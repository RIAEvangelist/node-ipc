import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildTransportDashboard} from './transport-dashboard.js';
import {renderTransportChart} from './render-transport-chart.js';
import {legacyProvenance,manifestEntry,oracleByTransport,sha256,summarize,transportOrder,validateCanonicalRuntime} from './transport-evidence.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'..');
const commit=git('rev-parse','HEAD').trim();
const currentPackage=JSON.parse(git('show',`${commit}:package.json`));
const packageHash=(revision,file) => sha256(git('show',`${revision}:${file}`,{encoding:'buffer'}));
const temporary=await mkdtemp(path.join(os.tmpdir(),'node-ipc-transport-evidence-test-'));
const artifacts=path.join(temporary,'artifacts');
const results=path.join(temporary,'results');

try{
    await mkdir(artifacts);
    await mkdir(results);
    await writeFile(path.join(results,'index.json'),`${JSON.stringify({schemaVersion:1,updatedAt:null,comparisonState:'no-verified-runs',results:[]},null,2)}\n`);
    const lanes=[
        ['darwin','macos-latest','v22.13.0','22.13.0'],['darwin','macos-latest','v24.18.1','24.18.1'],
        ['linux','ubuntu-latest','v22.13.0','22.13.0'],['linux','ubuntu-latest','v24.18.1','24.18.1'],
        ['win32','windows-latest','v22.13.0','22.13.0'],['win32','windows-latest','v24.18.1','24.18.1']
    ];
    const saturated=makeResult({laneIndex:0,node:lanes[0][2],nodeLane:lanes[0][3],osLane:lanes[0][1],platform:lanes[0][0]});
    saturated.samples[0].metrics.oracleCpuMicroseconds=Number(saturated.samples[0].metrics.elapsedNs)/1000;
    saturated.samples[0].metrics.oracleCpuToWallRatio=1;
    saturated.samples[0].metrics.oracleSaturated=true;
    assert.throws(() => validateCanonicalRuntime(saturated),/reflector was CPU-saturated/u);
    const forgedSaturation=makeResult({laneIndex:0,node:lanes[0][2],nodeLane:lanes[0][3],osLane:lanes[0][1],platform:lanes[0][0]});
    forgedSaturation.samples[0].metrics.oracleCpuMicroseconds=Number(forgedSaturation.samples[0].metrics.elapsedNs)/1000*0.95;
    forgedSaturation.samples[0].metrics.oracleCpuToWallRatio=0.95;
    assert.throws(() => validateCanonicalRuntime(forgedSaturation),/oracle saturation flag differs/u);
    const invalidBytes=makeResult({laneIndex:0,node:lanes[0][2],nodeLane:lanes[0][3],osLane:lanes[0][1],platform:lanes[0][0]});
    invalidBytes.samples[0].exact.totalWireBytes-=1;
    assert.throws(() => validateCanonicalRuntime(invalidBytes),/total wire byte count differs/u);
    for(let laneIndex=0;laneIndex<lanes.length;laneIndex+=1){
        const [platform,osLane,node,nodeLane]=lanes[laneIndex];
        const result=makeResult({laneIndex,node,nodeLane,osLane,platform});
        const serialized=`${JSON.stringify(result,null,2)}\n`;
        const laneDirectory=path.join(artifacts,`lane-${laneIndex}`);
        await mkdir(laneDirectory);
        await writeFile(path.join(laneDirectory,result.record.file),serialized);
    }
    execFileSync(process.execPath,[path.join(directory,'merge-transport-results.js'),artifacts,`--results-directory=${results}`],{cwd:root,stdio:'pipe'});
    execFileSync(process.execPath,[path.join(directory,'validate-transport-results.js'),`--results-directory=${results}`],{cwd:root,stdio:'pipe'});
    const manifest=JSON.parse(await readFile(path.join(results,'index.json'),'utf8'));
    assert.equal(manifest.results.length,6);
    assert.equal(manifest.comparisonState,'version-comparison');
    for(const entry of manifest.results){
        assert.equal(sha256(await readFile(path.join(results,entry.file))),entry.sha256);
    }
    const dashboard=await buildTransportDashboard({resultsDirectory:results,rawBase:'data/transport-benchmarks/'});
    assert.equal(dashboard.source.resultCount,6);
    assert.equal(dashboard.environments.length,6);
    assert.equal(dashboard.rankingEligible,false);
    assert.equal(dashboard.certification,false);
    for(const environment of dashboard.environments){
        assert.deepEqual(environment.runs[0].transports.map((transport) => transport.id),transportOrder);
        assert.ok(environment.runs[0].transports.every((transport) => transport.status === 'measured'));
        assert.deepEqual(environment.runs[0].provenance.oracleByTransport,oracleByTransport);
        assert.equal(environment.runs[0].provenance.oracles['standard-c-datagram-reflector'].implementation,'standard-c-datagram-reflector');
    }
    const chart=renderTransportChart(dashboard);
    assert.equal((chart.match(/<g class="environment"/gu) || []).length,6);
    assert.doesNotMatch(chart,/Environment pending/u);
    assert.match(chart,/rankings and certification are disabled/iu);
    process.stdout.write('transport evidence pipeline test passed: six lanes, 70 samples each\n');
}finally{
    await rm(temporary,{recursive:true,force:true});
}

