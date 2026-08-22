import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    legacyProvenance,
    manifestEntry,
    sha256,
    summarize,
    validDate,
    validateCanonicalRuntime
} from './transport-evidence.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const canonicalResultsDirectory=path.join(directory,'transport-results');
const resultsArgument=process.argv.find((argument) => argument.startsWith('--results-directory='));
const resultsDirectory=resultsArgument
    ? path.resolve(resultsArgument.slice('--results-directory='.length))
    : canonicalResultsDirectory;
const index=await readJson(path.join(resultsDirectory,'index.json'));
const schema=await readJson(path.join(directory,'transport-result-schema.json'));
const details=[];
const entries=await readdir(resultsDirectory,{withFileTypes:true});
for(const entry of entries){
    assert.ok(entry.isFile(),`${entry.name}: transport results must contain regular files only`);
    assert.match(entry.name,/^(?:index|run-[A-Za-z0-9-]+)[.]json$/u,`${entry.name}: unexpected transport result file`);
}
const files=entries.map((entry) => entry.name).filter((name) => name !== 'index.json').sort();

assert.equal(index.schemaVersion,1,'transport manifest schemaVersion must be 1');
assert.equal(schema.$id,'https://riaevangelist.github.io/node-ipc/data/transport-benchmarks/result-schema.json','transport result schema must use its public Pages URL');
assert.ok(index.updatedAt === null || validDate(index.updatedAt),'transport manifest updatedAt must be null or an ISO timestamp');
assert.ok(['no-verified-runs','version-comparison'].includes(index.comparisonState),'transport comparison state is invalid');
assert.ok(Array.isArray(index.results),'transport manifest results must be an array');
assert.equal(new Set(index.results.map((entry) => entry.id)).size,index.results.length,'transport run ids must be unique');
assert.equal(new Set(index.results.map((entry) => entry.file)).size,index.results.length,'transport filenames must be unique');
assert.deepEqual(index.results.map((entry) => entry.file).sort(),files,'transport manifest must reference every and only tracked run file');
if(index.results.length === 0){
    assert.equal(index.updatedAt,null,'empty transport manifest updatedAt must be null');
    assert.equal(index.comparisonState,'no-verified-runs','empty transport manifest must remain pending');
}else{
    assert.ok(validDate(index.updatedAt),'nonempty transport manifest requires updatedAt');
    assert.equal(index.comparisonState,'version-comparison','tracked transport comparisons must declare their state');
}
if(path.resolve(resultsDirectory) === path.resolve(canonicalResultsDirectory)) validateAppendOnlyHistory(index);

for(const entry of index.results){
    const serialized=await readFile(path.join(resultsDirectory,entry.file));
    assert.equal(sha256(serialized),entry.sha256,`${entry.file}: manifest SHA-256 mismatch`);
    const result=JSON.parse(serialized.toString('utf8'));
    assert.deepEqual(schemaErrors(result,schema,'$'),[],`${entry.file}: result does not match transport-result-schema.json`);
    validateResult(result,entry,serialized);
    details.push(result);
}

validateTrackedBatches(details);

process.stdout.write(`validated ${index.results.length} sanitized tracked transport benchmark result${index.results.length === 1 ? '' : 's'}\n`);

