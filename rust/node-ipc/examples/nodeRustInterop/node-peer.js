#!/usr/bin/env node

import {IPCModule,FastParser} from '../../../../node-ipc.js';

const PING_EVENT='node-ipc.demo.ping';
const PONG_EVENT='node-ipc.demo.pong';
const CLIENT_ID='rust-ping-pong-demo';

const role=process.argv[2];
const host=process.argv[3] || '127.0.0.1';
const port=Number(process.argv[4] || 9763);
if((role !== 'server' && role !== 'client') ||
    !Number.isInteger(port) || port < 1 || port > 65535){
    throw new Error(
        'usage: node ./rust/node-ipc/examples/nodeRustInterop/node-peer.js '+
        '<server|client> [host] [port]'
    );
}

class TracingParser extends FastParser{
    encode(type,data){
        const frame=super.encode(type,data);
        console.log(`SEND RAW: ${visibleFrame(frame)}`);
        return frame;
    }

    read(buffer,data,receive){
        const parsed=this.push(buffer,data);
        for(const frame of parsed.events){
            console.log(`RECV RAW: ${visibleFrame(frame+this.delimiter)}`);
            receive(this.decode(frame));
        }
        return parsed.remainder;
    }
}

const ipc=new IPCModule;
ipc.config.silent=true;
ipc.config.parser=TracingParser;
ipc.config.sync=false;
ipc.config.stopRetrying=true;
ipc.config.maxRetries=0;
ipc.config.networkHost=host;
ipc.config.networkPort=port;
ipc.config.maxConnections=1;

if(role === 'server'){
    await runServer();
}else{
    await runClient();
}

function runServer(){
    return new Promise((resolve,reject) => {
        let settled=false;
        function fail(error){
            if(settled){
                return;
            }
            settled=true;
            ipc.server?.stop?.();
            reject(error instanceof Error ? error : new Error(String(error)));
        }

        ipc.serveNet(host,port,() => {
            console.log(`Node server listening on ${host}:${port}`);
        });
        ipc.server.on('error',fail);
        ipc.server.on(PING_EVENT,(data,socket) => {
            try{
                expectMessage(data,'ping');
                console.log('DECODED:  ping');
                ipc.server.emit(socket,PONG_EVENT,{message:'pong'});
                console.log('SENT:     pong');
                socket.end(() => {
                    ipc.server.server.close(() => {
                        if(!settled){
                            settled=true;
                            resolve();
                        }
                    });
                });
            }catch(error){
                fail(error);
            }
        });
        ipc.server.start();
    });
}

async function runClient(){
    ipc.connectToNet(CLIENT_ID,host,port);
    const client=ipc.of[CLIENT_ID];
    await waitForConnect(client);
    console.log(`Node client connected to ${host}:${port}`);

    try{
        const response=waitForPong(client);
        client.emit(PING_EVENT,{message:'ping'});
        console.log('SENT:     ping');
        await response;
        console.log('DECODED:  pong');
    }finally{
        ipc.disconnect(CLIENT_ID);
    }
}

function waitForConnect(client){
    return new Promise((resolve,reject) => {
        function cleanup(){
            client.off('connect',onConnect);
            client.off('error',onError);
        }
        function onConnect(){
            cleanup();
            resolve();
        }
        function onError(error){
            cleanup();
            reject(error);
        }
        client.on('connect',onConnect);
        client.on('error',onError);
    });
}

function waitForPong(client){
    return new Promise((resolve,reject) => {
        function cleanup(){
            client.off(PONG_EVENT,onPong);
            client.off('error',onError);
            client.off('disconnect',onDisconnect);
        }
        function onPong(data){
            cleanup();
            try{
                expectMessage(data,'pong');
                resolve();
            }catch(error){
                reject(error);
            }
        }
        function onError(error){
            cleanup();
            reject(error);
        }
        function onDisconnect(){
            cleanup();
            reject(new Error('peer disconnected before returning pong'));
        }
        client.on(PONG_EVENT,onPong);
        client.on('error',onError);
        client.on('disconnect',onDisconnect);
    });
}

function expectMessage(data,message){
    if(!data || data.message !== message){
        throw new Error(`expected message ${message}`);
    }
}

function visibleFrame(frame){
    return frame
        .replaceAll('\f','\\f')
        .replaceAll('\r','\\r')
        .replaceAll('\n','\\n')
        .replaceAll('\t','\\t');
}
