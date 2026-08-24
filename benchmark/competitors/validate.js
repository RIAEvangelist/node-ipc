import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {definitions as capabilityDefinitions,matrix as capabilityMatrix} from './capabilities.js';
import {asOf,catalog,popularityWindow,sources} from './catalog.js';
import {complexityReport} from './complexity.js';
import {dependencyExposure} from './dependencies.js';
import {buildPlan} from './plan.js';
import {distribution} from './stats.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(directory,'../..');

function cleanupFailed(sample){
    return sample.status === 'ok' && (
        sample.cleanup?.naturalExit !== true
        || sample.cleanup?.workerNaturalExit !== true
        || sample.cleanup?.temporaryEntries !== 0
        || sample.cleanup?.endpointClosed === false
        || sample.cleanup?.endpointReusable === false
    );
}

function summarize(result){
    const summary=[];
    for(const subject of result.config.subjects){
        for(const payloadBytes of result.config.payloads){
            for(const workload of result.config.workloads){
                const cell=result.samples.filter(sample => sample.subjectId === subject
                    && sample.payloadBytes === payloadBytes
                    && sample.workload === workload);
                const successful=cell.filter(sample => sample.status === 'ok');
                const row={
                    failures:cell.length-successful.length,
                    payloadBytes,
                    samples:successful.length,
                    subject,
                    workload
                };
                if(successful.length){
                    row.coldStartNs=distribution(successful.map(sample => Number(sample.coldStartNs)));
                    row.roundTripsPerSecond=distribution(
                        successful.map(sample => sample.metrics.roundTripsPerSecond)
                    );
                    if(workload === 'throughput'){
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
                }
                summary.push(row);
            }
        }
    }
    return summary;
}

function assertUnique(values,label){
    assert.equal(new Set(values).size,values.length,`${label} must be unique`);
}

function assertApproximately(actual,expected,label){
    const tolerance=Math.max(1e-12,Math.abs(expected)*1e-12);
    assert.ok(Math.abs(actual-expected) <= tolerance,`${label}: expected ${expected}, received ${actual}`);
}

async function sha256(file){
    return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function validateResult(result,{verifyFiles=true}={}){
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

    assert.deepEqual(result.capabilities,{
        asOf,
        definitions:capabilityDefinitions,
        matrix:capabilityMatrix
    });
    assert.deepEqual(result.catalog,{
        asOf,
        popularityWindow,
        sources,
        subjects:catalog
    });

    for(const subject of result.config.subjects){
        assert.ok(result.capabilities.matrix[subject],`missing capabilities for ${subject}`);
        assert.ok(result.complexity[subject],`missing complexity for ${subject}`);
        assert.ok(result.dependencyExposure[subject],`missing dependencies for ${subject}`);
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
        assert.equal(sample.exact.contentVerified,true);
        assert.equal(sample.exact.sequenceVerified,true);
        assert.equal(sample.exact.measuredFrames,sample.config.frames);
        assert.equal(sample.config.payloadBytes,sample.payloadBytes);
        assert.equal(sample.config.workload,sample.workload);
        assert.ok(Number.isSafeInteger(sample.config.frames) && sample.config.frames > 0);
        assert.ok(Number.isSafeInteger(sample.config.warmupFrames) && sample.config.warmupFrames > 0);
        assert.equal(sample.subject.id,sample.subjectId);
        assert.equal(sample.cleanup.naturalExit,true);
        assert.equal(sample.cleanup.workerNaturalExit,true);
        assert.equal(sample.cleanup.temporaryEntries,0);
        assert.equal(sample.cleanup.temporaryBytes,0);
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
            assert.ok(sample.metrics.maximumInFlight <= result.config.windowMessages);
        }
    }

    const failedSamples=result.samples.filter(sample => sample.status !== 'ok').length;
    const cleanupFailures=result.samples.filter(cleanupFailed).length;
    const successfulSamples=result.samples.length-failedSamples;
    const complete=failedSamples === 0 && cleanupFailures === 0;
    assert.equal(result.validation.failedSamples,failedSamples,'failedSamples must be recomputed');
    assert.equal(result.validation.successfulSamples,successfulSamples,'successfulSamples must be recomputed');
    assert.equal(result.validation.cleanupFailures,cleanupFailures,'cleanupFailures must be recomputed');
    assert.equal(result.validation.complete,complete,'complete must be recomputed');
    assert.deepEqual(result.summary,summarize(result),'summary must match raw samples');

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
    summarize,
    validateResult
};
