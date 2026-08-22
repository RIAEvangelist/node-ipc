import net from 'node:net';
import tls from 'node:tls';
import Events from 'event-pubsub';
import Queue from 'js-queue';
import {createParser,IPCProtocolError} from '../entities/EventParser.js';
import {createClientTLSOptions} from '../entities/TLS.js';

class Client extends Events{
    constructor(config,log){
        super();
        this.Client=Client;
        this.config=config;
        this.log=log;
        this.publish=super.emit;
        this.retriesRemaining=config.maxRetries || 0;
        this.parser=createParser(config);
        this.raw=this.parser.raw;
        this.encoding=this.parser.encoding || 'utf8';
        this.encode=this.parser.encode.bind(this.parser);
        this.writeSocket=Number.isFinite(this.parser.maxPendingBytes)
            ? this.writeGuarded
            : this.writeDirect;
        this.send=config.sync ? this.sendQueued : this.writeSocket;
        this.queue=config.sync ? new Queue : null;
        this.receive=this.raw
            ? (config.sync ? this.receiveRawSync : this.receiveRaw)
            : (this.parser.messageTimeout ? this.receiveGuarded : this.receiveFramed);
        this.dispatch=config.sync ? this.dispatchSync : this.dispatchDirect;
        this.emit=config.logPayloads ? this.emitLogged : this.emitDirect;
        if(config.logPayloads){
            this.dispatch=config.sync ? this.dispatchLoggedSync : this.dispatchLogged;
        }
        this.receiveMessage=this.dispatch.bind(this);
    }

    socket=false;
    retriesRemaining=0;
    retryTimer=false;
    explicitlyDisconnected=false;
    protocolViolation=false;

    emitDirect(type,data){
        return this.send(this.encode(type,data));
    }

    emitLogged(type,data){
        this.log('dispatching event to',this.id,this.path,':',this.raw ? '<raw-buffer>' : type,data);
        return this.send(this.encode(type,data));
    }

    sendQueued(message){
        this.queue.add(() => this.writeSocket(message));
        return true;
    }

    writeDirect(message){
        return this.socket.write(message);
    }

    writeGuarded(message){
        const bytes=Buffer.isBuffer(message)
            ? message.length
            : Buffer.byteLength(message,this.encoding);
        if(this.socket.writableLength+bytes > this.parser.maxPendingBytes){
            const error=new IPCProtocolError(
                'ERR_IPC_BACKPRESSURE',
                'pending socket writes exceed maxPendingBytes'
            );
            this.protocolFailure(this.socket,error);
            return false;
        }
        return this.socket.write(message);
    }

    dispatchDirect(message){
        this.publish(message.type,message.data);
    }

    dispatchSync(message){
        this.publish(message.type,message.data);
        this.queue.next();
    }

    dispatchLogged(message){
        this.log('received event',message.type,message.data);
        this.publish(message.type,message.data);
    }

    dispatchLoggedSync(message){
        this.log('received event',message.type,message.data);
        this.publish(message.type,message.data);
        this.queue.next();
    }

    connect(){
        if(!this.path){
            this.log('client has no socket path');
            return;
        }
        if(this.socket && !this.socket.destroyed){
            return this.socket;
        }

        if(this.retryTimer){
            clearTimeout(this.retryTimer);
            this.retryTimer=false;
        }

        const options=this.connectionOptions();
        const secure=Boolean(this.port && this.config.tls);
        if(this.port && this.parser.profile === 'assured' && !secure){
            throw new IPCProtocolError(
                'ERR_IPC_ASSURED_TRANSPORT',
                'The assured parser requires TLS for network connections.'
            );
        }

        let socket;
        if(!this.port){
            this.log('connecting client on local socket',options.path);
            socket=net.connect(options);
        }else if(secure){
            this.log('connecting client via TLS',this.path,this.port);
            socket=tls.connect(createClientTLSOptions(
                this.config.tls,
                options,
                this.parser.profile === 'assured'
            ));
        }else{
            this.log('connecting client via TCP',options);
            socket=net.connect(options);
        }
        this.socket=socket;

        socket.setNoDelay?.(true);
        if(!this.raw){
            socket.setEncoding(this.encoding);
        }

        socket.on('error',(error) => {
            if(socket !== this.socket){
                return;
            }
            this.log('client socket error',error);
            this.publish('error',error);
        });
        socket.on(secure ? 'secureConnect' : 'connect',() => this.connected(socket));
        socket.on('close',() => this.closed(socket));
        socket.on('data',(data) => {
            if(socket === this.socket){
                this.receive(socket,data);
            }
        });
        return socket;
    }

    connectionOptions(){
        if(!this.port){
            let socketPath=this.path;
            if(process.platform === 'win32' && !socketPath.startsWith('\\\\.\\pipe\\')){
                socketPath=`\\\\.\\pipe\\${socketPath.replace(/^\//,'').replace(/\//g,'-')}`;
            }
            return {path:socketPath};
        }

        const options={host:this.path,port:this.port};
        const source=this.config.interface;
        for(const name of ['localAddress','localPort','family','hints','lookup']){
            if(source[name]){
                options[name]=source[name];
            }
        }
        return options;
    }

    connected(socket=this.socket){
        if(socket !== this.socket){
            return;
        }
        this.retriesRemaining=this.config.maxRetries;
        this.publish('connect');
    }

    closed(socket=this.socket){
        this.clearMessageTimer(socket);
        if(socket !== this.socket){
            return;
        }
        this.log('connection closed',this.id,this.path);

        if(
            this.config.stopRetrying ||
            this.retriesRemaining < 1 ||
            this.explicitlyDisconnected ||
            this.protocolViolation
        ){
            this.publish('disconnect');
            socket.destroy();
            this.publish('destroy');
            return;
        }

        this.retryTimer=setTimeout(() => {
            this.retryTimer=false;
            if(this.explicitlyDisconnected){
                return;
            }
            this.retriesRemaining--;
            this.connect();
        },this.config.retry);
        this.publish('disconnect');
    }

    receiveRaw(socket,data){
        this.publish('data',data);
    }

    receiveRawSync(socket,data){
        this.publish('data',data);
        this.queue.next();
    }

    receiveFramed(socket,data){
        try{
            socket.ipcBuffer=this.parser.read(socket.ipcBuffer || '',data,this.receiveMessage);
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
        this.protocolViolation=true;
        this.log('IPC protocol error',error.code || 'ERR_IPC_PROTOCOL',error.message);
        socket.destroy();
        this.publish('error',error);
    }
}

export {
    Client as default,
    Client
};
