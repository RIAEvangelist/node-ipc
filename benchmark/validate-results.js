import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const canonicalResultsDirectory=path.join(directory,'results');
const resultsDirectoryArgument=process.argv.find((argument) => argument.startsWith('--results-directory='));
const resultsDirectory=resultsDirectoryArgument
    ? path.resolve(resultsDirectoryArgument.slice('--results-directory='.length))
    : canonicalResultsDirectory;
const index=await readJson(path.join(resultsDirectory,'index.json'));
const schema=await readJson(path.join(directory,'result-schema.json'));
const canonicalAdapters=['node-net','node-ipc-raw','node-ipc-fast','node-ipc-guarded'];
const sourceHashCache=new Map();
const comparisonStates=[];
const directoryEntries=await readdir(resultsDirectory,{withFileTypes:true});
for(const entry of directoryEntries){
    assert.ok(entry.isFile(),`${entry.name}: benchmark results must contain regular files only`);
    assert.match(entry.name,/^(?:index|run-[A-Za-z0-9-]+)\.json$/u,`${entry.name}: unexpected benchmark result file`);
}
const files=directoryEntries
    .map((entry) => entry.name)
    .filter((file) => file !== 'index.json')
    .sort();

assert.equal(index.schemaVersion,2,'benchmark results index schemaVersion must be 2');
assert.equal(
    schema.$id,
    'https://riaevangelist.github.io/node-ipc/data/benchmarks/result-schema.json',
    'benchmark result schema must use its public Pages URL'
);
assert.ok(validDate(index.updatedAt),'benchmark results index updatedAt must be an ISO timestamp');
assert.ok(Array.isArray(index.results),'benchmark results index must contain a results array');
assert.ok(
    ['no-verified-runs','baseline-only','profile-comparison'].includes(index.comparisonState),
    'benchmark comparison state is invalid'
);
assert.equal(new Set(index.results.map((entry) => entry.id)).size,index.results.length,'benchmark run ids must be unique and append-only');
assert.deepEqual(
    [...index.results.map((entry) => entry.file)].sort(),
    files,
    'benchmark results index must reference every and only tracked result JSON file'
);
if(path.resolve(resultsDirectory) === path.resolve(canonicalResultsDirectory)){
    validateAppendOnlyHistory(index);
}

for(const entry of index.results){
    const serialized=await readFile(path.join(resultsDirectory,entry.file),'utf8');
    assert.equal(sha256(serialized),entry.sha256,`${entry.file}: manifest SHA-256 mismatch`);
    const result=JSON.parse(serialized);
    const schemaFailures=schemaErrors(result,schema,'$');
    assert.deepEqual(schemaFailures,[],`${entry.file}: result does not match result-schema.json`);
    validateResult(result,entry);
    comparisonStates.push(result.evidence.comparison.state);
}

const expectedComparisonState=index.results.length === 0
    ? 'no-verified-runs'
    : comparisonStates.includes('profile-comparison') ? 'profile-comparison' : 'baseline-only';
assert.equal(
    index.comparisonState,
    expectedComparisonState,
    'benchmark comparison state must honestly reflect its tracked evidence'
);

process.stdout.write(`validated ${index.results.length} sanitized tracked benchmark result${index.results.length === 1 ? '' : 's'}\n`);

