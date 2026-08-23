#!/usr/bin/env node

import assert from 'node:assert/strict';
import {cp,lstat,mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {manifestEntry,validateResult} from './lib.js';
import {validateHistory} from './history.js';

const inputArgument=process.argv.find((argument) => argument.startsWith('--input-directory='));
const outputArgument=process.argv.find((argument) => argument.startsWith('--output-directory='));
assert.ok(inputArgument && outputArgument,'merge requires --input-directory and --output-directory');
assert.equal(process.argv.slice(2).length,2,'unexpected merge argument');
const inputDirectory=path.resolve(inputArgument.slice('--input-directory='.length));
const outputDirectory=path.resolve(outputArgument.slice('--output-directory='.length));
const incoming=[];
await walk(inputDirectory,incoming);
assert.ok(incoming.length>0,'no benchmark artifacts found');

const batches=new Map;
for(const file of incoming){
    const bytes=await readFile(file);
    const result=validateResult(JSON.parse(bytes),{tracked:true});
    assert.equal(path.basename(file),result.record.file,`${file}: record filename differs`);
    const environment=result.system.environment;
    const batchKey=[result.repository.commit,environment.runId,environment.runAttempt].join(':');
    const batch=batches.get(batchKey) || [];
    batch.push({bytes,file,result,entry:manifestEntry(result,bytes)});
    batches.set(batchKey,batch);
}
const candidates=[...batches.values()].flat();
const incomingByFile=new Map(candidates.map((candidate) => [candidate.result.record.file,candidate]));
assert.equal(incomingByFile.size,candidates.length,'incoming result filenames must be unique');
for(const [key,batch] of batches){
    assert.equal(batch.length,3,`${key}: CI batch requires Windows, Linux, and macOS`);
    assert.deepEqual(batch.map(({result}) => result.system.platform).sort(),['darwin','linux','win32'],`${key}: platform matrix differs`);
    assert.equal(new Set(batch.map(({result}) => result.runtime.node.version)).size,1,`${key}: Node versions differ`);
    assert.equal(new Set(batch.map(({result}) => result.runtime.rust.release)).size,1,`${key}: Rust versions differ`);
}

await mkdir(outputDirectory,{recursive:true});
const indexPath=path.join(outputDirectory,'index.json');
const recovered=await recoverableResults();
const index=await validateHistory(outputDirectory,{allowMissing:true,allowUnindexed:recovered});
const existingById=new Map(index.results.map((entry) => [entry.id,entry]));
const additions=[];
for(const batch of batches.values()){
    const existing=batch.filter(({entry}) => existingById.has(entry.id));
    assert.ok(existing.length === 0 || existing.length === batch.length,'partial CI batch already exists');
    if(existing.length){
        for(const {entry} of batch) assert.deepEqual(existingById.get(entry.id),entry,`${entry.id}: existing manifest entry differs`);
        continue;
    }
    additions.push(...batch);
}
additions.sort((left,right) => {
    const leftEnvironment=left.result.system.environment;
    const rightEnvironment=right.result.system.environment;
    const leftBatch=`${leftEnvironment.runId}:${leftEnvironment.runAttempt}`;
    const rightBatch=`${rightEnvironment.runId}:${rightEnvironment.runAttempt}`;
    return leftBatch.localeCompare(rightBatch) || left.result.system.platform.localeCompare(right.result.system.platform);
});
if(additions.length){
    const updated={
        schemaVersion:1,
        updatedAt:additions.reduce(
            (latest,{result}) => latest && latest > result.record.recordedAt ? latest : result.record.recordedAt,
            index.updatedAt
        ),
        results:[...index.results,...additions.map(({entry}) => entry)]
    };
    await install(additions,updated,recovered);
}
process.stdout.write(`merged ${additions.length} new Rust/Node benchmark result${additions.length === 1 ? '' : 's'}\n`);

async function install(additions,index,recovered){
    const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-rust-merge-'));
    const candidateDirectory=path.join(temporaryRoot,'rust-results');
    let previousIndex;
    try{previousIndex=await readFile(indexPath);}catch(error){if(error.code !== 'ENOENT') throw error;}
    let manifestInstalled=false;
    let complete=false;
    try{
        await cp(outputDirectory,candidateDirectory,{recursive:true});
        for(const {bytes,result} of additions){
            if(!recovered.has(result.record.file)) await writeFile(path.join(candidateDirectory,result.record.file),bytes,{flag:'wx'});
        }
        await writeFile(path.join(candidateDirectory,'index.json'),`${JSON.stringify(index,null,2)}\n`);
        await validateHistory(candidateDirectory);
        for(const {bytes,result} of additions){
            const target=path.join(outputDirectory,result.record.file);
            if(!recovered.has(result.record.file)) await writeFile(target,bytes,{flag:'wx'});
        }
        await writeAtomic(indexPath,`${JSON.stringify(index,null,2)}\n`);
        manifestInstalled=true;
        await validateHistory(outputDirectory);
        complete=true;
    }finally{
        if(!complete){
            if(manifestInstalled){
                if(previousIndex) await writeAtomic(indexPath,previousIndex);
                else await rm(indexPath,{force:true});
            }
            await Promise.all(additions.map(({result}) => rm(path.join(outputDirectory,result.record.file),{force:true})));
        }
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

async function recoverableResults(){
    let manifest={results:[]};
    try{
        const details=await lstat(indexPath);
        assert.ok(details.isFile() && !details.isSymbolicLink(),'history manifest must be a regular file');
        manifest=JSON.parse(await readFile(indexPath,'utf8'));
    }catch(error){if(error.code !== 'ENOENT') throw error;}
    const referenced=new Set(Array.isArray(manifest.results) ? manifest.results.map((entry) => entry.file) : []);
    const recovered=new Set;
    for(const entry of await readdir(outputDirectory,{withFileTypes:true})){
        assert.equal(entry.isSymbolicLink(),false,`${entry.name}: symbolic links are forbidden`);
        if(!entry.isFile() || !/^run-[A-Za-z0-9-]+[.]json$/u.test(entry.name) || referenced.has(entry.name)) continue;
        const candidate=incomingByFile.get(entry.name);
        assert.ok(candidate,`${entry.name}: unindexed history result is not recoverable from this batch`);
        assert.deepEqual(await readFile(path.join(outputDirectory,entry.name)),candidate.bytes,`${entry.name}: recoverable result bytes differ`);
        recovered.add(entry.name);
    }
    return recovered;
}

async function writeAtomic(target,contents){
    const temporary=`${target}.${process.pid}.tmp`;
    try{
        await writeFile(temporary,contents,{flag:'wx'});
        await rename(temporary,target);
    }finally{
        await rm(temporary,{force:true});
    }
}

async function walk(directory,files){
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const full=path.join(directory,entry.name);
        assert.equal(entry.isSymbolicLink(),false,`${full}: symbolic links are forbidden`);
        if(entry.isDirectory()) await walk(full,files);
        else if(entry.isFile() && /^run-[A-Za-z0-9-]+[.]json$/u.test(entry.name)) files.push(full);
    }
}