function validateResult(result,entry,serialized){
    const label=entry.file;
    validateCanonicalRuntime(result,label);
    assert.equal(result.id,entry.id,`${label}: id differs from manifest`);
    assert.equal(result.record.file,entry.file,`${label}: record filename differs`);
    assert.ok(validDate(result.record.recordedAt),`${label}: record timestamp is invalid`);
    assert.equal(result.repository.capture,'pre-and-post-execution',`${label}: Git capture policy differs`);
    assert.equal(result.repository.dirty,false,`${label}: tracked evidence must be clean`);
    assert.equal(result.repository.changedDuringRun,false,`${label}: repository changed during measurement`);
    assert.equal(result.repository.preExecution.commit,result.repository.commit,`${label}: pre-execution commit differs`);
    assert.equal(result.repository.postExecution.commit,result.repository.commit,`${label}: post-execution commit differs`);
    assert.equal(result.repository.preExecution.dirty,false,`${label}: pre-execution tree was dirty`);
    assert.equal(result.repository.postExecution.dirty,false,`${label}: post-execution tree was dirty`);
    assert.equal(result.repository.preExecution.statusSha256,result.repository.postExecution.statusSha256,`${label}: pre/post Git status differs`);
    assert.deepEqual(result.summary,summarize(result.samples,result.system.platform),`${label}: summary must be recomputed from raw pairs`);
    assert.equal(result.evidence.authority,'snapshot-noisy',`${label}: hosted evidence must be labelled noisy`);
    assert.equal(result.evidence.classification,'clean-end-to-end-transport-comparison',`${label}: classification differs`);
    assert.equal(result.evidence.publishable,true,`${label}: result is not publishable`);
    assert.equal(result.evidence.rankingEligible,false,`${label}: rankings are forbidden`);
    assert.equal(result.evidence.certification,false,`${label}: certification is forbidden`);
    assert.deepEqual(result.evidence.reasons,[],`${label}: accepted evidence cannot retain failure reasons`);
    assert.equal(result.evidence.privacy.sanitized,true,`${label}: result is not privacy-sanitized`);
    assert.equal(result.subjects['legacy-v12'].id,'legacy-v12',`${label}: legacy id differs`);
    assert.equal(result.subjects['legacy-v12'].version,legacyProvenance.version,`${label}: legacy version differs`);
    assert.equal(result.subjects['legacy-v12'].source.kind,'git-tag-archive',`${label}: legacy acquisition differs`);
    assert.equal(result.subjects['legacy-v12'].source.tag,legacyProvenance.tag,`${label}: legacy tag differs`);
    assert.equal(result.subjects['legacy-v12'].source.commit,legacyProvenance.commit,`${label}: legacy commit differs`);
    assert.equal(result.subjects['legacy-v12'].source.packageJsonSha256,gitBlobHash(legacyProvenance.commit,'package.json'),`${label}: legacy package manifest hash differs`);
    assert.equal(result.subjects['legacy-v12'].source.packageLockSha256,gitBlobHash(legacyProvenance.commit,'package-lock.json'),`${label}: legacy lock hash differs`);
    assert.equal(result.subjects.current.id,'current',`${label}: current id differs`);
    assert.equal(result.subjects.current.version,result.config.currentVersion,`${label}: current version differs`);
    assert.equal(result.subjects.current.source.kind,'clean-repository',`${label}: current acquisition differs`);
    assert.equal(result.subjects.current.source.commit,result.repository.commit,`${label}: current source commit differs`);
    assert.equal(result.subjects.current.source.packageJsonSha256,gitBlobHash(result.repository.commit,'package.json'),`${label}: current package manifest hash differs`);
    assert.equal(result.subjects.current.source.packageLockSha256,gitBlobHash(result.repository.commit,'package-lock.json'),`${label}: current lock hash differs`);
    assert.equal(
        result.oracles['standard-c-datagram-reflector'].build.sourceSha256,
        gitBlobHash(result.repository.commit,'benchmark/oracle/echo.c'),
        `${label}: datagram oracle source differs from its measured commit`
    );
    const committedPackage=JSON.parse(gitShow(result.repository.commit,'package.json'));
    assert.equal(result.config.currentVersion,committedPackage.version,`${label}: current package version differs from its commit`);
    assertNoEphemeralData(result,label);
    if(result.system.environment.provider === 'github-actions') validateGitHubEnvironment(result,label);
    assert.deepEqual(entry,manifestEntry(result,serialized),`${label}: manifest summary differs from result`);
}

