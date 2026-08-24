import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildArtifactData} from './artifact-data.js';
import {
    definitions,
    matrix,
    transportDefinitions as capabilityTransportDefinitions,
    transportMatrix
} from './capabilities.js';
import {catalog} from './catalog.js';
import {complexityReport,sourceLines} from './complexity.js';
import {dependencyExposure,riskTier} from './dependencies.js';
import {
    assertDatagram,
    assertFragment,
    createFragmentReassembler,
    fragmentCountForBytes,
    fragmentDatagram,
    fragmentMessage,
    logicalWindowForUdp,
    udpChunkBytes,
    udpDatagramBytes,
    udpDatagramWindow
} from './lib/udp.js';
import {laneDefinitions,laneIds,moduleIds,transportIds} from './lanes.js';
import {
    baseWilliamsOrder,
    buildCohortPlan,
    buildPlan,
    cycleLength,
    williamsOrder
} from './plan.js';
import {createMessage,createMessageFactory,encodedBytes,emptyEnvelopeBytes,verifyMessage} from './protocol.js';
import {renderReport} from './render-report.js';
import {distribution,quantile} from './stats.js';
import {subjectIds} from './subjects.js';
import {validateResult} from './validate.js';
import {effectiveWindowForTransport,windowed} from './worker.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const schemaV2='https://riaevangelist.github.io/node-ipc/data/competitor-benchmarks/result-schema-v2.json';

function runBenchmark(arguments_,timeout=180000){
    const child=spawnSync(process.execPath,[path.join(directory,'run.js'),...arguments_],{
        cwd:directory,
        encoding:'utf8',
        maxBuffer:20*1024*1024,
        timeout
    });
    assert.equal(child.status,0,child.stderr || child.stdout);
    return JSON.parse(child.stdout);
}

function assertWilliamsBalance(size){
    const labels=Array.from({length:size},(_,index) => `s${index}`);
    const cycle=cycleLength(size);
    const rows=Array.from({length:cycle},(_,block) => williamsOrder(labels,block));
    const expectedPositionCount=cycle/size;
    for(let position=0;position<size;position+=1){
        for(const label of labels){
            assert.equal(rows.filter(row => row[position] === label).length,expectedPositionCount);
        }
    }
    if(size > 1){
        const expectedPairCount=cycle/size;
        for(const first of labels){
            for(const second of labels){
                if(first === second){
                    continue;
                }
                const count=rows.reduce((total,row) => total+row.slice(0,-1).filter(
                    (value,index) => value === first && row[index+1] === second
                ).length,0);
                assert.equal(count,expectedPairCount,`${size}-lane ${first} -> ${second}`);
            }
        }
    }
}

function assertCertificateCovers(certificate,date,label){
    const instant=date.getTime();
    assert.ok(Number.isFinite(instant),`${label} comparison date`);
    assert.ok(new Date(certificate.validFrom).getTime() <= instant,`${label} not yet valid`);
    assert.ok(new Date(certificate.validTo).getTime() >= instant,`${label} expired`);
}

assert.ok(emptyEnvelopeBytes < 64);
for(const bytes of [64,1024,65536]){
    const factory=createMessageFactory(bytes);
    const message=factory(42);
    assert.equal(encodedBytes(message),bytes);
    assert.equal(createMessage(bytes,42).payload,message.payload);
    verifyMessage(message,bytes,42,factory.payload);
}
assert.throws(() => createMessage(8,0));

assert.equal(udpChunkBytes,1024);
assert.equal(udpDatagramBytes,1200);
assert.equal(udpDatagramWindow,64);
assert.equal(fragmentCountForBytes(64),1);
assert.equal(fragmentCountForBytes(4096),4);
assert.equal(fragmentCountForBytes(65536),64);
assert.equal(logicalWindowForUdp(64),64);
assert.equal(logicalWindowForUdp(4096),16);
assert.equal(logicalWindowForUdp(65536),1);
assert.equal(effectiveWindowForTransport('udp4',64,128,64,8*1024*1024),64);
assert.equal(effectiveWindowForTransport('udp4',4096,128,64,8*1024*1024),16);
assert.equal(effectiveWindowForTransport('udp6',65536,128,64,8*1024*1024),1);
assert.equal(effectiveWindowForTransport('tcp',65536,128,64,8*1024*1024),64);
assert.throws(() => fragmentCountForBytes(0),/UDP logical message bytes/u);
assert.throws(() => fragmentCountForBytes(65537),/UDP logical message bytes/u);
assert.throws(() => logicalWindowForUdp(64,0),/positive integer/u);
assert.throws(() => assertDatagram(Buffer.alloc(udpDatagramBytes+1)),/received 1201/u);