function validateResult(result,entry){
    assert.equal(result.schemaVersion,2,`${entry.file}: schemaVersion must be 2`);
    assert.equal(result.id,entry.id,`${entry.file}: id must match the manifest`);
    assert.ok(validDate(result.generatedAt),`${entry.file}: generatedAt must be an ISO timestamp`);
    assert.equal(result.record?.file,entry.file,`${entry.file}: record.file must match its filename`);
    assert.match(result.repository?.commit || '',/^[0-9a-f]{40}$/u,`${entry.file}: repository commit must be a full Git SHA`);
    assert.equal(typeof result.repository?.dirty,'boolean',`${entry.file}: repository dirty state must be explicit`);
    assert.equal(result.repository?.capture,'pre-and-post-execution',`${entry.file}: Git state must be captured before and after execution`);
    assert.ok(validDate(result.repository?.preExecution?.capturedAt),`${entry.file}: pre-execution repository capture time is required`);
    assert.ok(validDate(result.repository?.postExecution?.capturedAt),`${entry.file}: post-execution repository capture time is required`);
    assert.equal(result.repository?.preExecution?.commit,result.repository?.commit,`${entry.file}: pre-execution commit mismatch`);
    assert.equal(result.repository?.postExecution?.commit,result.repository?.commit,`${entry.file}: repository commit changed during execution`);
    assert.equal(
        result.repository?.changedDuringRun,
        result.repository?.preExecution?.statusSha256 !== result.repository?.postExecution?.statusSha256,
        `${entry.file}: repository change flag mismatch`
    );
    assert.ok(result.system?.machine?.id,`${entry.file}: privacy-preserving machine identity is required`);
    assert.ok(result.system?.platform,`${entry.file}: OS platform is required`);
    assert.ok(result.system?.release,`${entry.file}: OS release is required`);
    assert.ok(result.system?.architecture,`${entry.file}: architecture is required`);
    assert.match(result.system?.node || '',/^v\d+\./u,`${entry.file}: Node version is required`);
    assert.ok(['github-actions','local'].includes(result.system?.environment?.provider),`${entry.file}: execution provider is required`);
    if(result.system.environment.provider === 'github-actions'){
        validateGitHubEnvironment(result,entry.file);
    }
    assert.match(result.oracle?.source?.sha256 || '',/^[0-9a-f]{64}$/u,`${entry.file}: oracle source SHA-256 is required`);
    assert.ok(Object.hasOwn(result.oracle,'build'),`${entry.file}: oracle build provenance is required`);
    assert.ok(result.config && typeof result.config === 'object',`${entry.file}: benchmark configuration is required`);
    assert.ok(Array.isArray(result.samples) && result.samples.length > 0,`${entry.file}: sanitized raw samples are required`);
    assert.deepEqual(result.summary,summarize(result.samples,result.system.platform),`${entry.file}: deterministic summary mismatch`);
    assert.ok(result.memory && typeof result.memory === 'object',`${entry.file}: memory summary is required`);
    assert.ok(result.gc && typeof result.gc === 'object',`${entry.file}: GC summary is required`);
    assert.equal(result.cleanup?.clean,true,`${entry.file}: tracked results must be internally clean`);
    assert.equal(result.cleanup.endpointLeaks,0,`${entry.file}: endpoints leaked`);
    assert.equal(result.cleanup.endpointReuseFailures,0,`${entry.file}: endpoints could not be reused`);
    assert.equal(result.cleanup.leftoverBytes,0,`${entry.file}: temporary bytes remain`);
    assert.equal(result.cleanup.leftoverEntries,0,`${entry.file}: temporary entries remain`);
    assert.equal(result.cleanup.openSockets,0,`${entry.file}: sockets remain open`);
    assert.equal(result.cleanup.samples,result.samples.length,`${entry.file}: cleanup sample count mismatch`);
    assert.equal(result.evidence?.authority,'snapshot-noisy',`${entry.file}: hosted evidence must be labelled snapshot/noisy`);
    const expectedComparison=result.config.adapters.some((adapter) => adapter.startsWith('node-ipc-'))
        ? 'profile-comparison'
        : 'baseline-only';
    assert.equal(result.evidence?.comparison?.state,expectedComparison,`${entry.file}: comparison state is incorrect`);
    if(expectedComparison === 'profile-comparison'){
        assert.equal(result.evidence.comparison.baseline,'node-net',`${entry.file}: profile baseline is incorrect`);
        assert.equal(result.evidence.comparison.certification,false,`${entry.file}: profile evidence cannot claim certification`);
    }
    assert.equal(result.evidence?.privacy?.sanitized,true,`${entry.file}: tracked evidence must be privacy-sanitized`);
    assert.equal(result.evidence?.publishable,true,`${entry.file}: only publishable evidence may be tracked`);
    assert.equal(result.evidence?.classification,'clean-c-oracle-snapshot',`${entry.file}: tracked evidence must be a clean C-oracle snapshot`);
    assert.equal(result.evidence?.packageFootprintStatus,'measured',`${entry.file}: package footprint must be measured`);
    assert.deepEqual(result.evidence?.comparison?.adapters,result.config.adapters,`${entry.file}: comparison adapter list mismatch`);

    assertNoEphemeralData(result,entry.file);

    for(const [index,sample] of result.samples.entries()){
        const label=`${entry.file}: sample ${index}`;
        assert.equal(sample.cleanup?.clean,true,`${label} is not internally clean`);
        assert.equal(sample.cleanup.naturalExit,true,`${label} processes did not exit naturally`);
        assert.equal(sample.cleanup.endpointClosed,true,`${label} endpoint did not close`);
        assert.equal(sample.cleanup.endpointReusable,true,`${label} endpoint was not reusable`);
        assert.equal(sample.cleanup.leftovers?.entries,0,`${label} left temporary entries`);
        assert.equal(sample.cleanup.leftovers?.bytes,0,`${label} left temporary bytes`);
        assert.equal(sample.processExit?.oracle?.code,0,`${label} oracle exit was not clean`);
        assert.equal(sample.processExit?.oracle?.signal,null,`${label} oracle received an exit signal`);
        assert.equal(sample.processExit?.worker?.code,0,`${label} worker exit was not clean`);
        assert.equal(sample.processExit?.worker?.signal,null,`${label} worker received an exit signal`);
        assert.equal(sample.exact?.sentFrames,sample.exact?.configuredFrames,`${label} sent-frame count mismatch`);
        assert.equal(sample.exact?.receivedFrames,sample.exact?.configuredFrames,`${label} received-frame count mismatch`);
        assert.equal(sample.exact?.byteCountsVerified,true,`${label} byte counts were not verified`);
        assert.equal(sample.exact?.oracleByteCountVerified,true,`${label} oracle byte counts were not verified`);
        assert.equal(sample.exact?.configuredFrames,result.config.frames[sample.pass],`${label} configured-frame count differs from its pass`);
        if(Object.hasOwn(sample.exact,'applicationSentBytes')){
            const applicationBytes=sample.exact.configuredFrames*result.config.payloadBytes;
            const totalWireBytes=sample.exact.probeWireSentBytes
                +sample.exact.warmupWireSentBytes
                +sample.exact.wireSentBytes;
            const totalWireBytesReceived=sample.exact.probeWireReceivedBytes
                +sample.exact.warmupWireReceivedBytes
                +sample.exact.wireReceivedBytes;
            assert.equal(sample.exact.applicationSentBytes,applicationBytes,`${label} application sent-byte count mismatch`);
            assert.equal(sample.exact.applicationReceivedBytes,applicationBytes,`${label} application received-byte count mismatch`);
            assert.equal(sample.exact.applicationByteCountsVerified,true,`${label} application byte counts were not verified`);
            assert.equal(sample.exact.sentBytes,sample.exact.wireSentBytes,`${label} wire sent-byte alias mismatch`);
            assert.equal(sample.exact.receivedBytes,sample.exact.wireReceivedBytes,`${label} wire received-byte alias mismatch`);
            assert.equal(sample.exact.wireReceivedBytes,sample.exact.wireSentBytes,`${label} measured wire bytes differ`);
            assert.equal(sample.exact.probeWireReceivedBytes,sample.exact.probeWireSentBytes,`${label} probe wire bytes differ`);
            assert.equal(sample.exact.warmupWireReceivedBytes,sample.exact.warmupWireSentBytes,`${label} warmup wire bytes differ`);
            assert.equal(sample.exact.framingOverheadBytes,sample.exact.wireSentBytes-applicationBytes,`${label} framing overhead mismatch`);
            assert.equal(sample.exact.contentVerified,true,`${label} payload content was not verified`);
            assert.equal(sample.exact.sequenceVerified,true,`${label} payload sequence was not verified`);
            assert.ok(sample.exact.correctnessFrames > 0,`${label} correctness probe did not run`);
            assert.equal(totalWireBytesReceived,totalWireBytes,`${label} total reflected wire bytes differ`);
            assert.equal(sample.exact.oracleBytes,totalWireBytes,`${label} oracle wire-byte count mismatch`);
        }else{
            assert.equal(sample.exact?.sentBytes,sample.exact.configuredFrames*result.config.payloadBytes,`${label} sent-byte count mismatch`);
            assert.equal(sample.exact?.receivedBytes,sample.exact.configuredFrames*result.config.payloadBytes,`${label} received-byte count mismatch`);
            assert.equal(sample.exact?.oracleBytes,(sample.exact.configuredFrames+result.config.warmupFrames)*result.config.payloadBytes,`${label} oracle byte count mismatch`);
        }
        assert.equal(sample.cleanup.oracle?.bytesIn,sample.exact.oracleBytes,`${label} oracle input byte count mismatch`);
        assert.equal(sample.cleanup.oracle?.bytesOut,sample.exact.oracleBytes,`${label} oracle output byte count mismatch`);
        assert.equal(sample.cleanup.worker?.openSockets,0,`${label} worker left sockets open`);
        assert.equal(sample.cleanup.worker?.pendingBytes,0,`${label} worker left pending bytes`);
        assert.deepEqual(sample.cleanup.worker?.activeResourceDelta,[],`${label} worker left active resources`);
        assert.equal(sample.cleanup.oracle?.activeSocketsAfterClose ?? 0,0,`${label} oracle left sockets open`);
        assert.equal(sample.metrics?.oracle?.saturated,false,`${label} saturated the oracle`);
        assert.ok(Number.isFinite(sample.metrics?.millisecondsPerMillion) && sample.metrics.millisecondsPerMillion > 0,`${label} timing metric must be finite and positive`);
        assert.ok(Number.isFinite(sample.metrics?.deltaMillisecondsPerMillion),`${label} paired delta must be finite`);
        assert.ok(sample.memory?.worker,`${label} worker memory checkpoints are required`);
        assert.ok(sample.gc,`${label} GC evidence is required`);
    }

    assert.equal(result.repository.dirty,false,`${entry.file}: tracked evidence must be clean-tree`);
    assert.equal(result.repository.changedDuringRun,false,`${entry.file}: tracked evidence requires identical pre/post Git state`);
    assert.equal(result.repository.preExecution.dirty,false,`${entry.file}: pre-execution tree must be clean`);
    assert.equal(result.repository.postExecution.dirty,false,`${entry.file}: post-execution tree must be clean`);
    assert.equal(result.repository.preExecution.statusSha256,result.repository.postExecution.statusSha256,`${entry.file}: pre/post Git status differs`);
    assert.equal(result.oracle.implementation,'standard-c',`${entry.file}: tracked evidence requires the C oracle`);
    assert.equal(canonicalConfiguration(result.config),true,`${entry.file}: tracked evidence requires canonical configuration`);
    assert.equal(
        oracleBuildVerified(result.oracle,result.system,sourceHashesAtCommit(result.repository.commit)),
        true,
        `${entry.file}: tracked evidence requires a verified canonical C build`
    );
    assert.equal(publicationSamplesClean(result.samples,result.cleanup),true,`${entry.file}: tracked evidence failed cleanup/count gates`);
    validateSampleTopology(result,entry.file);
    validateAggregateCleanup(result.samples,result.cleanup,entry.file);
    validatePackageFootprint(result.packageFootprint,entry.file);
    for(const adapter of result.config.adapters.filter((name) => name.startsWith('node-ipc-'))){
        assert.equal(
            result.memory.packageInstalledBytes?.[adapter],
            result.packageFootprint.installed.bytes,
            `${entry.file}: ${adapter} package footprint mismatch`
        );
    }
    assert.equal(result.evidence?.rankingEligible,false,`${entry.file}: profile evidence is not a certification or ranking`);

    const manifestFields={
        architecture:result.system.architecture,
        classification:result.evidence.classification,
        cleanupClean:result.cleanup.clean,
        commit:result.repository.commit,
        dirty:result.repository.dirty,
        file:result.record.file,
        generatedAt:result.generatedAt,
        id:result.id,
        machine:result.system.machine,
        node:result.system.node,
        oracle:result.oracle.implementation,
        packageFootprintStatus:result.evidence.packageFootprintStatus,
        platform:result.system.platform,
        publishable:result.evidence.publishable,
        rankingEligible:result.evidence.rankingEligible,
        sha256:entry.sha256
    };
    assert.deepEqual(entry,manifestFields,`${entry.file}: manifest summary differs from raw result`);
}