function makeResult({laneIndex,node,nodeLane,osLane,platform}){
    const generatedAt=`2026-08-22T12:0${laneIndex}:00.000Z`;
    const id=`run-transport-test-${laneIndex}`;
    const file=`${id}.json`;
    const statusSha256=sha256('');
    const samples=[];
    for(const transport of transportOrder){
        for(let pairIndex=0;pairIndex<7;pairIndex+=1){
            const order=pairIndex%2 ? ['current','legacy-v12'] : ['legacy-v12','current'];
            for(let orderIndex=0;orderIndex<2;orderIndex+=1){
                const version=order[orderIndex];
                const milliseconds=(version === 'legacy-v12' ? 3000 : 800)+pairIndex;
                const elapsedNs=String(milliseconds*1000000);
                const oracleCpuMicroseconds=milliseconds*500;
                samples.push({
                    transport,
                    oracle:oracleByTransport[transport],
                    securityMode:transport === 'tls' ? 'encryption-only' : 'plaintext',
                    pairIndex,
                    orderIndex,
                    version,
                    rootVersion:version === 'legacy-v12' ? '12.0.0' : currentPackage.version,
                    metrics:{
                        elapsedNs,
                        millisecondsPerMillion:milliseconds,
                        oracleCpuMicroseconds,
                        oracleCpuToWallRatio:oracleCpuMicroseconds/(Number(elapsedNs)/1000),
                        oracleSaturated:false,
                        oracleWallNs:elapsedNs
                    },
                    exact:{
                        applicationBytes:64000000,
                        contentVerified:true,
                        countVerified:true,
                        datagramCountsVerified:true,
                        measuredFrames:1000000,
                        oracleBytesIn:111106464,
                        oracleBytesOut:111106464,
                        oracleBytesVerified:true,
                        probeFrames:64,
                        sequenceVerified:true,
                        totalWireBytes:111106464,
                        warmupFrames:100000,
                        wireBytesPerFrame:101,
                        wireReceivedBytes:101000000,
                        wireSentBytes:101000000
                    },
                    cleanup:{
                        activeHandles:[],activeResourceDelta:[],clientClosed:true,clean:true,
                        endpointRemoved:true,leftovers:{bytes:0,entries:0},oracleActiveResourceDelta:[],
                        oracleNaturalExit:true,reflectorClosed:true,workerNaturalExit:true
                    }
                });
            }
        }
    }
    const repository={
        capture:'pre-and-post-execution',changedDuringRun:false,commit,dirty:false,
        preExecution:{capturedAt:generatedAt,commit,dirty:false,statusSha256},
        postExecution:{capturedAt:generatedAt,commit,dirty:false,statusSha256}
    };
    const system={
        architecture:'x64',cpu:{count:4,model:'synthetic'},
        environment:{
            githubRepository:'RIAEvangelist/node-ipc',imageOS:'test',imageVersion:'test',nodeLane,
            npm:'npm/11',osLane,provider:'github-actions',runAttempt:'1',runId:'123456789',
            runnerArchitecture:'X64',runnerEnvironment:'github-hosted',sourceRef:'refs/heads/main',
            sourceSha:commit,workflow:'Record transport comparison snapshots',
            workflowRef:'RIAEvangelist/node-ipc/.github/workflows/transport-benchmark.yml@refs/heads/main',workflowSha:commit
        },
        machine:{id:`synthetic-${laneIndex}`},node,platform,release:'test',totalMemoryBytes:1024
    };
    const config={
        currentVersion:currentPackage.version,messages:1000000,pairsPerTransport:7,payloadBytes:64,
        oracleByTransport:{...oracleByTransport},
        probeFrames:64,transports:[...transportOrder],udpWindow:64,
        versions:['legacy-v12','current'],warmupFrames:100000
    };
    const oracles={
        'standard-c-datagram-reflector':{implementation:'standard-c-datagram-reflector',build:{
                binarySha256:sha256(`binary-${laneIndex}`),compiler:'cc',flags:['-O3','-std=c11',...(platform === 'win32' ? ['-lws2_32'] : [])],
                sourceSha256:packageHash(commit,'benchmark/oracle/echo.c'),target:{architecture:'x64',name:platform === 'win32' ? 'raw-echo.exe' : 'raw-echo',platform},
                version:'cc synthetic'
        }},
        'node-byte-reflector':{implementation:'node-byte-reflector',runtime:node}
    };
    const result={
        schemaVersion:1,id,generatedAt,record:{file,recordedAt:generatedAt},repository,system,
        evidence:{
            authority:'snapshot-noisy',certification:false,classification:'clean-end-to-end-transport-comparison',
            comparison:{paired:true,state:'version-comparison',subjects:['legacy-v12','current'],transports:[...transportOrder]},
            privacy:{excluded:['absolute-paths','ephemeral-endpoints','process-ids'],sanitized:true},
            publishable:true,rankingEligible:false,reasons:[]
        },
        oracles,
        config,
        subjects:{
            'legacy-v12':{id:'legacy-v12',version:'12.0.0',source:{kind:'git-tag-archive',tag:'12.0.0',commit:legacyProvenance.commit,packageJsonSha256:packageHash(legacyProvenance.commit,'package.json'),packageLockSha256:packageHash(legacyProvenance.commit,'package-lock.json')}},
            current:{id:'current',version:currentPackage.version,source:{kind:'clean-repository',commit,packageJsonSha256:packageHash(commit,'package.json'),packageLockSha256:packageHash(commit,'package-lock.json')}}
        },
        samples,summary:summarize(samples,platform),cleanup:{activeHandles:[],clean:true,pairs:35,samples:70}
    };
    const serialized=`${JSON.stringify(result,null,2)}\n`;
    assert.equal(manifestEntry(result,serialized).sha256,sha256(serialized));
    return result;
}

function git(...arguments_){
    const options=arguments_.at(-1)?.encoding ? arguments_.pop() : {encoding:'utf8'};
    return execFileSync('git',arguments_,{cwd:root,...options});
}
