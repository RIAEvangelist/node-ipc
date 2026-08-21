import {execFileSync, fork, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {lstat, mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageFootprint} from './footprint.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const value = (name, fallback) => {
    const prefix = `--${name}=`;
    return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const integer = (name, fallback) => {
    const parsed = Number(value(name, fallback));
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
};
const quick = process.argv.includes('--quick');
const footprint = process.argv.includes('--footprint')
    || (!quick && !process.argv.includes('--no-footprint'));
const adapters = value('adapters', 'node-net').split(',');
const commonFrames = value('messages', null) === null ? null : integer('messages', 1);
const config = {
    adapters: [...new Set(['node-net', ...adapters])],
    host: value('host', '127.0.0.1'),
    oracle: value('oracle', quick ? 'node' : 'c'),
    passes: value('passes', 'speed,resource,latency').split(','),
    payloadBytes: integer('size', 64),
    quick,
    samplesPerPass: integer('samples', quick ? 1 : 7),
    timeoutMs: integer('timeout', quick ? 15000 : 600000),
    warmupFrames: integer('warmup', quick ? 64 : 100000),
    frames: {
        latency: commonFrames ?? integer('latency-messages', quick ? 128 : 1000000),
        resource: commonFrames ?? integer('resource-messages', quick ? 4096 : 1000000),
        speed: commonFrames ?? integer('speed-messages', quick ? 4096 : 1000000)
    },
    footprint
};

if (config.adapters.some(adapter => adapter !== 'node-net')) {
    throw new Error('available adapters: node-net');
}
if (config.passes.some(pass => !['latency', 'resource', 'speed'].includes(pass))) {
    throw new Error('available passes: speed, resource, latency');
}
if (!['c', 'node'].includes(config.oracle)) {
    throw new Error('available oracles: node, c');
}

const repositoryAtStart = (() => {
    try {
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: directory, encoding: 'utf8'}).trim();
        const dirty = execFileSync(
            'git',
            ['status', '--porcelain', '--untracked-files=all'],
            {cwd: directory, encoding: 'utf8'}
        ).trim().length > 0;
        return {capturedAt: new Date().toISOString(), commit, dirty};
    } catch {
        return {capturedAt: new Date().toISOString(), commit: null, dirty: null};
    }
})();

const deadline = (promise, timeoutMs, label) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            timer.unref();
        })
    ]).finally(() => clearTimeout(timer));
};
const childMessage = (child, type, timeoutMs) => deadline(new Promise((resolve, reject) => {
    const message = value => {
        if (value.type === 'error') {
            clean();
            reject(new Error(value.error));
        } else if (value.type === type) {
            clean();
            resolve(value);
        }
    };
    const exit = (code, signal) => {
        clean();
        reject(new Error(`child exited before ${type}: code=${code} signal=${signal}`));
    };
    const clean = () => {
        child.off('message', message);
        child.off('exit', exit);
    };
    child.on('message', message);
    child.once('exit', exit);
}), timeoutMs, type);
const childExit = (child, timeoutMs) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode])
    : deadline(once(child, 'exit'), timeoutMs, 'child exit');
const terminate = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.kill('SIGTERM');
    try {
        await childExit(child, 1000);
    } catch {
        child.kill('SIGKILL');
        await childExit(child, 1000).catch(() => {});
    }
};
const trialEnvironment = directory => ({
    ...process.env,
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory
});
const inventory = async directory => {
    const result = {bytes: 0, entries: 0};
    const visit = async current => {
        for (const entry of await readdir(current, {withFileTypes: true})) {
            const target = path.join(current, entry.name);
            result.entries += 1;
            if (entry.isDirectory()) {
                await visit(target);
            } else {
                result.bytes += (await lstat(target)).size;
            }
        }
    };
    await visit(directory);
    return result;
};

