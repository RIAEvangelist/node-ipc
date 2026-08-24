#!/usr/bin/env node

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import process from 'node:process';

import {FastParser,IPCModule} from '../../node-ipc.js';
import {parsePortableJson} from './portable-json.js';

const language='node';
const defaultHost='127.0.0.1';
const serverLifecycleEvents=new Set(['start','connect','close','socket.disconnected','error']);
const clientLifecycleEvents=new Set(['connect','disconnect','destroy','error']);

async function main(){
    const options=parseArguments(process.argv.slice(2));
    const contract=await loadContract(options.contract);
    const exchanges=contractExchanges(contract);

    if(options.mode === 'server'){
        await runServer(options,contract,exchanges);
        return;
    }
    await runClient(options,contract,exchanges);
}

function parseArguments(arguments_){
    const options={mode:'',host:defaultHost,port:0,contract:'',json:false};
    for(let index=0;index<arguments_.length;index++){
        const argument=arguments_[index];
        if(argument === '--json'){
            options.json=true;
            continue;
        }
        const value=arguments_[++index];
        if(value === undefined){
            throw new Error(`${argument} requires a value`);
        }
        switch(argument){
            case '--mode':
                options.mode=value;
                break;
            case '--host':
                options.host=value;
                break;
            case '--port':
                options.port=parsePort(value);
                break;
            case '--contract':
                options.contract=value;
                break;
            default:
                throw new Error(`unknown option: ${argument}`);
        }
    }
    if(options.mode !== 'server' && options.mode !== 'client'){
        throw new Error('--mode must be server or client');
    }
    if(!options.host){
        throw new Error('--host must not be empty');
    }
    if(!options.port){
        throw new Error('--port is required');
    }
    if(!options.contract){
        throw new Error('--contract is required');
    }
    if(!options.json){
        throw new Error('--json is required for the behavioral peer');
    }
    return options;
}

function parsePort(value){
    if(!/^\d+$/u.test(value)){
        throw new Error('--port must be an unsigned decimal integer');
    }
    const port=Number(value);
    if(!Number.isInteger(port) || port < 1 || port > 65535){
        throw new Error('--port must be from 1 through 65535');
    }
    return port;
}

async function loadContract(file){
    const contract=parsePortableJson(await readFile(file));
    assert.equal(contract.schema,'node-ipc-behavior-v1');
    assert.equal(contract.profile,'fast');
    assert.equal(contract.delimiterHex,'0c');
    assert.equal(typeof contract.wireProbe?.type,'string');
    assert.ok(contract.wireProbe.type.length > 0);
    assert.ok(Object.hasOwn(contract.wireProbe,'data'));
    assert.equal(typeof contract.wireProbe.frame,'string');
    assert.equal(
        new FastParser().encode(contract.wireProbe.type,contract.wireProbe.data),
        contract.wireProbe.frame,
        'Fast encoder changed the canonical wire probe'
    );
    assert.ok(Array.isArray(contract.steps));
    assert.ok(contract.steps.length > 0);
    assert.ok(contract.finish && typeof contract.finish === 'object');

    const ids=new Set;
    const requests=new Set;
    const responses=new Set;
    for(const exchange of contractExchanges(contract)){
        assert.equal(typeof exchange.id,'string');
        assert.equal(typeof exchange.request,'string');
        assert.equal(typeof exchange.response,'string');
        assert.ok(exchange.id.length > 0);
        assert.ok(exchange.request.length > 0);
        assert.ok(exchange.response.length > 0);
        assert.ok(!ids.has(exchange.id),`duplicate behavior id: ${exchange.id}`);
        assert.ok(!requests.has(exchange.request),`duplicate request event: ${exchange.request}`);
        assert.ok(!responses.has(exchange.response),`duplicate response event: ${exchange.response}`);
        ids.add(exchange.id);
        requests.add(exchange.request);
        responses.add(exchange.response);
    }
    assert.equal(contract.finish.requestData.expected,contract.steps.length);
    assert.equal(contract.finish.responseData.received,contract.steps.length);
    return contract;
}

function contractExchanges(contract){
    return [
        ...contract.steps.map((step) => ({
            id:step.id,
            request:step.request,
            requestData:step.data,
            response:step.response,
            responseData:step.data
        })),
        {
            id:contract.finish.id,
            request:contract.finish.request,
            requestData:contract.finish.requestData,
            response:contract.finish.response,
            responseData:contract.finish.responseData
        }
    ];
}

function createIPC(options){
    const ipc=new IPCModule;
    ipc.config.silent=true;
    ipc.config.parser='fast';
    ipc.config.sync=false;
    ipc.config.stopRetrying=true;
    ipc.config.maxRetries=0;
    ipc.config.networkHost=options.host;
    ipc.config.networkPort=options.port;
    ipc.config.maxConnections=1;
    return ipc;
}

