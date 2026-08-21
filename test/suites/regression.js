import assert from 'node:assert/strict';
import EventPubSub,{EventPubSub as NamedEventPubSub} from 'event-pubsub';
import Message from 'js-message';

import {Parser} from '../../entities/EventParser.js';
import {IPCModule} from '../../node-ipc.js';
import {parseFrame} from '../support.js';

function frame(type,data){
    const value=new Message;
    value.type=type;
    value.data=data;
    return new Parser().format(value);
}

function quietIPC(){
    const instance=new IPCModule;
    instance.config.silent=true;
    return instance;
}

const groups=[
    {
        category:'Regression',
        name:'Protocol payload edge cases',
        cases:[
            {
                name:'keeps delimiter characters inside JSON strings escaped',
                run(){
                    const parser=new Parser;
                    const formatted=frame('regression.delimiter',{text:'before\fafter'});
                    const parts=parser.parse(formatted);
                    assert.equal(parts.length,1);
                    assert.equal(JSON.parse(parts[0]).data.text,'before\fafter');
                }
            },
            {
                name:'round-trips multibyte payload text without corruption',
                run(){
                    assert.equal(
                        parseFrame(frame('regression.unicode',{text:'こんにちは 🌍'})).data.text,
                        'こんにちは 🌍'
                    );
                }
            },
            {
                name:'normalizes an empty-string payload to the legacy empty object',
                run(){
                    assert.deepEqual(parseFrame(frame('regression.empty-string','')).data,{});
                }
            },
            {
                name:'normalizes a null payload to the legacy empty object',
                run(){
                    assert.deepEqual(parseFrame(frame('regression.null',null)).data,{});
                }
            },
            {
                name:'preserves payloads whose emitter marker is explicitly zero',
                run(){
                    const data={_maxListeners:0,value:'public'};
                    assert.deepEqual(parseFrame(frame('regression.zero-listeners',data)).data,data);
                }
            }
        ]
    },
    {
        category:'Regression',
        name:'Public argument overloads',
        cases:[
            {
                name:'serve callback overload selects the configured local endpoint',
                run(){
                    const instance=quietIPC();
                    instance.config.socketRoot='/regression/';
                    instance.config.appspace='app.';
                    instance.config.id='service';
                    const callback=() => {};
                    instance.serve(callback);
                    assert.equal(instance.server.path,'/regression/app.service');
                    assert.ok(instance.server.list.start.includes(callback));
                }
            },
            {
                name:'numeric serveNet overload selects default host and explicit port',
                run(){
                    const instance=quietIPC();
                    instance.config.networkHost='127.0.0.9';
                    const callback=() => {};
                    instance.serveNet(9301,callback);
                    assert.equal(instance.server.path,'127.0.0.9');
                    assert.equal(instance.server.port,9301);
                    assert.ok(instance.server.list.start.includes(callback));
                }
            },
            {
                name:'UDP4 serveNet overload selects configured host and port',
                run(){
                    const instance=quietIPC();
                    instance.config.networkHost='127.0.0.8';
                    instance.config.networkPort=9302;
                    const callback=() => {};
                    instance.serveNet('udp4',callback);
                    assert.equal(instance.server.path,'127.0.0.8');
                    assert.equal(instance.server.port,9302);
                    assert.equal(instance.server.udp4,true);
                }
            },
            {
                name:'host-plus-UDP6 overload selects the configured port',
                run(){
                    const instance=quietIPC();
                    instance.config.networkPort=9303;
                    const callback=() => {};
                    instance.serveNet('::1','udp6',callback);
                    assert.equal(instance.server.path,'::1');
                    assert.equal(instance.server.port,9303);
                    assert.equal(instance.server.udp6,true);
                }
            },
            {
                name:'callback-only serveNet overload selects both network defaults',
                run(){
                    const instance=quietIPC();
                    instance.config.networkHost='127.0.0.7';
                    instance.config.networkPort=9304;
                    const callback=() => {};
                    instance.serveNet(callback);
                    assert.equal(instance.server.path,'127.0.0.7');
                    assert.equal(instance.server.port,9304);
                    assert.ok(instance.server.list.start.includes(callback));
                }
            }
        ]
    },
    {
        category:'Regression',
        name:'event-pubsub transport compatibility',
        cases:[
            {
                name:'keeps default and named class exports identical',
                run(){
                    assert.strictEqual(EventPubSub,NamedEventPubSub);
                }
            },
            {
                name:'keeps the public prototype and constructor name stable',
                run(){
                    const events=new EventPubSub;
                    assert.strictEqual(Object.getPrototypeOf(events),EventPubSub.prototype);
                    assert.equal(events.constructor.name,'EventPubSub');
                }
            },
            {
                name:'accepts every node-ipc reserved lifecycle event locally',
                run(){
                    const events=new EventPubSub;
                    const seen=[];
                    const types=['start','connect','disconnect','destroy','close','socket.disconnected','error','data'];
                    for(const type of types){
                        events.on(type,() => seen.push(type));
                        events.emit(type);
                    }
                    assert.deepEqual(seen,types);
                }
            },
            {
                name:'preserves wildcard, once, and explicit removal semantics',
                run(){
                    const events=new EventPubSub;
                    const seen=[];
                    const removed=() => seen.push('removed');
                    events.on('*',(type,value) => seen.push(`all:${type}:${value}`));
                    events.once('work',(value) => seen.push(`once:${value}`));
                    events.on('work',removed).off('work',removed);
                    events.emit('work',1).emit('work',2);
                    assert.deepEqual(seen,['all:work:1','once:1','all:work:2']);
                }
            },
            {
                name:'delivers every event on the emit hot path without loss',
                run(){
                    const events=new EventPubSub;
                    let count=0;
                    let sum=0;
                    events.on('hot',(value) => {
                        count++;
                        sum+=value;
                    });
                    for(let value=1; value<=5000; value++){
                        events.emit('hot',value);
                    }
                    assert.equal(count,5000);
                    assert.equal(sum,12_502_500);
                }
            }
        ]
    },
    {
        category:'Regression',
        name:'Connection lifecycle guards',
        cases:[
            {
                name:'rejects a local connection request without a service id',
                run(){
                    const instance=quietIPC();
                    assert.equal(instance.connectTo(),undefined);
                    assert.deepEqual(instance.of,{});
                }
            },
            {
                name:'rejects a network connection request without a service id',
                run(){
                    const instance=quietIPC();
                    assert.equal(instance.connectToNet(),undefined);
                    assert.deepEqual(instance.of,{});
                }
            },
            {
                name:'treats disconnect of an unknown peer as a no-op',
                run(){
                    const instance=quietIPC();
                    instance.of.known={marker:true};
                    assert.equal(instance.disconnect('missing'),undefined);
                    assert.deepEqual(instance.of,{known:{marker:true}});
                }
            },
            {
                name:'reuses a live connection and invokes the new callback',
                run(){
                    const instance=quietIPC();
                    const live={socket:{destroyed:false}};
                    instance.of.peer=live;
                    let callbacks=0;
                    instance.connectToNet('peer','127.0.0.1',9401,() => callbacks++);
                    assert.strictEqual(instance.of.peer,live);
                    assert.equal(callbacks,1);
                }
            },
            {
                name:'marks, clears, destroys, and removes a disconnected peer',
                run(){
                    const instance=quietIPC();
                    const peer=new EventPubSub;
                    let destroyed=false;
                    peer.explicitlyDisconnected=false;
                    peer.socket={destroy:() => {
                        destroyed=true;
                    }};
                    peer.on('*',() => {});
                    instance.of.peer=peer;
                    instance.disconnect('peer');
                    assert.equal(peer.explicitlyDisconnected,true);
                    assert.deepEqual(peer.list,{});
                    assert.equal(destroyed,true);
                    assert.equal(Object.hasOwn(instance.of,'peer'),false);
                }
            }
        ]
    }
];

export {groups as default,groups};
