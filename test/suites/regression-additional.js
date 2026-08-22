import assert from 'node:assert/strict';

import {Server} from '../../dao/socketServer.js';
import {Defaults} from '../../entities/Defaults.js';
import {IPCModule} from '../../node-ipc.js';

function assertMethodAssignmentIsIgnored(name){
    const instance=new IPCModule;
    const original=instance[name];
    instance[name]=() => 'replacement';
    assert.strictEqual(instance[name],original);
}

function closeFixture({readable=false,resetEvents=false}={}){
    const server=new Server('local',new Defaults,() => {});
    const listeners={};
    const socket={
        id:'regression-peer',
        readable,
        destroyCalls:0,
        on(type,listener){
            listeners[type]=listener;
        },
        destroy(){
            this.destroyCalls++;
        },
        setEncoding(){},
        setNoDelay(){}
    };
    let closed;
    let disconnected;

    server.on('socket.disconnected',(closedSocket,id) => {
        disconnected={closedSocket,id};
    });
    server.addSocket(socket);
    if(resetEvents){
        server.reset();
    }
    server.on('close',(closedSocket) => {
        closed={closedSocket,sockets:[...server.sockets]};
    });
    listeners.close();

    return {closed,disconnected,server,socket};
}

const groups=[
    {
        category:'Regression',
        name:'Public method accessor stability',
        cases:[
            {
                name:'keeps connectTo callable after an assignment attempt',
                run(){
                    assertMethodAssignmentIsIgnored('connectTo');
                }
            },
            {
                name:'keeps connectToNet callable after an assignment attempt',
                run(){
                    assertMethodAssignmentIsIgnored('connectToNet');
                }
            },
            {
                name:'keeps disconnect callable after an assignment attempt',
                run(){
                    assertMethodAssignmentIsIgnored('disconnect');
                }
            },
            {
                name:'keeps serve callable after an assignment attempt',
                run(){
                    assertMethodAssignmentIsIgnored('serve');
                }
            },
            {
                name:'keeps serveNet callable after an assignment attempt',
                run(){
                    assertMethodAssignmentIsIgnored('serveNet');
                }
            }
        ]
    },
    {
        category:'Regression',
        name:'Server socket cleanup invariants',
        cases:[
            {
                name:'removes a closed socket before publishing close after reset',
                run(){
                    const {closed,server,socket}=closeFixture({resetEvents:true});
                    assert.deepEqual(server.sockets,[]);
                    assert.strictEqual(closed.closedSocket,socket);
                    assert.deepEqual(closed.sockets,[]);
                }
            },
            {
                name:'destroys an unreadable closed socket exactly once',
                run(){
                    const {socket}=closeFixture();
                    assert.equal(socket.destroyCalls,1);
                }
            },
            {
                name:'publishes the disconnected socket and its peer id',
                run(){
                    const {disconnected,socket}=closeFixture();
                    assert.strictEqual(disconnected.closedSocket,socket);
                    assert.equal(disconnected.id,'regression-peer');
                }
            },
            {
                name:'retains a socket that remains readable',
                run(){
                    const {disconnected,server,socket}=closeFixture({readable:true});
                    assert.deepEqual(server.sockets,[socket]);
                    assert.equal(socket.destroyCalls,0);
                    assert.equal(disconnected,undefined);
                }
            },
            {
                name:'delegates server stop to the active listener',
                run(){
                    const server=new Server('local',new Defaults,() => {});
                    let closeCalls=0;
                    server.server={close:() => closeCalls++};
                    server.stop();
                    assert.equal(closeCalls,1);
                }
            }
        ]
    }
];

export {groups as default,groups};
