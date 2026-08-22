import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const directory=path.dirname(fileURLToPath(import.meta.url));
const {stdout,stderr}=await execute(
    process.execPath,
    [
        path.join(directory,'run.js'),
        '--quick',
        '--oracle=c',
        '--samples=1',
        '--speed-messages=256',
        '--resource-messages=256',
        '--latency-messages=32',
        '--warmup=8',
        '--size=32',
        '--no-footprint'
    ],
    {
        cwd:path.resolve(directory,'..'),
        encoding:'utf8',
        maxBuffer:64*1024*1024,
        windowsHide:true
    }
);

if(stderr.trim()){
    process.stderr.write(stderr);
}

const result=JSON.parse(stdout);
assert.equal(result.oracle.implementation,'standard-c');
assert.equal(result.config.oracle,'c');
assert.equal(result.config.quick,true);
assert.equal(
    result.samples.length,
    result.config.passes.length
        * result.config.samplesPerPass
        * result.config.adapters.length
);
for(const pass of result.config.passes){
    for(const adapter of result.config.adapters){
        assert.equal(
            result.samples.filter(sample => sample.pass === pass && sample.adapter === adapter).length,
            result.config.samplesPerPass
        );
    }
}
assert.equal(result.cleanup.clean,true);
assert.equal(result.cleanup.endpointLeaks,0);
assert.equal(result.cleanup.endpointReuseFailures,0);
assert.equal(result.cleanup.leftoverEntries,0);
assert.equal(result.cleanup.openSockets,0);

for(const sample of result.samples){
    assert.equal(sample.cleanup.clean,true);
    assert.equal(sample.cleanup.naturalExit,true);
    assert.equal(sample.processExit.oracle.code,0);
    assert.equal(sample.processExit.worker.code,0);
    assert.equal(sample.exact.sentFrames,sample.exact.configuredFrames);
    assert.equal(sample.exact.receivedFrames,sample.exact.configuredFrames);
    assert.equal(sample.exact.byteCountsVerified,true);
    assert.equal(sample.exact.oracleByteCountVerified,true);
}

process.stdout.write('C-oracle benchmark smoke passed\n');