const udpPeer={address:'127.0.0.1',port:32000};
for(const [bytes,expectedFragments] of [[64,1],[4096,4],[65536,64]]){
    const message=createMessage(bytes,42);
    const fragments=fragmentMessage(message,'q');
    assert.equal(fragments.length,expectedFragments);
    const reassembler=createFragmentReassembler({direction:'q'});
    let completed=null;
    for(const fragment of [...fragments].reverse()){
        assertFragment(fragment,'q');
        assert.ok(assertDatagram(fragmentDatagram(fragment)) <= udpDatagramBytes);
        assert.ok(assertDatagram(
            `${JSON.stringify({type:'benchmark.udp.fragment',data:fragment})}\f`,
            'node-ipc fast UDP frame'
        ) <= udpDatagramBytes);
        completed=reassembler.accept(fragment,udpPeer) ?? completed;
    }
    assert.deepEqual(completed?.message,message);
    assert.equal(completed?.fragmentCount,expectedFragments);
    assert.equal(reassembler.metrics().acceptedFragments,expectedFragments);
    assert.equal(reassembler.metrics().completedMessages,1);
    assert.equal(reassembler.metrics().pendingMessages,0);
    assert.equal(
        reassembler.metrics().outOfOrderFragments > 0,
        expectedFragments > 1
    );
}

const duplicatedFragments=fragmentMessage(createMessage(4096,43),'q');
const duplicateReassembler=createFragmentReassembler({direction:'q'});
assert.equal(duplicateReassembler.accept(duplicatedFragments[0],udpPeer),null);
assert.equal(duplicateReassembler.accept(duplicatedFragments[0],udpPeer),null);
let duplicateCompleted;
for(const fragment of duplicatedFragments.slice(1)){
    duplicateCompleted=duplicateReassembler.accept(fragment,udpPeer) ?? duplicateCompleted;
}
assert.equal(duplicateCompleted.message.sequence,'0000002b');
assert.equal(duplicateReassembler.metrics().duplicateFragments,1);
assert.equal(duplicateReassembler.metrics().completedMessages,1);
assert.equal(duplicateReassembler.metrics().pendingMessages,0);

const conflictingReassembler=createFragmentReassembler({direction:'q'});
conflictingReassembler.accept(duplicatedFragments[0],udpPeer);
const conflicting={
    ...duplicatedFragments[0],
    c:`${duplicatedFragments[0].c.slice(0,-1)}y`
};
assert.throws(
    () => conflictingReassembler.accept(conflicting,udpPeer),
    /duplicate conflicts/u
);
assert.equal(conflictingReassembler.metrics().conflictingDuplicates,1);
assert.equal(conflictingReassembler.metrics().pendingMessages,1);
conflictingReassembler.clear();
assert.equal(conflictingReassembler.metrics().pendingMessages,0);

const missingReassembler=createFragmentReassembler({direction:'q'});
for(const fragment of duplicatedFragments.slice(0,-1)){
    assert.equal(missingReassembler.accept(fragment,udpPeer),null);
}
assert.equal(missingReassembler.metrics().pendingMessages,1);
missingReassembler.clear();
assert.equal(missingReassembler.metrics().pendingMessages,0);

const secondUdpPeer={address:'::1',port:32001};
const isolatedReassembler=createFragmentReassembler({direction:'q'});
assert.equal(isolatedReassembler.accept(duplicatedFragments[0],udpPeer),null);
assert.equal(isolatedReassembler.accept(duplicatedFragments[0],secondUdpPeer),null);
let isolatedCompletions=0;
for(const fragment of duplicatedFragments.slice(1)){
    isolatedCompletions+=isolatedReassembler.accept(fragment,udpPeer) ? 1 : 0;
    isolatedCompletions+=isolatedReassembler.accept(fragment,secondUdpPeer) ? 1 : 0;
}
assert.equal(isolatedCompletions,2);
assert.equal(isolatedReassembler.metrics().completedMessages,2);
assert.equal(isolatedReassembler.metrics().maximumPendingMessages,2);
assert.equal(isolatedReassembler.metrics().pendingMessages,0);
assert.throws(
    () => createFragmentReassembler({direction:'q'}).accept(duplicatedFragments[0],{
        address:'127.0.0.1',port:0
    }),
    /UDP peer requires/u
);

