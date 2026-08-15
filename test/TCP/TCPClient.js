import ipc from '../../node-ipc.js';
import process from 'process';

const dieAfter = 120e3;
let timeout;

function exitClientProcess(code=0){
    clearTimeout(timeout);
    process.exit(code);
}


timeout=setTimeout(
    () => exitClientProcess(1),
    dieAfter
);

ipc.config.id = 'tcpClient';
ipc.config.retry= 600;
ipc.config.silent=true;
ipc.config.networkPort=8500;


ipc.connectToNet(
    'testWorld',
    function(){
        ipc.of.testWorld.on(
            'connect',
            function(){
                ipc.of.testWorld.emit(
                    'message',
                    'hello'
                );
            }
        );

        ipc.of.testWorld.on(
            'END',
            () => exitClientProcess(0)
        )
    }
);

if(process.send){
    process.send({type:'ready'});
}

export {
    dieAfter as default,
    dieAfter
}
