import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {createInbox} from '../lib/inbox.js';
import {decodeMessage,encodeMessage} from '../protocol.js';

const metadata={
    id:'ws',
    label:'ws 8.21.3',
    packages:['ws'],
    serialization:'canonical JSON over WebSocket text messages',
    topology:'unrelated processes',
    transport:'WebSocket over TCP loopback'
};

async function createServer({onError}){
    const sockets=new Set();
    const server=new WebSocketServer({
        host:'127.0.0.1',
        perMessageDeflate:false,
        port:0
    });
    server.on('connection',socket => {
        sockets.add(socket);
        socket.on('message',value => {
            try{
                socket.send(encodeMessage(decodeMessage(value)),{
                    binary:false,
                    compress:false
                });
            }catch(error){
                onError(error);
            }
        });
        socket.on('close',() => sockets.delete(socket));
        socket.on('error',onError);
    });
    server.on('error',onError);
    await once(server,'listening');
    const address=server.address();
    return {
        endpoint:{host:'127.0.0.1',port:address.port},
        async close(){
            for(const socket of sockets){
                socket.terminate();
            }
            await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
        }
    };
}

async function createClient({endpoint}){
    const inbox=createInbox();
    const socket=new WebSocket(`ws://${endpoint.host}:${endpoint.port}`,{
        perMessageDeflate:false
    });
    let maximumBufferedBytes=0;
    socket.on('message',value => {
        try{
            inbox.push(decodeMessage(value));
        }catch(error){
            inbox.fail(error);
        }
    });
    socket.on('error',error => inbox.fail(error));
    await once(socket,'open');
    return {
        send(value){
            socket.send(encodeMessage(value),{binary:false,compress:false});
            maximumBufferedBytes=Math.max(maximumBufferedBytes,socket.bufferedAmount);
        },
        receive:inbox.receive,
        metrics:() => ({
            backpressureEvents:0,
            maximumBufferedBytes,
            wireBytesRead:socket._socket?.bytesRead ?? null,
            wireBytesWritten:socket._socket?.bytesWritten ?? null
        }),
        async close(){
            if(socket.readyState !== WebSocket.CLOSED){
                const closed=once(socket,'close');
                socket.close();
                await closed;
            }
            inbox.end();
        }
    };
}

export {
    createClient,
    createServer,
    metadata
};

