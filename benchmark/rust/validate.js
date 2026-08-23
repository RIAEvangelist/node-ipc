#!/usr/bin/env node

import assert from 'node:assert/strict';
import {lstat,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {validateResult} from './lib.js';
import {validateHistory} from './history.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const tracked=process.argv.includes('--tracked');
const provided=process.argv.slice(2).filter((argument) => argument !== '--tracked');
assert.ok(provided.length>0,'provide at least one result file or directory');
const schema=JSON.parse(await readFile(path.join(directory,'result-schema.json'),'utf8'));
assert.equal(schema.$id,'https://riaevangelist.github.io/node-ipc/data/rust-benchmarks/result-schema.json','public schema id differs');

const files=[];
const inline=[];
let histories=0;
let historyResults=0;
for(const providedPath of provided){
    if(providedPath === '-'){
        const chunks=[];
        for await(const chunk of process.stdin) chunks.push(chunk);
        inline.push(Buffer.concat(chunks));
        continue;
    }
    const resolved=path.resolve(providedPath);
    const details=await lstat(resolved);
    assert.equal(details.isSymbolicLink(),false,`${providedPath}: symbolic links are forbidden`);
    if(details.isDirectory()){
        const names=await readdir(resolved,{withFileTypes:true});
        if(names.some((entry) => entry.name === 'index.json')){
            const index=await validateHistory(resolved,{tracked});
            histories++;
            historyResults+=index.results.length;
            continue;
        }
        for(const entry of names){
            assert.equal(entry.isSymbolicLink(),false,`${entry.name}: symbolic links are forbidden`);
            if(entry.isFile() && /^run-[A-Za-z0-9-]+[.]json$/u.test(entry.name)) files.push(path.join(resolved,entry.name));
        }
    }else{
        assert.ok(details.isFile(),`${providedPath}: result must be a regular file`);
        files.push(resolved);
    }
}
assert.ok(files.length+inline.length+histories>0,'no result files found');
for(const file of files.sort()){
    const result=validateResult(JSON.parse(await readFile(file,'utf8')),{tracked});
    assert.equal(path.basename(file),result.record.file,`${file}: record filename differs`);
}
for(const bytes of inline) validateResult(JSON.parse(bytes),{tracked});
const total=files.length+inline.length+historyResults;
process.stdout.write(`validated ${total} Rust/Node benchmark result${total === 1 ? '' : 's'}\n`);
