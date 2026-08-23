#!/usr/bin/env node

import {IPCModule} from '../../../node-ipc.js';

const REQUEST_EVENT='node-ipc.bench.request';
const RESPONSE_EVENT='node-ipc.bench.response';
const CLIENT_ID='rust-roundtrip-peer';
const SCHEMA='node-ipc-roundtrip-v1';
const PAUSED=Symbol('node-ipc-roundtrip-paused');

const HELP=`Usage: node ./rust/node-ipc/interop/node-peer.js --mode <server|client> [options]

Options:
  --host <address>         TCP address (default: 127.0.0.1)
  --port <number>          TCP port (default: 9763)
  --warmup <count>         Untimed round trips (default: 1000)
  --count <count>          Measured round trips (default: 100000)
  --payload-bytes <count>  ASCII payload bytes per event (default: 64)
  --inflight <count>       Maximum outstanding requests (default: 1)
  --json                   Emit JSON Lines instead of human-readable output
  --help                   Show this help

The server and client must use the same warmup, count, and payload-byte values.
`;

async function main(){
    const options=parseArguments(process.argv.slice(2));
    if(options.help){
        process.stdout.write(HELP);
        return;
    }

    if(options.mode === 'server'){
        await runServer(options);
        return;
    }
    await runClient(options);
}

function parseArguments(arguments_){
    const options={
        mode:'',
        host:'127.0.0.1',
        port:9763,
        warmup:1000,
        count:100000,
        payloadBytes:64,
        inflight:1,
        json:false,
        help:false
    };

    for(let index=0;index<arguments_.length;index++){
        const argument=arguments_[index];
        if(argument === '--json'){
            options.json=true;
            continue;
        }
        if(argument === '--help' || argument === '-h'){
            options.help=true;
            continue;
        }

        const value=arguments_[++index];
        if(value === undefined){
            throw new Error(`${argument} requires a value`);
        }
        switch(argument){
            case '--mode':
                options.mode=value;
                break;
            case '--host':
                options.host=value;
                break;
            case '--port':
                options.port=parseInteger(value,argument,1,65535);
                break;
            case '--warmup':
                options.warmup=parseInteger(value,argument,0,Number.MAX_SAFE_INTEGER);
                break;
            case '--count':
                options.count=parseInteger(value,argument,1,Number.MAX_SAFE_INTEGER);
                break;
            case '--payload-bytes':
                options.payloadBytes=parseInteger(value,argument,0,16*1024*1024);
                break;
            case '--inflight':
                options.inflight=parseInteger(value,argument,1,Number.MAX_SAFE_INTEGER);
                break;
            default:
                throw new Error(`unknown option: ${argument}`);
        }
    }

    if(options.help){
        return options;
    }
    if(options.mode !== 'server' && options.mode !== 'client'){
        throw new Error('--mode must be either server or client');
    }
    if(!options.host){
        throw new Error('--host must not be empty');
    }
    if(options.warmup+options.count > Number.MAX_SAFE_INTEGER){
        throw new Error('--warmup plus --count exceeds the safe integer range');
    }
    options.inflight=Math.min(options.inflight,options.count);
    return options;
}

