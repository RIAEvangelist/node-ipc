import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {
    definitions as capabilityDefinitions,
    matrix as capabilityMatrix,
    transportDefinitions as capabilityTransportDefinitions,
    transportMatrix as capabilityTransportMatrix
} from './capabilities.js';
import {asOf,catalog,popularityWindow,sources} from './catalog.js';
import {complexityReport} from './complexity.js';
import {dependencyExposure} from './dependencies.js';
import {buildCohortPlan,buildPlan,cycleLength} from './plan.js';
import {distribution} from './stats.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(directory,'../..');
const stableId=/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/u;
const schemaV2='https://riaevangelist.github.io/node-ipc/data/competitor-benchmarks/result-schema-v2.json';

function cleanupFailed(sample){
    return sample.status === 'ok' && (
        sample.cleanup?.naturalExit !== true
        || sample.cleanup?.workerNaturalExit !== true
        || sample.cleanup?.temporaryEntries !== 0
        || sample.cleanup?.artifactRemoved === false
        || sample.cleanup?.endpointClosed === false
        || sample.cleanup?.endpointReusable === false
    );
}

function summaryMetrics(row,successful){
    if(!successful.length){
        return row;
    }
    row.coldStartNs=distribution(successful.map(sample => Number(sample.coldStartNs)));
    row.roundTripsPerSecond=distribution(
        successful.map(sample => sample.metrics.roundTripsPerSecond)
    );
    if(row.workload === 'throughput'){
        row.applicationMiBPerSecond=distribution(
            successful.map(sample => sample.metrics.applicationMiBPerSecond)
        );
    }else{
        row.latencyNs={
            p50:distribution(successful.map(sample => sample.metrics.latencyNs.p50Ns)),
            p95:distribution(successful.map(sample => sample.metrics.latencyNs.p95Ns)),
            p99:distribution(successful.map(sample => sample.metrics.latencyNs.p99Ns))
        };
    }
    return row;
}

function summarizeV1(result){
    const summary=[];
    for(const subject of result.config.subjects){
        for(const payloadBytes of result.config.payloads){
            for(const workload of result.config.workloads){
                const cell=result.samples.filter(sample => sample.subjectId === subject
                    && sample.payloadBytes === payloadBytes
                    && sample.workload === workload);
                const successful=cell.filter(sample => sample.status === 'ok');
                summary.push(summaryMetrics({
                    failures:cell.length-successful.length,
                    payloadBytes,
                    samples:successful.length,
                    subject,
                    workload
                },successful));
            }
        }
    }
    return summary;
}

function laneMap(result){
    return result.dimensions?.lanes ?? result.dimensions?.cases;
}

function summarizeV2(result){
    const summary=[];
    const lanes=laneMap(result);
    for(const laneId of result.config.laneIds){
        const lane=lanes[laneId];
        for(const payloadBytes of result.config.payloads){
            for(const workload of result.config.workloads){
                const cell=result.samples.filter(sample => sample.laneId === laneId
                    && sample.payloadBytes === payloadBytes
                    && sample.workload === workload);
                const successful=cell.filter(sample => sample.status === 'ok');
                summary.push(summaryMetrics({
                    cohortId:lane.cohortId,
                    failures:cell.length-successful.length,
                    laneId,
                    moduleId:lane.moduleId,
                    payloadBytes,
                    samples:successful.length,
                    transportId:lane.transportId,
                    workload
                },successful));
            }
        }
    }
    return summary;
}

function summarize(result){
    if(result.schemaVersion === 1){
        return summarizeV1(result);
    }
    if(result.schemaVersion === 2){
        return summarizeV2(result);
    }
    throw new Error(`unsupported schemaVersion ${result.schemaVersion}`);
}

function assertUnique(values,label){
    assert.equal(new Set(values).size,values.length,`${label} must be unique`);
}

function assertExactKeys(object,expected,label){
    assert.deepEqual(Object.keys(object).sort(),[...expected].sort(),`${label} fields`);
}

function assertPositiveInteger(value,label){
    assert.ok(Number.isSafeInteger(value) && value > 0,`${label} must be a positive integer`);
}

function assertApproximately(actual,expected,label){
    const tolerance=Math.max(1e-12,Math.abs(expected)*1e-12);
    assert.ok(Math.abs(actual-expected) <= tolerance,`${label}: expected ${expected}, received ${actual}`);
}

