import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256,transportOrder} from './transport-evidence.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const defaultResultsDirectory=path.join(directory,'transport-results');
const platformOrder=new Map([['linux',0],['darwin',1],['win32',2]]);

async function buildTransportDashboard(options={}){
    const resultsDirectory=path.resolve(options.resultsDirectory || defaultResultsDirectory);
    const rawBase=normalizeRawBase(options.rawBase || 'data/transport-benchmarks/');
    const manifestBytes=await readFile(path.join(resultsDirectory,'index.json'));
    const manifest=JSON.parse(manifestBytes);
    assert.equal(manifest.schemaVersion,1,'transport manifest schemaVersion must be 1');
    assert.ok(Array.isArray(manifest.results),'transport manifest results must be an array');

    const environments=new Map;
    for(const entry of manifest.results){
        const detail=await readDetail(resultsDirectory,entry);
        const key=environmentKey(detail);
        const environment=environments.get(key) || environmentFrom(detail,key);
        environment.runs.push(runFrom(detail,entry,rawBase));
        environments.set(key,environment);
    }
    for(const environment of environments.values()) environment.runs.sort(compareRuns);

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
        transportOrder:[...transportOrder],
        environments:[...environments.values()].sort(compareEnvironments)
    };
}

async function readDetail(resultsDirectory,entry){
    assert.match(entry.file || '',/^run-[A-Za-z0-9-]+[.]json$/u,'unsafe transport result filename');
    assert.equal(entry.rankingEligible,false,`${entry.file}: rankings are forbidden`);
    const bytes=await readFile(path.join(resultsDirectory,entry.file));
    assert.equal(sha256(bytes),entry.sha256,`${entry.file}: manifest SHA-256 mismatch`);
    const detail=JSON.parse(bytes);
    assert.equal(detail.schemaVersion,1,`${entry.file}: schemaVersion must be 1`);
    assert.equal(detail.id,entry.id,`${entry.file}: id differs`);
    assert.equal(detail.record.file,entry.file,`${entry.file}: record filename differs`);
    assert.equal(detail.repository.commit,entry.commit,`${entry.file}: commit differs`);
    assert.equal(detail.system.platform,entry.platform,`${entry.file}: platform differs`);
    assert.equal(detail.system.architecture,entry.architecture,`${entry.file}: architecture differs`);
    assert.equal(detail.system.node,entry.node,`${entry.file}: Node differs`);
    assert.equal(detail.evidence.publishable,true,`${entry.file}: result is not publishable`);
    assert.equal(detail.evidence.rankingEligible,false,`${entry.file}: rankings are forbidden`);
    assert.equal(detail.evidence.certification,false,`${entry.file}: certification is forbidden`);
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
    const groups=new Map(detail.summary.groups.map((group) => [group.transport,group]));
    return {
        id:detail.id,
        generatedAt:detail.generatedAt,
        classification:detail.evidence.classification,
        comparisonState:detail.evidence.comparison.state,
        publishable:true,
        rankingEligible:false,
        certification:false,
        transports:transportOrder.map((id) => transportFrom(groups.get(id),id)),
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
            subjects:detail.subjects
        },
        cleanup:detail.cleanup,
        raw:{detail:`${rawBase}${encodeURIComponent(entry.file)}`,sha256:entry.sha256}
    };
}

function transportFrom(group,id){
    if(!group){
        return {id,status:'pending',implementation:null,legacy:null,current:null,paired:null};
    }
    return {
        id,
        status:'measured',
        implementation:group.implementation,
        legacy:{
            id:group.legacy.id,
            version:group.legacy.version,
            samples:group.legacy.samples,
            millisecondsPerMillion:compactDistribution(group.legacy.millisecondsPerMillion)
        },
        current:{
            id:group.current.id,
            version:group.current.version,
            samples:group.current.samples,
            millisecondsPerMillion:compactDistribution(group.current.millisecondsPerMillion)
        },
        paired:{
            samples:group.paired.samples,
            deltaMillisecondsPerMillion:compactDistribution(group.paired.deltaMillisecondsPerMillion),
            speedup:compactDistribution(group.paired.speedup),
            reductionPercent:compactDistribution(group.paired.reductionPercent)
        }
    };
}

function compactDistribution(value){
    return {
        minimum:round(value.minimum),
        median:round(value.median),
        p95:round(value.p95),
        maximum:round(value.maximum)
    };
}

function environmentKey(detail){
    return [detail.system.platform,detail.system.architecture,detail.system.node,detail.repository.commit].join('/');
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
    for(let index=0;index<Math.max(leftParts.length,rightParts.length);index+=1){
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

function serializeTransportDashboard(dashboard){
    return `${JSON.stringify(dashboard,null,2)}\n`;
}

async function writeTransportDashboard(dashboard,output){
    const serialized=serializeTransportDashboard(dashboard);
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
    const dashboard=await buildTransportDashboard({
        rawBase:option('raw-base',args),
        resultsDirectory:option('results-directory',args)
    });
    await writeTransportDashboard(dashboard,option('output',args));
    return dashboard;
}

const directInvocation=process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if(directInvocation) await main();

export {
    buildTransportDashboard,
    main,
    serializeTransportDashboard,
    transportOrder,
    writeTransportDashboard
};