function validateGitHubEnvironment(result,file){
    const environment=result.system.environment;
    const platformForLane={
        'macos-latest':'darwin',
        'ubuntu-latest':'linux',
        'windows-latest':'win32'
    };
    const architectureForRunner={ARM:'arm',ARM64:'arm64',X64:'x64'};
    assert.equal(environment.githubRepository,'RIAEvangelist/node-ipc',`${file}: unexpected GitHub repository`);
    assert.ok(environment.imageOS,`${file}: GitHub runner image OS is required`);
    assert.ok(environment.imageVersion,`${file}: GitHub runner image version is required`);
    assert.equal(`v${environment.nodeLane}`,result.system.node,`${file}: requested Node lane differs from the runtime`);
    assert.match(environment.npm || '',/^npm\/\d/u,`${file}: npm version is required`);
    assert.equal(platformForLane[environment.osLane],result.system.platform,`${file}: requested OS lane differs from the runtime`);
    assert.match(environment.runAttempt || '',/^\d+$/u,`${file}: workflow run attempt is required`);
    assert.match(environment.runId || '',/^\d+$/u,`${file}: workflow run id is required`);
    assert.equal(architectureForRunner[environment.runnerArchitecture],result.system.architecture,`${file}: runner architecture mismatch`);
    assert.equal(environment.runnerEnvironment,'github-hosted',`${file}: official snapshots require a GitHub-hosted runner`);
    assert.equal(environment.sourceRef,'refs/heads/main',`${file}: official snapshots require main`);
    assert.equal(environment.sourceSha,result.repository.commit,`${file}: workflow source SHA mismatch`);
    assert.equal(environment.workflow,'Record benchmark snapshots',`${file}: unexpected workflow`);
    assert.equal(
        environment.workflowRef,
        'RIAEvangelist/node-ipc/.github/workflows/benchmark-snapshot.yml@refs/heads/main',
        `${file}: unexpected workflow reference`
    );
    assert.equal(environment.workflowSha,result.repository.commit,`${file}: workflow SHA mismatch`);
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
        && (
            JSON.stringify(config.adapters) === JSON.stringify(['node-net'])
            || JSON.stringify(config.adapters) === JSON.stringify(canonicalAdapters)
        );
}

