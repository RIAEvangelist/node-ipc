import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

import ipc,{IPCModule} from 'node-ipc';
import {Client} from '../dao/client.js';
import {Defaults} from '../entities/Defaults.js';

const require=createRequire(import.meta.url);
const required=require('node-ipc');
const queuePath=require.resolve('js-queue');

assert.strictEqual(required.default,ipc);
assert.strictEqual(required.IPCModule,IPCModule);
assert.equal(require.cache[queuePath],undefined);

const syncConfig=new Defaults;
syncConfig.sync=true;
new Client(syncConfig,() => {});
assert.ok(require.cache[queuePath]);

if(!(ipc instanceof IPCModule)){
    throw new TypeError('The default export must be an IPCModule instance.');
}

for(const method of ['connectTo','connectToNet','disconnect','serve','serveNet']){
    if(typeof ipc[method] !== 'function'){
        throw new TypeError(`The default export is missing ${method}().`);
    }
}

console.log('node-ipc import and require runtime smoke passed');
