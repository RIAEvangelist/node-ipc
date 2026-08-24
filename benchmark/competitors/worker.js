import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createInbox} from './lib/inbox.js';
import {createMessageFactory,verifyMessage} from './protocol.js';
import {latencySummary} from './stats.js';
import {loadSubject} from './subjects.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(process.argv[2]);
let activeClient;
let activePeerState;
let shutdownPromise;

process.stdout.on('error',() => {});
process.stderr.on('error',() => {});

function deadline(promise,milliseconds,label){
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve,reject) => {
            timer=setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)),milliseconds);
            timer.unref();
        })
    ]).finally(() => clearTimeout(timer));
}

function controlChannel(peer){
    const inbox=createInbox();
    const lines=readline.createInterface({input:peer.stdout,terminal:false});
    lines.on('line',line => {
        try{
            inbox.push(JSON.parse(line));
        }catch(error){
            inbox.fail(new Error(`invalid peer control message: ${line}\n${error.message}`));
        }
    });
    peer.once('error',error => inbox.fail(error));
    peer.once('exit',(code,signal) => {
        if(code !== 0 || signal){
            inbox.fail(new Error(`peer exited: code=${code} signal=${signal}`));
        }else{
            inbox.end();
        }
    });
    return {
        async receive(type){
            while(true){
                const message=await inbox.receive();
                if(message.type === 'error'){
                    throw new Error(message.error);
                }
                if(message.type === type){
                    return message;
                }
            }
        },
        close:() => lines.close()
    };
}

async function startPeer(subjectId,subject){
    const peerFile=path.join(directory,'peer.js');
    const options={
        cwd:process.cwd(),
        env:process.env
    };
    const started=process.hrtime.bigint();
    const peer=subject.launchPeer
        ? subject.launchPeer(peerFile,subjectId,options)
        : spawn(process.execPath,[peerFile,subjectId],{
            ...options,
            stdio:['pipe','pipe','pipe']
        });
    let stderr='';
    peer.stderr.on('data',chunk => {
        stderr+=chunk.toString('utf8');
    });
    peer.stdin.on('error',() => {});
    const control=controlChannel(peer);
    const state={control,peer,started,stderr:() => stderr};
    activePeerState=state;
    try{
        const ready=await deadline(control.receive('ready'),config.timeoutMs,'peer ready');
        state.ready=ready;
        return state;
    }catch(error){
        await terminatePeer(state,2000);
        if(activePeerState === state){
            activePeerState=undefined;
        }
        throw new Error(`${error.message}${stderr ? `\n${stderr}` : ''}`);
    }
}

async function send(client,message){
    const pending=client.send(message);
    if(pending && typeof pending.then === 'function'){
        await pending;
    }
}

async function sequential(client,factory,bytes,frames,startSequence,measure){
    const samples=measure ? new Array(frames) : null;
    const started=process.hrtime.bigint();
    for(let index=0;index<frames;index+=1){
        const sequence=startSequence+index;
        const frameStarted=measure ? process.hrtime.bigint() : null;
        await send(client,factory(sequence));
        const message=await client.receive();
        const received=measure ? process.hrtime.bigint() : null;
        verifyMessage(message,bytes,sequence,factory.payload);
        if(measure){
            samples[index]=Number(received-frameStarted);
        }
    }
    const ended=process.hrtime.bigint();
    return {elapsedNs:ended-started,samples};
}

async function windowed(client,factory,bytes,frames,startSequence,windowMessages,windowBytes){
    const window=Math.max(1,Math.min(
        frames,
        windowMessages,
        Math.floor(windowBytes/bytes)
    ));
    let received=0;
    let sent=0;
    let maximumInFlight=0;
    const started=process.hrtime.bigint();
    while(sent<window){
        await send(client,factory(startSequence+sent));
        sent+=1;
        maximumInFlight=Math.max(maximumInFlight,sent-received);
    }
    while(received<frames){
        const message=await client.receive();
        verifyMessage(message,bytes,startSequence+received,factory.payload);
        received+=1;
        if(sent<frames){
            await send(client,factory(startSequence+sent));
            sent+=1;
            maximumInFlight=Math.max(maximumInFlight,sent-received);
        }
    }
    return {
        elapsedNs:process.hrtime.bigint()-started,
        maximumInFlight,
        received,
        sent,
        window
    };
}

