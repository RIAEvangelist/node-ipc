import assert from 'node:assert/strict';
import net from 'node:net';

import delay from '../helpers/delay.js';

const defaultTimeout=5000;

function waitForEvent(target,type,action,timeout=defaultTimeout){
    return new Promise((resolve,reject) => {
        let timer;

        const cleanup=() => {
            clearTimeout(timer);
            target.off(type,handler);
        };
        const handler=(...args) => {
            cleanup();
            resolve(args);
        };

        target.on(type,handler);
        timer=setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for "${type}" after ${timeout} ms.`));
        },timeout);

        try{
            action?.();
        }catch(error){
            cleanup();
            reject(error);
        }
    });
}

async function reservePort(host='127.0.0.1'){
    const server=net.createServer();
    await new Promise((resolve,reject) => {
        server.once('error',reject);
        server.listen(0,host,resolve);
    });
    const {port}=server.address();
    await new Promise((resolve,reject) => server.close((error) => error ? reject(error) : resolve()));
    await delay(0);
    return port;
}

function withTimeout(promise,label,timeout=defaultTimeout){
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve,reject) => {
            timer=setTimeout(() => reject(new Error(`${label} timed out after ${timeout} ms.`)),timeout);
        })
    ]).finally(() => clearTimeout(timer));
}

async function stopIPC(clientIPC,serverIPC,id){
    if(clientIPC?.of?.[id]){
        clientIPC.config.stopRetrying=true;
        clientIPC.disconnect(id);
    }

    const server=serverIPC?.server;
    if(!server){
        return;
    }
    for(const socket of [...(server.sockets || [])]){
        if(socket && socket !== server.server && typeof socket.destroy === 'function'){
            socket.destroy();
        }
    }
    if(server.server?.listening){
        await new Promise((resolve) => {
            server.server.close(() => resolve());
            setTimeout(resolve,1000).unref?.();
        });
    }
}

function parseFrame(frame,delimiter='\f'){
    assert.equal(frame.slice(-delimiter.length),delimiter);
    return JSON.parse(frame.slice(0,-delimiter.length));
}

export {
    defaultTimeout,
    parseFrame,
    reservePort,
    stopIPC,
    waitForEvent,
    withTimeout
};
