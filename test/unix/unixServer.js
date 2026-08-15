import ipc from '../../node-ipc.js';
import process from 'process';

const dieAfter=120e3;
let timeout;

function exitServerProcess(code=0){
    clearTimeout(timeout);
    process.exit(code);
}

timeout=setTimeout(
    () => exitServerProcess(1),
    dieAfter
);

ipc.config.id = 'unixServer';
ipc.config.retry= 1500;
ipc.config.silent=false;
if(process.env.NODE_IPC_TEST_SOCKET_ROOT){
    ipc.config.socketRoot=process.env.NODE_IPC_TEST_SOCKET_ROOT;
}

ipc.serve(
    function serverStarted(){
        ipc.server.on(
            'message',
            function gotMessage(data,socket){
                ipc.server.emit(
                    socket,
                    'message',
                    {
                        id      : ipc.config.id,
                        message : 'I am unix server!'
                    }
                );
            }
        );

        if(process.send){
            process.send({type:'ready'});
        }
    }
);

ipc.server.on(
    'END',
    () => exitServerProcess(0)
);

ipc.server.start();
