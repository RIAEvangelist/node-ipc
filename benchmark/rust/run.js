#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFile,spawn,spawnSync} from 'node:child_process';
import {access,mkdir,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
    configurations,
    evidenceReasons,
    expectedWireBytes,
    peerSchema,
    resultSchema,
    samplePlan,
    sha256,
    summarize,
    validateResult
} from './lib.js';

const execute=promisify(execFile);
const directory=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(directory,'..','..');
const crateRoot=path.join(projectRoot,'rust','node-ipc');
const manifest=path.join(crateRoot,'Cargo.toml');
const nodePeer=path.join(crateRoot,'interop','node-peer.js');
const rustExample=path.join(crateRoot,'examples','tcp_roundtrip.rs');
const host='127.0.0.1';
const tempPrefix='node-ipc-rust-benchmark-';
const children=new Set;
const sockets=new Set;
const usedPorts=new Set;

if(!global.gc && process.env.NODE_IPC_RUST_BENCHMARK_GC !== '1'){
    const outcome=spawnSync(
        process.execPath,
        ['--expose-gc',fileURLToPath(import.meta.url),...process.argv.slice(2)],
        {
            env:{...process.env,NODE_IPC_RUST_BENCHMARK_GC:'1'},
            stdio:'inherit',
            windowsHide:true
        }
    );
    process.exit(outcome.status ?? 1);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode=1;
});

async function main(){
    const mode=parseMode(process.argv.slice(2));
    const config=configurations[mode];
    const repositoryBefore=await repositoryState();
    const generatedAt=new Date().toISOString();
    const tempRoot=await mkdtemp(path.join(os.tmpdir(),tempPrefix));
    let tempRootRemoved=false;
    let prepared;
    const samples=[];

    try{
        prepared=await prepare(tempRoot);
        const plan=samplePlan(config);
        for(const entry of plan){
            const trialDirectory=path.join(tempRoot,`trial-${entry.orderIndex}`);
            await mkdir(trialDirectory);
            samples.push(await runSample(entry,config,prepared.rustBinary,generatedAt,trialDirectory));
        }
        assert.equal(children.size,0,'benchmark child processes remain');
        assert.equal(sockets.size,0,'benchmark sockets remain');
    }finally{
        const cleanupErrors=[];
        try{await cleanupChildren(config.cleanupTimeoutMs);}catch(error){cleanupErrors.push(error);}
        try{await cleanupSockets();}catch(error){cleanupErrors.push(error);}
        try{await removeTempRoot(tempRoot);tempRootRemoved=true;}catch(error){cleanupErrors.push(error);}
        if(cleanupErrors.length) throw new AggregateError(cleanupErrors,'benchmark cleanup failed');
    }

    const repositoryAfter=await repositoryState();
    const repositoryChanged=repositoryBefore.commit !== repositoryAfter.commit
        || repositoryBefore.statusSha256 !== repositoryAfter.statusSha256;
    const idSource=[
        generatedAt,
        repositoryBefore.commit,
        process.platform,
        process.arch,
        process.version,
        prepared.runtime.rust.release
    ].join(':');
    const id=`run-${generatedAt.replaceAll(/[-:.]/gu,'')}-${sha256(idSource).slice(0,16)}`;
    const system=systemProvenance();
    const repository={
        capture:'pre-and-post-execution',
        commit:repositoryBefore.commit,
        dirty:repositoryBefore.dirty || repositoryAfter.dirty,
        changedDuringRun:repositoryChanged,
        preExecution:repositoryBefore,
        postExecution:repositoryAfter
    };
    const reasons=evidenceReasons(mode,repository,system.environment,prepared.runtime,system.platform);
    const publishable=mode === 'full' && reasons.length === 0;
    const result={
        schema:resultSchema,
        schemaVersion:1,
        id,
        generatedAt,
        record:{file:`${id}.json`,recordedAt:generatedAt},
        repository,
        system,
        runtime:prepared.runtime,
        packages:prepared.packages,
        subjects:prepared.subjects,
        config:{
            ...config,
            lanes:samplePlan({...config,samplesPerLane:1}).map(({id:lane}) => lane),
            peerSchema,
            transport:'tcp',
            rustProfile:'release'
        },
        evidence:{
            classification:mode === 'full' ? 'release-performance-snapshot' : 'smoke-only',
            performanceClaims:mode === 'full',
            publishable,
            rankingEligible:false,
            certification:false,
            reasons,
            notes:mode === 'full'
                ? ['hosted and local measurements remain environment-specific']
                : ['quick mode validates orchestration only; its timings are not performance evidence']
        },
        samples,
        summary:summarize(samples),
        cleanup:{
            activeProcesses:children.size,
            activeSockets:sockets.size,
            forcedProcesses:samples.reduce((total,sample) => total+sample.cleanup.forced.length,0),
            uniquePorts:usedPorts.size,
            tempEntries:tempRootRemoved ? 0 : await countEntries(tempRoot),
            tempRootRemoved,
            clean:tempRootRemoved && children.size === 0 && sockets.size === 0
                && samples.every((sample) => sample.cleanup.forced.length === 0)
        }
    };
    validateResult(result);
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}

