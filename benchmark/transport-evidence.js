import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const transportOrder=Object.freeze(['local','tcp','tls','udp4','udp6']);
const subjectOrder=Object.freeze(['legacy-v12','current']);
const canonical={
    messages:1000000,
    pairsPerTransport:7,
    payloadBytes:64,
    probeFrames:64,
    transports:[...transportOrder],
    udpWindow:64,
    versions:[...subjectOrder],
    warmupFrames:100000,
    wireBytesPerFrame:101
};
const legacyProvenance={
    commit:'a98efaedbf090d7bf4d6bdf07761301c531608af',
    id:'legacy-v12',
    tag:'12.0.0',
    version:'12.0.0'
};

function sha256(value){
    return createHash('sha256').update(value).digest('hex');
}

function compareText(left,right){
    return left < right ? -1 : left > right ? 1 : 0;
}

function distribution(values,{retainValues=true}={}){
    const sorted=values.filter(Number.isFinite).sort((left,right) => left-right);
    assert.ok(sorted.length,'transport benchmark distribution cannot be empty');
    const middle=Math.floor(sorted.length/2);
    const median=sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
    const result={
        maximum:sorted.at(-1),
        median,
        minimum:sorted[0],
        p95:sorted[Math.ceil(sorted.length*0.95)-1]
    };
    if(retainValues) result.values=sorted;
    return result;
}

function implementationFor(transport,platform){
    if(transport === 'local') return platform === 'win32' ? 'windows-named-pipe' : 'unix-domain-socket';
    if(transport === 'tcp') return 'tcp-loopback';
    if(transport === 'tls') return 'tls-loopback';
    if(transport === 'udp4') return 'udp4-loopback';
    if(transport === 'udp6') return 'udp6-loopback';
    throw new Error(`unknown transport: ${transport}`);
}

function summarize(samples,platform){
    const groups=[];
    for(const transport of transportOrder){
        const transportSamples=samples.filter((sample) => sample.transport === transport);
        const legacy=transportSamples.filter((sample) => sample.version === 'legacy-v12');
        const current=transportSamples.filter((sample) => sample.version === 'current');
        const deltas=[];
        const speedups=[];
        const reductions=[];
        for(let pairIndex=0;pairIndex<canonical.pairsPerTransport;pairIndex+=1){
            const legacySample=legacy.find((sample) => sample.pairIndex === pairIndex);
            const currentSample=current.find((sample) => sample.pairIndex === pairIndex);
            assert.ok(legacySample && currentSample,`${transport}/${pairIndex}: paired samples are incomplete`);
            const legacyMs=legacySample.metrics.millisecondsPerMillion;
            const currentMs=currentSample.metrics.millisecondsPerMillion;
            deltas.push(currentMs-legacyMs);
            speedups.push(legacyMs/currentMs);
            reductions.push((legacyMs-currentMs)/legacyMs*100);
        }
        groups.push({
            transport,
            implementation:implementationFor(transport,platform),
            pairs:canonical.pairsPerTransport,
            legacy:{
                id:'legacy-v12',
                version:legacyProvenance.version,
                samples:legacy.length,
                millisecondsPerMillion:distribution(legacy.map((sample) => sample.metrics.millisecondsPerMillion))
            },
            current:{
                id:'current',
                version:current[0]?.rootVersion,
                samples:current.length,
                millisecondsPerMillion:distribution(current.map((sample) => sample.metrics.millisecondsPerMillion))
            },
            paired:{
                samples:canonical.pairsPerTransport,
                deltaMillisecondsPerMillion:distribution(deltas),
                speedup:distribution(speedups),
                reductionPercent:distribution(reductions)
            }
        });
    }
    return {
        metric:'milliseconds-per-million-completed-messages',
        paired:true,
        platform,
        groups
    };
}

