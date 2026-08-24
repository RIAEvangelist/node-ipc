const asOf='2026-08-23';
const popularityWindow={end:'2026-08-22',start:'2026-08-16'};

const catalog={
    'native-child-process':{
        label:'Node child_process IPC',
        packages:[],
        selectionReason:'Native parent-child IPC baseline from Node.js core'
    },
    'native-net':{
        label:'Node net',
        packages:[],
        selectionReason:'Native TCP and local socket capability from Node.js core'
    },
    'native-tls':{
        label:'Node tls',
        packages:[],
        selectionReason:'Native authenticated TLS stream baseline from Node.js core'
    },
    'node-ipc':{
        benchmarkProfile:'fast',
        benchmarkVersion:'14.0.0',
        label:'node-ipc 14.0.0',
        packages:[{
            downloadScope:'All public node-ipc versions on npm during the popularity window',
            downloads:813057,
            name:'node-ipc',
            note:'npm latest is 12.0.0 and the download count is package-wide, not version-specific. The benchmark measures the local 14.0.0 checkout with its default Fast profile.',
            npmLatestVersion:'12.0.0'
        }],
        selectionReason:'Subject under test at the canonical main checkout'
    },
    'socket-io':{
        label:'Socket.IO 4.8.3 stack',
        packages:[
            {downloads:17556158,name:'socket.io',version:'4.8.3'},
            {downloads:14063834,name:'socket.io-client',version:'4.8.3'}
        ],
        selectionReason:'Popular high-level event and acknowledgement stack'
    },
    'ws':{
        label:'ws 8.21.3',
        packages:[{downloads:259970655,name:'ws',version:'8.21.3'}],
        selectionReason:'Popular dependency-free WebSocket client/server module'
    },
    'zeromq':{
        label:'ZeroMQ.js 6.6.0',
        packages:[{downloads:641035,name:'zeromq',version:'6.6.0'}],
        selectionReason:'Popular purpose-built message-oriented IPC module'
    }
};

const sources={
    downloads:'https://api.npmjs.org/downloads/point/2026-08-16:2026-08-22/',
    downloadsNodeIpc:'https://api.npmjs.org/downloads/point/2026-08-16:2026-08-22/node-ipc',
    downloadsSocketIo:'https://api.npmjs.org/downloads/point/2026-08-16:2026-08-22/socket.io',
    downloadsSocketIoClient:'https://api.npmjs.org/downloads/point/2026-08-16:2026-08-22/socket.io-client',
    downloadsWs:'https://api.npmjs.org/downloads/point/2026-08-16:2026-08-22/ws',
    downloadsZeromq:'https://api.npmjs.org/downloads/point/2026-08-16:2026-08-22/zeromq',
    nodeChildProcess:'https://nodejs.org/download/release/v24.18.0/docs/api/child_process.html',
    nodeDgram:'https://nodejs.org/download/release/v24.18.0/docs/api/dgram.html',
    nodeNet:'https://nodejs.org/download/release/v24.18.0/docs/api/net.html',
    nodeTls:'https://nodejs.org/download/release/v24.18.0/docs/api/tls.html',
    nodeIpc:'https://github.com/RIAEvangelist/node-ipc/blob/9bdeca134d4b98ac4c3a819d06fa81fed8170be7/README.md',
    nodeIpcNpm:'https://registry.npmjs.org/node-ipc/12.0.0',
    socketIo:'https://socket.io/docs/v4/',
    socketIoClientOptions:'https://socket.io/docs/v4/client-options/',
    socketIoEvents:'https://socket.io/docs/v4/emitting-events/',
    socketIoEngineClient:'https://github.com/socketio/socket.io/blob/socket.io%404.8.3/packages/engine.io-client/lib/socket.ts',
    socketIoManifest:'https://github.com/socketio/socket.io/blob/socket.io%404.8.3/packages/socket.io/package.json',
    socketIoOffline:'https://socket.io/docs/v4/client-offline-behavior/',
    socketIoProtocol:'https://socket.io/docs/v4/socket-io-protocol/',
    socketIoRooms:'https://socket.io/docs/v4/rooms/',
    socketIoClientManifest:'https://github.com/socketio/socket.io/blob/socket.io-client%404.8.3/packages/socket.io-client/package.json',
    socketIoServerInitialization:'https://socket.io/docs/v4/server-initialization/',
    socketIoTransports:'https://socket.io/docs/v4/client-options/#transports',
    ws:'https://github.com/websockets/ws/blob/8.21.3/README.md',
    wsIpc:'https://github.com/websockets/ws/blob/8.21.3/doc/ws.md#ipc-connections',
    wsTls:'https://github.com/websockets/ws/blob/8.21.3/README.md#external-https-server',
    zeromq:'https://github.com/zeromq/zeromq.js/tree/v6.6.0',
    zeromqApi:'https://github.com/zeromq/zeromq.js/blob/v6.6.0/src/index.ts',
    zeromqCurve:'https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_curve.txt',
    zeromqIpc:'https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_ipc.txt',
    zeromqManifest:'https://github.com/zeromq/zeromq.js/blob/v6.6.0/package.json',
    zeromqSocket:'https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_socket.txt',
    zeromqUdp:'https://github.com/zeromq/libzmq/blob/v4.3.5/doc/zmq_udp.txt',
    zeromqZmtp:'https://rfc.zeromq.org/spec/23/'
};

export {
    asOf,
    catalog,
    popularityWindow,
    sources
};
