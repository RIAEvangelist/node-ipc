import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Message from 'js-message';

import {Parser} from '../../entities/EventParser.js';
import {IPCModule} from '../../node-ipc.js';
import {reservePort,stopIPC,waitForEvent,withTimeout} from '../support.js';

const host='127.0.0.1';
const certificate=fileURLToPath(new URL('../../local-node-ipc-certs/server.pub',import.meta.url));
const privateKey=fileURLToPath(new URL('../../local-node-ipc-certs/private/server.key',import.meta.url));

function quietIPC(){
    const instance=new IPCModule;
    instance.config.silent=true;
    instance.config.stopRetrying=true;
    instance.config.retry=25;
    instance.config.maxRetries=0;
    return instance;
}

async function startStreamPair({local=false,tls=false}={}){
    const serverIPC=quietIPC();
    const clientIPC=quietIPC();
    const id=tls ? 'tlsPeer' : (local ? 'localPeer' : 'tcpPeer');
    let endpoint;
    let directory;

    if(local){
        directory=await mkdtemp(path.join(os.tmpdir(),'node-ipc-correctness-'));
        endpoint=process.platform === 'win32'
            ? `/node-ipc-${process.pid}-${Date.now()}/app.${id}`
            : path.join(directory,`app.${id}`);
    }else{
        endpoint=await reservePort(host);
    }

    try{
        if(tls){
            serverIPC.config.tls={private:privateKey,public:certificate};
            clientIPC.config.tls={rejectUnauthorized:false};
        }

        let resolveStart;
        let rejectStart;
        const started=new Promise((resolve,reject) => {
            resolveStart=resolve;
            rejectStart=reject;
        });

        if(local){
            serverIPC.serve(endpoint,resolveStart);
        }else{
            serverIPC.serveNet(host,endpoint,resolveStart);
        }
        serverIPC.server.on('error',rejectStart);
        const serverConnection=waitForEvent(serverIPC.server,'connect');
        serverIPC.server.start();
        await withTimeout(started,`${id} server start`);

        if(local){
            clientIPC.connectTo(id,endpoint);
        }else{
            clientIPC.connectToNet(id,host,endpoint);
        }
        const client=clientIPC.of[id];
        const clientConnected=waitForEvent(client,'connect');
        client.on('error',rejectStart);
        const [[serverSocket]]=await Promise.all([
            serverConnection,
            withTimeout(clientConnected,`${id} client connect`)
        ]);

        return {
            client,
            clientIPC,
            directory,
            endpoint,
            id,
            serverIPC,
            serverSocket
        };
    }catch(error){
        await stopIPC(clientIPC,serverIPC,id);
        if(directory){
            await rm(directory,{recursive:true,force:true});
        }
        throw error;
    }
}

async function teardownStreamPair(context){
    if(!context){
        return;
    }
    await stopIPC(context.clientIPC,context.serverIPC,context.id);
    if(context.directory){
        await rm(context.directory,{recursive:true,force:true});
    }
}

async function reserveUDPPort(){
    const socket=dgram.createSocket('udp4');
    await new Promise((resolve,reject) => {
        socket.once('error',reject);
        socket.bind(0,host,resolve);
    });
    const {port}=socket.address();
    await new Promise((resolve) => socket.close(resolve));
    return port;
}

function wireMessage(type,data){
    const value=new Message;
    value.type=type;
    value.data=data;
    return new Parser().format(value);
}

async function startUDP(){
    const serverIPC=quietIPC();
    const port=await reserveUDPPort();
    let client;
    let resolveStart;
    let rejectStart;
    const started=new Promise((resolve,reject) => {
        resolveStart=resolve;
        rejectStart=reject;
    });

    try{
        serverIPC.serveNet(host,port,'udp4',resolveStart);
        serverIPC.server.on('error',rejectStart);
        const connected=waitForEvent(serverIPC.server,'connect');
        serverIPC.server.start();
        await Promise.all([
            withTimeout(started,'UDP4 server start'),
            withTimeout(connected,'UDP4 native bind')
        ]);

        client=dgram.createSocket('udp4');
        await new Promise((resolve,reject) => {
            client.once('error',reject);
            client.bind(0,host,resolve);
        });

        return {client,port,serverIPC};
    }catch(error){
        try{
            client?.close();
        }catch{
            // Preserve the setup error.
        }
        try{
            serverIPC.server?.server?.close();
        }catch{
            // Preserve the setup error.
        }
        throw error;
    }
}

async function sendDatagram(client,port,payload){
    await new Promise((resolve,reject) => {
        client.send(payload,port,host,(error) => error ? reject(error) : resolve());
    });
}

const streamCases=(prefix) => [
    {
        name:'binds and reports the requested endpoint',
        run(context){
            assert.equal(context.serverIPC.server.server.listening,true);
            if(typeof context.endpoint === 'number'){
                assert.equal(context.serverIPC.server.server.address().port,context.endpoint);
            }else{
                assert.equal(typeof context.serverIPC.server.server.address(),'string');
            }
        }
    },
    {
        name:'establishes both public peer and server socket state',
        run(context){
            assert.strictEqual(context.clientIPC.of[context.id],context.client);
            assert.equal(context.client.socket.destroyed,false);
            assert.ok(context.serverIPC.server.sockets.includes(context.serverSocket));
        }
    },
    {
        name:'delivers a structured client event to the server',
        async run(context){
            const payload={id:`${prefix}-client`,sequence:1};
            const [received,socket]=await waitForEvent(
                context.serverIPC.server,
                `${prefix}.request`,
                () => context.client.emit(`${prefix}.request`,payload)
            );
            assert.deepEqual(received,payload);
            assert.strictEqual(socket,context.serverSocket);
        }
    },
    {
        name:'delivers a server unicast event to the client',
        async run(context){
            const payload={from:`${prefix}-server`,mode:'unicast'};
            const [received]=await waitForEvent(
                context.client,
                `${prefix}.response`,
                () => context.serverIPC.server.emit(
                    context.serverSocket,
                    `${prefix}.response`,
                    payload
                )
            );
            assert.deepEqual(received,payload);
        }
    },
    {
        name:'delivers a server broadcast event to connected clients',
        async run(context){
            const payload={from:`${prefix}-server`,mode:'broadcast'};
            const [received]=await waitForEvent(
                context.client,
                `${prefix}.broadcast`,
                () => context.serverIPC.server.broadcast(`${prefix}.broadcast`,payload)
            );
            assert.deepEqual(received,payload);
        }
    }
];

