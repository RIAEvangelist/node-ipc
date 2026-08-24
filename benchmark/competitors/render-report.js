import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {cycleLength} from './plan.js';
import {validateResult} from './validate.js';

const reportTimeZone='America/Chicago';
const integer=value => Math.round(value).toLocaleString('en-US');
const decimal=(value,digits=1) => Number(value).toFixed(digits);
const finite=value => Number.isFinite(value);
const payloadLabel=bytes => bytes >= 1024 && bytes%1024 === 0
    ? `${bytes/1024} KiB`
    : `${bytes} B`;
const byteLimitLabel=bytes => bytes >= 1024*1024 && bytes%(1024*1024) === 0
    ? `${bytes/(1024*1024)} MiB`
    : payloadLabel(bytes);
const orderedUnique=values => [...new Set(values)];
const markdown=value => String(value ?? '').replaceAll('|','\\|').replaceAll('\n',' ');
const formatList=values => values.length < 2
    ? values[0] ?? ''
    : values.length === 2
        ? values.join(' and ')
        : `${values.slice(0,-1).join(', ')}, and ${values.at(-1)}`;

function legacyDimensions(result){
    const transports={
        'process-ipc':{
            family:'process-channel',id:'process-ipc',implementation:'node-child-process-channel',
            label:'Dedicated parent-child IPC',scope:'parent-child',
            securityMode:'platform process IPC; no benchmark-layer encryption'
        },
        tcp:{
            family:'byte-stream',id:'tcp',implementation:'tcp4-loopback',label:'TCP loopback',
            scope:'loopback',securityMode:'none'
        }
    };
    const lanes={};
    for(const moduleId of result.config?.subjects ?? []){
        const sample=(result.samples ?? []).find(row => row.subjectId === moduleId);
        const transportId=moduleId === 'native-child-process' ? 'process-ipc' : 'tcp';
        const complexity=result.complexity?.[moduleId];
        lanes[moduleId]={
            cohortId:transportId,
            id:moduleId,
            label:result.catalog?.subjects?.[moduleId]?.label ?? moduleId,
            moduleId,
            protocolStack:[sample?.subject?.transport ?? transports[transportId].label],
            securityMode:transports[transportId].securityMode,
            serialization:sample?.subject?.serialization ?? 'recorded public API serialization',
            sourceFiles:complexity?.source ? [complexity.source] : [],
            topology:sample?.subject?.topology ?? transports[transportId].scope,
            transportId
        };
    }
    return {lanes,transports};
}

function normalizeResult(result){
    const schemaVersion=result.schemaVersion;
    const dimensions=schemaVersion === 2
        ? {lanes:result.dimensions?.lanes ?? result.dimensions?.cases,transports:result.dimensions?.transports}
        : legacyDimensions(result);
    const laneIds=schemaVersion === 2 ? result.config.laneIds : result.config.subjects;
    const moduleIds=schemaVersion === 2 ? result.config.moduleIds : result.config.subjects;
    const transportIds=schemaVersion === 2
        ? result.config.transportIds
        : orderedUnique(laneIds.map(laneId => dimensions.lanes[laneId].transportId));
    const summaryRows=(result.summary ?? []).map(row => schemaVersion === 2 ? row : ({
        ...row,
        cohortId:dimensions.lanes[row.subject].cohortId,
        laneId:row.subject,
        moduleId:row.subject,
        transportId:dimensions.lanes[row.subject].transportId
    }));
    return {
        dimensions,
        laneIds,
        moduleIds,
        result,
        schemaVersion,
        summaryRows,
        transportIds
    };
}