function parseMode(arguments_){
    const modes=arguments_.filter((argument) => argument === '--full' || argument === '--quick');
    assert.equal(modes.length,1,'use exactly one of --full or --quick');
    assert.equal(arguments_.length,1,'unexpected benchmark argument');
    return modes[0].slice(2);
}

async function prepare(tempRoot){
    const cargo=await executable('cargo');
    const rustc=await executable('rustc');
    const buildTarget=path.join(tempRoot,'build');
    const packageTarget=path.join(tempRoot,'package');
    const commandEnvironment={...process.env,CARGO_TERM_COLOR:'never'};

    await command(cargo,[
        'build','--manifest-path',manifest,'--locked','--release',
        '--example','tcp_roundtrip','--target-dir',buildTarget
    ],{timeout:600_000,env:commandEnvironment});
    const rustBinary=path.join(buildTarget,'release','examples',`tcp_roundtrip${process.platform === 'win32' ? '.exe' : ''}`);
    await access(rustBinary);

    const npm=await npmInvocation();
    const [cargoOutput,rustOutput,npmOutput,packageListOutput,packageJson,cargoToml,cargoLock,nodePeerBytes,rustExampleBytes,packageLockBytes,rustBinaryBytes]=await Promise.all([
        command(cargo,['--version','--verbose'],{timeout:30_000,env:commandEnvironment}),
        command(rustc,['--version','--verbose'],{timeout:30_000,env:commandEnvironment}),
        command(npm.command,[...npm.prefix,'pack','--dry-run','--json','--ignore-scripts'],{timeout:120_000}),
        command(cargo,['package','--manifest-path',manifest,'--locked','--allow-dirty','--list'],{timeout:120_000,env:commandEnvironment}),
        readFile(path.join(projectRoot,'package.json')),
        readFile(manifest),
        readFile(path.join(crateRoot,'Cargo.lock')),
        readFile(nodePeer),
        readFile(rustExample),
        readFile(path.join(projectRoot,'package-lock.json')),
        readFile(rustBinary)
    ]);
    await command(cargo,[
        'package','--manifest-path',manifest,'--locked','--allow-dirty','--no-verify'
    ],{timeout:300_000,env:{...commandEnvironment,CARGO_TARGET_DIR:packageTarget}});

    const npmPackage=JSON.parse(npmOutput.stdout)[0];
    assert.ok(npmPackage,'npm pack returned no package');
    const rootPackage=JSON.parse(packageJson);
    const crateVersion=cargoToml.toString('utf8').match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
    assert.equal(npmPackage.version,rootPackage.version,'npm pack version differs');
    assert.equal(crateVersion,rootPackage.version,'crate and npm versions differ');
    const crateDirectory=path.join(packageTarget,'package');
    const crateFiles=(await readdir(crateDirectory)).filter((file) => file.endsWith('.crate'));
    assert.equal(crateFiles.length,1,'Cargo produced an unexpected crate inventory');
    const crateBytes=await readFile(path.join(crateDirectory,crateFiles[0]));
    const packageFiles=packageListOutput.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const rustFields=parseVersionOutput(rustOutput.stdout);
    const cargoFields=parseVersionOutput(cargoOutput.stdout);

    return {
        rustBinary,
        runtime:{
            node:{
                version:process.version,
                v8:process.versions.v8,
                uv:process.versions.uv,
                openssl:process.versions.openssl ?? null
            },
            rust:{
                version:rustOutput.stdout.split(/\r?\n/u)[0].trim(),
                release:rustFields.release,
                host:rustFields.host,
                commitHash:rustFields['commit-hash'] ?? null,
                llvmVersion:rustFields['LLVM version'] ?? null
            },
            cargo:{
                version:cargoOutput.stdout.split(/\r?\n/u)[0].trim(),
                release:cargoFields.release ?? cargoOutput.stdout.match(/cargo\s+([^\s]+)/u)?.[1]
            }
        },
        packages:{
            npm:{
                version:npmPackage.version,
                packedBytes:npmPackage.size,
                unpackedBytes:npmPackage.unpackedSize,
                fileCount:npmPackage.entryCount,
                sha1:npmPackage.shasum,
                integrity:npmPackage.integrity
            },
            crate:{
                version:crateVersion,
                packedBytes:crateBytes.length,
                fileCount:packageFiles.length,
                sha256:sha256(crateBytes)
            }
        },
        subjects:{
            node:{
                version:rootPackage.version,
                peerSha256:sha256(nodePeerBytes),
                packageJsonSha256:sha256(packageJson),
                packageLockSha256:sha256(packageLockBytes)
            },
            rust:{
                version:crateVersion,
                binarySha256:sha256(rustBinaryBytes),
                cargoTomlSha256:sha256(cargoToml),
                cargoLockSha256:sha256(cargoLock),
                exampleSha256:sha256(rustExampleBytes)
            }
        }
    };
}

