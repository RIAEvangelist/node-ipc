import {createServer as createHttpServer} from 'node:http';
import {once} from 'node:events';
import {Server} from 'socket.io';
import {io as createSocket} from 'socket.io-client';
import {createInbox} from '../lib/inbox.js';

const event='benchmark.message';
const metadata={
    id:'socket-io',
    label:'Socket.IO 4.8.3 stack',
    packages:['socket.io','socket.io-client'],
    serialization:'Socket.IO event serialization',
    topology:'unrelated processes',
    transport:'Socket.IO over WebSocket and TCP loopback'
};

async function createServer({onError}){
    const httpServer=createHttpServer();
    const io=new Server(httpServer,{
        httpCompression:false,
        perMessageDeflate:false,
        serveClient:false,
        transports:['websocket']
    });
    io.on('connection',socket => {
        socket.on(event,value => socket.emit(event,value));
        socket.on('error',onError);
    });
    io.engine.on('connection_error',onError);
    httpServer.on('error',onError);
    httpServer.listen({host:'127.0.0.1',port:0});
    await once(httpServer,'listening');
    const address=httpServer.address();
    return {
        endpoint:{host:'127.0.0.1',port:address.port},
        async close(){
            await new Promise(resolve => io.close(resolve));
        }
    };
}

async function createClient({endpoint}){
    const inbox=createInbox();
    const socket=createSocket(`http://${endpoint.host}:${endpoint.port}`,{
        forceNew:true,
        reconnection:false,
        transports:['websocket'],
        upgrade:false
    });
    socket.on(event,value => inbox.push(value));
    socket.on('connect_error',error => inbox.fail(error));
    socket.on('error',error => inbox.fail(error));
    await once(socket,'connect');
    return {
        send:value => socket.emit(event,value),
        receive:inbox.receive,
        metrics:() => ({backpressureEvents:0}),
        async close(){
            socket.disconnect();
            inbox.end();
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

export {
    createClient,
    createServer,
    metadata
};

