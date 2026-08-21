import assert from 'node:assert/strict';
import Message from 'js-message';

import {Defaults} from '../../entities/Defaults.js';
import {Parser} from '../../entities/EventParser.js';

function message(type,data){
    const value=new Message;
    value.type=type;
    value.data=data;
    return value;
}

function payload(frame,delimiter='\f'){
    assert.equal(frame.slice(-delimiter.length),delimiter);
    return JSON.parse(frame.slice(0,-delimiter.length)).data;
}

const groups=[
    {
        category:'Unit',
        name:'Defaults retry and transport policy',
        cases:[
            {
                name:'uses a 500 millisecond retry delay',
                run(){
                    assert.equal(new Defaults().retry,500);
                }
            },
            {
                name:'allows unlimited retries by default',
                run(){
                    assert.equal(new Defaults().maxRetries,Infinity);
                }
            },
            {
                name:'keeps automatic retrying enabled by default',
                run(){
                    assert.equal(new Defaults().stopRetrying,false);
                }
            },
            {
                name:'leaves TLS transport disabled by default',
                run(){
                    assert.equal(new Defaults().tls,false);
                }
            },
            {
                name:'isolates interface mutations between instances',
                run(){
                    const first=new Defaults;
                    const second=new Defaults;
                    first.interface.localPort=4321;
                    assert.equal(first.interface.localPort,4321);
                    assert.equal(second.interface.localPort,false);
                }
            }
        ]
    },
    {
        category:'Unit',
        name:'EventParser payload shapes',
        cases:[
            {
                name:'preserves a boolean true payload',
                run(){
                    assert.equal(payload(new Parser().format(message('unit.true',true))),true);
                }
            },
            {
                name:'preserves a negative numeric payload',
                run(){
                    assert.equal(payload(new Parser().format(message('unit.negative',-17))),-17);
                }
            },
            {
                name:'preserves a non-empty string payload',
                run(){
                    assert.equal(payload(new Parser().format(message('unit.string','node-ipc'))),'node-ipc');
                }
            },
            {
                name:'preserves an array payload',
                run(){
                    assert.deepEqual(
                        payload(new Parser().format(message('unit.array',[1,'two',false]))),
                        [1,'two',false]
                    );
                }
            },
            {
                name:'appends the configured delimiter without changing the payload',
                run(){
                    const config=new Defaults;
                    config.delimiter='<END>';
                    const formatted=new Parser(config).format(message('unit.delimiter',{value:42}));
                    assert.deepEqual(payload(formatted,config.delimiter),{value:42});
                }
            }
        ]
    }
];

export {groups as default,groups};