async function runSample(plan,config,rustBinary,runNonce,trialDirectory){
    assert.equal(children.size,0,'a prior benchmark process remains');
    assert.equal(sockets.size,0,'a prior benchmark socket remains');
    const memoryBaseline=await baseline(config.baselineDelayMs);
    const port=await freshPort();
    const reservationId=sha256(`${runNonce}:${plan.orderIndex}:${port}`);
    const forced=[];
    const server=launchPeer(plan.server,'server',port,config,rustBinary,trialDirectory);
    let client;
    let sampler;

    try{
        const listening=await waitForRecord(server,(record) => record.status === 'listening',config.readyTimeoutMs);
        validateServerRecord(listening,plan.server,'listening',port,config);
        client=launchPeer(plan.client,'client',port,config,rustBinary,trialDirectory);
        sampler=startMemorySampler({client,server},config.memoryIntervalMs);
        const [clientOutcome,serverOutcome]=await Promise.all([
            waitForExit(client,config.sampleTimeoutMs),
            waitForExit(server,config.sampleTimeoutMs)
        ]);
        const memory=await sampler.stop();
        assertProcessSuccess(clientOutcome,client);
        assertProcessSuccess(serverOutcome,server);
        assert.equal(client.records.length,1,`${client.label}: expected one JSON record`);
        assert.equal(server.records.length,2,`${server.label}: expected listening and complete records`);
        const clientRecord=client.records[0];
        const complete=server.records[1];
        validateClientRecord(clientRecord,plan.client,port,config);
        validateServerRecord(complete,plan.server,'complete',port,config);
        await rebind(port);
        await collectGarbage();
        const trialEntries=await countEntries(trialDirectory);
        assert.equal(trialEntries,0,'peer left temporary files');
        await removeTrialDirectory(trialDirectory);
        const expectedBytes=expectedWireBytes(config.count,config.payloadBytes);
        const durationNs=numberAsBigInt(clientRecord.duration_ns,'client duration');
        const derivedBytes=clientRecord.wire_bytes_per_second*Number(durationNs)/1e9;
        const derivedCount=clientRecord.round_trips_per_second*Number(durationNs)/1e9;
        assert.ok(Math.abs(derivedBytes-expectedBytes)<=1,'reported wire rate does not reconstruct exact bytes');
        assert.ok(Math.abs(derivedCount-config.count)<=1,'reported throughput does not reconstruct exact count');
        const sample={
            orderIndex:plan.orderIndex,
            round:plan.round,
            lane:plan.id,
            client:plan.client,
            server:plan.server,
            metrics:{
                durationNs:String(durationNs),
                roundTripsPerSecond:clientRecord.round_trips_per_second,
                wireBytes:String(expectedBytes),
                wireBytesPerSecond:clientRecord.wire_bytes_per_second,
                latencyNs:clientRecord.latency_ns
            },
            memory:{
                method:memory.method,
                peakKind:'sampled-maximum',
                intervalMs:config.memoryIntervalMs,
                clientSampledPeakRssBytes:memory.peaks.client,
                serverSampledPeakRssBytes:memory.peaks.server,
                clientPostExitRssBytes:null,
                serverPostExitRssBytes:null,
                clientGoneAfterExit:!await processExists(client.pid),
                serverGoneAfterExit:!await processExists(server.pid),
                samplerErrors:memory.errors,
                parentBeforeGcRssBytes:memoryBaseline.beforeGc,
                parentAfterGcRssBytes:memoryBaseline.afterGc,
                parentPostCleanupRssBytes:process.memoryUsage().rss,
                systemFreeBeforeBytes:memoryBaseline.systemFree,
                systemFreePostCleanupBytes:os.freemem()
            },
            exact:{
                peerSchema,
                host:'loopback-ipv4',
                portReservationId:reservationId,
                portReserved:true,
                reservationReleasedBeforeServer:true,
                serverListening:true,
                serverComplete:true,
                clientComplete:true,
                serverFrames:complete.frames,
                clientCount:clientRecord.count,
                payloadBytes:clientRecord.payload_bytes,
                inflight:clientRecord.inflight
            },
            cleanup:{
                clientNaturalExit:true,
                serverNaturalExit:true,
                forced,
                portRebound:true,
                tempEntriesBeforeRemoval:trialEntries,
                tempRemoved:true,
                activeProcesses:children.size,
                activeSockets:sockets.size
            }
        };
        assert.equal(sample.memory.clientGoneAfterExit,true,'client process remains after exit');
        assert.equal(sample.memory.serverGoneAfterExit,true,'server process remains after exit');
        return sample;
    }finally{
        const cleanupErrors=[];
        if(sampler) try{await sampler.stop();}catch(error){cleanupErrors.push(error);}
        if(client) try{if(await stopPeer(client,config.cleanupTimeoutMs)) forced.push('client');}catch(error){cleanupErrors.push(error);}
        try{if(await stopPeer(server,config.cleanupTimeoutMs)) forced.push('server');}catch(error){cleanupErrors.push(error);}
        if(cleanupErrors.length) throw new AggregateError(cleanupErrors,'sample cleanup failed');
    }
}

