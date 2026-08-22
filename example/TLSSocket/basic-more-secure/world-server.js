import ipc from '../../../node-ipc.js';
import {
    clientCertificate,
    dhParameters,
    serverCertificate,
    serverKey
} from '../certificates.js';

/***************************************\
 *
 * You should start both hello and world
 * then you will see them communicating.
 *
 * *************************************/

ipc.config.id = 'world';
ipc.config.retry= 1500;
// DEVELOPMENT FIXTURES ONLY: replace every repository key/certificate before deployment.
ipc.config.tls={
    public: serverCertificate,
    private: serverKey,
    dhparam: dhParameters,
    requestCert: true,
    // DEVELOPMENT ONLY: this accepts clients whose certificates cannot be verified.
    rejectUnauthorized:false,
    trustedConnections: [
        clientCertificate
    ]
};

ipc.serveNet(
    function(){
        ipc.server.on(
            'message',
            function(data,socket){
                ipc.log('got a message : ', data);
                ipc.server.emit(
                    socket,
                    'message',
                    data+' world!'
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