function localTimestamp(value){
    const date=new Date(value);
    const formatted=new Intl.DateTimeFormat('en-US',{
        day:'numeric',hour:'numeric',minute:'2-digit',month:'long',
        timeZone:reportTimeZone,year:'numeric'
    }).format(date);
    const abbreviation=new Intl.DateTimeFormat('en-US',{
        timeZone:reportTimeZone,timeZoneName:'short'
    }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? 'local time';
    return `${formatted} (${reportTimeZone}; ${abbreviation})`;
}

function summaryFor(view,laneId,payloadBytes,workload){
    return view.summaryRows.find(row => row.laneId === laneId
        && row.payloadBytes === payloadBytes
        && row.workload === workload);
}

function cohortIds(view){
    return orderedUnique(view.laneIds.map(laneId => view.dimensions.lanes[laneId].cohortId));
}

function cohortLanes(view,cohortId){
    return view.laneIds.filter(laneId => view.dimensions.lanes[laneId].cohortId === cohortId);
}

function performanceTable(view,cohortId,workload){
    const payloads=view.result.config?.payloads ?? [];
    const lanes=cohortLanes(view,cohortId);
    const metric=row => workload === 'throughput'
        ? row?.roundTripsPerSecond?.median
        : row?.latencyNs?.p50?.median;
    if(payloads.length === 0 || !lanes.some(laneId => payloads.some(payload => finite(metric(
        summaryFor(view,laneId,payload,workload)
    ))))){
        return null;
    }
    const transport=view.dimensions.transports[view.dimensions.lanes[lanes[0]].transportId];
    const title=workload === 'throughput' ? 'Throughput (round trips/s)' : 'Latency (p50 RTT, µs)';
    const lines=[
        `### ${markdown(transport?.label ?? cohortId)} cohort — ${title}`,
        '',
        `| Transport lane | Module | Protocol stack | ${payloads.map(payloadLabel).join(' | ')} |`,
        `| --- | --- | --- | ${payloads.map(() => '---:').join(' | ')} |`
    ];
    for(const laneId of lanes){
        const lane=view.dimensions.lanes[laneId];
        const moduleLabel=view.result.catalog?.subjects?.[lane.moduleId]?.label ?? lane.moduleId;
        const values=payloads.map(payloadBytes => {
            const value=metric(summaryFor(view,laneId,payloadBytes,workload));
            if(!finite(value)){
                return '—';
            }
            return workload === 'throughput' ? integer(value) : decimal(value/1000);
        });
        lines.push(`| ${markdown(lane.label)} | ${markdown(moduleLabel)} | ${markdown(lane.protocolStack.join(' → '))} | ${values.join(' | ')} |`);
    }
    const sampleCounts=orderedUnique(lanes.flatMap(laneId => payloads.map(payloadBytes =>
        summaryFor(view,laneId,payloadBytes,workload)?.samples
    )).filter(count => Number.isSafeInteger(count) && count > 0));
    const sampleText=sampleCounts.length === 1
        ? `${sampleCounts[0]} successful fresh-process sample${sampleCounts[0] === 1 ? '' : 's'} per available cell`
        : 'the successful fresh-process counts stored for each cell';
    lines.push('',`Values are medians across ${sampleText}; — means no successful measurement was recorded.`);
    if(lanes.length === 1 && view.dimensions.lanes[lanes[0]].transportId === 'process-ipc'){
        lines.push('',
            'This one-lane process IPC cohort is a descriptive baseline only. It has no same-transport comparator, so no ordinal result is calculated.'
        );
    }
    return lines;
}

function capabilityGroups(result,moduleId){
    const groups={manual:[],supported:[],unsupported:[]};
    for(const definition of result.capabilities?.definitions ?? []){
        const status=result.capabilities?.matrix?.[moduleId]?.[definition.id]?.status;
        if(!status){
            continue;
        }
        if(['built-in','protocol-compatible','supported'].includes(status)){
            groups.supported.push(definition.label);
        }else if(['unsupported','unsupported-default','unverified'].includes(status)){
            groups.unsupported.push(definition.label);
        }else{
            groups.manual.push(`${definition.label} (${status})`);
        }
    }
    return groups;
}

function dependencySection(view){
    const rows=view.moduleIds.filter(moduleId => view.result.dependencyExposure?.[moduleId]);
    if(!rows.length){
        return [];
    }
    return [
        '## Dependency exposure is counted once per module',
        '',
        '| Module | Direct dependency name count | Direct edges | Unique resolved production dependencies | Exposure tier | Install-script packages |',
        '| --- | ---: | ---: | ---: | --- | --- |',
        ...rows.map(moduleId => {
            const exposure=view.result.dependencyExposure[moduleId];
            const label=view.result.catalog?.subjects?.[moduleId]?.label ?? moduleId;
            return `| ${markdown(label)} | ${exposure.directUniqueDependencies} | ${exposure.directDependencyEdges} | ${exposure.uniqueResolvedDependencies} | ${markdown(exposure.riskTier)} | ${markdown(exposure.packagesWithInstallScripts?.join(', ') || 'none')} |`;
        }),
        '',
        'A module with several measured transports appears once: its pinned production dependency closure is not multiplied by lane count. The tier uses only unique resolved production dependency count (0 minimal, 1–5 low, 6–15 moderate, 16+ high). This is a dependency-count supply-chain proxy, not a vulnerability, provenance, maintainer, or code-quality assessment. Native Node has zero external npm dependencies, not zero total supply-chain risk.',
        ''
    ];
}

function complexitySection(view){
    const rows=view.laneIds.map(laneId => {
        const lane=view.dimensions.lanes[laneId];
        return {complexity:view.result.complexity?.[laneId] ?? view.result.complexity?.[lane.moduleId],lane,laneId};
    }).filter(row => row.complexity);
    if(!rows.length){
        return [];
    }
    return [
        '## Implementation-glue complexity is lane-aware',
        '',
        '| Transport lane | Module | Adapter SLOC | Files | Bytes | Source |',
        '| --- | --- | ---: | ---: | ---: | --- |',
        ...rows.map(({complexity,lane}) => {
            const label=view.result.catalog?.subjects?.[lane.moduleId]?.label ?? lane.moduleId;
            return `| ${markdown(lane.label)} | ${markdown(label)} | ${complexity.sourceLines} | ${complexity.implementationFiles} | ${complexity.implementationBytes} | ${markdown(complexity.source ?? lane.sourceFiles.join(', '))} |`;
        }),
        '',
        'SLOC counts nonblank, noncomment subject-specific benchmark adapter code. Shared harness code is excluded. When one adapter implements several lanes, the recorded module-level value is shown for each lane; it is an auditable glue proxy, not intrinsic API difficulty.',
        ''
    ];
}

function capabilitySection(view){
    if(!(view.result.capabilities?.definitions?.length)){
        return [];
    }
    return [
        '## Capability support is evaluated before performance',
        '',
        '| Module | Built in or supported | Manual, separate, or limited | Unsupported or unverified |',
        '| --- | --- | --- | --- |',
        ...view.moduleIds.map(moduleId => {
            const groups=capabilityGroups(view.result,moduleId);
            const label=view.result.catalog?.subjects?.[moduleId]?.label ?? moduleId;
            return `| ${markdown(label)} | ${markdown(groups.supported.join('; ') || '—')} | ${markdown(groups.manual.join('; ') || '—')} | ${markdown(groups.unsupported.join('; ') || '—')} |`;
        }),
        '',
        'Capability cells are version-specific and source-linked in the raw result. “Manual” means the transport can carry an application implementation; it does not mean the module supplies that feature.',
        ''
    ];
}

function transportCoverageSection(view){
    const definitions=view.result.capabilities?.transportDefinitions;
    const matrix=view.result.capabilities?.transportMatrix;
    if(!definitions || !matrix || !Object.keys(definitions).length){
        return [];
    }
    const ids=Object.keys(definitions);
    return [
        '## Transport support and measurement scope',
        '',
        `| Module | ${ids.map(id => markdown(definitions[id].label)).join(' | ')} |`,
        `| --- | ${ids.map(() => '---').join(' | ')} |`,
        ...view.moduleIds.map(moduleId => {
            const label=view.result.catalog?.subjects?.[moduleId]?.label ?? moduleId;
            const cells=ids.map(transportId => {
                const cell=matrix[moduleId]?.[transportId];
                return cell ? `${markdown(cell.status)} — ${markdown(cell.note)}` : '—';
            });
            return `| ${markdown(label)} | ${cells.join(' | ')} |`;
        }),
        '',
        '“Measured” identifies an executable lane in this result schema. Supported-but-unmeasured, unsupported, and not-implemented cells describe suite scope and are not failed trials.',
        ''
    ];
}

function transportSection(view){
    return [
        '## Measured transport-lane inventory',
        '',
        '| Transport lane | Module | Transport cohort | Topology | Serialization | Security mode |',
        '| --- | --- | --- | --- | --- | --- |',
        ...view.laneIds.map(laneId => {
            const lane=view.dimensions.lanes[laneId];
            const moduleLabel=view.result.catalog?.subjects?.[lane.moduleId]?.label ?? lane.moduleId;
            const transport=view.dimensions.transports[lane.transportId];
            return `| ${markdown(lane.label)} | ${markdown(moduleLabel)} | ${markdown(transport?.label ?? lane.cohortId)} | ${markdown(lane.topology)} | ${markdown(lane.serialization)} | ${markdown(lane.securityMode)} |`;
        }),
        '',
        'A lane is a concrete module × transport × protocol-stack implementation. Transport coverage marked supported but not measured, unsupported, or not implemented is evidence about scope—not a failed benchmark sample.',
        ''
    ];
}

function orderNotes(view){
    if(view.schemaVersion === 1){
        const count=view.laneIds.length;
        const blocks=view.result.config.samples;
        const complete=count > 0 && blocks%count === 0;
        return [`- Schema v1 uses a global Williams-derived subject order. Exact position and first-order carryover balance requires complete ${count}-block cycles; this ${blocks}-block snapshot ${complete ? 'contains complete cycles' : 'does not contain a complete cycle'}.`];
    }
    return cohortIds(view).map(cohortId => {
        const lanes=cohortLanes(view,cohortId);
        const blocks=view.result.config.samplesByCohort?.[cohortId] ?? view.result.config.samples;
        const cycle=cycleLength(lanes.length);
        const complete=Number.isSafeInteger(blocks) && blocks%cycle === 0;
        const transport=view.dimensions.transports[view.dimensions.lanes[lanes[0]].transportId];
        if(lanes.length === 1){
            return `- ${transport?.label ?? cohortId}: ${blocks} cohort-local block${blocks === 1 ? '' : 's'} for one descriptive lane; order balancing is not applicable.`;
        }
        return `- ${transport?.label ?? cohortId}: ${blocks} cohort-local blocks across ${lanes.length} lanes. The deterministic Williams-derived cycle is ${cycle} blocks; exact position and first-order carryover balance applies only to complete cycles, which this configuration ${complete ? 'contains' : 'does not contain'}.`;
    });
}

function publicationGuidance(view){
    if(view.schemaVersion === 1){
        return `${view.laneIds.length*4} blocks (four complete ${view.laneIds.length}-block cycles)`;
    }
    return cohortIds(view).map(cohortId => {
        const lanes=cohortLanes(view,cohortId);
        const cycle=cycleLength(lanes.length);
        const transport=view.dimensions.transports[view.dimensions.lanes[lanes[0]].transportId];
        return `${transport?.label ?? cohortId} ${cycle*4}`;
    }).join('; ');
}

async function renderReport(result,{input='result.json',output='REPORT.md',validateOptions={}}={}){
    await validateResult(result,validateOptions);
    const view=normalizeResult(result);
    const payloads=result.config?.payloads ?? [];
    const platformLabel={darwin:'macOS',linux:'Linux',win32:'Windows'}[result.system?.platform]
        ?? result.system?.platform
        ?? 'unknown platform';
    const successfulSamples=result.validation?.successfulSamples
        ?? result.samples?.filter(sample => sample.status === 'ok').length
        ?? 0;
    const repositoryState=result.repository?.dirty === true
        ? 'dirty'
        : result.repository?.dirty === false
            ? 'clean'
            : 'not recorded';
    const transportNames=cohortIds(view).map(cohortId => {
        const lane=view.dimensions.lanes[cohortLanes(view,cohortId)[0]];
        return view.dimensions.transports[lane.transportId]?.label ?? cohortId;
    });
    const performance=[];
    for(const workload of ['throughput','latency']){
        const tables=cohortIds(view).map(cohortId => performanceTable(view,cohortId,workload)).filter(Boolean);
        if(!tables.length){
            continue;
        }
        performance.push(
            workload === 'throughput'
                ? '## Post-warm-up throughput by transport cohort'
                : '## Post-warm-up round-trip latency by transport cohort',
            ''
        );
        for(const table of tables){
            performance.push(...table,'');
        }
        performance.push(workload === 'throughput'
            ? `Higher is faster within the same cohort and payload cell. The workload keeps up to ${result.config.windowMessages} requests and no more than ${byteLimitLabel(result.config.windowBytes)} of canonical application payload outstanding. Application MiB/s counts the request payload once per completed round trip, not both request and echo.`
            : 'Lower is faster within the same cohort and payload cell. Latency uses exactly one request in flight and sender-side monotonic RTT timing. p95, p99, maximum, and every per-sample latency summary remain in the raw JSON.',
        '');
    }
    const sources=orderedUnique(Object.values(result.capabilities?.matrix ?? {}).flatMap(module =>
        Object.values(module).map(capability => capability.source)
    ).filter(Boolean));
    const rawLink=path.relative(path.dirname(output),input).replaceAll('\\','/') || path.basename(input);
    const lines=[
        '# Node IPC transport-lane comparison',
        '',
        '## Technical summary',
        '',
        `- This ${platformLabel} result contains ${successfulSamples} successful fresh-process samples across ${view.laneIds.length} measured transport lanes and ${transportNames.length} transport cohorts: ${formatList(transportNames)}.`,
        '- Performance is descriptive at the transport-lane level. No global, cross-transport, within-transport, or transport-effect ranking is eligible from this noisy snapshot.',
        '- Capability fit, module-level dependency exposure, and lane-aware implementation glue are reported separately; they are not combined into a composite score.',
        '',
        ...performance,
        ...transportSection(view),
        ...transportCoverageSection(view),
        ...dependencySection(view),
        ...complexitySection(view),
        ...capabilitySection(view),
        '## Scope, data, and metric definitions',
        '',
        `- Snapshot generated ${localTimestamp(result.generatedAt)} on ${platformLabel} (${result.system?.platform ?? 'unknown'}/${result.system?.architecture ?? 'unknown'}), Node ${result.system?.node ?? 'unknown'}, ${result.system?.cpu?.model ?? 'unknown CPU'} (${result.system?.cpu?.count ?? 'unknown'} logical processors).`,
        ...(payloads.length ? [`- Payload matrix: ${payloads.map(payloadLabel).join(', ')} exact canonical JSON bytes. Each message is \`{"payload":"…","sequence":"00000000"}\`; the ASCII payload length is adjusted so the whole JSON message is exactly the stated size.`] : []),
        '- Every sample creates a fresh driver process and echo peer. Startup, connection negotiation, correctness probing, and warm-up are outside the timed measurement; cold-start observations remain in the raw result.',
        `- Throughput counts completed request/echo round trips with bounded pipelining. The ${byteLimitLabel(result.config.windowBytes)} cap covers canonical application request payload only; framing and serialization overhead are outside the cap. Application MiB/s counts request payload once per RTT.`,
        '- Latency keeps one request in flight and reports sender-side RTT percentiles. Timed replies verify exact sequence, encoded size, and payload content.',
        '- Failed or timed-out trials remain failures. Successful samples must exit naturally, leave no private temporary artifacts, and close/release their endpoint.',
        '',
        '## Experimental order and auditability',
        '',
        ...orderNotes(view),
        '- Throughput and latency use separate fresh-process trials. Complete-cycle requirements describe order balance only; they do not make a local noisy snapshot inferential evidence.',
        '- The raw JSON preserves every sample and the reported distributions (median, IQR, MAD, minimum, and maximum); the renderer does not discard timing outliers.',
        '',
        '## Limitations',
        '',
        `- This result is classified \`${result.classification}\`; repository state at capture was ${repositoryState}. Host load, scheduler state, power state, and page-cache state are uncontrolled.`,
        '- Transport cohorts have different topology, framing, security, and protocol semantics. Values from different cohorts are not exchangeable and must not be used as a leaderboard.',
        '- A singleton process IPC cohort is useful as a descriptive baseline but cannot support an ordinal comparison. One local snapshot cannot estimate a transport effect.',
        '- Results are host-, OS-, Node-version-, package-version-, endpoint-implementation-, and power-state-specific. Publication evidence should use identified idle Windows and Linux hosts and repeated complete cohort cycles.',
        '',
        '## Recommended next steps',
        '',
        '1. Filter modules and transport lanes by required topology, security, browser/cross-language interoperability, reconnect, backpressure, and binary semantics before examining timing.',
        `2. For publication evidence, record at least four complete cycles per cohort (${publicationGuidance(view)}) on each identified host; report uncertainty without pooling transports.`,
        '3. Treat dependency count, install scripts/native addons, capability support, and implementation-glue SLOC as separate decision dimensions.',
        '',
        '## Source and artifact inventory',
        '',
        `- Raw result: [${path.basename(input)}](${rawLink})`,
        '- Validation and rendering: `validate.js` and `render-report.js`.',
        '- Reproducible artifact data: `node artifact-data.js <result.json>` executes the named SQLite queries in `artifact-queries.sql` against the selected raw result and records its path, schema version, ID, and SHA-256.',
        '- Benchmark implementation: `run.js`, `worker.js`, `peer.js`, `protocol.js`, `plan.js`, `dependencies.js`, `complexity.js`, `lanes.js`, and `adapters/`.',
        ...sources.map(source => `- ${source}`)
    ];
    return `${lines.join('\n')}\n`;
}

const directInvocation=process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url;

if(directInvocation){
    const [input,output]=process.argv.slice(2);
    if(!input || !output){
        throw new Error('usage: node render-report.js <result.json> <report.md>');
    }
    const result=JSON.parse(await readFile(input,'utf8'));
    const report=await renderReport(result,{input,output});
    await writeFile(output,report);
    process.stdout.write(`${output}\n`);
}

export {
    normalizeResult,
    renderReport
};
