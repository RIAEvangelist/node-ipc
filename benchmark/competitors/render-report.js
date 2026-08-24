import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {validateResult} from './validate.js';

const [input,output]=process.argv.slice(2);
if(!input || !output){
    throw new Error('usage: node render-report.js <result.json> <report.md>');
}

const result=JSON.parse(await readFile(input,'utf8'));
await validateResult(result);

const labels=Object.fromEntries(Object.entries(result.catalog?.subjects ?? {}).map(
    ([id,subject]) => [id,subject.label]
));
const subjects=result.config?.subjects ?? [];
const payloads=result.config?.payloads ?? [];
const summaries=result.summary ?? [];
const summary=(subject,payloadBytes,workload) => summaries.find(row =>
    row.subject === subject && row.payloadBytes === payloadBytes && row.workload === workload
);
const integer=value => Math.round(value).toLocaleString('en-US');
const decimal=(value,digits=1) => Number(value).toFixed(digits);
const payloadLabel=bytes => bytes >= 1024 ? `${bytes/1024} KiB` : `${bytes} B`;
const reportTimeZone='America/Chicago';
const generated=new Intl.DateTimeFormat('en-US',{
    day:'numeric',
    hour:'numeric',
    minute:'2-digit',
    month:'long',
    timeZone:reportTimeZone,
    timeZoneName:'short',
    year:'numeric'
}).format(new Date(result.generatedAt));
const platformLabel={darwin:'macOS',linux:'Linux',win32:'Windows'}[result.system?.platform]
    ?? result.system?.platform
    ?? 'unknown platform';
const formatList=values => values.length < 2
    ? values[0] ?? ''
    : values.length === 2
        ? values.join(' and ')
        : `${values.slice(0,-1).join(', ')}, and ${values.at(-1)}`;
const finite=value => Number.isFinite(value);

function speedTable(workload){
    const available=summaries.some(row => row.workload === workload && (
        workload === 'throughput'
            ? finite(row.roundTripsPerSecond?.median)
            : finite(row.latencyNs?.p50?.median)
    ));
    if(!available || payloads.length === 0){
        return null;
    }
    const headers=payloads.map(payloadLabel);
    const unit=workload === 'throughput' ? 'round trips/s' : 'p50 RTT, µs';
    const lines=[
        `| Subject | ${headers.join(' | ')} |`,
        `| --- | ${headers.map(() => '---:').join(' | ')} |`
    ];
    for(const subject of subjects){
        const values=payloads.map(payloadBytes => {
            const row=summary(subject,payloadBytes,workload);
            const value=workload === 'throughput'
                ? row?.roundTripsPerSecond?.median
                : row?.latencyNs?.p50?.median;
            if(!finite(value)){
                return '—';
            }
            return workload === 'throughput' ? integer(value) : decimal(value/1000);
        });
        lines.push(`| ${labels[subject] ?? subject} | ${values.join(' | ')} |`);
    }
    const sampleCounts=[...new Set(summaries
        .filter(row => row.workload === workload && row.samples > 0)
        .map(row => row.samples))];
    const sampleDescription=sampleCounts.length === 1
        ? `${sampleCounts[0]} fresh-process samples per available cell`
        : 'the successful fresh-process sample counts recorded for each cell';
    return `${lines.join('\n')}\n\nValues are median ${unit} across ${sampleDescription}. Unavailable cells are shown as —.`;
}

