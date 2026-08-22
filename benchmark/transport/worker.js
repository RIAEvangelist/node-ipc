import dgram from 'node:dgram';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const config=JSON.parse(process.argv[2] || '{}');
const event='benchmark.frame';
const tail='a'.repeat(config.payloadBytes-8);
const constant='a'.repeat(config.payloadBytes);
const resources=() => process.getActiveResourcesInfo().sort();
const baselineResources=resources();

function resourceDifference(before,after){
    const remaining=[...before];
    return after.filter((resource) => {
        const index=remaining.indexOf(resource);
        if(index === -1) return true;
        remaining.splice(index,1);
        return false;
    });
}

async function forceGc(){
    for(let count=0;global.gc && count<3;count+=1){
        global.gc();
        await new Promise((resolve) => setImmediate(resolve));
    }
}

function payload(index,sequential){
    return sequential ? index.toString(16).padStart(8,'0')+tail : constant;
}

function assertPayload(value,index,sequential){
    const expected=payload(index,sequential);
    if(value !== expected){
        throw new Error(`payload corruption or sequence failure at frame ${index}`);
    }
}

function sequence(value,frames,seen){
    if(
        typeof value !== 'string'
        || value.length !== config.payloadBytes
        || value.slice(8) !== tail
        || !/^[0-9a-f]{8}$/u.test(value.slice(0,8))
    ){
        throw new Error('datagram payload corruption');
    }
    const index=Number.parseInt(value.slice(0,8),16);
    if(index>=frames || seen[index]) throw new Error(`duplicate or invalid datagram sequence ${index}`);
    seen[index]=1;
}

function wireBytes(){
    return Buffer.byteLength(`${JSON.stringify({type:event,data:payload(0,true)})}\f`);
}

function runStreamPhase(client,socket,frames,sequential){
    return new Promise((resolve,reject) => {
        let received=0;
        let sent=0;
        let finished=false;
        const startBytes={read:socket.bytesRead,written:socket.bytesWritten};
        const start=process.hrtime.bigint();
        const clean=() => {
            client.off(event,receive);
            client.off('error',fail);
        };
        const fail=(error) => {
            if(finished) return;
            finished=true;
            clean();
            reject(error);
        };
        const receive=(value) => {
            if(finished) return;
            try{assertPayload(value,received,sequential);}catch(error){fail(error);return;}
            received+=1;
            if(received !== frames) return;
            finished=true;
            const end=process.hrtime.bigint();
            clean();
            resolve({
                elapsedNs:end-start,
                received,
                sent,
                wireReadBytes:socket.bytesRead-startBytes.read,
                wireWrittenBytes:socket.bytesWritten-startBytes.written
            });
        };
        const write=() => {
            if(finished) return;
            while(sent<frames){
                client.emit(event,payload(sent,sequential));
                sent+=1;
                if(socket.writableNeedDrain){
                    socket.once('drain',write);
                    return;
                }
            }
        };
        client.on(event,receive);
        client.on('error',fail);
        write();
    });
}

function runDatagramPhase(server,peer,frames,window){
    return new Promise((resolve,reject) => {
        let received=0;
        let sent=0;
        let finished=false;
        const seen=new Uint8Array(frames);
        const start=process.hrtime.bigint();
        const clean=() => {
            server.off(event,receive);
            server.off('error',fail);
        };
        const fail=(error) => {
            if(finished) return;
            finished=true;
            clean();
            reject(error);
        };
        const pump=() => {
            while(!finished && sent<frames && sent-received<window){
                server.emit(peer,event,payload(sent,true));
                sent+=1;
            }
        };
        const receive=(value) => {
            if(finished) return;
            try{sequence(value,frames,seen);}catch(error){fail(error);return;}
            received+=1;
            if(received === frames){
                finished=true;
                const end=process.hrtime.bigint();
                clean();
                resolve({elapsedNs:end-start,received,sent});
                return;
            }
            pump();
        };
        server.on(event,receive);
        server.on('error',fail);
        pump();
    });
}

async function reserveDatagramPort(type,host){
    const socket=dgram.createSocket(type);
    await new Promise((resolve,reject) => {
        socket.once('error',reject);
        socket.bind(0,host,resolve);
    });
    const port=socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    return port;
}

async function createIPC(){
    const module=await import(pathToFileURL(path.join(config.root,'node-ipc.js')).href);
    if(typeof module.IPCModule !== 'function') throw new Error('subject does not export IPCModule');
    const manifest=JSON.parse(await readFile(path.join(config.root,'package.json'),'utf8'));
    const ipc=new module.IPCModule;
    ipc.config.silent=true;
    ipc.config.stopRetrying=true;
    ipc.config.maxRetries=0;
    ipc.config.sync=false;
    ipc.config.rawBuffer=false;
    ipc.config.parser='fast';
    return {ipc,version:manifest.version};
}