function oracleBuildVerified(oracle,system,sourceHashes){
    return oracle.implementation === 'standard-c'
        && oracle.source?.sha256 === oracle.build?.sourceSha256
        && sourceHashes.has(oracle.source?.sha256)
        && /^[0-9a-f]{64}$/u.test(oracle.build?.binarySha256 || '')
        && fixedBuild(oracle.build,system)
        && oracle.build?.target?.platform === system.platform
        && oracle.build?.target?.architecture === system.architecture
        && typeof oracle.build?.target?.name === 'string'
        && oracle.build.target.name.length > 0;
}

function sourceHashesAtCommit(commit){
    if(sourceHashCache.has(commit)) return sourceHashCache.get(commit);
    const repositoryRoot=path.resolve(directory,'..');
    const source=execFileSync(
        'git',
        ['show',`${commit}:benchmark/oracle/echo.c`],
        {cwd:repositoryRoot,encoding:'buffer',maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}
    );
    const normalized=source.toString('utf8').replace(/\r\n?/gu,'\n');
    const hashes=new Set([
        sha256(source),
        sha256(normalized),
        sha256(normalized.replace(/\n/gu,'\r\n'))
    ]);
    sourceHashCache.set(commit,hashes);
    return hashes;
}

function fixedBuild(build,system){
    if(!build || typeof build.compiler !== 'string'){
        return false;
    }
    const compiler=build.compiler.toLowerCase();
    const microsoft=compiler === 'cl' || compiler === 'cl.exe';
    const expectedFlags=microsoft
        ? ['/nologo','/O2','ws2_32.lib']
        : ['-O3','-std=c11',...(system.platform === 'win32' ? ['-lws2_32'] : [])];
    const expectedTarget=system.platform === 'win32' ? 'raw-echo.exe' : 'raw-echo';
    return JSON.stringify(build.flags) === JSON.stringify(expectedFlags)
        && build.target?.name === expectedTarget
        && typeof build.version === 'string'
        && build.version.length > 0;
}

