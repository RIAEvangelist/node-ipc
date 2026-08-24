import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstat,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {definitions as capabilityDefinitions,matrix as capabilities} from './capabilities.js';
import {asOf,catalog,popularityWindow,sources} from './catalog.js';
import {complexityReport} from './complexity.js';
import {dependencyExposure} from './dependencies.js';
import {buildPlan} from './plan.js';
import {distribution} from './stats.js';
import {subjectIds} from './subjects.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(directory,'../..');

function option(name,fallback){
    const prefix=`--${name}=`;
    return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function integer(name,fallback){
    const value=Number(option(name,fallback));
    if(!Number.isSafeInteger(value) || value < 1){
        throw new Error(`--${name} must be a positive integer`);
    }
    return value;
}

function optionalInteger(name){
    const value=option(name,null);
    return value === null ? null : integer(name,value);
}

function integers(name,fallback){
    return option(name,fallback).split(',').map(value => {
        const parsed=Number(value);
        if(!Number.isSafeInteger(parsed) || parsed < 64){
            throw new Error(`--${name} values must be integers of at least 64 bytes`);
        }
        return parsed;
    });
}

function names(name,fallback){
    return [...new Set(option(name,fallback).split(',').filter(Boolean))];
}

const quick=process.argv.includes('--quick');
const workloadOverrides={
    latencyFrames:optionalInteger('latency-messages'),
    throughputFrames:optionalInteger('throughput-messages'),
    warmupFrames:optionalInteger('warmup')
};
const config={
    payloads:integers('payloads',quick ? '64' : '64,4096,65536'),
    probeFrames:integer('probe',quick ? 8 : 64),
    quick,
    samples:integer('samples',quick ? 1 : 6),
    subjects:names('subjects',subjectIds.join(',')),
    timeoutMs:integer('timeout',quick ? 30000 : 180000),
    windowBytes:integer('window-bytes',8*1024*1024),
    windowMessages:integer('window',64),
    workloads:names('workloads','throughput,latency')
};

if(config.subjects.some(subject => !subjectIds.includes(subject))){
    throw new Error(`available subjects: ${subjectIds.join(', ')}`);
}
if(config.subjects.length%2 !== 0){
    throw new Error('the balanced benchmark plan requires an even number of subjects');
}
if(config.subjects.length === 0){
    throw new Error('at least one subject is required');
}
if(!quick && config.samples%config.subjects.length !== 0){
    throw new Error(
        `--samples must be a multiple of the selected subject count (${config.subjects.length}) for balanced ordering`
    );
}
if(config.workloads.some(workload => !['latency','throughput'].includes(workload))){
    throw new Error('available workloads: throughput, latency');
}

function workloadSize(payloadBytes,workload){
    const frames=workloadOverrides[`${workload}Frames`];
    if(quick){
        return {
            frames:frames ?? (workload === 'throughput' ? 512 : 64),
            warmupFrames:workloadOverrides.warmupFrames ?? 32
        };
    }
    const defaults=payloadBytes <= 64
        ? {latency:2000,throughput:20000,warmup:1000}
        : payloadBytes <= 4096
            ? {latency:1000,throughput:10000,warmup:500}
            : {latency:200,throughput:1000,warmup:100};
    return {
        frames:frames ?? defaults[workload],
        warmupFrames:workloadOverrides.warmupFrames ?? defaults.warmup
    };
}

function deadline(promise,milliseconds,label){
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve,reject) => {
            timer=setTimeout(() => {
                reject(new Error(`${label} timed out after ${milliseconds}ms`));
            },milliseconds);
            timer.unref();
        })
    ]).finally(() => clearTimeout(timer));
}

function childExit(child){
    if(child.exitCode !== null || child.signalCode !== null){
        return Promise.resolve([child.exitCode,child.signalCode]);
    }
    return new Promise((resolve,reject) => {
        child.once('error',reject);
        child.once('exit',(code,signal) => resolve([code,signal]));
    });
}

async function terminateChild(child){
    if(!child || child.exitCode !== null || child.signalCode !== null){
        return;
    }
    if(child.stdin?.writable){
        child.stdin.end(`${JSON.stringify({type:'terminate'})}\n`);
    }
    try{
        await deadline(childExit(child),5000,'worker cooperative termination');
        return;
    }catch{}
    child.kill();
    try{
        await deadline(childExit(child),5000,'worker termination');
        return;
    }catch{}
    child.kill('SIGKILL');
    await deadline(childExit(child),5000,'worker forced termination');
}

