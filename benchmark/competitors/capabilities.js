import {asOf,sources} from './catalog.js';

const definitions=[
    {id:'parentChild',label:'Direct parent-child IPC'},
    {id:'unrelatedProcesses',label:'Unrelated local processes'},
    {id:'tcp',label:'Remote TCP/IP'},
    {id:'localEndpoint',label:'Unix socket / Windows named pipe'},
    {id:'udp',label:'UDP'},
    {id:'encryptedTransport',label:'Authenticated encrypted transport'},
    {id:'namedEvents',label:'Named events'},
    {id:'requestReply',label:'Request/reply primitive'},
    {id:'broadcastPubSub',label:'Broadcast or pub/sub'},
    {id:'automaticReconnect',label:'Automatic reconnect'},
    {id:'queueingBackpressure',label:'Queueing / backpressure controls'},
    {id:'browserClient',label:'Browser-compatible client'},
    {id:'crossLanguage',label:'Cross-language protocol'},
    {id:'handlePassing',label:'Socket/server handle passing'}
];

const cell=(status,note,source) => ({note,source,status});

const matrix={
    'native-child-process':{
        parentChild:cell('built-in','Dedicated channel created by child_process.fork().',sources.nodeChildProcess),
        unrelatedProcesses:cell('unsupported','The channel is created for a direct child.',sources.nodeChildProcess),
        tcp:cell('unsupported','Not a network transport.',sources.nodeChildProcess),
        localEndpoint:cell('internal','Platform pipe is not exposed as a general server endpoint.',sources.nodeChildProcess),
        udp:cell('unsupported','No datagram transport.',sources.nodeChildProcess),
        encryptedTransport:cell('unsupported','No transport authentication or encryption API.',sources.nodeChildProcess),
        namedEvents:cell('manual','Applications dispatch on message fields.',sources.nodeChildProcess),
        requestReply:cell('manual','Correlation is application-owned.',sources.nodeChildProcess),
        broadcastPubSub:cell('manual','Requires application fan-out to child channels.',sources.nodeChildProcess),
        automaticReconnect:cell('manual','Process and channel restart are application-owned.',sources.nodeChildProcess),
        queueingBackpressure:cell('manual','send() reports channel backlog, but the application owns throttling and queue limits.',sources.nodeChildProcess),
        browserClient:cell('unsupported','Node process API only.',sources.nodeChildProcess),
        crossLanguage:cell('unsupported','The documented message API targets Node child processes.',sources.nodeChildProcess),
        handlePassing:cell('built-in','sendHandle supports selected socket/server handles with platform limits.',sources.nodeChildProcess)
    },
    'native-net':{
        parentChild:cell('manual','A parent and child must create or connect to an explicit TCP or local endpoint; net does not create a dedicated channel.',sources.nodeNet),
        unrelatedProcesses:cell('built-in','TCP and IPC servers accept independent clients.',sources.nodeNet),
        tcp:cell('built-in','TCP client and server APIs are built in.',sources.nodeNet),
        localEndpoint:cell('built-in','Unix sockets and Windows named pipes are documented.',sources.nodeNet),
        udp:cell('separate-core-module','Datagrams use node:dgram rather than node:net.',sources.nodeDgram),
        encryptedTransport:cell('separate-core-module','TLS uses node:tls over a stream.',sources.nodeTls),
        namedEvents:cell('manual','Framing and event dispatch are application-owned.',sources.nodeNet),
        requestReply:cell('manual','Framing and correlation are application-owned.',sources.nodeNet),
        broadcastPubSub:cell('manual','Applications track and fan out to sockets.',sources.nodeNet),
        automaticReconnect:cell('manual','Reconnect and retry policy are application-owned.',sources.nodeNet),
        queueingBackpressure:cell('built-in','write() and drain expose stream backpressure; queue limits and policy remain application-owned.',sources.nodeNet),
        browserClient:cell('unsupported','Raw TCP/local sockets are unavailable to browser JavaScript.',sources.nodeNet),
        crossLanguage:cell('manual','Peers can implement an application-defined stream protocol.',sources.nodeNet),
        handlePassing:cell('unsupported','Handle passing is provided by child_process, not net alone.',sources.nodeNet)
    },
    'node-ipc':{
        parentChild:cell('supported','The same client/server API works between related processes.',sources.nodeIpc),
        unrelatedProcesses:cell('supported','Local and network servers accept independent clients.',sources.nodeIpc),
        tcp:cell('supported','TCP client and server transports are built in.',sources.nodeIpc),
        localEndpoint:cell('supported','Unix sockets and Windows named pipes are built in.',sources.nodeIpc),
        udp:cell('supported','UDP4 and UDP6 server/client modes are built in.',sources.nodeIpc),
        encryptedTransport:cell('supported','TLS and Assured mutual TLS are configurable product capabilities; the benchmark Fast profile did not exercise encryption.',sources.nodeIpc),
        namedEvents:cell('supported','Event names are part of the public API.',sources.nodeIpc),
        requestReply:cell('manual','Applications correlate event payloads.',sources.nodeIpc),
        broadcastPubSub:cell('supported','Server broadcast is built in.',sources.nodeIpc),
        automaticReconnect:cell('supported','Stream clients have configurable retry intervals, retry limits, and a stop switch.',sources.nodeIpc),
        queueingBackpressure:cell('profile-dependent','Guarded and Assured bound pending stream bytes; the benchmark Fast profile writes directly. Sync mode can serialize requests.',sources.nodeIpc),
        browserClient:cell('unsupported','The package targets Node-style socket transports.',sources.nodeIpc),
        crossLanguage:cell('supported','Documented Node and Rust implementations share the protocol.',sources.nodeIpc),
        handlePassing:cell('unsupported','No public socket-handle transfer API.',sources.nodeIpc)
    },
    'ws':{
        parentChild:cell('supported','WebSocket works between any reachable peers.',sources.ws),
        unrelatedProcesses:cell('supported','Client and server can run independently.',sources.ws),
        tcp:cell('supported','WebSocket runs over HTTP/TCP.',sources.ws),
        localEndpoint:cell('supported','The documented ws+unix form supports IPC endpoints.',sources.wsIpc),
        udp:cell('unsupported','WebSocket is stream based.',sources.ws),
        encryptedTransport:cell('supported','WSS uses an HTTPS server.',sources.ws),
        namedEvents:cell('manual','Applications add an event envelope.',sources.ws),
        requestReply:cell('manual','Applications add correlation.',sources.ws),
        broadcastPubSub:cell('manual','The documented broadcast pattern loops over clients.',sources.ws),
        automaticReconnect:cell('manual','Reconnect policy is application-owned.',sources.ws),
        queueingBackpressure:cell('manual','bufferedAmount and send callbacks expose queue state, but applications own limits and policy.',sources.ws),
        browserClient:cell('protocol-compatible','Browsers provide a native WebSocket client.',sources.ws),
        crossLanguage:cell('supported','WebSocket is a standardized protocol.',sources.ws),
        handlePassing:cell('unsupported','No handle-transfer API.',sources.ws)
    },
    'socket-io':{
        parentChild:cell('supported','Socket.IO works between any reachable client and server.',sources.socketIo),
        unrelatedProcesses:cell('supported','Clients and servers are independently addressable.',sources.socketIo),
        tcp:cell('supported','HTTP long-polling and WebSocket provide TCP/IP lanes; WebTransport is also documented.',sources.socketIoTransports),
        localEndpoint:cell('unverified','Not claimed as a portable first-class endpoint in the cited docs.',sources.socketIo),
        udp:cell('unsupported','Socket.IO exposes no raw UDP datagram API; WebTransport is not a raw UDP lane.',sources.socketIoTransports),
        encryptedTransport:cell('supported','An HTTPS server supplies authenticated encryption when certificates and trust are configured.',sources.socketIoServerInitialization),
        namedEvents:cell('supported','Named events are the primary API.',sources.socketIoEvents),
        requestReply:cell('supported','Acknowledgements provide request/reply semantics.',sources.socketIoEvents),
        broadcastPubSub:cell('supported','Broadcasting and rooms are built in.',sources.socketIoRooms),
        automaticReconnect:cell('supported','The client exposes configurable reconnection, delay, and attempt settings.',sources.socketIoClientOptions),
        queueingBackpressure:cell('supported','The client buffers events while disconnected; this is in-memory buffering, not durable or exactly-once delivery.',sources.socketIoOffline),
        browserClient:cell('supported','The official client package targets browsers and Node.js.',sources.socketIoClientManifest),
        crossLanguage:cell('supported','The documented Socket.IO protocol has implementations in multiple languages.',sources.socketIoProtocol),
        handlePassing:cell('unsupported','No handle-transfer API is exposed by the documented protocol.',sources.socketIoProtocol)
    },
    'zeromq':{
        parentChild:cell('supported','Sockets work between any reachable peers; no parent-child-only channel is created.',sources.zeromqSocket),
        unrelatedProcesses:cell('supported','Message sockets bind and connect independently.',sources.zeromqSocket),
        tcp:cell('supported','TCP is a standard ZeroMQ transport.',sources.zeromqSocket),
        localEndpoint:cell('platform-limited','ipc:// depends on Unix-domain sockets and is not a Windows named-pipe transport.',sources.zeromqIpc),
        udp:cell('partial','UDP is an experimental draft transport limited to Radio/Dish sockets.',sources.zeromqUdp),
        encryptedTransport:cell('supported','CURVE authentication and encryption are available when configured; CURVE is not TLS.',sources.zeromqApi),
        namedEvents:cell('manual','Topics and socket patterns exist, but application event envelopes are manual.',sources.zeromqSocket),
        requestReply:cell('supported','REQ/REP and DEALER/ROUTER patterns are built in.',sources.zeromqSocket),
        broadcastPubSub:cell('supported','PUB/SUB is built in.',sources.zeromqSocket),
        automaticReconnect:cell('supported','Connection-oriented sockets expose reconnect interval controls.',sources.zeromqApi),
        queueingBackpressure:cell('supported','High-water marks bound in-memory queues; behavior can block or drop by socket type and is not durable delivery.',sources.zeromqSocket),
        browserClient:cell('unsupported-default','The default package is a native Node addon, not a browser client.',sources.zeromqManifest),
        crossLanguage:cell('supported','ZMTP is a documented wire protocol with implementations across languages.',sources.zeromqZmtp),
        handlePassing:cell('unsupported','No Node handle-transfer API is exposed.',sources.zeromqApi)
    }
};

export {
    asOf,
    definitions,
    matrix
};
