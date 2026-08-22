import assert from 'node:assert/strict';
import {chmod,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Message from 'js-message';

import {Client} from '../../dao/client.js';
import {Server} from '../../dao/socketServer.js';
import {Defaults} from '../../entities/Defaults.js';
import {
    AssuredParser,
    FastParser,
    GuardedParser,
    IPCProtocolError,
    RawParser,
    createParser
} from '../../entities/EventParser.js';
import {MessageParser} from '../../entities/MessageParser.js';
import {createClientTLSOptions,createServerTLSOptions} from '../../entities/TLS.js';
import {IPC} from '../../services/IPC.js';
import {reservePort,waitForEvent,withTimeout} from '../support.js';

const host='127.0.0.1';
const certificate=fileURLToPath(new URL('../../local-node-ipc-certs/server.pub',import.meta.url));
const dhparam=fileURLToPath(new URL('../../local-node-ipc-certs/private/dhparam.pem',import.meta.url));
const privateKey=fileURLToPath(new URL('../../local-node-ipc-certs/private/server.key',import.meta.url));

function config(values={}){
    return Object.assign(new Defaults,{stopRetrying:true,maxRetries:0,...values});
}

function fakeSocket(values={}){
    return Object.assign({
        destroyed:false,
        ipcBuffer:'',
        writableLength:0,
        destroy(){
            this.destroyed=true;
        },
        write(){
            return true;
        }
    },values);
}

function assertProtocolError(action,code){
    assert.throws(action,(error) => {
        assert.ok(error instanceof IPCProtocolError);
        assert.equal(error.code,code);
        return true;
    });
}

function roundTrip(parser,type,data){
    const frame=parser.encode(type,data);
    return parser.decode(frame.slice(0,-parser.delimiter.length));
}

async function startPair({raw=false,tls=false}={}){
    const port=await reservePort(host);
    const serverConfig=config({rawBuffer:raw});
    const clientConfig=config({rawBuffer:raw});
    if(tls){
        serverConfig.tls={private:privateKey,public:certificate};
        clientConfig.tls={rejectUnauthorized:false};
    }

    const server=new Server(host,serverConfig,() => {},port);
    let client;
    try{
        const started=waitForEvent(server,'start');
        const accepted=waitForEvent(server,'connect');
        server.start();
        await withTimeout(started,`${tls ? 'TLS' : 'raw'} server start`);

        client=new Client(clientConfig,() => {});
        client.id=tls ? 'tls-modernization' : 'raw-modernization';
        client.path=host;
        client.port=port;
        const order=[];
        const connected=waitForEvent(client,'connect').then((value) => {
            if(tls){
                order.push('secure');
            }
            return value;
        });
        client.connect();
        if(tls){
            client.socket.once('connect',() => order.push('tcp'));
        }

        const [[serverSocket]]=await Promise.all([
            withTimeout(accepted,`${tls ? 'TLS' : 'raw'} server accept`),
            withTimeout(connected,`${tls ? 'TLS' : 'raw'} client connect`)
        ]);
        return {client,order,server,serverSocket};
    }catch(error){
        await stopPair({client,server});
        throw error;
    }
}

async function stopPair(context){
    if(!context){
        return;
    }

    const clientSocket=context.client?.socket;
    if(clientSocket && !clientSocket.destroyed){
        const closed=new Promise((resolve) => clientSocket.once('close',resolve));
        context.client.explicitlyDisconnected=true;
        clientSocket.destroy();
        await withTimeout(closed,'modernization client close');
    }

    const nativeServer=context.server?.server;
    if(!nativeServer){
        return;
    }
    const closed=nativeServer.listening
        ? new Promise((resolve) => nativeServer.once('close',resolve))
        : Promise.resolve();
    context.server.stop();
    await withTimeout(closed,'modernization server close');
}

async function inTemporaryDirectory(action){
    const directory=await mkdtemp(path.join(os.tmpdir(),'node-ipc-modernization-'));
    try{
        return await action(directory);
    }finally{
        await rm(directory,{recursive:true,force:true});
    }
}

async function startLocalServer(socketRoot){
    const endpoint=path.join(socketRoot,'service.sock');
    const server=new Server(endpoint,config({socketRoot}),() => {});
    const started=waitForEvent(server,'start');
    server.start();
    await withTimeout(started,'modernization local server start');
    return {endpoint,server};
}

const groups=[
    {
        category:'Unit',
        name:'Runtime parser selection',
        cases:[
            {
                name:'selects the direct Fast parser by default',
                run(){
                    const parser=createParser(config({encoding:'utf16le'}));
                    assert.ok(parser instanceof FastParser);
                    assert.equal(parser.constructor,FastParser);
                    assert.equal(parser.encoding,'utf8');
                }
            },
            {
                name:'selects the Guarded parser explicitly',
                run(){
                    const parser=createParser(config({parser:'guarded'}));
                    assert.ok(parser instanceof GuardedParser);
                    assert.equal(parser.constructor,GuardedParser);
                }
            },
            {
                name:'maps the Assured profile to its guarded implementation',
                run(){
                    const parser=createParser(config({
                        parser:'assured',
                        allowedEvents:['unit.allowed']
                    }));
                    assert.ok(parser instanceof AssuredParser);
                    assert.equal(parser.constructor,AssuredParser);
                }
            },
            {
                name:'uses a supplied parser object without false write limits',
                run(){
                    let limitReads=0;
                    const custom={
                        encode:() => 'custom',
                        get maxPendingBytes(){
                            limitReads++;
                            return Symbol('unbounded');
                        },
                        read:() => ''
                    };
                    assert.strictEqual(createParser(config({parser:custom})),custom);
                    const client=new Client(config({parser:custom}),() => {});
                    const server=new Server('custom',config({parser:custom}),() => {});
                    assert.strictEqual(client.writeSocket,client.writeDirect);
                    assert.strictEqual(server.writeStream,server.writeStreamDirect);
                    assert.equal(limitReads,2);

                    const zero={
                        encode:() => 'zero',
                        maxPendingBytes:0,
                        read:() => ''
                    };
                    const zeroClient=new Client(config({parser:zero}),() => {});
                    const zeroServer=new Server('zero',config({parser:zero}),() => {});
                    assert.strictEqual(zeroClient.writeSocket,zeroClient.writeDirect);
                    assert.strictEqual(zeroServer.writeStream,zeroServer.writeStreamDirect);
                    assert.strictEqual(zeroServer.sendDatagram,zeroServer.sendDatagramDirect);
                    assert.equal(zeroServer.datagramCallback,null);
                }
            },
            {
                name:'constructs a supplied parser class with the live config',
                run(){
                    class CustomParser{
                        constructor(received){
                            this.config=received;
                        }
                        encode(){
                            return 'custom';
                        }
                        read(){
                            return '';
                        }
                    }
                    const selected=config({parser:CustomParser});
                    const parser=createParser(selected);
                    assert.ok(parser instanceof CustomParser);
                    assert.strictEqual(parser.config,selected);
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'MessageParser compatibility and Fast payloads',
        cases:[
            {
                name:'decodes official js-message envelopes',
                run(){
                    const message=new MessageParser().decode('{"type":"official","data":{"value":1}}');
                    assert.ok(message instanceof Message);
                    assert.deepEqual(message.toJSON(),{
                        type:'official',
                        data:{value:1}
                    });
                }
            },
            {
                name:'returns the official js-message error envelope for invalid input',
                run(){
                    const message=new MessageParser().decode('not-json');
                    assert.ok(message instanceof Message);
                    assert.equal(message.type,'error');
                    assert.equal(message.data.message,'Invalid JSON response format');
                    assert.equal(message.data.response,'not-json');
                }
            },
            {
                name:'preserves null payloads on the direct Fast path',
                run(){
                    assert.equal(roundTrip(new FastParser(),'fast.null',null).data,null);
                }
            },
            {
                name:'preserves empty-string payloads on the direct Fast path',
                run(){
                    assert.equal(roundTrip(new FastParser(),'fast.empty','').data,'');
                }
            },
            {
                name:'preserves emitter-shaped objects on the direct Fast path',
                run(){
                    const data={_maxListeners:10,private:'wire-data'};
                    assert.deepEqual(roundTrip(new FastParser(),'fast.object',data).data,data);
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Guarded protocol boundaries',
        cases:[
            {
                name:'rejects malformed JSON with a stable protocol code',
                run(){
                    const parser=createParser(config({parser:'guarded'}));
                    assertProtocolError(
                        () => parser.read('','{"type":\f',() => {}),
                        'ERR_IPC_INVALID_JSON'
                    );
                }
            },
            {
                name:'rejects messages without an event type',
                run(){
                    const parser=createParser(config({parser:'guarded'}));
                    assertProtocolError(
                        () => parser.decode('{"data":true}'),
                        'ERR_IPC_INVALID_EVENT'
                    );
                }
            },
            {
                name:'rejects complete frames over the byte limit',
                run(){
                    const frame=JSON.stringify({type:'large',data:'é'});
                    const bytes=Buffer.byteLength(frame);
                    const exact=createParser(config({parser:'guarded',maxMessageSize:bytes}));
                    assert.equal(exact.decode(frame).data,'é');

                    const parser=createParser(config({
                        parser:'guarded',
                        maxMessageSize:bytes-1
                    }));
                    assertProtocolError(
                        () => parser.decode(frame),
                        'ERR_IPC_FRAME_TOO_LARGE'
                    );
                }
            },
            {
                name:'rejects an oversized incomplete frame',
                run(){
                    const parser=createParser(config({parser:'guarded',maxMessageSize:8}));
                    assertProtocolError(
                        () => parser.read('','123456789',() => {}),
                        'ERR_IPC_FRAME_TOO_LARGE'
                    );
                }
            },
            {
                name:'contains dispatcher-prototype names and reserved wire events',
                run(){
                    const blocked=createParser(config({parser:'guarded'}));
                    for(const type of ['__proto__','constructor']){
                        assertProtocolError(
                            () => blocked.decode(JSON.stringify({type,data:{}})),
                            'ERR_IPC_INVALID_EVENT'
                        );
                    }
                    assertProtocolError(
                        () => blocked.decode('{"type":"connect","data":{}}'),
                        'ERR_IPC_RESERVED_EVENT'
                    );

                    const allowed=createParser(config({parser:'guarded',allowReservedEvents:true}));
                    assert.equal(allowed.decode('{"type":"connect","data":{}}').type,'connect');
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Assured allowlist and network TLS gate',
        cases:[
            {
                name:'requires a non-empty event allowlist',
                run(){
                    assert.throws(
                        () => createParser(config({parser:'assured',allowedEvents:[]})),
                        /allowedEvents must be a non-empty Array or Set/
                    );
                }
            },
            {
                name:'accepts allowlisted messages in both directions',
                run(){
                    const parser=createParser(config({
                        parser:'assured',
                        allowedEvents:new Set(['assured.allowed'])
                    }));
                    assert.deepEqual(roundTrip(parser,'assured.allowed',{value:1}),{
                        type:'assured.allowed',
                        data:{value:1}
                    });
                }
            },
            {
                name:'rejects unlisted messages without reflecting their names',
                run(){
                    const allowedEvents=new Set(['assured.allowed']);
                    const parser=createParser(config({
                        parser:'assured',
                        allowedEvents
                    }));
                    allowedEvents.add('assured.blocked');
                    assertProtocolError(
                        () => parser.encode('assured.blocked',{}),
                        'ERR_IPC_EVENT_NOT_ALLOWED'
                    );
                    assert.throws(
                        () => parser.decode(JSON.stringify({
                            type:'\u001b[31mFORGED\nLINE',
                            data:{}
                        })),
                        (error) => error.code === 'ERR_IPC_EVENT_NOT_ALLOWED' &&
                            !error.message.includes('FORGED')
                    );
                }
            },
            {
                name:'requires verified mutual TLS before an Assured client opens a socket',
                run(){
                    const client=new Client(config({
                        parser:'assured',
                        allowedEvents:['assured.allowed'],
                        tls:{
                            private:privateKey,
                            public:certificate,
                            trustedConnections:certificate,
                            rejectUnauthorized:false
                        }
                    }),() => {});
                    client.path=host;
                    client.port=65535;
                    try{
                        assert.throws(
                            () => client.connect(),
                            {code:'ERR_IPC_ASSURED_TLS'}
                        );
                        assert.equal(client.socket,false);
                    }finally{
                        client.socket?.destroy?.();
                    }
                }
            },
            {
                name:'requires a trusted client CA before an Assured server starts',
                run(){
                    const server=new Server(host,config({
                        parser:'assured',
                        allowedEvents:['assured.allowed'],
                        tls:{private:privateKey,public:certificate}
                    }),() => {},65535);
                    try{
                        assert.throws(
                            () => server.start(),
                            {code:'ERR_IPC_ASSURED_TLS'}
                        );
                        assert.equal(server.server,false);
                    }finally{
                        server.server?.close?.();
                    }
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Direct transport hot path',
        cases:[
            {
                name:'keeps delimiters isolated per client instance',
                run(){
                    const first=new Client(config({delimiter:'<A>'}),() => {});
                    const second=new Client(config({delimiter:'<B>'}),() => {});
                    const firstMessages=[];
                    const secondMessages=[];

                    first.parser.read('','{"type":"first","data":1}<A>',(message) => firstMessages.push(message));
                    second.parser.read('','{"type":"second","data":2}<B>',(message) => secondMessages.push(message));

                    assert.deepEqual(firstMessages,[{type:'first',data:1}]);
                    assert.deepEqual(secondMessages,[{type:'second',data:2}]);
                }
            },
            {
                name:'bypasses parser construction in raw mode',
                run(){
                    const raw=config({rawBuffer:true,parser:null,encoding:'hex'});
                    const value=Buffer.from([0xff,0x00]);
                    const client=new Client(raw,() => {});
                    const server=new Server('raw',raw,() => {});
                    assert.ok(client.parser instanceof RawParser);
                    assert.ok(server.parser instanceof RawParser);
                    assert.equal(client.encoding,'hex');
                    assert.equal(server.encoding,'hex');
                    assert.strictEqual(client.encode(value),value);
                    assert.strictEqual(server.encode(value),value);
                }
            },
            {
                name:'returns client socket backpressure directly',
                run(){
                    const client=new Client(config(),() => {});
                    client.socket={write:() => false};
                    assert.equal(client.emit('hot.client',{value:1}),false);
                }
            },
            {
                name:'returns server socket backpressure directly',
                run(){
                    const server=new Server('hot',config(),() => {});
                    assert.equal(server.emit({write:() => false},'hot.server',{value:1}),false);
                }
            },
            {
                name:'reports broadcast backpressure when any peer is full',
                run(){
                    const writes=[];
                    const server=new Server('hot',config(),() => {});
                    server.sockets=[
                        {write(value){writes.push(value); return true;}},
                        {write(value){writes.push(value); return false;}}
                    ];
                    assert.equal(server.broadcast('hot.broadcast',{value:1}),false);
                    assert.equal(writes.length,2);
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Guarded client failure and logging paths',
        cases:[
            {
                name:'rejects writes beyond the pending-byte limit',
                run(){
                    const errors=[];
                    let writes=0;
                    const client=new Client(config({
                        parser:'guarded',
                        maxPendingBytes:8
                    }),() => {});
                    client.socket=fakeSocket({write(){writes++; return true;}});
                    client.on('error',(error) => errors.push(error));

                    assert.equal(client.emit('client.backpressure',{value:1}),false);
                    assert.equal(writes,0);
                    assert.equal(errors[0].code,'ERR_IPC_BACKPRESSURE');
                    assert.equal(client.protocolViolation,true);
                    assert.equal(client.socket.destroyed,true);
                }
            },
            {
                name:'times out and clears an incomplete guarded frame',
                async run(){
                    const client=new Client(config({
                        parser:'guarded',
                        messageTimeout:10
                    }),() => {});
                    const socket=fakeSocket();
                    const failed=waitForEvent(client,'error');
                    client.receive(socket,'{"type":"client.partial"');

                    assert.equal((await failed)[0].code,'ERR_IPC_MESSAGE_TIMEOUT');
                    assert.equal(socket.ipcBuffer,'');
                    assert.equal(socket.ipcMessageTimer,undefined);
                    assert.equal(socket.destroyed,true);
                }
            },
            {
                name:'turns malformed input into a guarded protocol failure',
                async run(){
                    const client=new Client(config({parser:'guarded'}),() => {});
                    const socket=fakeSocket({ipcMessageTimer:setTimeout(() => {},1000)});
                    socket.ipcMessageTimer.unref?.();
                    const failed=waitForEvent(client,'error');
                    client.receive(socket,'not-json\f');

                    assert.equal((await failed)[0].code,'ERR_IPC_INVALID_JSON');
                    assert.equal(socket.ipcBuffer,'');
                    assert.equal(socket.ipcMessageTimer,undefined);
                    assert.equal(client.protocolViolation,true);
                }
            },
            {
                name:'logs outbound and inbound payload handlers when enabled',
                run(){
                    const logs=[];
                    const writes=[];
                    const received=[];
                    const client=new Client(
                        config({logPayloads:true}),
                        (...entry) => logs.push(entry)
                    );
                    client.id='logged-client';
                    client.path=host;
                    client.socket=fakeSocket({write(value){writes.push(value); return true;}});
                    client.on('client.logged.in',(data) => received.push(data));

                    assert.equal(client.emit('client.logged.out',{outbound:true}),true);
                    client.dispatch({type:'client.logged.in',data:{inbound:true}});
                    assert.equal(writes.length,1);
                    assert.deepEqual(received,[{inbound:true}]);
                    assert.equal(logs.length,2);
                }
            },
            {
                name:'advances the synchronous queue after raw input',
                run(){
                    let advances=0;
                    const received=[];
                    const client=new Client(config({rawBuffer:true,sync:true}),() => {});
                    client.queue.stop=true;
                    client.queue.add(() => advances++);
                    client.queue.stop=false;
                    client.on('data',(data) => received.push(data));
                    const payload=Buffer.from([0xff,0x00]);

                    client.receive(fakeSocket(),payload);
                    assert.deepEqual(received,[payload]);
                    assert.equal(advances,1);
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Guarded server, logging, and datagram paths',
        cases:[
            {
                name:'rejects stream writes beyond the pending-byte limit',
                run(){
                    const errors=[];
                    let writes=0;
                    const server=new Server('guarded',config({
                        parser:'guarded',
                        maxPendingBytes:8
                    }),() => {});
                    const socket=fakeSocket({write(){writes++; return true;}});
                    server.on('error',(error) => errors.push(error));

                    assert.equal(server.emit(socket,'server.backpressure',{value:1}),false);
                    assert.equal(writes,0);
                    assert.equal(errors[0].code,'ERR_IPC_BACKPRESSURE');
                    assert.equal(socket.destroyed,true);
                }
            },
            {
                name:'times out and clears an incomplete guarded frame',
                async run(){
                    const server=new Server('guarded',config({
                        parser:'guarded',
                        messageTimeout:10
                    }),() => {});
                    const socket=fakeSocket();
                    const failed=waitForEvent(server,'error');
                    server.receive(socket,'{"type":"server.partial"');

                    assert.equal((await failed)[0].code,'ERR_IPC_MESSAGE_TIMEOUT');
                    assert.equal(socket.ipcBuffer,'');
                    assert.equal(socket.ipcMessageTimer,undefined);
                    assert.equal(socket.destroyed,true);
                }
            },
            {
                name:'turns malformed input into a guarded protocol failure',
                async run(){
                    const server=new Server('guarded',config({parser:'guarded'}),() => {});
                    const socket=fakeSocket({ipcMessageTimer:setTimeout(() => {},1000)});
                    socket.ipcMessageTimer.unref?.();
                    const failed=waitForEvent(server,'error');
                    server.receive(socket,'not-json\f');

                    assert.equal((await failed)[0].code,'ERR_IPC_INVALID_JSON');
                    assert.equal(socket.ipcBuffer,'');
                    assert.equal(socket.ipcMessageTimer,undefined);
                    assert.equal(socket.destroyed,true);
                }
            },
            {
                name:'logs unicast, broadcast, and inbound payload handlers',
                run(){
                    const logs=[];
                    const writes=[];
                    const received=[];
                    const server=new Server(
                        'logged',
                        config({logPayloads:true}),
                        (...entry) => logs.push(entry)
                    );
                    const socket=fakeSocket({write(value){writes.push(value); return true;}});
                    server.sockets=[socket];
                    server.on('server.logged.in',(data) => received.push(data));

                    assert.equal(server.emit(socket,'server.logged.out',{unicast:true}),true);
                    assert.equal(server.broadcast('server.logged.broadcast',{broadcast:true}),true);
                    server.dispatch({type:'server.logged.in',data:{inbound:true}},socket);
                    assert.equal(writes.length,2);
                    assert.deepEqual(received,[{inbound:true}]);
                    assert.equal(logs.length,3);
                }
            },
            {
                name:'broadcasts datagrams and publishes transport errors',
                run(){
                    const errors=[];
                    const logs=[];
                    const sends=[];
                    const server=new Server(
                        host,
                        config({parser:'guarded'}),
                        (...entry) => logs.push(entry),
                        9999
                    );
                    server.udp4=true;
                    server.sockets=[
                        {address:host,port:9001},
                        {address:host,port:9002}
                    ];
                    server.server={send(data,port,address,callback){
                        sends.push({address,data,port});
                        callback(new Error('datagram write failed'));
                    }};
                    server.on('error',(error) => errors.push(error));

                    assert.equal(server.broadcast('server.udp.broadcast',{value:1}),true);
                    assert.equal(server.emit({},'server.udp.fallback',{value:2}),true);
                    const nativeError=new Error('native datagram failure');
                    server.serverError(nativeError);
                    assert.equal(sends.length,4);
                    assert.equal(errors.length,5);
                    assert.strictEqual(errors.at(-1),nativeError);
                    assert.equal(logs.length,5);
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'TLS option loading and verification defaults',
        cases:[
            {
                name:'loads client key and certificate paths with verification enabled',
                run(){
                    const options=createClientTLSOptions({
                        private:privateKey,
                        public:certificate,
                        trustedConnections:certificate
                    },{host,port:443},true);
                    assert.ok(Buffer.isBuffer(options.key));
                    assert.ok(Buffer.isBuffer(options.cert));
                    assert.equal(options.rejectUnauthorized,true);
                    assert.equal(options.host,host);
                    assert.equal(options.port,443);
                    assert.equal(Object.hasOwn(options,'private'),false);
                    assert.equal(Object.hasOwn(options,'public'),false);
                }
            },
            {
                name:'lets connection options override client TLS values',
                run(){
                    const options=createClientTLSOptions({
                        host:'stale.example',
                        rejectUnauthorized:true
                    },{
                        host,
                        port:8443,
                        rejectUnauthorized:false
                    });
                    assert.equal(options.host,host);
                    assert.equal(options.port,8443);
                    assert.equal(options.rejectUnauthorized,false);
                    assert.throws(
                        () => createClientTLSOptions({
                            private:privateKey,
                            public:certificate,
                            trustedConnections:certificate
                        },{
                            host,
                            port:8443,
                            rejectUnauthorized:false
                        },true),
                        {code:'ERR_IPC_ASSURED_TLS'}
                    );
                }
            },
            {
                name:'merges one trusted connection with an existing CA',
                async run(){
                    const existing=Buffer.from('existing-ca');
                    const options=createClientTLSOptions({
                        ca:existing,
                        trustedConnections:certificate
                    },{});
                    assert.strictEqual(options.ca[0],existing);
                    assert.deepEqual(options.ca[1],await readFile(certificate));
                    assert.equal(Object.hasOwn(options,'trustedConnections'),false);
                }
            },
            {
                name:'enables mutual TLS defaults for trusted server connections',
                async run(){
                    const [key,cert]=await Promise.all([
                        readFile(privateKey),
                        readFile(certificate)
                    ]);
                    const options=createServerTLSOptions({
                        key,
                        cert,
                        trustedConnections:[certificate]
                    },true);
                    assert.equal(options.requestCert,true);
                    assert.equal(options.rejectUnauthorized,true);
                    assert.deepEqual(options.ca,[cert]);
                }
            },
            {
                name:'loads DH parameters by path and preserves inline values',
                async run(){
                    const loaded=createClientTLSOptions({dhparam},{});
                    assert.deepEqual(loaded.dhparam,await readFile(dhparam));

                    const inline='-----BEGIN DH PARAMETERS-----\ninline';
                    const preserved=createClientTLSOptions({dhparam:inline},{});
                    assert.equal(preserved.dhparam,inline);
                }
            }
        ]
    },
    {
        category:'Integration',
        name:'Raw bytes and TLS connection timing',
        setup:() => startPair({raw:true}),
        teardown:stopPair,
        cases:[
            {
                name:'preserves invalid UTF-8 from client to server',
                async run(context){
                    const payload=Buffer.from([0xff,0xfe,0x00,0x80]);
                    const received=waitForEvent(context.server,'data',() => context.client.emit(payload));
                    const [data,socket]=await received;
                    assert.ok(Buffer.isBuffer(data));
                    assert.deepEqual(data,payload);
                    assert.strictEqual(socket,context.serverSocket);
                }
            },
            {
                name:'preserves invalid UTF-8 from server to client',
                async run(context){
                    const payload=Buffer.from([0x80,0x00,0xfe,0xff]);
                    const received=waitForEvent(
                        context.client,
                        'data',
                        () => context.server.emit(context.serverSocket,payload)
                    );
                    const [data]=await received;
                    assert.ok(Buffer.isBuffer(data));
                    assert.deepEqual(data,payload);
                }
            },
            {
                name:'treats delimiter and NUL bytes as raw payload data',
                async run(context){
                    const payload=Buffer.from([0x0c,0x00,0x0c]);
                    const received=waitForEvent(context.server,'data',() => context.client.emit(payload));
                    assert.deepEqual((await received)[0],payload);
                }
            },
            {
                name:'requires explicit TLS server credentials',
                run(){
                    assert.throws(
                        () => createServerTLSOptions({}),
                        {code:'ERR_IPC_TLS_CONFIGURATION'}
                    );
                }
            },
            {
                name:'publishes connect only after the TLS handshake',
                async run(){
                    const context=await startPair({tls:true});
                    try{
                        assert.deepEqual(context.order,['tcp','secure']);
                        assert.equal(context.client.socket.encrypted,true);
                    }finally{
                        await stopPair(context);
                    }
                }
            }
        ]
    },
    {
        category:'Regression',
        name:'Local socket root and cleanup safety',
        cases:[
            {
                name:'creates a private Unix root and rejects Windows Assured local service',
                async run(){
                    if(process.platform === 'win32'){
                        const socketRoot='/node-ipc-assured-test/';
                        const server=new Server(
                            `${socketRoot}service`,
                            config({
                                allowedEvents:['local.allowed'],
                                parser:'assured',
                                socketRoot
                            }),
                            () => {}
                        );
                        assert.throws(() => server.start(),{code:'ERR_IPC_ASSURED_TRANSPORT'});
                        return;
                    }
                    await inTemporaryDirectory(async (directory) => {
                        const socketRoot=path.join(directory,'socket-root');
                        const context=await startLocalServer(socketRoot);
                        try{
                            const stat=await lstat(socketRoot);
                            assert.equal(stat.isDirectory(),true);
                            assert.equal(stat.mode & 0o777,0o700);
                        }finally{
                            await stopPair(context);
                        }
                    });
                }
            },
            {
                name:'tightens an existing socket root on Unix',
                async run(){
                    if(process.platform === 'win32'){
                        return;
                    }
                    await inTemporaryDirectory(async (directory) => {
                        const socketRoot=path.join(directory,'socket-root');
                        await mkdir(socketRoot);
                        await chmod(socketRoot,0o777);
                        const context=await startLocalServer(socketRoot);
                        try{
                            assert.equal((await lstat(socketRoot)).mode & 0o777,0o700);
                        }finally{
                            await stopPair(context);
                        }
                    });
                }
            },
            {
                name:'rejects symlinked roots and nested Assured endpoints on Unix',
                async run(){
                    if(process.platform === 'win32'){
                        return;
                    }
                    await inTemporaryDirectory(async (directory) => {
                        const target=path.join(directory,'target');
                        const socketRoot=path.join(directory,'socket-root');
                        await mkdir(target);
                        await symlink(target,socketRoot,'dir');
                        const server=new Server(
                            path.join(socketRoot,'..service'),
                            config({socketRoot}),
                            () => {}
                        );
                        assert.throws(() => server.start(),{code:'ERR_IPC_SOCKET_ROOT'});

                        const secureRoot=path.join(directory,'secure-root');
                        const attackerRoot=path.join(directory,'attacker-root');
                        await mkdir(secureRoot);
                        await mkdir(attackerRoot);
                        await symlink(attackerRoot,path.join(secureRoot,'nested'),'dir');
                        const assured=new Server(
                            path.join(secureRoot,'nested','service.sock'),
                            config({
                                allowedEvents:['local.allowed'],
                                parser:'assured',
                                socketRoot:secureRoot
                            }),
                            () => {}
                        );
                        assert.throws(() => assured.start(),{code:'ERR_IPC_ASSURED_TRANSPORT'});
                    });
                }
            },
            {
                name:'refuses to unlink a regular file on Unix',
                async run(){
                    if(process.platform === 'win32'){
                        return;
                    }
                    await inTemporaryDirectory(async (directory) => {
                        const socketRoot=path.join(directory,'socket-root');
                        const endpoint=path.join(socketRoot,'service.sock');
                        await mkdir(socketRoot);
                        await writeFile(endpoint,'preserve-me');
                        const server=new Server(endpoint,config({socketRoot}),() => {});
                        assert.throws(() => server.start(),{code:'ERR_IPC_UNLINK_NOT_SOCKET'});
                        assert.equal(await readFile(endpoint,'utf8'),'preserve-me');
                    });
                }
            },
            {
                name:'destroys tracked peers and closes the native server',
                run(){
                    let closes=0;
                    let destroys=0;
                    const server=new Server('cleanup',config(),() => {});
                    server.sockets=[
                        {destroy:() => destroys++},
                        {destroy:() => destroys++}
                    ];
                    server.server={close:() => closes++};
                    server.stop();
                    assert.equal(destroys,2);
                    assert.equal(closes,1);
                    assert.deepEqual(server.sockets,[]);
                }
            }
        ]
    },
    {
        category:'Regression',
        name:'Client reconnect and stale socket lifecycle',
        cases:[
            {
                name:'ignores connect from a replaced socket',
                run(){
                    const client=new Client(config({maxRetries:4}),() => {});
                    const current=fakeSocket();
                    let connects=0;
                    client.socket=current;
                    client.retriesRemaining=1;
                    client.on('connect',() => connects++);

                    client.connected(fakeSocket());

                    assert.equal(connects,0);
                    assert.equal(client.retriesRemaining,1);
                    assert.strictEqual(client.socket,current);
                }
            },
            {
                name:'ignores data and errors from a replaced socket',
                async run(){
                    const server=net.createServer();
                    const accepted=new Promise((resolve,reject) => {
                        server.once('connection',resolve);
                        server.once('error',reject);
                    });
                    await new Promise((resolve,reject) => {
                        server.listen(0,host,resolve);
                        server.once('error',reject);
                    });

                    const client=new Client(config({rawBuffer:true}),() => {});
                    client.path=host;
                    client.port=server.address().port;
                    const connected=waitForEvent(client,'connect',() => client.connect());
                    const stale=client.socket;
                    const peer=await accepted;
                    await connected;

                    let dataEvents=0;
                    let errorEvents=0;
                    client.on('data',() => dataEvents++);
                    client.on('error',() => errorEvents++);
                    client.socket=fakeSocket();

                    try{
                        stale.emit('data',Buffer.from('stale'));
                        stale.emit('error',new Error('stale'));
                        assert.equal(dataEvents,0);
                        assert.equal(errorEvents,0);
                    }finally{
                        client.explicitlyDisconnected=true;
                        stale.destroy();
                        peer.destroy();
                        await new Promise((resolve) => server.close(resolve));
                    }
                }
            },
            {
                name:'clears a stale socket timer without lifecycle events or retry',
                run(){
                    const client=new Client(config({
                        maxRetries:2,
                        messageTimeout:1000,
                        parser:'guarded',
                        stopRetrying:false
                    }),() => {});
                    const stale=fakeSocket({ipcMessageTimer:setTimeout(() => {},1000)});
                    const events=[];
                    client.socket=fakeSocket();
                    client.retriesRemaining=2;
                    client.on('disconnect',() => events.push('disconnect'));
                    client.on('destroy',() => events.push('destroy'));

                    client.closed(stale);

                    assert.equal(stale.ipcMessageTimer,undefined);
                    assert.equal(client.retryTimer,false);
                    assert.deepEqual(events,[]);
                    assert.equal(stale.destroyed,false);
                }
            },
            {
                name:'clears or stops pending retries before another connection attempt',
                async run(){
                    const client=new Client(config(),() => {});
                    const expected=new Error('connection options probe');
                    let retried=false;
                    client.path='manual-connect';
                    client.retryTimer=setTimeout(() => retried=true,0);
                    client.connectionOptions=() => {
                        throw expected;
                    };

                    assert.throws(() => client.connect(),(error) => error === expected);
                    await new Promise((resolve) => setTimeout(resolve,10));

                    assert.equal(client.retryTimer,false);
                    assert.equal(retried,false);

                    const stopped=new Client(config({
                        maxRetries:1,
                        retry:0,
                        stopRetrying:false
                    }),() => {});
                    const closing=fakeSocket();
                    let reconnects=0;
                    stopped.socket=closing;
                    stopped.retriesRemaining=1;
                    stopped.connect=() => reconnects++;
                    let destroys=0;
                    stopped.on('destroy',() => destroys++);
                    stopped.closed(closing);
                    stopped.config.stopRetrying=true;
                    await new Promise((resolve) => setTimeout(resolve,10));

                    assert.equal(stopped.retryTimer,false);
                    assert.equal(reconnects,0);
                    assert.equal(closing.destroyed,true);
                    assert.equal(destroys,1);
                }
            },
            {
                name:'retires destroyed local and network clients before replacement',
                async run(){
                    const originalConnect=Client.prototype.connect;
                    let ghostReconnects=0;
                    const instance=new IPC;
                    instance.config.silent=true;
                    const createOldClient=() => {
                        const old=new Client(config(),() => {});
                        old.socket=fakeSocket({destroyed:true});
                        old.retryTimer=setTimeout(() => ghostReconnects++,0);
                        return old;
                    };
                    const local=createOldClient();
                    const network=createOldClient();
                    instance.of.local=local;
                    instance.of.network=network;
                    Client.prototype.connect=function(){
                        this.socket=fakeSocket();
                    };

                    try{
                        instance.connectTo('local','local-replacement');
                        instance.connectToNet('network',host,9000);
                        await new Promise((resolve) => setTimeout(resolve,10));

                        assert.equal(local.explicitlyDisconnected,true);
                        assert.equal(network.explicitlyDisconnected,true);
                        assert.equal(local.retryTimer,false);
                        assert.equal(network.retryTimer,false);
                        assert.equal(ghostReconnects,0);
                        assert.notStrictEqual(instance.of.local,local);
                        assert.notStrictEqual(instance.of.network,network);
                    }finally{
                        Client.prototype.connect=originalConnect;
                        clearTimeout(local.retryTimer);
                        clearTimeout(network.retryTimer);
                    }
                }
            }
        ]
    }
];

export {groups as default,groups};