function publicationSamplesClean(samples,cleanup){
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
            && sample.exact?.byteCountsVerified
            && (sample.exact?.applicationByteCountsVerified ?? true)
            && (sample.exact?.contentVerified ?? true)
            && (sample.exact?.sequenceVerified ?? true)
            && sample.exact?.oracleByteCountVerified);
}

function validateSampleTopology(result,label){
    const expectedCount=result.config.passes.length
        * result.config.samplesPerPass
        * result.config.adapters.length;
    assert.equal(result.samples.length,expectedCount,`${label}: canonical sample count mismatch`);

    for(const adapter of result.config.adapters){
        for(const pass of result.config.passes){
            const group=result.samples.filter((sample) => sample.adapter === adapter && sample.pass === pass);
            assert.equal(group.length,result.config.samplesPerPass,`${label}: ${adapter}/${pass} must contain exactly ${result.config.samplesPerPass} samples`);
            assert.deepEqual(
                group.map((sample) => sample.index).sort((left,right) => left-right),
                Array.from({length:result.config.samplesPerPass},(_,index) => index),
                `${label}: ${adapter}/${pass} sample indexes must be complete and unique`
            );
        }
    }

    const baselines=new Map(result.samples
        .filter((sample) => sample.adapter === 'node-net')
        .map((sample) => [`${sample.pass}:${sample.index}`,sample.metrics.millisecondsPerMillion]));
    for(const sample of result.samples){
        assert.ok(result.config.adapters.includes(sample.adapter),`${label}: unknown adapter ${sample.adapter}`);
        assert.ok(result.config.passes.includes(sample.pass),`${label}: unknown pass ${sample.pass}`);
        const baseline=baselines.get(`${sample.pass}:${sample.index}`);
        assert.ok(Number.isFinite(baseline),`${label}: paired node-net baseline is missing`);
        assert.equal(sample.metrics.baselineMillisecondsPerMillion,baseline,`${label}: paired baseline mismatch`);
        assert.equal(
            sample.metrics.deltaMillisecondsPerMillion,
            sample.metrics.millisecondsPerMillion-baseline,
            `${label}: paired delta mismatch`
        );
        if(sample.adapter === 'node-net'){
            assert.equal(sample.metrics.deltaMillisecondsPerMillion,0,`${label}: node-net baseline delta must be zero`);
        }
    }
}

