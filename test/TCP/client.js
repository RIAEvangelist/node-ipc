import VanillaTest from 'vanilla-test';
import Is from 'strong-type';
import {IPCModule}   from '../../node-ipc.js';
import delay from '../../helpers/delay.js';

async function run(){

    const test=new VanillaTest;
    const is=new Is;

    const cleanup=function(){
        test.pass();
        test.done();
    }

    const fail=function(err){
        console.trace(err)
        test.fail();
    }

    var transmit_delay = 1000;

    let retryingClient;
    try{
        test.expects(
            'TCP client to connection attempts to be limited by the "maxRetries" parameter.'
        );
        
        const ipc=retryingClient=new IPCModule;

        ipc.config.id ='testClient';
        ipc.config.retry = 60;
        ipc.config.maxRetries = 3;
        ipc.config.stopRetrying = false;
        ipc.config.silent=true;

        //set to -1 because there is an error on the first fail
        //before retrying
        let errorCount=-1;

        ipc.connectToNet(
            'tcpFakeServer',
            8002,
            function open(){
                
            }
        );

        ipc.of.tcpFakeServer.on(
            'error',
            function gotError(err){
                errorCount++;
                is.defined(err);
            }
        );

        await delay(ipc.config.retry*ipc.config.maxRetries + transmit_delay);
        
        test.compare(errorCount,ipc.config.maxRetries);

    }catch(err){
        fail(err);
    }finally{
        if(retryingClient){
            retryingClient.config.stopRetrying=true;
            retryingClient.disconnect('tcpFakeServer');
        }
    }
    cleanup();




    let stoppedClient;
    try{
        test.expects(
            'TCP client not to try to reconnect when "stopRetrying" is set to true.'
        );
        
        const ipc=stoppedClient=new IPCModule;
        ipc.config.maxRetries = 3;
        ipc.config.stopRetrying = true;
        ipc.silent=true;

        //set to -1 because there is an error on the first fail
        //before retrying
        let errorCount=-1;

        ipc.connectToNet(
            'tcpFakeServer',
            8002,
            function open(){
                
            }
        );

        ipc.of.tcpFakeServer.on(
            'error',
            function gotError(err){
                is.defined(err);
                errorCount++;
            }
        );

        await delay(ipc.config.retry*ipc.config.maxRetries + transmit_delay);

        test.compare(errorCount,0);
        test.compare(ipc.of.tcpFakeServer.retriesRemaining,ipc.config.maxRetries);

    }catch(err){
        fail(err);
    }finally{
        stoppedClient?.disconnect('tcpFakeServer');
    }
    cleanup();




    let connectedClient;
    try{
        test.expects(
            'TCP client to connect to server named "tcpServer" and receive a message.'
        );
        
        const ipc=connectedClient=new IPCModule;
        
        ipc.config.maxRetries = 3;
        ipc.config.stopRetrying = true;
        ipc.silent=true;

        let data={};

        ipc.connectToNet(
            'tcpServer',
            8300,
            function open(){
                ipc.of.tcpServer.on(
                    'connect',
                    function connected(){
                        ipc.of.tcpServer.emit(
                            'message',
                            {
                                id      : ipc.config.id,
                                message : 'Hello from testClient.'
                            }
                        );

                        console.log('client sent message');
                    }
                );

                ipc.of.tcpServer.on(
                    'message',
                    function gotMessage(message){
                        data=message;
                        console.log('client got message');
                    }
                );
            }
        );
        
        ipc.of.tcpServer.on(
            'error',
            function gotError(err){
                fail(err);
            }
        );

        await delay(ipc.config.retry*ipc.config.maxRetries + transmit_delay);


        console.log(data)

        test.compare(data.id,'tcpServer');
        test.compare(data.message,'I am TCP server!');
        
    }catch(err){
        fail(err);
    }finally{
        if(connectedClient?.of.tcpServer){
            if(!connectedClient.of.tcpServer.socket?.destroyed){
                connectedClient.of.tcpServer.emit('END');
            }
            connectedClient.disconnect('tcpServer');
        }
    }
    cleanup();

    return test.report();
}

export {
    run as default,
    run
}
