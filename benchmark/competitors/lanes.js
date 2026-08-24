const transportDefinitions=Object.freeze({
    'process-ipc':Object.freeze({
        family:'process-channel',
        id:'process-ipc',
        implementation:'node-child-process-channel',
        label:'Dedicated parent-child IPC',
        scope:'parent-child',
        securityMode:'platform process IPC; no benchmark-layer encryption'
    }),
    tcp:Object.freeze({
        family:'byte-stream',
        id:'tcp',
        implementation:'tcp4-loopback',
        label:'TCP loopback',
        scope:'loopback',
        securityMode:'none'
    }),
    local:Object.freeze({
        family:'byte-stream',
        id:'local',
        implementation:process.platform === 'win32'
            ? 'windows-named-pipe'
            : 'unix-domain-socket',
        label:'Local IPC',
        scope:'local-machine',
        securityMode:'platform endpoint permissions; no benchmark-layer encryption'
    }),
    tls:Object.freeze({
        family:'encrypted-byte-stream',
        id:'tls',
        implementation:'tls1.3-over-tcp4-loopback',
        label:'Authenticated TLS loopback',
        scope:'loopback',
        securityMode:'mutual TLS 1.3 with CA peer verification'
    }),
    udp4:Object.freeze({
        family:'datagram',
        id:'udp4',
        implementation:'udp4-loopback-with-benchmark-fragmentation',
        label:'UDP4 loopback',
        scope:'loopback',
        securityMode:'none; no authentication, confidentiality, or delivery guarantee'
    }),
    udp6:Object.freeze({
        family:'datagram',
        id:'udp6',
        implementation:'udp6-loopback-with-benchmark-fragmentation',
        label:'UDP6 loopback',
        scope:'loopback',
        securityMode:'none; no authentication, confidentiality, or delivery guarantee'
    })
});

const adapterLoaders=Object.freeze({
    'native-child-process':() => import('./adapters/native-child-process.js'),
    'native-dgram':() => import('./adapters/native-dgram.js'),
    'native-net':() => import('./adapters/native-net.js'),
    'native-tls':() => import('./adapters/native-tls.js'),
    'node-ipc':() => import('./adapters/node-ipc.js'),
    'socket-io':() => import('./adapters/socket-io.js'),
    'ws':() => import('./adapters/ws.js'),
    'zeromq':() => import('./adapters/zeromq.js')
});

