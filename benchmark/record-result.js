import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {cp,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const directory=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(directory,'..');
const resultsDirectory=path.join(directory,'results');
const indexPath=path.join(resultsDirectory,'index.json');
const provided=process.argv.slice(2);
const canonicalAdapters=['node-net','node-ipc-raw','node-ipc-fast','node-ipc-guarded'];
const full=provided.includes('--full');
const runArguments=provided.filter((argument) => argument !== '--full');
const repositoryBefore=await repositoryState();

if(!full){
    throw new Error('tracked benchmark recording requires --full; use npm run benchmark:quick for untracked development checks');
}
if(repositoryBefore.dirty !== false){
    throw new Error('tracked benchmark recording requires a clean Git tree before execution');
}

const build=await execute(
    process.execPath,
    [path.join(directory,'oracle','build.js')],
    {cwd:projectRoot,encoding:'utf8',windowsHide:true}
);
if(build.stderr.trim()){
    process.stderr.write(build.stderr);
}

const {stdout,stderr}=await execute(
    process.execPath,
    [path.join(directory,'run.js'),...runArguments],
    {
        cwd:projectRoot,
        encoding:'utf8',
        maxBuffer:128*1024*1024,
        windowsHide:true
    }
);

if(stderr.trim()){
    process.stderr.write(stderr);
}

const runtime=JSON.parse(stdout);
const repositoryAfter=await repositoryState();
const canonicalSourceSha256=sha256(await readFile(path.join(directory,'oracle','echo.c')));
const canonicalBinarySha256=sha256(await readFile(path.join(
    directory,
    'oracle',
    'bin',
    process.platform === 'win32' ? 'raw-echo.exe' : 'raw-echo'
)));
const runId=`run-${runtime.generatedAt.replaceAll(/[-:.]/g,'')}-${randomUUID()}`;
const file=`${runId}.json`;
const tracked=sanitize(
    runtime,
    repositoryBefore,
    repositoryAfter,
    canonicalSourceSha256,
    canonicalBinarySha256,
    runId,
    file
);
const serialized=`${JSON.stringify(tracked,null,2)}\n`;

if(!tracked.evidence.publishable){
    throw new Error(`benchmark result is not publishable: ${tracked.evidence.reasons.join(', ')}`);
}

await mkdir(resultsDirectory,{recursive:true});

let index={schemaVersion:2,updatedAt:null,comparisonState:'no-verified-runs',results:[]};
try{
    index=JSON.parse(await readFile(indexPath,'utf8'));
}catch(error){
    if(error.code !== 'ENOENT'){
        throw error;
    }
}

if(index.results.some((candidate) => candidate.id === runId)){
    throw new Error(`benchmark run id already exists: ${runId}`);
}

const entry={
    architecture:tracked.system.architecture,
    classification:tracked.evidence.classification,
    cleanupClean:tracked.cleanup.clean,
    commit:tracked.repository.commit,
    dirty:tracked.repository.dirty,
    file,
    generatedAt:tracked.generatedAt,
    id:runId,
    machine:tracked.system.machine,
    node:tracked.system.node,
    oracle:tracked.oracle.implementation,
    packageFootprintStatus:tracked.evidence.packageFootprintStatus,
    platform:tracked.system.platform,
    publishable:tracked.evidence.publishable,
    rankingEligible:tracked.evidence.rankingEligible,
    sha256:sha256(serialized)
};
index.schemaVersion=2;
index.updatedAt=new Date().toISOString();
index.comparisonState=tracked.evidence.comparison.state;
index.results=[...index.results,entry];
await validateProspectiveResult(index,file,serialized);
await writeAtomic(path.join(resultsDirectory,file),serialized);
await writeAtomic(indexPath,`${JSON.stringify(index,null,2)}\n`);

const outputDirectory=process.env.NODE_IPC_BENCHMARK_OUTPUT_DIRECTORY;
if(outputDirectory){
    await mkdir(outputDirectory,{recursive:true});
    await writeFile(path.join(outputDirectory,file),serialized,{flag:'wx'});
}

process.stdout.write(`${path.relative(projectRoot,path.join(resultsDirectory,file))}\n`);

function sanitize(
    runtimeResult,
    repositoryBeforeRun,
    repositoryAfterRun,
    canonicalSourceSha256,
    canonicalBinarySha256,
    id,
    filename
){
    const samples=runtimeResult.samples.map((sample) => {
        const {endpoint,pids,trialDirectory,...safeSample}=sample;
        return safeSample;
    });
    const oracleBuild=runtimeResult.oracle.build
        ? {
            binarySha256:runtimeResult.oracle.build.binarySha256,
            compiler:path.basename(runtimeResult.oracle.build.compiler),
            flags:[...runtimeResult.oracle.build.flags],
            sourceSha256:runtimeResult.oracle.build.sourceSha256,
            target:{...runtimeResult.oracle.build.target},
            version:runtimeResult.oracle.build.version
        }
        : null;
    const cleanup={...runtimeResult.cleanup};
    const hasNodeIpcAdapter=runtimeResult.config.adapters.some((adapter) => adapter.startsWith('node-ipc-'));
    const comparisonState=hasNodeIpcAdapter ? 'profile-comparison' : 'baseline-only';
    const repositoryChanged=repositoryBeforeRun.commit !== repositoryAfterRun.commit
        || repositoryBeforeRun.statusSha256 !== repositoryAfterRun.statusSha256;
    const repository={
        capture:'pre-and-post-execution',
        commit:repositoryBeforeRun.commit,
        dirty:repositoryBeforeRun.dirty || repositoryAfterRun.dirty || repositoryChanged,
        changedDuringRun:repositoryChanged,
        preExecution:repositoryBeforeRun,
        postExecution:repositoryAfterRun
    };
    const canonical=canonicalConfiguration(runtimeResult.config);
    const internallyClean=cleanSamples(runtimeResult.samples,cleanup);
    const oracleUnsaturated=runtimeResult.samples.every(
        (sample) => sample.metrics?.oracle?.saturated === false
    );
    const oracleBuildVerified=runtimeResult.oracle.implementation === 'standard-c'
        && oracleBuild
        && oracleBuild.sourceSha256 === canonicalSourceSha256
        && runtimeResult.oracle.sourceSha256 === canonicalSourceSha256
        && oracleBuild.binarySha256 === canonicalBinarySha256
        && fixedBuild(oracleBuild,runtimeResult.system)
        && oracleBuild.target.platform === runtimeResult.system.platform
        && oracleBuild.target.architecture === runtimeResult.system.architecture;
    const publishable=repository.dirty === false
        && !repository.changedDuringRun
        && canonical
        && internallyClean
        && oracleUnsaturated
        && oracleBuildVerified
        && runtimeResult.packageFootprint !== null;
    const reasons=[
        ...(repository.dirty ? ['dirty-tree'] : []),
        ...(repository.changedDuringRun ? ['repository-changed-during-run'] : []),
        ...(runtimeResult.oracle.implementation !== 'standard-c' ? ['non-c-oracle'] : []),
        ...(!canonical ? ['non-canonical-configuration'] : []),
        ...(!internallyClean ? ['internal-cleanliness-failed'] : []),
        ...(!oracleUnsaturated ? ['oracle-saturated'] : []),
        ...(!oracleBuildVerified ? ['oracle-build-unverified'] : []),
        ...(runtimeResult.packageFootprint === null ? ['package-footprint-not-measured'] : []),
        ...(!hasNodeIpcAdapter ? ['no-comparable-node-ipc-adapter'] : [])
    ];

    return {
        schemaVersion:2,
        id,
        generatedAt:runtimeResult.generatedAt,
        record:{file:filename,recordedAt:new Date().toISOString()},
        repository,
        system:runtimeResult.system,
        oracle:{
            build:oracleBuild,
            implementation:runtimeResult.oracle.implementation,
            source:{sha256:runtimeResult.oracle.sourceSha256}
        },
        evidence:{
            authority:'snapshot-noisy',
            classification:publishable ? 'clean-c-oracle-snapshot' : 'development-smoke',
            comparison:{
                adapters:[...runtimeResult.config.adapters],
                baseline:'node-net',
                certification:false,
                state:comparisonState
            },
            packageFootprintStatus:runtimeResult.packageFootprint ? 'measured' : 'omitted-smoke',
            privacy:{
                excluded:['absolute-paths','ephemeral-ports','process-ids'],
                sanitized:true
            },
            publishable,
            rankingEligible:false,
            reasons
        },
        config:runtimeResult.config,
        samples,
        summary:summarize(runtimeResult.samples,runtimeResult.system.platform),
        memory:runtimeResult.memory,
        gc:runtimeResult.gc,
        cleanup,
        packageFootprint:runtimeResult.packageFootprint
    };
}

function fixedBuild(build,system){
    if(!build || build.target?.platform !== system.platform || build.target?.architecture !== system.architecture){
        return false;
    }
    const compiler=build.compiler.toLowerCase();
    const microsoft=compiler === 'cl' || compiler === 'cl.exe';
    const expectedFlags=microsoft
        ? ['/nologo','/O2','ws2_32.lib']
        : ['-O3','-std=c11',...(system.platform === 'win32' ? ['-lws2_32'] : [])];
    const expectedTarget=system.platform === 'win32' ? 'raw-echo.exe' : 'raw-echo';
    return JSON.stringify(build.flags) === JSON.stringify(expectedFlags)
        && build.target.name === expectedTarget
        && typeof build.version === 'string'
        && build.version.length > 0;
}

async function repositoryState(){
    try{
        const [{stdout:commit},{stdout:status}]=await Promise.all([
            execute('git',['rev-parse','HEAD'],{cwd:projectRoot,encoding:'utf8',windowsHide:true}),
            execute(
                'git',
                ['status','--porcelain','--untracked-files=all'],
                {cwd:projectRoot,encoding:'utf8',windowsHide:true}
            )
        ]);
        return {
            capturedAt:new Date().toISOString(),
            commit:commit.trim(),
            dirty:status.trim().length > 0,
            statusSha256:sha256(status)
        };
    }catch{
        return {capturedAt:new Date().toISOString(),commit:null,dirty:null,statusSha256:null};
    }
}

function canonicalConfiguration(config){
    return config.oracle === 'c'
        && config.host === '127.0.0.1'
        && config.quick === false
        && config.footprint === true
        && config.samplesPerPass === 7
        && config.payloadBytes === 64
        && config.warmupFrames === 100000
        && config.frames?.speed === 1000000
        && config.frames?.resource === 1000000
        && config.frames?.latency === 1000000
        && config.timeoutMs === 600000
        && [...config.passes].sort().join(',') === 'latency,resource,speed'
        && new Set(config.passes).size === 3
        && JSON.stringify(config.adapters) === JSON.stringify(canonicalAdapters);
}

function cleanSamples(samples,cleanup){
    return cleanup.clean
        && cleanup.endpointLeaks === 0
        && cleanup.endpointReuseFailures === 0
        && cleanup.leftoverBytes === 0
        && cleanup.leftoverEntries === 0
        && cleanup.openSockets === 0
        && cleanup.samples === samples.length
        && samples.every((sample) => sample.cleanup?.clean
            && sample.cleanup.endpointClosed
            && sample.cleanup.endpointReusable
            && sample.cleanup.leftovers?.bytes === 0
            && sample.cleanup.leftovers?.entries === 0
            && sample.processExit?.oracle?.code === 0
            && sample.processExit?.worker?.code === 0
            && sample.exact?.sentFrames === sample.exact?.configuredFrames
            && sample.exact?.receivedFrames === sample.exact?.configuredFrames
            && sample.exact?.applicationByteCountsVerified
            && sample.exact?.byteCountsVerified
            && sample.exact?.contentVerified
            && sample.exact?.sequenceVerified
            && sample.exact?.oracleByteCountVerified);
}

function summarize(samples,platform){
    const groups=new Map();
    for(const sample of samples){
        const key=`${sample.adapter}:${sample.pass}`;
        const group=groups.get(key) || {adapter:sample.adapter,pass:sample.pass,values:[],deltas:[]};
        group.values.push(sample.metrics.millisecondsPerMillion);
        group.deltas.push(sample.metrics.deltaMillisecondsPerMillion);
        groups.set(key,group);
    }
    return {
        metric:'milliseconds-per-million',
        platform,
        groups:[...groups.values()]
            .sort((left,right) => `${left.adapter}:${left.pass}`.localeCompare(`${right.adapter}:${right.pass}`))
            .map((group) => ({
                adapter:group.adapter,
                pass:group.pass,
                samples:group.values.length,
                millisecondsPerMillion:distribution(group.values),
                pairedDeltaMillisecondsPerMillion:distribution(group.deltas)
            }))
    };
}

function distribution(values){
    const sorted=[...values].sort((left,right) => left-right);
    const middle=Math.floor(sorted.length/2);
    const median=sorted.length%2
        ? sorted[middle]
        : (sorted[middle-1]+sorted[middle])/2;
    return {maximum:sorted.at(-1),median,minimum:sorted[0],values:sorted};
}

function sha256(value){
    return createHash('sha256').update(value).digest('hex');
}

async function writeAtomic(target,contents){
    const temporary=`${target}.${process.pid}.tmp`;
    await writeFile(temporary,contents,{encoding:'utf8',flag:'wx'});
    await rename(temporary,target);
}

async function validateProspectiveResult(index,filename,serialized){
    const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-benchmark-record-'));
    const candidateDirectory=path.join(temporaryRoot,'results');
    try{
        await cp(resultsDirectory,candidateDirectory,{recursive:true});
        await writeFile(path.join(candidateDirectory,filename),serialized,{encoding:'utf8',flag:'wx'});
        await writeFile(
            path.join(candidateDirectory,'index.json'),
            `${JSON.stringify(index,null,2)}\n`,
            {encoding:'utf8'}
        );
        await execute(
            process.execPath,
            [path.join(directory,'validate-results.js'),`--results-directory=${candidateDirectory}`],
            {cwd:projectRoot,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true}
        );
    }finally{
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}
