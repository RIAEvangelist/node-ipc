import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const defaultResultsDirectory=path.join(directory,'results');
const adapterOrder=[
    'node-net',
    'node-ipc-raw',
    'node-ipc-fast',
    'node-ipc-guarded',
    'node-ipc-assured'
];
const passOrder=['speed','resource','latency'];
const platformOrder=new Map([['linux',0],['darwin',1],['win32',2]]);

async function buildDashboard(options={}){
    const resultsDirectory=path.resolve(options.resultsDirectory || defaultResultsDirectory);
    const rawBase=normalizeRawBase(options.rawBase || 'data/benchmarks/');
    const manifestBytes=await readFile(path.join(resultsDirectory,'index.json'));
    const manifest=JSON.parse(manifestBytes);

    assert.equal(manifest.schemaVersion,2,'benchmark manifest schemaVersion must be 2');
    assert.ok(Array.isArray(manifest.results),'benchmark manifest results must be an array');

    const environments=new Map;
    for(const entry of manifest.results){
        const detail=await readDetail(resultsDirectory,entry);
        const key=environmentKey(detail);
        const environment=environments.get(key) || environmentFrom(detail,key);
        environment.runs.push(runFrom(detail,entry,rawBase));
        environments.set(key,environment);
    }

    for(const environment of environments.values()){
        environment.runs.sort(compareRuns);
    }

    return {
        schemaVersion:1,
        source:{
            schemaVersion:manifest.schemaVersion,
            comparisonState:manifest.comparisonState,
            updatedAt:manifest.updatedAt,
            manifestSha256:sha256(manifestBytes),
            manifest:`${rawBase}index.json`,
            resultCount:manifest.results.length
        },
        rankingEligible:false,
        certification:false,
        adapterOrder:[...adapterOrder],
        environments:[...environments.values()].sort(compareEnvironments)
    };
}

async function readDetail(resultsDirectory,entry){
    assert.match(entry.file || '',/^run-[A-Za-z0-9-]+[.]json$/u,'unsafe benchmark result filename');
    assert.equal(entry.rankingEligible,false,`${entry.file}: rankings must remain disabled`);

    const bytes=await readFile(path.join(resultsDirectory,entry.file));
    assert.equal(sha256(bytes),entry.sha256,`${entry.file}: manifest SHA-256 mismatch`);
    const detail=JSON.parse(bytes);

    assert.equal(detail.schemaVersion,2,`${entry.file}: schemaVersion must be 2`);
    assert.equal(detail.id,entry.id,`${entry.file}: result id mismatch`);
    assert.equal(detail.record?.file,entry.file,`${entry.file}: record filename mismatch`);
    assert.equal(detail.repository?.commit,entry.commit,`${entry.file}: commit mismatch`);
    assert.equal(detail.system?.platform,entry.platform,`${entry.file}: platform mismatch`);
    assert.equal(detail.system?.architecture,entry.architecture,`${entry.file}: architecture mismatch`);
    assert.equal(detail.system?.node,entry.node,`${entry.file}: Node version mismatch`);
    assert.equal(detail.evidence?.publishable,true,`${entry.file}: result is not publishable`);
    assert.equal(detail.evidence?.rankingEligible,false,`${entry.file}: rankings must remain disabled`);
    assert.notEqual(detail.evidence?.comparison?.certification,true,`${entry.file}: certification is forbidden`);
    return detail;
}

function environmentFrom(detail,key){
    return {
        key,
        platform:detail.system.platform,
        architecture:detail.system.architecture,
        node:detail.system.node,
        commit:detail.repository.commit,
        runs:[]
    };
}

function runFrom(detail,entry,rawBase){
    const measured=new Map;
    for(const adapter of detail.config.adapters){
        measured.set(adapter,adapterFrom(detail,adapter));
    }

    return {
        id:detail.id,
        generatedAt:detail.generatedAt,
        comparisonState:detail.evidence.comparison.state,
        classification:detail.evidence.classification,
        publishable:true,
        rankingEligible:false,
        certification:false,
        adapters:adapterOrder.map((adapter) => measured.get(adapter) || {
            id:adapter,
            status:'pending',
            lane:adapter === 'node-ipc-assured' ? 'mutually-authenticated-tls' : 'plaintext',
            passes:null,
            memory:null,
            gc:null,
            package:null,
            cleanup:null
        }),
        resources:{
            memory:detail.memory,
            gc:detail.gc,
            cleanup:detail.cleanup,
            packageFootprint:detail.packageFootprint
        },
        provenance:{
            machine:detail.system.machine,
            cpu:detail.system.cpu,
            release:detail.system.release,
            totalMemoryBytes:detail.system.totalMemoryBytes,
            provider:detail.system.environment?.provider,
            imageOS:detail.system.environment?.imageOS,
            imageVersion:detail.system.environment?.imageVersion,
            workflow:detail.system.environment?.workflow,
            runId:detail.system.environment?.runId,
            commit:detail.repository.commit,
            dirty:detail.repository.dirty,
            oracle:detail.oracle
        },
        raw:{
            detail:`${rawBase}${encodeURIComponent(entry.file)}`,
            sha256:entry.sha256
        }
    };
}

