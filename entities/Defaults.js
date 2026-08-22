import os from 'os';
import path from 'path';

class Defaults{

    constructor(){

    }


    appspace='app.';
    socketRoot=getSocketRoot();
    id=os.hostname();

    encoding='utf8';
    rawBuffer=false;
    parser='fast';
    sync=false;
    unlink=true;
    identifyPeer=false;

    delimiter='\f';
    maxMessageSize=1024*1024;
    maxPendingBytes=8*1024*1024;
    maxEventNameLength=256;
    messageTimeout=30000;
    allowReservedEvents=false;
    allowedEvents=false;

    silent=false;
    logPayloads=false;
    logDepth=5;
    logInColor=true;
    logger=console.log.bind(console);

    maxConnections=100;
    retry=500;
    maxRetries=Infinity;
    stopRetrying=false;

    IPType=getIPType();
    tls=false;
    networkHost = (this.IPType == 'IPv6') ? '::1' : '127.0.0.1';
    networkPort = 8000;

    readableAll = false;
    writableAll = false;
    secureSocketRoot = true;

    interface={
        localAddress:false,
        localPort:false,
        family:false,
        hints:false,
        lookup:false
    }
    
}

function getSocketRoot(){
    const userName=safePathSegment(getUserName());
    if(process.platform === 'win32'){
        return `/node-ipc-${userName}/`;
    }

    const runtimeRoot=process.env.XDG_RUNTIME_DIR;
    if(runtimeRoot){
        return path.join(runtimeRoot,'node-ipc')+path.sep;
    }

    const userId=typeof process.getuid === 'function' ? process.getuid() : userName;
    return path.join(os.tmpdir(),`node-ipc-${userId}`)+path.sep;
}

function getUserName(){
    try{
        return os.userInfo().username;
    }catch{
        return 'user';
    }
}

function safePathSegment(value){
    return String(value).replace(/[^a-zA-Z0-9_.-]/g,'_');
}

function getIPType() {
    const interfaces=os.networkInterfaces();
    for(const addresses of Object.values(interfaces || {})){
        if(addresses?.length){
            return addresses[0].family;
        }
    }
    return '';
}

export {
    Defaults as default,
    Defaults
}
