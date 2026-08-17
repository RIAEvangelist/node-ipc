import net from 'node:net';

const host = process.argv[2] ?? '127.0.0.1';
const port = Number(process.argv[3] ?? 0);
const sockets = new Set();
const stats = {
    acceptedConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
    destroyedSockets: 0
};
const cpuStart = process.cpuUsage();
const started = process.hrtime.bigint();

const memory = () => ({...process.memoryUsage()});
const server = net.createServer(socket => {
    stats.acceptedConnections += 1;
    sockets.add(socket);
    socket.on('data', chunk => {
        stats.bytesIn += chunk.length;
        stats.bytesOut += chunk.length;
        if (!socket.write(chunk)) {
            socket.pause();
            socket.once('drain', () => socket.resume());
        }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
});

const send = message => process.send?.(message);
const close = () => {
    const activeSocketsBeforeClose = sockets.size;
    for (const socket of sockets) {
        stats.destroyedSockets += 1;
        socket.destroy();
    }
    server.close(() => {
        send({
            type: 'cleanup',
            memory: memory(),
            stats: {
                ...stats,
                activeSocketsBeforeClose,
                activeSocketsAfterClose: sockets.size,
                cpuUsage: process.cpuUsage(cpuStart),
                wallNs: (process.hrtime.bigint() - started).toString()
            }
        });
        process.disconnect?.();
    });
};

process.on('message', message => {
    if (message === 'measure') {
        send({type: 'measure', memory: memory(), activeSockets: sockets.size, stats: {...stats}});
    } else if (message === 'close') {
        close();
    }
});

server.on('error', error => {
    send({type: 'error', error: error.message});
    process.exitCode = 1;
});
server.listen({host, port}, () => {
    const address = server.address();
    send({
        type: 'ready',
        endpoint: {host: address.address, port: address.port},
        memory: memory(),
        pid: process.pid
    });
});
