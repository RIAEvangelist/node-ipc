import dgram from 'node:dgram';
import {readFileSync} from 'node:fs';
import {lstat} from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import {fileURLToPath} from 'node:url';

const config=JSON.parse(process.argv[2] || '{}');
const resources=() => process.getActiveResourcesInfo().sort();
const baselineResources=resources();
let cpuStart=process.cpuUsage();
let wallStart=process.hrtime.bigint();
const sockets=new Set;
const stats={bytesIn:0,bytesOut:0,messagesIn:0,messagesOut:0,pendingSends:0};
let server;
let stopping=false;

function difference(before,after){
    const remaining=[...before];
    return after.filter((resource) => {
        const index=remaining.indexOf(resource);
        if(index === -1) return true;
        remaining.splice(index,1);
        return false;
    });
}

function send(message){
    process.send?.(message);
}

function streamConnection(socket){
    sockets.add(socket);
    socket.setNoDelay?.(true);
    socket.on('data',(data) => {
        stats.bytesIn+=data.length;
        stats.messagesIn+=1;
        stats.bytesOut+=data.length;
        stats.messagesOut+=1;
        if(!socket.write(data)){
            socket.pause();
            socket.once('drain',() => socket.resume());
        }
    });
    socket.once('close',() => sockets.delete(socket));
    socket.once('error',(error) => send({type:'socket-error',error:error.message}));
}

function ready(endpoint){
    send({type:'ready',endpoint,pid:process.pid});
}

function startStream(){
    if(config.transport === 'tls'){
        server=tls.createServer({
            cert:readFileSync(config.certificates.serverCertificate),
            key:readFileSync(config.certificates.serverKey)
        },streamConnection);
    }else{
        server=net.createServer(streamConnection);
    }
    server.once('error',(error) => send({type:'error',error:error.stack || error.message}));
    if(config.transport === 'local'){
        server.listen(config.endpointPath,() => ready({path:config.endpointPath}));
        return;
    }
    server.listen(0,config.host,() => {
        const address=server.address();
        ready({host:config.host,port:address.port});
    });
}

function startDatagram(){
    server=dgram.createSocket(config.transport);
    server.on('message',(message,rinfo) => {
        stats.bytesIn+=message.length;
        stats.messagesIn+=1;
        stats.pendingSends+=1;
        server.send(message,rinfo.port,rinfo.address,(error) => {
            stats.pendingSends-=1;
            if(error){send({type:'socket-error',error:error.message});return;}
            stats.bytesOut+=message.length;
            stats.messagesOut+=1;
        });
    });
    server.once('error',(error) => send({type:'error',error:error.stack || error.message}));
    server.bind(0,config.host,() => {
        const address=server.address();
        ready({host:config.host,port:address.port});
    });
}

async function close(){
    if(stopping) return;
    stopping=true;
    for(const socket of sockets) socket.destroy();
    await new Promise((resolve) => {
        if(!server) return resolve();
        try{server.close(resolve);}catch{resolve();}
    });
    await new Promise((resolve) => setImmediate(resolve));
    const cpu=process.cpuUsage(cpuStart);
    const wallNs=process.hrtime.bigint()-wallStart;
    const endpointRemoved=config.transport !== 'local' || process.platform === 'win32'
        ? true
        : await lstat(config.endpointPath).then(() => false,() => true);
    await new Promise((resolve) => setImmediate(resolve));
    const observedActiveResources=difference(baselineResources,resources());
    const closedResources=new Set(['PipeWrap','TCPServerWrap','UDPWrap']);
    const activeResourceDelta=observedActiveResources.filter((resource) => !closedResources.has(resource));
    send({
        type:'cleanup',
        cleanup:{
            activeHandles:activeResourceDelta,
            activeResourceDelta,
            clean:sockets.size === 0 && stats.pendingSends === 0 && endpointRemoved && activeResourceDelta.length === 0,
            endpointRemoved,
            observedActiveResources,
            openSockets:sockets.size,
            pendingSends:stats.pendingSends
        },
        cpu,
        stats,
        wallNs:wallNs.toString()
    });
    process.disconnect?.();
}

process.on('message',(message) => {
    if(message === 'measure'){
        cpuStart=process.cpuUsage();
        wallStart=process.hrtime.bigint();
        send({type:'measure-ready'});
        return;
    }
    if(message === 'close') close().catch((error) => {
        send({type:'error',error:error.stack || error.message});
        process.exitCode=1;
        process.disconnect?.();
    });
});

if(['udp4','udp6'].includes(config.transport)) startDatagram();
else startStream();

export {close};
