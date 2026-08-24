import {fork} from 'node:child_process';
import {createInbox} from '../lib/inbox.js';

const messageKind='benchmark.message';

const metadata={
    id:'native-child-process',
    label:'Node child_process IPC',
    packages:[],
    serialization:'Node JSON IPC serialization',
    topology:'parent to direct child',
    transport:'platform IPC channel'
};

function launchPeer(peerFile,subject,options){
    return fork(peerFile,[subject],{
        ...options,
        serialization:'json',
        stdio:['pipe','pipe','pipe','ipc']
    });
}

async function createServer({onError}){
    const receive=message => {
        if(message?.kind !== messageKind){
            return;
        }
        try{
            process.send?.({kind:messageKind,value:message.value},error => {
                if(error){
                    onError(error);
                }
            });
        }catch(error){
            onError(error);
        }
    };
    process.on('message',receive);
    return {
        endpoint:null,
        async close(){
            process.off('message',receive);
            process.disconnect?.();
        }
    };
}

async function createClient({peer}){
    const inbox=createInbox();
    let backpressureEvents=0;
    const receive=message => {
        if(message?.kind === messageKind){
            inbox.push(message.value);
        }
    };
    const fail=error => inbox.fail(error);
    peer.on('message',receive);
    peer.on('error',fail);
    return {
        send(value){
            let rejectWait;
            let resolveWait;
            const accepted=peer.send({kind:messageKind,value},error => {
                if(error){
                    if(rejectWait){
                        rejectWait(error);
                    }else{
                        inbox.fail(error);
                    }
                    return;
                }
                resolveWait?.();
            });
            if(accepted){
                return undefined;
            }
            backpressureEvents+=1;
            return new Promise((resolve,reject) => {
                rejectWait=reject;
                resolveWait=resolve;
            });
        },
        receive:inbox.receive,
        metrics:() => ({backpressureEvents}),
        async close(){
            peer.off('message',receive);
            peer.off('error',fail);
            inbox.end();
        }
    };
}

export {
    createClient,
    createServer,
    launchPeer,
    metadata
};
