#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {access,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath,pathToFileURL} from 'node:url';

import VanillaTest from 'vanilla-test';
import {parsePortableJson} from './portable-json.js';

const host='127.0.0.1';
const readyTimeout=10e3;
const processTimeout=20e3;
const buildTimeout=180e3;
const cleanupTimeout=5e3;
const reservationAttempts=3;
const languages=Object.freeze(['node','rust','csharp']);
const languageLabels=Object.freeze({node:'JavaScript',rust:'Rust',csharp:'C#'});
const defaultPairs=Object.freeze(
    languages.flatMap((server) => languages.map((client) => Object.freeze([server,client])))
);

const behaviorRoot=fileURLToPath(new URL('./',import.meta.url));
const projectRoot=path.resolve(behaviorRoot,'..','..');
const contractFile=path.join(behaviorRoot,'tcp-transcript.json');
const nodePeer=path.join(behaviorRoot,'node-peer.js');
const rustManifest=path.join(projectRoot,'rust','node-ipc','Cargo.toml');
const csharpRoot=path.join(projectRoot,'csharp','node-ipc');
const csharpProject=path.join(csharpRoot,'interop','NodeIpc.Interop','NodeIpc.Interop.csproj');

async function cargoExecutable(){
    if(process.env.CARGO){
        return process.env.CARGO;
    }

    const userHome=process.platform === 'win32'
        ? process.env.USERPROFILE
        : process.env.HOME;
    if(userHome){
        const candidate=path.join(
            userHome,
            '.cargo',
            'bin',
            `cargo${process.platform === 'win32' ? '.exe' : ''}`
        );
        try{
            await access(candidate,fsConstants.X_OK);
            return candidate;
        }catch{
            // Fall through to PATH lookup.
        }
    }
    return 'cargo';
}

