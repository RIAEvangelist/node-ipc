import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {once} from 'node:events';
import {Server} from 'socket.io';
import {io as createSocket} from 'socket.io-client';
import {verifyStreamCleanup} from '../lib/endpoints.js';
import {createInbox} from '../lib/inbox.js';
import {
    assertAuthenticatedTls,
    clientTlsOptions,
    serverTlsOptions,
    tlsSessionMetadata
} from '../lib/tls.js';

const event='benchmark.message';
const metadata={
    id:'socket-io',
    label:'Socket.IO 4.8.3 stack',
    packages:['socket.io','socket.io-client'],
    serialization:'Socket.IO event serialization',
    topology:'unrelated processes',
    transport:'Socket.IO over WebSocket and TCP or mutual TLS loopback'
};

function transportId(lane){
    return lane?.transportId ?? 'tcp';
}

function transportSocket(socket){
    const transport=socket.io.engine.transport;
    return transport?.socket?._socket ?? transport?.ws?._socket ?? null;
}

async function createServer({lane,onError}){
    const selected=transportId(lane);
    const httpServer=selected === 'tls'
        ? createHttpsServer(serverTlsOptions())
        : createHttpServer();
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
    if(selected === 'tls'){
        httpServer.on('secureConnection',socket => {
            try{
                assertAuthenticatedTls(socket,'Socket.IO server');
            }catch(error){
                socket.destroy(error);
                onError(error);
            }
        });
    }
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

async function createClient({endpoint,lane}){
    const inbox=createInbox();
    const selected=transportId(lane);
    const socket=createSocket(
        `${selected === 'tls' ? 'https://localhost' : `http://${endpoint.host}`}:${endpoint.port}`,
        {
        ...(selected === 'tls' ? clientTlsOptions() : {}),
        forceNew:true,
        reconnection:false,
        transports:['websocket'],
        upgrade:false
    });
    socket.on(event,value => inbox.push(value));
    socket.on('error',error => inbox.fail(error));
    try{
        await new Promise((resolve,reject) => {
            const cleanup=() => {
                socket.off('connect',connected);
                socket.off('connect_error',failed);
            };
            const connected=() => {
                cleanup();
                resolve();
            };
            const failed=error => {
                cleanup();
                reject(error);
            };
            socket.once('connect',connected);
            socket.once('connect_error',failed);
        });
    }catch(error){
        socket.disconnect();
        inbox.end();
        throw error;
    }
    socket.on('connect_error',error => inbox.fail(error));
    const networkSocket=transportSocket(socket);
    if(selected === 'tls'){
        assertAuthenticatedTls(networkSocket,'Socket.IO client');
    }
    return {
        send:value => socket.emit(event,value),
        receive:inbox.receive,
        metrics:() => ({
            backpressureEvents:0,
            tls:selected === 'tls' ? tlsSessionMetadata(networkSocket) : null,
            wireBytesRead:networkSocket?.bytesRead ?? null,
            wireBytesWritten:networkSocket?.bytesWritten ?? null
        }),
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
    metadata,
    verifyStreamCleanup as verifyCleanup
};
