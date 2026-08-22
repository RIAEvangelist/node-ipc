import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';

import {IPCModule} from '../../node-ipc.js';
import {reservePort,stopIPC,waitForEvent,withTimeout} from '../support.js';

const host='127.0.0.1';
const host6='::1';
const setupAttempts=3;
const operationTimeout=5000;

function quietIPC(){
    const instance=new IPCModule;
    instance.config.silent=true;
    instance.config.stopRetrying=true;
    instance.config.retry=25;
    instance.config.maxRetries=0;
    instance.config.identifyPeer=true;
    return instance;
}

function wireMessage(type,data){
    return `${JSON.stringify({type,data})}\f`;
}

function readFrame(socket,label){
    return new Promise((resolve,reject) => {
        let buffer='';
        const timer=setTimeout(
            () => finish(new Error(`${label} timed out while waiting for a protocol frame.`)),
            operationTimeout
        );

        function cleanup(){
            clearTimeout(timer);
            socket.off('data',onData);
            socket.off('error',onError);
            socket.off('close',onClose);
        }

        function finish(error,value){
            cleanup();
            error ? reject(error) : resolve(value);
        }

        function onData(chunk){
            buffer+=chunk.toString();
            const boundary=buffer.indexOf('\f');
            if(boundary === -1){
                return;
            }
            try{
                finish(null,JSON.parse(buffer.slice(0,boundary)));
            }catch(error){
                finish(error);
            }
        }

        function onError(error){
            finish(error);
        }

        function onClose(){
            finish(new Error(`${label} socket closed before a protocol frame arrived.`));
        }

        socket.on('data',onData);
        socket.once('error',onError);
        socket.once('close',onClose);
    });
}

function waitForConnect(socket,label){
    if(!socket.connecting){
        return Promise.resolve();
    }
    return new Promise((resolve,reject) => {
        const timer=setTimeout(
            () => finish(new Error(`${label} timed out after ${operationTimeout} ms.`)),
            operationTimeout
        );
        const cleanup=() => {
            clearTimeout(timer);
            socket.off('connect',onConnect);
            socket.off('error',onError);
            socket.off('close',onClose);
        };
        const finish=(error) => {
            cleanup();
            error ? reject(error) : resolve();
        };
        const onConnect=() => {
            finish();
        };
        const onError=(error) => {
            finish(error);
        };
        const onClose=() => {
            finish(new Error(`${label} socket closed before connecting.`));
        };
        socket.once('connect',onConnect);
        socket.once('error',onError);
        socket.once('close',onClose);
    });
}

function waitForDatagram(socket,label){
    return new Promise((resolve,reject) => {
        const timer=setTimeout(
            () => finish(new Error(`${label} timed out after ${operationTimeout} ms.`)),
            operationTimeout
        );
        const cleanup=() => {
            clearTimeout(timer);
            socket.off('message',onMessage);
            socket.off('error',onError);
            socket.off('close',onClose);
        };
        const finish=(error,value) => {
            cleanup();
            error ? reject(error) : resolve(value);
        };
        const onMessage=(message) => finish(null,message);
        const onError=(error) => finish(error);
        const onClose=() => finish(new Error(`${label} socket closed before receiving a datagram.`));
        socket.once('message',onMessage);
        socket.once('error',onError);
        socket.once('close',onClose);
    });
}

function addressInUse(error){
    for(let current=error; current; current=current.cause){
        if(current.code === 'EADDRINUSE'){
            return true;
        }
    }
    return false;
}

async function retryAddressReservation(setup){
    let lastError;
    for(let attempt=1; attempt<=setupAttempts; attempt++){
        try{
            return await setup();
        }catch(error){
            lastError=error;
            if(!addressInUse(error) || attempt === setupAttempts){
                throw error;
            }
        }
    }
    throw lastError;
}

async function closeNetServer(server,sockets,label){
    for(const socket of sockets || []){
        socket?.destroy();
    }
    if(!server?.listening){
        return;
    }
    await withTimeout(new Promise((resolve,reject) => {
        try{
            server.close((error) => error ? reject(error) : resolve());
        }catch(error){
            reject(error);
        }
    }),label);
}

