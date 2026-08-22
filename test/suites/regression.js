import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import EventPubSub,{EventPubSub as NamedEventPubSub} from 'event-pubsub';
import IndexEventPubSub,{EventPubSub as NamedIndexEventPubSub} from 'event-pubsub/index.js';
import Message from 'js-message';

import {Parser} from '../../entities/EventParser.js';
import {IPCModule} from '../../node-ipc.js';
import {parseFrame} from '../support.js';

const require=createRequire(import.meta.url);
const RequiredEventPubSub=require('event-pubsub');
const RequiredIndexEventPubSub=require('event-pubsub/index.js');
const wildcard=Symbol.for('event-pubsub-all');

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
                name:'preserves an empty-string payload',
                run(){
                    assert.equal(parseFrame(frame('regression.empty-string','')).data,'');
                }
            },
            {
                name:'preserves a null payload',
                run(){
                    assert.equal(parseFrame(frame('regression.null',null)).data,null);
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
                name:'keeps root and index ESM and CommonJS class identities stable',
                run(){
                    assert.strictEqual(EventPubSub,NamedEventPubSub);
                    assert.strictEqual(EventPubSub,IndexEventPubSub);
                    assert.strictEqual(EventPubSub,NamedIndexEventPubSub);
                    assert.strictEqual(EventPubSub,RequiredEventPubSub);
                    assert.strictEqual(EventPubSub,RequiredIndexEventPubSub);
                    assert.strictEqual(RequiredEventPubSub.default,EventPubSub);
                    assert.strictEqual(RequiredEventPubSub.EventPubSub,EventPubSub);
                    const events=new EventPubSub;
                    assert.strictEqual(Object.getPrototypeOf(events),EventPubSub.prototype);
                    assert.equal(events.constructor.name,'EventPubSub');
                    assert.throws(() => events.on(1,() => {}),TypeError);
                    assert.throws(() => events.emit(1),TypeError);
                    events.on('invalid-handler',() => {});
                    assert.throws(() => events.off('invalid-handler',1),TypeError);
                }
            },
            {
                name:'accepts prototype-like and reserved lifecycle event names locally',
                run(){
                    const events=new EventPubSub;
                    const seen=[];
                    const types=[...new Set([
                        ...Object.getOwnPropertyNames(Object.prototype),
                        'start','connect','disconnect','destroy','close',
                        'socket.disconnected','error','data'
                    ])];
                    for(const type of types){
                        const handler=() => seen.push(type);
                        events.on(type,handler);
                        events.emit(type);
                        assert.equal(Object.hasOwn(events.list,type),true);
                        events.off(type,handler).emit(type);
                    }
                    assert.deepEqual(seen,types);
                    for(const type of types) events.on(type,() => {});
                    events.reset();
                    assert.deepEqual(Reflect.ownKeys(events.list),[]);
                }
            },
            {
                name:'distinguishes wildcard registration from the Symbol description during live synchronous dispatch',
                run(){
                    const events=new EventPubSub;
                    const seen=[];
                    const exactType=wildcard.toString();
                    let emitReturned=false;
                    const late=(type) => {
                        assert.equal(emitReturned,false);
                        seen.push(`late:${type}`);
                    };
                    const all=(type) => {
                        assert.equal(emitReturned,false);
                        seen.push(`wildcard:${type}`);
                        if(type === 'work'){
                            events.on('*',late);
                            events.on('work',() => seen.push('typed:late'));
                        }
                    };
                    const exact=() => seen.push('typed:symbol-description');
                    events.on('*',all).on(exactType,exact).emit(exactType);
                    assert.deepEqual(seen,[`wildcard:${exactType}`,'typed:symbol-description']);
                    assert.deepEqual(events.list[wildcard],[all]);
                    assert.deepEqual(events.list[exactType],[exact]);

                    events.off(exactType,exact).off(exactType,all);
                    assert.deepEqual(events.list[wildcard],[all]);
                    assert.equal(events.list[exactType],undefined);

                    seen.length=0;
                    events.on('work',() => seen.push('typed:work')).emit('work');
                    emitReturned=true;
                    assert.deepEqual(seen,['wildcard:work','late:work','typed:work','typed:late']);

                    seen.length=0;
                    emitReturned=false;
                    events.emit('*');
                    emitReturned=true;
                    assert.deepEqual(seen,['wildcard:*','late:*']);
                }
            },
            {
                name:'removes frozen once handlers before invocation and preserves explicit removals',
                run(){
                    const events=new EventPubSub;
                    const seen=[];
                    const persistent=(value) => seen.push(`persistent:${value}`);
                    const removed=Object.freeze(() => seen.push('removed'));
                    const once=Object.freeze((value) => {
                        assert.deepEqual(events.list.work,[persistent]);
                        seen.push(`once:${value}`);
                        events.emit('work','nested');
                    });
                    events.once('work',once);
                    events.on('work',persistent);
                    events.on('work',removed).off('work',removed);
                    events.emit('work','outer').emit('work','again');
                    assert.deepEqual(seen,[
                        'once:outer',
                        'persistent:nested',
                        'persistent:outer',
                        'persistent:again'
                    ]);
                    assert.deepEqual(events.list.work,[persistent]);
                }
            },
            {
                name:'keeps list snapshots isolated while delivering every hot-path emit without loss',
                run(){
                    const events=new EventPubSub;
                    let count=0;
                    let sum=0;
                    let expected=1;
                    const shared={marker:true};
                    const handler=(value,payload) => {
                        assert.equal(value,expected++);
                        assert.strictEqual(payload,shared);
                        count++;
                        sum+=value;
                    };
                    events.on('hot',handler);
                    const arities=[];
                    events.on('arity',(...args) => arities.push(args));
                    events.emit('arity');
                    events.emit('arity',shared);
                    events.emit('arity',1,shared);
                    events.emit('arity',1,2,shared);
                    assert.deepEqual(arities,[[],[shared],[1,shared],[1,2,shared]]);
                    assert.strictEqual(arities[1][0],shared);
                    assert.strictEqual(arities[2][1],shared);
                    assert.strictEqual(arities[3][2],shared);
                    const snapshot=events.list;
                    assert.strictEqual(Object.getPrototypeOf(snapshot),null);
                    snapshot.hot.length=0;
                    snapshot.injected=[handler];
                    for(let value=1; value<=5000; value++){
                        events.emit('hot',value,shared);
                    }
                    assert.equal(count,5000);
                    assert.equal(sum,12_502_500);
                    assert.equal(expected,5001);
                    assert.deepEqual(events.list.hot,[handler]);
                    assert.equal(events.list.injected,undefined);
                    const secondSnapshot=events.list;
                    assert.notStrictEqual(secondSnapshot,snapshot);
                    assert.notStrictEqual(secondSnapshot.hot,snapshot.hot);
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
                    assert.deepEqual(Object.keys(instance.of),[]);
                }
            },
            {
                name:'rejects a network connection request without a service id',
                run(){
                    const instance=quietIPC();
                    assert.equal(instance.connectToNet(),undefined);
                    assert.deepEqual(Object.keys(instance.of),[]);
                }
            },
            {
                name:'treats disconnect of an unknown peer as a no-op',
                run(){
                    const instance=quietIPC();
                    instance.of.known={marker:true};
                    assert.equal(instance.disconnect('missing'),undefined);
                    assert.deepEqual({...instance.of},{known:{marker:true}});
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
                async run(){
                    const instance=quietIPC();
                    const peer=new EventPubSub;
                    let destroyed=false;
                    let retried=false;
                    peer.explicitlyDisconnected=false;
                    peer.retryTimer=setTimeout(() => retried=true,0);
                    peer.socket={destroy:() => {
                        destroyed=true;
                    }};
                    peer.on('*',() => {});
                    instance.of.peer=peer;
                    instance.disconnect('peer');
                    assert.equal(peer.explicitlyDisconnected,true);
                    assert.equal(peer.retryTimer,false);
                    assert.deepEqual(Reflect.ownKeys(peer.list),[]);
                    assert.equal(destroyed,true);
                    assert.equal(Object.hasOwn(instance.of,'peer'),false);
                    await new Promise(resolve => setTimeout(resolve,10));
                    assert.equal(retried,false);
                }
            }
        ]
    }
];

export {groups as default,groups};
