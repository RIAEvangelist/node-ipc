import {Buffer} from 'node:buffer';
import {decodeMessage,encodeMessage} from '../protocol.js';

const udpChunkBytes=1024;
const udpDatagramBytes=1200;
const udpDatagramWindow=64;
const udpMaximumMessageBytes=udpChunkBytes*udpDatagramWindow;
const fragmentFields=Object.freeze(['b','c','d','i','n','s','v']);
const sequencePattern=/^[0-9a-f]{8}$/u;

function fragmentCountForBytes(bytes){
    if(!Number.isSafeInteger(bytes) || bytes < 1 || bytes > udpMaximumMessageBytes){
        throw new Error(`UDP logical message bytes must be between 1 and ${udpMaximumMessageBytes}`);
    }
    return Math.ceil(bytes/udpChunkBytes);
}

function logicalWindowForUdp(bytes,requested=udpDatagramWindow){
    if(!Number.isSafeInteger(requested) || requested < 1){
        throw new Error('requested UDP logical window must be a positive integer');
    }
    return Math.max(1,Math.min(
        requested,
        Math.floor(udpDatagramWindow/fragmentCountForBytes(bytes))
    ));
}

function assertDirection(direction){
    if(!['q','r'].includes(direction)){
        throw new Error('UDP fragment direction must be q or r');
    }
}

function fragmentMessage(message,direction){
    assertDirection(direction);
    if(!message || typeof message !== 'object' || !sequencePattern.test(message.sequence)){
        throw new Error('UDP logical message requires an eight-digit hexadecimal sequence');
    }
    const encoded=encodeMessage(message);
    const bytes=Buffer.byteLength(encoded);
    if(bytes !== encoded.length){
        throw new Error('UDP benchmark fragmentation requires canonical ASCII JSON');
    }
    const total=fragmentCountForBytes(bytes);
    return Array.from({length:total},(_,index) => ({
        b:bytes,
        c:encoded.slice(index*udpChunkBytes,(index+1)*udpChunkBytes),
        d:direction,
        i:index,
        n:total,
        s:message.sequence,
        v:1
    }));
}

function fragmentDatagram(fragment){
    return Buffer.from(JSON.stringify(fragment));
}

function assertDatagram(data,label='UDP datagram'){
    const bytes=Buffer.isBuffer(data) || data instanceof Uint8Array
        ? data.byteLength
        : Buffer.byteLength(String(data));
    if(bytes < 1 || bytes > udpDatagramBytes){
        throw new Error(`${label} must be between 1 and ${udpDatagramBytes} bytes; received ${bytes}`);
    }
    return bytes;
}

function peerKey(peer){
    if(!peer
        || typeof peer.address !== 'string'
        || !Number.isSafeInteger(peer.port)
        || peer.port < 1
        || peer.port > 65535){
        throw new Error('UDP peer requires an address and integer port');
    }
    return JSON.stringify([peer.address,peer.port]);
}

function assertFragment(fragment,expectedDirection){
    if(!fragment || typeof fragment !== 'object' || Array.isArray(fragment)){
        throw new Error('UDP fragment must be an object');
    }
    const keys=Object.keys(fragment).sort();
    if(keys.length !== fragmentFields.length || keys.some((key,index) => key !== fragmentFields[index])){
        throw new Error('UDP fragment fields are invalid');
    }
    if(fragment.v !== 1){
        throw new Error('UDP fragment version is invalid');
    }
    assertDirection(fragment.d);
    if(expectedDirection && fragment.d !== expectedDirection){
        throw new Error(`expected UDP fragment direction ${expectedDirection}, received ${fragment.d}`);
    }
    if(!sequencePattern.test(fragment.s)){
        throw new Error('UDP fragment sequence is invalid');
    }
    if(!Number.isSafeInteger(fragment.b) || fragment.b < 1 || fragment.b > udpMaximumMessageBytes){
        throw new Error('UDP fragment logical byte count is invalid');
    }
    const expectedCount=fragmentCountForBytes(fragment.b);
    if(fragment.n !== expectedCount){
        throw new Error(`UDP fragment count must be ${expectedCount}`);
    }
    if(!Number.isSafeInteger(fragment.i) || fragment.i < 0 || fragment.i >= fragment.n){
        throw new Error('UDP fragment index is invalid');
    }
    if(typeof fragment.c !== 'string' || Buffer.byteLength(fragment.c) !== fragment.c.length){
        throw new Error('UDP fragment chunk must be an ASCII string');
    }
    const expectedBytes=fragment.i === fragment.n-1
        ? fragment.b-udpChunkBytes*(fragment.n-1)
        : udpChunkBytes;
    if(fragment.c.length !== expectedBytes){
        throw new Error(`UDP fragment chunk must contain ${expectedBytes} bytes`);
    }
}

