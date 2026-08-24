import {once} from 'node:events';
import {IPCModule} from '../../../node-ipc.js';
import {nodeIpcLocalEndpoint,verifyStreamCleanup} from '../lib/endpoints.js';
import {createInbox} from '../lib/inbox.js';
import {reserveTcpPort} from '../lib/port.js';
import {
    assertAuthenticatedTls,
    clientTlsOptions,
    serverTlsOptions,
    tlsSessionMetadata
} from '../lib/tls.js';

const event='benchmark.message';
const metadata={
    id:'node-ipc',
    label:'node-ipc 14 fast profile',
    packages:['node-ipc'],
    serialization:'node-ipc fast event framing',
    topology:'unrelated processes',
    transport:'TCP, local IPC, or mutual TLS loopback'
};

function transportId(lane){
    return lane?.transportId ?? 'tcp';
}

function configure(ipc,lane,role){
    ipc.config.id='benchmark';
    ipc.config.maxRetries=0;
    ipc.config.parser='fast';
    ipc.config.silent=true;
    ipc.config.stopRetrying=true;
    if(transportId(lane) === 'tls'){
        ipc.config.tls=role === 'server' ? serverTlsOptions() : clientTlsOptions();
    }
}

async function createServer({lane,onError}){
    const selected=transportId(lane);
    const ipc=new IPCModule;
    configure(ipc,lane,'server');
    let host;
    let port;
    let local;
    let started;
    if(selected === 'local'){
        local=nodeIpcLocalEndpoint(lane?.id);
        started=new Promise(resolve => ipc.serve(local.logicalPath,resolve));
    }else{
        host='127.0.0.1';
        port=await reserveTcpPort(host);
        started=new Promise(resolve => ipc.serveNet(host,port,resolve));
    }
    ipc.server.on(event,(value,socket) => ipc.server.emit(socket,event,value));
    ipc.server.on('error',onError);
    ipc.server.start();
    await started;
    if(selected === 'tls'){
        ipc.server.server.on('secureConnection',socket => {
            try{
                assertAuthenticatedTls(socket,'node-ipc server');
            }catch(error){
                socket.destroy(error);
                onError(error);
            }
        });
    }
    return {
        endpoint:selected === 'local'
            ? {implementation:local.implementation,path:ipc.server.path}
            : {host,port},
        async close(){
            const networkServer=ipc.server.server;
            const closed=networkServer?.listening ? once(networkServer,'close') : null;
            ipc.server.stop();
            if(closed){
                await closed;
            }
        }
    };
}

async function createClient({endpoint,lane}){
    const ipc=new IPCModule;
    const inbox=createInbox();
    const id='benchmark-server';
    let channel;
    let backpressureEvents=0;
    const selected=transportId(lane);
    configure(ipc,lane,'client');
    await new Promise((resolve,reject) => {
        const connected=() => {
            channel=ipc.of[id];
            channel.once('connect',resolve);
            channel.once('error',reject);
        };
        if(selected === 'local'){
            ipc.connectTo(id,endpoint.path,connected);
        }else{
            ipc.connectToNet(id,endpoint.host,endpoint.port,connected);
        }
    });
    if(selected === 'tls'){
        assertAuthenticatedTls(channel.socket,'node-ipc client');
    }
    channel.on(event,value => inbox.push(value));
    channel.on('error',error => inbox.fail(error));
    return {
        send(value){
            if(channel.emit(event,value) !== false){
                return undefined;
            }
            backpressureEvents+=1;
            return once(channel.socket,'drain').then(() => undefined);
        },
        receive:inbox.receive,
        metrics:() => ({
            backpressureEvents,
            tls:selected === 'tls' ? tlsSessionMetadata(channel.socket) : null,
            wireBytesRead:channel.socket.bytesRead,
            wireBytesWritten:channel.socket.bytesWritten
        }),
        async close(){
            ipc.disconnect(id);
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
