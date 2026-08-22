import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBenchmark} from './run.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const result=await runBenchmark({
    currentRoot:root,
    legacyRoot:root,
    measuredFrames:100000,
    payloadBytes:64,
    probeFrames:32,
    quick:true,
    samplesPerVersion:1,
    timeoutMs:30000,
    transports:['udp4','udp6'],
    udpOracle:'c',
    udpWindow:64,
    warmupFrames:10000
});

assert.equal(result.oracles['standard-c-datagram-reflector'].implementation,'standard-c-datagram-reflector');
assert.equal(result.config.oracleByTransport.udp4,'standard-c-datagram-reflector');
assert.equal(result.config.oracleByTransport.udp6,'standard-c-datagram-reflector');
assert.equal(result.cleanup.clean,true);
assert.equal(result.samples.length,4);
for(const sample of result.samples){
    assert.equal(sample.oracle,'standard-c-datagram-reflector');
    assert.equal(sample.cleanup.clean,true);
    assert.equal(sample.exact.countVerified,true);
    assert.equal(sample.exact.contentVerified,true);
    assert.equal(sample.exact.sequenceVerified,true);
    assert.equal(sample.exact.oracleBytesVerified,true);
    assert.equal(sample.exact.datagramCountsVerified,true);
    assert.equal(sample.metrics.oracleSaturated,false);
}

process.stdout.write('standard-C UDP4/UDP6 oracle smoke passed\n');
