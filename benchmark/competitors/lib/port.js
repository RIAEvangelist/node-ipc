import net from 'node:net';

function reserveTcpPort(host='127.0.0.1'){
    return new Promise((resolve,reject) => {
        const server=net.createServer();
        server.once('error',reject);
        server.listen({host,port:0},() => {
            const {port}=server.address();
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

export {
    reserveTcpPort
};
