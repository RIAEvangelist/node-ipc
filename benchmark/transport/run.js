import {execFileSync,fork,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {lstat,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lineMessages} from '../oracle/line-messages.js';
import {commit as legacyCommit,tag as legacyTag} from './prepare-v12.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(directory,'../..');
const transportOrder=['local','tcp','tls','udp4','udp6'];
const versionOrder=['legacy-v12','current'];

function value(name,fallback){
    const prefix=`--${name}=`;
    return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function integer(name,fallback){
    const parsed=Number(value(name,fallback));
    if(!Number.isSafeInteger(parsed) || parsed<1) throw new Error(`--${name} must be a positive integer`);
    return parsed;
}

function deadline(promise,milliseconds,label){
    let timer;
    return Promise.race([
        promise,
        new Promise((_,reject) => {
            timer=setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)),milliseconds);
            timer.unref();
        })
    ]).finally(() => clearTimeout(timer));
}

function message(child,type,timeout){
    return deadline(new Promise((resolve,reject) => {
        const receive=(entry) => {
            if(entry.type === 'error' || entry.type === 'socket-error'){
                clean();
                reject(new Error(entry.error));
            }else if(entry.type === type){
                clean();
                resolve(entry);
            }
        };
        const exit=(code,signal) => {
            clean();
            reject(new Error(`child exited before ${type}: code=${code} signal=${signal}: ${child.benchmarkStderr || ''}`));
        };
        const clean=() => {
            child.off('message',receive);
            child.off('exit',exit);
        };
        child.on('message',receive);
        child.once('exit',exit);
    }),timeout,type);
}

function captureErrors(child){
    child.benchmarkStderr='';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data',(chunk) => child.benchmarkStderr+=chunk);
    return child;
}

async function childExit(child,timeout){
    if(child.exitCode !== null || child.signalCode !== null) return [child.exitCode,child.signalCode];
    return deadline(once(child,'exit'),timeout,'child exit');
}