function validateAggregateCleanup(samples,cleanup,label){
    const expected={
        clean:samples.every((sample) => sample.cleanup.clean),
        endpointLeaks:samples.filter((sample) => !sample.cleanup.endpointClosed).length,
        endpointReuseFailures:samples.filter((sample) => !sample.cleanup.endpointReusable).length,
        leftoverBytes:samples.reduce((sum,sample) => sum+sample.cleanup.leftovers.bytes,0),
        leftoverEntries:samples.reduce((sum,sample) => sum+sample.cleanup.leftovers.entries,0),
        openSockets:samples.reduce(
            (sum,sample) => sum+sample.cleanup.worker.openSockets+(sample.cleanup.oracle.activeSocketsAfterClose ?? 0),
            0
        ),
        samples:samples.length
    };
    assert.deepEqual(cleanup,expected,`${label}: aggregate cleanup must be recomputed from raw samples`);
}

function validatePackageFootprint(footprint,label){
    assert.ok(footprint && typeof footprint === 'object',`${label}: package footprint is required`);
    for(const section of ['installed','package']){
        assert.ok(Number.isSafeInteger(footprint[section]?.bytes) && footprint[section].bytes > 0,`${label}: ${section} byte footprint is invalid`);
        assert.ok(Number.isSafeInteger(footprint[section]?.files) && footprint[section].files > 0,`${label}: ${section} file footprint is invalid`);
    }
    assert.ok(Number.isSafeInteger(footprint.tarball?.bytes) && footprint.tarball.bytes > 0,`${label}: tarball byte footprint is invalid`);
    assert.ok(Number.isSafeInteger(footprint.tarball?.files) && footprint.tarball.files > 0,`${label}: tarball file footprint is invalid`);
    assert.ok(Number.isSafeInteger(footprint.tarball?.unpackedBytes) && footprint.tarball.unpackedBytes > 0,`${label}: unpacked tarball footprint is invalid`);
    assert.match(footprint.tarball?.integrity || '',/^sha512-[A-Za-z0-9+/]+=*$/u,`${label}: tarball integrity is invalid`);
    for(const key of ['direct','instances','unique']){
        assert.ok(Number.isSafeInteger(footprint.dependencies?.[key]) && footprint.dependencies[key] >= 0,`${label}: dependency ${key} count is invalid`);
    }
}

