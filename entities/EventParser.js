import Defaults from './Defaults.js';

const reservedEventTypes=new Set([
    'start',
    'connect',
    'disconnect',
    'destroy',
    'close',
    'socket.disconnected',
    'error',
    'data'
]);
const unsafeEventTypes=new Set(Object.getOwnPropertyNames(Object.prototype));
const emptyPayload={};

class IPCProtocolError extends Error{
    constructor(code,message){
        super(message);
        this.name='IPCProtocolError';
        this.code=code;
    }
}

class RawParser{
    constructor(config=new Defaults){
        this.encoding=config.encoding;
    }

    profile='raw';
    raw=true;

    encode(value){
        return Buffer.isBuffer(value) ? value : Buffer.from(value,this.encoding);
    }

    format(value){
        return this.encode(value);
    }

    read(buffer,data,receive){
        receive(data);
        return buffer;
    }

    parse(data){
        return [data];
    }

    decode(data){
        return data;
    }
}

class Parser{
    constructor(config=new Defaults){
        this.delimiter=config.delimiter;
        if(typeof this.delimiter !== 'string' || this.delimiter.length === 0){
            throw new TypeError('ipc.config.delimiter must be a non-empty string');
        }
    }

    profile='fast';
    raw=false;
    encoding='utf8';

    encode(type,data=emptyPayload){
        return JSON.stringify({type,data})+this.delimiter;
    }

    format(message){
        return this.encode(message.type,message.data);
    }

    read(buffer,data,receive){
        const combined=buffer ? buffer+data : data;
        const delimiter=this.delimiter;
        const length=delimiter.length;
        let start=0;
        let end=combined.indexOf(delimiter);

        while(end !== -1){
            receive(this.decode(combined.slice(start,end)));
            start=end+length;
            end=combined.indexOf(delimiter,start);
        }

        return start === 0 ? combined : combined.slice(start);
    }

    push(buffer='',data=''){
        const combined=buffer ? buffer+data : data;
        const events=[];
        const delimiter=this.delimiter;
        const length=delimiter.length;
        let start=0;
        let end=combined.indexOf(delimiter);

        while(end !== -1){
            events.push(combined.slice(start,end));
            start=end+length;
            end=combined.indexOf(delimiter,start);
        }

        return {
            events,
            remainder:start === 0 ? combined : combined.slice(start)
        };
    }

    parse(data){
        return this.push('',data).events;
    }

    decode(frame){
        try{
            return JSON.parse(frame);
        }catch{
            throw new IPCProtocolError('ERR_IPC_INVALID_JSON','received message is not valid JSON');
        }
    }
}

class GuardedParser extends Parser{
    constructor(config=new Defaults){
        super(config);
        this.maxMessageSize=config.maxMessageSize;
        this.maxPendingBytes=config.maxPendingBytes;
        this.maxEventNameLength=config.maxEventNameLength;
        this.messageTimeout=config.messageTimeout;
        this.allowReservedEvents=config.allowReservedEvents;
        this.delimiterBytes=Buffer.byteLength(this.delimiter);

        validateLimit(this.maxMessageSize,'maxMessageSize');
        validateLimit(this.maxPendingBytes,'maxPendingBytes');
        validateLimit(this.maxEventNameLength,'maxEventNameLength');
        if(this.messageTimeout !== 0){
            validateLimit(this.messageTimeout,'messageTimeout');
        }
    }

    profile='guarded';

    encode(type,data){
        this.validateType(type);
        const frame=super.encode(type,data);
        this.assertFrameSize(
            frame.length-this.delimiter.length,
            Buffer.byteLength(frame)-this.delimiterBytes
        );
        return frame;
    }

    read(buffer,data,receive){
        const combined=buffer ? buffer+data : data;
        const delimiter=this.delimiter;
        const length=delimiter.length;
        let start=0;
        let end=combined.indexOf(delimiter);

        while(end !== -1){
            const frame=combined.slice(start,end);
            this.assertFrameSize(frame.length,Buffer.byteLength(frame));
            receive(this.decodeMessage(frame));
            start=end+length;
            end=combined.indexOf(delimiter,start);
        }

        const remainder=start === 0 ? combined : combined.slice(start);
        this.assertFrameSize(remainder.length,Buffer.byteLength(remainder));
        return remainder;
    }

