import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import Events from 'event-pubsub';
import {createParser,IPCProtocolError} from '../entities/EventParser.js';
import {createServerTLSOptions} from '../entities/TLS.js';

class Server extends Events{
    constructor(socketPath,config,log,port){
        super();
        this.config=config;
        this.path=socketPath;
        this.port=port;
        this.log=log;
        this.publish=super.emit;
        this.parser=createParser(config);
        this.raw=this.parser.raw;
        this.encoding=this.parser.encoding || 'utf8';
        this.encode=this.parser.encode.bind(this.parser);
        const boundedWrites=Number.isFinite(this.parser.maxPendingBytes);
        this.writeStream=boundedWrites
            ? this.writeStreamGuarded
            : this.writeStreamDirect;
        this.sendDatagram=boundedWrites
            ? this.sendDatagramGuarded
            : this.sendDatagramDirect;
        this.datagramCallback=boundedWrites
            ? this.handleDatagramError.bind(this)
            : null;
        this.writeDatagram=this.raw || this.encoding === 'utf8'
            ? this.writeDatagramDirect
            : this.writeDatagramEncoded;
        this.receive=this.raw
            ? this.receiveRaw
            : (this.parser.messageTimeout ? this.receiveGuarded : this.receiveFramed);
        if(config.logPayloads){
            this.dispatch=config.identifyPeer
                ? this.dispatchIdentifiedLogged
                : this.dispatchLogged;
        }else{
            this.dispatch=config.identifyPeer
                ? this.dispatchIdentified
                : this.dispatchDirect;
        }
        this.emit=config.logPayloads ? this.emitLogged : this.emitDirect;
        this.broadcast=config.logPayloads ? this.broadcastLogged : this.broadcastDirect;
        this.selectTransport();
        this.on('close',(socket) => this.removeSocket(socket));
    }

    _udp4=false;
    _udp6=false;
    server=false;
    sockets=[];
    lastPeer=false;

    get udp4(){
        return this._udp4;
    }

    set udp4(value){
        this._udp4=value;
        this.selectTransport();
    }

    get udp6(){
        return this._udp6;
    }

    set udp6(value){
        this._udp6=value;
        this.selectTransport();
    }

    selectTransport(){
        if(this._udp4 || this._udp6){
            this.write=this.writeDatagram;
            this.writeAll=this.writeAllDatagrams;
            return;
        }
        this.write=this.writeStream;
        this.writeAll=this.writeAllStreams;
    }

    onStart(socket){
        this.publish('start',socket);
    }

    start(){
        if(!this.path){
            this.log('socket server path not specified');
            return;
        }

        if(!this.port && this.parser.profile === 'assured' && process.platform === 'win32'){
            throw new IPCProtocolError(
                'ERR_IPC_ASSURED_TRANSPORT',
                'Assured local transport requires Unix socket ownership checks; use mutual TLS or an application-owned Windows ACL.'
            );
        }
        if(!this.port && this.parser.profile === 'assured' && !this.config.secureSocketRoot){
            throw new IPCProtocolError(
                'ERR_IPC_ASSURED_TRANSPORT',
                'The assured parser requires secureSocketRoot for local sockets.'
            );
        }
        if(!this.port && this.parser.profile === 'assured' && !socketPathInRoot(this)){
            throw new IPCProtocolError(
                'ERR_IPC_ASSURED_TRANSPORT',
                'The assured parser requires a local endpoint inside socketRoot.'
            );
        }

        if(!this.port && process.platform !== 'win32'){
            prepareSocketRoot(this);
            if(this.config.unlink){
                unlinkSocket(this.path);
            }
        }

        this.startServer();
    }

    stop(){
        for(const socket of this.sockets){
            this.clearMessageTimer(socket);
            socket.destroy?.();
        }
        this.sockets.length=0;
        this.lastPeer=false;
        if(this.server && typeof this.server.close === 'function'){
            this.server.close();
        }
    }

    emitDirect(socket,type,data){
        return this.write(socket,this.encode(type,data));
    }

    emitLogged(socket,type,data){
        this.log('dispatching event to socket',type,data);
        return this.write(socket,this.encode(type,data));
    }

    broadcastDirect(type,data){
        return this.writeAll(this.encode(type,data));
    }

    broadcastLogged(type,data){
        this.log('broadcasting event',type,data);
        return this.writeAll(this.encode(type,data));
    }