async function closeDatagram(socket,label){
    if(!socket){
        return;
    }
    try{
        await withTimeout(new Promise((resolve) => socket.close(resolve)),label);
    }catch(error){
        if(error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING'){
            throw error;
        }
    }
}

async function startProtocolClient(){
    return retryAddressReservation(startProtocolClientAttempt);
}

async function startProtocolClientAttempt(){
    const serverIPC=quietIPC();
    const port=await reservePort(host);
    let rawSocket;

    try{
        let resolveStart;
        let rejectStart;
        const listening=new Promise((resolve,reject) => {
            resolveStart=resolve;
            rejectStart=reject;
        });
        serverIPC.serveNet(host,port,resolveStart);
        serverIPC.server.on('error',rejectStart);
        serverIPC.server.start();
        await withTimeout(listening,'protocol-compatible TCP server start');

        const accepted=waitForEvent(serverIPC.server,'connect');
        rawSocket=net.connect({host,port});
        rawSocket.setEncoding('utf8');
        const [,acceptedArguments]=await Promise.all([
            waitForConnect(rawSocket,'protocol-compatible TCP client connect'),
            accepted
        ]);
        const [serverSocket]=acceptedArguments;

        return {port,rawSocket,serverIPC,serverSocket};
    }catch(error){
        rawSocket?.destroy();
        await stopIPC(undefined,serverIPC);
        throw error;
    }
}

async function stopProtocolClient(context){
    if(!context){
        return;
    }
    context.rawSocket?.destroy();
    await stopIPC(undefined,context.serverIPC);
}

async function startProtocolServer(){
    const neutralServer=net.createServer();
    const neutralSockets=new Set;
    const clientIPC=quietIPC();
    const id='neutral-server';
    let serverSocket;

    neutralServer.on('connection',(socket) => {
        neutralSockets.add(socket);
        socket.once('close',() => neutralSockets.delete(socket));
    });

    try{
        await new Promise((resolve,reject) => {
            neutralServer.once('error',reject);
            neutralServer.listen(0,host,resolve);
        });
        const port=neutralServer.address().port;
        const accepted=withTimeout(new Promise((resolve) => neutralServer.once('connection',resolve)),'neutral TCP server accept');
        clientIPC.connectToNet(id,host,port);
        const client=clientIPC.of[id];
        const connected=waitForEvent(client,'connect');
        [serverSocket]=await Promise.all([accepted,connected]);
        serverSocket.setEncoding('utf8');
        return {client,clientIPC,id,neutralServer,neutralSockets,port,serverSocket};
    }catch(error){
        await stopIPC(clientIPC,undefined,id);
        await closeNetServer(neutralServer,neutralSockets,'neutral TCP server failure cleanup');
        throw error;
    }
}

async function stopProtocolServer(context){
    if(!context){
        return;
    }
    await stopIPC(context.clientIPC,undefined,context.id);
    await closeNetServer(
        context.neutralServer,
        context.neutralSockets,
        'neutral TCP server teardown'
    );
}

async function startMultipleClients(){
    return retryAddressReservation(startMultipleClientsAttempt);
}

async function startMultipleClientsAttempt(){
    const serverIPC=quietIPC();
    const firstIPC=quietIPC();
    const secondIPC=quietIPC();
    const port=await reservePort(host);

    try{
        let resolveStart;
        let rejectStart;
        const listening=new Promise((resolve,reject) => {
            resolveStart=resolve;
            rejectStart=reject;
        });
        serverIPC.serveNet(host,port,resolveStart);
        serverIPC.server.on('error',rejectStart);
        serverIPC.server.start();
        await withTimeout(listening,'multiple-client TCP server start');

        const firstAccepted=waitForEvent(serverIPC.server,'connect');
        firstIPC.connectToNet('first-peer',host,port);
        const first=firstIPC.of['first-peer'];
        const firstConnected=waitForEvent(first,'connect');
        const [[firstSocket]]=await Promise.all([firstAccepted,firstConnected]);

        const secondAccepted=waitForEvent(serverIPC.server,'connect');
        secondIPC.connectToNet('second-peer',host,port);
        const second=secondIPC.of['second-peer'];
        const secondConnected=waitForEvent(second,'connect');
        const [[secondSocket]]=await Promise.all([secondAccepted,secondConnected]);

        return {
            first,
            firstIPC,
            firstSocket,
            port,
            second,
            secondIPC,
            secondSocket,
            serverIPC
        };
    }catch(error){
        await stopMultipleClients({firstIPC,secondIPC,serverIPC});
        throw error;
    }
}

