import {once} from 'node:events';
import {IPCModule} from '../../../node-ipc.js';
import {
    nodeIpcLocalEndpoint,
    verifyDatagramCleanup,
    verifyStreamCleanup
} from '../lib/endpoints.js';
import {createInbox} from '../lib/inbox.js';
import {reserveTcpPort,reserveUdpPort} from '../lib/port.js';
import {
    assertAuthenticatedTls,
    clientTlsOptions,
    serverTlsOptions,
    tlsSessionMetadata
} from '../lib/tls.js';
import {
    assertDatagram,
    createFragmentReassembler,
    fragmentMessage,
    udpChunkBytes,
    udpDatagramBytes,
    udpDatagramWindow
} from '../lib/udp.js';

const event='benchmark.message';
const udpEvent='benchmark.udp.fragment';
const metadata={
    id:'node-ipc',
    label:'node-ipc 14 fast profile',
    packages:['node-ipc'],
    serialization:'node-ipc fast event framing',
    topology:'unrelated processes',
    transport:'TCP, local IPC, mutual TLS, UDP4, or UDP6 loopback'
};

function transportId(lane){
    return lane?.transportId ?? 'tcp';
}

function isUdp(selected){
    return selected === 'udp4' || selected === 'udp6';
}

function udpHost(selected){
    return selected === 'udp4' ? '127.0.0.1' : '::1';
}

function createUdpCounters(){
    return {
        datagramsRead:0,
        datagramsWritten:0,
        maximumDatagramBytes:0,
        udpPayloadBytesRead:0,
        udpPayloadBytesWritten:0
    };
}

function tuneUdpSocket(socket){
    for(const method of ['setRecvBufferSize','setSendBufferSize']){
        try{
            socket[method](8*1024*1024);
        }catch{}
    }
}

function recordDatagram(counters,direction,data,label){
    const bytes=assertDatagram(data,label);
    counters[`datagrams${direction}`]+=1;
    counters[`udpPayloadBytes${direction}`]+=bytes;
    counters.maximumDatagramBytes=Math.max(counters.maximumDatagramBytes,bytes);
    return bytes;
}

function observeUdpSocket(socket,counters,{countRead=false,countWritten=false}={}){
    if(countRead){
        socket.on('message',message => {
            recordDatagram(counters,'Read',message,'node-ipc received UDP event');
        });
    }
    const originalSend=socket.send.bind(socket);
    socket.send=(data,...arguments_) => {
        if(countWritten){
            recordDatagram(counters,'Written',data,'node-ipc encoded UDP event');
        }else{
            assertDatagram(data,'node-ipc encoded UDP event');
        }
        return originalSend(data,...arguments_);
    };
}

function udpMetrics(counters,reassembler){
    return {
        ...counters,
        ...reassembler.metrics(),
        backpressureEvents:0,
        fragmentPayloadBytes:udpChunkBytes,
        maximumAllowedDatagramBytes:udpDatagramBytes,
        maximumOutstandingDatagrams:udpDatagramWindow,
        tls:null,
        wireBytesRead:counters.udpPayloadBytesRead,
        wireBytesWritten:counters.udpPayloadBytesWritten
    };
}

async function stopServer(ipc){
    const networkServer=ipc.server.server;
    let closed=null;
    try{
        networkServer?.address?.();
        closed=once(networkServer,'close');
    }catch{}
    ipc.server.stop();
    if(closed){
        await closed;
    }
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
    if(isUdp(selected)){
        const host=udpHost(selected);
        const port=await reserveUdpPort(host,selected);
        const requests=createFragmentReassembler({direction:'q'});
        const counters=createUdpCounters();
        const started=new Promise(resolve => ipc.serveNet(host,port,selected,resolve));
        ipc.server.on(udpEvent,(fragment,peer) => {
            try{
                const complete=requests.accept(fragment,peer);
                if(!complete){
                    return;
                }
                for(const response of fragmentMessage(complete.message,'r')){
                    ipc.server.emit(peer,udpEvent,response);
                }
            }catch(error){
                onError(error);
            }
        });
        ipc.server.on('error',onError);
        ipc.server.start();
        await started;
        tuneUdpSocket(ipc.server.server);
        observeUdpSocket(ipc.server.server,counters);
        return {
            endpoint:{host,port,type:selected},
            async close(){
                const pending=requests.metrics().pendingMessages;
                await stopServer(ipc);
                requests.clear();
                if(pending !== 0){
                    throw new Error(`node-ipc UDP server closed with ${pending} incomplete messages`);
                }
            }
        };
    }
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
            await stopServer(ipc);
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
    if(isUdp(selected)){
        const host=udpHost(selected);
        const port=await reserveUdpPort(host,selected);
        const responses=createFragmentReassembler({direction:'r'});
        const counters=createUdpCounters();
        const started=new Promise(resolve => ipc.serveNet(host,port,selected,resolve));
        ipc.server.on(udpEvent,(fragment,peer) => {
            try{
                if(peer.address !== endpoint.host || peer.port !== endpoint.port){
                    throw new Error(`node-ipc UDP received an unexpected peer ${peer.address}:${peer.port}`);
                }
                const complete=responses.accept(fragment,peer);
                if(complete){
                    inbox.push(complete.message);
                }
            }catch(error){
                inbox.fail(error);
            }
        });
        ipc.server.on('error',error => inbox.fail(error));
        ipc.server.start();
        await started;
        tuneUdpSocket(ipc.server.server);
        observeUdpSocket(ipc.server.server,counters,{countRead:true,countWritten:true});
        return {
            send(value){
                const peer={address:endpoint.host,port:endpoint.port};
                for(const fragment of fragmentMessage(value,'q')){
                    ipc.server.emit(peer,udpEvent,fragment);
                }
            },
            receive:inbox.receive,
            metrics:() => udpMetrics(counters,responses),
            async close(){
                const pending=responses.metrics().pendingMessages;
                await stopServer(ipc);
                responses.clear();
                inbox.end();
                if(pending !== 0){
                    throw new Error(`node-ipc UDP client closed with ${pending} incomplete messages`);
                }
            }
        };
    }
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

async function verifyCleanup(context){
    return isUdp(transportId(context.lane))
        ? verifyDatagramCleanup(context)
        : verifyStreamCleanup(context);
}

export {
    createClient,
    createServer,
    metadata,
    verifyCleanup
};
