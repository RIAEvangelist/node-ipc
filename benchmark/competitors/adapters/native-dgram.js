import dgram from 'node:dgram';
import {once} from 'node:events';
import {verifyDatagramCleanup} from '../lib/endpoints.js';
import {createInbox} from '../lib/inbox.js';
import {
    assertDatagram,
    createFragmentReassembler,
    fragmentDatagram,
    fragmentMessage,
    udpChunkBytes,
    udpDatagramBytes,
    udpDatagramWindow
} from '../lib/udp.js';

const metadata={
    id:'native-dgram',
    label:'Node dgram',
    packages:[],
    serialization:'canonical JSON in benchmark fragment envelopes',
    topology:'unrelated processes',
    transport:'UDP4 or UDP6 loopback'
};

function transport(lane){
    const id=lane?.transportId ?? 'udp4';
    if(!['udp4','udp6'].includes(id)){
        throw new Error(`native dgram does not implement ${id}`);
    }
    return {
        host:id === 'udp4' ? '127.0.0.1' : '::1',
        type:id
    };
}

function tune(socket){
    for(const method of ['setRecvBufferSize','setSendBufferSize']){
        try{
            socket[method](8*1024*1024);
        }catch{}
    }
}

function decodeFragment(message){
    return JSON.parse(message.toString('utf8'));
}

function createCounters(){
    return {
        datagramsRead:0,
        datagramsWritten:0,
        maximumDatagramBytes:0,
        udpPayloadBytesRead:0,
        udpPayloadBytesWritten:0
    };
}

function record(counters,direction,bytes){
    counters[`datagrams${direction}`]+=1;
    counters[`udpPayloadBytes${direction}`]+=bytes;
    counters.maximumDatagramBytes=Math.max(counters.maximumDatagramBytes,bytes);
}

function sendFragments(socket,target,fragments,counters){
    for(const fragment of fragments){
        const datagram=fragmentDatagram(fragment);
        const bytes=assertDatagram(datagram,'native dgram encoded fragment');
        record(counters,'Written',bytes);
        socket.send(datagram,target.port,target.host);
    }
}

function metrics(counters,reassembler){
    return {
        ...counters,
        ...reassembler.metrics(),
        backpressureEvents:0,
        fragmentPayloadBytes:udpChunkBytes,
        maximumAllowedDatagramBytes:udpDatagramBytes,
        maximumOutstandingDatagrams:udpDatagramWindow,
        wireBytesRead:counters.udpPayloadBytesRead,
        wireBytesWritten:counters.udpPayloadBytesWritten
    };
}

async function closeSocket(socket){
    if(!socket || socket.address === undefined){
        return;
    }
    try{
        socket.address();
    }catch{
        return;
    }
    const closed=once(socket,'close');
    socket.close();
    await closed;
}

async function createServer({lane,onError}){
    const selected=transport(lane);
    const socket=dgram.createSocket(selected.type);
    const requests=createFragmentReassembler({direction:'q'});
    const counters=createCounters();
    socket.on('error',onError);
    socket.on('message',(message,peer) => {
        try{
            const bytes=assertDatagram(message,'native dgram received fragment');
            record(counters,'Read',bytes);
            const complete=requests.accept(decodeFragment(message),peer);
            if(complete){
                sendFragments(
                    socket,
                    {host:peer.address,port:peer.port},
                    fragmentMessage(complete.message,'r'),
                    counters
                );
            }
        }catch(error){
            onError(error);
        }
    });
    socket.bind({address:selected.host,exclusive:true,port:0});
    await once(socket,'listening');
    tune(socket);
    const address=socket.address();
    return {
        endpoint:{host:address.address,port:address.port,type:selected.type},
        async close(){
            const pending=requests.metrics().pendingMessages;
            await closeSocket(socket);
            requests.clear();
            if(pending !== 0){
                throw new Error(`native dgram server closed with ${pending} incomplete messages`);
            }
        }
    };
}

async function createClient({endpoint,lane}){
    const selected=transport(lane);
    const socket=dgram.createSocket(selected.type);
    const inbox=createInbox();
    const responses=createFragmentReassembler({direction:'r'});
    const counters=createCounters();
    socket.on('error',error => inbox.fail(error));
    socket.on('message',(message,peer) => {
        try{
            if(peer.address !== endpoint.host || peer.port !== endpoint.port){
                throw new Error(`native dgram received an unexpected peer ${peer.address}:${peer.port}`);
            }
            const bytes=assertDatagram(message,'native dgram received fragment');
            record(counters,'Read',bytes);
            const complete=responses.accept(decodeFragment(message),peer);
            if(complete){
                inbox.push(complete.message);
            }
        }catch(error){
            inbox.fail(error);
        }
    });
    socket.bind({address:selected.host,exclusive:true,port:0});
    await once(socket,'listening');
    tune(socket);
    return {
        send(value){
            sendFragments(socket,endpoint,fragmentMessage(value,'q'),counters);
        },
        receive:inbox.receive,
        metrics:() => metrics(counters,responses),
        async close(){
            const pending=responses.metrics().pendingMessages;
            await closeSocket(socket);
            responses.clear();
            inbox.end();
            if(pending !== 0){
                throw new Error(`native dgram client closed with ${pending} incomplete messages`);
            }
        }
    };
}

export {
    createClient,
    createServer,
    metadata,
    verifyDatagramCleanup as verifyCleanup
};
