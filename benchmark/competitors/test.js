import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildArtifactData} from './artifact-data.js';
import {definitions,matrix} from './capabilities.js';
import {catalog} from './catalog.js';
import {complexityReport,sourceLines} from './complexity.js';
import {dependencyExposure,riskTier} from './dependencies.js';
import {baseWilliamsOrder,buildPlan,williamsOrder} from './plan.js';
import {createMessage,createMessageFactory,encodedBytes,emptyEnvelopeBytes,verifyMessage} from './protocol.js';
import {distribution,quantile} from './stats.js';
import {subjectIds} from './subjects.js';
import {validateResult} from './validate.js';

const directory=path.dirname(fileURLToPath(import.meta.url));

assert.ok(emptyEnvelopeBytes < 64);
for(const bytes of [64,1024,65536]){
    const factory=createMessageFactory(bytes);
    const message=factory(42);
    assert.equal(encodedBytes(message),bytes);
    assert.equal(createMessage(bytes,42).payload,message.payload);
    verifyMessage(message,bytes,42,factory.payload);
}
assert.throws(() => createMessage(8,0));

assert.deepEqual(baseWilliamsOrder(6),[0,1,5,2,4,3]);
const labels=['a','b','c','d','e','f'];
for(let position=0;position<labels.length;position+=1){
    assert.deepEqual(
        new Set(Array.from({length:6},(_,block) => williamsOrder(labels,block)[position])),
        new Set(labels)
    );
}
assert.equal(buildPlan(labels,[64],['throughput','latency'],2).length,24);

assert.equal(quantile([1,2,3,4],0.5),2.5);
assert.deepEqual(distribution([1,2,3]),{
    count:3,
    iqr:1,
    mad:1,
    maximum:3,
    median:2,
    minimum:1,
    p25:1.5,
    p75:2.5
});
assert.equal(sourceLines('\n// comment\nconst value=1;\n'),1);

for(const subject of subjectIds){
    assert.ok(matrix[subject]);
    for(const definition of definitions){
        assert.ok(matrix[subject][definition.id]);
        assert.match(matrix[subject][definition.id].source,/^https:\/\//u);
    }
}
assert.equal(definitions.length,14);
assert.equal(matrix['native-net'].parentChild.status,'manual');
assert.equal(matrix['node-ipc'].queueingBackpressure.status,'profile-dependent');
assert.equal(catalog['node-ipc'].benchmarkVersion,'14.0.0');
assert.equal(catalog['node-ipc'].benchmarkProfile,'fast');
assert.equal(catalog['node-ipc'].packages[0].npmLatestVersion,'12.0.0');

const dependencies=await dependencyExposure();
assert.equal(dependencies['native-child-process'].uniqueResolvedDependencies,0);
assert.equal(dependencies['native-net'].uniqueResolvedDependencies,0);
assert.equal(dependencies.ws.uniqueResolvedDependencies,0);
assert.equal(dependencies.zeromq.directUniqueDependencies,2);
assert.equal(dependencies['node-ipc'].directUniqueDependencies,3);
assert.equal(dependencies['node-ipc'].uniqueResolvedDependencies,5);
assert.equal(dependencies['socket-io'].directUniqueDependencies,9);
assert.equal(dependencies['socket-io'].uniqueResolvedDependencies,23);
assert.equal(riskTier(0),'minimal');
assert.equal(riskTier(5),'low');
assert.equal(riskTier(15),'moderate');
assert.equal(riskTier(16),'high');

const complexity=await complexityReport();
for(const subject of subjectIds){
    assert.ok(complexity[subject].sourceLines > 0);
    assert.match(complexity[subject].sourceSha256,/^[0-9a-f]{64}$/u);
}

const artifactData=buildArtifactData();
assert.equal(artifactData.datasets.performance.length,subjectIds.length*3);
assert.equal(artifactData.datasets.exposure.length,subjectIds.length);
assert.equal(artifactData.datasets.capabilities.length,subjectIds.length*definitions.length);
for(const query of Object.values(artifactData.queries)){
    assert.match(query,/^WITH\b/u);
}

const unbalanced=spawnSync(process.execPath,[path.join(directory,'run.js'),'--samples=5'],{
    cwd:directory,
    encoding:'utf8',
    timeout:10000
});
assert.notEqual(unbalanced.status,0);
assert.match(unbalanced.stderr,/--samples must be a multiple/u);

const invalidWorkload=spawnSync(process.execPath,[
    path.join(directory,'run.js'),
    '--quick',
    '--latency-messages=0'
],{
    cwd:directory,
    encoding:'utf8',
    timeout:10000
});
assert.notEqual(invalidWorkload.status,0);
assert.match(invalidWorkload.stderr,/--latency-messages must be a positive integer/u);

const child=spawnSync(process.execPath,[
    path.join(directory,'run.js'),
    '--quick',
    '--samples=1',
    '--payloads=64',
    '--throughput-messages=128',
    '--latency-messages=32',
    '--warmup=16',
    '--probe=8'
],{
    cwd:directory,
    encoding:'utf8',
    timeout:60000
});
assert.equal(child.status,0,child.stderr || child.stdout);
const result=JSON.parse(child.stdout);
await validateResult(result);
assert.equal(result.validation.expectedSamples,subjectIds.length*2);
assert.equal(result.validation.successfulSamples,subjectIds.length*2);

const failedSample=structuredClone(result);
failedSample.samples[0].status='failed';
failedSample.samples[0].error='injected validation failure';
delete failedSample.samples[0].metrics;
delete failedSample.samples[0].exact;
await assert.rejects(
    validateResult(failedSample,{verifyFiles:false}),
    /failedSamples must be recomputed/u
);

const wrongPlan=structuredClone(result);
wrongPlan.samples[0].orderIndex+=1;
await assert.rejects(
    validateResult(wrongPlan,{verifyFiles:false}),
    /sample 0 orderIndex/u
);

const wrongSummary=structuredClone(result);
wrongSummary.summary[0].roundTripsPerSecond.median+=1;
await assert.rejects(
    validateResult(wrongSummary,{verifyFiles:false}),
    /summary must match raw samples/u
);

const wrongLock=structuredClone(result);
wrongLock.packageLocks.benchmark='0'.repeat(64);
await assert.rejects(
    validateResult(wrongLock),
    /benchmark lock hash mismatch/u
);

process.stdout.write('competitor benchmark tests passed\n');
