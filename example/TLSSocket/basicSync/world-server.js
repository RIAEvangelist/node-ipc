import ipc from '../../../node-ipc.js';
import {serverCertificate,serverKey} from '../certificates.js';

/***************************************\
 *
 * You should start both hello and world
 * then you will see them communicating.
 *
 * *************************************/

ipc.config.id = 'world';
ipc.config.retry= 1500;
ipc.config.sync= true;
// LOCAL DEVELOPMENT ONLY: these repository fixtures are public and expired.
ipc.config.tls={
    public: serverCertificate,
    private: serverKey
};

ipc.serveNet(
    function(){
        ipc.server.on(
            'message',
            function(data,socket){
                ipc.log('got a message : ', data);
                setTimeout(
                    function(){
                        ipc.server.emit(
                            socket,
                            'message',
                            data+' world!'
                        );
                    },
                    3000
                );
            }
        );

        ipc.server.on(
            'socket.disconnected',
            function(data,socket){
                console.log(arguments);
            }
        );
    }
);



ipc.server.start();