async function inventory(root){
    const total={bytes:0,entries:0};
    async function visit(current){
        for(const entry of await readdir(current,{withFileTypes:true})){
            const target=path.join(current,entry.name);
            total.entries+=1;
            if(entry.isDirectory()){
                await visit(target);
            }else if(entry.isFile()){
                total.bytes+=(await lstat(target)).size;
            }
        }
    }
    await visit(root);
    return total;
}

function safeTemporaryRoot(root){
    const resolved=path.resolve(root);
    const parent=path.resolve(os.tmpdir());
    return path.dirname(resolved) === parent
        && path.basename(resolved).startsWith('node-ipc-competitor-');
}

async function runTrial(entry){
    const workload=workloadSize(entry.payloadBytes,entry.workload);
    const trial={
        ...entry,
        ...workload,
        probeFrames:config.probeFrames,
        timeoutMs:config.timeoutMs,
        windowBytes:config.windowBytes,
        windowMessages:config.windowMessages
    };
    const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-competitor-'));
    if(!safeTemporaryRoot(temporaryRoot)){
        throw new Error(`refusing unsafe temporary directory ${temporaryRoot}`);
    }
    let child;
    try{
        child=spawn(process.execPath,[path.join(directory,'worker.js'),JSON.stringify(trial)],{
            cwd:temporaryRoot,
            env:{
                ...process.env,
                TEMP:temporaryRoot,
                TMP:temporaryRoot,
                TMPDIR:temporaryRoot,
                WS_NO_BUFFER_UTIL:'1',
                WS_NO_UTF_8_VALIDATE:'1'
            },
            stdio:['pipe','pipe','pipe']
        });
        child.stdin.on('error',() => {});
        let stdout='';
        let stderr='';
        child.stdout.on('data',chunk => {
            stdout+=chunk.toString('utf8');
        });
        child.stderr.on('data',chunk => {
            stderr+=chunk.toString('utf8');
        });
        const [exitCode,signal]=await deadline(
            childExit(child),
            config.timeoutMs+10000,
            'worker'
        );
        let result;
        try{
            result=JSON.parse(stdout.trim());
        }catch(error){
            result={
                error:`invalid worker output: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`,
                status:'failed',
                subject:entry.subject
            };
        }
        const leftovers=await inventory(temporaryRoot);
        return {
            ...entry,
            ...result,
            subjectId:entry.subject,
            cleanup:{
                ...(result.cleanup ?? {}),
                temporaryBytes:leftovers.bytes,
                temporaryEntries:leftovers.entries,
                workerNaturalExit:exitCode === 0 && signal === null
            },
            worker:{exitCode,signal},
            workerStderr:stderr || null
        };
    }catch(error){
        return {
            ...entry,
            error:error.stack ?? String(error),
            status:'failed',
            subject:entry.subject,
            subjectId:entry.subject
        };
    }finally{
        let terminationError;
        try{
            await terminateChild(child);
        }catch(error){
            terminationError=error;
        }
        try{
            if(!safeTemporaryRoot(temporaryRoot)){
                throw new Error(`refusing unsafe temporary directory cleanup ${temporaryRoot}`);
            }
            await rm(temporaryRoot,{force:true,recursive:true});
        }finally{
            if(terminationError){
                throw terminationError;
            }
        }
    }
}

function groupSummary(samples){
    const summary=[];
    for(const subject of config.subjects){
        for(const payloadBytes of config.payloads){
            for(const workload of config.workloads){
                const cell=samples.filter(sample => sample.subjectId === subject
                    && sample.payloadBytes === payloadBytes
                    && sample.workload === workload);
                const successful=cell.filter(sample => sample.status === 'ok');
                const row={
                    failures:cell.length-successful.length,
                    payloadBytes,
                    samples:successful.length,
                    subject,
                    workload
                };
                if(successful.length){
                    row.coldStartNs=distribution(successful.map(sample => Number(sample.coldStartNs)));
                    row.roundTripsPerSecond=distribution(
                        successful.map(sample => sample.metrics.roundTripsPerSecond)
                    );
                    if(workload === 'throughput'){
                        row.applicationMiBPerSecond=distribution(
                            successful.map(sample => sample.metrics.applicationMiBPerSecond)
                        );
                    }else{
                        row.latencyNs={
                            p50:distribution(successful.map(sample => sample.metrics.latencyNs.p50Ns)),
                            p95:distribution(successful.map(sample => sample.metrics.latencyNs.p95Ns)),
                            p99:distribution(successful.map(sample => sample.metrics.latencyNs.p99Ns))
                        };
                    }
                }
                summary.push(row);
            }
        }
    }
    return summary;
}