function validateGitHubEnvironment(result,label){
    const environment=result.system.environment;
    const platformForLane={'macos-latest':'darwin','ubuntu-latest':'linux','windows-latest':'win32'};
    const architectureForRunner={ARM:'arm',ARM64:'arm64',X64:'x64'};
    assert.equal(environment.githubRepository,'RIAEvangelist/node-ipc',`${label}: unexpected repository`);
    assert.ok(environment.imageOS,`${label}: runner image OS is required`);
    assert.ok(environment.imageVersion,`${label}: runner image version is required`);
    assert.equal(`v${environment.nodeLane}`,result.system.node,`${label}: requested Node lane differs`);
    assert.equal(platformForLane[environment.osLane],result.system.platform,`${label}: requested OS lane differs`);
    assert.equal(architectureForRunner[environment.runnerArchitecture],result.system.architecture,`${label}: runner architecture differs`);
    assert.equal(environment.runnerEnvironment,'github-hosted',`${label}: official evidence requires a GitHub-hosted runner`);
    assert.match(environment.runId || '',/^\d+$/u,`${label}: workflow run id is required`);
    assert.match(environment.runAttempt || '',/^\d+$/u,`${label}: workflow attempt is required`);
    assert.equal(environment.sourceRef,'refs/heads/main',`${label}: official evidence requires main`);
    assert.equal(environment.sourceSha,result.repository.commit,`${label}: workflow source SHA differs`);
    assert.equal(environment.workflow,'Record transport comparison snapshots',`${label}: workflow identity differs`);
    assert.equal(environment.workflowRef,'RIAEvangelist/node-ipc/.github/workflows/transport-benchmark.yml@refs/heads/main',`${label}: workflow reference differs`);
    assert.equal(environment.workflowSha,result.repository.commit,`${label}: workflow SHA differs`);
}

function validateTrackedBatches(results){
    const expectedMatrix=[
        'darwin:v22.13.0','darwin:v24.18.1',
        'linux:v22.13.0','linux:v24.18.1',
        'win32:v22.13.0','win32:v24.18.1'
    ];
    const batches=new Map;
    for(const result of results){
        assert.equal(result.system.environment.provider,'github-actions',`${result.id}: tracked transport evidence must come from GitHub Actions`);
        const key=[
            result.repository.commit,
            result.system.environment.runId,
            result.system.environment.runAttempt
        ].join(':');
        const batch=batches.get(key) || [];
        batch.push(result);
        batches.set(key,batch);
    }
    for(const [key,batch] of batches){
        assert.equal(batch.length,6,`${key}: tracked transport batch must contain six exact environment lanes`);
        assert.deepEqual(batch.map((result) => `${result.system.platform}:${result.system.node}`).sort(),expectedMatrix,`${key}: tracked transport matrix differs`);
    }
}

