[![node-ipc - local and remote inter-process communication for Node.js](https://raw.githubusercontent.com/RIAEvangelist/node-ipc/main/assets/node-ipc-header.png)](https://riaevangelist.github.io/node-ipc/)

# node-ipc

[![Sponsor RIAEvangelist to help development of node-ipc](https://img.shields.io/static/v1?label=Sponsor%20Me%20On%20Github&message=%E2%9D%A4&logo=GitHub&link=https://github.com/sponsors/RIAEvangelist)](https://github.com/sponsors/RIAEvangelist)

**Current official build: [node-ipc 13.0.0](https://www.npmjs.com/package/node-ipc/v/13.0.0)**

*a nodejs module for local and remote Inter Process Communication* with full support for Linux, Mac and Windows. It also supports all forms of socket communication from low level unix and windows sockets to UDP and secure TLS and TCP sockets.

A great solution for complex multiprocess **Neural Networking** in Node.JS

`npm install --save-exact node-ipc@13.0.0`

Use an exact, reviewed version. Do not use a mutable tag or version range for security-sensitive deployments.

#### Runtime

Version 13 requires Node.js 22.13.0 or newer. Version 12 remains the legacy Node release line.

`node-ipc` ships native ES modules only. Node.js loads the same entry point through `import` or synchronous `require()`; no transpiled CommonJS bundle is generated.

#### Runtime profiles

Version 13 selects its parser and hot-path handlers once, when each client or server is created. It does not poll a security flag for every message. Set the profile before calling `connect*()` or `serve*()`.

| Profile | Work on every message | Intended boundary |
|---------|-----------------------|-------------------|
| `raw` | No node-ipc framing, JSON parsing, or message checks. Buffers pass through the `data` event. | Trusted peers using a caller-owned binary or text protocol. |
| `fast` | JSON event-envelope encoding/decoding and delimiter framing. Malformed JSON becomes a protocol error; stream connections close. | Default for trusted local peers where the application owns payload validity. |
| `guarded` | Fast framing plus frame-size, stream pending-write, event-name, reserved/prototype-name, envelope, and incomplete-message-time controls. | Mixed-trust local services and authenticated network applications. |
| `assured` | Guarded controls plus a required event allow-list. Network use requires mutually authenticated TLS; each Unix local server endpoint must be a direct child of the secure socket root. Built-in Windows local service is rejected because node-ipc cannot prove its named-pipe ACL. | Hostile-network building block with verified peer certificates and application authorization; not a certification. |

```javascript
ipc.config.parser = 'guarded';
ipc.config.maxMessageSize = 1024 * 1024;
ipc.config.maxPendingBytes = 8 * 1024 * 1024;
```

See [Profiles](https://riaevangelist.github.io/node-ipc/profiles/), [Parsers](https://riaevangelist.github.io/node-ipc/parsers/), and [Security](https://riaevangelist.github.io/node-ipc/security/) before choosing a network-facing configuration.

#### Use

ESM: `import ipc from 'node-ipc';`

CommonJS: `const ipc = require('node-ipc').default;`

CommonJS loading uses Node.js 22.13+'s native [`require(esm)` support](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require).

#### NPM Stats

npm info :  [See npm trends and stats for node-ipc](http://npm-stat.com/charts.html?package=node-ipc&author=&from=&to=)   
[![NPM](https://nodei.co/npm/node-ipc.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/node-ipc/)
[![Package Quality](http://npm.packagequality.com/badge/node-ipc.png)](http://packagequality.com/#?package=node-ipc)  
![node-ipc npm version](https://img.shields.io/npm/v/node-ipc.svg) ![supported node version for node-ipc](https://img.shields.io/node/v/node-ipc.svg) ![total npm downloads for node-ipc](https://img.shields.io/npm/dt/node-ipc.svg) ![monthly npm downloads for node-ipc](https://img.shields.io/npm/dm/node-ipc.svg) ![npm licence for node-ipc](https://img.shields.io/npm/l/node-ipc.svg) 

GitHub info :  
![node-ipc GitHub Release](https://img.shields.io/github/release/RIAEvangelist/node-ipc.svg) ![GitHub license node-ipc license](https://img.shields.io/github/license/RIAEvangelist/node-ipc.svg) ![open issues for node-ipc on GitHub](https://img.shields.io/github/issues/RIAEvangelist/node-ipc.svg)

Code Coverage Info :  
Run `npm run coverage` to host a local version of the coverage report on [127.0.0.1:8080](http://127.0.0.1:8080).

Testing done with [vanilla-test](https://github.com/RIAEvangelist/vanilla-test)  
`vanilla-test` provides native V8 coverage for the ESM test suite without transpilation or bundling.

Package details websites :
* [GitHub.io site](https://riaevangelist.github.io/node-ipc/ "node-ipc documentation"). Engineer documentation and tracked evidence.
* [NPM Module](https://www.npmjs.org/package/node-ipc "node-ipc npm module"). The npm page for the node-ipc module.

This work is licenced via the MIT Licence.

#### Testing

`npm test` runs the Vanilla Test suite, native V8 coverage, both module loaders, and an installed-package smoke test. Reports are written to `coverage/node/`.

#### Performance evidence

![Tracked node-ipc profile benchmark chart](https://riaevangelist.github.io/node-ipc/assets/node-ipc-benchmark.svg)

The chart is generated from tracked, clean profile runs. Results stay separated by operating system, architecture, Node version, compiler, and commit; Assured remains pending until comparable mTLS evidence passes the same gates. See the [benchmark overview](https://riaevangelist.github.io/node-ipc/benchmarks/), [profile results](https://riaevangelist.github.io/node-ipc/benchmarks/profiles/), [resource results](https://riaevangelist.github.io/node-ipc/benchmarks/resources/), [methodology](https://riaevangelist.github.io/node-ipc/benchmarks/methodology/), and [run records](https://riaevangelist.github.io/node-ipc/benchmarks/runs/).

##### Version 12 versus current transport time

![Paired node-ipc v12.0.0 and current million-message transport timings on Linux, macOS, and Windows](https://riaevangelist.github.io/node-ipc/assets/node-ipc-transport-comparison.svg)

The paired CI snapshot reports median time for 1,000,000 completed messages through the native local transport, TCP, TLS, UDP4, and UDP6. Local IPC, TCP, and TLS use the Node byte reflector; official UDP4 and UDP6 evidence uses the standard-C exact-count reflector. Both versions use the same oracle within every pair, and C-oracle source, binary, compiler, flags, and target provenance are retained. TLS is an encryption-only throughput lane with peer verification disabled and its handshake outside timing. Results remain grouped by operating system and transport; they are not a cross-platform or cross-transport ranking. The hosted view remains Pending until a complete valid matrix passes every provenance, count, and cleanup gate. See the [transport comparison](https://riaevangelist.github.io/node-ipc/benchmarks/transports/) for exact timings, pending lanes, raw samples, and methodology.

----
#### Contents

1. [Types of IPC Sockets and Supporting OS](#types-of-ipc-sockets)
1. [IPC Config](#ipc-config)
2. [IPC Methods](#ipc-methods)
    1. [log](#log)
    2. [connectTo](#connectto)
    3. [connectToNet](#connecttonet)
    4. [disconnect](#disconnect)
    5. [serve](#serve)
    6. [serveNet](#servenet)
3. [IPC Stores and Default Variables](#ipc-stores-and-default-variables)
4. [IPC Events](#ipc-events)
5. [Multiple IPC instances](#multiple-ipc-instances)
6. [Basic Examples](#basic-examples)
    1. [Server for Unix||Windows Sockets & TCP Sockets](#server-for-unix-sockets-windows-sockets--tcp-sockets)
    2. [Client for Unix||Windows Sockets & TCP Sockets](#client-for-unix-sockets--tcp-sockets)
    4. [Server & Client for UDP Sockets](#server--client-for-udp-sockets)
    5. [Raw Buffers, Real Time and / or Binary Sockets](#raw-buffer-or-binary-sockets)
7. [Working with TLS/SSL Socket Servers & Clients](https://github.com/RIAEvangelist/node-ipc/tree/main/example/TLSSocket)
8. [Node Code Examples](https://github.com/RIAEvangelist/node-ipc/tree/main/example)


----
#### Types of IPC Sockets

| Type      | Stability |Definition |
|-----------|-----------|-----------|
|Unix socket or Windows named pipe| Stable    | Local IPC without the TCP/IP stack. Measure it against TCP on the target system rather than assuming a fixed latency difference. [Local Unix socket and Windows named-pipe examples](https://github.com/RIAEvangelist/node-ipc/tree/main/example/unixWindowsSocket/ "Unix socket and Windows named-pipe examples") |
|TCP Socket | Stable    | Reliable ordered byte streams for local loopback or remote networks. [Local or remote TCP examples](https://github.com/RIAEvangelist/node-ipc/tree/main/example/TCPSocket/ "TCP examples") |
|TLS Socket | Stable    | Encrypted network socket. It is secure only when certificate identities are verified; use mTLS or application authentication when clients must be identified. [TLS documentation](https://github.com/RIAEvangelist/node-ipc/tree/main/example/TLSSocket) |
|UDP Sockets| Stable    | Unordered datagrams for workloads that can own loss, duplication, reordering, and authentication. Compare measured latency and throughput on the target network before choosing it over TCP or local IPC. [Local or remote UDP examples](https://github.com/RIAEvangelist/node-ipc/tree/main/example/UDPSocket/ "UDP examples") |

| OS  | Supported Sockets  |
|-----|--------------------|
|Linux| Unix, Posix, TCP, TLS, UDP|
|Mac  | Unix, Posix, TCP, TLS, UDP|
|Win  | Windows, TCP, TLS, UDP      |  

----

#### IPC Config

`ipc.config`  

Set these variables in the `ipc.config` scope to overwrite or set default values.

```javascript

    {
        appspace        : 'app.',
        socketRoot      : '<secure per-user runtime directory>/',
        id              : os.hostname(),
        networkHost     : '127.0.0.1', //or ::1 when IPv6 is selected
        networkPort     : 8000,
        IPType          : '<detected IPv4 or IPv6>',
        tls             : false,
        readableAll     : false,
        writableAll     : false,
        secureSocketRoot: true,
        encoding        : 'utf8',
        rawBuffer       : false,
        parser          : 'fast',
        identifyPeer    : false,
        delimiter       : '\f',
        sync            : false,
        silent          : false,
        logInColor      : true,
        logDepth        : 5,
        logger          : console.log,
        logPayloads     : false,
        maxConnections  : 100,
        maxMessageSize  : 1024 * 1024,
        maxPendingBytes : 8 * 1024 * 1024,
        maxEventNameLength: 256,
        messageTimeout  : 30000,
        allowReservedEvents: false,
        allowedEvents   : false,
        retry           : 500,
        maxRetries      : Infinity,
        stopRetrying    : false,
        unlink          : true,
        interface       : {
            localAddress: false,
            localPort   : false,
            family      : false,
            hints       : false,
            lookup      : false
        }
    }

```

| variable | documentation |
|----------|---------------|
| appspace | used for Unix Socket (Unix Domain Socket) namespacing. If not set specifically, the Unix Domain Socket will combine the socketRoot, appspace, and id to form the Unix Socket Path for creation or binding. This is available in case you have many apps running on your system, you may have several sockets with the same id, but if you change the appspace, you will still have app specic unique sockets.|
| socketRoot| owner-only directory in which to create or bind a Unix Socket. On Unix the default is `$XDG_RUNTIME_DIR/node-ipc` when available, otherwise an owner-only `node-ipc-<uid>` directory below the OS temporary directory. Windows uses a per-user logical pipe prefix. The configured root is created and verified as owner-only by default. |
| id       | the id of this socket or service |
| networkHost| the local or remote host on which TCP, TLS or UDP Sockets should connect |
| networkPort| the default port on which TCP, TLS, or UDP sockets should connect |
| readableAll| makes the pipe readable for all users including windows services |
| writableAll| makes the pipe writable for all users including windows services |
| secureSocketRoot | create and verify an owner-only Unix socket root. Defaults to `true` and is required by Assured. For other profiles, disabling it transfers directory ownership and permission checks to the application. An Assured local server must bind directly inside that root and is Unix-only; clients must verify endpoint ownership. On Windows use Assured mutual TLS or an application-owned named-pipe ACL outside the built-in profile. |
| encoding | encoding for non-Buffer Raw writes. Built-in framed profiles use UTF-8 so both wire directions remain symmetric. Custom parsers should return a `Buffer` when they own another wire encoding. |
| rawBuffer| compatibility switch for the `raw` profile. When `true`, node-ipc performs no framing, JSON parsing, or message validation; incoming `Buffer` values are delivered through `data`. The caller owns the complete wire protocol and its security. |
| parser | parser profile or custom parser. Defaults to `fast`; accepts `raw`, `fast`, `guarded`, `assured`, a parser class, or a parser object. Selection happens once for each new client or server. |
| identifyPeer | legacy server behavior that copies a received payload's `data.id` onto the socket. Defaults to `false` so Fast does not inspect every payload. Selected once when the server is created; never treat this caller-supplied value as authenticated identity. |
| delimiter| frame terminator used by the `fast`, `guarded`, and `assured` profiles. |
| sync     | synchronous requests. Clients will not send new requests until the server answers. |
| silent   | turn on/off logging default is false which means logging is on |
| logInColor   | turn on/off util.inspect colors for ipc.log |
| logDepth   | set the depth for util.inspect during ipc.log |
| logger   | the function which receives the output from ipc.log; should take a single string argument |
| logPayloads | include application payloads in automatic transport logs. Defaults to `false`. Do not pass keys, passphrases, tokens, or other secrets to `ipc.log`; application-supplied log values are not redacted. |
| maxConnections| maximum number of concurrent connections accepted by a stream socket. Defaults to 100. |
| maxMessageSize | `guarded` and `assured` maximum framed-message size in bytes. Defaults to 1 MiB. Fast and Raw do not read this option. |
| maxPendingBytes | `guarded` and `assured` maximum bytes queued for a stream socket write. Defaults to 8 MiB; exceeding it closes that connection. Fast and Raw write directly. |
| maxEventNameLength | `guarded` and `assured` maximum accepted wire event-name length. Defaults to 256 characters. |
| messageTimeout | `guarded` and `assured` time allowed for an incomplete stream frame. Defaults to 30000 ms; set to `0` to disable the timer. |
| allowReservedEvents | `guarded` compatibility escape hatch for lifecycle names. Defaults to `false`. Assured always rejects reserved names. |
| allowedEvents | required non-empty `Array` or `Set` of event names for `assured`. The allow-list applies to sent and received events. Defaults to `false` for the other profiles. |
| retry    | this is the time in milliseconds a client will wait before trying to reconnect to a server if the connection is lost. This does not effect UDP sockets since they do not have a client server relationship like Unix Sockets and TCP Sockets. |
| maxRetries    | if set, it represents the maximum number of retries after each disconnect before giving up and completely killing a specific connection |
| stopRetrying| Boolean switch. `true` stops scheduled and future reconnect attempts; `false` permits retries up to `maxRetries`. Set `maxRetries` to `0` to disable reconnects. |
| unlink| Defaults to true meaning that the module will take care of deleting the IPC socket prior to startup.  If you use `node-ipc` in a clustered environment where there will be multiple listeners on the same socket, you must set this to `false` and then take care of deleting the socket in your own code. |
| interface| primarily used when specifying which interface a client should connect through. see the [socket.connect documentation in the node.js api](https://nodejs.org/api/net.html#net_socket_connect_options_connectlistener) |
| IPType | detected IP family used to choose the initial loopback host. |
| tls | TLS options object or `false`. Assured network clients require a key, certificate, trusted CA, and `rejectUnauthorized:true`; servers also require a trusted client CA, `requestCert:true`, and `rejectUnauthorized:true`. |

Security boundaries:

- `fast` is the default because the trusted hot path stays direct. It contains malformed JSON, but it does not enforce message size, event-name, reserved-name, timeout, allow-list, or pending-write limits. Use `guarded` or `assured` when peers are not fully trusted.
- Parser controls validate the event envelope, not the application payload. Validate payload type, shape, identity, authorization, and replay rules in the application.
- TCP and UDP provide neither authentication nor confidentiality. Any service bound beyond loopback must authenticate and authorize messages at the application layer, or use mutually authenticated TLS. Server-authenticated TLS alone does not identify clients.
- TLS servers must supply an explicit `key` and `cert`, or the existing `private` and `public` file-path aliases. There is no bundled certificate fallback. Keep private keys outside the package and source tree.
- `rejectUnauthorized: false` disables certificate identity verification and is vulnerable to man-in-the-middle attacks. Use it only for isolated local development, never on an external or untrusted network.
- Unix socket permissions are a boundary, not message authentication. Keep the default owner-only socket root or provide an equally restricted directory; do not place privileged sockets directly in a shared temporary directory.

The official `node-ipc/parsers/message` export keeps `js-message` ecosystem compatibility as an explicit opt-in parser. It maps malformed envelopes to an `error` message and is not a hardened decoder. Use Guarded or Assured for node-ipc protocol controls, or provide a custom parser that implements your required policy.

For the complete upgrade contract, see [MIGRATION.md](./MIGRATION.md).

----

#### IPC Methods  
These methods are available in the IPC Scope.  

----
##### log

`ipc.log(a,b,c,d,e...);`  

ipc.log will accept any number of arguments and if `ipc.config.silent` is not set, it will concat them all with a single space ' ' between them and then log them to the console. This is fast because it prevents any concatenation from happening if the ipc.config.silent is set ` true `. That way if you leave your logging in place it should have almost no effect on performance.

The log also uses util.inspect You can control if it should log in color, the log depth, and the destination via ` ipc.config `

```javascript

    ipc.config.logInColor=true; //default
    ipc.config.logDepth=5; //default    
    ipc.config.logger=console.log.bind(console); // default

```

----
##### connectTo

`ipc.connectTo(id,path,callback);`  

Used for connecting as a client to local Unix sockets and Windows named pipes. This avoids IP framing and routing, but the fastest same-machine transport depends on the operating system, workload, and message shape, so compare it with loopback TCP on the target system.

| variable | required | definition |
|----------|----------|------------|
| id       | required |  is the string id of the socket being connected to. The socket with this id is added to the ipc.of object when created. |
| path     | optional | is the path of the Unix Domain Socket File, if the System is Windows, this will automatically be converted to an appropriate pipe with the same information as the Unix Domain Socket File. If not set this will default to ` ipc.config.socketRoot `+` ipc.config.appspace `+` id ` |
| callback | optional | this is the function to execute when the socket has been created. |

**examples** arguments can be ommitted so long as they are still in order.

```javascript

    ipc.connectTo('world');

```

or using just an id and a callback

```javascript

    ipc.connectTo(
        'world',
        function(){
            ipc.of.world.on(
                'hello',
                function(data){
                    ipc.log(data.debug);
                    //if data was a string, it would have the color set to the debug style applied to it
                }
            )
        }
    );

```

or explicitly setting the path

```javascript

    ipc.connectTo(
        'world',
        'myapp.world'
    );

```

or explicitly setting the path with callback

```javascript

    ipc.connectTo(
        'world',
        'myapp.world',
        function(){
            ...
        }
    );

```

----
##### connectToNet

`ipc.connectToNet(id,host,port,callback)`  

Used to connect as a client to a TCP or [TLS socket](https://github.com/RIAEvangelist/node-ipc/tree/main/example/TLSSocket) over loopback or a remote IP network. For same-machine peers, compare this path with `connectTo`; the better choice depends on the target system and workload.

For TLS and SSL Sockets see the [node-ipc TLS and SSL docs](https://github.com/RIAEvangelist/node-ipc/tree/main/example/TLSSocket). They have a few additional requirements, and things to know about and so have their own doc.

| variable | required | definition |
|----------|----------|------------|
| id       | required | is the string id of the socket being connected to. For TCP & TLS sockets, this id is added to the `ipc.of` object when the socket is created with a reference to the socket. |
| host     | optional | is the host on which the TCP or TLS socket resides.  This will default to  `ipc.config.networkHost` if not specified. |
| port     | optional | the port on which the TCP or TLS socket resides. |
| callback | optional | this is the function to execute when the socket has been created. |

**examples** arguments can be ommitted so long as they are still in order.  
So while the default is : (id,host,port,callback), the following examples will still work because they are still in order (id,port,callback) or (id,host,callback) or (id,port) etc.

```javascript

    ipc.connectToNet('world');

```

or using just an id and a callback

```javascript

    ipc.connectToNet(
        'world',
        function(){
            ...
        }
    );

```

or explicitly setting the host and path

```javascript

    ipc.connectToNet(
        'world',
        'myapp.com',serve(path,callback)
        3435
    );

```

or only explicitly setting port and callback

```javascript

    ipc.connectToNet(
        'world',
        3435,
        function(){
            ...
        }
    );

```

----
##### disconnect

`ipc.disconnect(id)`  

Used to disconnect a client from a Unix, Windows, TCP or TLS socket. The socket and its refrence will be removed from memory and the `ipc.of` scope. This can be local or remote. UDP clients do not maintain connections and so there are no Clients and this method has no value to them.

| variable | required | definition |
|----------|----------|------------|
| id       | required | is the string id of the socket from which to disconnect. |

**examples**

```javascript

    ipc.disconnect('world');

```

----
##### serve
`ipc.serve(path,callback);`  

Used to create local Unix Socket Server or Windows Socket Server to which Clients can bind. The server can `emit` events to specific Client Sockets, or `broadcast` events to all known Client Sockets.   

| variable | required | definition |
|----------|----------|------------|
| path     | optional | This  is the path of the Unix Domain Socket File, if the System is Windows, this will automatically be converted to an appropriate pipe with the same information as the Unix Domain Socket File. If not set this will default to ` ipc.config.socketRoot `+` ipc.config.appspace `+` id ` |
| callback | optional | This is a function to be called after the Server has started. This can also be done by binding an event to the start event like `ipc.server.on('start',function(){});` |

***examples*** arguments can be omitted so long as they are still in order.

```javascript

    ipc.serve();

```

or specifying callback

```javascript

    ipc.serve(
        function(){...}
    );

```

or specify path

```javascript

    ipc.serve(
        ipc.config.socketRoot+'myapp.myservice'
    );

```

or specifying everything

```javascript

    ipc.serve(
        ipc.config.socketRoot+'myapp.myservice',
        function(){...}
    );

```

----    
##### serveNet

`serveNet(host,port,UDPType,callback)`

Used to create TCP, TLS or UDP Socket Server to which Clients can bind or other servers can send data to. The server can `emit` events to specific Client Sockets, or `broadcast` events to all known Client Sockets.

Binding to a non-loopback interface exposes the service to the network. Use application authentication and authorization for TCP/UDP, or mutually authenticated TLS when both peers must have cryptographic identities.


| variable | required | definition |
|----------|----------|------------|
| host     | optional | If not specified this defaults to `ipc.config.networkHost`, which is loopback (`127.0.0.1` or `::1`). An explicit non-loopback host creates an external network boundary. |
| port     | optional | The port on which the TCP, UDP, or TLS Socket server will be bound, this defaults to 8000 if not specified |
| UDPType  | optional | If set this will create the server as a UDP socket. 'udp4' or 'udp6' are valid values. This defaults to not being set. When using udp6 make sure to specify a valid IPv6 host, like ` ::1 ` |
| callback | optional | Function to be called when the server is created |

***examples*** arguments can be ommitted solong as they are still in order.

default tcp server

```javascript

    ipc.serveNet();

```

default udp server

```javascript

    ipc.serveNet('udp4');

```

or specifying TCP server with callback

```javascript

    ipc.serveNet(
        function(){...}
    );

```

or specifying UDP server with callback

```javascript

    ipc.serveNet(
        'udp4',
        function(){...}
    );

```

or specify port

```javascript

    ipc.serveNet(
        3435
    );

```

or specifying everything TCP

```javascript

    ipc.serveNet(
        'MyMostAwesomeApp.com',
        3435,
        function(){...}
    );

```

or specifying everything UDP

```javascript

    ipc.serveNet(
        'MyMostAwesomeApp.com',
        3435,
        'udp4',
        function(){...}
    );

```

----
### IPC Stores and Default Variables  

| variable  | definition |
|-----------|------------|
| ipc.of    | This is where socket connection refrences will be stored when connecting to them as a client via the `ipc.connectTo` or `iupc.connectToNet`. They will be stored based on the ID used to create them, eg : ipc.of.mySocket|
| ipc.server| This is a refrence to the server created by `ipc.serve` or `ipc.serveNet`|

----
### IPC Server Methods  

| method  | definition |
|-----------|------------|
|start| start serving need to call ` serve ` or ` serveNet ` first to set up the server |
|stop| close the server and stop serving |

----

### IPC Events  

|event name|params|definition|
|----------|------|----------|
|error|err obj|triggered when an error has occured|
|connect||triggered when socket connected|
|disconnect||triggered by client when socket has disconnected from server|
|socket.disconnected|socket destroyedSocketID|triggered by server when a client socket has disconnected|
|destroy||triggered when socket has been totally destroyed, no further auto retries will happen and all references are gone.|
|data|buffer|triggered when ipc.config.rawBuffer is true and a message is received.|
|***your event type***|***your event data***|triggered when a JSON message is received. The event name will be the type string from your message and the param will be the data object from your message eg : ` { type:'myEvent',data:{a:1}} ` |

The Guarded and Assured profiles reject the lifecycle names `start`, `connect`, `disconnect`, `destroy`, `close`, `socket.disconnected`, `error`, and `data`, plus names inherited from `Object.prototype`. Guarded can restore lifecycle-name compatibility with `ipc.config.allowReservedEvents=true`; Assured cannot. The default Fast profile does not perform either name check, so use it only with trusted peers.

### Multiple IPC Instances

Sometimes you might need explicit and independent instances of node-ipc. Just for such scenarios we have exposed the core IPC class on the IPC singleton.

```javascript

    import {IPCModule} from 'node-ipc';

    const ipc=new IPCModule;
    const someOtherExplicitIPC=new IPCModule;


    //setting explicit configs

    //keep one silent and the other verbose
    ipc.config.silent=true;
    someOtherExplicitIPC.config.silent=true;

    //make one a raw binary and the other json based ipc
    ipc.config.rawBuffer=false;

    someOtherExplicitIPC.config.rawBuffer=true;
    someOtherExplicitIPC.config.encoding='hex';

```


----
### Basic Examples
You can find [Advanced Examples](https://github.com/RIAEvangelist/node-ipc/tree/main/example) in the examples folder. In the examples you will find more complex demos including multi client examples.

#### Server for Unix Sockets, Windows Sockets & TCP Sockets
The server is the process keeping a socket for IPC open. Multiple sockets can connect to this server and talk to it. It can also broadcast to all clients or emit to a specific client. This is the most basic example which will work for local Unix and Windows Sockets as well as local or remote network TCP Sockets.

```javascript

    import ipc from 'node-ipc';

    ipc.config.id   = 'world';
    ipc.config.retry= 1500;

    ipc.serve(
        function(){
            ipc.server.on(
                'message',
                function(data,socket){
                    ipc.log('got a message : '.debug, data);
                    ipc.server.emit(
                        socket,
                        'message',  //this can be anything you want so long as
                                    //your client knows.
                        data+' world!'
                    );
                }
            );
			ipc.server.on(
				'socket.disconnected',
				function(socket, destroyedSocketID) {
					ipc.log('client ' + destroyedSocketID + ' has disconnected!');
				}
			);
        }
    );

    ipc.server.start();

```

#### Client for Unix Sockets & TCP Sockets
The client connects to the servers socket for Inter Process Communication. The socket will receive events emitted to it specifically as well as events which are broadcast out on the socket by the server. This is the most basic example which will work for both local Unix Sockets and local or remote network TCP Sockets.

```javascript

    import ipc from 'node-ipc';

    ipc.config.id   = 'hello';
    ipc.config.retry= 1500;

    ipc.connectTo(
        'world',
        function(){
            ipc.of.world.on(
                'connect',
                function(){
                    ipc.log('## connected to world ##'.rainbow, ipc.config.delay);
                    ipc.of.world.emit(
                        'message',  //any event or message type your server listens for
                        'hello'
                    )
                }
            );
            ipc.of.world.on(
                'disconnect',
                function(){
                    ipc.log('disconnected from world'.notice);
                }
            );
            ipc.of.world.on(
                'message',  //any event or message type your server listens for
                function(data){
                    ipc.log('got a message from world : '.debug, data);
                }
            );
        }
    );

```

#### Server & Client for UDP Sockets
UDP Sockets are different than Unix, Windows & TCP Sockets because they must be bound to a unique port on their machine to receive messages. For example, A TCP, Unix, or Windows Socket client could just connect to a separate TCP, Unix, or Windows Socket sever. That client could then exchange, both send and receive, data on the servers port or location. UDP Sockets can not do this. They must bind to a port to receive or send data.  

This means a UDP Client and Server are the same thing because in order to receive data, a UDP Socket must have its own port to receive data on, and only one process can use this port at a time. It also means that in order to `emit` or `broadcast` data the UDP server will need to know the host and port of the Socket it intends to broadcast the data to.

This is the most basic example which will work for both local and remote UDP Sockets.

##### UDP Server 1 - "World"

```javascript

    import ipc from 'node-ipc';

    ipc.config.id   = 'world';
    ipc.config.retry= 1500;

    ipc.serveNet(
        'udp4',
        function(){
            console.log(123);
            ipc.server.on(
                'message',
                function(data,socket){
                    ipc.log('got a message from '.debug, data.from.variable ,' : '.debug, data.message.variable);
                    ipc.server.emit(
                        socket,
                        'message',
                        {
                            from    : ipc.config.id,
                            message : data.message+' world!'
                        }
                    );
                }
            );

            console.log(ipc.server);
        }
    );

    ipc.server.start();

```

##### UDP Server 2 - "Hello"
*note* we set the port here to 8001 because the world server is already using the default ipc.config.networkPort of 8000. So we can not bind to 8000 while world is using it.

```javascript

    ipc.config.id   = 'hello';
    ipc.config.retry= 1500;

    ipc.serveNet(
        8001,
        'udp4',
        function(){
            ipc.server.on(
                'message',
                function(data){
                    ipc.log('got Data');
                    ipc.log('got a message from '.debug, data.from.variable ,' : '.debug, data.message.variable);
                }
            );
            ipc.server.emit(
                {
                    address : '127.0.0.1', //any hostname will work
                    port    : ipc.config.networkPort
                },
                'message',
                {
                    from    : ipc.config.id,
                    message : 'Hello'
                }
            );
        }
    );

    ipc.server.start();

```

#### Raw Buffer or Binary Sockets
Binary or Buffer sockets can be used with any of the above socket types, however the way data events are emit is ***slightly*** different. These may come in handy if working with embedded systems or C / C++ processes. You can even make sure to match C or C++ string typing.

When setting up a rawBuffer socket you must specify it as such :

```javascript

    ipc.config.rawBuffer=true;

```

You can also specify its encoding type. The default is ` utf8 `

```javascript

    ipc.config.encoding='utf8';

```

emit string buffer :

```javascript

    //server
    ipc.server.emit(
        socket,
        'hello'
    );

    //client
    ipc.of.world.emit(
        'hello'
    )

```

emit byte array buffer :

```javascript

    //hex encoding may work best for this.
    ipc.config.encoding='hex';

    //server
    ipc.server.emit(
        socket,
        [10,20,30]
    );

    //client
    ipc.server.emit(
        [10,20,30]
    );

```

emit binary or hex array buffer, this is best for real time data transfer, especially whan connecting to C or C++ processes, or embedded systems :

```javascript

    ipc.config.encoding='hex';

    //server
    ipc.server.emit(
        socket,
        [0x05,0x6d,0x5c]
    );

    //client
    ipc.server.emit(
        [0x05,0x6d,0x5c]
    );

```

Writing explicit buffers, int types, doubles, floats etc. as well as big endian and little endian data to raw buffer nostly valuable when connecting to C or C++ processes, or embedded systems (see more detailed info on buffers as well as UInt, Int, double etc. here)[https://nodejs.org/api/buffer.html]:

```javascript

    ipc.config.encoding='hex';

    //make a 6 byte buffer for example
    const myBuffer=Buffer.alloc(6).fill(0);

    //fill the first 2 bytes with a 16 bit (2 byte) short unsigned int

    //write a UInt16 (2 byte or short) as Big Endian
    myBuffer.writeUInt16BE(
        2, //value to write
        0 //offset in bytes
    );
    //OR
    myBuffer.writeUInt16LE(0x2,0);
    //OR
    myBuffer.writeUInt16LE(0x02,0);

    //fill the remaining 4 bytes with a 32 bit (4 byte) long unsigned int

    //write a UInt32 (4 byte or long) as Big Endian
    myBuffer.writeUInt32BE(
        16772812, //value to write
        2 //offset in bytes
    );
    //OR
    myBuffer.writeUInt32BE(0xffeecc,0)

    //server
    ipc.server.emit(
        socket,
        myBuffer
    );

    //client
    ipc.server.emit(
        myBuffer
    );

```

#### Server with the `cluster` Module
`node-ipc` can be used with Node.js' [cluster module](https://nodejs.org/api/cluster.html) to provide the ability to have multiple readers for a single socket.  Doing so simply requires you to set the `unlink` property in the config to `false` and take care of unlinking the socket path in the master process:

##### Server

```javascript

    import fs  from 'fs';
    import ipc from 'node-ipc';
    import {cpus}  from 'os';
    import cluster  from 'cluster';
    
    const cpuCount=cpus().length;

    const socketPath=ipc.config.socketRoot+'ipc.sock';

    ipc.config.unlink = false;

    if (cluster.isMaster) {
       if (fs.existsSync(socketPath)) {
           fs.unlinkSync(socketPath);
       }

       for (let i = 0; i < cpuCount; i++) {
           cluster.fork();
       }
    }else{
       ipc.serve(
         socketPath,
         function() {
           ipc.server.on(
             'currentDate',
             function(data,socket) {
               console.log(`pid ${process.pid} got: `, data);
             }
           );
         }
      );

      ipc.server.start();
      console.log(`pid ${process.pid} listening on ${socketPath}`);
    }

```

##### Client

```javascript

    import fs  from 'fs';
    import ipc  from 'node-ipc';

    const socketPath = ipc.config.socketRoot+'ipc.sock';

    //loop forever so you can see the pid of the cluster sever change in the logs
    setInterval(
      function() {
        ipc.connectTo(
          'world',
          socketPath,
          connecting
         );
      },
      2000
    );

    function connecting(socket) {
      ipc.of.world.on(
        'connect',
        function() {
          ipc.of.world.emit(
            'currentDate',
            {
                 message: new Date().toISOString()
            }
          );
          ipc.disconnect('world');
        }
      );
    }

```

#### Licensed under MIT license
See the [MIT license](https://github.com/RIAEvangelist/node-ipc/blob/main/license) file.

I'm sorry.
