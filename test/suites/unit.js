import assert from 'node:assert/strict';
import os from 'node:os';
import Message from 'js-message';

import {Client} from '../../dao/client.js';
import {Defaults} from '../../entities/Defaults.js';
import {Parser} from '../../entities/EventParser.js';
import ipc,{IPCModule} from '../../node-ipc.js';
import {Server} from '../../dao/socketServer.js';
import {parseFrame} from '../support.js';

function message(type,data,includeData=true){
    const value=new Message;
    value.type=type;
    if(includeData){
        value.data=data;
    }
    return value;
}

const groups=[
    {
        category:'Unit',
        name:'Defaults core configuration',
        cases:[
            {
                name:'constructs isolated configuration objects',
                run(){
                    const first=new Defaults;
                    const second=new Defaults;
                    assert.notStrictEqual(first,second);
                    assert.notStrictEqual(first.interface,second.interface);
                }
            },
            {
                name:'uses a non-empty host identity',
                run(){
                    const config=new Defaults;
                    assert.equal(typeof config.id,'string');
                    assert.ok(config.id.length > 0);
                }
            },
            {
                name:'defines the local protocol namespace and delimiter',
                run(){
                    const config=new Defaults;
                    assert.equal(config.appspace,'app.');
                    assert.equal(typeof config.socketRoot,'string');
                    assert.ok(config.socketRoot.length > 0);
                    assert.equal(config.delimiter,'\f');
                }
            },
            {
                name:'defaults to framed asynchronous UTF-8 messages',
                run(){
                    const config=new Defaults;
                    assert.equal(config.encoding,'utf8');
                    assert.equal(config.rawBuffer,false);
                    assert.equal(config.sync,false);
                }
            },
            {
                name:'enables stale local-socket unlinking by default',
                run(){
                    assert.equal(new Defaults().unlink,true);
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'Defaults network and logging configuration',
        cases:[
            {
                name:'derives a loopback host from the detected IP family',
                run(){
                    const original=os.networkInterfaces;
                    try{
                        os.networkInterfaces=() => [[{family:'IPv6'}]];
                        const config=new Defaults;
                        assert.equal(config.IPType,'IPv6');
                        assert.equal(config.networkHost,'::1');
                    }finally{
                        os.networkInterfaces=original;
                    }
                }
            },
            {
                name:'sets stable network port and connection limits',
                run(){
                    const config=new Defaults;
                    assert.equal(config.networkPort,8000);
                    assert.equal(config.maxConnections,100);
                }
            },
            {
                name:'starts every optional client interface field disabled',
                run(){
                    assert.deepEqual(new Defaults().interface,{
                        localAddress:false,
                        localPort:false,
                        family:false,
                        hints:false,
                        lookup:false
                    });
                }
            },
            {
                name:'keeps broad local-socket permissions disabled',
                run(){
                    const config=new Defaults;
                    assert.equal(config.readableAll,false);
                    assert.equal(config.writableAll,false);
                }
            },
            {
                name:'provides an enabled console logger with bounded inspection',
                run(){
                    const config=new Defaults;
                    assert.equal(config.silent,false);
                    assert.equal(config.logDepth,5);
                    assert.equal(config.logInColor,true);
                    assert.equal(typeof config.logger,'function');
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'EventParser formatting',
        cases:[
            {
                name:'serializes an object payload and appends one delimiter',
                run(){
                    const parser=new Parser;
                    assert.deepEqual(parseFrame(parser.format(message('unit.object',{value:42}))),{
                        type:'unit.object',
                        data:{value:42}
                    });
                }
            },
            {
                name:'preserves a boolean false payload',
                run(){
                    assert.equal(parseFrame(new Parser().format(message('unit.false',false))).data,false);
                }
            },
            {
                name:'preserves a numeric zero payload',
                run(){
                    assert.equal(parseFrame(new Parser().format(message('unit.zero',0))).data,0);
                }
            },
            {
                name:'normalizes omitted payload data to an object',
                run(){
                    assert.deepEqual(parseFrame(new Parser().format(message('unit.empty',undefined,false))).data,{});
                }
            },
            {
                name:'does not serialize event-emitter internals',
                run(){
                    const data={_maxListeners:10,private:'not-for-wire'};
                    assert.deepEqual(parseFrame(new Parser().format(message('unit.emitter',data))).data,{});
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'EventParser frame splitting',
        cases:[
            {
                name:'extracts one complete frame',
                run(){
                    assert.deepEqual(new Parser().parse('one\f'),['one']);
                }
            },
            {
                name:'extracts multiple frames in wire order',
                run(){
                    assert.deepEqual(new Parser().parse('one\ftwo\fthree\f'),['one','two','three']);
                }
            },
            {
                name:'ignores an incomplete trailing frame',
                run(){
                    assert.deepEqual(new Parser().parse('complete\fincomplete'),['complete']);
                }
            },
            {
                name:'supports a configured multi-character delimiter',
                run(){
                    const config=new Defaults;
                    config.delimiter='<END>';
                    assert.deepEqual(new Parser(config).parse('first<END>second<END>'),['first','second']);
                }
            },
            {
                name:'returns an empty list when no frame is complete',
                run(){
                    assert.deepEqual(new Parser().parse(''),[]);
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'Public module surface',
        cases:[
            {
                name:'exports one singleton IPC module',
                run(){
                    assert.ok(ipc instanceof IPCModule);
                }
            },
            {
                name:'exposes the IPC class through module instances',
                run(){
                    const instance=new IPCModule;
                    assert.equal(typeof instance.IPC,'function');
                    assert.ok(instance instanceof instance.IPC);
                }
            },
            {
                name:'isolates config and connection registries per instance',
                run(){
                    const first=new IPCModule;
                    const second=new IPCModule;
                    assert.notStrictEqual(first.config,second.config);
                    assert.notStrictEqual(first.of,second.of);
                }
            },
            {
                name:'publishes all five connection and service methods',
                run(){
                    const instance=new IPCModule;
                    for(const method of ['connectTo','connectToNet','disconnect','serve','serveNet']){
                        assert.equal(typeof instance[method],'function',method);
                    }
                }
            },
            {
                name:'starts without a server or peer connections',
                run(){
                    const instance=new IPCModule;
                    assert.equal(instance.server,false);
                    assert.deepEqual(instance.of,{});
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'Transport object construction',
        cases:[
            {
                name:'client retains its configuration and logger',
                run(){
                    const config=new Defaults;
                    const logger=() => {};
                    const client=new Client(config,logger);
                    assert.strictEqual(client.config,config);
                    assert.strictEqual(client.log,logger);
                }
            },
            {
                name:'client initializes its retry allowance from configuration',
                run(){
                    const config=new Defaults;
                    config.maxRetries=7;
                    assert.equal(new Client(config,() => {}).retriesRemaining,7);
                }
            },
            {
                name:'client exposes its constructor and transport operations',
                run(){
                    const client=new Client(new Defaults,() => {});
                    assert.strictEqual(client.Client,Client);
                    assert.equal(typeof client.connect,'function');
                    assert.equal(typeof client.emit,'function');
                }
            },
            {
                name:'server retains path, port, and configuration',
                run(){
                    const config=new Defaults;
                    const server=new Server('127.0.0.1',config,() => {},4321);
                    assert.equal(server.path,'127.0.0.1');
                    assert.equal(server.port,4321);
                    assert.strictEqual(server.config,config);
                }
            },
            {
                name:'server starts with neutral transport state',
                run(){
                    const server=new Server('local',new Defaults,() => {});
                    assert.equal(server.server,false);
                    assert.equal(server.udp4,false);
                    assert.equal(server.udp6,false);
                    assert.deepEqual(server.sockets,[]);
                }
            }
        ]
    }
];

export {groups as default,groups};