function parseInteger(value,name,minimum,maximum){
    if(!/^\d+$/.test(value)){
        throw new Error(`${name} must be a non-negative decimal integer`);
    }
    const parsed=Number(value);
    if(!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum){
        throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    return parsed;
}

function createIPC(options){
    const ipc=new IPCModule;
    ipc.config.silent=true;
    ipc.config.parser='fast';
    ipc.config.sync=false;
    ipc.config.stopRetrying=true;
    ipc.config.maxRetries=0;
    ipc.config.networkHost=options.host;
    ipc.config.networkPort=options.port;
    ipc.config.maxConnections=1;
    return ipc;
}

async function runServer(options){
    const ipc=createIPC(options);
    const expectedPayload='x'.repeat(options.payloadBytes);
    const expectedFrames=options.warmup+options.count;
    let frames=0;
    let startedAt=0n;
    let finishing=false;
    let settled=false;

    await new Promise((resolve,reject) => {
        function fail(error){
            if(settled){
                return;
            }
            settled=true;
            ipc.server?.stop?.();
            reject(error);
        }

        ipc.serveNet(options.host,options.port,() => {
            reportServerStatus(options,'listening',{
                frames:0,
                durationNs:0
            });
        });
        ipc.server.on('error',fail);
        ipc.server.on('close',() => {
            if(!settled && !finishing){
                fail(new Error(
                    `peer disconnected after ${frames} of ${expectedFrames} frames`
                ));
            }
        });
        ipc.server.on(REQUEST_EVENT,(data,socket) => {
            try{
                if(settled || finishing){
                    return;
                }
                const expectedSequence=frames < options.warmup
                    ? frames
                    : frames-options.warmup;
                validatePayload(data,expectedSequence,expectedPayload);
                if(frames === 0){
                    startedAt=process.hrtime.bigint();
                }
                frames++;

                const writable=ipc.server.emit(socket,RESPONSE_EVENT,data);
                if(frames !== expectedFrames){
                    if(!writable && !socket[PAUSED]){
                        socket[PAUSED]=true;
                        socket.pause();
                        socket.once('drain',() => {
                            socket[PAUSED]=false;
                            socket.resume();
                        });
                    }
                    return;
                }

                finishing=true;
                const durationNs=process.hrtime.bigint()-startedAt;
                ipc.server.server.close();
                socket.end(() => {
                    if(settled){
                        return;
                    }
                    settled=true;
                    reportServerStatus(options,'complete',{
                        frames,
                        durationNs:Number(durationNs)
                    });
                    resolve();
                });
            }catch(error){
                fail(error);
            }
        });
        ipc.server.start();
    });
}

async function runClient(options){
    const ipc=createIPC(options);
    const payload='x'.repeat(options.payloadBytes);

    ipc.connectToNet(CLIENT_ID,options.host,options.port);
    const client=ipc.of[CLIENT_ID];
    await waitForConnect(client);

    try{
        const wireBytes=wireBytesForPhase(
            options.count,
            payload,
            client.encode
        );
        if(options.warmup > 0){
            await runPhase(client,options.warmup,payload,options.inflight,false);
        }
        const result=await runPhase(
            client,
            options.count,
            payload,
            options.inflight,
            true
        );
        result.wireBytes=wireBytes;
        reportClientResult(options,result);
    }finally{
        ipc.disconnect(CLIENT_ID);
    }
}

function waitForConnect(client){
    return new Promise((resolve,reject) => {
        function cleanup(){
            client.off('connect',onConnect);
            client.off('error',onError);
        }
        function onConnect(){
            cleanup();
            resolve();
        }
        function onError(error){
            cleanup();
            reject(error);
        }
        client.on('connect',onConnect);
        client.on('error',onError);
    });
}

function runPhase(client,count,payload,inflight,recordLatency){
    return new Promise((resolve,reject) => {
        const expectedPayload=payload;
        const request={sequence:0,payload};
        const slotSequences=new Array(Math.min(inflight,count)).fill(-1);
        const slotStartedAt=new Array(slotSequences.length);
        const latencies=recordLatency ? [] : null;
        const startedAt=process.hrtime.bigint();
        let sent=0;
        let received=0;
        let waitingForDrain=false;
        let settled=false;

        function cleanup(){
            client.off(RESPONSE_EVENT,onResponse);
            client.off('error',fail);
            client.off('disconnect',onDisconnect);
            client.socket?.off?.('drain',onDrain);
        }
        function finish(){
            if(settled){
                return;
            }
            settled=true;
            const durationNs=process.hrtime.bigint()-startedAt;
            cleanup();
            resolve({durationNs,latencies});
        }
        function fail(error){
            if(settled){
                return;
            }
            settled=true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        }
        function onDisconnect(){
            fail(new Error('peer disconnected before the round-trip phase completed'));
        }
        function onDrain(){
            waitingForDrain=false;
            fillWindow();
        }
        function fillWindow(){
            if(settled || waitingForDrain){
                return;
            }
            try{
                while(sent < count && sent-received < slotSequences.length){
                    const sequence=sent++;
                    const slotIndex=sequence%slotSequences.length;
                    if(slotSequences[slotIndex] !== -1){
                        throw new Error(`latency slot ${slotIndex} was reused before its response`);
                    }
                    slotSequences[slotIndex]=sequence;
                    slotStartedAt[slotIndex]=process.hrtime.bigint();
                    request.sequence=sequence;
                    const writable=client.emit(REQUEST_EVENT,request);
                    if(!writable){
                        waitingForDrain=true;
                        client.socket.once('drain',onDrain);
                        return;
                    }
                }
            }catch(error){
                fail(error);
            }
        }
        function onResponse(data){
            try{
                validatePayload(data,undefined,expectedPayload);
                const slotIndex=data.sequence%slotSequences.length;
                if(slotSequences[slotIndex] !== data.sequence){
                    throw new Error(`unexpected or duplicate response sequence ${data.sequence}`);
                }
                if(recordLatency){
                    latencies.push(Number(process.hrtime.bigint()-slotStartedAt[slotIndex]));
                }
                slotSequences[slotIndex]=-1;
                slotStartedAt[slotIndex]=undefined;
                received++;
                if(received === count){
                    finish();
                    return;
                }
                fillWindow();
            }catch(error){
                fail(error);
            }
        }

        client.on(RESPONSE_EVENT,onResponse);
        client.on('error',fail);
        client.on('disconnect',onDisconnect);
        fillWindow();
    });
}

function validatePayload(data,expectedSequence,expectedPayload){
    if(!data || typeof data !== 'object' || Array.isArray(data)){
        throw new Error('received event data is not an object');
    }
    if(!Number.isSafeInteger(data.sequence) || data.sequence < 0){
        throw new Error('received event sequence is not a non-negative safe integer');
    }
    if(expectedSequence !== undefined && data.sequence !== expectedSequence){
        throw new Error(`expected sequence ${expectedSequence}, received ${data.sequence}`);
    }
    if(data.payload !== expectedPayload){
        throw new Error(`payload mismatch for sequence ${data.sequence}`);
    }
}

function reportServerStatus(options,status,result){
    if(options.json){
        process.stdout.write(`${JSON.stringify({
            schema:SCHEMA,
            language:'node',
            role:'server',
            status,
            host:options.host,
            port:options.port,
            frames:result.frames,
            duration_ns:result.durationNs
        })}\n`);
        return;
    }

    if(status === 'listening'){
        process.stdout.write(`Node server listening on ${options.host}:${options.port}\n`);
        return;
    }
    process.stdout.write(
        `Node server completed ${result.frames} validated frames in ${formatDuration(result.durationNs)}\n`
    );
}

function reportClientResult(options,result){
    if(result.durationNs <= 0n){
        throw new Error('measured phase duration was zero');
    }
    const durationNs=Number(result.durationNs);
    const seconds=durationNs/1e9;
    const sorted=result.latencies.sort((left,right) => left-right);
    const totalLatency=sorted.reduce((total,value) => total+value,0);
    const output={
        schema:SCHEMA,
        language:'node',
        role:'client',
        host:options.host,
        port:options.port,
        warmup:options.warmup,
        count:options.count,
        payload_bytes:options.payloadBytes,
        inflight:options.inflight,
        duration_ns:durationNs,
        round_trips_per_second:options.count/seconds,
        wire_bytes_per_second:result.wireBytes/seconds,
        latency_ns:{
            mean:totalLatency/sorted.length,
            p50:percentile(sorted,0.50),
            p95:percentile(sorted,0.95),
            p99:percentile(sorted,0.99),
            max:sorted.at(-1)
        }
    };

    if(options.json){
        process.stdout.write(`${JSON.stringify(output)}\n`);
        return;
    }
    process.stdout.write([
        'Node TCP round-trip result',
        `  count:       ${output.count}`,
        `  payload:     ${output.payload_bytes} bytes`,
        `  inflight:    ${output.inflight}`,
        `  throughput:  ${output.round_trips_per_second.toFixed(3)} round trips/s`,
        `  wire rate:   ${(output.wire_bytes_per_second/1024/1024).toFixed(3)} MiB/s`,
        `  latency p50: ${formatDuration(output.latency_ns.p50)}`,
        `  latency p95: ${formatDuration(output.latency_ns.p95)}`,
        `  latency p99: ${formatDuration(output.latency_ns.p99)}`,
        `  latency max: ${formatDuration(output.latency_ns.max)}`
    ].join('\n')+'\n');
}

function percentile(sorted,fraction){
    return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)];
}

