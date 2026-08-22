import net from 'node:net';
import {once} from 'node:events';

const probeFrames=64;

const connect=async ({host,port}) => {
    const socket=net.createConnection({host,port});
    socket.setNoDelay(true);
    await once(socket,'connect');
    return socket;
};

const throughput=(socket,payload,frames) => new Promise((resolve,reject) => {
    const targetBytes=payload.length*frames;
    let receivedBytes=0;
    let sentFrames=0;
    let start;

    const fail=error => {
        socket.off('data',receive);
        socket.off('error',fail);
        reject(error);
    };
    const receive=chunk => {
        receivedBytes+=chunk.length;
        if(receivedBytes < targetBytes){
            return;
        }

        const end=process.hrtime.bigint();
        socket.off('data',receive);
        socket.off('error',fail);
        if(receivedBytes !== targetBytes){
            reject(new Error(`oracle returned ${receivedBytes-targetBytes} excess bytes`));
            return;
        }
        resolve({end,receivedBytes,sentFrames,start});
    };
    const send=() => {
        while(sentFrames < frames){
            sentFrames+=1;
            if(!socket.write(payload)){
                socket.once('drain',send);
                return;
            }
        }
    };

    socket.once('error',fail);
    socket.on('data',receive);
    start=process.hrtime.bigint();
    send();
});

const latency=(socket,payload,frames) => new Promise((resolve,reject) => {
    const samples=new BigUint64Array(frames);
    let frameStart;
    let receivedBytes=0;
    let receivedFrames=0;
    let start;

    const fail=error => {
        socket.off('data',receive);
        socket.off('error',fail);
        reject(error);
    };
    const send=() => {
        frameStart=process.hrtime.bigint();
        socket.write(payload);
    };
    const receive=chunk => {
        receivedBytes+=chunk.length;
        if(receivedBytes < payload.length){
            return;
        }
        if(receivedBytes !== payload.length){
            fail(new Error('latency oracle crossed a frame boundary'));
            return;
        }

        const now=process.hrtime.bigint();
        samples[receivedFrames]=now-frameStart;
        receivedFrames+=1;
        receivedBytes=0;
        if(receivedFrames === frames){
            socket.off('data',receive);
            socket.off('error',fail);
            resolve({end:now,receivedFrames,samples,start});
            return;
        }
        send();
    };

    socket.once('error',fail);
    socket.on('data',receive);
    start=process.hrtime.bigint();
    send();
});

const close=async socket => {
    if(socket.destroyed){
        return;
    }
    const closed=once(socket,'close');
    socket.end();
    await closed;
};

const sequencePayload=(bytes,index) => Buffer.from(
    index.toString(16).padStart(8,'0')+'a'.repeat(bytes-8)
);

const probe=(socket,bytes) => new Promise((resolve,reject) => {
    const frames=Array.from({length:probeFrames},(_,index) => sequencePayload(bytes,index));
    const expected=Buffer.concat(frames);
    const received=[];
    let receivedBytes=0;

    const fail=error => {
        socket.off('data',receive);
        socket.off('error',fail);
        reject(error);
    };
    const receive=chunk => {
        received.push(chunk);
        receivedBytes+=chunk.length;
        if(receivedBytes < expected.length){
            return;
        }
        socket.off('data',receive);
        socket.off('error',fail);
        if(receivedBytes !== expected.length || !Buffer.concat(received).equals(expected)){
            reject(new Error('correctness probe changed payload content or sequence'));
            return;
        }
        resolve();
    };

    socket.once('error',fail);
    socket.on('data',receive);
    for(const frame of frames){
        socket.write(frame);
    }
});

const bytes=socket => ({read:socket.bytesRead,written:socket.bytesWritten});
const difference=(after,before) => ({
    read:after.read-before.read,
    written:after.written-before.written
});

export const metadata={
    name:'node-net',
    transport:'TCP byte stream',
    package:{
        name:'node:net',
        bundled:true,
        dependencyCount:0,
        fileCount:0,
        installedBytes:0
    }
};

export async function run(config,hooks={}){
    const payload=Buffer.alloc(config.payloadBytes,0x61);
    const socket=await connect(config.endpoint);
    await hooks.connected?.();

    const initial=bytes(socket);
    await probe(socket,config.payloadBytes);
    const afterProbe=bytes(socket);
    const probeWire=difference(afterProbe,initial);

    const warmup=await throughput(socket,payload,config.warmupFrames);
    if(warmup.sentFrames !== config.warmupFrames || warmup.receivedBytes !== payload.length*config.warmupFrames){
        throw new Error('warmup count mismatch');
    }
    const afterWarmup=bytes(socket);
    const warmupWire=difference(afterWarmup,afterProbe);

    await hooks.beforeMeasure?.();
    const beforeMeasure=bytes(socket);
    const result=config.pass === 'latency'
        ? await latency(socket,payload,config.frames)
        : await throughput(socket,payload,config.frames);
    const afterMeasure=bytes(socket);
    await hooks.afterMeasure?.();
    const measuredWire=difference(afterMeasure,beforeMeasure);

    const sentFrames=result.sentFrames ?? result.receivedFrames;
    const receivedFrames=result.receivedFrames ?? result.receivedBytes/payload.length;
    const applicationBytes=config.payloadBytes*config.frames;
    if(sentFrames !== config.frames || receivedFrames !== config.frames){
        throw new Error(`expected ${config.frames} frames, sent ${sentFrames}, received ${receivedFrames}`);
    }

    await close(socket);
    await hooks.closed?.();

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
            probeWireReceivedBytes:probeWire.read,
            probeWireSentBytes:probeWire.written,
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
