import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import VanillaTest from 'vanilla-test';
import {adapterOrder,buildDashboard,serializeDashboard} from './dashboard.js';
import {renderChart} from './render-chart.js';

const directory = path.dirname(fileURLToPath(import.meta.url));

async function check(test, description, assertion) {
    test.expects(description);
    try {
        await assertion();
        test.pass();
    } catch (error) {
        console.error(error);
        test.fail();
    } finally {
        test.done();
    }
}

async function run() {
    const child = spawnSync(process.execPath, [
        path.join(directory, 'run.js'),
        '--quick',
        '--samples=1',
        '--speed-messages=256',
        '--resource-messages=256',
        '--latency-messages=32',
        '--warmup=8',
        '--size=32'
    ], {encoding: 'utf8', timeout: 30000});
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    const test = new VanillaTest;

    await check(test, 'benchmark runs isolated speed, resource, and latency samples', () => {
        assert.equal(result.samples.length,12);
        assert.deepEqual(result.config.adapters,[
            'node-net',
            'node-ipc-raw',
            'node-ipc-fast',
            'node-ipc-guarded'
        ]);
        for(const pass of ['speed','resource','latency']){
            assert.equal(result.samples.filter(sample => sample.pass === pass).length,4);
        }
    });
    await check(test, 'benchmark records fresh oracle and worker processes for every sample', () => {
        assert.equal(result.pids.samples.length,12);
        result.samples.forEach((sample,index) => {
            assert.deepEqual(result.pids.samples[index],sample.pids);
            assert.ok(Number.isInteger(sample.pids.oracle) && sample.pids.oracle > 0);
            assert.ok(Number.isInteger(sample.pids.worker) && sample.pids.worker > 0);
            assert.notEqual(sample.pids.oracle,sample.pids.worker);
            assert.notEqual(sample.pids.oracle,result.pids.runner);
            assert.notEqual(sample.pids.worker,result.pids.runner);
        });
    });
    await check(test, 'benchmark records every fresh endpoint binding and temporary root', () => {
        assert.equal(result.endpoints.length,12);
        result.endpoints.forEach((endpoint,index) => {
            assert.deepEqual(endpoint,result.samples[index].endpoint);
            assert.equal(typeof endpoint.host,'string');
            assert.ok(endpoint.host.length > 0);
            assert.ok(Number.isInteger(endpoint.port));
            assert.ok(endpoint.port > 0 && endpoint.port <= 65535);
        });
        assert.equal(new Set(result.samples.map(sample => sample.trialDirectory)).size,12);
    });
    await check(test, 'benchmark accounts for application, wire, and reflected byte totals', () => {
        for (const sample of result.samples) {
            assert.equal(sample.exact.applicationByteCountsVerified,true);
            assert.equal(sample.exact.byteCountsVerified, true);
            assert.equal(sample.exact.oracleByteCountVerified, true);
            assert.equal(sample.exact.sentFrames, sample.exact.configuredFrames);
            assert.equal(sample.exact.receivedFrames, sample.exact.configuredFrames);
            assert.equal(sample.exact.applicationSentBytes,32*sample.exact.configuredFrames);
            assert.equal(sample.exact.applicationReceivedBytes,32*sample.exact.configuredFrames);
            assert.equal(sample.exact.sentBytes,sample.exact.wireSentBytes);
            assert.equal(sample.exact.receivedBytes,sample.exact.wireReceivedBytes);
        }
    });
    await check(test,'benchmark verifies content and sequence outside the timed path',() => {
        for(const sample of result.samples){
            assert.equal(sample.exact.contentVerified,true);
            assert.equal(sample.exact.sequenceVerified,true);
            assert.equal(sample.exact.correctnessFrames,64);
        }
    });
    await check(test, 'benchmark reports milliseconds per million against its paired baseline', () => {
        for (const sample of result.samples) {
            assert.ok(sample.metrics.millisecondsPerMillion > 0);
            assert.ok(Number.isFinite(sample.metrics.deltaMillisecondsPerMillion));
            if(sample.adapter === 'node-net'){
                assert.equal(sample.metrics.deltaMillisecondsPerMillion,0);
            }
        }
    });
    await check(test,'benchmark keeps raw payload bytes raw and reports framed overhead',() => {
        for(const sample of result.samples){
            if(['node-net','node-ipc-raw'].includes(sample.adapter)){
                assert.equal(sample.exact.framingOverheadBytes,0);
            }else{
                assert.ok(sample.exact.framingOverheadBytes > 0);
                assert.ok(sample.metrics.wireBytesPerSecond > sample.metrics.applicationBytesPerSecond);
            }
        }
    });
    await check(test, 'benchmark closes every socket and naturally exits every process', () => {
        for (const sample of result.samples) {
            assert.equal(sample.cleanup.naturalExit, true);
            assert.equal(sample.cleanup.worker.openSockets, 0);
            assert.equal(sample.processExit.oracle.code, 0);
            assert.equal(sample.processExit.worker.code, 0);
        }
    });
    await check(test, 'benchmark releases and immediately reuses every endpoint', () => {
        assert.equal(result.cleanup.endpointLeaks, 0);
        assert.equal(result.cleanup.endpointReuseFailures, 0);
        assert.ok(result.samples.every(sample => sample.cleanup.endpointReusable));
    });
    await check(test, 'benchmark leaves no active resources or temporary files', () => {
        assert.equal(result.cleanup.leftoverEntries, 0);
        assert.equal(result.cleanup.openSockets, 0);
        assert.ok(result.samples.every(sample => sample.cleanup.worker.activeResourceDelta.length === 0));
    });
    await check(test, 'benchmark captures every memory baseline outside the timed path', () => {
        for (const sample of result.samples) {
            assert.ok(sample.memory.worker.beforeImport);
            assert.ok(sample.memory.worker.afterImport);
            assert.ok(sample.memory.worker.connected);
            assert.ok(sample.memory.worker.ready);
            assert.ok(sample.memory.worker.postRun);
            assert.ok(sample.memory.worker.afterCleanupGc);
        }
    });
    await check(test, 'benchmark keeps GC observation out of speed and latency passes', () => {
        assert.equal(result.samples.find(sample => sample.pass === 'speed').gc.observed, false);
        assert.equal(result.samples.find(sample => sample.pass === 'latency').gc.observed, false);
    });
    await check(test, 'benchmark instruments resources without contaminating package footprint', () => {
        assert.equal(result.samples.find(sample => sample.pass === 'resource').gc.observed, true);
        assert.equal(result.packageFootprint, null);
        assert.equal(result.cleanup.clean, true);
        assert.equal(result.evidence.comparisonState,'profile-comparison');
        assert.equal(result.evidence.comparison.certification,false);
        assert.equal(result.evidence.rankingEligible,false);
    });

    const dashboard=await buildDashboard();
    const dashboardBytes=serializeDashboard(dashboard);
    const chart=renderChart(dashboard);

    await check(test,'benchmark dashboard preserves schema-v2 history in exact environments',() => {
        assert.equal(dashboard.schemaVersion,1);
        assert.equal(dashboard.source.schemaVersion,2);
        assert.equal(dashboard.source.resultCount,6);
        assert.equal(dashboard.environments.length,6);
        assert.equal(new Set(dashboard.environments.map(environment => environment.key)).size,6);
        for(const environment of dashboard.environments){
            assert.equal(environment.key,[
                environment.platform,
                environment.architecture,
                environment.node,
                environment.commit
            ].join('/'));
            assert.deepEqual(environment.runs[0].adapters.map(adapter => adapter.id),adapterOrder);
            assert.equal(environment.runs[0].comparisonState,'baseline-only');
        }
    });
    await check(test,'benchmark dashboard verifies every tracked detail hash',async() => {
        for(const environment of dashboard.environments){
            for(const run of environment.runs){
                const file=path.basename(new URL(run.raw.detail,'https://example.invalid/').pathname);
                const bytes=await readFile(path.join(directory,'results',file));
                assert.equal(createHash('sha256').update(bytes).digest('hex'),run.raw.sha256);
            }
        }
    });
    await check(test,'benchmark dashboard exposes measured distributions and evidence',() => {
        for(const environment of dashboard.environments){
            const run=environment.runs[0];
            const baseline=run.adapters[0];
            const milliseconds=baseline.passes.speed.millisecondsPerMillion;
            const frames=baseline.passes.speed.framesPerSecond;
            assert.ok(milliseconds.minimum <= milliseconds.median);
            assert.ok(milliseconds.median <= milliseconds.p95);
            assert.ok(milliseconds.p95 <= milliseconds.maximum);
            assert.ok(frames.minimum > 0 && frames.maximum >= frames.p95);
            assert.ok(baseline.memory.peakRssBytes.maximum > 0);
            assert.equal(baseline.cleanup.clean,true);
            assert.ok(run.resources.packageFootprint.tarball.bytes > 0);
            assert.ok(run.provenance.commit);
            assert.match(run.raw.detail,/^data\/benchmarks\/run-[A-Za-z0-9-]+[.]json$/u);
        }
    });
    await check(test,'benchmark dashboard never enables rankings or certification',() => {
        assertDisabledEvidence(dashboard);
    });
    await check(test,'benchmark dashboard and accessible SVG are deterministic',async() => {
        const nextDashboard=serializeDashboard(await buildDashboard());
        assert.equal(nextDashboard,dashboardBytes);
        assert.equal(renderChart(JSON.parse(nextDashboard)),chart);
        assert.match(createHash('sha256').update(chart).digest('hex'),/^[0-9a-f]{64}$/u);
        assert.equal((chart.match(/<g class="environment"/gu) || []).length,6);
        assert.match(chart,/<title id="title">/u);
        assert.match(chart,/<desc id="description">/u);
        assert.match(chart,/BASELINE ONLY · PROFILES PENDING/u);
        assert.doesNotMatch(chart,/<script\b/iu);
        assert.equal(await readFile(path.join(directory,'../docs/assets/node-ipc-benchmark.svg'),'utf8'),chart);
    });

    return test.report();
}

function assertDisabledEvidence(value){
    if(Array.isArray(value)){
        value.forEach(assertDisabledEvidence);
        return;
    }
    if(!value || typeof value !== 'object') return;
    for(const [key,entry] of Object.entries(value)){
        if(key === 'rankingEligible' || key === 'certification'){
            assert.equal(entry,false,`${key} must remain false`);
        }
        assertDisabledEvidence(entry);
    }
}

const directInvocation = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (directInvocation) {
    const result = await run();
    process.exitCode = result.ok ? 0 : 1;
}

export {
    run as default,
    run
};
