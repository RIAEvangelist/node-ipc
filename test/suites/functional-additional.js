import assert from 'node:assert/strict';

import {Defaults} from '../../entities/Defaults.js';
import {IPCModule} from '../../node-ipc.js';
import {Server} from '../../dao/socketServer.js';

function parseFrame(frame,delimiter='\f'){
    assert.equal(frame.slice(-delimiter.length),delimiter);
    return JSON.parse(frame.slice(0,-delimiter.length));
}

function quietIPC(){
    const instance=new IPCModule;
    instance.config.silent=true;
    return instance;
}

const groups=[
    {
        category:'Functional',
        name:'Server outbound routing',
        cases:[
            {
                name:'writes one framed event to a stream socket',
                run(){
                    const writes=[];
                    const server=new Server('local',new Defaults,() => {});
                    server.emit({write:(value) => writes.push(value)},'functional.unicast',{value:1});
                    assert.equal(writes.length,1);
                    assert.deepEqual(parseFrame(writes[0]),{
                        type:'functional.unicast',
                        data:{value:1}
                    });
                }
            },
            {
                name:'broadcasts one framed event to each stream socket exactly once',
                run(){
                    const first=[];
                    const second=[];
                    const server=new Server('local',new Defaults,() => {});
                    server.sockets=[
                        {write:(value) => first.push(value)},
                        {write:(value) => second.push(value)}
                    ];
                    server.broadcast('functional.broadcast',{value:2});
                    assert.equal(first.length,1);
                    assert.equal(second.length,1);
                    assert.deepEqual(parseFrame(first[0]),{
                        type:'functional.broadcast',
                        data:{value:2}
                    });
                    assert.deepEqual(parseFrame(second[0]),parseFrame(first[0]));
                }
            },
            {
                name:'writes raw-buffer bytes to one stream socket',
                run(){
                    const config=new Defaults;
                    config.rawBuffer=true;
                    const writes=[];
                    const server=new Server('local',config,() => {});
                    server.emit({write:(value) => writes.push(value)},'raw unicast',{ignored:true});
                    assert.equal(writes.length,1);
                    assert.ok(Buffer.isBuffer(writes[0]));
                    assert.equal(writes[0].toString(config.encoding),'raw unicast');
                }
            },
            {
                name:'broadcasts raw-buffer bytes to every stream socket',
                run(){
                    const config=new Defaults;
                    config.rawBuffer=true;
                    const writes=[[],[]];
                    const server=new Server('local',config,() => {});
                    server.sockets=writes.map((values) => ({write:(value) => values.push(value)}));
                    server.broadcast('raw broadcast',{ignored:true});
                    assert.deepEqual(writes.map((values) => values.length),[1,1]);
                    assert.ok(writes.every(([value]) => Buffer.isBuffer(value)));
                    assert.ok(writes.every(([value]) => value.toString(config.encoding) === 'raw broadcast'));
                }
            },
            {
                name:'preserves the address and port of a targeted UDP write',
                run(){
                    const writes=[];
                    const server=new Server('127.0.0.1',new Defaults,() => {},4321);
                    const target={address:'127.0.0.1',port:5432};
                    server.udp4=true;
                    server.server={send:(value,port,address,callback) => {
                        writes.push({address,port,value});
                        callback?.();
                    }};
                    server.emit(target,'functional.udp',{value:3});
                    assert.equal(writes.length,1);
                    assert.equal(writes[0].address,target.address);
                    assert.equal(writes[0].port,target.port);
                    assert.deepEqual(parseFrame(writes[0].value.toString()),{
                        type:'functional.udp',
                        data:{value:3}
                    });
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Service overload resolution',
        cases:[
            {
                name:'serve without arguments derives a local endpoint and default callback',
                run(){
                    const instance=quietIPC();
                    instance.config.socketRoot='/additional/';
                    instance.config.appspace='scope.';
                    instance.config.id='service';
                    instance.serve();
                    assert.equal(instance.server.path,'/additional/scope.service');
                    assert.equal(instance.server.list.start.length,1);
                    assert.equal(typeof instance.server.list.start[0],'function');
                }
            },
            {
                name:'numeric-only serveNet uses the default host and explicit TCP port',
                run(){
                    const instance=quietIPC();
                    instance.config.networkHost='127.0.0.21';
                    instance.serveNet(9501);
                    assert.equal(instance.server.path,'127.0.0.21');
                    assert.equal(instance.server.port,9501);
                    assert.equal(instance.server.udp4,false);
                    assert.equal(instance.server.udp6,false);
                }
            },
            {
                name:'host-plus-callback serveNet uses the configured TCP port',
                run(){
                    const instance=quietIPC();
                    const callback=() => {};
                    instance.config.networkPort=9502;
                    instance.serveNet('127.0.0.22',callback);
                    assert.equal(instance.server.path,'127.0.0.22');
                    assert.equal(instance.server.port,9502);
                    assert.ok(instance.server.list.start.includes(callback));
                }
            },
            {
                name:'port-plus-UDP4 serveNet uses the default host and registers its callback',
                run(){
                    const instance=quietIPC();
                    const callback=() => {};
                    instance.config.networkHost='127.0.0.23';
                    instance.serveNet(9503,'udp4',callback);
                    assert.equal(instance.server.path,'127.0.0.23');
                    assert.equal(instance.server.port,9503);
                    assert.equal(instance.server.udp4,true);
                    assert.ok(instance.server.list.start.includes(callback));
                }
            },
            {
                name:'fully specified UDP6 serveNet preserves endpoint protocol and callback',
                run(){
                    const instance=quietIPC();
                    const callback=() => {};
                    instance.serveNet('::1',9504,'udp6',callback);
                    assert.equal(instance.server.path,'::1');
                    assert.equal(instance.server.port,9504);
                    assert.equal(instance.server.udp6,true);
                    assert.equal(instance.server.udp4,false);
                    assert.ok(instance.server.list.start.includes(callback));
                }
            }
        ]
    }
];

export {groups as default,groups};