const localImplementation=transportDefinitions.local.implementation;
const laneInputs=[
    {
        id:'native-child-process:process-ipc',label:'Node child_process IPC',
        moduleId:'native-child-process',transportId:'process-ipc',
        protocolStack:['node:child_process','platform IPC channel'],
        topology:'parent to direct child',serialization:'Node JSON IPC serialization'
    },
    {
        id:'native-net:tcp',label:'Node net over TCP',moduleId:'native-net',transportId:'tcp',
        protocolStack:['node:net','TCP4 loopback'],topology:'unrelated processes',
        serialization:'canonical JSON with newline framing'
    },
    {
        id:'native-net:local',label:'Node net over local IPC',moduleId:'native-net',transportId:'local',
        protocolStack:['node:net',localImplementation],topology:'unrelated processes',
        serialization:'canonical JSON with newline framing'
    },
    {
        id:'native-tls:tls',label:'Node TLS',moduleId:'native-tls',transportId:'tls',
        protocolStack:['node:tls','TLS 1.3','TCP4 loopback'],topology:'unrelated processes',
        serialization:'canonical JSON with newline framing'
    },
    {
        id:'native-dgram:udp4',label:'Node dgram over UDP4',moduleId:'native-dgram',transportId:'udp4',
        protocolStack:['benchmark UDP fragmentation','node:dgram','UDP4 loopback'],
        topology:'unrelated processes',serialization:'canonical JSON in benchmark fragment envelopes',
        sourceFiles:['adapters/native-dgram.js','lib/udp.js']
    },
    {
        id:'native-dgram:udp6',label:'Node dgram over UDP6',moduleId:'native-dgram',transportId:'udp6',
        protocolStack:['benchmark UDP fragmentation','node:dgram','UDP6 loopback'],
        topology:'unrelated processes',serialization:'canonical JSON in benchmark fragment envelopes',
        sourceFiles:['adapters/native-dgram.js','lib/udp.js']
    },
    {
        id:'node-ipc:tcp',label:'node-ipc over TCP',moduleId:'node-ipc',transportId:'tcp',
        protocolStack:['node-ipc fast framing','node:net','TCP4 loopback'],topology:'unrelated processes',
        serialization:'node-ipc fast event framing'
    },
    {
        id:'node-ipc:local',label:'node-ipc over local IPC',moduleId:'node-ipc',transportId:'local',
        protocolStack:['node-ipc fast framing','node:net',localImplementation],topology:'unrelated processes',
        serialization:'node-ipc fast event framing'
    },
    {
        id:'node-ipc:tls',label:'node-ipc over TLS',moduleId:'node-ipc',transportId:'tls',
        protocolStack:['node-ipc fast framing','node:tls','TLS 1.3','TCP4 loopback'],
        topology:'unrelated processes',serialization:'node-ipc fast event framing'
    },
    {
        id:'node-ipc:udp4',label:'node-ipc over UDP4',moduleId:'node-ipc',transportId:'udp4',
        protocolStack:['benchmark UDP fragmentation','node-ipc fast framing','node:dgram','UDP4 loopback'],
        topology:'unrelated processes',
        serialization:'node-ipc fast event framing carrying benchmark UDP fragments',
        sourceFiles:['adapters/node-ipc.js','lib/udp.js']
    },
    {
        id:'node-ipc:udp6',label:'node-ipc over UDP6',moduleId:'node-ipc',transportId:'udp6',
        protocolStack:['benchmark UDP fragmentation','node-ipc fast framing','node:dgram','UDP6 loopback'],
        topology:'unrelated processes',
        serialization:'node-ipc fast event framing carrying benchmark UDP fragments',
        sourceFiles:['adapters/node-ipc.js','lib/udp.js']
    },
    {
        id:'ws:tcp',label:'ws over TCP',moduleId:'ws',transportId:'tcp',
        protocolStack:['WebSocket','HTTP/1.1','TCP4 loopback'],topology:'unrelated processes',
        serialization:'canonical JSON over WebSocket text messages'
    },
    {
        id:'ws:local',label:'ws over local IPC',moduleId:'ws',transportId:'local',
        protocolStack:['WebSocket','HTTP/1.1',localImplementation],topology:'unrelated processes',
        serialization:'canonical JSON over WebSocket text messages'
    },
    {
        id:'ws:tls',label:'ws over TLS',moduleId:'ws',transportId:'tls',
        protocolStack:['WebSocket','HTTPS','TLS 1.3','TCP4 loopback'],topology:'unrelated processes',
        serialization:'canonical JSON over WebSocket text messages'
    },
    {
        id:'socket-io:tcp',label:'Socket.IO over TCP',moduleId:'socket-io',transportId:'tcp',
        protocolStack:['Socket.IO','Engine.IO','WebSocket','HTTP/1.1','TCP4 loopback'],
        topology:'unrelated processes',serialization:'Socket.IO event serialization'
    },
    {
        id:'socket-io:tls',label:'Socket.IO over TLS',moduleId:'socket-io',transportId:'tls',
        protocolStack:['Socket.IO','Engine.IO','WebSocket','HTTPS','TLS 1.3','TCP4 loopback'],
        topology:'unrelated processes',serialization:'Socket.IO event serialization'
    },
    {
        id:'zeromq:tcp',label:'ZeroMQ over TCP',moduleId:'zeromq',transportId:'tcp',
        protocolStack:['ZeroMQ','ZMTP','TCP4 loopback'],topology:'unrelated processes',
        serialization:'canonical JSON over ZMTP'
    }
];

