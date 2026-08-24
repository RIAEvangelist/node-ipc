import {createHash} from 'node:crypto';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {lstat} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

function endpointToken(laneId='benchmark'){
    return createHash('sha256')
        .update(`${process.cwd()}\0${laneId}`)
        .digest('hex')
        .slice(0,16);
}

function localEndpoint(laneId='benchmark'){
    const token=endpointToken(laneId);
    if(process.platform === 'win32'){
        return {
            implementation:'windows-named-pipe',
            path:`\\\\.\\pipe\\node-ipc-bench-${token}`
        };
    }
    const socketPath=path.join(process.cwd(),`ipc-${token}.sock`);
    if(Buffer.byteLength(socketPath) > 100){
        throw new Error(`local IPC path is too long: ${socketPath}`);
    }
    return {
        implementation:'unix-domain-socket',
        path:socketPath
    };
}

function nodeIpcLocalEndpoint(laneId='node-ipc:local'){
    const endpoint=localEndpoint(laneId);
    return {
        ...endpoint,
        logicalPath:process.platform === 'win32'
            ? `/node-ipc-bench-${endpointToken(laneId)}`
            : endpoint.path
    };
}

function streamTarget(endpoint){
    if(endpoint?.path){
        return {path:endpoint.path};
    }
    if(endpoint?.host && endpoint?.port){
        return {host:endpoint.host,port:endpoint.port};
    }
    if(endpoint?.url?.startsWith('tcp://')){
        const value=new URL(endpoint.url);
        return {host:value.hostname,port:Number(value.port)};
    }
    return null;
}

function attemptConnection(target){
    return new Promise(resolve => {
        const socket=net.createConnection(target);
        let settled=false;
        const finish=value => {
            if(settled){
                return;
            }
            settled=true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(500,() => finish(false));
        socket.once('connect',() => finish(false));
        socket.once('error',() => finish(true));
    });
}

function attemptListen(target){
    return new Promise(resolve => {
        const server=net.createServer();
        let settled=false;
        const finish=value => {
            if(settled){
                return;
            }
            settled=true;
            if(server.listening){
                server.close(() => resolve(value));
            }else{
                resolve(value);
            }
        };
        server.once('error',() => finish(false));
        server.listen(target,() => finish(true));
    });
}

async function artifactRemoved(endpoint){
    if(process.platform === 'win32' || !endpoint?.path){
        return null;
    }
    try{
        await lstat(endpoint.path);
        return false;
    }catch(error){
        if(error.code === 'ENOENT'){
            return true;
        }
        throw error;
    }
}

async function verifyStreamCleanup({endpoint}){
    const target=streamTarget(endpoint);
    if(!target){
        return {artifactRemoved:null,closed:null,reusable:null};
    }
    const closed=await attemptConnection(target);
    const reusable=await attemptListen(target);
    const removed=await artifactRemoved(endpoint);
    return {artifactRemoved:removed,closed,reusable};
}

async function verifyDatagramCleanup({endpoint,lane}){
    const type=endpoint?.type ?? lane?.transportId;
    if(!endpoint?.host || !Number.isSafeInteger(endpoint?.port) || !['udp4','udp6'].includes(type)){
        return {artifactRemoved:null,closed:null,reusable:null};
    }
    const socket=dgram.createSocket(type);
    let reusable=false;
    try{
        socket.bind({
            address:endpoint.host,
            exclusive:true,
            port:endpoint.port
        });
        await once(socket,'listening');
        reusable=true;
    }catch{
        reusable=false;
    }finally{
        try{
            socket.address();
            const closed=once(socket,'close');
            socket.close();
            await closed;
        }catch{}
    }
    return {artifactRemoved:null,closed:reusable,reusable};
}

export {
    endpointToken,
    localEndpoint,
    nodeIpcLocalEndpoint,
    streamTarget,
    verifyDatagramCleanup,
    verifyStreamCleanup
};
