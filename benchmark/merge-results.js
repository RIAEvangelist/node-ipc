import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,lstat,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const source=process.argv[2];
if(!source){
    throw new Error('usage: node benchmark/merge-results.js <downloaded-artifact-directory>');
}

const directory=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(directory,'..');
const resultsDirectory=path.join(directory,'results');
const indexPath=path.join(resultsDirectory,'index.json');
const validator=path.join(directory,'validate-results.js');
const canonicalAdapters=['node-net','node-ipc-raw','node-ipc-fast','node-ipc-guarded'];
const expectedCommit=git('rev-parse','HEAD');

validate(resultsDirectory);
const index=JSON.parse(await readFile(indexPath,'utf8'));
const candidates=await Promise.all((await findInputs(path.resolve(source))).map(readCandidate));
assert.equal(new Set(candidates.map(({result}) => result.id)).size,6,'benchmark result ids must be unique');
assert.equal(new Set(candidates.map(({file}) => file)).size,6,'benchmark result filenames must be unique');

const byId=new Map(index.results.map((entry) => [entry.id,entry]));
const byFile=new Map(index.results.map((entry) => [entry.file,entry]));
const existing=[];
const additions=[];

for(const candidate of candidates){
    const idEntry=byId.get(candidate.result.id);
    const fileEntry=byFile.get(candidate.file);
    if(idEntry || fileEntry){
        assert.ok(idEntry && fileEntry && idEntry === fileEntry,`${candidate.file}: conflicting result id or filename`);
        assert.equal(idEntry.sha256,candidate.sha256,`${candidate.file}: tracked result bytes differ`);
        assert.deepEqual(idEntry,manifestEntry(candidate),`${candidate.file}: tracked manifest entry differs`);
        assert.equal(
            sha256(await readFile(path.join(resultsDirectory,candidate.file))),
            candidate.sha256,
            `${candidate.file}: tracked file bytes differ`
        );
        existing.push(candidate);
    }else{
        additions.push(candidate);
    }
}

if(existing.length === candidates.length){
    process.stdout.write('all six benchmark results are already tracked; no changes made\n');
}else{
    assert.equal(existing.length,0,'official benchmark snapshots cannot be merged as a partial batch');
    validateBatch(additions);
    additions.sort(compareCandidates);
    const entries=additions.map(manifestEntry);
    const updated={
        schemaVersion:2,
        updatedAt:additions.reduce(
            (latest,{result}) => result.record.recordedAt > latest ? result.record.recordedAt : latest,
            index.updatedAt
        ),
        comparisonState:'profile-comparison',
        results:[...index.results,...entries]
    };
    await install(additions,updated);
    process.stdout.write(`merged ${entries.length} sanitized benchmark results\n`);
}

