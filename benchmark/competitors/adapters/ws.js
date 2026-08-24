import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {localEndpoint,verifyStreamCleanup} from '../lib/endpoints.js';
import {createInbox} from '../lib/inbox.js';
import {
    assertAuthenticatedTls,
    clientTlsOptions,
    serverTlsOptions,
    tlsSessionMetadata
} from '../lib/tls.js';
import {decodeMessage,encodeMessage} from '../protocol.js';

const metadata={
    id:'ws',
    label:'ws 8.21.3',
    packages:['ws'],
    serialization:'canonical JSON over WebSocket text messages',
    topology:'unrelated processes',
    transport:'WebSocket over TCP, local IPC, or mutual TLS loopback'
};

function transportId(lane){
    return lane?.transportId ?? 'tcp';
}

async function createServer({lane,onError}){
    const selected=transportId(lane);
    const sockets=new Set();
    const networkServer=selected === 'tls'
        ? createHttpsServer(serverTlsOptions())
        : createHttpServer();
    const server=new WebSocketServer({
        server:networkServer,
        perMessageDeflate:false,
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
    networkServer.on('error',onError);
    if(selected === 'tls'){
        networkServer.on('secureConnection',socket => {
            try{
                assertAuthenticatedTls(socket,'ws server');
            }catch(error){
                socket.destroy(error);
                onError(error);
            }
        });
    }
    const target=selected === 'local'
        ? localEndpoint(lane?.id)
        : {host:'127.0.0.1',port:0};
    networkServer.listen(target.path ? {path:target.path} : target);
    await once(networkServer,'listening');
    const address=networkServer.address();
    const endpoint=typeof address === 'string'
        ? {implementation:target.implementation,path:address}
        : {host:'127.0.0.1',port:address.port};
    return {
        endpoint,
        async close(){
            for(const socket of sockets){
                socket.terminate();
            }
            await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
            if(networkServer.listening){
                await new Promise((resolve,reject) => networkServer.close(error => error ? reject(error) : resolve()));
            }
        }
    };
}

async function createClient({endpoint,lane}){
    const inbox=createInbox();
    const selected=transportId(lane);
    const url=selected === 'local'
        ? `ws+unix:${endpoint.path}:/`
        : selected === 'tls'
            ? `wss://localhost:${endpoint.port}`
            : `ws://${endpoint.host}:${endpoint.port}`;
    const socket=new WebSocket(url,{
        ...(selected === 'tls' ? clientTlsOptions() : {}),
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
    if(selected === 'tls'){
        assertAuthenticatedTls(socket._socket,'ws client');
    }
    return {
        send(value){
            socket.send(encodeMessage(value),{binary:false,compress:false});
            maximumBufferedBytes=Math.max(maximumBufferedBytes,socket.bufferedAmount);
        },
        receive:inbox.receive,
        metrics:() => ({
            backpressureEvents:0,
            maximumBufferedBytes,
            tls:selected === 'tls' ? tlsSessionMetadata(socket._socket) : null,
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
    metadata,
    verifyStreamCleanup as verifyCleanup
};