const oneFragment=fragmentMessage(createMessage(64,44),'q')[0];
const completedDuplicateReassembler=createFragmentReassembler({direction:'q'});
assert.ok(completedDuplicateReassembler.accept(oneFragment,udpPeer));
assert.ok(completedDuplicateReassembler.accept(oneFragment,udpPeer));
assert.equal(completedDuplicateReassembler.metrics().completedMessages,2);
assert.equal(completedDuplicateReassembler.metrics().duplicateFragments,0);

assert.throws(
    () => assertFragment({...duplicatedFragments[0],i:duplicatedFragments[0].n},'q'),
    /index is invalid/u
);
assert.throws(
    () => assertFragment({...duplicatedFragments[0],n:duplicatedFragments[0].n+1},'q'),
    /count must be/u
);
assert.throws(
    () => assertFragment({...duplicatedFragments[0],c:duplicatedFragments[0].c.slice(1)},'q'),
    /chunk must contain/u
);
assert.throws(
    () => assertFragment(duplicatedFragments[0],'r'),
    /expected UDP fragment direction r/u
);

function syntheticClient(factory,startSequence,responseOffsets){
    const sent=new Set;
    const offsets=[...responseOffsets];
    return {
        send(message){
            sent.add(message.sequence);
        },
        async receive(){
            const offset=offsets.shift();
            const message=factory(startSequence+offset);
            assert.ok(sent.has(message.sequence),`synthetic response ${message.sequence} was not sent`);
            return message;
        },
        sent
    };
}

const unorderedFactory=createMessageFactory(64);
const unorderedStart=0x300000;
const unorderedClient=syntheticClient(unorderedFactory,unorderedStart,[2,0,1,4,3,5]);
const unorderedWindow=await windowed(
    unorderedClient,
    unorderedFactory,
    64,
    6,
    unorderedStart,
    3,
    8*1024*1024,
    {orderIndependent:true,transportId:'udp4'}
);
assert.equal(unorderedWindow.received,6);
assert.equal(unorderedWindow.sent,6);
assert.equal(unorderedWindow.maximumInFlight,3);
assert.equal(unorderedWindow.window,3);
assert.equal(unorderedClient.sent.size,6);

const orderedClient=syntheticClient(unorderedFactory,unorderedStart,[2]);
await assert.rejects(
    windowed(
        orderedClient,
        unorderedFactory,
        64,
        3,
        unorderedStart,
        3,
        8*1024*1024
    ),
    /expected sequence 00300000/u
);
const duplicateResponseClient=syntheticClient(unorderedFactory,unorderedStart,[0,0]);
await assert.rejects(
    windowed(
        duplicateResponseClient,
        unorderedFactory,
        64,
        3,
        unorderedStart,
        3,
        8*1024*1024,
        {orderIndependent:true,transportId:'udp4'}
    ),
    /duplicate response sequence 00300000/u
);

assert.deepEqual(baseWilliamsOrder(6),[0,1,5,2,4,3]);
assert.equal(cycleLength(1),1);
assert.equal(cycleLength(5),10);
assert.equal(cycleLength(6),6);
assertWilliamsBalance(1);
assertWilliamsBalance(5);
assertWilliamsBalance(6);
const legacyLabels=['a','b','c','d','e','f'];
assert.equal(buildPlan(legacyLabels,[64],['throughput','latency'],2).length,24);
const twoTransportPlan=buildCohortPlan([
    laneDefinitions['native-net:tcp'],
    laneDefinitions['native-net:local']
],[64],['throughput'],{tcp:1,local:1});
assert.deepEqual(twoTransportPlan.map(row => row.laneId),['native-net:tcp','native-net:local']);
assert.deepEqual(twoTransportPlan.map(row => row.block),[0,0]);

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