function metricDifference(after,before,key){
    return Number.isFinite(after[key]) && Number.isFinite(before[key])
        ? after[key]-before[key]
        : null;
}

function tcpEndpoint(endpoint){
    if(endpoint?.host && endpoint?.port){
        return endpoint;
    }
    if(endpoint?.url?.startsWith('tcp://')){
        const url=new URL(endpoint.url);
        return {host:url.hostname,port:Number(url.port)};
    }
    return null;
}

async function endpointCleanup(endpoint){
    const target=tcpEndpoint(endpoint);
    if(!target){
        return {closed:null,reusable:null};
    }
    const closed=await new Promise(resolve => {
        const socket=net.createConnection(target);
        const finish=value => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(500,() => finish(false));
        socket.once('connect',() => finish(false));
        socket.once('error',() => finish(true));
    });
    const reusable=await new Promise(resolve => {
        const server=net.createServer();
        server.once('error',() => resolve(false));
        server.listen(target,() => server.close(() => resolve(true)));
    });
    return {closed,reusable};
}

async function peerExit(peer,timeoutMs){
    return peer.exitCode !== null || peer.signalCode !== null
        ? [peer.exitCode,peer.signalCode]
        : deadline(once(peer,'exit'),timeoutMs,'peer exit');
}

async function terminatePeer(state,timeoutMs){
    if(state.termination){
        return state.termination;
    }
    state.termination=(async() => {
        const {control,peer}=state;
        try{
            if(peer.exitCode !== null || peer.signalCode !== null){
                return [peer.exitCode,peer.signalCode];
            }
            if(peer.stdin?.writable){
                peer.stdin.end(`${JSON.stringify({type:'close'})}\n`);
                try{
                    return await peerExit(peer,timeoutMs);
                }catch{}
            }
            if(peer.exitCode === null && peer.signalCode === null){
                peer.kill();
            }
            try{
                return await peerExit(peer,timeoutMs);
            }catch{}
            if(peer.exitCode === null && peer.signalCode === null){
                peer.kill('SIGKILL');
            }
            return await peerExit(peer,timeoutMs);
        }finally{
            control.close();
        }
    })();
    return state.termination;
}

async function shutdownOwnedProcesses(){
    if(shutdownPromise){
        return shutdownPromise;
    }
    shutdownPromise=(async() => {
        if(activeClient){
            const client=activeClient;
            activeClient=undefined;
            try{
                await deadline(client.close(),2000,'client shutdown');
            }catch{}
        }
        if(activePeerState){
            const state=activePeerState;
            await terminatePeer(state,2000);
            if(activePeerState === state){
                activePeerState=undefined;
            }
        }
    })();
    return shutdownPromise;
}

let parentControlComplete=false;
const parentControl=readline.createInterface({input:process.stdin,terminal:false});

function requestShutdown(){
    if(parentControlComplete){
        return;
    }
    void shutdownOwnedProcesses()
        .catch(error => process.stderr.write(`${error?.stack ?? error}\n`))
        .finally(() => process.exit(1));
}

parentControl.on('line',line => {
    try{
        if(JSON.parse(line).type === 'terminate'){
            requestShutdown();
        }
    }catch(error){
        process.stderr.write(`invalid worker control message: ${error.message}\n`);
        requestShutdown();
    }
});
parentControl.once('close',requestShutdown);

function completeParentControl(){
    parentControlComplete=true;
    parentControl.close();
}