function createFragmentReassembler({direction,maxMessages=256}={}){
    if(direction){
        assertDirection(direction);
    }
    if(!Number.isSafeInteger(maxMessages) || maxMessages < 1){
        throw new Error('UDP reassembler maxMessages must be a positive integer');
    }
    const states=new Map;
    const counters={
        acceptedFragments:0,
        completedMessages:0,
        conflictingDuplicates:0,
        duplicateFragments:0,
        maximumPendingMessages:0,
        outOfOrderFragments:0
    };

    function accept(fragment,peer){
        assertFragment(fragment,direction);
        const key=`${peerKey(peer)}\0${fragment.d}\0${fragment.s}`;
        let state=states.get(key);
        if(!state){
            if(states.size >= maxMessages){
                throw new Error(`UDP reassembly exceeds ${maxMessages} pending messages`);
            }
            state={
                bytes:0,
                chunks:new Array(fragment.n),
                nextIndex:0,
                total:fragment.n,
                totalBytes:fragment.b
            };
            states.set(key,state);
            counters.maximumPendingMessages=Math.max(counters.maximumPendingMessages,states.size);
        }else if(state.total !== fragment.n || state.totalBytes !== fragment.b){
            throw new Error('UDP fragment metadata changed within one logical message');
        }

        const existing=state.chunks[fragment.i];
        if(existing !== undefined){
            if(existing !== fragment.c){
                counters.conflictingDuplicates+=1;
                throw new Error('UDP fragment duplicate conflicts with the accepted chunk');
            }
            counters.duplicateFragments+=1;
            return null;
        }
        if(fragment.i !== state.nextIndex){
            counters.outOfOrderFragments+=1;
        }
        state.chunks[fragment.i]=fragment.c;
        state.bytes+=fragment.c.length;
        counters.acceptedFragments+=1;
        while(state.nextIndex < state.total && state.chunks[state.nextIndex] !== undefined){
            state.nextIndex+=1;
        }
        if(state.nextIndex !== state.total){
            return null;
        }

        states.delete(key);
        const encoded=state.chunks.join('');
        if(state.bytes !== state.totalBytes || Buffer.byteLength(encoded) !== state.totalBytes){
            throw new Error('UDP reassembled byte count does not match fragment metadata');
        }
        const message=decodeMessage(encoded);
        if(message?.sequence !== fragment.s){
            throw new Error('UDP reassembled message sequence does not match fragment metadata');
        }
        counters.completedMessages+=1;
        return {
            encodedBytes:state.totalBytes,
            fragmentCount:state.total,
            message
        };
    }

    function metrics(){
        return {
            ...counters,
            pendingMessages:states.size
        };
    }

    function clear(){
        states.clear();
    }

    return {accept,clear,metrics};
}

export {
    assertDatagram,
    assertFragment,
    createFragmentReassembler,
    fragmentCountForBytes,
    fragmentDatagram,
    fragmentMessage,
    logicalWindowForUdp,
    peerKey,
    udpChunkBytes,
    udpDatagramBytes,
    udpDatagramWindow,
    udpMaximumMessageBytes
};