function launchPeer(language,role,port,config,rustBinary,trialDirectory){
    const common=[
        '--mode',role,
        '--host',host,
        '--port',String(port),
        '--warmup',String(config.warmup),
        '--count',String(config.count),
        '--payload-bytes',String(config.payloadBytes),
        '--inflight',String(config.inflight),
        '--json'
    ];
    const commandName=language === 'node' ? process.execPath : rustBinary;
    const arguments_=language === 'node' ? [nodePeer,...common] : common;
    const child=spawn(commandName,arguments_,{
        cwd:projectRoot,
        env:{
            ...process.env,
            NODE_NO_WARNINGS:'1',
            TEMP:trialDirectory,
            TMP:trialDirectory,
            TMPDIR:trialDirectory
        },
        stdio:['ignore','pipe','pipe'],
        windowsHide:true
    });
    const wrapper={
        child,
        pid:child.pid,
        label:`${language}-${role}`,
        language,
        role,
        records:[],
        parseErrors:[],
        stderr:[],
        listeners:new Set,
        closed:false,
        launchError:null,
        stdoutBuffer:''
    };
    children.add(wrapper);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',(chunk) => consumeOutput(wrapper,chunk));
    child.stderr.on('data',(chunk) => wrapper.stderr.push(chunk));
    child.once('error',(error) => {wrapper.launchError=error;});
    wrapper.exit=new Promise((resolve) => {
        child.once('close',(code,signal) => {
            if(wrapper.stdoutBuffer.trim()) consumeLine(wrapper,wrapper.stdoutBuffer.trim());
            wrapper.stdoutBuffer='';
            wrapper.closed=true;
            children.delete(wrapper);
            resolve({code,signal,error:wrapper.launchError});
        });
    });
    return wrapper;
}