function capabilityGroups(subject){
    const groups={manual:[],supported:[],unsupported:[]};
    for(const definition of result.capabilities?.definitions ?? []){
        const status=result.capabilities?.matrix?.[subject]?.[definition.id]?.status;
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

const primaryPayload=payloads[0];
const primaryThroughput=primaryPayload === undefined ? [] : subjects
    .map(subject => ({subject,value:summary(subject,primaryPayload,'throughput')?.roundTripsPerSecond?.median}))
    .filter(entry => finite(entry.value))
    .sort((left,right) => right.value-left.value);
const nodeIpcPrimary=primaryThroughput.find(entry => entry.subject === 'node-ipc');
const exposureRows=subjects
    .filter(subject => result.dependencyExposure?.[subject])
    .map(subject => ({exposure:result.dependencyExposure[subject],subject}));
const dependencyRows=subjects.filter(subject => result.complexity?.[subject]
    && result.dependencyExposure?.[subject]).map(subject => ({
    complexity:result.complexity[subject],
    exposure:result.dependencyExposure[subject],
    subject
}));
const dependencyGroups=new Map;
for(const {exposure,subject} of exposureRows){
    const count=exposure.uniqueResolvedDependencies;
    const group=dependencyGroups.get(count) ?? [];
    group.push(labels[subject] ?? subject);
    dependencyGroups.set(count,group);
}
const dependencySummary=[...dependencyGroups.entries()]
    .sort(([left],[right]) => left-right)
    .map(([count,names]) => `${formatList(names)} (${count})`)
    .join('; ');
const throughputTable=speedTable('throughput');
const latencyTable=speedTable('latency');
const subjectCount=subjects.length;
const snapshotBlocks=result.config?.samples ?? 0;
const completeCycles=subjectCount > 0 && snapshotBlocks%subjectCount === 0;
const publicationBlocks=subjectCount*4;
const sources=[...new Set(
    Object.values(result.capabilities?.matrix ?? {}).flatMap(subject =>
        Object.values(subject).map(capability => capability.source)
    ).filter(Boolean)
)];

const technicalSummary=[];
if(nodeIpcPrimary){
    technicalSummary.push(
        `- **The measured node-ipc fast-profile result completed ${integer(nodeIpcPrimary.value)} ${payloadLabel(primaryPayload)} round trips/s in this local ${platformLabel} snapshot.** It placed ${primaryThroughput.findIndex(entry => entry.subject === 'node-ipc')+1} of ${primaryThroughput.length} for that cell, but the subjects use different transports and the result is not an overall product ranking.`
    );
}
if(exposureRows.length){
    const counts=exposureRows.map(row => row.exposure.uniqueResolvedDependencies);
    technicalSummary.push(
        `- **Unique resolved production dependency exposure ranges from ${Math.min(...counts)} to ${Math.max(...counts)} packages.** ${dependencySummary}. Counts come from the pinned production lockfile closures.`
    );
}
if(dependencyRows.length){
    technicalSummary.push(
        `- **Adapter complexity ranges from ${Math.min(...dependencyRows.map(row => row.complexity.sourceLines))} to ${Math.max(...dependencyRows.map(row => row.complexity.sourceLines))} nonblank, noncomment lines.** This measures subject-specific benchmark glue for both endpoints, not intrinsic API difficulty.`
    );
}
if(result.capabilities?.definitions?.length){
    technicalSummary.push(
        '- **Capability breadth changes the decision.** The version-specific matrix separates built-in or supported capabilities from manual, limited, unsupported, and unverified behavior; filter by requirements before comparing performance.'
    );
}

const dependencySection=dependencyRows.length ? [
    '## Dependency exposure and implementation glue are independently auditable',
    '',
    '| Subject | Direct dependency name count | Direct edges | Unique resolved dependencies | Exposure tier | Adapter SLOC |',
    '| --- | ---: | ---: | ---: | --- | ---: |',
    ...dependencyRows.map(({complexity,exposure,subject}) =>
        `| ${labels[subject] ?? subject} | ${exposure.directUniqueDependencies} | ${exposure.directDependencyEdges} | ${exposure.uniqueResolvedDependencies} | ${exposure.riskTier} | ${complexity.sourceLines} |`
    ),
    '',
    'The exposure tier is intentionally based only on unique resolved production dependency count: 0 minimal, 1–5 low, 6–15 moderate, and 16+ high. It is not a vulnerability or maintainer-quality score. A zero external npm dependency count is not zero total supply-chain risk; install scripts and native addons are recorded separately in the raw result.',
    ''
] : [];

const capabilitySection=result.capabilities?.definitions?.length ? [
    '## Capability breadth—not a composite score—should drive fit',
    '',
    '| Subject | Built in or supported | Manual, separate, or limited | Unsupported or unverified |',
    '| --- | --- | --- | --- |',
    ...subjects.map(subject => {
        const groups=capabilityGroups(subject);
        return `| ${labels[subject] ?? subject} | ${groups.supported.join('; ') || '—'} | ${groups.manual.join('; ') || '—'} | ${groups.unsupported.join('; ') || '—'} |`;
    }),
    '',
    'Capability cells are version-specific and source-linked in the raw result. “Manual” means the transport can carry an application implementation; it does not mean the library supplies the feature.',
    ''
] : [];

const successfulSamples=result.validation?.successfulSamples
    ?? result.samples?.filter(sample => sample.status === 'ok').length
    ?? 0;
const repositoryState=result.repository?.dirty === true
    ? 'dirty'
    : result.repository?.dirty === false
        ? 'clean'
        : 'not recorded';
const orderStatement=subjectCount > 0
    ? `- A deterministic Williams-derived order reduces position and first-order carryover bias. Exact balance requires complete ${subjectCount}-row cycles; this ${snapshotBlocks}-block snapshot ${completeCycles ? 'completes whole cycles' : 'does not complete a whole cycle'}. Throughput and latency run in separate fresh-process trials.`
    : null;
const implementationNotes=[];
if(subjects.includes('ws')){
    implementationNotes.push('`ws` compression and optional native accelerators are disabled');
}
if(subjects.includes('socket-io')){
    implementationNotes.push('Socket.IO is forced to WebSocket without upgrade/reconnect');
}
if(subjects.includes('zeromq')){
    implementationNotes.push('ZeroMQ uses DEALER/ROUTER so bounded pipelining is possible');
}
if(subjects.includes('node-ipc')){
    implementationNotes.push('node-ipc uses its default fast profile over loopback TCP');
}
const transportLabels=[...new Set((result.samples ?? [])
    .map(sample => sample.subject?.transport)
    .filter(Boolean))];
const scopeLines=[
    `- Snapshot generated ${generated} (${reportTimeZone}) on ${platformLabel} (${result.system?.platform ?? 'unknown'}/${result.system?.architecture ?? 'unknown'}), Node ${result.system?.node ?? 'unknown'}, ${result.system?.cpu?.model ?? 'unknown CPU'} (${result.system?.cpu?.count ?? 'unknown'} logical processors).`,
    ...(payloads.length ? [
        `- Payload matrix: ${payloads.map(payloadLabel).join(', ')} exact canonical JSON bytes. Each message is \`{"payload":"…","sequence":"00000000"}\`; the ASCII payload length is adjusted so the whole JSON message is exactly the stated size.`
    ] : []),
    `- ${snapshotBlocks} independent samples per subject × payload × workload, ${successfulSamples} successful samples total.`,
    '- Throughput: completed request/echo round trips per second with bounded pipelining. The 8 MiB cap covers canonical application payload only, and application MiB/s counts the request payload once per completed round trip—not both request and echo. Latency: one-in-flight sender-side RTT percentiles.',
    '- Startup, connection negotiation, the correctness probe, and warm-up are outside the timed measurement. Cold-start observations remain in the raw result.',
    '- All subjects parse and re-emit the same logical object. Raw stream/WebSocket/ZMTP adapters explicitly decode and re-encode JSON; Node IPC, child IPC, and Socket.IO use their public message serialization.'
];

const lines=[
    '# Node IPC end-to-end comparison',
    '',
    ...(technicalSummary.length ? ['## Technical summary','',...technicalSummary,''] : []),
    ...(throughputTable ? [
        '## Throughput varies materially by transport and abstraction',
        '',
        throughputTable,
        '',
        'Higher is faster. The throughput workload keeps up to 64 requests and no more than 8 MiB of canonical application payload outstanding, then counts completed echoes. Transport framing and serialization overhead are not part of that cap. Application MiB/s counts the request payload once per completed round trip, not both request and echo.',
        ''
    ] : []),
    ...(latencyTable ? [
        '## Sequential post-warm-up round-trip latency shows response cost',
        '',
        latencyTable,
        '',
        'Lower is faster. Latency uses exactly one request in flight and sender-side monotonic round-trip timing. p95, p99, maximum, and per-sample distributions remain in the raw JSON.',
        ''
    ] : []),
    ...dependencySection,
    ...capabilitySection,
    '## Scope, data, and metric definitions',
    '',
    ...scopeLines,
    '',
    '## Methodology preserves fairness without pretending the transports are identical',
    '',
    '- Every sample creates a fresh driver process and a fresh echo peer. The peer reports readiness and shutdown over stdio, so native child IPC is measured on its only IPC channel rather than sharing it with the harness control plane.',
    ...(orderStatement ? [orderStatement] : []),
    '- A content-and-sequence probe runs before warm-up. Timed messages still verify exact sequence, total encoded size, and payload content; failures, timeouts, duplicates, or reordering fail the sample.',
    '- TCP endpoints must be closed and immediately reusable, peer and worker exits must be natural, and the private temporary directory must remain empty.',
    ...(implementationNotes.length ? [`- ${implementationNotes.join('. ')}.`] : []),
    '',
    '## Limitations, uncertainty, and robustness checks',
    '',
    `- This is classified \`${result.classification}\`; the repository state was ${repositoryState} at capture. The result retains the commit and a status SHA-256 without publishing or characterizing changed paths.`,
    `- ${snapshotBlocks} samples are useful for a directional snapshot, not narrow confidence claims. The raw JSON preserves medians, IQR, MAD, min/max, and every sample; it does not delete timing outliers.`,
    `- The subjects intentionally retain their native transport semantics${transportLabels.length ? `: ${formatList(transportLabels)}` : ''}. A single overall “winner” would erase capability and topology differences.`,
    '- Only the common JSON request/echo lane is measured here. Binary/advanced-serialization, local Unix-domain socket, Windows named-pipe, TLS, UDP, broadcast, reconnect, multi-client scaling, CPU, and peak-RSS lanes remain future work.',
    '- Results are host-, OS-, Node-version-, package-version-, and power-state-specific. Cross-platform publication should use clean commits on identified idle Windows and Linux machines with complete subject-count cycles.',
    '',
    '## Recommended next steps',
    '',
    '1. Use this suite as the reproducible common-denominator baseline, not as a universal leaderboard.',
    '2. Add separate local-pipe and binary lanes where subjects genuinely support those semantics; keep them out of the TCP/JSON table.',
    `3. Record clean Windows and Linux runs with at least ${publicationBlocks || 24} blocks${subjectCount ? ` (four complete ${subjectCount}-row cycles)` : ''} before making narrow percentage claims.`,
    '4. Choose a solution by the minimum capability set first, then compare speed, adapter SLOC, and dependency exposure within that eligible set.',
    '',
    '## Further questions',
    '',
    '- Does the target require unrelated processes, remote hosts, browser clients, cross-language peers, UDP, authenticated encryption, or pub/sub?',
    '- Is the dominant payload JSON or binary, and what are the real concurrency and backpressure limits?',
    '- Should install scripts/native binaries count as a separate supply-chain dimension in addition to dependency count?',
    '',
    '## Source and artifact inventory',
    '',
    `- Raw result: [${path.basename(input)}](${path.relative(path.dirname(output),input).replaceAll('\\','/')})`,
    '- Reproducible code: `run.js`, `worker.js`, `peer.js`, `protocol.js`, `dependencies.js`, `complexity.js`, and `adapters/` in this directory.',
    ...sources.map(source => `- ${source}`)
];

await writeFile(output,`${lines.join('\n')}\n`);
process.stdout.write(`${output}\n`);
