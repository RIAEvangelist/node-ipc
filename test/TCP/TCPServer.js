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

ipc.config.id = 'tcpServer';
ipc.config.retry= 1500;
ipc.config.networkPort=8300;
ipc.config.silent=true;

ipc.serveNet(
    function serverStarted(){
        ipc.server.on(
            'message',
            function gotMessage(data,socket){
                console.log('Server recieved message',data);

                ipc.server.emit(
                    socket,
                    'message',
                    {
                        id      : ipc.config.id,
                        message : 'I am TCP server!'
                    }
                );
                console.log('server emitted data')
            }
        );

        ipc.server.on(
            'END',
            () => exitServerProcess(0)
        );

        console.log('TCP server up');
        if(process.send){
            process.send({type:'ready'});
        }
    }
);

ipc.server.start();

export {
    exitServerProcess as default,
    exitServerProcess
}
