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

function closeFixture({readable=false}={}){
    const server=new Server('local',new Defaults,() => {});
    const socket={
        id:'regression-peer',
        readable,
        destroyCalls:0,
        destroy(){
            this.destroyCalls++;
        }
    };
    let disconnected;

    server.sockets.push(socket);
    server.on('socket.disconnected',(closedSocket,id) => {
        disconnected={closedSocket,id};
    });
    server.publish('close',socket);

    return {disconnected,server,socket};
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
                name:'removes an unreadable closed socket from the registry',
                run(){
                    const {server}=closeFixture();
                    assert.deepEqual(server.sockets,[]);
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
