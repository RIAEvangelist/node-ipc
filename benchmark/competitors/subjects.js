const loaders={
    'native-child-process':() => import('./adapters/native-child-process.js'),
    'native-net':() => import('./adapters/native-net.js'),
    'node-ipc':() => import('./adapters/node-ipc.js'),
    'socket-io':() => import('./adapters/socket-io.js'),
    'ws':() => import('./adapters/ws.js'),
    'zeromq':() => import('./adapters/zeromq.js')
};

const subjectIds=Object.freeze(Object.keys(loaders));

function loadSubject(id){
    const loader=loaders[id];
    if(!loader){
        throw new Error(`available subjects: ${subjectIds.join(', ')}`);
    }
    return loader();
}

export {
    loadSubject,
    subjectIds
};
