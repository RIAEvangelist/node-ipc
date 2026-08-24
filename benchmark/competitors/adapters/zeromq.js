import {Dealer,Router,version as libraryVersion} from 'zeromq';
import {createInbox} from '../lib/inbox.js';
import {decodeMessage,encodeMessage} from '../protocol.js';

const metadata={
    id:'zeromq',
    label:'ZeroMQ.js 6.6.0',
    packages:['zeromq'],
    runtimeVersion:libraryVersion,
    serialization:'canonical JSON over ZMTP',
    topology:'unrelated processes',
    transport:'ZeroMQ over TCP loopback'
};

async function createServer({onError}){
    const socket=new Router;
    await socket.bind('tcp://127.0.0.1:*');
    let closing=false;
    const receiveLoop=(async() => {
        try{
            for await(const frames of socket){
                const identity=frames[0];
                const value=frames.at(-1);
                await socket.send([identity,encodeMessage(decodeMessage(value))]);
            }
        }catch(error){
            if(!closing){
                onError(error);
            }
        }
    })();
    return {
        endpoint:{url:socket.lastEndpoint},
        async close(){
            closing=true;
            socket.close();
            await receiveLoop;
        }
    };
}

async function createClient({endpoint}){
    const inbox=createInbox();
    const socket=new Dealer;
    socket.connect(endpoint.url);
    let closing=false;
    const receiveLoop=(async() => {
        try{
            for await(const frames of socket){
                inbox.push(decodeMessage(frames.at(-1)));
            }
        }catch(error){
            if(!closing){
                inbox.fail(error);
            }
        }
    })();
    return {
        send:value => socket.send(encodeMessage(value)),
        receive:inbox.receive,
        metrics:() => ({backpressureEvents:0}),
        async close(){
            closing=true;
            socket.close();
            await receiveLoop;
            inbox.end();
        }
    };
}

export {
    createClient,
    createServer,
    metadata
};