async function stopMultipleClients(context){
    if(!context){
        return;
    }
    await stopIPC(context.firstIPC,undefined,'first-peer');
    await stopIPC(context.secondIPC,undefined,'second-peer');
    await stopIPC(undefined,context.serverIPC);
}

async function assertUnicastIsolation(context,{event,recipient,other,socket}){
    let otherDeliveries=0;
    const onOther=() => otherDeliveries++;
    other.on(event,onOther);
    try{
        const received=waitForEvent(recipient,event);
        context.serverIPC.server.emit(socket,event,{recipient:event});
        assert.deepEqual((await received)[0],{recipient:event});

        const barrier=`${event}.barrier`;
        const otherBarrier=waitForEvent(other,barrier);
        context.serverIPC.server.broadcast(barrier,{complete:true});
        await otherBarrier;
        assert.equal(otherDeliveries,0);
    }finally{
        other.off(event,onOther);
    }
}

async function reserveUDP6Port(){
    const socket=dgram.createSocket('udp6');
    await new Promise((resolve,reject) => {
        socket.once('error',reject);
        socket.bind(0,host6,resolve);
    });
    const {port}=socket.address();
    await closeDatagram(socket,'UDP6 port reservation cleanup');
    return port;
}

async function startUDP6(){
    return retryAddressReservation(startUDP6Attempt);
}

async function startUDP6Attempt(){
    const serverIPC=quietIPC();
    const port=await reserveUDP6Port();
    let client;

    try{
        let resolveStart;
        let rejectStart;
        const started=new Promise((resolve,reject) => {
            resolveStart=resolve;
            rejectStart=reject;
        });
        serverIPC.serveNet(host6,port,'udp6',resolveStart);
        serverIPC.server.on('error',rejectStart);
        const connected=waitForEvent(serverIPC.server,'connect');
        serverIPC.server.start();
        await Promise.all([
            withTimeout(started,'UDP6 server start'),
            withTimeout(connected,'UDP6 native bind')
        ]);

        client=dgram.createSocket('udp6');
        await new Promise((resolve,reject) => {
            client.once('error',reject);
            client.bind(0,host6,resolve);
        });
        return {client,port,serverIPC};
    }catch(error){
        try{
            await closeDatagram(client,'UDP6 client failure cleanup');
        }catch{
            // Preserve the setup error.
        }
        try{
            await closeDatagram(serverIPC.server?.server,'UDP6 server failure cleanup');
        }catch{
            // Preserve the setup error.
        }
        throw error;
    }
}

async function stopUDP6(context){
    if(!context){
        return;
    }
    await closeDatagram(context.client,'UDP6 client teardown');
    await closeDatagram(context.serverIPC.server.server,'UDP6 server teardown');
}

async function sendUDP6(client,port,payload){
    await new Promise((resolve,reject) => {
        client.send(payload,port,host6,(error) => error ? reject(error) : resolve());
    });
}

