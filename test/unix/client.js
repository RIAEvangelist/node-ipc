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

    let unixClient;
    try{
        test.expects(
            'unix client to connect to "unixServer" and receive a message.'
        );
        
        const ipc=unixClient=new IPCModule;

        if(process.env.NODE_IPC_TEST_SOCKET_ROOT){
            ipc.config.socketRoot=process.env.NODE_IPC_TEST_SOCKET_ROOT;
        }
        
        ipc.config.id ='testClient';
        ipc.config.retry = 900;

        let serverID='';
        let serverMessage='';

        let expectedServerID='unixServer';
        let expectedMessage='I am unix server!';

        ipc.connectTo(
            'unixServer',
             function open(){
                 ipc.of.unixServer.on(
                    'connect',
                    function connected(){
                        ipc.of.unixServer.on(
                            'message',
                            function gotMessage(data){
                                serverID=data.id
                                serverMessage=data.message
                            }
                        );

                        ipc.of.unixServer.emit(
                            'message',
                            {
                                id      : ipc.config.id,
                                message : 'Hello from Client.'
                            }
                        );
                    }
                );
             }
        );

        await delay(transmit_delay);

        test.compare(serverID,expectedServerID);
        test.compare(serverMessage,expectedMessage);

        
        

    }catch(err){
        fail(err);
    }finally{
        if(unixClient){
            unixClient.config.stopRetrying=true;
            if(unixClient.of.unixServer){
                if(!unixClient.of.unixServer.socket?.destroyed){
                    unixClient.of.unixServer.emit('END');
                }
                unixClient.disconnect('unixServer');
            }
        }
    }
    cleanup();




    let syncClient;
    try{
        test.expects(
            'the unix client to send synchronously when config.sync is set to true'
        );
        
        const ipc=syncClient=new IPCModule;

        if(process.env.NODE_IPC_TEST_SOCKET_ROOT){
            ipc.config.socketRoot=process.env.NODE_IPC_TEST_SOCKET_ROOT;
        }

        ipc.config.sync = true;
        ipc.config.silent = true;

        const messageTotal=5;
        let responseCounter = 0;
        let responseError;

        ipc.connectTo(
            'unixServerSync',
            ipc.config.socketRoot+ipc.config.appspace+'unixServerSync',
            function open(){
                ipc.of.unixServerSync.on(
                    'connect',
                    function connected(){

                        for(let i=0; i<messageTotal; i++){
                            ipc.of.unixServerSync.emit(
                                'message',
                                {
                                    id      : ipc.config.id,
                                    message : 'Unix Client Request '
                                }
                            );
                        }

                        ipc.of.unixServerSync.on(
                            'message',
                            function gotMessage(data){
                                if(data.message!=='Response from unix server'){
                                    responseError=new Error("data.message!=='Response from unix server'");
                                    return;
                                }
                                responseCounter++;
                            }
                        );
                    }
                );
            }
        );

        await delay(transmit_delay);

        if(responseError){
            throw responseError;
        }
        
        test.compare(responseCounter,messageTotal);
    }catch(err){
        fail(err);
    }finally{
        if(syncClient){
            syncClient.config.stopRetrying=true;
            if(syncClient.of.unixServerSync){
                if(!syncClient.of.unixServerSync.socket?.destroyed){
                    syncClient.of.unixServerSync.emit('END');
                }
                syncClient.disconnect('unixServerSync');
            }
        }
    }
    cleanup();




    // try{
    //     test.expects(
    //         ''
    //     );
        
    //     const ipc=new IPCModule;

        

    // }catch(err){
    //     fail(err);
    // }
    // cleanup();

    return test.report();

}

export {
    run as default,
    run
}