function consumeOutput(wrapper,chunk){
    wrapper.stdoutBuffer+=chunk;
    for(let boundary=wrapper.stdoutBuffer.indexOf('\n');boundary !== -1;boundary=wrapper.stdoutBuffer.indexOf('\n')){
        const line=wrapper.stdoutBuffer.slice(0,boundary).trim();
        wrapper.stdoutBuffer=wrapper.stdoutBuffer.slice(boundary+1);
        if(line) consumeLine(wrapper,line);
    }
}

function consumeLine(wrapper,line){
    try{
        const record=JSON.parse(line);
        wrapper.records.push(record);
        for(const listener of wrapper.listeners) listener(record);
    }catch(error){
        wrapper.parseErrors.push(`${error.message}: ${line.slice(0,200)}`);
    }
}

function waitForRecord(wrapper,predicate,timeout){
    const existing=wrapper.records.find(predicate);
    if(existing) return Promise.resolve(existing);
    return new Promise((resolve,reject) => {
        let finished=false;
        const timer=setTimeout(() => finish(new Error(`${wrapper.label} readiness timed out`)),timeout);
        const listener=(record) => {
            if(predicate(record)) finish(null,record);
        };
        wrapper.listeners.add(listener);
        wrapper.exit.then((outcome) => finish(new Error(
            `${wrapper.label} exited before readiness (code ${outcome.code}, signal ${outcome.signal || 'none'})`
        )));
        function finish(error,value){
            if(finished) return;
            finished=true;
            clearTimeout(timer);
            wrapper.listeners.delete(listener);
            if(error) reject(error);
            else resolve(value);
        }
    });
}

async function waitForExit(wrapper,timeout){
    let timer;
    const outcome=await Promise.race([
        wrapper.exit,
        new Promise((resolve) => {timer=setTimeout(() => resolve(null),timeout);})
    ]).finally(() => clearTimeout(timer));
    if(!outcome) throw new Error(`${wrapper.label} timed out after ${timeout} ms`);
    return outcome;
}

function assertProcessSuccess(outcome,wrapper){
    assert.equal(outcome.error,null,`${wrapper.label}: ${outcome.error?.message || 'launch error'}`);
    assert.equal(outcome.code,0,`${wrapper.label}: exit code ${outcome.code}; ${wrapper.stderr.join('').trim()}`);
    assert.equal(outcome.signal,null,`${wrapper.label}: signal ${outcome.signal}`);
    assert.deepEqual(wrapper.parseErrors,[],`${wrapper.label}: invalid JSON output`);
    assert.equal(wrapper.stderr.join('').trim(),'',`${wrapper.label}: unexpected stderr`);
}

function validateServerRecord(record,language,status,port,config){
    assert.equal(record.schema,peerSchema,'server peer schema differs');
    assert.equal(record.language,language,'server language differs');
    assert.equal(record.role,'server','server role differs');
    assert.equal(record.status,status,'server status differs');
    assert.equal(record.host,host,'server host differs');
    assert.equal(record.port,port,'server port differs');
    if(status === 'listening'){
        assert.equal(record.frames,0,'listening server frames differ');
        assert.equal(record.duration_ns,0,'listening server duration differs');
    }else{
        assert.equal(record.frames,config.warmup+config.count,'server frame count differs');
        assert.ok(Number(record.duration_ns)>0,'server duration differs');
    }
}

