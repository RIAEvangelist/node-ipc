import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory=path.resolve(directory,'../fixtures/tls');
const ca=readFileSync(path.join(fixtureDirectory,'ca-cert.pem'));
const serverCertificate=readFileSync(path.join(fixtureDirectory,'server-cert.pem'));
const serverKey=readFileSync(path.join(fixtureDirectory,'server-key.pem'));
const clientCertificate=readFileSync(path.join(fixtureDirectory,'client-cert.pem'));
const clientKey=readFileSync(path.join(fixtureDirectory,'client-key.pem'));

const common={
    ca,
    maxVersion:'TLSv1.3',
    minVersion:'TLSv1.3',
    rejectUnauthorized:true
};

function clientTlsOptions(){
    return {
        ...common,
        cert:clientCertificate,
        key:clientKey,
        servername:'localhost'
    };
}

function serverTlsOptions(){
    return {
        ...common,
        cert:serverCertificate,
        key:serverKey,
        requestCert:true
    };
}

function assertAuthenticatedTls(socket,role){
    if(!socket?.encrypted){
        throw new Error(`${role} did not establish TLS`);
    }
    if(socket.authorized !== true){
        throw new Error(`${role} TLS peer was not authorized: ${socket.authorizationError ?? 'unknown error'}`);
    }
    if(socket.getProtocol() !== 'TLSv1.3'){
        throw new Error(`${role} negotiated ${socket.getProtocol()} instead of TLSv1.3`);
    }
}

function tlsSessionMetadata(socket){
    const cipher=socket?.getCipher?.();
    return {
        authorized:socket?.authorized ?? null,
        cipher:cipher?.standardName ?? cipher?.name ?? null,
        protocol:socket?.getProtocol?.() ?? null
    };
}

export {
    assertAuthenticatedTls,
    clientTlsOptions,
    serverTlsOptions,
    tlsSessionMetadata
};
