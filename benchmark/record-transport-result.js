import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
    legacyProvenance,
    manifestEntry,
    sha256,
    summarize,
    validateCanonicalRuntime
} from './transport-evidence.js';

const execute=promisify(execFile);
const directory=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(directory,'..');
const provided=process.argv.slice(2);
const full=provided.includes('--full');
const runArguments=provided.filter((argument) => argument !== '--full' && !argument.startsWith('--output-directory='));
const outputArgument=provided.find((argument) => argument.startsWith('--output-directory='));
const outputDirectory=path.resolve(
    outputArgument?.slice('--output-directory='.length)
    || process.env.NODE_IPC_TRANSPORT_OUTPUT_DIRECTORY
    || ''
);

if(!full){
    throw new Error('tracked transport recording requires --full');
}
if(!outputArgument && !process.env.NODE_IPC_TRANSPORT_OUTPUT_DIRECTORY){
    throw new Error('tracked transport recording requires --output-directory or NODE_IPC_TRANSPORT_OUTPUT_DIRECTORY');
}

const repositoryBefore=await repositoryState();
assert.equal(repositoryBefore.dirty,false,'tracked transport recording requires a clean Git tree');
assert.match(repositoryBefore.commit || '',/^[0-9a-f]{40}$/u,'tracked transport recording requires a Git commit');
assert.equal(await git('rev-parse','12.0.0^{commit}'),legacyProvenance.commit,'the exact v12 tag commit differs');

const {stdout,stderr}=await execute(
    process.execPath,
    [path.join(directory,'transport','run.js'),...runArguments],
    {cwd:projectRoot,encoding:'utf8',maxBuffer:128*1024*1024,windowsHide:true}
);
if(stderr.trim()) process.stderr.write(stderr);

const runtime=JSON.parse(stdout);
const currentPackage=JSON.parse(await readFile(path.join(projectRoot,'package.json'),'utf8'));
const harnessConfig=runtime.config;
assert.equal(harnessConfig.subjects?.['legacy-v12']?.commit,legacyProvenance.commit,'transport harness legacy commit differs');
assert.equal(harnessConfig.subjects?.['legacy-v12']?.tag,legacyProvenance.tag,'transport harness legacy tag differs');
assert.equal(harnessConfig.subjects?.['legacy-v12']?.version,legacyProvenance.version,'transport harness legacy version differs');
assert.equal(harnessConfig.subjects?.current?.commit,repositoryBefore.commit,'transport harness current commit differs');
assert.equal(harnessConfig.subjects?.current?.version,currentPackage.version,'transport harness current version differs');
runtime.config={
    currentVersion:currentPackage.version,
    messages:harnessConfig.measuredFrames,
    pairsPerTransport:harnessConfig.samplesPerVersion,
    payloadBytes:harnessConfig.payloadBytes,
    probeFrames:harnessConfig.probeFrames,
    transports:harnessConfig.transports,
    udpWindow:harnessConfig.udpWindow,
    versions:['legacy-v12','current'],
    warmupFrames:harnessConfig.warmupFrames
};
validateCanonicalRuntime(runtime);

const repositoryAfter=await repositoryState();
const repositoryChanged=repositoryBefore.commit !== repositoryAfter.commit
    || repositoryBefore.statusSha256 !== repositoryAfter.statusSha256;
const repository={
    capture:'pre-and-post-execution',
    changedDuringRun:repositoryChanged,
    commit:repositoryBefore.commit,
    dirty:repositoryBefore.dirty || repositoryAfter.dirty || repositoryChanged,
    preExecution:repositoryBefore,
    postExecution:repositoryAfter
};
assert.equal(repository.dirty,false,'tracked transport recording requires identical clean pre/post Git state');
assert.equal(runtime.repository.commit,repository.commit,'transport harness measured a different commit');