function validateClientRecord(record,language,port,config){
    assert.equal(record.schema,peerSchema,'client peer schema differs');
    assert.equal(record.language,language,'client language differs');
    assert.equal(record.role,'client','client role differs');
    assert.equal(record.host,host,'client host differs');
    assert.equal(record.port,port,'client port differs');
    assert.equal(record.warmup,config.warmup,'client warmup differs');
    assert.equal(record.count,config.count,'client count differs');
    assert.equal(record.payload_bytes,config.payloadBytes,'client payload differs');
    assert.equal(record.inflight,config.inflight,'client inflight differs');
    numberAsBigInt(record.duration_ns,'client duration');
    assert.ok(Number.isFinite(record.round_trips_per_second) && record.round_trips_per_second>0,'client throughput differs');
    assert.ok(Number.isFinite(record.wire_bytes_per_second) && record.wire_bytes_per_second>0,'client wire rate differs');
    const latency=record.latency_ns;
    for(const key of ['mean','p50','p95','p99','max']) assert.ok(Number.isFinite(latency?.[key]) && latency[key]>=0,`client latency ${key} differs`);
    assert.ok(latency.p50<=latency.p95 && latency.p95<=latency.p99 && latency.p99<=latency.max,'client latency order differs');
}

async function freshPort(){
    for(let attempt=0;attempt<32;attempt++){
        const server=net.createServer();
        sockets.add(server);
        await listen(server,0);
        const address=server.address();
        assert.ok(address && typeof address === 'object','port reservation returned no address');
        const {port}=address;
        await close(server);
        sockets.delete(server);
        if(!usedPorts.has(port)){
            usedPorts.add(port);
            return port;
        }
    }
    throw new Error('could not reserve a fresh TCP port');
}

async function rebind(port){
    const server=net.createServer();
    sockets.add(server);
    try{
        await listen(server,port);
    }finally{
        await close(server);
        sockets.delete(server);
    }
}

function listen(server,port){
    return new Promise((resolve,reject) => {
        const fail=(error) => {server.off('listening',ready);reject(error);};
        const ready=() => {server.off('error',fail);resolve();};
        server.once('error',fail);
        server.once('listening',ready);
        server.listen({host,port,exclusive:true});
    });
}

function close(server){
    return new Promise((resolve,reject) => {
        if(!server.listening){resolve();return;}
        server.close((error) => error ? reject(error) : resolve());
    });
}

async function baseline(delay){
    const beforeGc=process.memoryUsage().rss;
    await collectGarbage();
    if(delay) await new Promise((resolve) => setTimeout(resolve,delay));
    await collectGarbage();
    return {beforeGc,afterGc:process.memoryUsage().rss,systemFree:os.freemem()};
}

async function collectGarbage(){
    global.gc?.();
    await new Promise((resolve) => setImmediate(resolve));
    global.gc?.();
}

function startMemorySampler(processes,intervalMs){
    const peaks={client:null,server:null};
    let errors=0;
    let stopped=false;
    let timer;
    let current=Promise.resolve();
    const tick=async() => {
        const pids=Object.fromEntries(Object.entries(processes).map(([role,wrapper]) => [role,wrapper.pid]));
        try{
            const values=await readMemory(pids);
            for(const [role,value] of Object.entries(values)){
                if(value !== null) peaks[role]=Math.max(peaks[role] ?? 0,value);
            }
        }catch{
            errors++;
        }
    };
    const schedule=() => {
        if(stopped) return;
        current=tick().finally(() => {
            if(!stopped) timer=setTimeout(schedule,intervalMs);
        });
    };
    schedule();
    return {
        async stop(){
            if(!stopped){
                stopped=true;
                clearTimeout(timer);
                await current;
            }
            return {method:memoryMethod(),peaks,errors};
        }
    };
}