    push(buffer='',data=''){
        const parsed=super.push(buffer,data);
        for(const frame of parsed.events){
            this.assertFrameSize(frame.length,Buffer.byteLength(frame));
        }
        this.assertFrameSize(
            parsed.remainder.length,
            Buffer.byteLength(parsed.remainder)
        );
        return parsed;
    }

    decode(frame){
        this.assertFrameSize(frame.length,Buffer.byteLength(frame));
        return this.decodeMessage(frame);
    }

    decodeMessage(frame){
        const message=super.decode(frame);

        if(!message || typeof message !== 'object' || Array.isArray(message)){
            throw new IPCProtocolError('ERR_IPC_INVALID_MESSAGE','received message must be a JSON object');
        }
        this.validateType(message.type);
        return message;
    }

    validateType(type){
        if(typeof type !== 'string' || type.length === 0){
            throw new IPCProtocolError('ERR_IPC_INVALID_EVENT','event type must be a non-empty string');
        }
        if(type.length > this.maxEventNameLength){
            throw new IPCProtocolError('ERR_IPC_EVENT_TOO_LARGE','event type exceeds maxEventNameLength');
        }
        if(unsafeEventTypes.has(type)){
            throw new IPCProtocolError('ERR_IPC_INVALID_EVENT',`event type "${type}" is not safe for the active event dispatcher`);
        }
        if(!this.allowReservedEvents && reservedEventTypes.has(type)){
            throw new IPCProtocolError('ERR_IPC_RESERVED_EVENT',`event type "${type}" is reserved for local lifecycle events`);
        }
    }

    assertFrameSize(characters,bytes){
        if(bytes <= this.maxMessageSize){
            return;
        }
        throw new IPCProtocolError('ERR_IPC_FRAME_TOO_LARGE','message exceeds maxMessageSize');
    }
}

class AssuredParser extends GuardedParser{
    constructor(config=new Defaults){
        super(config);
        const allowed=config.allowedEvents;
        if(!(Array.isArray(allowed) || allowed instanceof Set) || allowed.size === 0 || allowed.length === 0){
            throw new TypeError('ipc.config.allowedEvents must be a non-empty Array or Set for the assured parser');
        }
        this.allowedEvents=new Set(allowed);
        this.allowReservedEvents=false;
    }

    profile='assured';

    validateType(type){
        super.validateType(type);
        if(!this.allowedEvents.has(type)){
            throw new IPCProtocolError('ERR_IPC_EVENT_NOT_ALLOWED','event type is not in allowedEvents');
        }
    }
}

function createParser(config){
    const selected=config.rawBuffer ? 'raw' : config.parser;
    let parser;

    if(selected === 'raw'){
        parser=new RawParser(config);
    }else if(!selected || selected === 'fast'){
        parser=new Parser(config);
    }else if(selected === 'guarded'){
        parser=new GuardedParser(config);
    }else if(selected === 'assured'){
        parser=new AssuredParser(config);
    }else if(typeof selected === 'function'){
        parser=new selected(config);
    }else{
        parser=selected;
    }

    if(!parser || typeof parser.encode !== 'function' || typeof parser.read !== 'function'){
        throw new TypeError('ipc.config.parser must be "raw", "fast", "guarded", "assured", or an object with encode() and read() methods');
    }
    return parser;
}

function validateLimit(value,name){
    if(value === Infinity){
        return;
    }
    if(!Number.isInteger(value) || value < 1){
        throw new TypeError(`ipc.config.${name} must be a positive integer or Infinity`);
    }
}

export {
    AssuredParser,
    Parser as FastParser,
    GuardedParser,
    IPCProtocolError,
    Parser,
    Parser as default,
    RawParser,
    createParser,
    reservedEventTypes
};
