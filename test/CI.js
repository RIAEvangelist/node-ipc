import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {run as TCPClientRun} from './TCP/client.js';
import {run as TCPServerRun} from './TCP/server.js';
import {run as UDPRun} from './UDP/client.js';
import {run as unixClientRun} from './unix/client.js';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const fixtureReadyTimeout=10e3;
const fixtureExitTimeout=5e3;

const fixtureDefinitions=[
    ['TCP server','test/TCP/TCPServer.js'],
    ['UDP4 server','test/UDP/UDP4Server.js'],
    ['UDP6 server','test/UDP/UDP6Server.js'],
    ['Unix server','test/unix/unixServer.js'],
    ['Unix sync server','test/unix/unixServerSync.js'],
    ['TCP client','test/TCP/TCPClient.js']
];

const suiteDefinitions=[
    ['TCP client',TCPClientRun],
    ['TCP server',TCPServerRun],
    ['UDP',UDPRun],
    ['Unix socket',unixClientRun]
];

async function run(){
    const socketRoot=await createSocketRoot();
    const previousSocketRoot=process.env.NODE_IPC_TEST_SOCKET_ROOT;
    process.env.NODE_IPC_TEST_SOCKET_ROOT=socketRoot;
    const fixtures=[];
    const results=[];
    let harnessError;

    try{
        try{
            for(const [name,file] of fixtureDefinitions){
                const fixture=startFixture(name,file,socketRoot);
                fixtures.push(fixture);
                await waitForFixture(fixture);
            }

            for(const [name,execute] of suiteDefinitions){
                results.push([name,validateResult(await execute(),name)]);
            }
        }catch(err){
            harnessError=err;
            console.error(err?.stack || err);
        }

        const fixtureResults=await settleFixtures(fixtures);
        const fixtureFailures=fixtureResults.filter(
            ({code,forced,signal}) => forced || code !== 0 || signal
        );

        if(fixtureFailures.length){
            const details=fixtureFailures.map(formatFixtureFailure).join('\n');
            harnessError=harnessError || new Error(`Fixture processes did not exit cleanly:\n${details}`);
        }

        if(harnessError){
            results.push(['Harness',failureResult(harnessError)]);
        }

        return aggregateResults(results);
    }finally{
        try{
            await ensureFixturesStopped(fixtures);
            if(process.platform !== 'win32'){
                await rm(socketRoot,{recursive:true,force:true});
            }
        }finally{
            if(previousSocketRoot === undefined){
                delete process.env.NODE_IPC_TEST_SOCKET_ROOT;
            }else{
                process.env.NODE_IPC_TEST_SOCKET_ROOT=previousSocketRoot;
            }
        }
    }
}

async function createSocketRoot(){
    if(process.platform === 'win32'){
        return `/node-ipc-test-${process.pid}-${Date.now()}/`;
    }

    return `${await mkdtemp(path.join(os.tmpdir(),'node-ipc-test-'))}${path.sep}`;
}

function startFixture(name,file,socketRoot){
    const output=[];
    const child=spawn(
        process.execPath,
        [file],
        {
            cwd:projectRoot,
            env:{
                ...process.env,
                NODE_IPC_TEST_SOCKET_ROOT:socketRoot
            },
            stdio:['ignore','pipe','pipe','ipc']
        }
    );

    child.stdout.on('data',(data) => output.push(data.toString()));
    child.stderr.on('data',(data) => output.push(data.toString()));

    const exited=new Promise((resolve) => {
        child.once('error',(error) => resolve({code:null,signal:null,error}));
        child.once('exit',(code,signal) => resolve({code,signal,error:null}));
    });

    return {name,file,child,output,exited};
}

function waitForFixture(fixture){
    return new Promise((resolve,reject) => {
        const timeout=setTimeout(
            () => finish(new Error(`${fixture.name} did not become ready within ${fixtureReadyTimeout} ms.`)),
            fixtureReadyTimeout
        );

        function finish(error){
            clearTimeout(timeout);
            fixture.child.off('message',onMessage);
            fixture.child.off('exit',onExit);
            fixture.child.off('error',onError);
            error ? reject(error) : resolve();
        }

        function onMessage(message){
            if(message?.type === 'ready'){
                finish();
            }
        }

        function onExit(code,signal){
            finish(new Error(
                `${fixture.name} exited before it was ready (code ${code}, signal ${signal || 'none'}).${fixtureOutput(fixture)}`
            ));
        }

        function onError(error){
            finish(new Error(`${fixture.name} could not start: ${error.message}`));
        }

        fixture.child.on('message',onMessage);
        fixture.child.once('exit',onExit);
        fixture.child.once('error',onError);
    });
}

