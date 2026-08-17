import net from 'node:net';
import {once} from 'node:events';

const connect = async ({host, port}) => {
    const socket = net.createConnection({host, port});
    socket.setNoDelay(true);
    await once(socket, 'connect');
    return socket;
};

const throughput = (socket, payload, frames) => new Promise((resolve, reject) => {
    const targetBytes = payload.length * frames;
    let receivedBytes = 0;
    let sentFrames = 0;
    let start;

    const fail = error => {
        socket.off('data', receive);
        socket.off('error', fail);
        reject(error);
    };
    const receive = chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes < targetBytes) {
            return;
        }

        const end = process.hrtime.bigint();
        socket.off('data', receive);
        socket.off('error', fail);
        if (receivedBytes > targetBytes) {
            reject(new Error(`oracle returned ${receivedBytes - targetBytes} excess bytes`));
            return;
        }
        resolve({end, receivedBytes, sentFrames, start});
    };
    const send = () => {
        while (sentFrames < frames) {
            sentFrames += 1;
            if (!socket.write(payload)) {
                socket.once('drain', send);
                return;
            }
        }
    };

    socket.once('error', fail);
    socket.on('data', receive);
    start = process.hrtime.bigint();
    send();
});

const latency = (socket, payload, frames) => new Promise((resolve, reject) => {
    const samples = new BigUint64Array(frames);
    let frameStart;
    let receivedBytes = 0;
    let receivedFrames = 0;
    let start;

    const fail = error => {
        socket.off('data', receive);
        socket.off('error', fail);
        reject(error);
    };
    const send = () => {
        frameStart = process.hrtime.bigint();
        socket.write(payload);
    };
    const receive = chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes < payload.length) {
            return;
        }
        if (receivedBytes > payload.length) {
            socket.off('data', receive);
            socket.off('error', fail);
            reject(new Error('latency oracle crossed a frame boundary'));
            return;
        }

        const now = process.hrtime.bigint();
        samples[receivedFrames] = now - frameStart;
        receivedFrames += 1;
        receivedBytes = 0;
        if (receivedFrames === frames) {
            socket.off('data', receive);
            socket.off('error', fail);
            resolve({end: now, receivedFrames, samples, start});
            return;
        }
        send();
    };

    socket.once('error', fail);
    socket.on('data', receive);
    start = process.hrtime.bigint();
    send();
});

const close = async socket => {
    if (socket.destroyed) {
        return;
    }
    const closed = once(socket, 'close');
    socket.end();
    await closed;
};

const warm = async (socket, payload, frames) => {
    if (!frames) {
        return;
    }
    const result = await throughput(socket, payload, frames);
    if (result.sentFrames !== frames || result.receivedBytes !== payload.length * frames) {
        throw new Error('warmup count mismatch');
    }
};

export const metadata = {
    name: 'node-net',
    transport: 'TCP byte stream',
    package: {
        name: 'node:net',
        bundled: true,
        dependencyCount: 0,
        fileCount: 0,
        installedBytes: 0
    }
};

export async function run(config, hooks = {}) {
    const payload = Buffer.alloc(config.payloadBytes, 0x61);
    const socket = await connect(config.endpoint);
    await hooks.connected?.();
    await warm(socket, payload, config.warmupFrames);
    await hooks.beforeMeasure?.();

    const result = config.pass === 'latency'
        ? await latency(socket, payload, config.frames)
        : await throughput(socket, payload, config.frames);
    await hooks.afterMeasure?.();
    await close(socket);
    await hooks.closed?.();

    const sentFrames = result.sentFrames ?? result.receivedFrames;
    const receivedFrames = result.receivedFrames ?? result.receivedBytes / payload.length;
    const sentBytes = sentFrames * payload.length;
    const receivedBytes = receivedFrames * payload.length;
    if (sentFrames !== config.frames || receivedFrames !== config.frames) {
        throw new Error(`expected ${config.frames} frames, sent ${sentFrames}, received ${receivedFrames}`);
    }

    return {
        elapsedNs: result.end - result.start,
        exact: {
            byteCountsVerified: sentBytes === receivedBytes,
            configuredFrames: config.frames,
            receivedBytes,
            receivedFrames,
            sentBytes,
            sentFrames
        },
        latencyNs: result.samples,
        cleanup: {
            openSockets: socket.destroyed ? 0 : 1,
            pendingBytes: sentBytes - receivedBytes,
            socketsClosed: socket.destroyed ? 1 : 0,
            socketsCreated: 1
        }
    };
}
