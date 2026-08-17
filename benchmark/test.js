import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import VanillaTest from 'vanilla-test';

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
        assert.equal(result.samples.length, 3);
        assert.deepEqual(result.samples.map(sample => sample.pass), ['speed', 'resource', 'latency']);
    });
    await check(test, 'benchmark starts fresh oracle and worker processes for every sample', () => {
        assert.equal(new Set(result.samples.map(sample => sample.pids.oracle)).size, 3);
        assert.equal(new Set(result.samples.map(sample => sample.pids.worker)).size, 3);
    });
    await check(test, 'benchmark gives every sample a fresh endpoint and temporary root', () => {
        assert.equal(new Set(result.endpoints.map(endpoint => endpoint.port)).size, 3);
        assert.equal(new Set(result.samples.map(sample => sample.trialDirectory)).size, 3);
    });
    await check(test, 'benchmark accounts for exact sent, received, and reflected byte totals', () => {
        for (const sample of result.samples) {
            assert.equal(sample.exact.byteCountsVerified, true);
            assert.equal(sample.exact.oracleByteCountVerified, true);
            assert.equal(sample.exact.sentFrames, sample.exact.configuredFrames);
            assert.equal(sample.exact.receivedFrames, sample.exact.configuredFrames);
        }
    });
    await check(test, 'benchmark reports milliseconds per million against its paired baseline', () => {
        for (const sample of result.samples) {
            assert.ok(sample.metrics.millisecondsPerMillion > 0);
            assert.equal(sample.metrics.deltaMillisecondsPerMillion, 0);
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
    });

    return test.report();
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