function adapterFrom(detail,adapter){
    const samples=detail.samples.filter((sample) => sample.adapter === adapter);
    const passes={};
    for(const pass of passOrder){
        const passSamples=samples.filter((sample) => sample.pass === pass);
        if(!passSamples.length){
            passes[pass]=null;
            continue;
        }
        const milliseconds=passSamples.map((sample) => sample.metrics.millisecondsPerMillion);
        const frames=passSamples.map((sample) => sample.metrics.framesPerSecond
            ?? 1e9/sample.metrics.millisecondsPerMillion);
        const latency=passSamples
            .map((sample) => Number(sample.latencyNs?.p95))
            .filter(Number.isFinite);
        passes[pass]={
            samples:passSamples.length,
            millisecondsPerMillion:distribution(milliseconds),
            framesPerSecond:distribution(frames),
            p95RoundTripNanoseconds:latency.length ? distribution(latency) : null
        };
    }

    return {
        id:adapter,
        status:'measured',
        lane:adapter === 'node-ipc-assured' ? 'mutually-authenticated-tls' : 'plaintext',
        passes,
        memory:adapterMemory(samples),
        gc:{
            durationMs:round(samples.reduce((sum,sample) => sum+(sample.gc?.durationMs || 0),0)),
            events:samples.reduce((sum,sample) => sum+(sample.gc?.events || 0),0),
            forcedRuns:samples.reduce((sum,sample) => sum+(sample.gc?.forcedRuns || 0),0),
            observedSamples:samples.filter((sample) => sample.gc?.observed).length
        },
        package:samples.find((sample) => sample.package)?.package || null,
        cleanup:{
            clean:samples.every((sample) => sample.cleanup?.clean === true),
            endpointReuseFailures:samples.filter((sample) => !sample.cleanup?.endpointReusable).length,
            leftoverBytes:samples.reduce((sum,sample) => sum+(sample.cleanup?.leftovers?.bytes || 0),0),
            leftoverEntries:samples.reduce((sum,sample) => sum+(sample.cleanup?.leftovers?.entries || 0),0),
            openSockets:samples.reduce((sum,sample) => sum+(sample.cleanup?.worker?.openSockets || 0),0),
            naturalExits:samples.filter((sample) => sample.cleanup?.naturalExit).length,
            samples:samples.length
        }
    };
}

function adapterMemory(samples){
    const peakRss=samples
        .map((sample) => sample.memory?.worker?.peak?.rss)
        .filter(Number.isFinite);
    const afterImportRss=samples
        .map((sample) => sample.memory?.worker?.afterImport?.rss)
        .filter(Number.isFinite);
    const afterCleanupRss=samples
        .map((sample) => sample.memory?.worker?.afterCleanupGc?.rss)
        .filter(Number.isFinite);
    return {
        peakRssBytes:peakRss.length ? distribution(peakRss) : null,
        afterImportRssBytes:afterImportRss.length ? distribution(afterImportRss) : null,
        afterCleanupRssBytes:afterCleanupRss.length ? distribution(afterCleanupRss) : null
    };
}

function distribution(values){
    const sorted=values.filter(Number.isFinite).sort((left,right) => left-right);
    assert.ok(sorted.length,'benchmark distribution cannot be empty');
    const middle=Math.floor(sorted.length/2);
    const median=sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
    return {
        minimum:round(sorted[0]),
        median:round(median),
        p95:round(sorted[Math.ceil(sorted.length*0.95)-1]),
        maximum:round(sorted.at(-1))
    };
}

function environmentKey(detail){
    return [
        detail.system.platform,
        detail.system.architecture,
        detail.system.node,
        detail.repository.commit
    ].join('/');
}

function compareEnvironments(left,right){
    const platform=(platformOrder.get(left.platform) ?? 99)-(platformOrder.get(right.platform) ?? 99);
    if(platform) return platform;
    const architecture=left.architecture.localeCompare(right.architecture,'en');
    if(architecture) return architecture;
    const node=compareNode(left.node,right.node);
    return node || left.commit.localeCompare(right.commit,'en');
}

function compareNode(left,right){
    const leftParts=left.slice(1).split('.').map(Number);
    const rightParts=right.slice(1).split('.').map(Number);
    for(let index=0;index<Math.max(leftParts.length,rightParts.length);index++){
        const difference=(leftParts[index] || 0)-(rightParts[index] || 0);
        if(difference) return difference;
    }
    return 0;
}

function compareRuns(left,right){
    return left.generatedAt.localeCompare(right.generatedAt,'en') || left.id.localeCompare(right.id,'en');
}

function normalizeRawBase(value){
    return value.endsWith('/') ? value : `${value}/`;
}

function round(value){
    return Number(value.toFixed(6));
}

function sha256(value){
    return createHash('sha256').update(value).digest('hex');
}

function serializeDashboard(dashboard){
    return `${JSON.stringify(dashboard,null,2)}\n`;
}

async function writeDashboard(dashboard,output){
    const serialized=serializeDashboard(dashboard);
    if(!output){
        process.stdout.write(serialized);
        return;
    }
    const target=path.resolve(output);
    await mkdir(path.dirname(target),{recursive:true});
    await writeFile(target,serialized);
}

function option(name,args){
    const prefix=`--${name}=`;
    return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(args=process.argv.slice(2)){
    const known=['--output=','--raw-base=','--results-directory='];
    const unknown=args.find((argument) => !known.some((prefix) => argument.startsWith(prefix)));
    assert.equal(unknown,undefined,`unknown option: ${unknown}`);
    const dashboard=await buildDashboard({
        rawBase:option('raw-base',args),
        resultsDirectory:option('results-directory',args)
    });
    await writeDashboard(dashboard,option('output',args));
    return dashboard;
}

const directInvocation=process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if(directInvocation){
    await main();
}

export {
    adapterOrder,
    buildDashboard,
    main,
    serializeDashboard,
    writeDashboard
};
