import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBenchmark,transportOrder,versionOrder} from './run.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const result=await runBenchmark({
    currentRoot:root,
    legacyRoot:root,
    measuredFrames:128,
    payloadBytes:64,
    probeFrames:8,
    quick:true,
    samplesPerVersion:1,
    timeoutMs:30000,
    transports:transportOrder,
    udpWindow:8,
    warmupFrames:32
});

assert.equal(result.schemaVersion,1);
assert.equal(result.rankingEligible,false);
assert.deepEqual(result.config.transports,transportOrder);
assert.deepEqual(result.config.versions,versionOrder);
assert.equal(result.config.messages,128);
assert.equal(result.config.pairsPerTransport,1);
assert.equal(result.config.currentVersion,'13.0.0');
assert.equal(result.oracles['node-byte-reflector'].runtime,process.version);
assert.equal(result.samples.length,transportOrder.length*versionOrder.length);
assert.equal(result.summary.length,transportOrder.length);
assert.equal(result.cleanup.clean,true);
assert.deepEqual(result.cleanup.activeHandles,[]);

for(const transport of transportOrder){
    const samples=result.samples.filter((sample) => sample.transport === transport);
    assert.deepEqual(samples.map((sample) => sample.version),versionOrder);
    for(const sample of samples){
        assert.equal(sample.rootVersion,'13.0.0');
        assert.equal(sample.oracle,'node-byte-reflector');
        assert.equal(sample.exact.countVerified,true);
        assert.equal(sample.exact.contentVerified,true);
        assert.equal(sample.exact.sequenceVerified,true);
        assert.equal(sample.exact.oracleBytesVerified,true);
        assert.equal(sample.cleanup.clean,true);
        assert.deepEqual(sample.cleanup.activeHandles,[]);
        assert.deepEqual(sample.cleanup.activeResourceDelta,[]);
        assert.deepEqual(sample.cleanup.oracleActiveResourceDelta,[]);
        assert.equal(sample.securityMode,transport === 'tls' ? 'encryption-only' : 'plaintext');
    }
}

process.stdout.write(`transport benchmark smoke passed: ${result.samples.length} samples, ${transportOrder.length} transports\n`);
