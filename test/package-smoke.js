import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
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
    assert.ok(![...files].some((file) => file.startsWith('rust/')));
    assert.ok(![...files].some((file) => file.startsWith('csharp/')));
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
    const installedPackageRoot=path.join(installedRoot,'node-ipc');
    const [
        packedReadme,
        packedMigration,
        packedSecurity,
        packedEntry,
        packedClient,
        packedServer,
        packedDefaults,
        packedMessageParser,
        packedTLS,
        packedIPC
    ]=await Promise.all([
        readFile(path.join(installedPackageRoot,'README.md'),'utf8'),
        readFile(path.join(installedPackageRoot,'MIGRATION.md'),'utf8'),
        readFile(path.join(installedPackageRoot,'SECURITY.md'),'utf8'),
        readFile(path.join(installedPackageRoot,'node-ipc.js'),'utf8'),
        readFile(path.join(installedPackageRoot,'dao','client.js'),'utf8'),
        readFile(path.join(installedPackageRoot,'dao','socketServer.js'),'utf8'),
        readFile(path.join(installedPackageRoot,'entities','Defaults.js'),'utf8'),
        readFile(path.join(installedPackageRoot,'entities','MessageParser.js'),'utf8'),
        readFile(path.join(installedPackageRoot,'entities','TLS.js'),'utf8'),
        readFile(path.join(installedPackageRoot,'services','IPC.js'),'utf8')
    ]);

    assert.equal(nodeIpcManifest.version,'14.0.0');
    assert.match(nodeIpcManifest.description,/Node\.js-only/);
    assert.equal(nodeIpcManifest.type,'module');
    assert.equal(nodeIpcManifest.main,'./node-ipc.js');
    assert.deepEqual(nodeIpcManifest.exports,{
        '.':'./node-ipc.js',
        './parsers':'./entities/EventParser.js',
        './parsers/message':'./entities/MessageParser.js'
    });
    assert.equal(Object.hasOwn(nodeIpcManifest,'browser'),false);
    assert.equal(nodeIpcManifest.engines?.node,'>=22.13.0');
    assert.deepEqual(nodeIpcManifest.dependencies,{
        'event-pubsub':'6.1.1',
        'js-message':'3.1.0',
        'js-queue':'3.1.0'
    });
    assert.equal(eventPubSubManifest.version,'6.1.1');
    assert.equal(eventPubSubManifest.main,'./index.js');
    assert.equal(eventPubSubManifest.engines?.node,'>=22.12.0');
    assert.equal(Object.hasOwn(eventPubSubManifest,'exports'),false);
    assert.deepEqual(eventPubSubManifest.dependencies,{'strong-type':'2.0.0'});
    assert.equal(jsQueueManifest.version,'3.1.0');
    assert.equal(strongTypeManifest.version,'2.0.0');
    for(const document of [packedReadme,packedMigration,packedSecurity]){
        assert.match(document,/Node\.js-only/);
    }
    assert.match(packedReadme,/not supported in browsers,\s+with or without a\s+bundler/i);
    assert.match(packedMigration,/not supported in browsers,\s+with or without a\s+bundler/i);
    assert.match(packedSecurity,/does not run in web\s+browsers,\s+whether bundled or unbundled/i);

    const packedRuntime=[
        packedEntry,
        packedClient,
        packedServer,
        packedDefaults,
        packedMessageParser,
        packedTLS,
        packedIPC
    ].join('\n');
    for(const builtin of [
        'node:dgram',
        'node:fs',
        'node:module',
        'node:net',
        'node:os',
        'node:path',
        'node:tls',
        'node:util'
    ]){
        assert.ok(packedRuntime.includes(`'${builtin}'`),`packed runtime must use ${builtin}`);
    }
    assert.match(packedRuntime,/\bBuffer\./);
    assert.match(packedRuntime,/\bprocess\./);
    assert.match(packedClient,/from 'event-pubsub'/);
    assert.match(packedClient,/require\('js-queue'\)/);
    assert.match(packedServer,/from 'event-pubsub'/);
    assert.match(packedMessageParser,/from 'js-message'/);
    assert.doesNotMatch(
        packedRuntime,
        /(?:\.\.\/|node_modules\/)(?:event-pubsub|js-message|js-queue)(?:\/index\.js)?/
    );
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
    assert.equal(installedNodeIpc?.version,'14.0.0');
    assert.equal(installedNodeIpc?.dependencies?.['event-pubsub']?.version,'6.1.1');
    assert.equal(installedNodeIpc?.dependencies?.['event-pubsub']?.dependencies?.['strong-type']?.version,'2.0.0');
    assert.equal(installedNodeIpc?.dependencies?.['js-message']?.version,'3.1.0');
    assert.equal(installedNodeIpc?.dependencies?.['js-queue']?.version,'3.1.0');
    assert.equal(installedNodeIpc?.dependencies?.['js-queue']?.dependencies?.['easy-stack']?.version,'2.1.0');
    assert.equal(installedNodeIpc?.dependencies?.['strong-type'],undefined);
    execFileSync(process.execPath,['smoke.cjs'],{cwd:consumer,stdio:'inherit'});

    // Given a packed consumer whose incompatible direct dependencies must stay isolated.
    const directConflictConsumer=path.join(tempRoot,'direct-conflicting-consumer');
    const directDependencyNames=['event-pubsub','js-message','js-queue'];
    const directDependencyTrace=path.join(tempRoot,'direct-dependency-resolution.txt');
    const directPoisonDependencies={};
    await mkdir(directConflictConsumer);
    for(const dependencyName of directDependencyNames){
        const poisonDirectoryName=`poisoned-direct-${dependencyName}`;
        const poisonDirectory=path.join(tempRoot,poisonDirectoryName);
        directPoisonDependencies[dependencyName]=`file:../${poisonDirectoryName}`;
        await mkdir(poisonDirectory);
        await writeFile(
            path.join(poisonDirectory,'package.json'),
            `${JSON.stringify({
                name:dependencyName,
                version:'999.0.0',
                type:'module',
                main:'./index.js',
                exports:{'.':'./index.js'}
            },null,2)}\n`
        );
        await writeFile(
            path.join(poisonDirectory,'index.js'),
            [
                "import {appendFileSync} from 'node:fs';",
                `appendFileSync(process.env.NODE_IPC_DIRECT_DEPENDENCY_TRACE,'root:${dependencyName}:'+process.env.NODE_IPC_DIRECT_DEPENDENCY_LOADER+'\\n','utf8');`,
                `throw new Error('poisoned consumer-root ${dependencyName}@999.0.0 executed');`,
                'export default class PoisonedDirectDependency {}',
                ''
            ].join('\n')
        );
    }
    await writeFile(
        path.join(directConflictConsumer,'package.json'),
        `${JSON.stringify({
            private:true,
            dependencies:directPoisonDependencies
        },null,2)}\n`
    );
    await writeFile(
        path.join(directConflictConsumer,'direct-conflict-esm.mjs'),
        `import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const packageEntry=fileURLToPath(import.meta.resolve('node-ipc'));
const packageRoot=path.dirname(packageEntry);
const root=await import('node-ipc');
assert.ok(root.default instanceof root.IPCModule);
const ipc=new root.IPCModule;
ipc.config.silent=true;
ipc.serveNet('127.0.0.1',9763,() => {});
assert.equal(ipc.server.server,false);
assert.deepEqual(ipc.server.sockets,[]);
let published=false;
const handler=(value) => published=value;
ipc.server.on('direct.dependency.probe',handler);
ipc.server.publish('direct.dependency.probe',true);
assert.equal(published,true);
ipc.server.off('direct.dependency.probe',handler);
ipc.server=false;

const {MessageParser}=await import('node-ipc/parsers/message');
const message=new MessageParser().decode('{"type":"direct.message","data":7}');
assert.equal(message.type,'direct.message');
assert.equal(message.data,7);

const [{Client},{Defaults}]=await Promise.all([
    import(pathToFileURL(path.join(packageRoot,'dao/client.js')).href),
    import(pathToFileURL(path.join(packageRoot,'entities/Defaults.js')).href)
]);
const config=new Defaults;
config.silent=true;
config.sync=true;
const client=new Client(config,() => {});
const writes=[];
client.socket={
    writableLength:0,
    write(value){
        writes.push(value);
        return true;
    }
};
client.emit('direct.queue.first',1);
client.emit('direct.queue.second',2);
assert.equal(writes.length,1);
assert.equal(client.queue.contents.length,1);
client.queue.next();
assert.equal(writes.length,2);
assert.equal(JSON.parse(writes[1].slice(0,-config.delimiter.length)).type,'direct.queue.second');
client.queue.next();
assert.equal(client.queue.running,false);
assert.deepEqual(client.queue.clear(),[]);
client.socket=false;
assert.equal(client.retryTimer,false);
`
    );
    await writeFile(
        path.join(directConflictConsumer,'direct-conflict-commonjs.cjs'),
        `const assert=require('node:assert/strict');
const path=require('node:path');
const packageEntry=require.resolve('node-ipc');
const packageRoot=path.dirname(packageEntry);
const root=require('node-ipc');
assert.ok(root.default instanceof root.IPCModule);
const ipc=new root.IPCModule;
ipc.config.silent=true;
ipc.serveNet('127.0.0.1',9763,() => {});
assert.equal(ipc.server.server,false);
assert.deepEqual(ipc.server.sockets,[]);
let published=false;
const handler=(value) => published=value;
ipc.server.on('direct.dependency.probe',handler);
ipc.server.publish('direct.dependency.probe',true);
assert.equal(published,true);
ipc.server.off('direct.dependency.probe',handler);
ipc.server=false;

const {MessageParser}=require('node-ipc/parsers/message');
const message=new MessageParser().decode('{"type":"direct.message","data":7}');
assert.equal(message.type,'direct.message');
assert.equal(message.data,7);

const {Client}=require(path.join(packageRoot,'dao/client.js'));
const {Defaults}=require(path.join(packageRoot,'entities/Defaults.js'));
const config=new Defaults;
config.silent=true;
config.sync=true;
const client=new Client(config,() => {});
const writes=[];
client.socket={
    writableLength:0,
    write(value){
        writes.push(value);
        return true;
    }
};
client.emit('direct.queue.first',1);
client.emit('direct.queue.second',2);
assert.equal(writes.length,1);
assert.equal(client.queue.contents.length,1);
client.queue.next();
assert.equal(writes.length,2);
assert.equal(JSON.parse(writes[1].slice(0,-config.delimiter.length)).type,'direct.queue.second');
client.queue.next();
assert.equal(client.queue.running,false);
assert.deepEqual(client.queue.clear(),[]);
client.socket=false;
assert.equal(client.retryTimer,false);
`
    );

    npm(
        [
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            tarball
        ],
        directConflictConsumer
    );
    const directConflictRoot=path.join(directConflictConsumer,'node_modules');
    const directConflictNodeIpcRoot=path.join(directConflictRoot,'node-ipc');
    const directConflictNodeIpc=await readJson(
        path.join(directConflictNodeIpcRoot,'package.json')
    );
    const directConsumerManifest=await readJson(
        path.join(directConflictConsumer,'package.json')
    );
    assert.equal(
        Object.hasOwn(directConsumerManifest.dependencies,'strong-type'),
        false
    );
    const requireFromDirectNodeIpc=createRequire(
        path.join(directConflictNodeIpcRoot,'package.json')
    );
    for(const dependencyName of directDependencyNames){
        const poisonedRootDependency=await readJson(
            path.join(directConflictRoot,dependencyName,'package.json')
        );
        assert.equal(poisonedRootDependency.version,'999.0.0');

        const nestedDependencyRoot=path.join(
            directConflictNodeIpcRoot,
            'node_modules',
            dependencyName
        );
        const nestedDependency=await readJson(
            path.join(nestedDependencyRoot,'package.json')
        );
        assert.equal(
            nestedDependency.version,
            directConflictNodeIpc.dependencies?.[dependencyName]
        );
        assert.notEqual(
            nestedDependency.version,
            poisonedRootDependency.version
        );

        const nestedEntry=await realpath(
            requireFromDirectNodeIpc.resolve(dependencyName)
        );
        const resolvedNestedDependencyRoot=await realpath(nestedDependencyRoot);
        const relativeEntry=path.relative(
            resolvedNestedDependencyRoot,
            nestedEntry
        );
        assert.ok(
            relativeEntry &&
            !relativeEntry.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relativeEntry),
            `${dependencyName} must resolve inside node-ipc's nested dependency`
        );
        const nestedSource=await readFile(nestedEntry,'utf8');
        const instrumentation=[
            "import {appendFileSync as nodeIpcAppendDirectDependencyTrace} from 'node:fs';",
            `nodeIpcAppendDirectDependencyTrace(process.env.NODE_IPC_DIRECT_DEPENDENCY_TRACE,'nested:${dependencyName}:'+process.env.NODE_IPC_DIRECT_DEPENDENCY_LOADER+'\\n','utf8');`,
            ''
        ].join('\n');
        await writeFile(nestedEntry,instrumentation+nestedSource);
    }

    // When both supported Node module systems exercise all three dependency paths.
    const directLoadFailures=[];
    for(const [loader,script] of [
        ['esm','direct-conflict-esm.mjs'],
        ['commonjs','direct-conflict-commonjs.cjs']
    ]){
        try{
            execFileSync(
                process.execPath,
                [script],
                {
                    cwd:directConflictConsumer,
                    env:{
                        ...process.env,
                        NODE_IPC_DIRECT_DEPENDENCY_LOADER:loader,
                        NODE_IPC_DIRECT_DEPENDENCY_TRACE:directDependencyTrace
                    },
                    stdio:'inherit'
                }
            );
        }catch(error){
            directLoadFailures.push(`${loader}: exit ${error.status ?? 'unknown'}`);
        }
    }
    assert.deepEqual(
        directLoadFailures,
        [],
        'node-ipc must resolve each direct dependency from its own package boundary'
    );
    const directTrace=(await readFile(directDependencyTrace,'utf8'))
        .trim()
        .split(/\r?\n/);
    assert.deepEqual(directTrace,[
        'nested:event-pubsub:esm',
        'nested:js-message:esm',
        'nested:js-queue:esm',
        'nested:event-pubsub:commonjs',
        'nested:js-message:commonjs',
        'nested:js-queue:commonjs'
    ]);
    assert.equal(directTrace.some((entry) => entry.startsWith('root:')),false);
    console.log('node-ipc direct dependency conflict resolution smoke passed');

    // Given a packed consumer whose incompatible root dependency must never win.
    const conflictConsumer=path.join(tempRoot,'conflicting-consumer');
    const poisonedStrongType=path.join(tempRoot,'poisoned-strong-type');
    const resolutionTrace=path.join(tempRoot,'strong-type-resolution.txt');
    await mkdir(conflictConsumer);
    await mkdir(poisonedStrongType);
    await writeFile(
        path.join(poisonedStrongType,'package.json'),
        `${JSON.stringify({
            name:'strong-type',
            version:'999.0.0',
            type:'module',
            main:'./index.js',
            exports:{
                '.':'./index.js',
                './index.js':'./index.js'
            }
        },null,2)}\n`
    );
    await writeFile(
        path.join(poisonedStrongType,'index.js'),
        [
            "import {appendFileSync} from 'node:fs';",
            "appendFileSync(process.env.NODE_IPC_STRONG_TYPE_TRACE,'root:'+process.env.NODE_IPC_STRONG_TYPE_LOADER+'\\n','utf8');",
            "throw new Error('poisoned consumer-root strong-type@999.0.0 executed');",
            'export default class PoisonedStrongType {}',
            ''
        ].join('\n')
    );
    await writeFile(
        path.join(conflictConsumer,'package.json'),
        `${JSON.stringify({
            private:true,
            dependencies:{
                'strong-type':'file:../poisoned-strong-type'
            }
        },null,2)}\n`
    );
    await writeFile(
        path.join(conflictConsumer,'conflict-esm.mjs'),
        `import assert from 'node:assert/strict';
import ipc,{IPCModule} from 'node-ipc';

assert.ok(ipc instanceof IPCModule);
const isolated=new IPCModule;
assert.equal(typeof isolated.connectToNet,'function');
`
    );
    await writeFile(
        path.join(conflictConsumer,'conflict-commonjs.cjs'),
        `const assert=require('node:assert/strict');
const required=require('node-ipc');

assert.ok(required.default instanceof required.IPCModule);
const isolated=new required.IPCModule;
assert.equal(typeof isolated.connectToNet,'function');
`
    );

    npm(['install','--ignore-scripts','--no-audit','--no-fund',tarball],conflictConsumer);
    const conflictRoot=path.join(conflictConsumer,'node_modules');
    const conflictNodeIpcRoot=path.join(conflictRoot,'node-ipc');
    const conflictRootStrongType=await readJson(path.join(conflictRoot,'strong-type','package.json'));
    assert.equal(conflictRootStrongType.version,'999.0.0');

    const requireFromNodeIpc=createRequire(path.join(conflictNodeIpcRoot,'package.json'));
    const conflictEventPubSubRoot=path.dirname(requireFromNodeIpc.resolve('event-pubsub'));
    const conflictEventPubSub=await readJson(
        path.join(conflictEventPubSubRoot,'package.json')
    );
    const nestedStrongTypeRoot=path.join(
        conflictEventPubSubRoot,
        'node_modules',
        'strong-type'
    );
    const nestedStrongType=await readJson(path.join(nestedStrongTypeRoot,'package.json'));
    assert.equal(
        nestedStrongType.version,
        conflictEventPubSub.dependencies?.['strong-type']
    );
    assert.notEqual(nestedStrongType.version,conflictRootStrongType.version);

    const nestedStrongTypeEntry=path.join(
        nestedStrongTypeRoot,
        nestedStrongType.main || 'index.js'
    );
    const nestedStrongTypeSource=await readFile(nestedStrongTypeEntry,'utf8');
    const nestedInstrumentation=[
        "import {appendFileSync as nodeIpcAppendResolutionTrace} from 'node:fs';",
        "nodeIpcAppendResolutionTrace(process.env.NODE_IPC_STRONG_TYPE_TRACE,'nested:'+process.env.NODE_IPC_STRONG_TYPE_LOADER+'\\n','utf8');",
        ''
    ].join('\n');
    await writeFile(
        nestedStrongTypeEntry,
        nestedInstrumentation+nestedStrongTypeSource
    );

    // When both supported Node module systems load the public package entry.
    const loadFailures=[];
    for(const [loader,script] of [
        ['esm','conflict-esm.mjs'],
        ['commonjs','conflict-commonjs.cjs']
    ]){
        try{
            execFileSync(
                process.execPath,
                [script],
                {
                    cwd:conflictConsumer,
                    env:{
                        ...process.env,
                        NODE_IPC_STRONG_TYPE_LOADER:loader,
                        NODE_IPC_STRONG_TYPE_TRACE:resolutionTrace
                    },
                    stdio:'inherit'
                }
            );
        }catch(error){
            loadFailures.push(`${loader}: exit ${error.status ?? 'unknown'}`);
        }
    }
    // Then event-pubsub must execute its own declared nested strong-type copy.
    assert.deepEqual(
        loadFailures,
        [],
        'node-ipc must never execute an incompatible consumer-root strong-type'
    );
    assert.deepEqual(
        (await readFile(resolutionTrace,'utf8')).trim().split(/\r?\n/),
        ['nested:esm','nested:commonjs']
    );
    console.log('node-ipc conflicting-root dependency resolution smoke passed');

    console.log('node-ipc installed package smoke passed');
}finally{
    await rm(tempRoot,{recursive:true,force:true});
}
