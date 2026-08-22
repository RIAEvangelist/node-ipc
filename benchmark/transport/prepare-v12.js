import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const tag='12.0.0';
const commit='a98efaedbf090d7bf4d6bdf07761301c531608af';
const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

function command(name,args,options={}){
    return new Promise((resolve,reject) => {
        const child=spawn(name,args,{...options,stdio:['ignore','pipe','pipe']});
        let stdout='';
        let stderr='';
        child.stdout?.on('data',(chunk) => stdout+=chunk);
        child.stderr?.on('data',(chunk) => stderr+=chunk);
        child.once('error',reject);
        child.once('exit',(code,signal) => code === 0
            ? resolve(stdout)
            : reject(new Error(`${name} exited code=${code} signal=${signal}: ${stderr.trim()}`))
        );
    });
}

function exportTag(source,destination){
    return new Promise((resolve,reject) => {
        const archive=spawn('git',['archive','--format=tar',tag],{
            cwd:source,
            stdio:['ignore','pipe','pipe']
        });
        const extract=spawn('tar',['-xf','-','-C',destination],{
            stdio:['pipe','ignore','pipe']
        });
        let errors='';
        let archiveCode;
        let extractCode;
        const fail=(error) => reject(error);
        const finish=() => {
            if(archiveCode === undefined || extractCode === undefined) return;
            if(archiveCode === 0 && extractCode === 0){
                resolve();
                return;
            }
            reject(new Error(`git archive/tar failed: ${errors.trim()}`));
        };
        archive.stderr.on('data',(chunk) => errors+=chunk);
        extract.stderr.on('data',(chunk) => errors+=chunk);
        archive.once('error',fail);
        extract.once('error',fail);
        archive.once('exit',(code) => {archiveCode=code;finish();});
        extract.once('exit',(code) => {extractCode=code;finish();});
        archive.stdout.pipe(extract.stdin);
    });
}

async function prepareV12(destination,source=repositoryRoot){
    destination=path.resolve(destination);
    await mkdir(destination,{recursive:true});
    if((await readdir(destination)).length){
        throw new Error(`v12 destination must be empty: ${destination}`);
    }

    const resolved=(await command('git',['rev-parse',`${tag}^{commit}`],{cwd:source})).trim();
    if(resolved !== commit){
        throw new Error(`tag ${tag} resolved to ${resolved}, expected ${commit}`);
    }

    await exportTag(source,destination);
    const manifest=JSON.parse(await readFile(path.join(destination,'package.json'),'utf8'));
    if(manifest.name !== 'node-ipc' || manifest.version !== tag){
        throw new Error(`tag ${tag} exported ${manifest.name}@${manifest.version}`);
    }

    const lockFile=path.join(destination,'package-lock.json');
    const lockSha256=createHash('sha256').update(await readFile(lockFile)).digest('hex');
    const npmArguments=['ci','--omit=dev','--ignore-scripts','--prefix',destination];
    if(process.platform === 'win32'){
        const shim=(await command('where.exe',['npm.cmd'])).trim().split(/\r?\n/u)[0];
        const cli=process.env.npm_execpath || path.join(path.dirname(shim),'node_modules','npm','bin','npm-cli.js');
        await command(process.execPath,[cli,...npmArguments]);
    }else{
        await command('npm',npmArguments);
    }
    const installedLockSha256=createHash('sha256').update(await readFile(lockFile)).digest('hex');
    if(installedLockSha256 !== lockSha256){
        throw new Error('npm ci changed the pinned v12 package lock');
    }
    return {
        commit,
        packageLockSha256:lockSha256,
        root:destination,
        tag,
        version:manifest.version
    };
}

if(process.argv[1] === fileURLToPath(import.meta.url)){
    const destination=process.argv[2];
    if(!destination) throw new Error('usage: node benchmark/transport/prepare-v12.js <empty-destination>');
    process.stdout.write(`${JSON.stringify(await prepareV12(destination))}\n`);
}

export {commit,prepareV12,tag};