async function terminate(child){
    if(!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await childExit(child,1000).catch(async () => {
        child.kill('SIGKILL');
        await childExit(child,1000).catch(() => {});
    });
}

function trialEnvironment(root){
    return {...process.env,TEMP:root,TMP:root,TMPDIR:root};
}

async function inventory(root){
    const result={bytes:0,entries:0};
    async function visit(current){
        for(const entry of await readdir(current,{withFileTypes:true})){
            const target=path.join(current,entry.name);
            result.entries+=1;
            if(entry.isDirectory()) await visit(target);
            else result.bytes+=(await lstat(target)).size;
        }
    }
    await visit(root);
    return result;
}

function localEndpoint(trial){
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\node-ipc-benchmark-${randomUUID()}`
        : path.join(trial,'node-ipc.sock');
}

function datagramEndpointReleased(transport,endpoint){
    const socket=dgram.createSocket(transport);
    return new Promise((resolve) => {
        let settled=false;
        const finish=(released) => {
            if(settled) return;
            settled=true;
            socket.removeAllListeners('error');
            try{socket.close(() => resolve(released));}catch{resolve(released);}
        };
        socket.once('error',() => finish(false));
        socket.bind(endpoint.port,endpoint.host,() => finish(true));
    });
}

async function cDatagramOracle(){
    const oracleDirectory=path.resolve(directory,'../oracle');
    const binary=path.join(oracleDirectory,'bin',process.platform === 'win32' ? 'raw-echo.exe' : 'raw-echo');
    const build=JSON.parse(await readFile(path.join(oracleDirectory,'bin','build.json'),'utf8'));
    const [binarySha256,sourceSha256]=await Promise.all([
        sha256(binary),
        sha256(path.join(oracleDirectory,'echo.c'))
    ]);
    if(build.binarySha256 !== binarySha256 || build.sourceSha256 !== sourceSha256){
        throw new Error('standard-C oracle build hashes do not match its source and binary');
    }
    if(build.target?.architecture !== process.arch || build.target?.platform !== process.platform){
        throw new Error('standard-C oracle target differs from the current runtime');
    }
    return {
        binary,
        evidence:{
            implementation:'standard-c-datagram-reflector',
            build:{
                binarySha256,
                compiler:path.basename(build.compiler),
                flags:build.flags,
                sourceSha256,
                target:build.target,
                version:build.version
            }
        }
    };
}

function normalizeCOracle(entry){
    if(!Number.isFinite(entry.measuredCpuSeconds) || entry.measuredCpuSeconds<0){
        throw new Error('standard-C oracle did not report measured CPU time');
    }
    if(!/^\d+$/u.test(String(entry.measuredWallNs))){
        throw new Error('standard-C oracle did not report measured wall time');
    }
    return {
        cleanup:{
            activeHandles:[],
            activeResourceDelta:[],
            clean:entry.activeSocketsAfterClose === 0,
            endpointRemoved:false,
            observedActiveResources:[],
            openSockets:entry.activeSocketsAfterClose,
            pendingSends:0
        },
        cpu:{user:Math.round(entry.measuredCpuSeconds*1000000),system:0},
        stats:{
            bytesIn:entry.bytesIn,
            bytesOut:entry.bytesOut,
            messagesIn:entry.messagesIn,
            messagesOut:entry.messagesOut,
            pendingSends:0
        },
        wallNs:entry.measuredWallNs
    };
}

async function runTrial(options,subject,transport,pairIndex,orderIndex){
    const trial=await mkdtemp(path.join(os.tmpdir(),'node-ipc-transport-'));
    const endpointPath=transport === 'local' ? localEndpoint(trial) : null;
    const host=transport === 'udp6' ? '::1' : '127.0.0.1';
    const nativeDatagram=transport.startsWith('udp') && options.datagramOracle;
    const totalFrames=options.probeFrames+options.warmupFrames+options.measuredFrames;
    const reflector=nativeDatagram
        ? captureErrors(spawn(options.datagramOracle.binary,[
            '--host',host,
            '--port','0',
            '--transport',transport,
            '--messages',String(totalFrames),
            '--measure-after',String(options.probeFrames+options.warmupFrames)
        ],{
            cwd:trial,
            env:trialEnvironment(trial),
            stdio:['ignore','pipe','pipe'],
            windowsHide:true
        }))
        : captureErrors(fork(path.join(directory,'reflector.js'),[JSON.stringify({
            certificates:options.certificates,
            endpointPath,
            host,
            transport
        })],{
            cwd:trial,
            env:trialEnvironment(trial),
            execArgv:[],
            silent:true
        }));
    const oracleMessage=nativeDatagram ? lineMessages(reflector,options.timeoutMs,'standard-C datagram oracle') : null;
    let worker;
    let ready;
    let workerResult;
    let workerProcessExit;
    let oracleEnd;
    let oracleProcessExit;
    let leftovers;
    try{
        ready=nativeDatagram
            ? await oracleMessage('ready')
            : await message(reflector,'ready',options.timeoutMs);
        worker=captureErrors(fork(path.join(directory,'worker.js'),[JSON.stringify({
            certificates:options.certificates,
            endpoint:ready.endpoint ?? {host:ready.host,port:ready.port},
            measuredFrames:options.measuredFrames,
            payloadBytes:options.payloadBytes,
            probeFrames:options.probeFrames,
            root:subject.root,
            transport,
            udpWindow:options.udpWindow,
            version:subject.id,
            warmupFrames:options.warmupFrames
        })],{
            cwd:trial,
            env:trialEnvironment(trial),
            execArgv:['--expose-gc'],
            silent:true
        }));
        const measureStart=message(worker,'measure-start',options.timeoutMs);
        await measureStart;
        if(!nativeDatagram){
            const measureReady=message(reflector,'measure-ready',options.timeoutMs);
            reflector.send('measure');
            await measureReady;
        }
        const resultMessage=message(worker,'result',options.timeoutMs);
        worker.send('measure-ready');
        workerResult=(await resultMessage).result;
        workerProcessExit=await childExit(worker,options.timeoutMs);
        if(nativeDatagram){
            oracleEnd=normalizeCOracle(await oracleMessage('cleanup'));
        }else{
            const cleanup=message(reflector,'cleanup',options.timeoutMs);
            reflector.send('close');
            oracleEnd=await cleanup;
        }
        oracleProcessExit=await childExit(reflector,options.timeoutMs);
        if(transport.startsWith('udp')){
            const natural=oracleProcessExit[0] === 0 && !oracleProcessExit[1];
            oracleEnd.cleanup.endpointRemoved=natural && await datagramEndpointReleased(transport,{
                host:ready.endpoint?.host ?? ready.host,
                port:ready.endpoint?.port ?? ready.port
            });
            oracleEnd.cleanup.clean=oracleEnd.cleanup.clean && oracleEnd.cleanup.endpointRemoved;
        }
        leftovers=await inventory(trial);
    }catch(error){
        await terminate(worker);
        await terminate(reflector);
        throw error;
    }finally{
        leftovers??=await inventory(trial).catch(() => ({bytes:0,entries:0}));
        await rm(trial,{force:true,recursive:true});
    }

    const workerNaturalExit=workerProcessExit[0] === 0 && !workerProcessExit[1];
    const oracleNaturalExit=oracleProcessExit[0] === 0 && !oracleProcessExit[1];
    const cpuMicroseconds=oracleEnd.cpu.user+oracleEnd.cpu.system;
    const cpuToWallRatio=cpuMicroseconds/(Number(workerResult.metrics.elapsedNs)/1000);
    const oracleBytesVerified=oracleEnd.stats.bytesIn === workerResult.exact.totalWireBytes
        && oracleEnd.stats.bytesOut === workerResult.exact.totalWireBytes;
    const datagramCountsVerified=!transport.startsWith('udp') || (
        oracleEnd.stats.messagesIn === options.probeFrames+options.warmupFrames+options.measuredFrames
        && oracleEnd.stats.messagesOut === oracleEnd.stats.messagesIn
    );
    const clean=workerResult.cleanup.clean
        && oracleEnd.cleanup.clean
        && workerNaturalExit
        && oracleNaturalExit
        && leftovers.entries === 0
        && oracleBytesVerified
        && datagramCountsVerified;

    return {
        transport,
        oracle:options.oracleByTransport[transport],
        securityMode:transport === 'tls' ? 'encryption-only' : 'plaintext',
        pairIndex,
        orderIndex,
        version:subject.id,
        rootVersion:workerResult.rootVersion,
        metrics:{
            ...workerResult.metrics,
            oracleCpuMicroseconds:cpuMicroseconds,
            oracleCpuToWallRatio:cpuToWallRatio,
            oracleSaturated:cpuToWallRatio>=0.9,
            oracleWallNs:oracleEnd.wallNs
        },
        exact:{
            ...workerResult.exact,
            datagramCountsVerified,
            oracleBytesIn:oracleEnd.stats.bytesIn,
            oracleBytesOut:oracleEnd.stats.bytesOut,
            oracleBytesVerified
        },
        memory:workerResult.memory,
        cleanup:{
            ...workerResult.cleanup,
            activeHandles:[
                ...workerResult.cleanup.activeResourceDelta,
                ...oracleEnd.cleanup.activeResourceDelta
            ],
            clean,
            endpointRemoved:oracleEnd.cleanup.endpointRemoved,
            leftovers,
            oracleActiveResourceDelta:oracleEnd.cleanup.activeResourceDelta,
            oracleNaturalExit,
            reflectorClosed:oracleEnd.cleanup.openSockets === 0,
            workerNaturalExit
        }
    };
}

function median(values){
    const sorted=[...values].sort((left,right) => left-right);
    return sorted[Math.floor(sorted.length/2)];
}

function summarize(samples){
    return transportOrder.filter((transport) => samples.some((sample) => sample.transport === transport)).map((transport) => {
        const medians=Object.fromEntries(versionOrder.map((version) => {
            const values=samples
                .filter((sample) => sample.transport === transport && sample.version === version)
                .map((sample) => sample.metrics.millisecondsPerMillion);
            return [version,{medianMillisecondsPerMillion:median(values),samples:values.length}];
        }));
        const legacy=medians['legacy-v12'].medianMillisecondsPerMillion;
        const current=medians.current.medianMillisecondsPerMillion;
        return {
            transport,
            versions:medians,
            deltaMillisecondsPerMillion:current-legacy,
            deltaPercent:(current/legacy-1)*100
        };
    });
}

async function sha256(file){
    return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function subject(id,root,commit){
    const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
    return {
        id,
        root,
        version:manifest.version,
        commit,
        packageLockSha256:await sha256(path.join(root,'package-lock.json'))
    };
}

function repositoryState(root){
    try{
        const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
        const dirty=execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}).trim().length>0;
        return {commit,dirty};
    }catch{return {commit:null,dirty:null};}
}

async function runBenchmark(input={}){
    const quick=input.quick ?? process.argv.includes('--quick');
    const currentRoot=path.resolve(input.currentRoot ?? value('current-root',repositoryRoot));
    const legacyInput=input.legacyRoot ?? value('legacy-root',quick ? currentRoot : '');
    if(!legacyInput) throw new Error('--legacy-root is required for a full run');
    const legacyRoot=path.resolve(legacyInput);
    const transports=input.transports ?? value('transports',transportOrder.join(',')).split(',').filter(Boolean);
    if(transports.some((transport) => !transportOrder.includes(transport))){
        throw new Error(`available transports: ${transportOrder.join(', ')}`);
    }
    const state=repositoryState(currentRoot);
    const subjects={
        'legacy-v12':await subject('legacy-v12',legacyRoot,legacyCommit),
        current:await subject('current',currentRoot,state.commit)
    };
    if(!quick && subjects['legacy-v12'].version !== legacyTag){
        throw new Error(`legacy root must contain node-ipc ${legacyTag}`);
    }
    const udpOracle=input.udpOracle ?? value('udp-oracle',quick ? 'node' : 'c');
    if(!['c','node'].includes(udpOracle)) throw new Error('available UDP oracles: node, c');
    const datagramOracle=udpOracle === 'c' ? await cDatagramOracle() : null;
    const nodeOracle={implementation:'node-byte-reflector',runtime:process.version};
    const datagramOracleName=datagramOracle ? datagramOracle.evidence.implementation : nodeOracle.implementation;
    const oracleByTransport=Object.fromEntries(transports.map((transport) => [
        transport,
        transport.startsWith('udp') ? datagramOracleName : nodeOracle.implementation
    ]));
    const oracles={
        [nodeOracle.implementation]:nodeOracle,
        ...(datagramOracle ? {[datagramOracle.evidence.implementation]:datagramOracle.evidence} : {})
    };
    const options={
        certificates:{
            serverCertificate:path.join(currentRoot,'local-node-ipc-certs','server.pub'),
            serverKey:path.join(currentRoot,'local-node-ipc-certs','private','server.key')
        },
        datagramOracle,
        measuredFrames:input.measuredFrames ?? integer('messages',quick ? 128 : 1000000),
        oracleByTransport,
        oracles,
        payloadBytes:input.payloadBytes ?? integer('size',64),
        probeFrames:input.probeFrames ?? integer('probes',quick ? 8 : 64),
        samplesPerVersion:input.samplesPerVersion ?? integer('samples',quick ? 1 : 7),
        timeoutMs:input.timeoutMs ?? integer('timeout',quick ? 30000 : 600000),
        transports,
        udpWindow:input.udpWindow ?? integer('udp-window',quick ? 8 : 64),
        warmupFrames:input.warmupFrames ?? integer('warmup',quick ? 32 : 100000)
    };

    const samples=[];
    for(const transport of transports){
        for(let pairIndex=0;pairIndex<options.samplesPerVersion;pairIndex+=1){
            const order=pairIndex%2 ? [...versionOrder].reverse() : versionOrder;
            for(let orderIndex=0;orderIndex<order.length;orderIndex+=1){
                samples.push(await runTrial(options,subjects[order[orderIndex]],transport,pairIndex,orderIndex));
            }
        }
    }
    const publicSubjects=Object.fromEntries(Object.entries(subjects).map(([id,entry]) => [id,{
        commit:entry.commit,
        id,
        packageLockSha256:entry.packageLockSha256,
        tag:id === 'legacy-v12' ? legacyTag : null,
        version:entry.version
    }]));
    return {
        schemaVersion:1,
        generatedAt:new Date().toISOString(),
        repository:state,
        oracles:options.oracles,
        system:{
            architecture:process.arch,
            cpu:{count:os.availableParallelism(),model:os.cpus()[0]?.model ?? null},
            environment:{
                githubRepository:process.env.GITHUB_REPOSITORY ?? null,
                imageOS:process.env.ImageOS ?? null,
                imageVersion:process.env.ImageVersion ?? null,
                nodeLane:process.env.NODE_IPC_BENCHMARK_NODE_LANE ?? null,
                npm:process.env.npm_config_user_agent?.split(' ')[0] ?? null,
                osLane:process.env.NODE_IPC_BENCHMARK_OS_LANE ?? null,
                provider:process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
                runAttempt:process.env.GITHUB_RUN_ATTEMPT ?? null,
                runId:process.env.GITHUB_RUN_ID ?? null,
                runnerArchitecture:process.env.RUNNER_ARCH ?? null,
                runnerEnvironment:process.env.RUNNER_ENVIRONMENT ?? null,
                sourceRef:process.env.GITHUB_REF ?? null,
                sourceSha:process.env.GITHUB_SHA ?? null,
                workflow:process.env.GITHUB_WORKFLOW ?? null,
                workflowRef:process.env.GITHUB_WORKFLOW_REF ?? null,
                workflowSha:process.env.GITHUB_WORKFLOW_SHA ?? null
            },
            machine:{
                id:createHash('sha256').update(`${os.hostname()}\0${os.cpus()[0]?.model ?? ''}\0${os.totalmem()}`).digest('hex').slice(0,16)
            },
            node:process.version,
            platform:process.platform,
            release:os.release(),
            totalMemoryBytes:os.totalmem()
        },
        config:{
            currentVersion:subjects.current.version,
            messages:options.measuredFrames,
            measuredFrames:options.measuredFrames,
            oracleByTransport:options.oracleByTransport,
            pairsPerTransport:options.samplesPerVersion,
            payloadBytes:options.payloadBytes,
            probeFrames:options.probeFrames,
            samplesPerVersion:options.samplesPerVersion,
            subjects:publicSubjects,
            transports,
            udpWindow:options.udpWindow,
            versions:[...versionOrder],
            warmupFrames:options.warmupFrames
        },
        samples,
        summary:summarize(samples),
        cleanup:{
            activeHandles:samples.flatMap((sample) => sample.cleanup.activeHandles),
            clean:samples.every((sample) => sample.cleanup.clean),
            pairs:options.samplesPerVersion*transports.length,
            samples:samples.length
        },
        rankingEligible:false
    };
}

if(process.argv[1] === fileURLToPath(import.meta.url)){
    process.stdout.write(`${JSON.stringify(await runBenchmark(),null,2)}\n`);
}

export {runBenchmark,transportOrder,versionOrder};
