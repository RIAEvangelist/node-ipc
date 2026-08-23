#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath,pathToFileURL} from 'node:url';

import VanillaTest from 'vanilla-test';

const host='127.0.0.1';
const warmup=0;
const count=5;
const payloadBytes=17;
const inflight=1;
const readyTimeout=10e3;
const processTimeout=30e3;
const buildTimeout=180e3;
const cleanupTimeout=5e3;
const reservationAttempts=3;

const interopRoot=fileURLToPath(new URL('./',import.meta.url));
const crateRoot=path.resolve(interopRoot,'..');
const projectRoot=path.resolve(crateRoot,'..','..');
const manifest=path.join(crateRoot,'Cargo.toml');
const nodePeer=path.join(interopRoot,'node-peer.js');
let rustPeer;

async function cargoExecutable(){
    if(process.env.CARGO){
        return process.env.CARGO;
    }

    const home=process.platform === 'win32'
        ? process.env.USERPROFILE
        : process.env.HOME;
    if(home){
        const candidate=path.join(
            home,
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

function launch(command,args,label){
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
        cwd:projectRoot,
        env:{...process.env,CARGO_TERM_COLOR:'never'},
        stdio:['ignore','pipe','pipe'],
        windowsHide:true
    });

    const settle=(outcome) => {
        if(settled){
            return;
        }
        settled=true;
        if(stdoutBuffer.trim()){
            stdoutLines.push(stdoutBuffer.trim());
        }
        resolveExit({...outcome,label,stderr:stderr.join(''),stdoutLines});
    };

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
    if(!running || running.child.exitCode !== null || running.child.signalCode !== null){
        return;
    }
    running.child.kill('SIGTERM');
    let timer;
    const stopped=await Promise.race([
        running.exit.then(() => true),
        new Promise((resolve) => {
            timer=setTimeout(() => resolve(false),cleanupTimeout);
        })
    ]).finally(() => clearTimeout(timer));
    if(!stopped){
        running.child.kill('SIGKILL');
        await running.exit;
    }
}

async function runCommand(command,args,label,timeout){
    const running=launch(command,args,label);
    const outcome=await waitForExit(running,timeout,label);
    if(outcome.error || outcome.code !== 0 || outcome.signal){
        throw new Error(
            `${label} failed (code ${outcome.code}, signal ${outcome.signal || 'none'}): `+
            `${outcome.error?.message || 'process failure'}.${formatOutput(running)}`
        );
    }
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

function peer(language,mode,port){
    const common=[
        '--mode',mode,
        '--host',host,
        '--port',String(port),
        '--warmup',String(warmup),
        '--count',String(count),
        '--payload-bytes',String(payloadBytes),
        '--inflight',String(inflight),
        '--json'
    ];
    if(language === 'node'){
        return {
            args:[nodePeer,...common],
            command:process.execPath,
            label:`Node ${mode}`
        };
    }
    return {
        args:common,
        command:rustPeer,
        label:`Rust ${mode}`
    };
}

async function runPair(serverLanguage,clientLanguage){
    let lastError;
    for(let attempt=1;attempt<=reservationAttempts;attempt++){
        const port=await reservePort();
        try{
            return await runPairOnPort(serverLanguage,clientLanguage,port);
        }catch(error){
            lastError=error;
            if(attempt === reservationAttempts || !addressInUse(error)){
                throw error;
            }
        }
    }
    throw lastError;
}

async function runPairOnPort(serverLanguage,clientLanguage,port){
    const serverDefinition=peer(serverLanguage,'server',port);
    const clientDefinition=peer(clientLanguage,'client',port);
    const server=launch(
        serverDefinition.command,
        serverDefinition.args,
        serverDefinition.label
    );
    let client;
    try{
        const listening=await waitForStatus(server,'listening');
        assert.equal(listening.schema,'node-ipc-roundtrip-v1');
        assert.equal(listening.language,serverLanguage);
        assert.equal(listening.role,'server');
        assert.equal(listening.port,port);

        client=launch(
            clientDefinition.command,
            clientDefinition.args,
            clientDefinition.label
        );
        const [clientOutcome,serverOutcome]=await Promise.all([
            waitForExit(client,processTimeout),
            waitForExit(server,processTimeout)
        ]);
        assertSuccessful(clientOutcome,client);
        assertSuccessful(serverOutcome,server);

        const clientRecord=records(client).find((record) => record.role === 'client');
        assert.ok(clientRecord,'client did not emit a result record');
        assert.equal(clientRecord.schema,'node-ipc-roundtrip-v1');
        assert.equal(clientRecord.language,clientLanguage);
        assert.equal(clientRecord.count,count);
        assert.equal(clientRecord.payload_bytes,payloadBytes);
        assert.equal(clientRecord.inflight,inflight);
        const complete=records(server).find((record) => record.status === 'complete');
        assert.ok(complete,'server did not emit a completion record');
        assert.equal(complete.language,serverLanguage);
        assert.equal(complete.frames,count);
        return {client:clientRecord,server:complete};
    }finally{
        await Promise.all([stop(client),stop(server)]);
    }
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
        if(current.code === 'EADDRINUSE' || /address.*in use|os error 10048/iu.test(current.message)){
            return true;
        }
    }
    return false;
}

async function run(){
    const cargo=await cargoExecutable();
    const build=await runCommand(
        cargo,
        [
            'build',
            '--manifest-path',manifest,
            '--example','tcp_roundtrip',
            '--message-format=json-render-diagnostics'
        ],
        'Rust interoperability peer build',
        buildTimeout
    );
    const artifact=build.stdoutLines
        .map(parseRecord)
        .find((record) => record?.reason === 'compiler-artifact'
            && record.target?.name === 'tcp_roundtrip'
            && record.target?.kind?.includes('example')
            && typeof record.executable === 'string');
    assert.ok(artifact,'Cargo did not report the Rust interoperability executable');
    rustPeer=artifact.executable;
    await access(rustPeer,fsConstants.X_OK);

    const test=new VanillaTest;
    const cases=[
        {
            name:'Node client ping-pongs through the Rust server',
            run:() => runPair('rust','node')
        },
        {
            name:'Rust client ping-pongs through the Node server',
            run:() => runPair('node','rust')
        }
    ];

    for(const entry of cases){
        test.expects(entry.name);
        try{
            await entry.run();
            test.pass();
        }catch(error){
            console.error(`\n${entry.name}`);
            console.error(error?.stack || error);
            test.fail();
        }finally{
            test.done();
        }
    }

    return test.report();
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

export {run as default,run};
