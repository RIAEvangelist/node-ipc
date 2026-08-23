import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const peerSchema='node-ipc-roundtrip-v1';
export const resultSchema='node-ipc-rust-benchmark-v1';
export const officialEnvironment=Object.freeze({
    node:'v24.18.1',
    rust:'1.85.0',
    repository:'RIAEvangelist/node-ipc',
    workflow:'Record Rust and Node TCP benchmark snapshots',
    workflowRef:'RIAEvangelist/node-ipc/.github/workflows/rust-benchmark.yml@refs/heads/main',
    osLanes:Object.freeze({darwin:'macos-latest',linux:'ubuntu-latest',win32:'windows-latest'})
});
export const lanes=Object.freeze([
    Object.freeze({id:'node-node',client:'node',server:'node'}),
    Object.freeze({id:'node-rust',client:'node',server:'rust'}),
    Object.freeze({id:'rust-node',client:'rust',server:'node'}),
    Object.freeze({id:'rust-rust',client:'rust',server:'rust'})
]);
export const configurations=Object.freeze({
    full:Object.freeze({
        mode:'full',
        warmup:100_000,
        count:1_000_000,
        payloadBytes:64,
        inflight:64,
        samplesPerLane:5,
        readyTimeoutMs:15_000,
        sampleTimeoutMs:180_000,
        cleanupTimeoutMs:5_000,
        baselineDelayMs:1_000,
        memoryIntervalMs:500
    }),
    quick:Object.freeze({
        mode:'quick',
        warmup:100,
        count:1_000,
        payloadBytes:64,
        inflight:64,
        samplesPerLane:1,
        readyTimeoutMs:15_000,
        sampleTimeoutMs:30_000,
        cleanupTimeoutMs:5_000,
        baselineDelayMs:25,
        memoryIntervalMs:100
    })
});

export function samplePlan(config){
    const plan=[];
    for(let round=0;round<config.samplesPerLane;round++){
        for(let position=0;position<lanes.length;position++){
            const lane=lanes[(position+round)%lanes.length];
            plan.push({...lane,round,orderIndex:plan.length});
        }
    }
    return plan;
}

export function expectedWireBytes(count,payloadBytes){
    const payload='x'.repeat(payloadBytes);
    const encoded=(type,sequence) => Buffer.byteLength(
        `${JSON.stringify({type,data:{sequence,payload}})}\f`
    );
    const base=encoded('node-ipc.bench.request',0)+encoded('node-ipc.bench.response',0);
    let extra=0;
    for(let start=10,digits=1;start<count;start*=10,digits++){
        const end=Math.min(count,start*10);
        extra+=(end-start)*digits;
        if(end === count) break;
    }
    return count*base+2*extra;
}

export function evidenceReasons(mode,repository,environment,runtime={},platform){
    const reasons=[];
    if(mode !== 'full') reasons.push('quick-smoke');
    if(repository.dirty) reasons.push('dirty-repository');
    if(repository.changedDuringRun) reasons.push('repository-changed');
    if(environment.provider !== 'github-actions') reasons.push('non-github-environment');
    if(environment.sourceRef !== 'refs/heads/main') reasons.push('non-main-source');
    if(environment.sourceSha !== repository.commit) reasons.push('source-sha-mismatch');
    if(mode === 'full' && environment.provider === 'github-actions'){
        if(runtime.node?.version !== officialEnvironment.node) reasons.push('node-version-mismatch');
        if(runtime.rust?.release !== officialEnvironment.rust) reasons.push('rust-version-mismatch');
        if(environment.githubRepository !== officialEnvironment.repository) reasons.push('repository-mismatch');
        if(environment.workflow !== officialEnvironment.workflow) reasons.push('workflow-mismatch');
        if(environment.workflowRef !== officialEnvironment.workflowRef) reasons.push('workflow-ref-mismatch');
        if(environment.workflowSha !== repository.commit) reasons.push('workflow-sha-mismatch');
        if(environment.nodeLane !== officialEnvironment.node.slice(1)) reasons.push('node-lane-mismatch');
        const osLane=officialEnvironment.osLanes[platform];
        if(!osLane) reasons.push('unsupported-platform');
        else if(environment.osLane !== osLane) reasons.push('os-lane-mismatch');
        if(environment.runnerEnvironment !== 'github-hosted') reasons.push('runner-environment-mismatch');
    }
    return reasons;
}