function wireBytesForPhase(count,payload,encode){
    const requestBase=Buffer.byteLength(encode(REQUEST_EVENT,{sequence:0,payload}));
    const responseBase=Buffer.byteLength(encode(RESPONSE_EVENT,{sequence:0,payload}));
    let extraSequenceDigits=0;
    let rangeStart=10;
    let extraDigits=1;
    while(rangeStart < count){
        const rangeEnd=rangeStart > Math.floor(Number.MAX_SAFE_INTEGER/10)
            ? count
            : Math.min(count,rangeStart*10);
        extraSequenceDigits+=(rangeEnd-rangeStart)*extraDigits;
        if(rangeEnd === count){
            break;
        }
        rangeStart=rangeEnd;
        extraDigits++;
    }
    return count*(requestBase+responseBase)+2*extraSequenceDigits;
}

function formatDuration(nanoseconds){
    if(nanoseconds < 1e3){
        return `${nanoseconds.toFixed(0)} ns`;
    }
    if(nanoseconds < 1e6){
        return `${(nanoseconds/1e3).toFixed(3)} us`;
    }
    if(nanoseconds < 1e9){
        return `${(nanoseconds/1e6).toFixed(3)} ms`;
    }
    return `${(nanoseconds/1e9).toFixed(3)} s`;
}

main().catch((error) => {
    process.stderr.write(`node-ipc interop peer: ${error.message}\n`);
    process.exitCode=1;
});