    writeAllStreams(message){
        let writable=true;
        for(const socket of this.sockets){
            const result=this.writeStream(socket,message);
            if(result === false){
                writable=false;
            }
        }
        return writable;
    }

    writeAllDatagrams(message){
        for(const socket of this.sockets){
            this.writeDatagram(socket,message);
        }
        return true;
    }

    writeStreamDirect(socket,message){
        return socket.write(message);
    }

    writeStreamGuarded(socket,message){
        const bytes=Buffer.isBuffer(message)
            ? message.length
            : Buffer.byteLength(message,this.encoding);
        if(socket.writableLength+bytes > this.parser.maxPendingBytes){
            this.protocolFailure(
                socket,
                new IPCProtocolError(
                    'ERR_IPC_BACKPRESSURE',
                    'pending socket writes exceed maxPendingBytes'
                )
            );
            return false;
        }
        return socket.write(message);
    }

    writeDatagramDirect(socket,message){
        if(!socket?.address || !socket?.port){
            return this.writeAllDatagrams(message);
        }
        return this.sendDatagram(message,socket.port,socket.address);
    }

    writeDatagramEncoded(socket,message){
        if(!socket?.address || !socket?.port){
            return this.writeAllDatagrams(message);
        }
        return this.sendDatagram(
            Buffer.from(message,this.encoding),
            socket.port,
            socket.address
        );
    }

    sendDatagramDirect(data,port,address){
        this.server.send(data,port,address);
        return true;
    }

    sendDatagramGuarded(data,port,address){
        this.server.send(data,port,address,this.datagramCallback);
        return true;
    }

    handleDatagramError(error){
        if(!error){
            return;
        }
        this.log('error writing datagram',error);
        this.publish('error',error);
    }

    startServer(){
        this.log('starting server on',this.path,this.port ? `:${this.port}` : '');
        if(this.parser.profile === 'assured' && (this.udp4 || this.udp6 || (this.port && !this.config.tls))){
            throw new IPCProtocolError(
                'ERR_IPC_ASSURED_TRANSPORT',
                'The assured parser requires TLS for network servers.'
            );
        }
        if(this.udp4 || this.udp6){
            this.startDatagramServer();
            return;
        }

        this.server=this.config.tls
            ? tls.createServer(
                createServerTLSOptions(
                    this.config.tls,
                    this.parser.profile === 'assured'
                ),
                (socket) => this.addSocket(socket)
            )
            : net.createServer((socket) => this.addSocket(socket));
        this.server.maxConnections=this.config.maxConnections;
        this.server.on('error',(error) => this.serverError(error));

        if(!this.port){
            if(process.platform === 'win32'){
                this.path=`\\\\.\\pipe\\${this.path.replace(/^\//,'').replace(/\//g,'-')}`;
            }
            this.server.listen({
                path:this.path,
                readableAll:this.config.readableAll,
                writableAll:this.config.writableAll
            },() => this.onStart(this.server));
            return;
        }

        this.server.listen(this.port,this.path,() => this.onStart(this.server));
    }

    startDatagramServer(){
        this.server=dgram.createSocket(this.udp4 ? 'udp4' : 'udp6');
        this.server.on('error',(error) => this.serverError(error));
        this.server.on('message',(message,rinfo) => this.receiveDatagram(message,rinfo));
        this.server.bind(this.port,this.path,() => {
            this.publish('connect',this.server);
            this.onStart(this.server);
        });
    }

    addSocket(socket){
        this.sockets.push(socket);
        socket.setNoDelay?.(true);
        socket.ipcBuffer='';
        socket.ipcDispatch=(message) => this.dispatch(message,socket);
        if(!this.raw){
            socket.setEncoding(this.encoding);
        }
        socket.on('close',() => this.publish('close',socket));
        socket.on('error',(error) => {
            this.log('server socket error',error);
            this.publish('error',error);
        });
        socket.on('data',(data) => this.receive(socket,data));
        this.publish('connect',socket);
    }

    receiveDatagram(message,rinfo){
        const peer=this.peer(rinfo);
        const data=this.raw ? message : message.toString(this.encoding);
        this.receive(peer,data);
    }

    peer(rinfo){
        let peer=this.lastPeer;
        if(peer?.address === rinfo.address && peer.port === rinfo.port){
            return peer;
        }
        for(let index=0;index<this.sockets.length;index++){
            peer=this.sockets[index];
            if(peer.address === rinfo.address && peer.port === rinfo.port){
                this.lastPeer=peer;
                return peer;
            }
        }

        peer={...rinfo,ipcBuffer:''};
        peer.ipcDispatch=(message) => this.dispatch(message,peer);
        this.sockets.push(peer);
        this.lastPeer=peer;
        return peer;
    }