async function install(additions,index){
    const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-benchmark-merge-'));
    const candidateDirectory=path.join(temporaryRoot,'results');
    const installed=[];
    let manifestInstalled=false;
    try{
        await cp(resultsDirectory,candidateDirectory,{recursive:true});
        for(const addition of additions){
            await writeFile(path.join(candidateDirectory,addition.file),addition.serialized,{flag:'wx'});
        }
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
        if(!manifestInstalled){
            await Promise.all(installed.map((file) => rm(file,{force:true})));
        }
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

async function findInputs(root){
    const rootStat=await lstat(root);
    assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(),'benchmark artifact source must be a real directory');
    const files=[];
    await walk(root,files);
    assert.equal(files.length,6,'official snapshot requires exactly six result files');
    return files.sort(compareText);
}

async function walk(directory,files){
    const entries=(await readdir(directory,{withFileTypes:true})).sort((left,right) => compareText(left.name,right.name));
    assert.ok(entries.length > 0,`${directory}: empty artifact directory`);
    for(const entry of entries){
        const target=path.join(directory,entry.name);
        assert.ok(!entry.isSymbolicLink(),`${target}: symbolic links are forbidden`);
        if(entry.isDirectory()){
            await walk(target,files);
        }else{
            assert.ok(entry.isFile(),`${target}: only regular files are allowed`);
            assert.match(entry.name,/^run-[A-Za-z0-9-]+\.json$/u,`${target}: unexpected artifact file`);
            files.push(target);
        }
    }
}

async function readCandidate(sourceFile){
    const serialized=await readFile(sourceFile);
    const result=JSON.parse(serialized.toString('utf8'));
    const file=path.basename(sourceFile);
    assert.equal(result.schemaVersion,2,`${file}: schemaVersion must be 2`);
    assert.equal(result.record?.file,file,`${file}: record.file mismatch`);
    assert.equal(result.evidence?.publishable,true,`${file}: result is not publishable`);
    assert.equal(result.evidence?.rankingEligible,false,`${file}: profile result cannot rank or certify`);
    const baseline=JSON.stringify(result.config?.adapters) === JSON.stringify(['node-net']);
    const profiles=JSON.stringify(result.config?.adapters) === JSON.stringify(canonicalAdapters);
    assert.ok(baseline || profiles,`${file}: unexpected adapter set`);
    assert.equal(
        result.evidence?.comparison?.state,
        profiles ? 'profile-comparison' : 'baseline-only',
        `${file}: comparison state does not match its adapters`
    );
    return {file,result,serialized,sha256:sha256(serialized)};
}

function validateBatch(candidates){
    const expectedMatrix=[
        'darwin:v22.13.0',
        'darwin:v24.18.1',
        'linux:v22.13.0',
        'linux:v24.18.1',
        'win32:v22.13.0',
        'win32:v24.18.1'
    ];
    assert.deepEqual(
        candidates.map(({result}) => `${result.system.platform}:${result.system.node}`).sort(compareText),
        expectedMatrix,
        'official snapshot matrix is incomplete, duplicated, or on an unexpected Node version'
    );

    const first=candidates[0].result.system.environment;
    for(const {file,result} of candidates){
        assert.deepEqual(result.config.adapters,canonicalAdapters,`${file}: expected the canonical profile adapters`);
        const environment=result.system.environment;
        assert.equal(result.repository.commit,expectedCommit,`${file}: measured commit is not current HEAD`);
        assert.equal(environment.provider,'github-actions',`${file}: expected GitHub Actions evidence`);
        assert.equal(environment.githubRepository,'RIAEvangelist/node-ipc',`${file}: unexpected repository`);
        assert.equal(environment.runId,first.runId,`${file}: workflow run id differs`);
        assert.equal(environment.runAttempt,first.runAttempt,`${file}: workflow run attempt differs`);
        assert.equal(environment.sourceRef,'refs/heads/main',`${file}: benchmark source is not main`);
        assert.equal(environment.sourceSha,expectedCommit,`${file}: workflow source SHA differs`);
        assert.equal(environment.workflow,'Record benchmark snapshots',`${file}: unexpected workflow`);
        assert.equal(environment.workflowRef,first.workflowRef,`${file}: workflow reference differs`);
        assert.equal(environment.workflowSha,expectedCommit,`${file}: workflow SHA differs`);
    }
}

function manifestEntry({file,result,sha256}){
    return {
        architecture:result.system.architecture,
        classification:result.evidence.classification,
        cleanupClean:result.cleanup.clean,
        commit:result.repository.commit,
        dirty:result.repository.dirty,
        file,
        generatedAt:result.generatedAt,
        id:result.id,
        machine:result.system.machine,
        node:result.system.node,
        oracle:result.oracle.implementation,
        packageFootprintStatus:result.evidence.packageFootprintStatus,
        platform:result.system.platform,
        publishable:result.evidence.publishable,
        rankingEligible:result.evidence.rankingEligible,
        sha256
    };
}

function validate(results){
    execFileSync(
        process.execPath,
        [validator,`--results-directory=${results}`],
        {cwd:repositoryRoot,stdio:'inherit'}
    );
}

function git(...arguments_){
    return execFileSync('git',arguments_,{cwd:repositoryRoot,encoding:'utf8'}).trim();
}

function compareCandidates(left,right){
    return compareText(tuple(left.result),tuple(right.result));
}

function compareText(left,right){
    return left < right ? -1 : left > right ? 1 : 0;
}

function tuple(result){
    return [result.system.platform,result.system.architecture,result.system.node,result.id].join('\0');
}

function sha256(value){
    return createHash('sha256').update(value).digest('hex');
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