async function settleFixtures(fixtures){
    return Promise.all(fixtures.map(async (fixture) => {
        let outcome=await settleWithin(fixture.exited,fixtureExitTimeout);
        let forced=false;

        if(!outcome){
            forced=true;
            fixture.child.kill('SIGTERM');
            outcome=await settleWithin(fixture.exited,fixtureExitTimeout);
        }

        if(!outcome){
            fixture.child.kill('SIGKILL');
            outcome=await settleWithin(fixture.exited,fixtureExitTimeout);
        }

        if(!outcome){
            outcome={
                code:null,
                signal:null,
                error:new Error('process did not exit after termination')
            };
        }

        return {
            ...outcome,
            forced,
            name:fixture.name,
            output:fixture.output.join('').trim()
        };
    }));
}

async function ensureFixturesStopped(fixtures){
    await Promise.all(fixtures.map(async (fixture) => {
        if(fixture.child.exitCode !== null || fixture.child.signalCode !== null){
            return;
        }

        fixture.child.kill('SIGKILL');
        await settleWithin(fixture.exited,fixtureExitTimeout);
    }));
}

function settleWithin(promise,timeoutMs){
    let timeout;
    return Promise.race([
        promise,
        new Promise((resolve) => {
            timeout=setTimeout(() => resolve(null),timeoutMs);
        })
    ]).finally(() => clearTimeout(timeout));
}

function fixtureOutput(fixture){
    const output=fixture.output.join('').trim();
    return output ? `\n${output}` : '';
}

function formatFixtureFailure(fixture){
    const reason=fixture.error
        ? fixture.error.message
        : `code ${fixture.code}, signal ${fixture.signal || 'none'}${fixture.forced ? ', terminated by harness' : ''}`;
    return `${fixture.name}: ${reason}${fixture.output ? `\n${fixture.output}` : ''}`;
}

function validateResult(result,name){
    if(
        !result ||
        typeof result.ok !== 'boolean' ||
        !Number.isSafeInteger(result.failureCount) ||
        result.failureCount < 0 ||
        result.ok !== (result.failureCount === 0)
    ){
        throw new TypeError(`${name} must return consistent {ok, failureCount}.`);
    }

    return result;
}

function failureResult(error){
    const failed=Object.freeze([error?.message || String(error)]);
    return Object.freeze({
        passed:Object.freeze([]),
        failed,
        total:1,
        failureCount:1,
        ok:false,
        report:failed[0]
    });
}

function aggregateResults(results){
    const passed=[];
    const failed=[];

    for(const [suite,result] of results){
        for(const description of result.passed || []){
            passed.push(`${suite}: ${description}`);
        }
        for(const description of result.failed || []){
            failed.push(`${suite}: ${description}`);
        }
    }

    const frozenPassed=Object.freeze(passed);
    const frozenFailed=Object.freeze(failed);
    const total=results.reduce(
        (count,[,result]) => count+(Number.isSafeInteger(result.total) ? result.total : result.failureCount),
        0
    );
    const failureCount=results.reduce((count,[,result]) => count+result.failureCount,0);
    const report=`node-ipc test result: ${total-failureCount} passed, ${failureCount} failed, ${total} total`;

    console.log(`\n${report}`);

    return Object.freeze({
        passed:frozenPassed,
        failed:frozenFailed,
        total,
        failureCount,
        ok:failureCount === 0,
        report
    });
}

const directInvocation=process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if(directInvocation){
    try{
        const result=await run();
        process.exitCode=result.ok ? 0 : 1;
    }catch(err){
        console.error(err?.stack || err);
        process.exitCode=2;
    }
}

export {
    aggregateResults,
    run as default,
    run
};