async function readMemory(pids){
    if(process.platform === 'linux'){
        const entries=await Promise.all(Object.entries(pids).map(async([role,pid]) => {
            try{
                const status=await readFile(`/proc/${pid}/status`,'utf8');
                const kib=Number(status.match(/^VmRSS:\s+([0-9]+)\s+kB$/mu)?.[1]);
                return [role,Number.isFinite(kib) && kib>0 ? kib*1024 : null];
            }catch(error){
                if(error.code === 'ENOENT') return [role,null];
                throw error;
            }
        }));
        return Object.fromEntries(entries);
    }
    if(process.platform === 'darwin'){
        const entries=Object.entries(pids);
        const output=await command('/bin/ps',['-o','pid=,rss=','-p',entries.map(([,pid]) => pid).join(',')],{timeout:5_000,allowExit1:true});
        const byPid=new Map(output.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
            const [pid,kib]=line.trim().split(/\s+/u).map(Number);
            return [pid,kib*1024];
        }));
        return Object.fromEntries(entries.map(([role,pid]) => [role,byPid.get(pid) ?? null]));
    }
    if(process.platform === 'win32'){
        const entries=Object.entries(pids);
        const powershell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        const ids=entries.map(([,pid]) => pid).join(',');
        const script=`Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ($_.Id.ToString() + ' ' + $_.WorkingSet64.ToString()) }`;
        const output=await command(powershell,['-NoProfile','-NonInteractive','-Command',script],{timeout:5_000,allowExit1:true});
        const byPid=new Map(output.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
            const [pid,bytes]=line.trim().split(/\s+/u).map(Number);
            return [pid,bytes];
        }));
        return Object.fromEntries(entries.map(([role,pid]) => [role,byPid.get(pid) ?? null]));
    }
    return Object.fromEntries(Object.keys(pids).map((role) => [role,null]));
}

function memoryMethod(){
    return {linux:'procfs-vmrss',darwin:'ps-rss',win32:'powershell-workingset'}[process.platform] ?? 'unavailable';
}

async function processExists(pid){
    if(!Number.isInteger(pid) || pid<=0) return false;
    try{process.kill(pid,0);return true;}catch{return false;}
}

async function stopPeer(wrapper,timeout){
    if(!wrapper || wrapper.closed) return false;
    wrapper.child.kill('SIGTERM');
    let timer;
    const graceful=await Promise.race([
        wrapper.exit.then(() => true),
        new Promise((resolve) => {timer=setTimeout(() => resolve(false),timeout);})
    ]).finally(() => clearTimeout(timer));
    if(graceful) return true;
    if(process.platform === 'win32'){
        await command('taskkill',['/PID',String(wrapper.pid),'/T','/F'],{timeout:timeout,allowExit1:true});
    }else{
        wrapper.child.kill('SIGKILL');
    }
    let reapTimer;
    const reaped=await Promise.race([
        wrapper.exit.then(() => true),
        new Promise((resolve) => {reapTimer=setTimeout(() => resolve(false),timeout);})
    ]).finally(() => clearTimeout(reapTimer));
    if(!reaped) throw new Error(`${wrapper.label} did not close after forced termination`);
    return true;
}

async function cleanupChildren(timeout){
    await Promise.all([...children].map((wrapper) => stopPeer(wrapper,timeout)));
}

async function cleanupSockets(){
    await Promise.all([...sockets].map(async(server) => {
        try{await close(server);}finally{sockets.delete(server);}
    }));
}

