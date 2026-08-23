#!/usr/bin/env node

import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateHistory} from './history.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const defaultResults=path.resolve(directory,'../rust-results');
const defaultOutput=path.resolve(directory,'../../docs/assets/node-ipc-rust-benchmark.svg');
const platforms=['linux','darwin','win32'];
const platformNames={linux:'Linux',darwin:'macOS',win32:'Windows'};
const laneNames={
    'node-node':'Node → Node',
    'node-rust':'Node → Rust',
    'rust-node':'Rust → Node',
    'rust-rust':'Rust → Rust'
};

function selectBatch(results){
    const batches=new Map;
    for(const result of results){
        const environment=result.system.environment;
        const key=[result.repository.commit,environment.runId,environment.runAttempt].join(':');
        const batch=batches.get(key) || [];
        batch.push(result);
        batches.set(key,batch);
    }
    const complete=[...batches.values()].filter((batch) =>
        batch.length === 3
        && new Set(batch.map((result) => result.system.platform)).size === 3
        && platforms.every((platform) => batch.some((result) => result.system.platform === platform))
    );
    assert.ok(complete.length,'no complete Rust benchmark batch');
    complete.sort((left,right) => batchTime(right)-batchTime(left));
    return [...complete[0]].sort((left,right) =>
        platforms.indexOf(left.system.platform)-platforms.indexOf(right.system.platform)
    );
}

function renderChart(batch){
    assert.deepEqual(batch.map((result) => result.system.platform),platforms,'platform order differs');
    const source=batch[0];
    const commit=source.repository.commit;
    const node=source.runtime.node.version;
    const rust=source.runtime.rust.release;
    assert.equal(new Set(batch.map((result) => result.repository.commit)).size,1,'batch commits differ');
    assert.equal(new Set(batch.map((result) => result.runtime.node.version)).size,1,'batch Node versions differ');
    assert.equal(new Set(batch.map((result) => result.runtime.rust.release)).size,1,'batch Rust versions differ');
    const maximum=Math.max(...batch.flatMap((result) =>
        result.summary.lanes.map((lane) => lane.medianMillisecondsPerMillionRoundTrips)
    ));
    const panels=batch.map((result,index) => renderPanel(result,index,maximum)).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="470" viewBox="0 0 1200 470" role="img" aria-labelledby="title description" data-source-commit="${commit}">
  <title id="title">node-ipc Node.js and Rust TCP benchmark</title>
  <desc id="description">Median milliseconds per one million validated round trips for Node to Node, Node to Rust, Rust to Node, and Rust to Rust on Linux, macOS, and Windows at commit ${commit}. Node ${node}; Rust ${rust}. Hosted platforms are not ranked.</desc>
  <rect width="1200" height="470" rx="18" fill="#050812"/>
  <rect x="1" y="1" width="1198" height="468" rx="17" fill="none" stroke="#21304a" stroke-width="2"/>
  <text x="34" y="43" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="25" font-weight="700">Node.js ↔ Rust · framed TCP</text>
  <text x="34" y="69" fill="#9fb1c8" font-family="system-ui, sans-serif" font-size="14">Median milliseconds per 1,000,000 validated round trips · 2,000,000 application frames</text>
  <text x="1166" y="43" fill="#72839b" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="13" text-anchor="end">${commit.slice(0,12)}</text>
${panels}
  <text x="34" y="445" fill="#72839b" font-family="system-ui, sans-serif" font-size="13">Fixed lane order. Compare roles within one hosted platform; hardware differs across platforms. Rankings and certification are disabled.</text>
</svg>
`;
}

function renderPanel(result,index,maximum){
    const x=34+index*386;
    const lanes=new Map(result.summary.lanes.map((lane) => [lane.lane,lane]));
    const rows=Object.keys(laneNames).map((id,row) => renderRow(lanes.get(id),id,row,maximum)).join('\n');
    return `  <g transform="translate(${x} 92)">
    <rect width="360" height="320" rx="12" fill="#0c1322" stroke="#21304a"/>
    <text x="18" y="34" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="18" font-weight="700">${platformNames[result.system.platform]}</text>
    <text x="342" y="34" fill="#62f28c" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" text-anchor="end">${result.system.architecture}</text>
${rows}
  </g>`;
}

function renderRow(lane,id,row,maximum){
    assert.ok(lane,`${id}: lane is missing`);
    const y=72+row*57;
    const milliseconds=lane.medianMillisecondsPerMillionRoundTrips;
    assert.ok(Number.isFinite(milliseconds) && milliseconds>0,`${id}: median differs`);
    const width=Math.max(3,milliseconds/maximum*310);
    const color=id === 'node-node' ? '#48d8ff' : id === 'rust-rust' ? '#62f28c' : '#9d8cff';
    return `    <text x="18" y="${y}" fill="#dce8f7" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="13" font-weight="700">${laneNames[id]}</text>
    <text x="342" y="${y}" fill="#f2f7ff" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="13" text-anchor="end">${formatMilliseconds(milliseconds)} ms</text>
    <rect x="18" y="${y+12}" width="310" height="9" rx="4.5" fill="#17243a"/>
    <rect x="18" y="${y+12}" width="${width.toFixed(2)}" height="9" rx="4.5" fill="${color}"/>`;
}

async function buildChart(resultsDirectory){
    const index=await validateHistory(resultsDirectory,{tracked:true});
    const results=await Promise.all(index.results.map(async({file}) =>
        JSON.parse(await readFile(path.join(resultsDirectory,file),'utf8'))
    ));
    return renderChart(selectBatch(results));
}

function batchTime(batch){
    return Math.max(...batch.map((result) => Date.parse(result.record.recordedAt)));
}

function formatMilliseconds(value){
    return Math.round(value).toLocaleString('en-US');
}

function option(name,args){
    const prefix=`--${name}=`;
    return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(args=process.argv.slice(2)){
    const known=['--check','--output=','--results-directory='];
    const unknown=args.find((argument) => !known.some((prefix) => argument === prefix || argument.startsWith(prefix)));
    assert.equal(unknown,undefined,`unknown option: ${unknown}`);
    const output=path.resolve(option('output',args) || defaultOutput);
    const results=path.resolve(option('results-directory',args) || defaultResults);
    const svg=await buildChart(results);
    if(args.includes('--check')) assert.equal(await readFile(output,'utf8'),svg,`${path.relative(process.cwd(),output)} is stale`);
    else{
        await mkdir(path.dirname(output),{recursive:true});
        await writeFile(output,svg);
    }
    return svg;
}

const direct=process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if(direct) await main();

export {buildChart,main,renderChart,selectBatch};