async function run(){
    const subject=await loadSubject(config.subject);
    const peerState=await startPeer(config.subject,subject);
    const {control,peer,ready}=peerState;
    let client;
    try{
        client=await deadline(subject.createClient({
            endpoint:ready.endpoint,
            peer
        }),config.timeoutMs,'client connect');
        activeClient=client;
        const connected=process.hrtime.bigint();
        const factory=createMessageFactory(config.payloadBytes);
        const probe=await deadline(
            sequential(client,factory,config.payloadBytes,config.probeFrames,0,false),
            config.timeoutMs,
            'correctness probe'
        );
        const warmup=config.workload === 'latency'
            ? await deadline(
                sequential(client,factory,config.payloadBytes,config.warmupFrames,0x100000,false),
                config.timeoutMs,
                'latency warmup'
            )
            : await deadline(
                windowed(
                    client,
                    factory,
                    config.payloadBytes,
                    config.warmupFrames,
                    0x100000,
                    config.windowMessages,
                    config.windowBytes
                ),
                config.timeoutMs,
                'throughput warmup'
            );
        const before=client.metrics();
        const measured=config.workload === 'latency'
            ? await deadline(
                sequential(client,factory,config.payloadBytes,config.frames,0x200000,true),
                config.timeoutMs,
                'latency measurement'
            )
            : await deadline(
                windowed(
                    client,
                    factory,
                    config.payloadBytes,
                    config.frames,
                    0x200000,
                    config.windowMessages,
                    config.windowBytes
                ),
                config.timeoutMs,
                'throughput measurement'
            );
        const after=client.metrics();
        const elapsedSeconds=Number(measured.elapsedNs)/1e9;
        const metrics={
            applicationMiBPerSecond:(config.payloadBytes*config.frames)/(1024*1024)/elapsedSeconds,
            backpressureEvents:metricDifference(after,before,'backpressureEvents'),
            elapsedNs:measured.elapsedNs.toString(),
            latencyNs:measured.samples ? latencySummary(measured.samples) : null,
            maximumInFlight:measured.maximumInFlight ?? 1,
            roundTripsPerSecond:config.frames/elapsedSeconds,
            wireBytesRead:metricDifference(after,before,'wireBytesRead'),
            wireBytesWritten:metricDifference(after,before,'wireBytesWritten')
        };
        await deadline(client.close(),config.timeoutMs,'client close');
        if(activeClient === client){
            activeClient=undefined;
        }
        peer.stdin.write(`${JSON.stringify({type:'close'})}\n`);
        peer.stdin.end();
        await deadline(control.receive('closed'),config.timeoutMs,'peer close');
        const [exitCode,signal]=await peerExit(peer,config.timeoutMs);
        control.close();
        if(activePeerState === peerState){
            activePeerState=undefined;
        }
        const cleanup=await endpointCleanup(ready.endpoint);
        return {
            cleanup:{
                endpointClosed:cleanup.closed,
                endpointReusable:cleanup.reusable,
                naturalExit:exitCode === 0 && signal === null
            },
            coldStartNs:(connected-peerState.started).toString(),
            config:{
                frames:config.frames,
                payloadBytes:config.payloadBytes,
                probeFrames:config.probeFrames,
                warmupFrames:config.warmupFrames,
                windowBytes:config.windowBytes,
                windowMessages:config.windowMessages,
                workload:config.workload
            },
            exact:{
                contentVerified:true,
                measuredFrames:config.frames,
                probeFrames:config.probeFrames,
                sequenceVerified:true,
                warmupFrames:config.warmupFrames
            },
            metrics,
            peer:{exitCode,signal},
            status:'ok',
            subject:subject.metadata,
            warmupElapsedNs:warmup.elapsedNs.toString()
        };
    }catch(error){
        if(activeClient === client){
            activeClient=undefined;
        }
        try{
            await client?.close();
        }catch{}
        await terminatePeer(peerState,2000);
        if(activePeerState === peerState){
            activePeerState=undefined;
        }
        throw new Error(`${error.stack ?? error}${peerState.stderr() ? `\nPeer stderr:\n${peerState.stderr()}` : ''}`);
    }
}

try{
    const result=await run();
    process.stdout.write(`${JSON.stringify(result)}\n`);
}catch(error){
    process.stdout.write(`${JSON.stringify({
        error:error.stack ?? String(error),
        status:'failed',
        subject:config.subject
    })}\n`);
    process.exitCode=1;
}finally{
    completeParentControl();
}

export {
    endpointCleanup,
    sequential,
    windowed
};
