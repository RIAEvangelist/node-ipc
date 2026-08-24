import {once} from 'node:events';
import {IPCModule} from '../../../node-ipc.js';
import {createInbox} from '../lib/inbox.js';
import {reserveTcpPort} from '../lib/port.js';

const event='benchmark.message';
const metadata={
    id:'node-ipc',
    label:'node-ipc 14 fast profile',
    packages:['node-ipc'],
    serialization:'node-ipc fast event framing',
    topology:'unrelated processes',
    transport:'TCP loopback'
};

function configure(ipc){
    ipc.config.id='benchmark';
    ipc.config.maxRetries=0;
    ipc.config.parser='fast';
    ipc.config.silent=true;
    ipc.config.stopRetrying=true;
}

async function createServer({onError}){
    const host='127.0.0.1';
    const port=await reserveTcpPort(host);
    const ipc=new IPCModule;
    configure(ipc);
    const started=new Promise(resolve => ipc.serveNet(host,port,resolve));
    ipc.server.on(event,(value,socket) => ipc.server.emit(socket,event,value));
    ipc.server.on('error',onError);
    ipc.server.start();
    await started;
    return {
        endpoint:{host,port},
        async close(){
            ipc.server.stop();
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

async function createClient({endpoint}){
    const ipc=new IPCModule;
    const inbox=createInbox();
    const id='benchmark-server';
    let channel;
    let backpressureEvents=0;
    configure(ipc);
    await new Promise((resolve,reject) => {
        ipc.connectToNet(id,endpoint.host,endpoint.port,() => {
            channel=ipc.of[id];
            channel.once('connect',resolve);
            channel.once('error',reject);
        });
    });
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
    metadata
};
