const loaders={
    'node-net':() => import('./node-net.js'),
    'node-ipc-raw':() => import('./node-ipc.js').then(({createAdapter}) => createAdapter('raw')),
    'node-ipc-fast':() => import('./node-ipc.js').then(({createAdapter}) => createAdapter('fast')),
    'node-ipc-guarded':() => import('./node-ipc.js').then(({createAdapter}) => createAdapter('guarded'))
};

const names=Object.freeze(Object.keys(loaders));

function loadAdapter(name){
    const load=loaders[name];
    if(!load){
        throw new Error(`available adapters: ${names.join(', ')}`);
    }
    return load();
}

export {
    loadAdapter,
    names
};