for(const moduleId of moduleIds){
    assert.ok(matrix[moduleId]);
    for(const definition of definitions){
        assert.ok(matrix[moduleId][definition.id]);
        assert.match(matrix[moduleId][definition.id].source,/^https:\/\//u);
    }
    for(const transportId of transportIds){
        assert.ok(transportMatrix[moduleId][transportId]);
        assert.match(transportMatrix[moduleId][transportId].source,/^https:\/\//u);
    }
}
assert.deepEqual(Object.keys(capabilityTransportDefinitions),transportIds);
assert.deepEqual(transportIds,['process-ipc','tcp','local','tls','udp4','udp6']);
assert.deepEqual(
    laneIds.filter(laneId => ['udp4','udp6'].includes(laneDefinitions[laneId].transportId)),
    ['native-dgram:udp4','native-dgram:udp6','node-ipc:udp4','node-ipc:udp6']
);
assert.equal(definitions.length,14);
assert.equal(matrix['native-net'].parentChild.status,'manual');
assert.equal(matrix['node-ipc'].queueingBackpressure.status,'profile-dependent');
assert.equal(catalog['node-ipc'].benchmarkVersion,'14.0.0');
assert.equal(catalog['node-ipc'].benchmarkProfile,'fast');
assert.equal(catalog['node-ipc'].packages[0].npmLatestVersion,'12.0.0');
const measuredCoverage=[];
for(const moduleId of moduleIds){
    for(const transportId of transportIds){
        if(transportMatrix[moduleId][transportId].status === 'measured'){
            measuredCoverage.push(`${moduleId}:${transportId}`);
        }
    }
}
assert.deepEqual(measuredCoverage,laneIds);

const dependencies=await dependencyExposure();
assert.equal(dependencies['native-child-process'].uniqueResolvedDependencies,0);
assert.equal(dependencies['native-net'].uniqueResolvedDependencies,0);
assert.equal(dependencies['native-tls'].uniqueResolvedDependencies,0);
assert.equal(dependencies['native-dgram'].uniqueResolvedDependencies,0);
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
for(const moduleId of moduleIds){
    assert.ok(complexity[moduleId].sourceLines > 0);
    assert.match(complexity[moduleId].sourceSha256,/^[0-9a-f]{64}$/u);
}

const legacyArtifactData=buildArtifactData(
    path.join(directory,'results/windows-node24-20260823.json')
);
assert.equal(legacyArtifactData.source.schemaVersion,1);
assert.match(legacyArtifactData.source.sha256,/^[0-9a-f]{64}$/u);
assert.equal(legacyArtifactData.datasets.performance.length,subjectIds.length*3);
assert.equal(legacyArtifactData.datasets.exposure.length,subjectIds.length);
assert.equal(legacyArtifactData.datasets.capabilities.length,subjectIds.length*definitions.length);
assert.equal(legacyArtifactData.datasets['transport-lanes'].length,subjectIds.length);
assert.equal(legacyArtifactData.datasets['transport-coverage'].length,0);
for(const query of Object.values(legacyArtifactData.queries)){
    assert.match(query,/^WITH\b/u);
    assert.match(query,/benchmark_result\(\)/u);
}
const currentArtifactData=buildArtifactData();
const trackedTransportResult=JSON.parse(await readFile(currentArtifactData.source.file,'utf8'));
const trackedLaneCount=Object.keys(
    trackedTransportResult.dimensions.lanes ?? trackedTransportResult.dimensions.cases
).length;
const trackedModuleCount=Object.keys(trackedTransportResult.dependencyExposure).length;
const trackedTransportCount=Object.keys(
    trackedTransportResult.capabilities.transportDefinitions
).length;
assert.equal(currentArtifactData.source.schemaVersion,2);
assert.equal(currentArtifactData.datasets.performance.length,trackedLaneCount*3);
assert.equal(currentArtifactData.datasets.exposure.length,trackedModuleCount);
assert.equal(currentArtifactData.datasets.capabilities.length,trackedModuleCount*definitions.length);
assert.equal(currentArtifactData.datasets['transport-lanes'].length,trackedLaneCount);
assert.equal(
    currentArtifactData.datasets['transport-coverage'].length,
    trackedModuleCount*trackedTransportCount
);
const legacyResult=JSON.parse(await readFile(
    path.join(directory,'results/windows-node24-20260823.json'),'utf8'
));
await validateResult(legacyResult);

const unbalanced=spawnSync(process.execPath,[path.join(directory,'run.js'),'--samples=5'],{
    cwd:directory,
    encoding:'utf8',
    timeout:10000
});
assert.notEqual(unbalanced.status,0);
assert.match(unbalanced.stderr,/must be divisible by the tcp cohort cycle \(10\)/u);

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

const result=runBenchmark([
    '--quick',
    '--payloads=64',
    '--throughput-messages=128',
    '--latency-messages=32',
    '--warmup=16',
    '--probe=8'
]);
await validateResult(result);
assert.equal(result.schemaVersion,2);
assert.equal(result.$schema,schemaV2);
assert.equal(result.validation.expectedSamples,laneIds.length*2);
assert.equal(result.validation.successfulSamples,laneIds.length*2);
assert.deepEqual(result.config.laneIds,laneIds);
assert.deepEqual(result.evidence.comparison,{
    crossTransportRankingEligible:false,
    transportEffectEligible:false,
    unit:'transport-lane',
    withinTransportRankingEligible:false
});

const fixtureDirectory=path.join(directory,'fixtures','tls');
const certificates=Object.fromEntries(await Promise.all([
    ['ca',path.join(fixtureDirectory,'ca-cert.pem')],
    ['server',path.join(fixtureDirectory,'server-cert.pem')],
    ['client',path.join(fixtureDirectory,'client-cert.pem')]
].map(async ([name,file]) => [name,new X509Certificate(await readFile(file))])));
for(const [name,certificate] of Object.entries(certificates)){
    assertCertificateCovers(certificate,new Date(),`${name} certificate current date`);
    assertCertificateCovers(certificate,new Date(result.generatedAt),`${name} certificate generatedAt`);
}
assert.match(certificates.server.subjectAltName,/DNS:localhost/u);
assert.match(certificates.server.subjectAltName,/IP Address:127\.0\.0\.1/u);
assert.equal(certificates.server.checkHost('localhost'),'localhost');
assert.equal(certificates.server.checkIP('127.0.0.1'),'127.0.0.1');
const tlsLaneIds=laneIds.filter(laneId => laneDefinitions[laneId].transportId === 'tls');
assert.deepEqual(tlsLaneIds,[
    'native-tls:tls','node-ipc:tls','ws:tls','socket-io:tls'
]);
const tlsSamples=result.samples.filter(sample => sample.transportId === 'tls');
assert.equal(tlsSamples.length,tlsLaneIds.length*result.config.workloads.length);
assert.deepEqual(new Set(tlsSamples.map(sample => sample.laneId)),new Set(tlsLaneIds));
for(const sample of tlsSamples){
    assert.equal(sample.status,'ok');
    assert.equal(sample.metrics.tls.authorized,true);
    assert.equal(sample.metrics.tls.protocol,'TLSv1.3');
}
const udpLaneIds=laneIds.filter(laneId => ['udp4','udp6'].includes(
    laneDefinitions[laneId].transportId
));
assert.deepEqual(udpLaneIds,[
    'native-dgram:udp4','native-dgram:udp6','node-ipc:udp4','node-ipc:udp6'
]);
const udpSamples=result.samples.filter(sample => ['udp4','udp6'].includes(sample.transportId));
assert.equal(udpSamples.length,udpLaneIds.length*result.config.workloads.length);
assert.deepEqual(new Set(udpSamples.map(sample => sample.laneId)),new Set(udpLaneIds));
for(const sample of udpSamples){
    const expectedWindow=sample.workload === 'latency' ? 1 : 64;
    assert.equal(sample.status,'ok');
    assert.equal(sample.config.effectiveWindowMessages,expectedWindow);
    assert.equal(sample.metrics.maximumInFlight,expectedWindow);
    assert.equal(sample.metrics.udp.fragmentCountPerMessage,1);
    assert.equal(sample.metrics.udp.expectedDatagramsPerDirection,sample.config.frames);
    assert.equal(sample.metrics.udp.datagramsWritten,sample.config.frames);
    assert.equal(sample.metrics.udp.acceptedFragments,sample.config.frames);
    assert.equal(sample.metrics.udp.completedMessages,sample.config.frames);
    assert.equal(sample.metrics.udp.pendingMessages,0);
    assert.equal(sample.metrics.udp.conflictingDuplicates,0);
    assert.equal(sample.metrics.udp.retransmissions,0);
    assert.ok(sample.metrics.udp.maximumDatagramBytes <= udpDatagramBytes);
}

const udpSampleIndex=result.samples.findIndex(sample => ['udp4','udp6'].includes(
    sample.transportId
));
assert.notEqual(udpSampleIndex,-1);
const oversizedUdpDatagram=structuredClone(result);
oversizedUdpDatagram.samples[udpSampleIndex].metrics.udp.maximumDatagramBytes=udpDatagramBytes+1;
await assert.rejects(
    validateResult(oversizedUdpDatagram,{verifyFiles:false}),
    /UDP maximum datagram exceeds 1200/u
);
const pendingUdpAssembly=structuredClone(result);
pendingUdpAssembly.samples[udpSampleIndex].metrics.udp.pendingMessages=1;
await assert.rejects(
    validateResult(pendingUdpAssembly,{verifyFiles:false}),
    /UDP pending messages/u
);
const conflictingUdpDuplicate=structuredClone(result);
conflictingUdpDuplicate.samples[udpSampleIndex].metrics.udp.conflictingDuplicates=1;
await assert.rejects(
    validateResult(conflictingUdpDuplicate,{verifyFiles:false}),
    /UDP conflicting duplicates/u
);
const wrongUdpDatagramCount=structuredClone(result);
wrongUdpDatagramCount.samples[udpSampleIndex].metrics.udp.datagramsWritten+=1;
await assert.rejects(
    validateResult(wrongUdpDatagramCount,{verifyFiles:false}),
    /UDP written datagrams/u
);
const wrongUdpWindow=structuredClone(result);
wrongUdpWindow.samples[udpSampleIndex].config.effectiveWindowMessages+=1;
await assert.rejects(
    validateResult(wrongUdpWindow,{verifyFiles:false}),
    /UDP effective window/u
);

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

const duplicateSample=structuredClone(result);
duplicateSample.samples[1]=structuredClone(duplicateSample.samples[0]);
await assert.rejects(
    validateResult(duplicateSample,{verifyFiles:false}),
    /sample cohort\/block\/lane\/payload\/workload tuples must be unique/u
);

const mismatchedSampleModule=structuredClone(result);
mismatchedSampleModule.samples[0].moduleId='native-net';
await assert.rejects(
    validateResult(mismatchedSampleModule,{verifyFiles:false}),
    /sample 0 moduleId/u
);

const unknownLane=structuredClone(result);
unknownLane.config.laneIds[0]='unknown:tcp';
await assert.rejects(
    validateResult(unknownLane,{verifyFiles:false}),
    /unknown laneId unknown:tcp/u
);

const mismatchedDimension=structuredClone(result);
mismatchedDimension.dimensions.lanes['native-net:tcp'].transportId='unknown';
await assert.rejects(
    validateResult(mismatchedDimension,{verifyFiles:false}),
    /unknown transportId unknown/u
);

const duplicateSummary=structuredClone(result);
duplicateSummary.summary[1]=structuredClone(duplicateSummary.summary[0]);
await assert.rejects(
    validateResult(duplicateSummary,{verifyFiles:false}),
    /summary lane\/payload\/workload tuples must be unique/u
);

const incompleteSummary=structuredClone(result);
incompleteSummary.summary.pop();
await assert.rejects(
    validateResult(incompleteSummary,{verifyFiles:false}),
    /summary must cover every configured cell/u
);

const mismatchedSummaryTransport=structuredClone(result);
mismatchedSummaryTransport.summary[0].transportId='tcp';
await assert.rejects(
    validateResult(mismatchedSummaryTransport,{verifyFiles:false}),
    /summary 0 transportId/u
);

const rankingClaim=structuredClone(result);
rankingClaim.evidence.comparison.crossTransportRankingEligible=true;
await assert.rejects(
    validateResult(rankingClaim,{verifyFiles:false}),
    /crossTransportRankingEligible/u
);

const extraCohortCount=structuredClone(result);
extraCohortCount.config.samplesByCohort.extra=1;
await assert.rejects(
    validateResult(extraCohortCount,{verifyFiles:false}),
    /samplesByCohort keys must match selected cohorts/u
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

const twoTransportResult=runBenchmark([
    '--quick',
    '--lanes=native-net:tcp,native-net:local',
    '--payloads=64',
    '--throughput-messages=64',
    '--latency-messages=16',
    '--warmup=8',
    '--probe=4'
]);
await validateResult(twoTransportResult);
assert.deepEqual(twoTransportResult.config.moduleIds,['native-net']);
assert.deepEqual(twoTransportResult.config.transportIds,['tcp','local']);
assert.equal(twoTransportResult.validation.expectedSamples,4);

const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-artifact-test-'));
try{
    const resultFile=path.join(temporaryRoot,'arbitrary-input.json');
    const resultBytes=Buffer.from(`${JSON.stringify(twoTransportResult,null,2)}\n`);
    await writeFile(resultFile,resultBytes);
    const arbitraryArtifactData=buildArtifactData(resultFile);
    assert.equal(arbitraryArtifactData.source.file,resultFile);
    assert.equal(arbitraryArtifactData.source.id,twoTransportResult.id);
    assert.equal(arbitraryArtifactData.source.schemaVersion,2);
    assert.equal(
        arbitraryArtifactData.source.sha256,
        createHash('sha256').update(resultBytes).digest('hex')
    );
    assert.equal(arbitraryArtifactData.datasets.performance.length,2);
    assert.equal(arbitraryArtifactData.datasets.exposure.length,1);
    assert.equal(arbitraryArtifactData.datasets.capabilities.length,definitions.length);
    assert.equal(arbitraryArtifactData.datasets['transport-lanes'].length,2);
    assert.equal(
        arbitraryArtifactData.datasets['transport-coverage'].length,
        Object.keys(capabilityTransportDefinitions).length
    );
    assert.deepEqual(
        arbitraryArtifactData.datasets.performance.map(row => row.laneId),
        ['native-net:tcp','native-net:local']
    );
    assert.equal(new Set(arbitraryArtifactData.datasets.performance.map(
        row => `${row.laneId}\0${row.payloadBytes}`
    )).size,2,'performance query must not multiply module rows across transports');
    assert.equal(arbitraryArtifactData.datasets.exposure[0].laneCount,2);
    assert.equal(arbitraryArtifactData.datasets.exposure[0].moduleId,'native-net');

    const report=await renderReport(twoTransportResult,{
        input:resultFile,
        output:path.join(temporaryRoot,'REPORT.md'),
        validateOptions:{verifyFiles:false}
    });
    const tcpHeading='### TCP loopback cohort — Throughput';
    const localHeading='### Local IPC cohort — Throughput';
    assert.ok(report.indexOf(tcpHeading) < report.indexOf(localHeading));
    assert.match(report,/No global, cross-transport, within-transport, or transport-effect ranking is eligible/u);
    assert.match(report,/## Transport support and measurement scope/u);
    assert.doesNotMatch(report,/placed \d+ of|overall winner|ranked #/iu);
    assert.match(report,/raw JSON preserves every sample and the reported distributions/u);
    const dependencySection=report.split('## Dependency exposure is counted once per module')[1]
        .split('## Implementation-glue complexity')[0];
    assert.equal((dependencySection.match(/^\| Node net \|/gmu) ?? []).length,1);

    const fullReport=await renderReport(result,{
        input:'quick-result.json',
        output:path.join(temporaryRoot,'FULL.md'),
        validateOptions:{verifyFiles:false}
    });
    assert.match(fullReport,/one-lane process IPC cohort is a descriptive baseline only/iu);
    assert.match(fullReport,/It has no same-transport comparator, so no ordinal result is calculated/u);
    assert.match(fullReport,/UDP4 and UDP6 carry those same logical bytes/u);
    assert.match(fullReport,/1,024-byte canonical-ASCII fragments/u);
    assert.match(fullReport,/complete compact JSON datagram of at most 1,200 bytes/u);
    assert.match(fullReport,/adds no acknowledgement, retry, retransmission, authentication, or confidentiality/u);
}finally{
    await rm(temporaryRoot,{force:true,recursive:true});
}

process.stdout.write('competitor benchmark tests passed\n');
