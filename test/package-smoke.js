import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const npmCli=process.env.npm_execpath;

if(!npmCli){
    throw new Error('npm_execpath is required for the package smoke test.');
}

const tempRoot=await mkdtemp(path.join(os.tmpdir(),'node-ipc-package-'));

async function readJson(file){
    return JSON.parse(await readFile(file,'utf8'));
}

function npm(args,cwd=projectRoot){
    return execFileSync(
        process.execPath,
        [npmCli,...args],
        {cwd,encoding:'utf8',stdio:['ignore','pipe','inherit']}
    );
}

try{
    const projectManifest=await readJson(path.join(projectRoot,'package.json'));
    const projectLock=await readJson(path.join(projectRoot,'package-lock.json'));
    const lockedRoot=projectLock.packages?.[''];
    assert.equal(lockedRoot?.version,projectManifest.version);
    assert.deepEqual(lockedRoot?.dependencies,projectManifest.dependencies);
    assert.deepEqual(lockedRoot?.devDependencies,projectManifest.devDependencies);
    assert.deepEqual(lockedRoot?.engines,projectManifest.engines);

    const [packed]=JSON.parse(npm([
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        tempRoot
    ]));
    const files=new Set(packed.files.map(({path:file}) => file.replaceAll('\\','/')));
    const expectedFiles=new Set([
        'MIGRATION.md',
        'README.md',
        'SECURITY.md',
        'dao/client.js',
        'dao/socketServer.js',
        'entities/Defaults.js',
        'entities/EventParser.js',
        'entities/MessageParser.js',
        'entities/TLS.js',
        'licence',
        'node-ipc.js',
        'package.json',
        'services/IPC.js'
    ]);

    assert.deepEqual([...files].sort(),[...expectedFiles].sort());
    assert.ok(files.has('node-ipc.js'));
    assert.ok(!files.has('node-ipc.cjs'));
    assert.ok(![...files].some((file) => file.startsWith('.github/')));
    assert.ok(![...files].some((file) => file.startsWith('assets/')));
    assert.ok(![...files].some((file) => file.startsWith('docs/')));
    assert.ok(![...files].some((file) => file.startsWith('benchmark/results/')));
    assert.ok(![...files].some((file) => file.startsWith('local-node-ipc-certs/')));
    assert.ok(![...files].some((file) => file.startsWith('.codex-')));
    assert.ok(![...files].some((file) => /(?:^|\/)(?:private\/|[^/]+\.(?:key|pem)$)/i.test(file)));
    assert.ok(files.has('entities/EventParser.js'));
    assert.ok(files.has('entities/MessageParser.js'));
    assert.ok(files.has('MIGRATION.md'));

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
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const required=require('node-ipc');
const requiredParsers=require('node-ipc/parsers');
const requiredMessageParser=require('node-ipc/parsers/message');
const EventPubSub=require('event-pubsub');
const IndexEventPubSub=require('event-pubsub/index.js');
const packageRoot=path.dirname(require.resolve('node-ipc'));

assert.equal(typeof required.IPCModule,'function');
assert.equal(typeof required.FastParser,'function');
assert.equal(typeof required.GuardedParser,'function');
assert.strictEqual(required.FastParser,requiredParsers.FastParser);
assert.equal(typeof requiredMessageParser.MessageParser,'function');
assert.ok(required.default instanceof required.IPCModule);
assert.match(require.resolve('node-ipc'),/node-ipc\\.js$/);
assert.strictEqual(EventPubSub,IndexEventPubSub);
assert.strictEqual(EventPubSub.default,EventPubSub);
assert.strictEqual(EventPubSub.EventPubSub,EventPubSub);

const events=new EventPubSub;
const seen=[];
const once=Object.freeze((value) => {
    assert.equal((events.list.work ?? []).includes(once),false);
    seen.push(\`once:\${value}\`);
});
events.on('*',(type,value) => seen.push(\`all:\${type}:\${value}\`));
events.once('work',once).emit('work',1).emit('work',2);
assert.deepEqual(seen,['all:work:1','once:1','all:work:2']);

Promise.all([
    import('node-ipc'),
    import('node-ipc/parsers'),
    import('node-ipc/parsers/message'),
    import('event-pubsub'),
    import('event-pubsub/index.js'),
    import(pathToFileURL(path.join(packageRoot,'dao/client.js')).href),
    import(pathToFileURL(path.join(packageRoot,'entities/Defaults.js')).href)
]).then(([imported,parsers,messageParser,eventPubSub,indexEventPubSub,clientModule,defaultsModule]) => {
    assert.strictEqual(required.default,imported.default);
    assert.strictEqual(required.IPCModule,imported.IPCModule);
    assert.strictEqual(imported.FastParser,parsers.FastParser);
    assert.strictEqual(requiredParsers.FastParser,parsers.FastParser);
    assert.strictEqual(requiredMessageParser.MessageParser,messageParser.MessageParser);
    assert.strictEqual(EventPubSub,eventPubSub.default);
    assert.strictEqual(EventPubSub,eventPubSub.EventPubSub);
    assert.strictEqual(EventPubSub,indexEventPubSub.default);
    assert.strictEqual(EventPubSub,indexEventPubSub.EventPubSub);

    const syncConfig=new defaultsModule.Defaults;
    syncConfig.sync=true;
    const syncClient=new clientModule.Client(syncConfig,() => {});
    const writes=[];
    syncClient.socket={
        writableLength:0,
        write(value){
            writes.push(value);
            return true;
        }
    };
    assert.equal(typeof syncClient.queue.add,'function');
    assert.equal(typeof syncClient.queue.next,'function');
    syncClient.emit('packed.first',1);
    syncClient.emit('packed.second',2);
    assert.equal(writes.length,1);
    assert.equal(syncClient.queue.contents.length,1);
    syncClient.queue.next();
    assert.equal(writes.length,2);
    assert.equal(JSON.parse(writes[1].slice(0,-syncConfig.delimiter.length)).type,'packed.second');
}).catch((err) => {
    console.error(err);
    process.exitCode=1;
});
`
    );

    npm(['install','--ignore-scripts','--no-audit','--no-fund',tarball],consumer);
    const installedRoot=path.join(consumer,'node_modules');
    const nodeIpcManifest=await readJson(path.join(installedRoot,'node-ipc','package.json'));
    const eventPubSubManifest=await readJson(path.join(installedRoot,'event-pubsub','package.json'));
    const jsQueueManifest=await readJson(path.join(installedRoot,'js-queue','package.json'));
    const strongTypeManifest=await readJson(path.join(installedRoot,'strong-type','package.json'));

    assert.equal(nodeIpcManifest.version,'13.0.0');
    assert.equal(nodeIpcManifest.engines?.node,'>=22.13.0');
    assert.deepEqual(nodeIpcManifest.dependencies,{
        'event-pubsub':'6.1.0',
        'js-message':'3.1.0',
        'js-queue':'3.1.0'
    });
    assert.equal(eventPubSubManifest.version,'6.1.0');
    assert.equal(eventPubSubManifest.main,'./index.js');
    assert.equal(eventPubSubManifest.engines?.node,'>=22.12.0');
    assert.equal(Object.hasOwn(eventPubSubManifest,'exports'),false);
    assert.deepEqual(eventPubSubManifest.dependencies,{'strong-type':'2.0.0'});
    assert.equal(jsQueueManifest.version,'3.1.0');
    assert.equal(strongTypeManifest.version,'2.0.0');
    for(const absent of ['copyfiles','vanilla-test','node-http-server']){
        await assert.rejects(readFile(path.join(installedRoot,absent,'package.json'),'utf8'));
    }

    const productionTree=JSON.parse(npm(['ls','--omit=dev','--all','--json'],consumer));
    const allowedPackages=new Set([
        'easy-stack',
        'event-pubsub',
        'js-message',
        'js-queue',
        'strong-type'
    ]);
    const inspectDependencies=(dependencies={}) => {
        for(const [name,dependency] of Object.entries(dependencies)){
            assert.ok(allowedPackages.has(name),`unexpected production dependency: ${name}`);
            inspectDependencies(dependency.dependencies);
        }
    };
    inspectDependencies(productionTree.dependencies?.['node-ipc']?.dependencies);
    const installedNodeIpc=productionTree.dependencies?.['node-ipc'];
    assert.equal(installedNodeIpc?.version,'13.0.0');
    assert.equal(installedNodeIpc?.dependencies?.['event-pubsub']?.version,'6.1.0');
    assert.equal(installedNodeIpc?.dependencies?.['event-pubsub']?.dependencies?.['strong-type']?.version,'2.0.0');
    assert.equal(installedNodeIpc?.dependencies?.['js-message']?.version,'3.1.0');
    assert.equal(installedNodeIpc?.dependencies?.['js-queue']?.version,'3.1.0');
    assert.equal(installedNodeIpc?.dependencies?.['js-queue']?.dependencies?.['easy-stack']?.version,'2.1.0');
    assert.equal(installedNodeIpc?.dependencies?.['strong-type'],undefined);
    execFileSync(process.execPath,['smoke.cjs'],{cwd:consumer,stdio:'inherit'});
    console.log('node-ipc installed package smoke passed');
}finally{
    await rm(tempRoot,{recursive:true,force:true});
}
