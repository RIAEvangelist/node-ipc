import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

import ipc,{IPCModule} from 'node-ipc';

const required=createRequire(import.meta.url)('node-ipc');

assert.strictEqual(required.default,ipc);
assert.strictEqual(required.IPCModule,IPCModule);

if(!(ipc instanceof IPCModule)){
    throw new TypeError('The default export must be an IPCModule instance.');
}

for(const method of ['connectTo','connectToNet','disconnect','serve','serveNet']){
    if(typeof ipc[method] !== 'function'){
        throw new TypeError(`The default export is missing ${method}().`);
    }
}

console.log('node-ipc import and require runtime smoke passed');
