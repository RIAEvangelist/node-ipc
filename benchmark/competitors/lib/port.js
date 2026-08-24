import dgram from 'node:dgram';
import {once} from 'node:events';
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

async function reserveUdpPort(host='127.0.0.1',type='udp4'){
    if(!['udp4','udp6'].includes(type)){
        throw new Error(`unsupported UDP type ${type}`);
    }
    const socket=dgram.createSocket(type);
    try{
        socket.bind({address:host,exclusive:true,port:0});
        await once(socket,'listening');
        return socket.address().port;
    }finally{
        if(socket.address){
            try{
                socket.address();
                const closed=once(socket,'close');
                socket.close();
                await closed;
            }catch{}
        }
    }
}

export {
    reserveTcpPort,
    reserveUdpPort
};
