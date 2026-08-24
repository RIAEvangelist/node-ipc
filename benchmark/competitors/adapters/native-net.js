import net from 'node:net';
import {once} from 'node:events';
import {localEndpoint,verifyStreamCleanup} from '../lib/endpoints.js';
import {createInbox} from '../lib/inbox.js';
import {decodeMessage,encodeMessage} from '../protocol.js';

const metadata={
    id:'native-net',
    label:'Node net',
    packages:[],
    serialization:'canonical JSON with newline framing',
    topology:'unrelated processes',
    transport:'TCP or local IPC stream'
};

function consumeLines(state,chunk,consume){
    state.text+=chunk.toString('utf8');
    let boundary=state.text.indexOf('\n');
    while(boundary !== -1){
        const line=state.text.slice(0,boundary);
        state.text=state.text.slice(boundary+1);
        consume(line);
        boundary=state.text.indexOf('\n');
    }
}

function transportId(lane){
    return lane?.transportId ?? 'tcp';
}

async function createServer({lane,onError}){
    const sockets=new Set();
    const server=net.createServer(socket => {
        sockets.add(socket);
        socket.setNoDelay(true);
        const state={text:''};
        socket.on('data',chunk => consumeLines(state,chunk,line => {
            try{
                const encoded=`${encodeMessage(decodeMessage(line))}\n`;
                if(!socket.write(encoded)){
                    socket.pause();
                    socket.once('drain',() => socket.resume());
                }
            }catch(error){
                onError(error);
            }
        }));
        socket.on('close',() => sockets.delete(socket));
        socket.on('error',onError);
    });
    server.on('error',onError);
    const requested=transportId(lane);
    const target=requested === 'local'
        ? localEndpoint(lane?.id)
        : {host:'127.0.0.1',port:0};
    server.listen(target.path ? {path:target.path} : target);
    await once(server,'listening');
    const address=server.address();
    const endpoint=typeof address === 'string'
        ? {implementation:target.implementation,path:address}
        : {host:address.address,port:address.port};
    return {
        endpoint,
        async close(){
            for(const socket of sockets){
                socket.destroy();
            }
            if(server.listening){
                await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
            }
        }
    };
}

async function createClient({endpoint}){
    const inbox=createInbox();
    const socket=net.createConnection(endpoint);
    socket.setNoDelay(true);
    const state={text:''};
    let backpressureEvents=0;
    socket.on('data',chunk => consumeLines(state,chunk,line => {
        try{
            inbox.push(decodeMessage(line));
        }catch(error){
            inbox.fail(error);
        }
    }));
    socket.on('error',error => inbox.fail(error));
    await once(socket,'connect');
    return {
        send(value){
            if(socket.write(`${encodeMessage(value)}\n`)){
                return undefined;
            }
            backpressureEvents+=1;
            return once(socket,'drain').then(() => undefined);
        },
        receive:inbox.receive,
        metrics:() => ({
            backpressureEvents,
            wireBytesRead:socket.bytesRead,
            wireBytesWritten:socket.bytesWritten
        }),
        async close(){
            if(!socket.destroyed){
                const closed=once(socket,'close');
                socket.end();
                await closed;
            }
            inbox.end();
        }
    };
}

export {
    createClient,
    createServer,
    metadata,
    verifyStreamCleanup as verifyCleanup
};
