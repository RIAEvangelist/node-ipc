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
ipc.config.rawBuffer=true;
ipc.config.encoding='ascii';
ipc.config.networkHost='localhost';

// Replace these public, expired fixtures with a valid server identity and trusted client CA.
ipc.config.tls={
    public: serverCertificate,
    private: serverKey,
    dhparam: dhParameters,
    requestCert: true,
    rejectUnauthorized:true,
    trustedConnections: [
        clientCertificate
    ]
};

ipc.serveNet(
    function(){
        ipc.server.on(
            'connect',
            function(socket){
                console.log('connection detected');
                ipc.server.emit(
                    socket,
                    'hello'
                );
            }
        );

        ipc.server.on(
            'data',
            function(data,socket){
                ipc.log('got a message', data,data.toString());
                ipc.server.emit(
                    socket,
                    'goodbye'
                );
            }
        );
    }
);

ipc.server.start();
