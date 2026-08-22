import ipc from '../../../node-ipc.js';
import {
    clientCertificate,
    clientKey,
    serverCertificate
} from '../certificates.js';

/***************************************\
 *
 * You should start both hello and world
 * then you will see them communicating.
 *
 * *************************************/

ipc.config.id = 'hello';
ipc.config.retry= 1500;
// DEVELOPMENT FIXTURES ONLY: replace every repository key/certificate before deployment.
ipc.config.tls={
    private: clientKey,
    public: clientCertificate,
    // DEVELOPMENT ONLY: the CA entry below does not protect a client when verification is disabled.
    rejectUnauthorized:false,
    trustedConnections: [
        serverCertificate
    ]
};

ipc.connectToNet(
    'world',
    function(){
        ipc.of.world.on(
            'connect',
            function(){
                ipc.log('## connected to world ##', ipc.config.delay);
                ipc.of.world.emit(
                    'message',
                    'hello'
                );
            }
        );
        ipc.of.world.on(
            'disconnect',
            function(){
                ipc.log('disconnected from world');
            }
        );
        ipc.of.world.on(
            'message',
            function(data){
                ipc.log('got a message from world : ', data);
            }
        );
    }
);