const groups=[
    {
        category:'Integration',
        name:'Protocol-compatible TCP client',
        setup:startProtocolClient,
        teardown:stopProtocolClient,
        cases:[
            {
                name:'connects without loading node-ipc in the peer',
                run(context){
                    assert.equal(context.rawSocket.remotePort,context.port);
                    assert.ok(context.serverIPC.server.sockets.includes(context.serverSocket));
                }
            },
            {
                name:'delivers a neutral object frame to the node-ipc server',
                async run(context){
                    const received=waitForEvent(context.serverIPC.server,'neutral.object');
                    context.rawSocket.write(wireMessage('neutral.object',{answer:42}));
                    assert.deepEqual((await received)[0],{answer:42});
                }
            },
            {
                name:'delivers a neutral false payload to the node-ipc server',
                async run(context){
                    const received=waitForEvent(context.serverIPC.server,'neutral.false');
                    context.rawSocket.write(wireMessage('neutral.false',false));
                    assert.equal((await received)[0],false);
                }
            },
            {
                name:'delivers a neutral zero payload to the node-ipc server',
                async run(context){
                    const received=waitForEvent(context.serverIPC.server,'neutral.zero');
                    context.rawSocket.write(wireMessage('neutral.zero',0));
                    assert.equal((await received)[0],0);
                }
            },
            {
                name:'decodes a node-ipc reply with only the wire contract',
                async run(context){
                    const received=readFrame(context.rawSocket,'neutral TCP client reply');
                    context.serverIPC.server.emit(context.serverSocket,'neutral.reply',{language:'any'});
                    assert.deepEqual(await received,{
                        type:'neutral.reply',
                        data:{language:'any'}
                    });
                }
            }
        ]
    },
    {
        category:'Integration',
        name:'Protocol-compatible TCP server',
        setup:startProtocolServer,
        teardown:stopProtocolServer,
        cases:[
            {
                name:'accepts a node-ipc client without loading node-ipc in the server',
                run(context){
                    assert.equal(context.client.socket.destroyed,false);
                    assert.equal(context.serverSocket.remotePort,context.client.socket.localPort);
                }
            },
            {
                name:'receives a node-ipc object as a neutral JSON frame',
                async run(context){
                    const received=readFrame(context.serverSocket,'neutral TCP server object');
                    context.client.emit('neutral.object',{answer:42});
                    assert.deepEqual(await received,{
                        type:'neutral.object',
                        data:{answer:42}
                    });
                }
            },
            {
                name:'receives a node-ipc false payload without coercion',
                async run(context){
                    const received=readFrame(context.serverSocket,'neutral TCP server false payload');
                    context.client.emit('neutral.false',false);
                    assert.deepEqual(await received,{type:'neutral.false',data:false});
                }
            },
            {
                name:'receives Unicode through the neutral wire frame',
                async run(context){
                    const received=readFrame(context.serverSocket,'neutral TCP server Unicode payload');
                    context.client.emit('neutral.unicode',{text:'Zażółć こんにちは 🌍'});
                    assert.deepEqual(await received,{
                        type:'neutral.unicode',
                        data:{text:'Zażółć こんにちは 🌍'}
                    });
                }
            },
            {
                name:'turns a neutral reply frame into a node-ipc client event',
                async run(context){
                    const received=waitForEvent(context.client,'neutral.reply');
                    context.serverSocket.write(wireMessage('neutral.reply',{language:'any'}));
                    assert.deepEqual((await received)[0],{language:'any'});
                }
            }
        ]
    },
    {
        category:'Integration',
        name:'Multiple TCP client routing',
        setup:startMultipleClients,
        teardown:stopMultipleClients,
        cases:[
            {
                name:'tracks two simultaneous client sockets',
                run(context){
                    assert.equal(context.serverIPC.server.sockets.length,2);
                    assert.notStrictEqual(context.firstSocket,context.secondSocket);
                }
            },
            {
                name:'associates each declared peer id with the correct socket',
                async run(context){
                    const firstSeen=waitForEvent(context.serverIPC.server,'multi.identity.first');
                    context.first.emit('multi.identity.first',{id:'first-wire-peer'});
                    assert.strictEqual((await firstSeen)[1],context.firstSocket);

                    const secondSeen=waitForEvent(context.serverIPC.server,'multi.identity.second');
                    context.second.emit('multi.identity.second',{id:'second-wire-peer'});
                    assert.strictEqual((await secondSeen)[1],context.secondSocket);
                    assert.equal(context.firstSocket.id,'first-wire-peer');
                    assert.equal(context.secondSocket.id,'second-wire-peer');
                }
            },
            {
                name:'isolates a unicast addressed to the first client',
                async run(context){
                    await assertUnicastIsolation(context,{
                        event:'multi.to-first',
                        other:context.second,
                        recipient:context.first,
                        socket:context.firstSocket
                    });
                }
            },
            {
                name:'isolates a unicast addressed to the second client',
                async run(context){
                    await assertUnicastIsolation(context,{
                        event:'multi.to-second',
                        other:context.first,
                        recipient:context.second,
                        socket:context.secondSocket
                    });
                }
            },
            {
                name:'broadcasts one event to both clients',
                async run(context){
                    const first=waitForEvent(context.first,'multi.broadcast');
                    const second=waitForEvent(context.second,'multi.broadcast');
                    context.serverIPC.server.broadcast('multi.broadcast',{audience:'all'});
                    const [firstArgs,secondArgs]=await Promise.all([first,second]);
                    assert.deepEqual(firstArgs[0],{audience:'all'});
                    assert.deepEqual(secondArgs[0],{audience:'all'});
                }
            }
        ]
    },
    {
        category:'Integration',
        name:'UDP6 datagram exchange',
        setup:startUDP6,
        teardown:stopUDP6,
        cases:[
            {
                name:'binds a public UDP6 service to the requested port',
                run(context){
                    const address=context.serverIPC.server.server.address();
                    assert.equal(context.serverIPC.server.udp6,true);
                    assert.equal(address.family,'IPv6');
                    assert.ok(
                        [host6,'0:0:0:0:0:0:0:1'].includes(address.address.toLowerCase()),
                        `Expected an IPv6 loopback bind, received ${address.address}.`
                    );
                    assert.equal(address.port,context.port);
                }
            },
            {
                name:'decodes a UDP6 event and preserves sender metadata',
                async run(context){
                    const received=waitForEvent(context.serverIPC.server,'udp6.request');
                    await sendUDP6(context.client,context.port,wireMessage('udp6.request',{value:6}));
                    const [data,sender]=await received;
                    assert.deepEqual(data,{value:6});
                    assert.equal(net.isIPv6(sender.address),true);
                    assert.equal(sender.port,context.client.address().port);
                }
            },
            {
                name:'associates a declared peer id with its UDP6 sender',
                async run(context){
                    const received=waitForEvent(context.serverIPC.server,'udp6.identity');
                    await sendUDP6(
                        context.client,
                        context.port,
                        wireMessage('udp6.identity',{id:'udp6-client',ready:true})
                    );
                    assert.equal((await received)[1].id,'udp6-client');
                }
            },
            {
                name:'sends a framed response to one UDP6 peer',
                async run(context){
                    const peer=waitForEvent(context.serverIPC.server,'udp6.peer');
                    await sendUDP6(context.client,context.port,wireMessage('udp6.peer',{ready:true}));
                    const [,sender]=await peer;
                    const response=waitForDatagram(context.client,'UDP6 response');
                    context.serverIPC.server.emit(sender,'udp6.response',{answer:42});
                    const frame=(await response).toString();
                    assert.equal(frame.endsWith('\f'),true);
                    assert.deepEqual(JSON.parse(frame.slice(0,-1)),{
                        type:'udp6.response',
                        data:{answer:42}
                    });
                }
            },
            {
                name:'decodes two complete UDP6 frames in wire order',
                async run(context){
                    const values=[];
                    let handler;
                    const received=withTimeout(new Promise((resolve) => {
                        handler=(data) => {
                            values.push(data.sequence);
                            if(values.length === 2){
                                resolve();
                            }
                        };
                        context.serverIPC.server.on('udp6.batch',handler);
                    }),'UDP6 batched frames');
                    try{
                        await sendUDP6(
                            context.client,
                            context.port,
                            wireMessage('udp6.batch',{sequence:1})+wireMessage('udp6.batch',{sequence:2})
                        );
                        await received;
                    }finally{
                        context.serverIPC.server.off('udp6.batch',handler);
                    }
                    assert.deepEqual(values,[1,2]);
                }
            }
        ]
    }
];

export {groups as default,groups};