function assertStableId(value,label){
    assert.ok(typeof value === 'string' && stableId.test(value),`${label} must be a colon-safe stable id`);
}

function orderedUnique(values){
    return [...new Set(values)];
}

async function sha256(file){
    const normalized=(await readFile(file,'utf8')).replaceAll('\r\n','\n');
    return createHash('sha256').update(normalized).digest('hex');
}

function assertSampleMeasurement(sample,index){
    assert.equal(sample.exact.contentVerified,true);
    assert.equal(sample.exact.sequenceVerified,true);
    assert.equal(sample.exact.measuredFrames,sample.config.frames);
    assert.equal(sample.config.payloadBytes,sample.payloadBytes);
    assert.equal(sample.config.workload,sample.workload);
    assert.ok(Number.isSafeInteger(sample.config.frames) && sample.config.frames > 0);
    assert.ok(Number.isSafeInteger(sample.config.warmupFrames) && sample.config.warmupFrames > 0);
    assert.equal(sample.cleanup.naturalExit,true);
    assert.equal(sample.cleanup.workerNaturalExit,true);
    assert.equal(sample.cleanup.temporaryEntries,0);
    assert.equal(sample.cleanup.temporaryBytes,0);
    assert.notEqual(sample.cleanup.artifactRemoved,false);
    assert.notEqual(sample.cleanup.endpointClosed,false);
    assert.notEqual(sample.cleanup.endpointReusable,false);
    assert.ok(sample.metrics.roundTripsPerSecond > 0);
    assert.ok(sample.metrics.applicationMiBPerSecond > 0);
    assertApproximately(
        sample.metrics.applicationMiBPerSecond,
        sample.metrics.roundTripsPerSecond*sample.payloadBytes/(1024*1024),
        `sample ${index} application MiB/s`
    );
    if(sample.workload === 'latency'){
        assert.ok(sample.metrics.latencyNs.p50Ns > 0);
        assert.ok(sample.metrics.latencyNs.p95Ns >= sample.metrics.latencyNs.p50Ns);
        assert.ok(sample.metrics.latencyNs.p99Ns >= sample.metrics.latencyNs.p95Ns);
        assert.equal(sample.metrics.maximumInFlight,1);
    }else{
        assert.equal(sample.metrics.latencyNs,null);
        assert.ok(sample.metrics.maximumInFlight > 0);
    }
}

function assertValidationTotals(result){
    const failedSamples=result.samples.filter(sample => sample.status !== 'ok').length;
    const cleanupFailures=result.samples.filter(cleanupFailed).length;
    const successfulSamples=result.samples.length-failedSamples;
    const complete=failedSamples === 0 && cleanupFailures === 0;
    assert.equal(result.validation.failedSamples,failedSamples,'failedSamples must be recomputed');
    assert.equal(result.validation.successfulSamples,successfulSamples,'successfulSamples must be recomputed');
    assert.equal(result.validation.cleanupFailures,cleanupFailures,'cleanupFailures must be recomputed');
    assert.equal(result.validation.complete,complete,'complete must be recomputed');
}

function assertLegacyEvidence(result){
    assert.ok(Array.isArray(result.capabilities?.definitions)
        && result.capabilities.definitions.length > 0,'legacy capability definitions');
    assertUnique(result.capabilities.definitions.map(({id}) => id),'legacy capability definition ids');
    assert.ok(result.capabilities?.matrix && typeof result.capabilities.matrix === 'object','legacy capability matrix');
    assert.ok(result.catalog?.subjects && typeof result.catalog.subjects === 'object','legacy subject catalog');
    assert.ok(result.catalog?.sources && typeof result.catalog.sources === 'object','legacy source catalog');
}