const lineMessages = child => {
    const listeners = new Set();
    const messages = [];
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buffered += chunk;
        let end;
        while ((end = buffered.indexOf('\n')) !== -1) {
            const line = buffered.slice(0, end).trim();
            buffered = buffered.slice(end + 1);
            if (line) {
                const message = JSON.parse(line);
                messages.push(message);
                for (const listener of listeners) {
                    listener(message);
                }
            }
        }
    });
    return type => deadline(new Promise((resolve, reject) => {
        const existing = messages.find(message => message.type === type);
        if (existing) {
            resolve(existing);
            return;
        }
        const receive = message => {
            if (message.type === type) {
                listeners.delete(receive);
                resolve(message);
            }
        };
        listeners.add(receive);
        child.once('error', reject);
    }), config.timeoutMs, `C oracle ${type}`);
};

const startOracle = async trialDirectory => {
    const started = process.hrtime.bigint();
    if (config.oracle === 'node') {
        const child = fork(path.join(directory, 'service.js'), [config.host, '0'], {
            cwd: trialDirectory,
            env: trialEnvironment(trialDirectory),
            silent: true
        });
        let ready;
        try {
            ready = await childMessage(child, 'ready', config.timeoutMs);
        } catch (error) {
            await terminate(child);
            throw error;
        }
        return {
            child,
            endpoint: ready.endpoint,
            pid: ready.pid,
            startMemory: ready.memory,
            stop: async () => {
                const measured = childMessage(child, 'measure', config.timeoutMs);
                child.send('measure');
                const end = await measured;
                const cleanup = childMessage(child, 'cleanup', config.timeoutMs);
                child.send('close');
                const closed = await cleanup;
                const [exitCode, signal] = await childExit(child, config.timeoutMs);
                return {
                    cleanup: closed.stats,
                    endMemory: end.memory,
                    exitCode,
                    signal,
                    wallNs: (process.hrtime.bigint() - started).toString()
                };
            }
        };
    }

    const binary = path.join(directory, 'oracle', 'bin', process.platform === 'win32' ? 'raw-echo.exe' : 'raw-echo');
    const child = spawn(binary, ['--host', config.host, '--port', '0'], {
        cwd: trialDirectory,
        env: trialEnvironment(trialDirectory),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const message = lineMessages(child);
    let ready;
    try {
        ready = await message('ready');
    } catch (error) {
        await terminate(child);
        throw error;
    }
    return {
        child,
        endpoint: {host: ready.host, port: ready.port},
        pid: ready.pid,
        startMemory: null,
        stop: async () => {
            const cleanup = await message('cleanup');
            const [exitCode, signal] = await childExit(child, config.timeoutMs);
            return {
                cleanup,
                endMemory: null,
                exitCode,
                signal,
                wallNs: (process.hrtime.bigint() - started).toString()
            };
        }
    };
};

const runWorker = async (sample, trialDirectory) => {
    const child = fork(path.join(directory, 'worker.js'), [JSON.stringify(sample)], {
        cwd: trialDirectory,
        env: trialEnvironment(trialDirectory),
        execArgv: ['--expose-gc'],
        silent: true
    });
    const pid = child.pid;
    try {
        const result = await childMessage(child, 'result', config.timeoutMs);
        const [exitCode, signal] = await childExit(child, config.timeoutMs);
        return {exitCode, pid, result: result.result, signal};
    } catch (error) {
        await terminate(child);
        throw error;
    }
};

const endpointClosed = endpoint => new Promise(resolve => {
    const socket = net.createConnection(endpoint);
    const finish = closed => {
        socket.destroy();
        resolve(closed);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
});
const endpointReusable = endpoint => new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(endpoint, () => server.close(() => resolve(true)));
});

const samples = [];
for (const pass of config.passes) {
    for (let sampleIndex = 0; sampleIndex < config.samplesPerPass; sampleIndex += 1) {
        const adapterOrder = sampleIndex % 2 ? [...config.adapters].reverse() : config.adapters;
        for (const adapter of adapterOrder) {
            const trialDirectory = await mkdtemp(path.join(os.tmpdir(), 'node-ipc-benchmark-'));
            let oracle;
            let worker;
            let oracleEnd;
            let closed = false;
            let reusable = false;
            let leftovers;
            try {
                oracle = await startOracle(trialDirectory);
                worker = await runWorker({
                    adapter,
                    endpoint: oracle.endpoint,
                    frames: config.frames[pass],
                    pass,
                    payloadBytes: config.payloadBytes,
                    warmupFrames: config.warmupFrames
                }, trialDirectory);
                oracleEnd = await oracle.stop();
                closed = await endpointClosed(oracle.endpoint);
                reusable = await endpointReusable(oracle.endpoint);
            } catch (error) {
                await terminate(oracle?.child);
                throw error;
            } finally {
                leftovers = await inventory(trialDirectory);
                await rm(trialDirectory, {force: true, recursive: true});
            }
            const naturalExit = worker.exitCode === 0 && !worker.signal
                && oracleEnd.exitCode === 0 && !oracleEnd.signal;
            const oracleCpuMicroseconds = oracleEnd.cleanup.cpuUsage
                ? oracleEnd.cleanup.cpuUsage.user + oracleEnd.cleanup.cpuUsage.system
                : oracleEnd.cleanup.cpuSeconds >= 0 ? oracleEnd.cleanup.cpuSeconds * 1e6 : null;
            const oracleCpuToWall = oracleCpuMicroseconds === null
                ? null
                : oracleCpuMicroseconds / (Number(oracleEnd.wallNs) / 1000);
            samples.push({
                adapter,
                cleanup: {
                    clean: closed && reusable && naturalExit && worker.result.cleanup.clean
                        && (oracleEnd.cleanup.activeSocketsAfterClose ?? 0) === 0
                        && leftovers.entries === 0,
                    endpointClosed: closed,
                    endpointReusable: reusable,
                    leftovers,
                    naturalExit,
                    oracle: oracleEnd.cleanup,
                    worker: worker.result.cleanup
                },
                endpoint: oracle.endpoint,
                gc: worker.result.gc,
                index: sampleIndex,
                memory: {oracle: {end: oracleEnd.endMemory, start: oracle.startMemory}, worker: worker.result.memory},
                metrics: {
                    ...worker.result.metrics,
                    oracle: {
                        cpuToWallRatio: oracleCpuToWall,
                        saturated: oracleCpuToWall === null ? null : oracleCpuToWall >= 0.9,
                        wallNs: oracleEnd.wallNs
                    }
                },
                exact: {
                    ...worker.result.exact,
                    oracleBytes: oracleEnd.cleanup.bytesIn,
                    oracleByteCountVerified: oracleEnd.cleanup.bytesIn
                        === (config.frames[pass] + config.warmupFrames) * config.payloadBytes
                },
                latencyNs: worker.result.latencyNs,
                package: worker.result.adapter.package,
                pass,
                pids: {oracle: oracle.pid, runner: process.pid, worker: worker.pid},
                processExit: {
                    oracle: {code: oracleEnd.exitCode, signal: oracleEnd.signal},
                    worker: {code: worker.exitCode, signal: worker.signal}
                },
                trialDirectory
            });
        }
    }
}

const baselines = new Map(samples
    .filter(sample => sample.adapter === 'node-net')
    .map(sample => [`${sample.pass}:${sample.index}`, sample.metrics.millisecondsPerMillion]));
for (const sample of samples) {
    const baseline = baselines.get(`${sample.pass}:${sample.index}`);
    sample.metrics.baselineMillisecondsPerMillion = baseline;
    sample.metrics.deltaMillisecondsPerMillion = sample.metrics.millisecondsPerMillion - baseline;
}

const repository = repositoryAtStart;
const total = (select) => samples.reduce((sum, sample) => sum + select(sample), 0);
const oracle = config.oracle === 'c'
    ? {
        build: JSON.parse(await readFile(path.join(directory, 'oracle', 'bin', 'build.json'), 'utf8')),
        implementation: 'standard-c',
        sourceSha256: await sha256(path.join(directory, 'oracle', 'echo.c'))
    }
    : {
        build: null,
        implementation: 'node-net',
        sourceSha256: await sha256(path.join(directory, 'service.js'))
    };
const cleanup = {
    clean: samples.every(sample => sample.cleanup.clean),
    endpointLeaks: samples.filter(sample => !sample.cleanup.endpointClosed).length,
    endpointReuseFailures: samples.filter(sample => !sample.cleanup.endpointReusable).length,
    leftoverBytes: total(sample => sample.cleanup.leftovers.bytes),
    leftoverEntries: total(sample => sample.cleanup.leftovers.entries),
    openSockets: total(sample => sample.cleanup.worker.openSockets + (sample.cleanup.oracle.activeSocketsAfterClose ?? 0)),
    samples: samples.length
};
const packageFootprintResult = footprint
    ? await packageFootprint(path.resolve(directory, '..'))
    : null;
const machineIdentity = createHash('sha256')
    .update(`${os.hostname()}\0${os.cpus()[0]?.model ?? 'unknown'}\0${os.totalmem()}`)
    .digest('hex')
    .slice(0,16);
const publishable = repository.dirty === false
    && oracle.implementation === 'standard-c'
    && !config.quick
    && cleanup.clean
    && packageFootprintResult !== null;
const hasComparableNodeIpcAdapter = config.adapters.some(adapter => adapter !== 'node-net');
const evidence = {
    classification: publishable ? 'clean-c-oracle' : 'development-smoke',
    packageFootprintStatus: packageFootprintResult ? 'measured' : 'omitted-smoke',
    publishable,
    rankingEligible: publishable && hasComparableNodeIpcAdapter && config.adapters.length > 1,
    reasons: [
        ...(repository.dirty ? ['dirty-tree'] : []),
        ...(oracle.implementation !== 'standard-c' ? ['non-c-oracle'] : []),
        ...(config.quick ? ['quick-configuration'] : []),
        ...(!cleanup.clean ? ['cleanup-failed'] : []),
        ...(packageFootprintResult === null ? ['package-footprint-not-measured'] : []),
        ...(!hasComparableNodeIpcAdapter ? ['no-comparable-node-ipc-adapter'] : [])
    ]
};
const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    system: {
        architecture: process.arch,
        cpu: {count: os.availableParallelism(), model: os.cpus()[0]?.model ?? null},
        environment: {
            githubRepository: process.env.GITHUB_REPOSITORY ?? null,
            imageOS: process.env.ImageOS ?? null,
            imageVersion: process.env.ImageVersion ?? null,
            nodeLane: process.env.NODE_IPC_BENCHMARK_NODE_LANE ?? null,
            npm: process.env.npm_config_user_agent?.split(' ')[0] ?? null,
            osLane: process.env.NODE_IPC_BENCHMARK_OS_LANE ?? null,
            provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
            runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
            runId: process.env.GITHUB_RUN_ID ?? null,
            runnerArchitecture: process.env.RUNNER_ARCH ?? null,
            runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
            sourceRef: process.env.GITHUB_REF ?? null,
            sourceSha: process.env.GITHUB_SHA ?? null,
            workflow: process.env.GITHUB_WORKFLOW ?? null,
            workflowRef: process.env.GITHUB_WORKFLOW_REF ?? null,
            workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? null
        },
        machine: {id: machineIdentity},
        node: process.version,
        platform: process.platform,
        release: os.release(),
        totalMemoryBytes: os.totalmem()
    },
    repository,
    oracle,
    evidence,
    config,
    pids: {runner: process.pid, samples: samples.map(sample => sample.pids)},
    endpoints: samples.map(sample => sample.endpoint),
    samples,
    memory: {
        maximumWorkerRssBytes: Math.max(...samples.map(sample => sample.memory.worker.peak.rss)),
        packageInstalledBytes: Object.fromEntries(samples.map(sample => [sample.adapter, sample.package.installedBytes]))
    },
    gc: {
        durationMs: total(sample => sample.gc.durationMs),
        events: total(sample => sample.gc.events),
        forcedRuns: total(sample => sample.gc.forcedRuns)
    },
    cleanup,
    packageFootprint: packageFootprintResult
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
