import assert from 'node:assert/strict';

import {Client} from '../../dao/client.js';
import {Defaults} from '../../entities/Defaults.js';
import {IPCModule} from '../../node-ipc.js';
import {parseFrame} from '../support.js';

function configuredIPC(){
    const instance=new IPCModule;
    instance.config.silent=true;
    return instance;
}

const groups=[
    {
        category:'Functional',
        name:'Configured logging',
        cases:[
            {
                name:'silent mode suppresses logger calls',
                run(){
                    const instance=new IPCModule;
                    let calls=0;
                    instance.config.logger=() => calls++;
                    instance.config.silent=true;
                    instance.log('hidden');
                    assert.equal(calls,0);
                }
            },
            {
                name:'joins primitive arguments into one record',
                run(){
                    const instance=new IPCModule;
                    const records=[];
                    instance.config.logger=(record) => records.push(record);
                    instance.log('peer','connected',42);
                    assert.deepEqual(records,['peer connected 42']);
                }
            },
            {
                name:'inspects object arguments for readable output',
                run(){
                    const instance=new IPCModule;
                    const records=[];
                    instance.config.logInColor=false;
                    instance.config.logger=(record) => records.push(record);
                    instance.log('payload',{value:1});
                    assert.match(records[0],/^payload \{ value: 1 \}$/);
                }
            },
            {
                name:'honors the configured object inspection depth',
                run(){
                    const instance=new IPCModule;
                    const records=[];
                    instance.config.logInColor=false;
                    instance.config.logDepth=0;
                    instance.config.logger=(record) => records.push(record);
                    instance.log({outer:{inner:true}});
                    assert.match(records[0],/outer: \[Object\]/);
                }
            },
            {
                name:'emits exactly one logger call per log operation',
                run(){
                    const instance=new IPCModule;
                    const records=[];
                    instance.config.logger=(record) => records.push(record);
                    instance.log('one','logical','record');
                    assert.equal(records.length,1);
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Local service construction',
        cases:[
            {
                name:'uses an explicit local endpoint',
                run(){
                    const instance=configuredIPC();
                    instance.serve('/custom/ipc/path');
                    assert.equal(instance.server.path,'/custom/ipc/path');
                }
            },
            {
                name:'derives its endpoint from socket root, appspace, and id',
                run(){
                    const instance=configuredIPC();
                    instance.config.socketRoot='/suite/';
                    instance.config.appspace='scope.';
                    instance.config.id='service';
                    instance.serve();
                    assert.equal(instance.server.path,'/suite/scope.service');
                }
            },
            {
                name:'shares the live public configuration with its server',
                run(){
                    const instance=configuredIPC();
                    instance.serve('/suite/service');
                    assert.strictEqual(instance.server.config,instance.config);
                }
            },
            {
                name:'registers the supplied start callback',
                run(){
                    const instance=configuredIPC();
                    let startedWith;
                    instance.serve('/suite/service',(socket) => {
                        startedWith=socket;
                    });
                    instance.server.publish('start','local-socket');
                    assert.equal(startedWith,'local-socket');
                }
            },
            {
                name:'replaces an earlier unstarted service definition cleanly',
                run(){
                    const instance=configuredIPC();
                    instance.serve('/suite/first');
                    const first=instance.server;
                    instance.serve('/suite/second');
                    assert.notStrictEqual(instance.server,first);
                    assert.equal(instance.server.path,'/suite/second');
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Network service construction',
        cases:[
            {
                name:'preserves an explicit TCP host and port',
                run(){
                    const instance=configuredIPC();
                    instance.serveNet('127.0.0.1',9123);
                    assert.equal(instance.server.path,'127.0.0.1');
                    assert.equal(instance.server.port,9123);
                }
            },
            {
                name:'registers the supplied network start callback',
                run(){
                    const instance=configuredIPC();
                    let endpoint;
                    instance.serveNet('127.0.0.1',9124,(value) => {
                        endpoint=value;
                    });
                    instance.server.publish('start',{port:9124});
                    assert.deepEqual(endpoint,{port:9124});
                }
            },
            {
                name:'marks a UDP4 service without marking UDP6',
                run(){
                    const instance=configuredIPC();
                    instance.serveNet('127.0.0.1',9125,'udp4');
                    assert.equal(instance.server.udp4,true);
                    assert.equal(instance.server.udp6,false);
                }
            },
            {
                name:'marks a UDP6 service without marking UDP4',
                run(){
                    const instance=configuredIPC();
                    instance.serveNet('::1',9126,'udp6');
                    assert.equal(instance.server.udp4,false);
                    assert.equal(instance.server.udp6,true);
                }
            },
            {
                name:'normalizes a UDP4 service away from IPv6 loopback',
                run(){
                    const instance=configuredIPC();
                    instance.serveNet('::1',9127,'udp4');
                    assert.equal(instance.server.path,'127.0.0.1');
                }
            }
        ]
    },
    {
        category:'Functional',
        name:'Client outbound messaging',
        cases:[
            {
                name:'writes one framed custom event to its socket',
                run(){
                    const config=new Defaults;
                    const writes=[];
                    const client=new Client(config,() => {});
                    client.id='peer';
                    client.path='endpoint';
                    client.socket={write:(value) => writes.push(value)};
                    client.emit('functional.object',{answer:42});
                    assert.deepEqual(parseFrame(writes[0]),{
                        type:'functional.object',
                        data:{answer:42}
                    });
                }
            },
            {
                name:'preserves Unicode through outbound serialization',
                run(){
                    const writes=[];
                    const client=new Client(new Defaults,() => {});
                    client.socket={write:(value) => writes.push(value)};
                    client.emit('functional.unicode',{text:'Zażółć 🛰️'});
                    assert.equal(parseFrame(writes[0]).data.text,'Zażółć 🛰️');
                }
            },
            {
                name:'writes raw-buffer event bytes without a protocol frame',
                run(){
                    const config=new Defaults;
                    config.rawBuffer=true;
                    const writes=[];
                    const client=new Client(config,() => {});
                    client.socket={write:(value) => writes.push(value)};
                    client.emit('raw bytes ignored as an event name',{ignored:true});
                    assert.ok(Buffer.isBuffer(writes[0]));
                    assert.equal(writes[0].toString(config.encoding),'raw bytes ignored as an event name');
                }
            },
            {
                name:'volatile mode writes immediately without retaining queue work',
                run(){
                    const config=new Defaults;
                    config.sync=false;
                    const writes=[];
                    const client=new Client(config,() => {});
                    client.socket={write:(value) => writes.push(value)};
                    client.emit('functional.immediate',1);
                    assert.equal(writes.length,1);
                    assert.equal(client.queue.contents.length,0);
                }
            },
            {
                name:'synchronous mode holds later writes until queue advancement',
                run(){
                    const config=new Defaults;
                    config.sync=true;
                    const writes=[];
                    const client=new Client(config,() => {});
                    client.socket={write:(value) => writes.push(value)};
                    client.emit('functional.first',1);
                    client.emit('functional.second',2);
                    assert.equal(writes.length,1);
                    assert.equal(client.queue.contents.length,1);
                    client.queue.next();
                    assert.equal(writes.length,2);
                    assert.equal(parseFrame(writes[1]).type,'functional.second');
                }
            }
        ]
    }
];

export {groups as default,groups};
