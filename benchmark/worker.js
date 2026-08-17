import {monitorEventLoopDelay, performance, PerformanceObserver} from 'node:perf_hooks';
import {getActiveResourcesInfo} from 'node:process';

const config = JSON.parse(process.argv[2]);
const gc = {durationMs: 0, events: 0, exposed: typeof global.gc === 'function', forcedRuns: 0, observed: false};
const settle = () => new Promise(resolve => setImmediate(resolve));
const forceGc = async (runs = 3) => {
    for (let run = 0; global.gc && run < runs; run += 1) {
        global.gc();
        gc.forcedRuns += 1;
        await settle();
    }
};
const memory = () => ({...process.memoryUsage()});
const resources = () => getActiveResourcesInfo().sort();
const resourceDelta = (before, after) => {
    const remaining = [...before];
    return after.filter(resource => {
        const index = remaining.indexOf(resource);
        if (index === -1) {
            return true;
        }
        remaining.splice(index, 1);
        return false;
    });
};
const quantile = (values, fraction) => values[Math.floor((values.length - 1) * fraction)];
const latencySummary = values => {
    if (!values) {
        return null;
    }
    values.sort();
    let total = 0n;
    for (const value of values) {
        total += value;
    }
    return {
        maximum: values.at(-1).toString(),
        mean: (total / BigInt(values.length)).toString(),
        minimum: values[0].toString(),
        p50: quantile(values, 0.50).toString(),
        p95: quantile(values, 0.95).toString(),
        p99: quantile(values, 0.99).toString()
    };
};

try {
    await forceGc();
    const beforeImport = memory();
    const baselineResources = resources();
    const adapter = await import(`./adapters/${config.adapter}.js`);
    await forceGc();
    const afterImport = memory();
    const peak = {...afterImport};
    const sampleMemory = () => {
        const current = memory();
        for (const [name, bytes] of Object.entries(current)) {
            peak[name] = Math.max(peak[name], bytes);
        }
    };
    let cpuStart;
    let cpu;
    let delay;
    let elu;
    let eluStart;
    let observer;
    let resourceStart;
    let resourceEnd;
    let sampler;
    let connected;
    let ready;
    let postRun;
    const observeGc = entries => {
        for (const entry of entries) {
            gc.durationMs += entry.duration;
            gc.events += 1;
        }
    };
    const measured = await adapter.run(config, {
        connected: async () => {
            await forceGc();
            connected = memory();
        },
        beforeMeasure: async () => {
            await forceGc();
            ready = memory();
            cpuStart = process.cpuUsage();
            eluStart = performance.eventLoopUtilization();
            resourceStart = process.resourceUsage();
            if (config.pass === 'resource') {
                gc.observed = true;
                observer = new PerformanceObserver(list => observeGc(list.getEntries()));
                observer.observe({entryTypes: ['gc']});
                delay = monitorEventLoopDelay({resolution: 10});
                delay.enable();
                sampler = setInterval(sampleMemory, 5);
                sampler.unref();
            }
        },
        afterMeasure: async () => {
            cpu = process.cpuUsage(cpuStart);
            elu = performance.eventLoopUtilization(eluStart);
            resourceEnd = process.resourceUsage();
            if (sampler) {
                clearInterval(sampler);
            }
            delay?.disable();
            if (observer) {
                observeGc(observer.takeRecords());
                observer.disconnect();
            }
            postRun = memory();
        }
    });
    sampleMemory();
    const beforeCleanupGc = memory();
    await forceGc();
    await settle();
    const afterCleanupGc = memory();
    const remainingResources = resourceDelta(baselineResources, resources());

    const elapsedSeconds = Number(measured.elapsedNs) / 1e9;
    process.send?.({
        type: 'result',
        result: {
            adapter: adapter.metadata,
            cleanup: {
                ...measured.cleanup,
                activeResourceDelta: remainingResources,
                clean: measured.cleanup.openSockets === 0 && remainingResources.length === 0
            },
            exact: measured.exact,
            gc,
            latencyNs: latencySummary(measured.latencyNs),
            memory: {
                afterCleanupGc,
                afterImport,
                beforeCleanupGc,
                beforeImport,
                connected,
                heapReclaimedBytes: Math.max(0, beforeCleanupGc.heapUsed - afterCleanupGc.heapUsed),
                postRun,
                peak,
                ready
            },
            metrics: {
                bytesPerSecond: measured.exact.receivedBytes / elapsedSeconds,
                cpu,
                elapsedNs: measured.elapsedNs.toString(),
                eventLoopDelayNs: delay ? {
                    maximum: delay.max,
                    p50: delay.percentile(50),
                    p95: delay.percentile(95),
                    p99: delay.percentile(99)
                } : null,
                eventLoopUtilization: elu,
                framesPerSecond: measured.exact.receivedFrames / elapsedSeconds,
                millisecondsPerMillion: Number(measured.elapsedNs) / measured.exact.receivedFrames,
                resourceUsage: {
                    end: resourceEnd,
                    start: resourceStart
                }
            }
        }
    });
    process.disconnect?.();
} catch (error) {
    process.send?.({type: 'error', error: error.stack ?? error.message});
    process.exitCode = 1;
    process.disconnect?.();
}