async function runStream(ipc){
    const id=`benchmark-${config.version}`;
    if(config.transport === 'local'){
        ipc.connectTo(id,config.endpoint.path);
    }else{
        if(config.transport === 'tls'){
            ipc.config.tls={
                rejectUnauthorized:false,
                trustedConnections:config.certificates.serverCertificate
            };
        }
        ipc.connectToNet(id,config.endpoint.host,config.endpoint.port);
    }
    const client=ipc.of[id];
    const socket=client.socket;
    await once(socket,config.transport === 'tls' ? 'secureConnect' : 'connect');

    const probe=await runStreamPhase(client,socket,config.probeFrames,true);
    const warmup=await runStreamPhase(client,socket,config.warmupFrames,false);
    await forceGc();
    const measured=await runStreamPhase(client,socket,config.measuredFrames,false);

    client.explicitlyDisconnected=true;
    const closed=once(socket,'close');
    socket.end();
    await closed;
    client.reset?.();
    return {closed:socket.destroyed,measured,probe,warmup};
}

async function runDatagram(ipc){
    const host=config.transport === 'udp6' ? '::1' : '127.0.0.1';
    const port=await reserveDatagramPort(config.transport,host);
    ipc.serveNet(host,port,config.transport);
    const started=new Promise((resolve,reject) => {
        ipc.server.once('start',resolve);
        ipc.server.once('error',reject);
    });
    ipc.server.start();
    await started;
    const socket=ipc.server.server;
    try{socket.address();}catch{await once(socket,'listening');}
    const peer={address:config.endpoint.host,port:config.endpoint.port};

    const probe=await runDatagramPhase(ipc.server,peer,config.probeFrames,config.udpWindow);
    const warmup=await runDatagramPhase(ipc.server,peer,config.warmupFrames,config.udpWindow);
    await forceGc();
    const measured=await runDatagramPhase(ipc.server,peer,config.measuredFrames,config.udpWindow);

    const closed=once(socket,'close');
    ipc.server.stop();
    await closed;
    ipc.server.reset?.();
    return {closed:true,measured,probe,warmup};
}

async function runSample(){
    await forceGc();
    const beforeImport=process.memoryUsage();
    const {ipc,version}=await createIPC();
    await forceGc();
    const afterImport=process.memoryUsage();
    const run=['udp4','udp6'].includes(config.transport)
        ? await runDatagram(ipc)
        : await runStream(ipc);
    await forceGc();
    await new Promise((resolve) => setImmediate(resolve));

    const perFrame=wireBytes();
    const measuredNs=run.measured.elapsedNs;
    const seconds=Number(measuredNs)/1e9;
    const totalFrames=config.probeFrames+config.warmupFrames+config.measuredFrames;
    const stream=!['udp4','udp6'].includes(config.transport);
    const observedActiveResources=resourceDifference(baselineResources,resources());
    const activeResourceDelta=observedActiveResources.filter((resource) => resource !== 'PipeWrap');
    return {
        rootVersion:version,
        metrics:{
            elapsedNs:measuredNs.toString(),
            framesPerSecond:config.measuredFrames/seconds,
            millisecondsPerMillion:Number(measuredNs)/config.measuredFrames
        },
        exact:{
            applicationBytes:config.payloadBytes*config.measuredFrames,
            contentVerified:true,
            countVerified:run.measured.sent === config.measuredFrames && run.measured.received === config.measuredFrames,
            measuredFrames:config.measuredFrames,
            probeFrames:config.probeFrames,
            sequenceVerified:true,
            totalWireBytes:perFrame*totalFrames,
            warmupFrames:config.warmupFrames,
            wireBytesPerFrame:perFrame,
            wireReceivedBytes:stream ? run.measured.wireReadBytes : perFrame*config.measuredFrames,
            wireSentBytes:stream ? run.measured.wireWrittenBytes : perFrame*config.measuredFrames
        },
        memory:{afterImport,beforeImport},
        cleanup:{
            activeHandles:activeResourceDelta,
            activeResourceDelta,
            clientClosed:run.closed,
            clean:run.closed && activeResourceDelta.length === 0,
            observedActiveResources
        }
    };
}

try{
    const result=await runSample();
    process.send?.({type:'result',result});
    process.disconnect?.();
}catch(error){
    process.send?.({type:'error',error:error.stack || error.message});
    process.exitCode=1;
    process.disconnect?.();
}

export {runSample};