function validateAppendOnlyHistory(current){
    const manifestPath='benchmark/transport-results/index.json';
    let revisions=[];
    try{
        revisions=execFileSync('git',['log','--format=%H','--',manifestPath],{cwd:path.resolve(directory,'..'),encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/u).filter(Boolean);
    }catch{
        return;
    }
    const canonical=JSON.stringify(current);
    let previous;
    for(const revision of revisions){
        try{
            const candidate=JSON.parse(execFileSync('git',['show',`${revision}:${manifestPath}`],{cwd:path.resolve(directory,'..'),encoding:'utf8',stdio:['ignore','pipe','ignore']}));
            if(JSON.stringify(candidate) !== canonical){
                previous=candidate;
                break;
            }
        }catch{
            // Keep looking across the file's introduction.
        }
    }
    if(!previous) return;
    assert.equal(previous.schemaVersion,1,'previous transport manifest schemaVersion differs');
    assert.ok(previous.results.length <= current.results.length,'transport history cannot delete runs');
    assert.deepEqual(current.results.slice(0,previous.results.length),previous.results,'transport history is append-only');
    if(previous.updatedAt) assert.ok(Date.parse(current.updatedAt) >= Date.parse(previous.updatedAt),'transport manifest time moved backward');
}

function gitBlobHash(commit,file){
    return sha256(execFileSync('git',['show',`${commit}:${file}`],{cwd:path.resolve(directory,'..'),encoding:'buffer'}));
}

function gitShow(commit,file){
    return execFileSync('git',['show',`${commit}:${file}`],{cwd:path.resolve(directory,'..'),encoding:'utf8'});
}

function assertNoEphemeralData(value,label,segments=[]){
    const banned=new Set(['endpoint','endpoints','path','pid','pids','port','root','trialDirectory']);
    if(Array.isArray(value)){
        value.forEach((entry,index) => assertNoEphemeralData(entry,label,[...segments,String(index)]));
        return;
    }
    if(!value || typeof value !== 'object'){
        if(typeof value === 'string'){
            assert.ok(!/^[a-zA-Z]:[\\/]/u.test(value),`${label}: absolute Windows path at ${segments.join('.')}`);
            assert.ok(!/^\/(?:Users|home|tmp|var\/tmp)\//u.test(value),`${label}: absolute POSIX path at ${segments.join('.')}`);
        }
        return;
    }
    for(const [key,entry] of Object.entries(value)){
        assert.ok(!banned.has(key),`${label}: ephemeral field ${[...segments,key].join('.')} is forbidden`);
        assertNoEphemeralData(entry,label,[...segments,key]);
    }
}

function schemaErrors(value,definition,pointer){
    const failures=[];
    const types=Array.isArray(definition.type) ? definition.type : definition.type ? [definition.type] : [];
    if(types.length && !types.some((type) => matchesType(value,type))) return [`${pointer}: expected ${types.join(' or ')}`];
    if(Object.hasOwn(definition,'const') && !deepEqual(value,definition.const)) failures.push(`${pointer}: value differs from const`);
    if(definition.enum && !definition.enum.some((candidate) => deepEqual(value,candidate))) failures.push(`${pointer}: value is outside enum`);
    if(typeof value === 'string'){
        if(definition.pattern && !new RegExp(definition.pattern,'u').test(value)) failures.push(`${pointer}: string does not match pattern`);
        if(definition.format === 'date-time' && !validDate(value)) failures.push(`${pointer}: invalid date-time`);
        if(definition.minLength !== undefined && value.length < definition.minLength) failures.push(`${pointer}: string is too short`);
    }
    if(typeof value === 'number' && definition.minimum !== undefined && value < definition.minimum) failures.push(`${pointer}: number is below minimum`);
    if(Array.isArray(value)){
        if(definition.minItems !== undefined && value.length < definition.minItems) failures.push(`${pointer}: too few items`);
        if(definition.maxItems !== undefined && value.length > definition.maxItems) failures.push(`${pointer}: too many items`);
        if(definition.items) value.forEach((entry,index) => failures.push(...schemaErrors(entry,definition.items,`${pointer}/${index}`)));
    }
    if(value && typeof value === 'object' && !Array.isArray(value)){
        for(const required of definition.required || []) if(!Object.hasOwn(value,required)) failures.push(`${pointer}: missing ${required}`);
        for(const [key,entry] of Object.entries(value)){
            if(definition.properties?.[key]) failures.push(...schemaErrors(entry,definition.properties[key],`${pointer}/${key}`));
            else if(definition.additionalProperties === false) failures.push(`${pointer}: unexpected property ${key}`);
        }
    }
    return failures;
}

function matchesType(value,type){
    if(type === 'null') return value === null;
    if(type === 'array') return Array.isArray(value);
    if(type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if(type === 'integer') return Number.isInteger(value);
    return typeof value === type;
}

function deepEqual(left,right){
    try{assert.deepEqual(left,right);return true;}catch{return false;}
}

async function readJson(file){
    return JSON.parse(await readFile(file,'utf8'));
}