const laneDefinitions=Object.freeze(Object.fromEntries(laneInputs.map(input => {
    const transport=transportDefinitions[input.transportId];
    const definition=Object.freeze({
        ...input,
        cohortId:input.transportId,
        protocolStack:Object.freeze([...input.protocolStack]),
        securityMode:transport.securityMode,
        sourceFiles:Object.freeze(input.sourceFiles ?? [`adapters/${input.moduleId}.js`])
    });
    return [definition.id,definition];
})));
const laneIds=Object.freeze(Object.keys(laneDefinitions));
const transportIds=Object.freeze(Object.keys(transportDefinitions));
const moduleIds=Object.freeze([...new Set(laneInputs.map(({moduleId}) => moduleId))]);

const legacySubjectLanes=Object.freeze({
    'native-child-process':'native-child-process:process-ipc',
    'native-net':'native-net:tcp',
    'node-ipc':'node-ipc:tcp',
    'socket-io':'socket-io:tcp',
    'ws':'ws:tcp',
    'zeromq':'zeromq:tcp'
});

function laneDefinition(id){
    const definition=laneDefinitions[id];
    if(!definition){
        throw new Error(`available lanes: ${laneIds.join(', ')}`);
    }
    return definition;
}

function lanesForTransports(selectedTransportIds){
    const selected=new Set(selectedTransportIds);
    const unknown=[...selected].filter(id => !transportIds.includes(id));
    if(unknown.length){
        throw new Error(`available transports: ${transportIds.join(', ')}`);
    }
    return laneIds.filter(id => selected.has(laneDefinitions[id].transportId));
}

function implementationFor(adapter,definition){
    return adapter.lanes?.[definition.id]
        ?? adapter.transports?.[definition.transportId]
        ?? adapter;
}

function adapterMethod(adapter,implementation,name){
    const owner=typeof implementation[name] === 'function' ? implementation : adapter;
    const method=owner[name];
    return typeof method === 'function' ? method.bind(owner) : undefined;
}

async function loadLane(id){
    const definition=laneDefinition(id);
    const adapter=await adapterLoaders[definition.moduleId]();
    const implementation=implementationFor(adapter,definition);
    const createClient=adapterMethod(adapter,implementation,'createClient');
    const createServer=adapterMethod(adapter,implementation,'createServer');
    if(!createClient || !createServer){
        throw new Error(`lane ${id} adapter must export createClient and createServer`);
    }
    const moduleMetadata=Object.freeze({
        ...(adapter.metadata ?? {}),
        id:definition.moduleId
    });
    const metadata=Object.freeze({
        ...moduleMetadata,
        ...(implementation.metadata ?? {}),
        cohortId:definition.cohortId,
        id:definition.id,
        label:implementation.metadata?.label ?? definition.label,
        laneId:definition.id,
        moduleId:definition.moduleId,
        transportId:definition.transportId
    });
    return Object.freeze({
        ...definition,
        createClient,
        createServer,
        launchPeer:adapterMethod(adapter,implementation,'launchPeer'),
        metadata,
        moduleMetadata,
        verifyCleanup:adapterMethod(adapter,implementation,'verifyCleanup')
    });
}

function serializeLaneDefinitions(ids=laneIds){
    return Object.fromEntries(ids.map(id => [id,{...laneDefinition(id)}]));
}

function serializeTransportDefinitions(ids=transportIds){
    return Object.fromEntries(ids.map(id => [id,{...transportDefinitions[id]}]));
}

export {
    laneDefinition,
    laneDefinitions,
    laneIds,
    lanesForTransports,
    legacySubjectLanes,
    loadLane,
    moduleIds,
    serializeLaneDefinitions,
    serializeTransportDefinitions,
    transportDefinitions,
    transportIds
};
