#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {renderChart,selectBatch} from './chart.js';
import {configurations,evidenceReasons,expectedWireBytes,lanes,manifestEntry,officialEnvironment,samplePlan,sha256,summarize} from './lib.js';
import {validateHistory,validateHistoryIndex} from './history.js';

const plan=samplePlan(configurations.full);
assert.equal(plan.length,20);
for(const lane of lanes) assert.equal(plan.filter((entry) => entry.id === lane.id).length,5);
for(let round=0;round<5;round++) assert.deepEqual(
    [...new Set(plan.filter((entry) => entry.round === round).map((entry) => entry.id))].sort(),
    lanes.map(({id}) => id).sort()
);

const count=117;
const payloadBytes=9;
const payload='x'.repeat(payloadBytes);
let direct=0;
for(let sequence=0;sequence<count;sequence++){
    direct+=Buffer.byteLength(`${JSON.stringify({type:'node-ipc.bench.request',data:{sequence,payload}})}\f`);
    direct+=Buffer.byteLength(`${JSON.stringify({type:'node-ipc.bench.response',data:{sequence,payload}})}\f`);
}
assert.equal(expectedWireBytes(count,payloadBytes),direct);

const samples=plan.map((entry,index) => ({
    ...entry,
    lane:entry.id,
    metrics:{durationNs:String(1_000_000+index),roundTripsPerSecond:1,latencyNs:{p50:10}},
    memory:{clientSampledPeakRssBytes:100+index,serverSampledPeakRssBytes:200+index},
    exact:{clientCount:configurations.full.count}
}));
const summary=summarize(samples);
assert.equal(summary.lanes.length,4);
assert.ok(summary.lanes.every((lane) => lane.samples === 5));

const chartCommit='0'.repeat(40);
const chartBatch=selectBatch(['win32','darwin','linux'].map((platform,index) => ({
    record:{recordedAt:`2026-08-23T00:00:0${index}.000Z`},
    repository:{commit:chartCommit},
    runtime:{node:{version:'v24.18.1'},rust:{release:'1.85.0'}},
    summary,
    system:{architecture:platform === 'darwin' ? 'arm64' : 'x64',environment:{runAttempt:'1',runId:'7'},platform}
})));
assert.deepEqual(chartBatch.map(({system}) => system.platform),['linux','darwin','win32']);
const chart=renderChart(chartBatch);
assert.match(chart,new RegExp(`data-source-commit="${chartCommit}"`,'u'));
assert.ok(chart.indexOf('Node → Node') < chart.indexOf('Node → Rust'));
assert.ok(chart.indexOf('Linux') < chart.indexOf('macOS') && chart.indexOf('macOS') < chart.indexOf('Windows'));

const result={
    id:'run-20260823T000000000Z-0123456789abcdef',
    record:{file:'run-20260823T000000000Z-0123456789abcdef.json'},
    generatedAt:'2026-08-23T00:00:00.000Z',
    repository:{commit:'0'.repeat(40)},
    system:{platform:'win32',architecture:'x64'},
    runtime:{node:{version:'v24.18.1'},rust:{release:'1.85.0'}},
    summary
};
const bytes=Buffer.from('{}\n');
const entry=manifestEntry(result,bytes);
assert.equal(entry.sha256,sha256(bytes));
assert.equal(entry.file,result.record.file);
const history={schemaVersion:1,updatedAt:result.generatedAt,results:[entry]};
const records=new Map([[entry.file,{bytes,result}]]);
assert.equal(validateHistoryIndex(history,records),history);
assert.throws(() => validateHistoryIndex({
    ...history,
    results:[{...entry,sha256:'f'.repeat(64)}]
},records),/history manifest entry differs/u);
const historyDirectory=await mkdtemp(path.join(os.tmpdir(),'node-ipc-rust-history-test-'));
try{
    await writeFile(path.join(historyDirectory,'index.json'),`${JSON.stringify({
        schemaVersion:1,
        updatedAt:null,
        results:[]
    },null,2)}\n`);
    const validator=fileURLToPath(new URL('./validate.js',import.meta.url));
    assert.match(execFileSync(process.execPath,[validator,'--tracked',historyDirectory],{encoding:'utf8'}),/^validated 0 Rust\/Node benchmark results\n$/u);
    const orphan='run-20260823T000000000Z-aaaaaaaaaaaaaaaa.json';
    await writeFile(path.join(historyDirectory,orphan),'{}\n');
    await assert.rejects(validateHistory(historyDirectory,{tracked:false}),/history result inventory differs/u);
    assert.deepEqual(await validateHistory(historyDirectory,{
        allowUnindexed:new Set([orphan]),
        tracked:false
    }),{schemaVersion:1,updatedAt:null,results:[]});
}finally{
    await rm(historyDirectory,{recursive:true,force:true});
}

const cleanRepository={commit:'0'.repeat(40),dirty:false,changedDuringRun:false};
const officialSystem={
    provider:'github-actions',
    sourceRef:'refs/heads/main',
    sourceSha:cleanRepository.commit,
    githubRepository:officialEnvironment.repository,
    workflow:officialEnvironment.workflow,
    workflowRef:officialEnvironment.workflowRef,
    workflowSha:cleanRepository.commit,
    nodeLane:officialEnvironment.node.slice(1),
    osLane:'windows-latest',
    runnerEnvironment:'github-hosted'
};
const officialRuntime={node:{version:officialEnvironment.node},rust:{release:officialEnvironment.rust}};
assert.deepEqual(evidenceReasons('full',cleanRepository,officialSystem,officialRuntime,'win32'),[]);
assert.deepEqual(evidenceReasons('full',cleanRepository,officialSystem,{
    ...officialRuntime,
    node:{version:'v24.18.0'}
},'win32'),['node-version-mismatch']);
assert.deepEqual(evidenceReasons('full',cleanRepository,{...officialSystem,osLane:undefined},officialRuntime,'freebsd'),['unsupported-platform']);
assert.deepEqual(evidenceReasons('quick',{...cleanRepository,dirty:true},{
    provider:'local',
    sourceRef:null,
    sourceSha:null
}),[
    'quick-smoke',
    'dirty-repository',
    'non-github-environment',
    'non-main-source',
    'source-sha-mismatch'
]);

process.stdout.write('11 Rust/Node benchmark contract checks passed\n');