function validateCanonicalRuntime(runtime,label='transport runtime'){
    assert.equal(runtime.schemaVersion,1,`${label}: schemaVersion must be 1`);
    assert.ok(validDate(runtime.generatedAt),`${label}: generatedAt must be an ISO timestamp`);
    assert.ok(runtime.system && typeof runtime.system === 'object',`${label}: system evidence is required`);
    assert.ok(runtime.repository && typeof runtime.repository === 'object',`${label}: repository evidence is required`);
    assert.ok(runtime.config && typeof runtime.config === 'object',`${label}: configuration is required`);
    assert.deepEqual(runtime.config.transports,transportOrder,`${label}: canonical transports differ`);
    assert.deepEqual(runtime.config.versions,subjectOrder,`${label}: canonical subjects differ`);
    assert.equal(runtime.config.messages,canonical.messages,`${label}: measured-message count differs`);
    assert.equal(runtime.config.warmupFrames,canonical.warmupFrames,`${label}: warm-up count differs`);
    assert.equal(runtime.config.payloadBytes,canonical.payloadBytes,`${label}: payload size differs`);
    assert.equal(runtime.config.probeFrames,canonical.probeFrames,`${label}: probe count differs`);
    assert.equal(runtime.config.pairsPerTransport,canonical.pairsPerTransport,`${label}: pair count differs`);
    assert.equal(runtime.config.udpWindow,canonical.udpWindow,`${label}: UDP window differs`);
    assert.ok(Array.isArray(runtime.samples),`${label}: samples must be an array`);
    assert.equal(runtime.samples.length,transportOrder.length*subjectOrder.length*canonical.pairsPerTransport,`${label}: sample count differs`);

    for(const transport of transportOrder){
        for(let pairIndex=0;pairIndex<canonical.pairsPerTransport;pairIndex+=1){
            const pair=runtime.samples.filter((sample) => sample.transport === transport && sample.pairIndex === pairIndex);
            assert.equal(pair.length,2,`${label}: ${transport}/${pairIndex} must have two samples`);
            assert.deepEqual(pair.map((sample) => sample.version).sort(compareText),[...subjectOrder].sort(compareText),`${label}: ${transport}/${pairIndex} subjects differ`);
            assert.deepEqual(pair.map((sample) => sample.orderIndex).sort(),[0,1],`${label}: ${transport}/${pairIndex} execution order differs`);
            const expectedFirst=pairIndex%2 === 0 ? 'legacy-v12' : 'current';
            assert.equal(pair.find((sample) => sample.orderIndex === 0)?.version,expectedFirst,`${label}: ${transport}/${pairIndex} order was not alternated`);
            const legacySample=pair.find((sample) => sample.version === 'legacy-v12');
            const currentSample=pair.find((sample) => sample.version === 'current');
            assert.equal(legacySample.exact?.wireBytesPerFrame,currentSample.exact?.wireBytesPerFrame,`${label}: ${transport}/${pairIndex} subjects used different wire frames`);
        }
    }

    for(const [index,sample] of runtime.samples.entries()){
        const sampleLabel=`${label}: sample ${index}`;
        assert.ok(transportOrder.includes(sample.transport),`${sampleLabel}: unknown transport`);
        assert.ok(subjectOrder.includes(sample.version),`${sampleLabel}: unknown subject`);
        assert.equal(sample.securityMode,sample.transport === 'tls' ? 'encryption-only' : 'plaintext',`${sampleLabel}: transport security semantics differ`);
        assert.ok(Number.isInteger(sample.pairIndex) && sample.pairIndex >= 0 && sample.pairIndex < canonical.pairsPerTransport,`${sampleLabel}: invalid pair index`);
        assert.equal(sample.rootVersion,sample.version === 'legacy-v12' ? legacyProvenance.version : runtime.config.currentVersion,`${sampleLabel}: package version differs`);
        assert.ok(Number.isFinite(sample.metrics?.millisecondsPerMillion) && sample.metrics.millisecondsPerMillion > 0,`${sampleLabel}: invalid timing`);
        assert.ok(/^\d+$/u.test(String(sample.metrics?.elapsedNs ?? '')),`${sampleLabel}: elapsedNs must be an integer string`);
        assert.equal(sample.metrics.millisecondsPerMillion,Number(sample.metrics.elapsedNs)/canonical.messages,`${sampleLabel}: timing normalization differs`);
        assert.equal(sample.metrics.oracleSaturated,false,`${sampleLabel}: reflector was CPU-saturated`);
        assert.equal(sample.exact?.probeFrames,canonical.probeFrames,`${sampleLabel}: probe count differs`);
        assert.equal(sample.exact?.warmupFrames,canonical.warmupFrames,`${sampleLabel}: warm-up count differs`);
        assert.equal(sample.exact?.measuredFrames,canonical.messages,`${sampleLabel}: measured count differs`);
        assert.equal(sample.exact?.applicationBytes,canonical.messages*canonical.payloadBytes,`${sampleLabel}: application byte count differs`);
        assert.equal(sample.exact?.wireBytesPerFrame,canonical.wireBytesPerFrame,`${sampleLabel}: wire frame size differs`);
        assert.equal(sample.exact?.wireSentBytes,canonical.messages*canonical.wireBytesPerFrame,`${sampleLabel}: sent wire byte count differs`);
        assert.equal(sample.exact?.sequenceVerified,true,`${sampleLabel}: sequence verification failed`);
        assert.equal(sample.exact?.contentVerified,true,`${sampleLabel}: content verification failed`);
        assert.equal(sample.exact?.countVerified,true,`${sampleLabel}: count verification failed`);
        assert.equal(sample.exact?.wireSentBytes,sample.exact?.wireReceivedBytes,`${sampleLabel}: reflected wire byte count differs`);
        const totalFrames=canonical.probeFrames+canonical.warmupFrames+canonical.messages;
        assert.equal(sample.exact?.totalWireBytes,totalFrames*canonical.wireBytesPerFrame,`${sampleLabel}: total wire byte count differs`);
        assert.equal(sample.exact?.oracleBytesIn,sample.exact.totalWireBytes,`${sampleLabel}: reflector input byte count differs`);
        assert.equal(sample.exact?.oracleBytesOut,sample.exact.totalWireBytes,`${sampleLabel}: reflector output byte count differs`);
        assert.equal(sample.cleanup?.clean,true,`${sampleLabel}: cleanup failed`);
        assert.equal(sample.cleanup?.clientClosed,true,`${sampleLabel}: client remained open`);
        assert.equal(sample.cleanup?.reflectorClosed,true,`${sampleLabel}: reflector remained open`);
        assert.equal(sample.cleanup?.endpointRemoved,true,`${sampleLabel}: endpoint remained bound`);
        assert.deepEqual(sample.cleanup?.activeResourceDelta,[],`${sampleLabel}: worker resources remained`);
        assert.deepEqual(sample.cleanup?.oracleActiveResourceDelta,[],`${sampleLabel}: reflector resources remained`);
        assert.deepEqual(sample.cleanup?.activeHandles,[],`${sampleLabel}: active handles remained`);
        assert.equal(sample.cleanup?.leftovers?.entries,0,`${sampleLabel}: temporary entries remained`);
        assert.equal(sample.cleanup?.leftovers?.bytes,0,`${sampleLabel}: temporary bytes remained`);
        assert.equal(sample.cleanup?.oracleNaturalExit,true,`${sampleLabel}: reflector did not exit naturally`);
        assert.equal(sample.cleanup?.workerNaturalExit,true,`${sampleLabel}: worker did not exit naturally`);
        assert.equal(sample.exact?.oracleBytesVerified,true,`${sampleLabel}: reflector byte count differs`);
        assert.equal(sample.exact?.datagramCountsVerified,true,`${sampleLabel}: datagram count differs`);
    }
    assert.equal(runtime.cleanup?.clean,true,`${label}: aggregate cleanup failed`);
    assert.equal(runtime.cleanup?.samples,runtime.samples.length,`${label}: aggregate sample count differs`);
    assert.equal(runtime.cleanup?.pairs,transportOrder.length*canonical.pairsPerTransport,`${label}: aggregate pair count differs`);
    assert.deepEqual(runtime.cleanup?.activeHandles,[],`${label}: aggregate active handles remained`);
    return true;
}

function manifestEntry(result,serialized){
    return {
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
        platform:result.system.platform,
        publishable:result.evidence.publishable,
        rankingEligible:result.evidence.rankingEligible,
        sha256:sha256(serialized)
    };
}

function validDate(value){
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export {
    canonical,
    compareText,
    distribution,
    implementationFor,
    legacyProvenance,
    manifestEntry,
    sha256,
    subjectOrder,
    summarize,
    transportOrder,
    validDate,
    validateCanonicalRuntime
};
