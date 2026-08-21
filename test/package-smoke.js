import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const npmCli=process.env.npm_execpath;

if(!npmCli){
    throw new Error('npm_execpath is required for the package smoke test.');
}

const tempRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-package-'));

function npm(args,cwd=projectRoot){
    return execFileSync(
        process.execPath,
        [npmCli,...args],
        {cwd,encoding:'utf8',stdio:['ignore','pipe','inherit']}
    );
}

try{
    const [packed]=JSON.parse(npm([
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        tempRoot
    ]));
    const files=new Set(packed.files.map(({path:file}) => file.replaceAll('\\','/')));

    assert.ok(files.has('node-ipc.js'));
    assert.ok(!files.has('node-ipc.cjs'));
    assert.ok(![...files].some((file) => file.startsWith('.github/')));
    assert.ok(![...files].some((file) => file.startsWith('assets/')));
    assert.ok(![...files].some((file) => file.startsWith('docs/')));
    assert.ok(![...files].some((file) => file.startsWith('benchmark/results/')));

    const consumer=path.join(tempRoot,'consumer');
    const tarball=path.join(tempRoot,packed.filename);
    await mkdir(consumer);
    await writeFile(
        path.join(consumer,'package.json'),
        '{"private":true}\n'
    );
    await writeFile(
        path.join(consumer,'smoke.cjs'),
        `const assert=require('node:assert/strict');
const required=require('node-ipc');

assert.equal(typeof required.IPCModule,'function');
assert.ok(required.default instanceof required.IPCModule);
assert.match(require.resolve('node-ipc'),/node-ipc\\.js$/);

import('node-ipc').then((imported) => {
    assert.strictEqual(required.default,imported.default);
    assert.strictEqual(required.IPCModule,imported.IPCModule);
}).catch((err) => {
    console.error(err);
    process.exitCode=1;
});
`
    );

    npm(['install','--ignore-scripts','--no-audit','--no-fund',tarball],consumer);
    execFileSync(process.execPath,['smoke.cjs'],{cwd:consumer,stdio:'inherit'});
    console.log('node-ipc installed package smoke passed');
}finally{
    await rm(tempRoot,{recursive:true,force:true});
}
