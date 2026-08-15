import ipc,{IPCModule} from '../node-ipc.js';

if(!(ipc instanceof IPCModule)){
    throw new TypeError('The default export must be an IPCModule instance.');
}

for(const method of ['connectTo','connectToNet','disconnect','serve','serveNet']){
    if(typeof ipc[method] !== 'function'){
        throw new TypeError(`The default export is missing ${method}().`);
    }
}

console.log('node-ipc ESM runtime smoke passed');
