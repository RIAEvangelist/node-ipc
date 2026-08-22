import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,lstat,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {compareText,manifestEntry,sha256,transportOrder} from './transport-evidence.js';

const source=process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if(!source) throw new Error('usage: node benchmark/merge-transport-results.js <downloaded-artifact-directory>');
const directory=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(directory,'..');
const resultsArgument=process.argv.find((argument) => argument.startsWith('--results-directory='));
const resultsDirectory=resultsArgument
    ? path.resolve(resultsArgument.slice('--results-directory='.length))
    : path.join(directory,'transport-results');
const indexPath=path.join(resultsDirectory,'index.json');
const validator=path.join(directory,'validate-transport-results.js');
const expectedCommit=git('rev-parse','HEAD');

validate(resultsDirectory);
const index=JSON.parse(await readFile(indexPath,'utf8'));
const inputFiles=await findInputs(path.resolve(source));
const candidates=await Promise.all(inputFiles.map(readCandidate));
assert.equal(new Set(candidates.map(({result}) => result.id)).size,6,'transport result ids must be unique');
assert.equal(new Set(candidates.map(({file}) => file)).size,6,'transport result filenames must be unique');

const byId=new Map(index.results.map((entry) => [entry.id,entry]));
const byFile=new Map(index.results.map((entry) => [entry.file,entry]));
const existing=[];
const additions=[];
for(const candidate of candidates){
    const idEntry=byId.get(candidate.result.id);
    const fileEntry=byFile.get(candidate.file);
    if(idEntry || fileEntry){
        assert.ok(idEntry && fileEntry && idEntry === fileEntry,`${candidate.file}: conflicting id or filename`);
        assert.deepEqual(idEntry,manifestEntry(candidate.result,candidate.serialized),`${candidate.file}: tracked manifest entry differs`);
        assert.equal(sha256(await readFile(path.join(resultsDirectory,candidate.file))),candidate.sha256,`${candidate.file}: tracked bytes differ`);
        existing.push(candidate);
    }else{
        additions.push(candidate);
    }
}

if(existing.length === candidates.length){
    process.stdout.write('all six transport results are already tracked; no changes made\n');
}else{
    assert.equal(existing.length,0,'official transport snapshots cannot be merged as a partial batch');
    validateBatch(additions);
    additions.sort(compareCandidates);
    const updated={
        schemaVersion:1,
        updatedAt:additions.reduce((latest,{result}) => latest && latest > result.record.recordedAt ? latest : result.record.recordedAt,index.updatedAt),
        comparisonState:'version-comparison',
        results:[...index.results,...additions.map((candidate) => manifestEntry(candidate.result,candidate.serialized))]
    };
    await install(additions,updated);
    process.stdout.write(`merged ${additions.length} sanitized transport benchmark results\n`);
}

async function findInputs(root){
    const stat=await lstat(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(),'transport artifact source must be a real directory');
    const files=[];
    await walk(root,files);
    assert.equal(files.length,6,'official transport snapshot requires exactly six result files');
    return files.sort(compareText);
}

async function walk(current,files){
    const entries=(await readdir(current,{withFileTypes:true})).sort((left,right) => compareText(left.name,right.name));
    assert.ok(entries.length > 0,`${current}: empty artifact directory`);
    for(const entry of entries){
        const target=path.join(current,entry.name);
        assert.ok(!entry.isSymbolicLink(),`${target}: symbolic links are forbidden`);
        if(entry.isDirectory()) await walk(target,files);
        else{
            assert.ok(entry.isFile(),`${target}: only regular files are allowed`);
            assert.match(entry.name,/^run-[A-Za-z0-9-]+[.]json$/u,`${target}: unexpected artifact file`);
            files.push(target);
        }
    }
}

async function readCandidate(sourceFile){
    const serialized=await readFile(sourceFile);
    const result=JSON.parse(serialized.toString('utf8'));
    const file=path.basename(sourceFile);
    assert.equal(result.schemaVersion,1,`${file}: schemaVersion must be 1`);
    assert.equal(result.record?.file,file,`${file}: record filename differs`);
    assert.equal(result.evidence?.publishable,true,`${file}: result is not publishable`);
    assert.equal(result.evidence?.rankingEligible,false,`${file}: rankings are forbidden`);
    assert.equal(result.evidence?.certification,false,`${file}: certification is forbidden`);
    assert.deepEqual(result.config?.transports,transportOrder,`${file}: transport set differs`);
    return {file,result,serialized,sha256:sha256(serialized)};
}

function validateBatch(candidates){
    const expectedMatrix=[
        'darwin:v22.13.0','darwin:v24.18.1',
        'linux:v22.13.0','linux:v24.18.1',
        'win32:v22.13.0','win32:v24.18.1'
    ];
    assert.deepEqual(candidates.map(({result}) => `${result.system.platform}:${result.system.node}`).sort(compareText),expectedMatrix,'official transport matrix is incomplete, duplicated, or on an unexpected Node version');
    const first=candidates[0].result.system.environment;
    for(const {file,result} of candidates){
        const environment=result.system.environment;
        assert.equal(result.repository.commit,expectedCommit,`${file}: measured commit is not current HEAD`);
        assert.equal(environment.provider,'github-actions',`${file}: expected GitHub Actions evidence`);
        assert.equal(environment.githubRepository,'RIAEvangelist/node-ipc',`${file}: unexpected repository`);
        assert.equal(environment.runId,first.runId,`${file}: workflow run id differs`);
        assert.equal(environment.runAttempt,first.runAttempt,`${file}: workflow attempt differs`);
        assert.equal(environment.sourceRef,'refs/heads/main',`${file}: benchmark source is not main`);
        assert.equal(environment.sourceSha,expectedCommit,`${file}: source SHA differs`);
        assert.equal(environment.workflow,'Record transport comparison snapshots',`${file}: workflow identity differs`);
        assert.equal(environment.workflowRef,first.workflowRef,`${file}: workflow reference differs`);
        assert.equal(environment.workflowSha,expectedCommit,`${file}: workflow SHA differs`);
    }
}

async function install(additions,index){
    const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-transport-merge-'));
    const candidateDirectory=path.join(temporaryRoot,'transport-results');
    const installed=[];
    let manifestInstalled=false;
    try{
        await cp(resultsDirectory,candidateDirectory,{recursive:true});
        for(const addition of additions) await writeFile(path.join(candidateDirectory,addition.file),addition.serialized,{flag:'wx'});
        await writeFile(path.join(candidateDirectory,'index.json'),`${JSON.stringify(index,null,2)}\n`);
        validate(candidateDirectory);
        for(const addition of additions){
            const target=path.join(resultsDirectory,addition.file);
            await writeFile(target,addition.serialized,{flag:'wx'});
            installed.push(target);
        }
        await writeAtomic(indexPath,`${JSON.stringify(index,null,2)}\n`);
        manifestInstalled=true;
    }finally{
        if(!manifestInstalled) await Promise.all(installed.map((file) => rm(file,{force:true})));
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

function validate(results){
    execFileSync(process.execPath,[validator,`--results-directory=${results}`],{cwd:repositoryRoot,stdio:'inherit'});
}

function git(...arguments_){
    return execFileSync('git',arguments_,{cwd:repositoryRoot,encoding:'utf8'}).trim();
}

function compareCandidates(left,right){
    return compareText([left.result.system.platform,left.result.system.architecture,left.result.system.node,left.result.id].join('\0'),[right.result.system.platform,right.result.system.architecture,right.result.system.node,right.result.id].join('\0'));
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
