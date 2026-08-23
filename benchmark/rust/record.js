#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {sha256,validateResult} from './lib.js';

const execute=promisify(execFile);
const directory=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(directory,'..','..');
const arguments_=process.argv.slice(2);
const outputArgument=arguments_.find((argument) => argument.startsWith('--output-directory='));

assert.deepEqual(
    arguments_.filter((argument) => !argument.startsWith('--output-directory=')),
    ['--full'],
    'tracked recording requires exactly --full'
);
assert.ok(outputArgument,'tracked recording requires --output-directory');
assert.equal(arguments_.filter((argument) => argument.startsWith('--output-directory=')).length,1,'output directory must be unique');

const outputDirectory=path.resolve(outputArgument.slice('--output-directory='.length));
assert.equal(process.env.GITHUB_ACTIONS,'true','tracked recording requires GitHub Actions');
assert.equal(process.env.GITHUB_REF,'refs/heads/main','tracked recording requires main');
assert.equal(process.env.GITHUB_SHA?.length,40,'tracked recording requires an exact workflow SHA');
const before=await repositoryState();
assert.equal(before.dirty,false,'tracked recording requires a clean Git tree');
const {stdout,stderr}=await execute(
    process.execPath,
    [path.join(directory,'run.js'),'--full'],
    {
        cwd:projectRoot,
        encoding:'utf8',
        maxBuffer:64*1024*1024,
        timeout:4*60*60*1000,
        windowsHide:true
    }
);
if(stderr.trim()) process.stderr.write(stderr);
const result=JSON.parse(stdout);
result.record.recordedAt=new Date().toISOString();
const after=await repositoryState();
assert.deepEqual(after,before,'repository changed during tracked recording');
assert.equal(result.repository.commit,before.commit,'runtime measured a different commit');
validateResult(result,{tracked:true});
const serialized=`${JSON.stringify(result,null,2)}\n`;
assert.equal(sha256(serialized).length,64);
await mkdir(outputDirectory,{recursive:true});
await writeFile(path.join(outputDirectory,result.record.file),serialized,{flag:'wx'});
process.stdout.write(`${result.record.file}\n`);

async function repositoryState(){
    const [{stdout:commit},{stdout:status}]=await Promise.all([
        execute('git',['rev-parse','HEAD'],{cwd:projectRoot,encoding:'utf8',windowsHide:true}),
        execute('git',['status','--porcelain','--untracked-files=all'],{cwd:projectRoot,encoding:'utf8',windowsHide:true})
    ]);
    return {commit:commit.trim(),dirty:status.trim().length>0,statusSha256:sha256(status)};
}
