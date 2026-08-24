import {Buffer} from 'node:buffer';

const emptyEnvelopeBytes=Buffer.byteLength(JSON.stringify({
    payload:'',
    sequence:'00000000'
}));

function sequenceValue(sequence){
    if(!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff){
        throw new Error('sequence must be an unsigned 32-bit integer');
    }
    return sequence.toString(16).padStart(8,'0');
}

function createMessage(bytes,sequence){
    return createMessageFactory(bytes)(sequence);
}

function createMessageFactory(bytes){
    if(!Number.isSafeInteger(bytes) || bytes < emptyEnvelopeBytes){
        throw new Error(`message size must be at least ${emptyEnvelopeBytes} bytes`);
    }
    const payload='x'.repeat(bytes-emptyEnvelopeBytes);
    const probe={payload,sequence:'00000000'};
    if(encodedBytes(probe) !== bytes){
        throw new Error(`message encoding is not exactly ${bytes} bytes`);
    }
    const factory=sequence => ({payload,sequence:sequenceValue(sequence)});
    factory.payload=payload;
    return factory;
}

function encodeMessage(message){
    return JSON.stringify(message);
}

function decodeMessage(value){
    const text=Buffer.isBuffer(value) || value instanceof Uint8Array
        ? Buffer.from(value).toString('utf8')
        : String(value);
    return JSON.parse(text);
}

function encodedBytes(message){
    return Buffer.byteLength(encodeMessage(message));
}

function verifyMessage(message,bytes,sequence,expectedPayload){
    if(!message || typeof message !== 'object'){
        throw new Error('echoed message is not an object');
    }
    if(message.sequence !== sequenceValue(sequence)){
        throw new Error(`expected sequence ${sequenceValue(sequence)}, received ${message.sequence}`);
    }
    if(typeof message.payload !== 'string'){
        throw new Error('echoed payload is not a string');
    }
    if(encodedBytes(message) !== bytes){
        throw new Error(`expected ${bytes} encoded bytes, received ${encodedBytes(message)}`);
    }
    if(message.payload !== (expectedPayload ?? createMessageFactory(bytes).payload)){
        throw new Error(`payload content changed at sequence ${message.sequence}`);
    }
}

export {
    createMessage,
    createMessageFactory,
    decodeMessage,
    emptyEnvelopeBytes,
    encodeMessage,
    encodedBytes,
    sequenceValue,
    verifyMessage
};