    receiveRaw(socket,data){
        this.publish('data',data,socket);
    }

    receiveFramed(socket,data){
        try{
            socket.ipcBuffer=this.parser.read(socket.ipcBuffer || '',data,socket.ipcDispatch);
        }catch(error){
            this.handleReadError(socket,error);
        }
    }

    receiveGuarded(socket,data){
        this.receiveFramed(socket,data);
        if(socket.destroyed){
            return;
        }
        if(socket.ipcBuffer){
            this.startMessageTimer(socket);
        }else{
            this.clearMessageTimer(socket);
        }
    }

    dispatchDirect(message,socket){
        this.publish(message.type,message.data,socket);
    }

    dispatchIdentified(message,socket){
        if(message.data?.id){
            socket.id=message.data.id;
        }
        this.publish(message.type,message.data,socket);
    }

    dispatchLogged(message,socket){
        this.log('received event',message.type,message.data);
        this.publish(message.type,message.data,socket);
    }

    dispatchIdentifiedLogged(message,socket){
        this.log('received event',message.type,message.data);
        this.dispatchIdentified(message,socket);
    }

    handleReadError(socket,error){
        if(error instanceof IPCProtocolError){
            this.protocolFailure(socket,error);
            return;
        }
        throw error;
    }

    startMessageTimer(socket){
        if(socket.ipcMessageTimer){
            return;
        }
        socket.ipcMessageTimer=setTimeout(() => {
            this.protocolFailure(
                socket,
                new IPCProtocolError('ERR_IPC_MESSAGE_TIMEOUT','incomplete message exceeded messageTimeout')
            );
        },this.parser.messageTimeout);
        socket.ipcMessageTimer.unref?.();
    }

    clearMessageTimer(socket){
        if(!socket?.ipcMessageTimer){
            return;
        }
        clearTimeout(socket.ipcMessageTimer);
        socket.ipcMessageTimer=undefined;
    }

    protocolFailure(socket,error){
        this.clearMessageTimer(socket);
        socket.ipcBuffer='';
        this.log('IPC protocol error',error.code || 'ERR_IPC_PROTOCOL',error.message);
        socket.destroy?.();
        this.publish('error',error);
    }

    removeSocket(socket){
        const index=this.sockets.indexOf(socket);
        if(index === -1 || socket.readable){
            return;
        }
        this.sockets.splice(index,1);
        if(this.lastPeer === socket){
            this.lastPeer=false;
        }
        const id=socket.id || false;
        if(!socket.destroyed){
            socket.destroy?.();
        }
        this.clearMessageTimer(socket);
        this.publish('socket.disconnected',socket,id);
    }

    serverError(error){
        this.log('server error',error);
        this.publish('error',error);
    }
}

function prepareSocketRoot(server){
    const root=path.resolve(server.config.socketRoot);
    const relative=path.relative(root,path.resolve(server.path));
    if(relative.startsWith('..') || path.isAbsolute(relative)){
        return;
    }

    fs.mkdirSync(root,{recursive:true,mode:0o700});
    if(!server.config.secureSocketRoot){
        return;
    }

    const stat=fs.lstatSync(root);
    if(!stat.isDirectory() || stat.isSymbolicLink()){
        throw socketRootError('socketRoot must be a real directory');
    }
    if(typeof process.getuid === 'function' && stat.uid !== process.getuid()){
        throw socketRootError('socketRoot must be owned by the current user');
    }
    if((stat.mode & 0o077) !== 0){
        fs.chmodSync(root,0o700);
    }
}

function socketPathInRoot(server){
    const root=path.resolve(server.config.socketRoot);
    const relative=path.relative(root,path.resolve(server.path));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function unlinkSocket(socketPath){
    let stat;
    try{
        stat=fs.lstatSync(socketPath);
    }catch(error){
        if(error.code === 'ENOENT'){
            return;
        }
        throw error;
    }
    if(!stat.isSocket()){
        const error=new Error('refusing to unlink a non-socket path');
        error.code='ERR_IPC_UNLINK_NOT_SOCKET';
        throw error;
    }
    fs.unlinkSync(socketPath);
}

function socketRootError(message){
    const error=new Error(message);
    error.code='ERR_IPC_SOCKET_ROOT';
    return error;
}

export {
    Server as default,
    Server
};