export function summarize(samples){
    return {
        metric:'milliseconds-per-million-validated-round-trips',
        lanes:lanes.map((lane) => {
            const entries=samples.filter((sample) => sample.lane === lane.id);
            return {
                lane:lane.id,
                samples:entries.length,
                medianDurationNs:median(entries.map((sample) => Number(sample.metrics.durationNs))),
                medianMillisecondsPerMillionRoundTrips:median(entries.map(
                    (sample) => Number(sample.metrics.durationNs)/sample.exact.clientCount
                )),
                medianRoundTripsPerSecond:median(entries.map((sample) => sample.metrics.roundTripsPerSecond)),
                medianLatencyP50Ns:median(entries.map((sample) => sample.metrics.latencyNs.p50)),
                medianClientSampledPeakRssBytes:nullableMedian(entries.map((sample) => sample.memory.clientSampledPeakRssBytes)),
                medianServerSampledPeakRssBytes:nullableMedian(entries.map((sample) => sample.memory.serverSampledPeakRssBytes))
            };
        })
    };
}

export function validateResult(result,{tracked=false}={}){
    assertObjectKeys(result,[
        'cleanup','config','evidence','generatedAt','id','packages','record','repository',
        'runtime','samples','schema','schemaVersion','subjects','summary','system'
    ],'result');
    assertObjectKeys(result.record,['file','recordedAt'],'record');
    assertObjectKeys(result.repository,['capture','changedDuringRun','commit','dirty','postExecution','preExecution'],'repository');
    for(const state of [result.repository.preExecution,result.repository.postExecution]) assertObjectKeys(
        state,['capturedAt','changedEntries','commit','dirty','statusSha256'],'repository state'
    );
    assertObjectKeys(result.system,['architecture','cpu','environment','machine','platform','release','totalMemoryBytes'],'system');
    assertObjectKeys(result.system.cpu,['count','model'],'system.cpu');
    assertObjectKeys(result.system.machine,['id'],'system.machine');
    assertObjectKeys(result.system.environment,[
        'githubRepository','imageOS','imageVersion','nodeLane','osLane','provider','runAttempt','runId',
        'runnerArchitecture','runnerEnvironment','sourceRef','sourceSha','workflow','workflowRef','workflowSha'
    ],'system.environment');
    assertObjectKeys(result.runtime,['cargo','node','rust'],'runtime');
    assertObjectKeys(result.runtime.node,['openssl','uv','v8','version'],'runtime.node');
    assertObjectKeys(result.runtime.rust,['commitHash','host','llvmVersion','release','version'],'runtime.rust');
    assertObjectKeys(result.runtime.cargo,['release','version'],'runtime.cargo');
    assertObjectKeys(result.packages,['crate','npm'],'packages');
    assertObjectKeys(result.packages.npm,['fileCount','integrity','packedBytes','sha1','unpackedBytes','version'],'packages.npm');
    assertObjectKeys(result.packages.crate,['fileCount','packedBytes','sha256','version'],'packages.crate');
    assertObjectKeys(result.subjects,['node','rust'],'subjects');
    assertObjectKeys(result.subjects.node,['packageJsonSha256','packageLockSha256','peerSha256','version'],'subjects.node');
    assertObjectKeys(result.subjects.rust,['binarySha256','cargoLockSha256','cargoTomlSha256','exampleSha256','version'],'subjects.rust');
    assertObjectKeys(result.config,[
        'baselineDelayMs','cleanupTimeoutMs','count','inflight','lanes','memoryIntervalMs','mode',
        'payloadBytes','peerSchema','readyTimeoutMs','rustProfile','sampleTimeoutMs','samplesPerLane','transport','warmup'
    ],'config');
    assertObjectKeys(result.evidence,[
        'certification','classification','notes','performanceClaims','publishable','rankingEligible','reasons'
    ],'evidence');
    assertObjectKeys(result.summary,['lanes','metric'],'summary');
    for(const lane of result.summary.lanes) assertObjectKeys(lane,[
        'lane','medianClientSampledPeakRssBytes','medianDurationNs','medianLatencyP50Ns',
        'medianMillisecondsPerMillionRoundTrips','medianRoundTripsPerSecond','medianServerSampledPeakRssBytes','samples'
    ],'summary lane');
    assertObjectKeys(result.cleanup,[
        'activeProcesses','activeSockets','clean','forcedProcesses','tempEntries','tempRootRemoved','uniquePorts'
    ],'cleanup');
    assert.equal(result.schema,resultSchema,'result schema differs');
    assert.equal(result.schemaVersion,1,'schemaVersion differs');
    assert.match(result.id,/^run-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{16}$/u,'run id differs');
    assert.ok(validDate(result.generatedAt),'generatedAt is invalid');
    assert.equal(result.record.file,`${result.id}.json`,'record filename differs');
    assert.ok(validDate(result.record.recordedAt),'recordedAt is invalid');

    const config=configurations[result.config.mode];
    assert.ok(config,'mode is invalid');
    for(const [key,value] of Object.entries(config)){
        assert.equal(result.config[key],value,`config.${key} differs`);
    }
    assert.deepEqual(result.config.lanes,lanes.map(({id}) => id),'lane order differs');
    assert.equal(result.config.peerSchema,peerSchema,'peer schema differs');
    assert.equal(result.config.transport,'tcp','transport differs');
    assert.equal(result.config.rustProfile,'release','Rust profile differs');

    assert.match(result.repository.commit,/^[0-9a-f]{40}$/u,'Git commit differs');
    assert.equal(result.repository.capture,'pre-and-post-execution','Git capture policy differs');
    assert.equal(result.repository.preExecution.commit,result.repository.commit,'pre-execution commit differs');
    assert.equal(result.repository.postExecution.commit,result.repository.commit,'post-execution commit differs');
    assert.equal(
        result.repository.changedDuringRun,
        result.repository.preExecution.commit !== result.repository.postExecution.commit
            || result.repository.preExecution.statusSha256 !== result.repository.postExecution.statusSha256,
        'Git changedDuringRun differs'
    );
    for(const state of [result.repository.preExecution,result.repository.postExecution]){
        assert.ok(validDate(state.capturedAt),'Git capture time is invalid');
        assert.match(state.statusSha256,/^[0-9a-f]{64}$/u,'Git status hash differs');
        assert.equal(typeof state.dirty,'boolean','Git dirty state differs');
        assert.ok(Number.isInteger(state.changedEntries) && state.changedEntries>=0,'Git entry count differs');
    }
    assert.equal(result.repository.dirty,
        result.repository.preExecution.dirty || result.repository.postExecution.dirty,
        'combined Git dirty state differs');

    assert.ok(result.system.platform && result.system.release && result.system.architecture,'OS provenance is incomplete');
    assert.ok(Number.isInteger(result.system.cpu.count) && result.system.cpu.count>0,'CPU count differs');
    assert.ok(result.system.cpu.model,'CPU model is missing');
    assert.ok(Number.isInteger(result.system.totalMemoryBytes) && result.system.totalMemoryBytes>0,'system memory differs');
    assert.match(result.system.machine.id,/^[0-9a-f]{64}$/u,'machine id differs');
    assert.match(result.runtime.node.version,/^v[0-9]+[.]/u,'Node version differs');
    assert.match(result.runtime.rust.release,/^[0-9]+[.][0-9]+[.][0-9]+/u,'Rust version differs');
    assert.ok(result.runtime.rust.host,'Rust host is missing');
    assert.ok(result.runtime.cargo.version,'Cargo version is missing');

    assert.equal(result.subjects.node.version,result.packages.npm.version,'Node subject version differs');
    assert.equal(result.subjects.rust.version,result.packages.crate.version,'Rust subject version differs');
    for(const [name,subject] of Object.entries(result.subjects)){
        for(const [key,value] of Object.entries(subject)){
            if(key !== 'version') assert.match(value,/^[0-9a-f]{64}$/u,`${name}.${key} hash differs`);
        }
    }

    assert.equal(result.packages.npm.version,result.packages.crate.version,'package versions differ');
    assert.ok(Number.isInteger(result.packages.npm.packedBytes) && result.packages.npm.packedBytes>0,'npm size differs');
    assert.ok(Number.isInteger(result.packages.npm.unpackedBytes) && result.packages.npm.unpackedBytes>0,'npm unpacked size differs');
    assert.ok(Number.isInteger(result.packages.npm.fileCount) && result.packages.npm.fileCount>0,'npm file count differs');
    assert.match(result.packages.npm.sha1,/^[0-9a-f]{40}$/u,'npm SHA-1 differs');
    assert.match(result.packages.npm.integrity,/^sha512-/u,'npm integrity differs');
    assert.ok(Number.isInteger(result.packages.crate.packedBytes) && result.packages.crate.packedBytes>0,'crate size differs');
    assert.ok(Number.isInteger(result.packages.crate.fileCount) && result.packages.crate.fileCount>0,'crate file count differs');
    assert.match(result.packages.crate.sha256,/^[0-9a-f]{64}$/u,'crate SHA-256 differs');

    const plan=samplePlan(config);
    assert.equal(result.samples.length,plan.length,'sample count differs');
    const ports=new Set;
    for(let index=0;index<plan.length;index++){
        validateSample(result.samples[index],plan[index],config,index);
        assert.match(result.samples[index].exact.portReservationId,/^[0-9a-f]{64}$/u,'port reservation id differs');
        ports.add(result.samples[index].exact.portReservationId);
    }
    assert.equal(ports.size,plan.length,'every sample requires a fresh port reservation');
    assert.deepEqual(result.summary,summarize(result.samples),'summary differs from raw samples');

    assert.equal(result.cleanup.activeProcesses,0,'active benchmark processes remain');
    assert.equal(result.cleanup.activeSockets,0,'active benchmark sockets remain');
    assert.equal(result.cleanup.tempEntries,0,'temporary entries remain');
    assert.equal(result.cleanup.tempRootRemoved,true,'temporary root remains');
    assert.equal(result.cleanup.forcedProcesses,0,'forced process cleanup was required');
    assert.equal(result.cleanup.clean,true,'run cleanup is not clean');
    assert.equal(result.cleanup.uniquePorts,plan.length,'unique port count differs');

    const full=config.mode === 'full';
    const reasons=evidenceReasons(
        config.mode,
        result.repository,
        result.system.environment,
        result.runtime,
        result.system.platform
    );
    const publishable=full && reasons.length === 0;
    assert.equal(result.evidence.classification,full ? 'release-performance-snapshot' : 'smoke-only','evidence classification differs');
    assert.equal(result.evidence.performanceClaims,full,'performance claim boundary differs');
    assert.equal(result.evidence.publishable,publishable,'publishable boundary differs');
    assert.deepEqual(result.evidence.reasons,reasons,'evidence rejection reasons differ');
    assert.equal(result.evidence.rankingEligible,false,'rankings are forbidden');
    assert.equal(result.evidence.certification,false,'certification is forbidden');
    if(tracked){
        assert.equal(config.mode,'full','tracked evidence must use full mode');
        assert.equal(result.repository.dirty,false,'tracked evidence requires a clean repository');
        assert.equal(result.repository.changedDuringRun,false,'tracked evidence changed during execution');
        assert.equal(result.system.environment.provider,'github-actions','tracked evidence requires GitHub Actions');
        assert.equal(result.system.environment.sourceRef,'refs/heads/main','tracked evidence requires main');
        assert.equal(result.system.environment.sourceSha,result.repository.commit,'workflow source differs');
        assert.match(result.system.environment.runId || '',/^[0-9]+$/u,'workflow run id differs');
        assert.match(result.system.environment.runAttempt || '',/^[0-9]+$/u,'workflow run attempt differs');
        assert.ok(result.system.environment.workflow,'workflow name is missing');
        assert.ok(result.system.environment.workflowRef,'workflow reference is missing');
        assert.equal(result.system.environment.workflowSha,result.repository.commit,'workflow SHA differs');
        assert.equal(result.system.environment.githubRepository,officialEnvironment.repository,'tracked repository differs');
        assert.equal(result.system.environment.workflow,officialEnvironment.workflow,'tracked workflow differs');
        assert.equal(result.system.environment.workflowRef,officialEnvironment.workflowRef,'tracked workflow ref differs');
        assert.equal(result.system.environment.nodeLane,officialEnvironment.node.slice(1),'tracked Node lane differs');
        assert.ok(Object.hasOwn(officialEnvironment.osLanes,result.system.platform),'tracked platform differs');
        assert.equal(result.system.environment.osLane,officialEnvironment.osLanes[result.system.platform],'tracked OS lane differs');
        assert.equal(result.system.environment.runnerEnvironment,'github-hosted','tracked runner environment differs');
        assert.equal(result.runtime.node.version,officialEnvironment.node,'tracked Node version differs');
        assert.equal(result.runtime.rust.release,officialEnvironment.rust,'tracked Rust version differs');
        assert.equal(result.evidence.publishable,true,'tracked evidence is not publishable');
        assert.deepEqual(result.evidence.reasons,[],'tracked evidence retains rejection reasons');
    }
    assertSanitized(result);
    return result;
}