async function validateV1(result,{verifyFiles=true}={}){
    assert.equal(result.schemaVersion,1);
    assert.equal(result.classification,'local-snapshot-noisy');
    assert.equal(result.evidence.rankingEligible,false);
    assert.ok(Array.isArray(result.config.subjects) && result.config.subjects.length > 0);
    assert.ok(Array.isArray(result.config.payloads) && result.config.payloads.length > 0);
    assert.ok(Array.isArray(result.config.workloads) && result.config.workloads.length > 0);
    assert.ok(Number.isSafeInteger(result.config.samples) && result.config.samples > 0);
    assertUnique(result.config.subjects,'subjects');
    assertUnique(result.config.payloads,'payloads');
    assertUnique(result.config.workloads,'workloads');
    if(!result.config.quick){
        assert.equal(
            result.config.samples%result.config.subjects.length,
            0,
            'non-quick snapshots must contain complete subject-count order cycles'
        );
    }
    const plan=buildPlan(
        result.config.subjects,
        result.config.payloads,
        result.config.workloads,
        result.config.samples
    );
    assert.equal(result.validation.expectedSamples,plan.length);
    assert.equal(result.samples.length,plan.length);
    assert.equal(result.summary.length,
        result.config.subjects.length*result.config.payloads.length*result.config.workloads.length
    );
    assertLegacyEvidence(result);
    for(const subject of result.config.subjects){
        assert.ok(result.capabilities.matrix[subject],`missing capabilities for ${subject}`);
        assert.ok(result.complexity[subject],`missing complexity for ${subject}`);
        assert.ok(result.dependencyExposure[subject],`missing dependencies for ${subject}`);
        assert.match(result.complexity[subject].sourceSha256,/^[0-9a-f]{64}$/u);
        for(const definition of result.capabilities.definitions){
            const capability=result.capabilities.matrix[subject][definition.id];
            assert.ok(capability,`missing ${definition.id} for ${subject}`);
            assert.match(capability.source,/^https:\/\//u);
            assert.ok(capability.status);
        }
    }
    for(let index=0;index<plan.length;index+=1){
        const expected=plan[index];
        const sample=result.samples[index];
        assert.equal(sample.block,expected.block,`sample ${index} block`);
        assert.equal(sample.orderIndex,expected.orderIndex,`sample ${index} orderIndex`);
        assert.equal(sample.payloadBytes,expected.payloadBytes,`sample ${index} payloadBytes`);
        assert.equal(sample.subjectId,expected.subject,`sample ${index} subject`);
        assert.equal(sample.workload,expected.workload,`sample ${index} workload`);
        assert.ok(['ok','failed'].includes(sample.status),`sample ${index} status`);
        if(sample.status !== 'ok'){
            assert.ok(typeof sample.error === 'string' && sample.error,`sample ${index} missing error`);
            continue;
        }
        assert.equal(sample.subject.id,sample.subjectId);
        assertSampleMeasurement(sample,index);
        if(sample.workload === 'throughput'){
            assert.ok(sample.metrics.maximumInFlight <= result.config.windowMessages);
        }
    }
    assertValidationTotals(result);
    assert.deepEqual(result.summary,summarizeV1(result),'summary must match raw samples');
    assert.match(result.packageLocks.benchmark,/^[0-9a-f]{64}$/u,'legacy benchmark lock hash');
    assert.match(result.packageLocks.repository,/^[0-9a-f]{64}$/u,'legacy repository lock hash');
    // Schema-v1 snapshots are immutable historical evidence. Current catalogs,
    // adapter hashes, and lock closures may legitimately advance under v2, so
    // live-file equality is intentionally reserved for native schema-v2 runs.
    void verifyFiles;
    return true;
}

function assertV2Dimensions(result){
    const transports=result.dimensions?.transports;
    const lanes=laneMap(result);
    assert.ok(transports && typeof transports === 'object' && !Array.isArray(transports),'dimensions.transports must be a keyed object');
    assert.ok(lanes && typeof lanes === 'object' && !Array.isArray(lanes),'dimensions.lanes must be a keyed object');
    assert.ok(!(result.dimensions.lanes && result.dimensions.cases),'dimensions cannot contain both lanes and cases');
    for(const [transportId,transport] of Object.entries(transports)){
        assertStableId(transportId,`transport key ${transportId}`);
        assert.equal(transport.id,transportId,`transport ${transportId} id`);
        assertExactKeys(
            transport,
            ['id','label','family','implementation','scope','securityMode'],
            `transport ${transportId}`
        );
        for(const field of ['label','family','implementation','scope','securityMode']){
            assert.ok(typeof transport[field] === 'string' && transport[field],`transport ${transportId} ${field}`);
        }
    }
    for(const [laneId,lane] of Object.entries(lanes)){
        assertStableId(laneId,`lane key ${laneId}`);
        assert.equal(lane.id,laneId,`lane ${laneId} id`);
        assertExactKeys(
            lane,
            [
                'id','moduleId','transportId','cohortId','label','protocolStack','topology',
                'serialization','securityMode','sourceFiles'
            ],
            `lane ${laneId}`
        );
        for(const field of ['moduleId','transportId','cohortId','label','topology','serialization','securityMode']){
            assert.ok(typeof lane[field] === 'string' && lane[field],`lane ${laneId} ${field}`);
        }
        assertStableId(lane.moduleId,`lane ${laneId} moduleId`);
        assertStableId(lane.transportId,`lane ${laneId} transportId`);
        assertStableId(lane.cohortId,`lane ${laneId} cohortId`);
        assert.ok(Array.isArray(lane.protocolStack) && lane.protocolStack.length > 0,`lane ${laneId} protocolStack`);
        assert.ok(lane.protocolStack.every(value => typeof value === 'string' && value),`lane ${laneId} protocolStack entries`);
        assert.ok(Array.isArray(lane.sourceFiles) && lane.sourceFiles.length > 0,`lane ${laneId} sourceFiles`);
        assert.ok(lane.sourceFiles.every(value => typeof value === 'string' && value),`lane ${laneId} sourceFiles entries`);
        assert.ok(transports[lane.transportId],`lane ${laneId} unknown transportId ${lane.transportId}`);
        assert.equal(lane.securityMode,transports[lane.transportId].securityMode,`lane ${laneId} securityMode`);
        assert.ok(catalog[lane.moduleId],`lane ${laneId} unknown moduleId ${lane.moduleId}`);
        assert.equal(
            capabilityTransportMatrix[lane.moduleId]?.[lane.transportId]?.status,
            'measured',
            `lane ${laneId} must have measured transport coverage`
        );
    }
    return {lanes,transports};
}

function samplesForCohort(config,cohortId){
    return config.samplesByCohort?.[cohortId] ?? config.samples;
}

function assertV2Plan(result,lanes){
    const selected=result.config.laneIds.map(laneId => lanes[laneId]);
    const selectedCohorts=orderedUnique(selected.map(lane => lane.cohortId));
    assert.ok(result.config.samplesByCohort
        && typeof result.config.samplesByCohort === 'object'
        && !Array.isArray(result.config.samplesByCohort),'config.samplesByCohort');
    assert.deepEqual(
        Object.keys(result.config.samplesByCohort),
        selectedCohorts,
        'config.samplesByCohort keys must match selected cohorts in configured order'
    );
    const samplesByCohort={};
    for(const cohortId of selectedCohorts){
        const count=samplesForCohort(result.config,cohortId);
        assert.ok(Number.isSafeInteger(count) && count > 0,`samples for ${cohortId} must be a positive integer`);
        samplesByCohort[cohortId]=count;
        const size=selected.filter(lane => lane.cohortId === cohortId).length;
        if(!result.config.quick){
            assert.equal(
                count%cycleLength(size),
                0,
                `non-quick ${cohortId} cohort must contain complete ${cycleLength(size)}-row cycles`
            );
        }
    }
    if(result.config.samples !== undefined){
        assert.ok(Number.isSafeInteger(result.config.samples) && result.config.samples > 0,'config.samples');
        const uniqueCounts=orderedUnique(Object.values(samplesByCohort));
        assert.equal(uniqueCounts.length,1,'config.samples is only valid when every cohort count matches');
        assert.equal(result.config.samples,uniqueCounts[0],'config.samples must match samplesByCohort');
    }
    const plan=buildCohortPlan(selected,result.config.payloads,result.config.workloads,samplesByCohort);
    assert.equal(result.validation.expectedSamples,plan.length);
    assert.equal(result.samples.length,plan.length);
    assertUnique(result.samples.map(sample => [
        sample.cohortId,sample.block,sample.laneId,sample.payloadBytes,sample.workload
    ].join('\0')),'sample cohort/block/lane/payload/workload tuples');
    for(let index=0;index<plan.length;index+=1){
        const expected=plan[index];
        const sample=result.samples[index];
        for(const field of ['block','cohortId','laneId','moduleId','orderIndex','payloadBytes','transportId','workload']){
            assert.equal(sample[field],expected[field],`sample ${index} ${field}`);
        }
    }
    return plan;
}

function assertV2EmbeddedEvidence(result){
    assert.deepEqual(result.capabilities.definitions,capabilityDefinitions);
    assert.deepEqual(result.capabilities.matrix,capabilityMatrix);
    assert.deepEqual(result.capabilities.transportDefinitions,capabilityTransportDefinitions);
    assert.deepEqual(result.capabilities.transportMatrix,capabilityTransportMatrix);
    assert.deepEqual(result.catalog,{asOf,popularityWindow,sources,subjects:catalog});
}

async function validateV2(result,{verifyFiles=true}={}){
    assert.equal(result.schemaVersion,2);
    assert.equal(result.$schema,schemaV2);
    assert.match(result.id,/^local-[A-Za-z0-9-]+$/u,'schema-v2 result id');
    assert.ok(Number.isFinite(Date.parse(result.generatedAt)),'schema-v2 generatedAt');
    assert.equal(result.classification,'local-snapshot-noisy');
    assert.equal(result.evidence.authority,'snapshot-noisy');
    assert.ok(typeof result.evidence.commonContract === 'string' && result.evidence.commonContract,'evidence.commonContract');
    assert.ok(Array.isArray(result.evidence.reasons) && result.evidence.reasons.length > 0,'evidence.reasons');
    assert.ok(result.evidence.reasons.every(reason => typeof reason === 'string' && reason),'evidence.reasons entries');
    assert.equal(result.evidence.rankingEligible,false);
    assert.deepEqual(result.evidence.comparison,{
        crossTransportRankingEligible:false,
        transportEffectEligible:false,
        unit:'transport-lane',
        withinTransportRankingEligible:false
    });
    const {lanes,transports}=assertV2Dimensions(result);
    assertExactKeys(
        result.config,
        [
            'laneIds','moduleIds','payloads','probeFrames','quick','samplesByCohort','timeoutMs',
            'transportIds','windowBytes','windowMessages','workloads',
            ...(result.config.samples === undefined ? [] : ['samples'])
        ],
        'config'
    );
    for(const [name,values] of [
        ['laneIds',result.config.laneIds],
        ['moduleIds',result.config.moduleIds],
        ['transportIds',result.config.transportIds],
        ['payloads',result.config.payloads],
        ['workloads',result.config.workloads]
    ]){
        assert.ok(Array.isArray(values) && values.length > 0,`config.${name}`);
        assertUnique(values,`config.${name}`);
    }
    assert.ok(result.config.payloads.every(value => Number.isSafeInteger(value) && value >= 64),'config.payloads values');
    assert.ok(result.config.workloads.every(value => ['throughput','latency'].includes(value)),'config.workloads values');
    assert.equal(typeof result.config.quick,'boolean','config.quick');
    for(const field of ['probeFrames','timeoutMs','windowBytes','windowMessages']){
        assertPositiveInteger(result.config[field],`config.${field}`);
    }
    for(const laneId of result.config.laneIds){
        assertStableId(laneId,'config laneId');
        assert.ok(lanes[laneId],`unknown laneId ${laneId}`);
    }
    const selected=result.config.laneIds.map(laneId => lanes[laneId]);
    assert.deepEqual(result.config.moduleIds,orderedUnique(selected.map(lane => lane.moduleId)),'config.moduleIds must derive from laneIds');
    assert.deepEqual(result.config.transportIds,orderedUnique(selected.map(lane => lane.transportId)),'config.transportIds must derive from laneIds');
    for(const transportId of result.config.transportIds){
        assert.ok(transports[transportId],`unknown transportId ${transportId}`);
    }
    assertV2EmbeddedEvidence(result);
    const plan=assertV2Plan(result,lanes);
    const expectedSummaryKeys=result.config.laneIds.flatMap(laneId =>
        result.config.payloads.flatMap(payloadBytes => result.config.workloads.map(workload =>
            [laneId,payloadBytes,workload].join('\0')
        ))
    );
    assert.equal(result.summary.length,expectedSummaryKeys.length,'summary must cover every configured cell');
    const summaryKeys=result.summary.map(row => [row.laneId,row.payloadBytes,row.workload].join('\0'));
    assertUnique(summaryKeys,'summary lane/payload/workload tuples');
    assert.deepEqual(summaryKeys,expectedSummaryKeys,'summary cells must preserve configured lane/payload/workload order');
    for(let index=0;index<result.summary.length;index+=1){
        const row=result.summary[index];
        const lane=lanes[row.laneId];
        assert.ok(lane,`summary ${index} unknown laneId ${row.laneId}`);
        assert.equal(row.moduleId,lane.moduleId,`summary ${index} moduleId`);
        assert.equal(row.transportId,lane.transportId,`summary ${index} transportId`);
        assert.equal(row.cohortId,lane.cohortId,`summary ${index} cohortId`);
        assert.ok(!Object.keys(row).some(key => /rank/iu.test(key)),`summary ${index} must not contain a rank`);
        assert.ok(Number.isSafeInteger(row.samples) && row.samples >= 0,`summary ${index} samples`);
        assert.ok(Number.isSafeInteger(row.failures) && row.failures >= 0,`summary ${index} failures`);
    }
    for(const laneId of result.config.laneIds){
        const lane=lanes[laneId];
        assert.ok(result.capabilities.matrix[lane.moduleId],`missing capabilities for ${lane.moduleId}`);
        assert.ok(result.dependencyExposure[lane.moduleId],`missing dependencies for ${lane.moduleId}`);
        assert.ok(result.complexity[laneId] || result.complexity[lane.moduleId],`missing complexity for lane ${laneId}`);
    }
    for(let index=0;index<plan.length;index+=1){
        const sample=result.samples[index];
        const lane=lanes[sample.laneId];
        assert.equal(sample.moduleId,lane.moduleId,`sample ${index} moduleId`);
        assert.equal(sample.transportId,lane.transportId,`sample ${index} transportId`);
        assert.equal(sample.cohortId,lane.cohortId,`sample ${index} cohortId`);
        assert.ok(['ok','failed'].includes(sample.status),`sample ${index} status`);
        if(sample.status !== 'ok'){
            assert.ok(typeof sample.error === 'string' && sample.error,`sample ${index} missing error`);
            continue;
        }
        assertSampleMeasurement(sample,index);
        if(sample.transportId === 'tls'){
            assert.equal(sample.metrics.tls?.authorized,true,`sample ${index} TLS authorized`);
            assert.equal(sample.metrics.tls?.protocol,'TLSv1.3',`sample ${index} TLS protocol`);
        }
        if(sample.workload === 'throughput'){
            assert.ok(sample.metrics.maximumInFlight <= result.config.windowMessages);
        }
    }
    assertValidationTotals(result);
    assert.deepEqual(result.summary,summarizeV2(result),'summary must match raw samples');
    assert.match(result.packageLocks.benchmark,/^[0-9a-f]{64}$/u,'benchmark lock hash');
    assert.match(result.packageLocks.repository,/^[0-9a-f]{64}$/u,'repository lock hash');
    if(verifyFiles){
        const [currentComplexity,currentDependencies,benchmarkLock,repositoryLock]=await Promise.all([
            complexityReport(),
            dependencyExposure(),
            sha256(path.join(directory,'package-lock.json')),
            sha256(path.join(repositoryRoot,'package-lock.json'))
        ]);
        assert.deepEqual(result.complexity,currentComplexity,'complexity hashes/counts must match source files');
        assert.deepEqual(result.dependencyExposure,currentDependencies,'dependency closure must match lockfiles');
        assert.equal(result.packageLocks.benchmark,benchmarkLock,'benchmark lock hash mismatch');
        assert.equal(result.packageLocks.repository,repositoryLock,'repository lock hash mismatch');
    }
    return true;
}

async function validateResult(result,options={}){
    if(result.schemaVersion === 1){
        return validateV1(result,options);
    }
    if(result.schemaVersion === 2){
        return validateV2(result,options);
    }
    throw new Error(`unsupported schemaVersion ${result.schemaVersion}`);
}

const directInvocation=process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url;

if(directInvocation){
    if(process.argv.length < 3){
        throw new Error('usage: node validate.js <result.json> [...]');
    }
    for(const file of process.argv.slice(2)){
        const result=JSON.parse(await readFile(file,'utf8'));
        await validateResult(result);
        process.stdout.write(`${file}: valid\n`);
    }
}

export {
    laneMap,
    summarize,
    validateResult
};
