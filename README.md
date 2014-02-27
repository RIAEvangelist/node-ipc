#node-ipc
*a nodejs module for local and remote Inter Process Communication*

**npm install node-ipc**

*this is a new project so more documentation will come*

----
#### Types of IPC Sockets

| Type      | Definition |
|-----------|------------|
|Unix Socket| Gives lightning fast communication and avoids the network card to reduce overhead and latency. [Local Unix Socket examples ](https://github.com/RIAEvangelist/node-ipc/tree/master/example/unixSocket/ "Unix Socket Node IPC examples")  |
|TCP Socket | Gives the most reliable communication across the network. Can be used for local IPC as well, but is slower than #1's Unix Socket Implementation because TCP sockets go through the network card while Unix Sockets do not. [Local or remote network TCP Socket examples ](https://github.com/RIAEvangelist/node-ipc/tree/master/example/TCPSocket/ "TCP Socket Node IPC examples") |
|TLS Socket | ***coming soon...*** |
|UDP Sockets| Gives the **fastest network communication**. UDP is less reliable but much faster than TCP. It is best used for streaming non critical data like sound, video, or multiplayer game data as it can drop packets depending on network connectivity and other factors. UDP can be used for local IPC as well, but is slower than #1's Unix Socket Implementation because UDP sockets go through the network card while Unix Sockets do not. [Local or remote network UDP Socket examples ](https://github.com/RIAEvangelist/node-ipc/tree/master/example/UDPSocket/ "UDP Socket Node IPC examples") |

----
### IPC Default Variables  

``ipc.config``  

Set these variables in the ``ipc.config`` scope to overwrite or set default values.

    {
        appspace        : 'app.',
        socketRoot      : '/tmp/',
        id              : os.hostname(),
        networkHost     : 'localhost',
        networkPort     : 8000,
        encoding        : 'utf8',
        silent          : false,
        maxConnections  : 100,
        retry           : 500
    }

| variable | documentation |
|----------|---------------|
| appspace | used for Unix Socket (Unix Domain Socket) namespacing. If not set specifically, the Unix Domain Socket will combine the socketRoot, appspace, and id to form the Unix Socket Path for creation or binding. This is available incase you have many apps running on your system, you may have several sockets with the same id, but if you change the appspace, you will still have app specic unique sockets.|
| socketRoot| the directory in which to create or bind to a Unix Socket |
| id       | the id of this socket or service |
| networkHost| the local or remote host on which TCP, TLS or UDP Sockets should connect |
| networkPort| the default port on which TCP, TLS, or UDP sockets should connect |
| encoding | the default encoding for data sent on sockets |
| silent   | turn on/off logging default is false which means logging is on |
| maxConnections| this is the max number of connections allowed to a socket. It is currently only being set on Unix Sockets. Other Socket types are using the system defaults. |
| retry    | this is the time in milliseconds a client will wait before trying to reconnect to a server if the connection is lost. This does not effect UDP sockets since they do not have a client server relationship like Unix Sockets and TCP Sockets. |

----

#### IPC Methods  
These methods are available in the IPC Scope.  

----
##### log

``ipc.log(a,b,c,d,e...);``  

ipc.log will accept any number of arguments and if ``ipc.config.silent`` is not set, it will concat them all with a sincle space ' ' between them and then log them to the console. This is fast because it prevents any concation from happening if the ipc is set to silent. That way if you leave your logging in place it should not effect performance.

the log also supports [colors](https://github.com/Marak/colors.js) implementation. All of the available styles are supported and the theme styles are as follows :

    {
        good    : 'green',
        notice  : 'yellow',
        warn    : 'red',
        error   : 'redBG',
        debug   : 'magenta',
        variable: 'cyan',
        data    : 'blue'
    }    

You can override any of these settings by requireing colors and setting the theme as follows :

    var colors=require('colors');
    
    colors.setTheme(
        {
            good    : 'zebra',
            notice  : 'redBG',
            ...
        }    
    );
----
##### connectTo

``ipc.connectTo(id,path,callback);``  

Used for connecting as a client to local Unix Sockets. ***This is the fastst way for processes on the same machine to communicate*** because it bypasses the network card which TCP and UDP must both use.


1. ``id`` ***required*** is the string id of the socket being connected to. The socket with this id is added to the ipc.of object when created.
2. ``path`` ***optional*** is the path of the Unix Domain Socket File, if not set this will be defaylted to ``ipc.config.socketRoot``+``ipc.config.appspace``+``id`` 
3. ``callback`` ***optional*** this is the function to execute when the socket has been created.

**examples**

    ipc.connectTo('world');
    
or using just an id and a callback
    
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

or explicitly setting the path

    ipc.connectTo(
        'world',
        'myapp.world'
    );
    
or explicitly setting the path with callback

    ipc.connectTo(
        'world',
        'myapp.world',
        function(){
            ...
        }
    );
----
##### connectToNet

``ipc.connectToNet(id,host,port,callback)``  

Used to connect as a client to a TCP or TLS socket via the network card. This can be local or remote, if local, it is recommended that you use the Unix Socket Implementaion of ``connectTo`` instead as it is much faster since it avoids the network card alltogether.

1. ``id`` ***required*** is the string id of the socket being connected to. For TCP & TLS sockets, this id is added to the ``ipc.of`` object when the socket is created with a refrence to the socket.
2. ``host`` ***optional*** is the host on which the TCP or TLS socket resides.  This will default to  ``ipc.config.networkHost`` if not specified.
3. ``port`` ***optional***
4. ``callback`` ***optional*** this is the function to execute when the socket has been created.

**examples** arguments can be ommitted solong as they are still in order.  
So while the default is : (id,host,port,callback), the following examples will still work because they are still in order (id,port,callback) or (id,host,callback) or (id,port) etc.

    ipc.connectToNet('world');
    
or using just an id and a callback
    
    ipc.connectToNet(
        'world',
        function(){
            ...
        }
    );

or explicitly setting the host and path

    ipc.connectToNet(
        'world',
        'myapp.com',serve(path,callback)
        3435
    );
    
or only explicitly setting port and callback

    ipc.connectToNet(
        'world',
        3435,
        function(){
            ...
        }
    );

----
##### serve

``ipc.serve(path,callback);``  

Used to create local Unix Socket Server to which Clients can bind. The server can ``emit`` events to specific Client Sockets, or ``broadcast`` events to all known Client Sockets.   

1. ``path`` ***optional*** This is the Unix Domain Socket path to bind to. If not supplied, it will default to : ipc.config.socketRoot + ipc.config.appspace + ipc.config.id;
2. ``callback`` ***optional*** This is a function to be called after the Server has started. This can also be done by binding an event to the start event as follows :

    ipc.server.on(
        'start',
        callback
    );

***examples***

    ipc.serve();

or specifying callback

    ipc.serve(
        function(){...}
    );
    
or specify path

    ipc.serve(
        '/tmp/myapp.myservice'
    );
    
or specifying everything

    ipc.serve(
        '/tmp/myapp.myservice',
        function(){...}
    );

----    
##### serveNet
coming soon ...
For TCP, TLS & UDP servers this is most likely going to be local host or 0.0.0.0 unless you have something like [node-http-server](https://github.com/RIAEvangelist/node-http-server) installed to run subdomains for you.

----
### Basic Examples  

#### Server for Unix Sockets & TCP Sockets 
The server is the process keeping a socket for IPC open. Multiple sockets can connect to this server and talk to it. It can also broadcast to all clients or emit to a specific client. This is the most basic example which will work for both local Unix Sockets and local or remote network TCP Sockets.

    var ipc=require('node-ipc');

    ipc.config.id   = 'world';
    ipc.config.retry= 1500;
    
    ipc.serve(
        function(){
            ipc.server.on(
                'message',
                function(data,socket){
                    ipc.log('got a message : '.debug, data);
                    socket.emit(
                        'message',
                        data+' world!'
                    );
                }
            );
        }
    );
    
    ipc.server.start();

#### Client for Unix Sockets & TCP Sockets 
The client connects to the servers socket for Inter Process Communication. The socket will recieve events emitted to it specifically as well as events which are broadcast out on the socket by the server. This is the most basic example which will work for both local Unix Sockets and local or remote network TCP Sockets.

    var ipc=require('../../../node-ipc');

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
                        'message',
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
                'message',
                function(data){
                    ipc.log('got a message from world : '.debug, data);
                }
            );
        }
    );
    
#### Server & Client for UDP Sockets 
UDP Sockets are different than Unix & TCP Sockets because they must be bound to a unique port on their machine to recieve messages. For example, A TCP or Unix Socket client could just connect to a seperate TCP or Unix Socket sever. That client could then exchange, both send and recive, data on the servers port or location. UDP Sockets can not do this. They must bind to a port to recieve or send data.  

This means a UDP Client and Server are the same thing because inorder to recieve data, a UDP Socket must have its own port to recieve data on, and only one process can use this port at a time. It also means that inorder to ``emit`` or ``broadcast`` data the UDP server will need to know the host and port of the Socket it intends to broadcast the data to.

This is the most basic example which will work for both local Unix Sockets and local or remote network TCP Sockets.

##### UDP Server 1 - "World" 

    var ipc=require('../../../node-ipc');

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
    
    ipc.server.define.listen.message='This event type listens for message strings as value of data key.';
    
    ipc.server.start();
    
##### UDP Server 2 - "Hello"
*note* we set the port here to 8001 because the world server is already using the default ipc.config.networkPort of 8000. So we can not bind to 8000 while world is using it.

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
                    address : 'localhost',
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
    
    ipc.server.define.listen.message='This event type listens for message strings as value of data key.';
    
    ipc.server.start();