async function runServer(options,contract,exchanges){
    const ipc=createIPC(options);
    let next=0;
    let finishing=false;
    let settled=false;
    let finishSocket;
    let inputEnded=false;

    await new Promise((resolve,reject) => {
        function fail(error){
            if(settled){
                return;
            }
            settled=true;
            ipc.server?.stop?.();
            reject(error instanceof Error ? error : new Error(String(error)));
        }

        ipc.serveNet(options.host,options.port,() => {
            report(options,contract,exchanges,'server','listening');
        });
        const requestEvents=new Set(exchanges.map(({request}) => request));
        ipc.server.on('*',(type) => {
            if(!serverLifecycleEvents.has(type) && !requestEvents.has(type)){
                fail(new Error(`unexpected server event: ${type}`));
            }
        });
        ipc.server.on('error',fail);
        ipc.server.on('close',(socket) => {
            if(settled){
                return;
            }
            if(!finishing){
                fail(new Error(`peer disconnected after ${next} of ${exchanges.length} exchanges`));
                return;
            }
            if(socket !== finishSocket || !inputEnded){
                fail(new Error('peer closed without a clean post-finish request boundary'));
                return;
            }
            if(finishSocket.ipcBuffer){
                fail(new Error('peer ended with an incomplete trailing request frame'));
                return;
            }
            settled=true;
            report(options,contract,exchanges,'server','complete');
            resolve();
        });

        for(const [exchangeIndex,exchange] of exchanges.entries()){
            ipc.server.on(exchange.request,(data,socket) => {
                try{
                    if(settled){
                        return;
                    }
                    assert.ok(!finishing,`request received after the finish exchange: ${exchange.id}`);
                    assert.equal(next,exchangeIndex,`request order mismatch at ${exchange.id}`);
                    assert.deepStrictEqual(data,exchange.requestData,`request payload mismatch at ${exchange.id}`);
                    const isFinish=next+1 === exchanges.length;
                    if(isFinish){
                        finishing=true;
                        finishSocket=socket;
                        inputEnded=socket.readableEnded;
                        if(!inputEnded){
                            socket.once('end',() => {
                                inputEnded=true;
                            });
                        }
                        ipc.server.server.close();
                    }
                    ipc.server.emit(socket,exchange.response,exchange.responseData);
                    next++;
                }catch(error){
                    fail(error);
                }
            });
        }
        ipc.server.start();
    });
}

async function runClient(options,contract,exchanges){
    const ipc=createIPC(options);
    const clientId='behavior-server';
    let next=0;
    let resolveStepResponses;
    let resolveResponses;
    let rejectFailure;
    let resolveDisconnect;
    const stepResponses=new Promise((resolve) => {
        resolveStepResponses=resolve;
    });
    const responses=new Promise((resolve) => {
        resolveResponses=resolve;
    });
    const failure=new Promise((_,reject) => {
        rejectFailure=reject;
    });
    failure.catch(() => {});
    const disconnected=new Promise((resolve) => {
        resolveDisconnect=resolve;
    });

    ipc.connectToNet(clientId,options.host,options.port);
    const client=ipc.of[clientId];
    const responseEvents=new Set(exchanges.map(({response}) => response));
    client.on('*',(type) => {
        if(!clientLifecycleEvents.has(type) && !responseEvents.has(type)){
            rejectFailure(new Error(`unexpected client event: ${type}`));
        }
    });
    for(const [exchangeIndex,exchange] of exchanges.entries()){
        client.on(exchange.response,(data) => {
            try{
                assert.equal(next,exchangeIndex,`response order mismatch at ${exchange.id}`);
                assert.deepStrictEqual(data,exchange.responseData,`response payload mismatch at ${exchange.id}`);
                next++;
                if(next === contract.steps.length){
                    resolveStepResponses();
                }
                if(next === exchanges.length){
                    resolveResponses();
                }
            }catch(error){
                rejectFailure(error);
            }
        });
    }
    client.on('error',(error) => rejectFailure(error));
    client.on('disconnect',() => {
        if(next !== exchanges.length){
            rejectFailure(new Error(
                `peer disconnected after ${next} of ${exchanges.length} responses`
            ));
        }
        resolveDisconnect();
    });

    try{
        await waitForConnect(client);
        for(const exchange of exchanges.slice(0,contract.steps.length)){
            client.emit(exchange.request,exchange.requestData);
        }
        await Promise.race([stepResponses,failure]);
        const finish=exchanges.at(-1);
        client.emit(finish.request,finish.requestData);
        await Promise.race([responses,failure]);
        client.socket.end();
        await Promise.race([disconnected,failure]);
        assert.equal(client.socket.ipcBuffer,'','server ended with an incomplete trailing frame');
        report(options,contract,exchanges,'client','complete');
    }finally{
        ipc.disconnect(clientId);
    }
}

function waitForConnect(client){
    return new Promise((resolve,reject) => {
        function cleanup(){
            client.off('connect',connected);
            client.off('error',failed);
        }
        function connected(){
            cleanup();
            resolve();
        }
        function failed(error){
            cleanup();
            reject(error);
        }
        client.on('connect',connected);
        client.on('error',failed);
    });
}

function report(options,contract,exchanges,role,status){
    process.stdout.write(`${JSON.stringify({
        schema:contract.schema,
        language,
        role,
        status,
        host:options.host,
        port:options.port,
        steps:contract.steps.length,
        frames:exchanges.length,
        scenario_ids:exchanges.map(({id}) => id)
    })}\n`);
}

main().catch((error) => {
    process.stderr.write(`node-ipc JavaScript behavioral peer: ${error?.stack || error}\n`);
    process.exitCode=1;
});