async function removeTempRoot(tempRoot){
    const resolved=path.resolve(tempRoot);
    const base=`${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolved.startsWith(base),'temporary root escaped the system temporary directory');
    assert.ok(path.basename(resolved).startsWith(tempPrefix),'temporary root prefix differs');
    await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    try{
        await access(resolved);
        throw new Error('temporary benchmark root remains');
    }catch(error){
        if(error.code !== 'ENOENT') throw error;
    }
}

async function removeTrialDirectory(trialDirectory){
    const resolved=path.resolve(trialDirectory);
    assert.ok(path.basename(resolved).startsWith('trial-'),'trial directory name differs');
    await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    try{await access(resolved);throw new Error('trial directory remains');}
    catch(error){if(error.code !== 'ENOENT') throw error;}
}

async function countEntries(root){
    try{return (await readdir(root,{recursive:true})).length;}catch(error){if(error.code === 'ENOENT') return 0;throw error;}
}

async function executable(name){
    const configured=process.env[name.toUpperCase()];
    if(configured) return configured;
    const home=process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
    if(home){
        const candidate=path.join(home,'.cargo','bin',`${name}${process.platform === 'win32' ? '.exe' : ''}`);
        try{await access(candidate);return candidate;}catch{}
    }
    return name;
}

async function npmInvocation(){
    const candidates=[
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),
        path.resolve(path.dirname(process.execPath),'..','lib','node_modules','npm','bin','npm-cli.js')
    ].filter(Boolean);
    for(const candidate of candidates){
        try{await access(candidate);return {command:process.execPath,prefix:[candidate]};}catch{}
    }
    return {command:process.platform === 'win32' ? 'npm.cmd' : 'npm',prefix:[]};
}

async function command(commandName,arguments_,options={}){
    try{
        const result=await execute(commandName,arguments_,{
            cwd:options.cwd ?? projectRoot,
            encoding:'utf8',
            env:options.env ?? process.env,
            maxBuffer:64*1024*1024,
            timeout:options.timeout ?? 60_000,
            windowsHide:true
        });
        return result;
    }catch(error){
        if(options.allowExit1 && error.code === 1) return {stdout:error.stdout ?? '',stderr:error.stderr ?? ''};
        throw new Error(`${path.basename(commandName)} ${arguments_.join(' ')} failed: ${error.stderr || error.message}`);
    }
}

async function repositoryState(){
    const [{stdout:commit},{stdout:status}]=await Promise.all([
        command('git',['rev-parse','HEAD'],{timeout:30_000}),
        command('git',['status','--porcelain','--untracked-files=all'],{timeout:30_000})
    ]);
    const lines=status.trim() ? status.trimEnd().split(/\r?\n/u) : [];
    return {
        capturedAt:new Date().toISOString(),
        commit:commit.trim(),
        dirty:lines.length>0,
        changedEntries:lines.length,
        statusSha256:sha256(status)
    };
}

function systemProvenance(){
    const cpus=os.cpus();
    const environment={
        provider:process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
        githubRepository:process.env.GITHUB_REPOSITORY ?? null,
        imageOS:process.env.ImageOS ?? null,
        imageVersion:process.env.ImageVersion ?? null,
        osLane:process.env.NODE_IPC_RUST_BENCHMARK_OS_LANE ?? null,
        nodeLane:process.env.NODE_IPC_RUST_BENCHMARK_NODE_LANE ?? null,
        runId:process.env.GITHUB_RUN_ID ?? null,
        runAttempt:process.env.GITHUB_RUN_ATTEMPT ?? null,
        runnerArchitecture:process.env.RUNNER_ARCH ?? null,
        runnerEnvironment:process.env.RUNNER_ENVIRONMENT ?? null,
        sourceRef:process.env.GITHUB_REF ?? null,
        sourceSha:process.env.GITHUB_SHA ?? null,
        workflow:process.env.GITHUB_WORKFLOW ?? null,
        workflowRef:process.env.GITHUB_WORKFLOW_REF ?? null,
        workflowSha:process.env.GITHUB_WORKFLOW_SHA ?? null
    };
    return {
        platform:process.platform,
        release:os.release(),
        architecture:process.arch,
        cpu:{model:cpus[0]?.model?.trim() || 'unknown',count:cpus.length},
        totalMemoryBytes:os.totalmem(),
        machine:{id:sha256([os.hostname(),process.platform,process.arch,cpus[0]?.model || ''].join(':'))},
        environment
    };
}

function parseVersionOutput(output){
    const fields={};
    for(const line of output.trim().split(/\r?\n/u)){
        const boundary=line.indexOf(':');
        if(boundary !== -1) fields[line.slice(0,boundary).trim()]=line.slice(boundary+1).trim();
    }
    return fields;
}

function numberAsBigInt(value,label){
    const text=String(value);
    assert.match(text,/^[1-9][0-9]*$/u,`${label} is not a positive integer`);
    return BigInt(text);
}