function repositoryState(){
    try{
        const commit=execFileSync('git',['rev-parse','HEAD'],{
            cwd:repositoryRoot,
            encoding:'utf8'
        }).trim();
        const status=execFileSync('git',['status','--porcelain','--untracked-files=all'],{
            cwd:repositoryRoot,
            encoding:'utf8'
        });
        return {
            commit,
            dirty:Boolean(status.trim()),
            statusSha256:createHash('sha256').update(status).digest('hex')
        };
    }catch{
        return {commit:null,dirty:null,statusSha256:null};
    }
}

async function fileSha256(file){
    return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main(){
    const plan=buildPlan(config.subjects,config.payloads,config.workloads,config.samples);
    const samples=[];
    for(let index=0;index<plan.length;index+=1){
        const entry=plan[index];
        process.stderr.write(
            `[${index+1}/${plan.length}] ${entry.workload} ${entry.payloadBytes} B ${entry.subject}\n`
        );
        samples.push(await runTrial(entry));
    }
    const failures=samples.filter(sample => sample.status !== 'ok');
    const cleanupFailures=samples.filter(sample => sample.status === 'ok' && (
        sample.cleanup.naturalExit !== true
        || sample.cleanup.workerNaturalExit !== true
        || sample.cleanup.temporaryEntries !== 0
        || sample.cleanup.endpointClosed === false
        || sample.cleanup.endpointReusable === false
    ));
    const [complexity,dependencies,benchmarkLockSha256,rootLockSha256]=await Promise.all([
        complexityReport(),
        dependencyExposure(),
        fileSha256(path.join(directory,'package-lock.json')),
        fileSha256(path.join(repositoryRoot,'package-lock.json'))
    ]);
    const result={
        schemaVersion:1,
        id:`local-${new Date().toISOString().replace(/[-:.]/gu,'')}-${randomUUID()}`,
        generatedAt:new Date().toISOString(),
        classification:'local-snapshot-noisy',
        capabilities:{
            asOf,
            definitions:capabilityDefinitions,
            matrix:capabilities
        },
        catalog:{asOf,popularityWindow,sources,subjects:catalog},
        complexity,
        config,
        dependencyExposure:dependencies,
        evidence:{
            authority:'snapshot-noisy',
            commonContract:'exact canonical JSON request/echo in fresh two-process trials',
            rankingEligible:false,
            reasons:[
                'The native child channel, TCP, WebSocket, Socket.IO, and ZMTP transports have different semantics.',
                'Local host load, scheduler state, power state, and page cache are not controlled.',
                'Results are descriptive snapshots, not certification or a universal ranking.'
            ]
        },
        packageLocks:{benchmark:benchmarkLockSha256,repository:rootLockSha256},
        repository:repositoryState(),
        samples,
        summary:groupSummary(samples),
        system:{
            architecture:process.arch,
            cpu:{count:os.cpus().length,model:os.cpus()[0]?.model ?? 'unknown'},
            node:process.version,
            platform:process.platform,
            release:os.release(),
            totalMemoryBytes:os.totalmem()
        },
        validation:{
            cleanupFailures:cleanupFailures.length,
            complete:failures.length === 0 && cleanupFailures.length === 0,
            expectedSamples:plan.length,
            failedSamples:failures.length,
            successfulSamples:samples.length-failures.length
        }
    };
    const output=option('output',null);
    if(output){
        const target=path.resolve(output);
        await mkdir(path.dirname(target),{recursive:true});
        await writeFile(target,`${JSON.stringify(result,null,2)}\n`);
        process.stdout.write(`${JSON.stringify({
            complete:result.validation.complete,
            failedSamples:result.validation.failedSamples,
            output:target,
            successfulSamples:result.validation.successfulSamples
        })}\n`);
    }else{
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    if(!result.validation.complete){
        process.exitCode=1;
    }
}

await main();

export {
    config,
    groupSummary,
    runTrial,
    workloadSize
};
