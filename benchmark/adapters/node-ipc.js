import Client from '../../dao/client.js';
import Defaults from '../../entities/Defaults.js';

const event='benchmark.frame';
const probeFrames=64;

function createClient(profile,endpoint){
    const config=new Defaults;
    config.maxRetries=0;
    config.parser=profile;
    config.rawBuffer=profile === 'raw';
    config.silent=true;
    config.stopRetrying=true;

    const client=new Client(config,() => {});
    client.id=`benchmark-${profile}`;
    client.path=endpoint.host;
    client.port=endpoint.port;
    return client;
}

function connect(client){
    return new Promise((resolve,reject) => {
        const connected=() => {
            client.off('error',failed);
            resolve();
        };
        const failed=error => {
            client.off('connect',connected);
            reject(error);
        };
        client.once('connect',connected);
        client.once('error',failed);
        client.connect();
    });
}

function close(client){
    if(client.socket.destroyed){
        return Promise.resolve();
    }
    return new Promise(resolve => {
        client.explicitlyDisconnected=true;
        client.once('destroy',resolve);
        client.socket.end();
    });
}

function sequencePayload(bytes,index){
    return index.toString(16).padStart(8,'0')+'a'.repeat(bytes-8);
}

function rawProbe(client,bytes){
    const expected=Buffer.concat(Array.from(
        {length:probeFrames},
        (_,index) => Buffer.from(sequencePayload(bytes,index))
    ));

    return new Promise((resolve,reject) => {
        const received=[];
        let receivedBytes=0;
        const failed=error => {
            client.off('data',receive);
            client.off('error',failed);
            reject(error);
        };
        const receive=chunk => {
            received.push(chunk);
            receivedBytes+=chunk.length;
            if(receivedBytes < expected.length){
                return;
            }
            client.off('data',receive);
            client.off('error',failed);
            if(receivedBytes !== expected.length || !Buffer.concat(received).equals(expected)){
                reject(new Error('raw correctness probe changed payload content or sequence'));
                return;
            }
            resolve();
        };
        client.on('data',receive);
        client.once('error',failed);
        for(let index=0;index<probeFrames;index+=1){
            client.emit(expected.subarray(index*bytes,(index+1)*bytes));
        }
    });
}

function framedProbe(client,bytes){
    return new Promise((resolve,reject) => {
        let received=0;
        const failed=error => {
            client.off(event,receive);
            client.off('error',failed);
            reject(error);
        };
        const receive=value => {
            if(value !== sequencePayload(bytes,received)){
                failed(new Error('framed correctness probe changed payload content or sequence'));
                return;
            }
            received+=1;
            if(received === probeFrames){
                client.off(event,receive);
                client.off('error',failed);
                resolve();
            }
        };
        client.on(event,receive);
        client.once('error',failed);
        for(let index=0;index<probeFrames;index+=1){
            client.emit(event,sequencePayload(bytes,index));
        }
    });
}

function rawThroughput(client,payload,frames){
    const targetBytes=payload.length*frames;
    let receivedBytes=0;
    let sentFrames=0;
    let start;

    return new Promise((resolve,reject) => {
        const failed=error => {
            client.off('data',receive);
            client.off('error',failed);
            reject(error);
        };
        const receive=chunk => {
            receivedBytes+=chunk.length;
            if(receivedBytes < targetBytes){
                return;
            }
            const end=process.hrtime.bigint();
            client.off('data',receive);
            client.off('error',failed);
            if(receivedBytes !== targetBytes){
                reject(new Error(`oracle returned ${receivedBytes-targetBytes} excess bytes`));
                return;
            }
            resolve({end,receivedBytes,sentFrames,start});
        };
        const send=() => {
            while(sentFrames < frames){
                sentFrames+=1;
                if(!client.emit(payload)){
                    client.socket.once('drain',send);
                    return;
                }
            }
        };
        client.on('data',receive);
        client.once('error',failed);
        start=process.hrtime.bigint();
        send();
    });
}

function framedThroughput(client,payload,frames){
    let receivedFrames=0;
    let sentFrames=0;
    let start;

    return new Promise((resolve,reject) => {
        const failed=error => {
            client.off(event,receive);
            client.off('error',failed);
            reject(error);
        };
        const receive=() => {
            receivedFrames+=1;
            if(receivedFrames !== frames){
                return;
            }
            const end=process.hrtime.bigint();
            client.off(event,receive);
            client.off('error',failed);
            resolve({end,receivedFrames,sentFrames,start});
        };
        const send=() => {
            while(sentFrames < frames){
                sentFrames+=1;
                if(!client.emit(event,payload)){
                    client.socket.once('drain',send);
                    return;
                }
            }
        };
        client.on(event,receive);
        client.once('error',failed);
        start=process.hrtime.bigint();
        send();
    });
}

function rawLatency(client,payload,frames){
    const samples=new BigUint64Array(frames);
    let frameStart;
    let receivedBytes=0;
    let receivedFrames=0;
    let start;

    return new Promise((resolve,reject) => {
        const failed=error => {
            client.off('data',receive);
            client.off('error',failed);
            reject(error);
        };
        const send=() => {
            frameStart=process.hrtime.bigint();
            client.emit(payload);
        };
        const receive=chunk => {
            receivedBytes+=chunk.length;
            if(receivedBytes < payload.length){
                return;
            }
            if(receivedBytes !== payload.length){
                failed(new Error('raw latency probe crossed a frame boundary'));
                return;
            }
            const now=process.hrtime.bigint();
            samples[receivedFrames]=now-frameStart;
            receivedFrames+=1;
            receivedBytes=0;
            if(receivedFrames === frames){
                client.off('data',receive);
                client.off('error',failed);
                resolve({end:now,receivedFrames,samples,start});
                return;
            }
            send();
        };
        client.on('data',receive);
        client.once('error',failed);
        start=process.hrtime.bigint();
        send();
    });
}