function launch(command,args,label,{cwd=projectRoot,env=process.env,killTree=false}={}){
    const stdoutLines=[];
    const stderr=[];
    const lineListeners=new Set;
    let stdoutBuffer='';
    let settled=false;
    let resolveExit;
    const exit=new Promise((resolve) => {
        resolveExit=resolve;
    });
    const child=spawn(command,args,{
        cwd,
        detached:killTree && process.platform !== 'win32',
        env,
        stdio:['ignore','pipe','pipe'],
        windowsHide:true
    });

    function settle(outcome){
        if(settled){
            return;
        }
        settled=true;
        if(stdoutBuffer.trim()){
            stdoutLines.push(stdoutBuffer.trim());
        }
        resolveExit({...outcome,label,stderr:stderr.join(''),stdoutLines});
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk) => {
        stdoutBuffer+=chunk;
        for(let boundary=stdoutBuffer.indexOf('\n');boundary !== -1;boundary=stdoutBuffer.indexOf('\n')){
            const line=stdoutBuffer.slice(0,boundary).trim();
            stdoutBuffer=stdoutBuffer.slice(boundary+1);
            if(!line){
                continue;
            }
            stdoutLines.push(line);
            for(const listener of lineListeners){
                listener(line);
            }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',(chunk) => stderr.push(chunk));
    child.once('error',(error) => settle({code:null,error,signal:null}));
    child.once('close',(code,signal) => settle({code,error:null,signal}));

    return {
        child,
        exit,
        get settled(){
            return settled;
        },
        killTree,
        label,
        onLine(listener){
            lineListeners.add(listener);
            return () => lineListeners.delete(listener);
        },
        stderr,
        stdoutLines
    };
}

async function waitForExit(running,timeout,label=running.label){
    let timer;
    const outcome=await Promise.race([
        running.exit,
        new Promise((resolve) => {
            timer=setTimeout(() => resolve(null),timeout);
        })
    ]).finally(() => clearTimeout(timer));
    if(outcome){
        return outcome;
    }
    await stop(running);
    throw new Error(`${label} timed out after ${timeout} ms.${formatOutput(running)}`);
}

async function stop(running){
    if(!running || running.settled){
        return;
    }
    await signalProcess(running,'SIGTERM');
    let timer;
    const stopped=await Promise.race([
        running.exit.then(() => true),
        new Promise((resolve) => {
            timer=setTimeout(() => resolve(false),cleanupTimeout);
        })
    ]).finally(() => clearTimeout(timer));
    if(stopped){
        return;
    }

    await signalProcess(running,'SIGKILL');
    let killTimer;
    const killed=await Promise.race([
        running.exit.then(() => true),
        new Promise((resolve) => {
            killTimer=setTimeout(() => resolve(false),cleanupTimeout);
        })
    ]).finally(() => clearTimeout(killTimer));
    if(!killed){
        throw new Error(`${running.label} did not close after forced termination.${formatOutput(running)}`);
    }
}

async function signalProcess(running,signal){
    if(!running.killTree){
        running.child.kill(signal);
        return;
    }
    if(process.platform === 'win32'){
        const killed=await taskkill(running.child.pid,signal === 'SIGKILL');
        if(!killed && running.child.exitCode === null && running.child.signalCode === null){
            running.child.kill(signal);
        }
        return;
    }
    try{
        process.kill(-running.child.pid,signal);
    }catch(error){
        if(error?.code !== 'ESRCH'){
            throw error;
        }
    }
}

function taskkill(pid,force){
    return new Promise((resolve) => {
        let settled=false;
        const args=['/PID',String(pid),'/T'];
        if(force){
            args.push('/F');
        }
        const killer=spawn('taskkill.exe',args,{
            stdio:'ignore',
            windowsHide:true
        });
        const timer=setTimeout(() => {
            killer.kill();
            finish(false);
        },cleanupTimeout);
        killer.once('error',() => finish(false));
        killer.once('close',(code) => finish(code === 0));

        function finish(result){
            if(settled){
                return;
            }
            settled=true;
            clearTimeout(timer);
            resolve(result);
        }
    });
}

async function runCommand(command,args,label,timeout,options){
    const running=launch(command,args,label,options);
    const outcome=await waitForExit(running,timeout,label);
    assertSuccessful(outcome,running);
    return outcome;
}

function waitForStatus(running,status,timeout=readyTimeout){
    for(const line of running.stdoutLines){
        const record=parseRecord(line);
        if(record?.status === status){
            return Promise.resolve(record);
        }
    }

    return new Promise((resolve,reject) => {
        let finished=false;
        const timer=setTimeout(
            () => finish(new Error(
                `${running.label} did not report ${status} within ${timeout} ms.${formatOutput(running)}`
            )),
            timeout
        );
        const unsubscribe=running.onLine((line) => {
            const record=parseRecord(line);
            if(record?.status === status){
                finish(null,record);
            }
        });
        running.exit.then((outcome) => {
            finish(new Error(
                `${running.label} exited before ${status} (code ${outcome.code}, `+
                `signal ${outcome.signal || 'none'}).${formatOutput(running)}`
            ));
        });

        function finish(error,record){
            if(finished){
                return;
            }
            finished=true;
            clearTimeout(timer);
            unsubscribe();
            error ? reject(error) : resolve(record);
        }
    });
}

function parseRecord(line){
    try{
        return JSON.parse(line);
    }catch{
        return null;
    }
}

function records(running){
    return running.stdoutLines.map(parseRecord).filter(Boolean);
}

function formatOutput(running){
    const stdout=running.stdoutLines.join('\n').trim();
    const stderr=running.stderr.join('').trim();
    return [stdout && `\nstdout:\n${stdout}`,stderr && `\nstderr:\n${stderr}`]
        .filter(Boolean)
        .join('');
}

async function reservePort(){
    const server=net.createServer();
    await new Promise((resolve,reject) => {
        server.once('error',reject);
        server.listen(0,host,resolve);
    });
    const {port}=server.address();
    await new Promise((resolve,reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    return port;
}

async function loadContract(){
    const contract=parsePortableJson(await readFile(contractFile));
    assert.equal(contract.schema,'node-ipc-behavior-v1');
    assert.equal(contract.profile,'fast');
    assert.equal(contract.delimiterHex,'0c');
    assert.equal(typeof contract.wireProbe?.type,'string');
    assert.ok(contract.wireProbe.type.length > 0);
    assert.ok(Object.hasOwn(contract.wireProbe,'data'));
    assert.equal(typeof contract.wireProbe.frame,'string');
    assert.equal(Buffer.from(contract.wireProbe.frame).at(-1),0x0c);
    assert.ok(Array.isArray(contract.steps));
    assert.ok(contract.steps.length > 0);
    assert.ok(contract.finish && typeof contract.finish === 'object');
    const scenarioIds=[...contract.steps.map(({id}) => id),contract.finish.id];
    assert.equal(new Set(scenarioIds).size,scenarioIds.length,'behavior ids must be unique');
    assert.equal(contract.finish.requestData.expected,contract.steps.length);
    assert.equal(contract.finish.responseData.received,contract.steps.length);
    return Object.freeze({
        contract,
        exchanges:Object.freeze(contractExchanges(contract)),
        scenarioIds:Object.freeze(scenarioIds)
    });
}

function contractExchanges(contract){
    return [
        ...contract.steps.map((step) => Object.freeze({
            id:step.id,
            request:step.request,
            requestData:step.data,
            response:step.response,
            responseData:step.data
        })),
        Object.freeze({
            id:contract.finish.id,
            request:contract.finish.request,
            requestData:contract.finish.requestData,
            response:contract.finish.response,
            responseData:contract.finish.responseData
        })
    ];
}

function validatePairs(pairs){
    assert.ok(Array.isArray(pairs) && pairs.length > 0,'at least one behavior pair is required');
    const seen=new Set;
    return pairs.map((pair) => {
        assert.ok(Array.isArray(pair) && pair.length === 2,'each pair must be [server, client]');
        const [server,client]=pair;
        assert.ok(languages.includes(server),`unknown server language: ${server}`);
        assert.ok(languages.includes(client),`unknown client language: ${client}`);
        const key=`${server}:${client}`;
        assert.ok(!seen.has(key),`duplicate behavior pair: ${key}`);
        seen.add(key);
        return Object.freeze([server,client]);
    });
}

function validateBoundaryLanguages(selected){
    assert.ok(Array.isArray(selected),'boundaryLanguages must be an array');
    const unique=new Set(selected);
    assert.equal(unique.size,selected.length,'boundaryLanguages must not contain duplicates');
    for(const language of selected){
        assert.ok(languages.includes(language),`unknown boundary language: ${language}`);
    }
    return [...selected];
}

async function preparePeers(requiredLanguages,temporaryRoot){
    const peers={
        node:{command:process.execPath,prefix:[nodePeer]}
    };
    const builds=[];
    if(requiredLanguages.has('rust')){
        builds.push(buildRustPeer(temporaryRoot).then((peer) => {
            peers.rust=peer;
        }));
    }
    if(requiredLanguages.has('csharp')){
        builds.push(buildCsharpPeer(temporaryRoot).then((peer) => {
            peers.csharp=peer;
        }));
    }
    const outcomes=await Promise.allSettled(builds);
    const failed=outcomes.find((outcome) => outcome.status === 'rejected');
    if(failed){
        throw failed.reason;
    }
    return peers;
}

async function buildRustPeer(temporaryRoot){
    const cargo=await cargoExecutable();
    const targetDirectory=path.join(temporaryRoot,'cargo-target');
    const build=await runCommand(
        cargo,
        [
            'build',
            '--manifest-path',rustManifest,
            '--example','behavior_peer',
            '--locked',
            '--message-format=json-render-diagnostics'
        ],
        'Rust behavioral peer build',
        buildTimeout,
        {
            env:{...process.env,CARGO_TARGET_DIR:targetDirectory,CARGO_TERM_COLOR:'never'},
            killTree:true
        }
    );
    const artifact=build.stdoutLines
        .map(parseRecord)
        .find((record) => record?.reason === 'compiler-artifact'
            && record.target?.name === 'behavior_peer'
            && record.target?.kind?.includes('example')
            && typeof record.executable === 'string');
    assert.ok(artifact,'Cargo did not report the Rust behavioral executable');
    await access(artifact.executable,fsConstants.X_OK);
    return {command:artifact.executable,prefix:[]};
}

async function buildCsharpPeer(temporaryRoot){
    const artifacts=path.join(temporaryRoot,'dotnet-artifacts');
    await runCommand(
        'dotnet',
        [
            'build',csharpProject,
            '-c','Release',
            '--nologo',
            '--artifacts-path',artifacts
        ],
        'C# behavioral peer build',
        buildTimeout,
        {cwd:csharpRoot,killTree:true}
    );
    const matches=(await findFiles(artifacts,'NodeIpc.Interop.dll'))
        .filter((file) => file.split(path.sep).includes('bin'));
    assert.equal(
        matches.length,
        1,
        `expected one built C# behavioral assembly, found ${matches.length}`
    );
    return {command:'dotnet',prefix:[matches[0]]};
}

async function findFiles(directory,name){
    const matches=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const file=path.join(directory,entry.name);
        if(entry.isDirectory()){
            matches.push(...await findFiles(file,name));
        }else if(entry.isFile() && entry.name === name){
            matches.push(file);
        }
    }
    return matches;
}

function peerDefinition(peers,language,mode,port){
    const peer=peers[language];
    assert.ok(peer,`peer was not built for ${language}`);
    return {
        command:peer.command,
        args:[
            ...peer.prefix,
            '--mode',mode,
            '--host',host,
            '--port',String(port),
            '--contract',contractFile,
            '--json'
        ],
        label:`${languageLabels[language]} ${mode}`
    };
}

async function runPair(peers,fixture,serverLanguage,clientLanguage){
    let lastError;
    for(let attempt=1;attempt<=reservationAttempts;attempt++){
        const port=await reservePort();
        try{
            return await runPairOnPort(
                peers,
                fixture,
                serverLanguage,
                clientLanguage,
                port
            );
        }catch(error){
            lastError=error;
            if(attempt === reservationAttempts || !addressInUse(error)){
                throw error;
            }
        }
    }
    throw lastError;
}

async function runPairOnPort(peers,fixture,serverLanguage,clientLanguage,port){
    const serverDefinition=peerDefinition(peers,serverLanguage,'server',port);
    const clientDefinition=peerDefinition(peers,clientLanguage,'client',port);
    const server=launch(serverDefinition.command,serverDefinition.args,serverDefinition.label);
    let client;
    try{
        const listening=await waitForStatus(server,'listening');
        assertBehaviorRecord(
            listening,
            fixture,
            serverLanguage,
            'server',
            'listening',
            port
        );

        client=launch(clientDefinition.command,clientDefinition.args,clientDefinition.label);
        const [clientOutcome,serverOutcome]=await Promise.all([
            waitForExit(client,processTimeout),
            waitForExit(server,processTimeout)
        ]);
        assertSuccessful(clientOutcome,client);
        assertSuccessful(serverOutcome,server);

        const clientComplete=records(client).find((record) =>
            record.role === 'client' && record.status === 'complete'
        );
        const serverComplete=records(server).find((record) =>
            record.role === 'server' && record.status === 'complete'
        );
        assert.ok(clientComplete,'client did not emit a completion record');
        assert.ok(serverComplete,'server did not emit a completion record');
        assertBehaviorRecord(
            clientComplete,
            fixture,
            clientLanguage,
            'client',
            'complete',
            port
        );
        assertBehaviorRecord(
            serverComplete,
            fixture,
            serverLanguage,
            'server',
            'complete',
            port
        );
    }finally{
        await Promise.all([stop(client),stop(server)]);
    }
}

function encodeFrame(type,data){
    return `${JSON.stringify({type,data})}\f`;
}

function consumeFrames(state,chunk,receive){
    state.buffer+=chunk;
    for(let boundary=state.buffer.indexOf('\f');boundary !== -1;boundary=state.buffer.indexOf('\f')){
        const frame=state.buffer.slice(0,boundary);
        state.buffer=state.buffer.slice(boundary+1);
        receive(JSON.parse(frame));
    }
}

function connectRawClient(port){
    return new Promise((resolve,reject) => {
        const socket=net.createConnection({host,port});
        const timer=setTimeout(() => {
            socket.destroy();
            reject(new Error(`raw behavioral client did not connect within ${readyTimeout} ms`));
        },readyTimeout);
        const failed=(error) => {
            clearTimeout(timer);
            reject(error);
        };
        socket.setNoDelay(true);
        socket.setEncoding('utf8');
        socket.once('error',failed);
        socket.once('connect',() => {
            clearTimeout(timer);
            socket.off('error',failed);
            socket.on('error',() => {});
            resolve(socket);
        });
    });
}

function assertRejected(outcome,running,boundary){
    assert.equal(outcome.error,null,`${running.label} spawn error: ${outcome.error?.message}`);
    assert.equal(
        outcome.signal,
        null,
        `${running.label} terminated by ${outcome.signal}.${formatOutput(running)}`
    );
    assert.notEqual(
        outcome.code,
        0,
        `${running.label} accepted ${boundary}.${formatOutput(running)}`
    );
    assert.ok(
        !records(running).some((record) => record.status === 'complete'),
        `${running.label} reported completion after ${boundary}.${formatOutput(running)}`
    );
}

async function runServerBoundary(peers,fixture,language,boundary){
    let lastError;
    for(let attempt=1;attempt<=reservationAttempts;attempt++){
        const port=await reservePort();
        try{
            return await runServerBoundaryOnPort(peers,fixture,language,boundary,port);
        }catch(error){
            lastError=error;
            if(attempt === reservationAttempts || !addressInUse(error)){
                throw error;
            }
        }
    }
    throw lastError;
}

async function runServerBoundaryOnPort(peers,fixture,language,boundary,port){
    const definition=peerDefinition(peers,language,'server',port);
    const running=launch(definition.command,definition.args,definition.label);
    let socket;
    let responseError;
    try{
        const listening=await waitForStatus(running,'listening');
        assertBehaviorRecord(listening,fixture,language,'server','listening',port);
        socket=await connectRawClient(port);
        const socketClosed=new Promise((resolve) => socket.once('close',resolve));
        const responseState={buffer:''};
        let responseIndex=0;
        socket.on('data',(chunk) => {
            if(responseError){
                return;
            }
            try{
                consumeFrames(responseState,chunk,(message) => {
                    const expected=fixture.exchanges[responseIndex++];
                    assert.ok(expected,'server emitted an extra response during a boundary check');
                    assert.equal(message.type,expected.response);
                    assert.deepEqual(message.data,expected.responseData);
                    if(responseIndex === fixture.exchanges.length){
                        socket.end();
                    }
                });
            }catch(error){
                responseError=error;
                socket.destroy();
            }
        });
        socket.write(
            fixture.exchanges
                .map((exchange) => encodeFrame(exchange.request,exchange.requestData))
                .join('')+boundary.suffix
        );

        const outcome=await waitForExit(running,processTimeout);
        let closeTimer;
        await Promise.race([
            socketClosed,
            new Promise((_,reject) => {
                closeTimer=setTimeout(
                    () => reject(new Error('raw behavioral client did not observe server close')),
                    cleanupTimeout
                );
            })
        ]).finally(() => clearTimeout(closeTimer));
        if(responseError){
            throw responseError;
        }
        assert.equal(
            responseIndex,
            fixture.exchanges.length,
            `${running.label} rejected the boundary before returning every valid-prefix response`
        );
        assert.equal(
            responseState.buffer,
            '',
            `${running.label} left an incomplete response during a boundary check`
        );
        assertRejected(outcome,running,boundary.label);
    }finally{
        socket?.destroy();
        await stop(running);
    }
}

async function listenRawServer(server){
    await new Promise((resolve,reject) => {
        server.once('error',reject);
        server.listen(0,host,() => {
            server.off('error',reject);
            resolve();
        });
    });
    return server.address().port;
}

async function closeRawServer(server,socket){
    socket?.destroy();
    if(!server.listening){
        return;
    }
    let timer;
    await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((_,reject) => {
            timer=setTimeout(() => {
                server.closeAllConnections?.();
                reject(new Error('raw behavioral server did not close within its cleanup deadline'));
            },cleanupTimeout);
        })
    ]).finally(() => clearTimeout(timer));
}

async function runClientBoundary(peers,fixture,language,boundary){
    let socket;
    let protocolError;
    let requestIndex=0;
    const rawServer=net.createServer((accepted) => {
        if(socket){
            protocolError=new Error('behavioral client opened more than one raw connection');
            accepted.destroy();
            return;
        }
        socket=accepted;
        socket.setNoDelay(true);
        socket.setEncoding('utf8');
        socket.on('error',() => {});
        const requestState={buffer:''};
        socket.on('data',(chunk) => {
            if(protocolError){
                return;
            }
            try{
                consumeFrames(requestState,chunk,(message) => {
                    const expected=fixture.exchanges[requestIndex++];
                    assert.ok(expected,'client emitted an extra request during a boundary check');
                    assert.equal(message.type,expected.request);
                    assert.deepEqual(message.data,expected.requestData);
                    const response=encodeFrame(expected.response,expected.responseData);
                    if(requestIndex === fixture.exchanges.length){
                        socket.end(response+boundary.suffix);
                    }else{
                        socket.write(response);
                    }
                });
            }catch(error){
                protocolError=error;
                socket.destroy();
            }
        });
    });
    rawServer.on('error',(error) => {
        protocolError??=error;
    });

    let running;
    try{
        const port=await listenRawServer(rawServer);
        const definition=peerDefinition(peers,language,'client',port);
        running=launch(definition.command,definition.args,definition.label);
        const outcome=await waitForExit(running,processTimeout);
        if(protocolError){
            throw protocolError;
        }
        assert.equal(
            requestIndex,
            fixture.exchanges.length,
            `${running.label} stopped before completing the valid request transcript`
        );
        assertRejected(outcome,running,boundary.label);
    }finally{
        await stop(running);
        await closeRawServer(rawServer,socket);
    }
}

function assertBehaviorRecord(record,fixture,language,role,status,port){
    assert.equal(record.schema,fixture.contract.schema);
    assert.equal(record.language,language);
    assert.equal(record.role,role);
    assert.equal(record.status,status);
    assert.equal(record.host,host);
    assert.equal(record.port,port);
    assert.equal(record.steps,fixture.contract.steps.length);
    assert.equal(record.frames,fixture.scenarioIds.length);
    assert.deepEqual(record.scenario_ids,fixture.scenarioIds);
}

function assertSuccessful(outcome,running){
    assert.equal(outcome.error,null,`${running.label} spawn error: ${outcome.error?.message}`);
    assert.equal(
        outcome.signal,
        null,
        `${running.label} terminated by ${outcome.signal}.${formatOutput(running)}`
    );
    assert.equal(
        outcome.code,
        0,
        `${running.label} exited with ${outcome.code}.${formatOutput(running)}`
    );
}

function addressInUse(error){
    for(let current=error;current;current=current.cause){
        if(current.code === 'EADDRINUSE'
            || /EADDRINUSE|address.*in use|\b10048\b|normally permitted/iu.test(current.message)){
            return true;
        }
    }
    return false;
}

async function runExpectation(test,description,action){
    test.expects(description);
    try{
        await action();
        test.pass();
    }catch(error){
        console.error(`\n${description}`);
        console.error(error?.stack || error);
        test.fail();
    }finally{
        test.done();
    }
}

async function run(options={}){
    const pairs=options.pairs ?? defaultPairs;
    const selectedPairs=validatePairs(pairs);
    const boundaryLanguages=validateBoundaryLanguages(
        options.boundaryLanguages ?? (options.pairs === undefined ? languages : [])
    );
    const fixture=await loadContract();
    const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-behavior-'));
    try{
        const requiredLanguages=new Set([...selectedPairs.flat(),...boundaryLanguages]);
        const peers=await preparePeers(requiredLanguages,temporaryRoot);
        const test=new VanillaTest;

        for(const [serverLanguage,clientLanguage] of selectedPairs){
            const description=
                `${languageLabels[clientLanguage]} client follows the shared transcript `+
                `with the ${languageLabels[serverLanguage]} server`;
            await runExpectation(
                test,
                description,
                () => runPair(peers,fixture,serverLanguage,clientLanguage)
            );
        }

        const boundaries=[
            Object.freeze({
                label:'a complete trailing Fast frame',
                suffix:encodeFrame('behavior.unexpected',{after:'finish'})
            }),
            Object.freeze({
                label:'an incomplete trailing Fast frame',
                suffix:'{"type":"behavior.trailing"'
            })
        ];
        for(const language of boundaryLanguages){
            for(const boundary of boundaries){
                await runExpectation(
                    test,
                    `${languageLabels[language]} server rejects ${boundary.label}`,
                    () => runServerBoundary(peers,fixture,language,boundary)
                );
                await runExpectation(
                    test,
                    `${languageLabels[language]} client rejects ${boundary.label}`,
                    () => runClientBoundary(peers,fixture,language,boundary)
                );
            }
        }

        const result=test.report();
        const expectedTotal=selectedPairs.length+boundaryLanguages.length*boundaries.length*2;
        assert.equal(result.total,expectedTotal,'behavioral case count changed unexpectedly');
        return result;
    }finally{
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

const directInvocation=process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if(directInvocation){
    try{
        const result=await run();
        process.exitCode=result.ok ? 0 : 1;
    }catch(error){
        console.error(error?.stack || error);
        process.exitCode=2;
    }
}

export {defaultPairs,run as default,run};
