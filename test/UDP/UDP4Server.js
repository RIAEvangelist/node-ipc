import ipc from '../../node-ipc.js';
import process from 'process';

const dieAfter = 120e3;
let timeout;

function exitServerProcess(code=0){
    clearTimeout(timeout);
    process.exit(code);
}

timeout=setTimeout(
    () => exitServerProcess(1),
    dieAfter
);

ipc.config.id = 'udp4Server';
ipc.config.retry= 1500;
ipc.config.silent=true;
ipc.config.networkPort=8095;

ipc.serveNet(
    '127.0.0.1',
    'udp4',
    function serverStarted(){
        ipc.server.on(
            'message',
            function gotMessage(data,socket){
                //console.log(data,socket)
                ipc.server.emit(
                    socket,
                    'message',
                    {
                        id      : ipc.config.id,
                        message : 'I am UDP4 server!'
                    }
                );
            }
        );

        ipc.server.on(
            'END',
            () => exitServerProcess(0)
        );

        if(process.send){
            process.send({type:'ready'});
        }
    }
);


ipc.server.start();