function framedLatency(client,payload,frames){
    const samples=new BigUint64Array(frames);
    let frameStart;
    let receivedFrames=0;
    let start;

    return new Promise((resolve,reject) => {
        const failed=error => {
            client.off(event,receive);
            client.off('error',failed);
            reject(error);
        };
        const send=() => {
            frameStart=process.hrtime.bigint();
            client.emit(event,payload);
        };
        const receive=() => {
            const now=process.hrtime.bigint();
            samples[receivedFrames]=now-frameStart;
            receivedFrames+=1;
            if(receivedFrames === frames){
                client.off(event,receive);
                client.off('error',failed);
                resolve({end:now,receivedFrames,samples,start});
                return;
            }
            send();
        };
        client.on(event,receive);
        client.once('error',failed);
        start=process.hrtime.bigint();
        send();
    });
}

function bytes(socket){
    return {read:socket.bytesRead,written:socket.bytesWritten};
}

function difference(after,before){
    return {read:after.read-before.read,written:after.written-before.written};
}

function createAdapter(profile){
    const raw=profile === 'raw';
    return {
        metadata:{
            name:`node-ipc-${profile}`,
            profile,
            transport:'node-ipc TCP client to raw byte reflector',
            package:{
                name:'node-ipc',
                bundled:false,
                dependencyCount:null,
                fileCount:null,
                installedBytes:null
            }
        },
        async run(config,hooks={}){
            const payload=raw
                ? Buffer.alloc(config.payloadBytes,0x61)
                : 'a'.repeat(config.payloadBytes);
            const client=createClient(profile,config.endpoint);
            await connect(client);
            const socket=client.socket;
            await hooks.connected?.();

            const initial=bytes(socket);
            await (raw ? rawProbe(client,config.payloadBytes) : framedProbe(client,config.payloadBytes));
            const afterProbe=bytes(socket);
            const probe=difference(afterProbe,initial);

            const warmup=raw
                ? await rawThroughput(client,payload,config.warmupFrames)
                : await framedThroughput(client,payload,config.warmupFrames);
            const afterWarmup=bytes(socket);
            const warmupWire=difference(afterWarmup,afterProbe);
            const warmupSentFrames=warmup.sentFrames ?? warmup.receivedFrames;
            const warmupReceivedFrames=warmup.receivedFrames
                ?? warmup.receivedBytes/config.payloadBytes;
            if(
                warmupSentFrames !== config.warmupFrames
                || warmupReceivedFrames !== config.warmupFrames
            ){
                throw new Error('warmup count mismatch');
            }

            await hooks.beforeMeasure?.();
            const beforeMeasure=bytes(socket);
            const result=config.pass === 'latency'
                ? raw
                    ? await rawLatency(client,payload,config.frames)
                    : await framedLatency(client,payload,config.frames)
                : raw
                    ? await rawThroughput(client,payload,config.frames)
                    : await framedThroughput(client,payload,config.frames);
            const afterMeasure=bytes(socket);
            await hooks.afterMeasure?.();
            const measuredWire=difference(afterMeasure,beforeMeasure);

            const sentFrames=result.sentFrames ?? result.receivedFrames;
            const receivedFrames=result.receivedFrames ?? result.receivedBytes/payload.length;
            const applicationBytes=config.payloadBytes*config.frames;
            if(sentFrames !== config.frames || receivedFrames !== config.frames){
                throw new Error(`expected ${config.frames} frames, sent ${sentFrames}, received ${receivedFrames}`);
            }

            await close(client);
            client.reset();

            return {
                elapsedNs:result.end-result.start,
                exact:{
                    applicationByteCountsVerified:applicationBytes === config.payloadBytes*receivedFrames,
                    applicationReceivedBytes:applicationBytes,
                    applicationSentBytes:applicationBytes,
                    byteCountsVerified:measuredWire.read === measuredWire.written,
                    configuredFrames:config.frames,
                    contentVerified:true,
                    correctnessFrames:probeFrames,
                    framingOverheadBytes:measuredWire.written-applicationBytes,
                    probeWireReceivedBytes:probe.read,
                    probeWireSentBytes:probe.written,
                    receivedBytes:measuredWire.read,
                    receivedFrames,
                    sentBytes:measuredWire.written,
                    sentFrames,
                    sequenceVerified:true,
                    warmupWireReceivedBytes:warmupWire.read,
                    warmupWireSentBytes:warmupWire.written,
                    wireReceivedBytes:measuredWire.read,
                    wireSentBytes:measuredWire.written
                },
                latencyNs:result.samples,
                cleanup:{
                    openSockets:socket.destroyed ? 0 : 1,
                    pendingBytes:socket.writableLength,
                    socketsClosed:socket.destroyed ? 1 : 0,
                    socketsCreated:1
                }
            };
        }
    };
}

export {
    createAdapter
};