export function manifestEntry(result,bytes){
    return {
        id:result.id,
        file:result.record.file,
        sha256:sha256(bytes),
        generatedAt:result.generatedAt,
        commit:result.repository.commit,
        platform:result.system.platform,
        architecture:result.system.architecture,
        node:result.runtime.node.version,
        rust:result.runtime.rust.release,
        summary:result.summary
    };
}

export function sha256(value){
    return createHash('sha256').update(value).digest('hex');
}

export function validDate(value){
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateSample(sample,plan,config,index){
    assertObjectKeys(sample,['cleanup','client','exact','lane','memory','metrics','orderIndex','round','server'],`sample ${index}`);
    assertObjectKeys(sample.metrics,['durationNs','latencyNs','roundTripsPerSecond','wireBytes','wireBytesPerSecond'],`sample ${index}.metrics`);
    assertObjectKeys(sample.metrics.latencyNs,['max','mean','p50','p95','p99'],`sample ${index}.metrics.latencyNs`);
    assertObjectKeys(sample.memory,[
        'clientGoneAfterExit','clientPostExitRssBytes','clientSampledPeakRssBytes','intervalMs','method',
        'parentAfterGcRssBytes','parentBeforeGcRssBytes','parentPostCleanupRssBytes','peakKind','samplerErrors',
        'serverGoneAfterExit','serverPostExitRssBytes','serverSampledPeakRssBytes','systemFreeBeforeBytes','systemFreePostCleanupBytes'
    ],`sample ${index}.memory`);
    assertObjectKeys(sample.exact,[
        'clientComplete','clientCount','host','inflight','payloadBytes','peerSchema','portReservationId',
        'portReserved','reservationReleasedBeforeServer','serverComplete','serverFrames','serverListening'
    ],`sample ${index}.exact`);
    assertObjectKeys(sample.cleanup,[
        'activeProcesses','activeSockets','clientNaturalExit','forced','portRebound','serverNaturalExit',
        'tempEntriesBeforeRemoval','tempRemoved'
    ],`sample ${index}.cleanup`);
    assert.equal(sample.orderIndex,index,`sample ${index}: order differs`);
    assert.equal(sample.round,plan.round,`sample ${index}: round differs`);
    assert.equal(sample.lane,plan.id,`sample ${index}: lane differs`);
    assert.equal(sample.client,plan.client,`sample ${index}: client differs`);
    assert.equal(sample.server,plan.server,`sample ${index}: server differs`);
    assert.match(sample.metrics.durationNs,/^[1-9][0-9]*$/u,`sample ${index}: duration differs`);
    assert.ok(Number.isFinite(sample.metrics.roundTripsPerSecond) && sample.metrics.roundTripsPerSecond>0,`sample ${index}: throughput differs`);
    assert.equal(sample.metrics.wireBytes,String(expectedWireBytes(config.count,config.payloadBytes)),`sample ${index}: wire bytes differ`);
    assert.ok(Number.isFinite(sample.metrics.wireBytesPerSecond) && sample.metrics.wireBytesPerSecond>0,`sample ${index}: wire rate differs`);
    const latency=sample.metrics.latencyNs;
    for(const key of ['mean','p50','p95','p99','max']) assert.ok(Number.isFinite(latency[key]) && latency[key]>=0,`sample ${index}: latency ${key} differs`);
    assert.ok(latency.p50<=latency.p95 && latency.p95<=latency.p99 && latency.p99<=latency.max,`sample ${index}: latency order differs`);

    assert.equal(sample.exact.peerSchema,peerSchema,`sample ${index}: peer schema differs`);
    assert.equal(sample.exact.host,'loopback-ipv4',`sample ${index}: host differs`);
    assert.equal(sample.exact.portReserved,true,`sample ${index}: port was not reserved`);
    assert.equal(sample.exact.reservationReleasedBeforeServer,true,`sample ${index}: reservation was not released`);
    assert.equal(sample.exact.serverListening,true,`sample ${index}: server did not listen`);
    assert.equal(sample.exact.serverComplete,true,`sample ${index}: server did not complete`);
    assert.equal(sample.exact.clientComplete,true,`sample ${index}: client did not complete`);
    assert.equal(sample.exact.serverFrames,config.warmup+config.count,`sample ${index}: server frames differ`);
    assert.equal(sample.exact.clientCount,config.count,`sample ${index}: client count differs`);
    assert.equal(sample.exact.payloadBytes,config.payloadBytes,`sample ${index}: payload differs`);
    assert.equal(sample.exact.inflight,config.inflight,`sample ${index}: inflight differs`);

    assert.ok(Number.isInteger(sample.memory.parentBeforeGcRssBytes) && sample.memory.parentBeforeGcRssBytes>0,`sample ${index}: parent pre-GC memory differs`);
    assert.ok(Number.isInteger(sample.memory.parentAfterGcRssBytes) && sample.memory.parentAfterGcRssBytes>0,`sample ${index}: parent post-GC memory differs`);
    assert.ok(Number.isInteger(sample.memory.parentPostCleanupRssBytes) && sample.memory.parentPostCleanupRssBytes>0,`sample ${index}: parent cleanup memory differs`);
    assert.equal(sample.memory.peakKind,'sampled-maximum',`sample ${index}: memory peak kind differs`);
    for(const key of ['clientSampledPeakRssBytes','serverSampledPeakRssBytes']) assert.ok(sample.memory[key] === null || Number.isInteger(sample.memory[key]) && sample.memory[key]>0,`sample ${index}: ${key} differs`);
    assert.equal(sample.memory.clientPostExitRssBytes,null,`sample ${index}: client post-exit RSS must be unavailable`);
    assert.equal(sample.memory.serverPostExitRssBytes,null,`sample ${index}: server post-exit RSS must be unavailable`);
    assert.ok(Number.isInteger(sample.memory.samplerErrors) && sample.memory.samplerErrors>=0,`sample ${index}: sampler errors differ`);
    assert.equal(sample.memory.clientGoneAfterExit,true,`sample ${index}: client still exists`);
    assert.equal(sample.memory.serverGoneAfterExit,true,`sample ${index}: server still exists`);

    assert.equal(sample.cleanup.clientNaturalExit,true,`sample ${index}: client required forced cleanup`);
    assert.equal(sample.cleanup.serverNaturalExit,true,`sample ${index}: server required forced cleanup`);
    assert.deepEqual(sample.cleanup.forced,[],`sample ${index}: forced cleanup differs`);
    assert.equal(sample.cleanup.portRebound,true,`sample ${index}: port was not released`);
    assert.equal(sample.cleanup.tempEntriesBeforeRemoval,0,`sample ${index}: peer left temporary entries`);
    assert.equal(sample.cleanup.tempRemoved,true,`sample ${index}: trial directory remains`);
    assert.equal(sample.cleanup.activeProcesses,0,`sample ${index}: active processes remain`);
    assert.equal(sample.cleanup.activeSockets,0,`sample ${index}: active sockets remain`);
    if(config.mode === 'full'){
        assert.equal(sample.memory.samplerErrors,0,`sample ${index}: memory sampling failed`);
        assert.ok(sample.memory.clientSampledPeakRssBytes,`sample ${index}: client memory is unavailable`);
        assert.ok(sample.memory.serverSampledPeakRssBytes,`sample ${index}: server memory is unavailable`);
    }
}

function median(values){
    assert.ok(values.length>0,'median requires values');
    const sorted=[...values].sort((left,right) => left-right);
    const middle=Math.floor(sorted.length/2);
    return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}

function nullableMedian(values){
    const present=values.filter((value) => value !== null);
    return present.length ? median(present) : null;
}

function assertSanitized(value,segments=[]){
    if(Array.isArray(value)){
        value.forEach((entry,index) => assertSanitized(entry,[...segments,String(index)]));
        return;
    }
    if(value && typeof value === 'object'){
        for(const [key,entry] of Object.entries(value)){
            assert.ok(!['pid','pids','port','endpoint','absolutePath'].includes(key),`ephemeral field ${[...segments,key].join('.')} is forbidden`);
            assertSanitized(entry,[...segments,key]);
        }
        return;
    }
    if(typeof value === 'string'){
        assert.ok(!/^[a-zA-Z]:[\\/]/u.test(value),`absolute Windows path at ${segments.join('.')}`);
        assert.ok(!/^\/(?:Users|home|private\/tmp|tmp|var\/tmp)\//u.test(value),`absolute POSIX path at ${segments.join('.')}`);
    }
}

function assertObjectKeys(value,expected,label){
    assert.ok(value && typeof value === 'object' && !Array.isArray(value),`${label} must be an object`);
    assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),`${label} fields differ`);
}