function validateAppendOnlyHistory(current){
    const repositoryRoot=path.resolve(directory,'..');
    const manifestPath='benchmark/results/index.json';
    let revisions;
    try{
        revisions=execFileSync(
            'git',
            ['log','--format=%H','--',manifestPath],
            {cwd:repositoryRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}
        ).trim().split(/\r?\n/u).filter(Boolean);
    }catch{
        return;
    }

    const currentCanonical=JSON.stringify(current);
    let previous=null;
    for(const revision of revisions){
        try{
            const candidate=JSON.parse(execFileSync(
                'git',
                ['show',`${revision}:${manifestPath}`],
                {cwd:repositoryRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}
            ));
            if(JSON.stringify(candidate) === currentCanonical){
                continue;
            }
            previous=candidate;
            break;
        }catch{
            // A historical path lookup can fail across renames; keep looking.
        }
    }

    if(!previous){
        return;
    }
    assert.equal(previous.schemaVersion,2,'previous benchmark manifest schemaVersion must be 2');
    assert.ok(Date.parse(current.updatedAt) >= Date.parse(previous.updatedAt),'benchmark results updatedAt cannot move backward');
    assert.ok(previous.results.length <= current.results.length,'benchmark results manifest cannot delete historical entries');
    assert.deepEqual(
        current.results.slice(0,previous.results.length),
        previous.results,
        'benchmark results manifest is append-only; historical entries cannot be changed or reordered'
    );
}