const generatedAt=runtime.generatedAt;
const id=`run-${generatedAt.replaceAll(/[-:.]/gu,'')}-${randomUUID()}`;
const file=`${id}.json`;
const subjects={
    'legacy-v12':{
        id:'legacy-v12',
        version:legacyProvenance.version,
        source:{
            kind:'git-tag-archive',
            tag:legacyProvenance.tag,
            commit:legacyProvenance.commit,
            packageJsonSha256:sha256(await gitBytes('show','12.0.0:package.json')),
            packageLockSha256:sha256(await gitBytes('show','12.0.0:package-lock.json'))
        }
    },
    current:{
        id:'current',
        version:currentPackage.version,
        source:{
            kind:'clean-repository',
            commit:repository.commit,
            packageJsonSha256:sha256(await gitBytes('show',`${repository.commit}:package.json`)),
            packageLockSha256:sha256(await gitBytes('show',`${repository.commit}:package-lock.json`))
        }
    }
};
const system={
    ...runtime.system,
    environment:{
        ...(runtime.system.environment || {}),
        githubRepository:process.env.GITHUB_REPOSITORY ?? runtime.system.environment?.githubRepository ?? null,
        imageOS:process.env.ImageOS ?? runtime.system.environment?.imageOS ?? null,
        imageVersion:process.env.ImageVersion ?? runtime.system.environment?.imageVersion ?? null,
        nodeLane:process.env.NODE_IPC_BENCHMARK_NODE_LANE ?? runtime.system.environment?.nodeLane ?? null,
        npm:process.env.npm_config_user_agent?.split(' ')[0] ?? runtime.system.environment?.npm ?? null,
        osLane:process.env.NODE_IPC_BENCHMARK_OS_LANE ?? runtime.system.environment?.osLane ?? null,
        provider:process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
        runAttempt:process.env.GITHUB_RUN_ATTEMPT ?? runtime.system.environment?.runAttempt ?? null,
        runId:process.env.GITHUB_RUN_ID ?? runtime.system.environment?.runId ?? null,
        runnerArchitecture:process.env.RUNNER_ARCH ?? runtime.system.environment?.runnerArchitecture ?? null,
        runnerEnvironment:process.env.RUNNER_ENVIRONMENT ?? runtime.system.environment?.runnerEnvironment ?? null,
        sourceRef:process.env.GITHUB_REF ?? runtime.system.environment?.sourceRef ?? null,
        sourceSha:process.env.GITHUB_SHA ?? runtime.system.environment?.sourceSha ?? null,
        workflow:process.env.GITHUB_WORKFLOW ?? runtime.system.environment?.workflow ?? null,
        workflowRef:process.env.GITHUB_WORKFLOW_REF ?? runtime.system.environment?.workflowRef ?? null,
        workflowSha:process.env.GITHUB_WORKFLOW_SHA ?? runtime.system.environment?.workflowSha ?? null
    }
};
const result={
    schemaVersion:1,
    id,
    generatedAt,
    record:{file,recordedAt:new Date().toISOString()},
    repository,
    system,
    evidence:{
        authority:'snapshot-noisy',
        certification:false,
        classification:'clean-end-to-end-transport-comparison',
        comparison:{
            paired:true,
            state:'version-comparison',
            subjects:['legacy-v12','current'],
            transports:['local','tcp','tls','udp4','udp6']
        },
        privacy:{excluded:['absolute-paths','ephemeral-endpoints','process-ids'],sanitized:true},
        publishable:true,
        rankingEligible:false,
        reasons:[]
    },
    config:runtime.config,
    subjects,
    samples:runtime.samples,
    summary:summarize(runtime.samples,system.platform),
    cleanup:runtime.cleanup
};

assertNoEphemeralData(result);
const serialized=`${JSON.stringify(result,null,2)}\n`;
const entry=manifestEntry(result,serialized);
assert.equal(entry.sha256,sha256(serialized));
await mkdir(outputDirectory,{recursive:true});
await writeFile(path.join(outputDirectory,file),serialized,{flag:'wx'});
process.stdout.write(`${path.join(outputDirectory,file)}\n`);

async function repositoryState(){
    const [{stdout:commit},{stdout:status}]=await Promise.all([
        execute('git',['rev-parse','HEAD'],{cwd:projectRoot,encoding:'utf8',windowsHide:true}),
        execute('git',['status','--porcelain','--untracked-files=all'],{cwd:projectRoot,encoding:'utf8',windowsHide:true})
    ]);
    return {
        capturedAt:new Date().toISOString(),
        commit:commit.trim(),
        dirty:status.trim().length > 0,
        statusSha256:sha256(status)
    };
}

async function git(...arguments_){
    return (await execute('git',arguments_,{cwd:projectRoot,encoding:'utf8',windowsHide:true})).stdout.trim();
}

async function gitBytes(...arguments_){
    return (await execute('git',arguments_,{cwd:projectRoot,encoding:'buffer',windowsHide:true,maxBuffer:16*1024*1024})).stdout;
}

function assertNoEphemeralData(value,segments=[]){
    const banned=new Set(['endpoint','endpoints','path','pid','pids','port','root','trialDirectory']);
    if(Array.isArray(value)){
        value.forEach((entry,index) => assertNoEphemeralData(entry,[...segments,String(index)]));
        return;
    }
    if(!value || typeof value !== 'object'){
        if(typeof value === 'string'){
            assert.ok(!/^[a-zA-Z]:[\\/]/u.test(value),`absolute Windows path at ${segments.join('.')}`);
            assert.ok(!/^\/(?:Users|home|tmp|var\/tmp)\//u.test(value),`absolute POSIX path at ${segments.join('.')}`);
        }
        return;
    }
    for(const [key,entry] of Object.entries(value)){
        assert.ok(!banned.has(key),`ephemeral field ${[...segments,key].join('.')} is forbidden`);
        assertNoEphemeralData(entry,[...segments,key]);
    }
}