const groups=[
    {
        category:'Integration',
        name:'TCP lifecycle and round trip',
        setup:() => startStreamPair(),
        teardown:teardownStreamPair,
        cases:streamCases('tcp')
    },
    {
        category:'Integration',
        name:'Local socket or Windows pipe round trip',
        setup:() => startStreamPair({local:true}),
        teardown:teardownStreamPair,
        cases:streamCases('local')
    },
    {
        category:'Integration',
        name:'UDP4 datagram exchange',
        setup:startUDP,
        async teardown(context){
            if(!context){
                return;
            }
            await new Promise((resolve) => context.client.close(resolve));
            if(context.serverIPC.server.server){
                await new Promise((resolve) => context.serverIPC.server.server.close(resolve));
            }
        },
        cases:[
            {
                name:'binds a public UDP4 service to the requested port',
                run(context){
                    const address=context.serverIPC.server.server.address();
                    assert.equal(context.serverIPC.server.udp4,true);
                    assert.equal(address.address,host);
                    assert.equal(address.port,context.port);
                }
            },
            {
                name:'decodes a custom event and preserves sender metadata',
                async run(context){
                    const awaited=waitForEvent(context.serverIPC.server,'udp.request');
                    await sendDatagram(context.client,context.port,wireMessage('udp.request',{value:7}));
                    const [data,sender]=await awaited;
                    assert.deepEqual(data,{value:7});
                    assert.equal(sender.address,host);
                    assert.equal(sender.port,context.client.address().port);
                }
            },
            {
                name:'associates a declared peer id with its datagram sender',
                async run(context){
                    const awaited=waitForEvent(context.serverIPC.server,'udp.identity');
                    await sendDatagram(
                        context.client,
                        context.port,
                        wireMessage('udp.identity',{id:'udp-client',value:true})
                    );
                    const [,sender]=await awaited;
                    assert.equal(sender.id,'udp-client');
                }
            },
            {
                name:'sends a framed response to one UDP peer',
                async run(context){
                    const peerAwaited=waitForEvent(context.serverIPC.server,'udp.peer');
                    await sendDatagram(context.client,context.port,wireMessage('udp.peer',{ready:true}));
                    const [,sender]=await peerAwaited;
                    const response=withTimeout(
                        new Promise((resolve,reject) => {
                            context.client.once('message',resolve);
                            context.client.once('error',reject);
                        }),
                        'UDP4 response'
                    );
                    context.serverIPC.server.emit(sender,'udp.response',{answer:42});
                    const frame=(await response).toString();
                    assert.deepEqual(JSON.parse(frame.slice(0,-1)),{
                        type:'udp.response',
                        data:{answer:42}
                    });
                }
            },
            {
                name:'decodes two complete frames from one datagram in order',
                async run(context){
                    const values=[];
                    const received=withTimeout(new Promise((resolve) => {
                        const handler=(data) => {
                            values.push(data.sequence);
                            if(values.length === 2){
                                context.serverIPC.server.off('udp.batch',handler);
                                resolve();
                            }
                        };
                        context.serverIPC.server.on('udp.batch',handler);
                    }),'UDP4 batched frames');
                    await sendDatagram(
                        context.client,
                        context.port,
                        wireMessage('udp.batch',{sequence:1})+wireMessage('udp.batch',{sequence:2})
                    );
                    await received;
                    assert.deepEqual(values,[1,2]);
                }
            }
        ]
    },
    {
        category:'Integration',
        name:'TLS encrypted transport',
        setup:() => startStreamPair({tls:true}),
        teardown:teardownStreamPair,
        cases:[
            {
                name:'creates an encrypted server-side socket',
                run(context){
                    assert.equal(context.serverSocket.encrypted,true);
                }
            },
            {
                name:'creates an encrypted client-side socket',
                run(context){
                    assert.equal(context.client.socket.encrypted,true);
                    assert.equal(context.client.socket.destroyed,false);
                }
            },
            {
                name:'negotiates a concrete TLS cipher',
                run(context){
                    const cipher=context.client.socket.getCipher();
                    assert.equal(typeof cipher.name,'string');
                    assert.ok(cipher.name.length > 0);
                }
            },
            {
                name:'delivers a framed event through the encrypted channel',
                async run(context){
                    const payload={secure:true,direction:'client-to-server'};
                    const [received]=await waitForEvent(
                        context.serverIPC.server,
                        'tls.request',
                        () => context.client.emit('tls.request',payload)
                    );
                    assert.deepEqual(received,payload);
                }
            },
            {
                name:'returns a framed event through the encrypted channel',
                async run(context){
                    const payload={secure:true,direction:'server-to-client'};
                    const [received]=await waitForEvent(
                        context.client,
                        'tls.response',
                        () => context.serverIPC.server.emit(
                            context.serverSocket,
                            'tls.response',
                            payload
                        )
                    );
                    assert.deepEqual(received,payload);
                }
            }
        ]
    }
];

export {groups as default,groups};