function schemaErrors(value,definition,pointer){
    const failures=[];
    const types=Array.isArray(definition.type) ? definition.type : definition.type ? [definition.type] : [];
    if(types.length && !types.some((type) => matchesType(value,type))){
        return [`${pointer}: expected ${types.join(' or ')}`];
    }
    if(Object.hasOwn(definition,'const') && !deepEqual(value,definition.const)){
        failures.push(`${pointer}: value differs from const`);
    }
    if(definition.enum && !definition.enum.some((candidate) => deepEqual(value,candidate))){
        failures.push(`${pointer}: value is outside enum`);
    }
    if(typeof value === 'string'){
        if(definition.pattern && !new RegExp(definition.pattern,'u').test(value)){
            failures.push(`${pointer}: string does not match ${definition.pattern}`);
        }
        if(definition.format === 'date-time' && !validDate(value)){
            failures.push(`${pointer}: string is not an ISO date-time`);
        }
        if(definition.minLength !== undefined && value.length < definition.minLength){
            failures.push(`${pointer}: string is shorter than ${definition.minLength}`);
        }
    }
    if(typeof value === 'number' && definition.minimum !== undefined && value < definition.minimum){
        failures.push(`${pointer}: number is below ${definition.minimum}`);
    }
    if(Array.isArray(value)){
        if(definition.minItems !== undefined && value.length < definition.minItems){
            failures.push(`${pointer}: array has fewer than ${definition.minItems} items`);
        }
        if(definition.maxItems !== undefined && value.length > definition.maxItems){
            failures.push(`${pointer}: array has more than ${definition.maxItems} items`);
        }
        if(definition.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length){
            failures.push(`${pointer}: array items are not unique`);
        }
        if(definition.items){
            value.forEach((entry,index) => failures.push(...schemaErrors(entry,definition.items,`${pointer}/${index}`)));
        }
    }
    if(value && typeof value === 'object' && !Array.isArray(value)){
        for(const required of definition.required || []){
            if(!Object.hasOwn(value,required)){
                failures.push(`${pointer}: missing required property ${required}`);
            }
        }
        for(const [key,entry] of Object.entries(value)){
            if(definition.properties?.[key]){
                failures.push(...schemaErrors(entry,definition.properties[key],`${pointer}/${key}`));
            }else if(definition.additionalProperties === false){
                failures.push(`${pointer}: unexpected property ${key}`);
            }
        }
    }
    if(definition.anyOf && !definition.anyOf.some((candidate) => schemaErrors(value,candidate,pointer).length === 0)){
        failures.push(`${pointer}: value does not match anyOf`);
    }
    if(definition.not && schemaErrors(value,definition.not,pointer).length === 0){
        failures.push(`${pointer}: value matches forbidden schema`);
    }
    return failures;
}

function matchesType(value,type){
    if(type === 'null') return value === null;
    if(type === 'array') return Array.isArray(value);
    if(type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if(type === 'integer') return Number.isInteger(value);
    return typeof value === type;
}

function deepEqual(left,right){
    try{
        assert.deepEqual(left,right);
        return true;
    }catch{
        return false;
    }
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

function assertNoEphemeralData(value,label,pathSegments=[]){
    const bannedKeys=new Set(['endpoint','endpoints','pid','pids','port','trialDirectory']);
    if(Array.isArray(value)){
        value.forEach((entry,index) => assertNoEphemeralData(entry,label,[...pathSegments,String(index)]));
        return;
    }
    if(!value || typeof value !== 'object'){
        if(typeof value === 'string'){
            assert.ok(!/^[a-zA-Z]:[\\/]/u.test(value),`${label}: absolute Windows path at ${pathSegments.join('.')}`);
            assert.ok(!/^\/(?:Users|home|tmp|var\/tmp)\//u.test(value),`${label}: absolute POSIX path at ${pathSegments.join('.')}`);
        }
        return;
    }
    for(const [key,entry] of Object.entries(value)){
        assert.ok(!bannedKeys.has(key),`${label}: ephemeral field ${[...pathSegments,key].join('.')} is forbidden`);
        assertNoEphemeralData(entry,label,[...pathSegments,key]);
    }
}

async function readJson(file){
    return JSON.parse(await readFile(file,'utf8'));
}

function validDate(value){
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sha256(value){
    return createHash('sha256').update(value).digest('hex');
}
