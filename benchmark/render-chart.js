import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildDashboard} from './dashboard.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const defaultOutput=path.resolve(directory,'../docs/assets/node-ipc-benchmark.svg');
const labels=new Map([
    ['node-net','NET'],
    ['node-ipc-raw','RAW'],
    ['node-ipc-fast','FAST'],
    ['node-ipc-guarded','GUARDED']
]);
const colors=new Map([
    ['node-net','#9fb1c8'],
    ['node-ipc-raw','#62f28c'],
    ['node-ipc-fast','#48d8ff'],
    ['node-ipc-guarded','#ffc857']
]);
const platformNames=new Map([
    ['linux','Linux'],
    ['darwin','macOS'],
    ['win32','Windows']
]);

function renderChart(dashboard){
    assert.equal(dashboard.schemaVersion,1,'unsupported benchmark dashboard schema');
    assert.equal(dashboard.rankingEligible,false,'rankings must remain disabled');
    assert.equal(dashboard.certification,false,'certification must remain disabled');

    const cohort=selectCohort(dashboard.environments);
    const commit=cohort[0]?.commit || null;
    const panels=Array.from({length:6},(_,index) => panel(cohort[index],index));
    const state=cohort.some((environment) => selectedRun(environment)?.comparisonState === 'profile-comparison')
        ? 'Accepted plaintext profile evidence is shown without ranking.'
        : 'Only baseline evidence is tracked; plaintext profiles remain pending.';
    const description=cohort.length
        ? `Six exact-environment panels from commit ${commit}. ${state} Assured remains a separate pending mutually authenticated TLS lane.`
        : 'No complete six-environment benchmark cohort is tracked. Rankings and certification are disabled.';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420" role="img" aria-labelledby="title description">
  <title id="title">node-ipc tracked plaintext profiles; Assured mTLS pending</title>
  <desc id="description">${escapeXml(description)}</desc>
  <rect width="1200" height="420" rx="18" fill="#050812"/>
  <rect x="1" y="1" width="1198" height="418" rx="17" fill="none" stroke="#21304a" stroke-width="2"/>
  <text x="38" y="42" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="25" font-weight="700">node-ipc profile benchmark</text>
  <text x="38" y="67" fill="#9fb1c8" font-family="system-ui, sans-serif" font-size="14">Speed pass median milliseconds per million messages · exact OS, architecture, Node, and commit</text>
  <text x="1162" y="42" fill="#72839b" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="13" text-anchor="end">${commit ? escapeXml(commit.slice(0,12)) : 'no cohort'}</text>
${panels.join('\n')}
  <text x="38" y="402" fill="#72839b" font-family="system-ui, sans-serif" font-size="13">Pending is not zero. Assured uses a separate mutually authenticated TLS (mTLS) lane. Rankings and certification are disabled.</text>
</svg>
`;
}

function selectCohort(environments){
    const byCommit=new Map;
    for(const environment of environments){
        const cohort=byCommit.get(environment.commit) || [];
        cohort.push(environment);
        byCommit.set(environment.commit,cohort);
    }
    const cohorts=[...byCommit.values()]
        .filter((cohort) => cohort.length >= 6)
        .sort((left,right) => cohortTime(right)-cohortTime(left));
    return (cohorts[0] || [])
        .sort(comparePanels)
        .slice(0,6);
}

function cohortTime(cohort){
    return Math.max(...cohort.flatMap((environment) => environment.runs.map(
        (run) => Date.parse(run.generatedAt)
    )));
}

function comparePanels(left,right){
    const order=new Map([['linux',0],['darwin',1],['win32',2]]);
    const platform=(order.get(left.platform) ?? 99)-(order.get(right.platform) ?? 99);
    if(platform) return platform;
    const node=Number(left.node.match(/^v(\d+)/u)?.[1] || 0)-Number(right.node.match(/^v(\d+)/u)?.[1] || 0);
    return node || left.architecture.localeCompare(right.architecture,'en');
}

function panel(environment,index){
    const column=index%2;
    const row=Math.floor(index/2);
    const x=38+column*572;
    const y=87+row*99;
    const width=552;
    const run=selectedRun(environment);

    if(!environment || !run){
        return `  <g class="environment" transform="translate(${x} ${y})">
    <rect width="552" height="88" rx="10" fill="#0c1322" stroke="#21304a"/>
    <text x="16" y="29" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="15" font-weight="700">Environment pending</text>
    <text x="16" y="58" fill="#72839b" font-family="system-ui, sans-serif" font-size="13">No accepted exact-environment record</text>
  </g>`;
    }

    const title=`${platformNames.get(environment.platform) || environment.platform} · ${environment.architecture} · ${environment.node}`;
    const profile=run.comparisonState === 'profile-comparison';
    const state=profile ? 'PLAINTEXT PROFILES' : 'BASELINE ONLY · PROFILES PENDING';
    const adapters=['node-net','node-ipc-raw','node-ipc-fast','node-ipc-guarded'];
    const cells=adapters.map((adapter,index) => adapterCell(run,adapter,index)).join('\n');
    return `  <g class="environment" transform="translate(${x} ${y})">
    <rect width="${width}" height="88" rx="10" fill="#0c1322" stroke="#21304a"/>
    <text x="16" y="23" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="15" font-weight="700">${escapeXml(title)}</text>
    <text x="536" y="23" fill="${profile ? '#62f28c' : '#72839b'}" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" text-anchor="end">${state}</text>
${cells}
  </g>`;
}

function adapterCell(run,adapter,index){
    const result=run.adapters.find((candidate) => candidate.id === adapter);
    const metric=result?.passes?.speed?.millisecondsPerMillion?.median;
    const x=16+index*132;
    const value=Number.isFinite(metric) ? formatMilliseconds(metric) : 'pending';
    return `    <g transform="translate(${x} 43)">
      <text x="0" y="0" fill="${colors.get(adapter)}" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" font-weight="700">${labels.get(adapter)}</text>
      <text x="0" y="21" fill="${Number.isFinite(metric) ? '#f2f7ff' : '#72839b'}" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="12">${value}</text>
    </g>`;
}

function selectedRun(environment){
    if(!environment) return null;
    return [...environment.runs]
        .sort((left,right) => {
            const comparison=(right.comparisonState === 'profile-comparison')-(left.comparisonState === 'profile-comparison');
            return comparison || right.generatedAt.localeCompare(left.generatedAt,'en');
        })[0] || null;
}

function formatMilliseconds(value){
    if(value >= 10000) return `${Math.round(value).toLocaleString('en-US')} ms`;
    if(value >= 1000) return `${value.toFixed(0)} ms`;
    return `${value.toFixed(1)} ms`;
}

function escapeXml(value){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&apos;');
}

function option(name,args){
    const prefix=`--${name}=`;
    return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(args=process.argv.slice(2)){
    const check=args.includes('--check');
    const known=['--check','--output=','--results-directory='];
    const unknown=args.find((argument) => !known.some((prefix) => argument === prefix || argument.startsWith(prefix)));
    assert.equal(unknown,undefined,`unknown option: ${unknown}`);
    const output=path.resolve(option('output',args) || defaultOutput);
    const dashboard=await buildDashboard({resultsDirectory:option('results-directory',args)});
    const svg=renderChart(dashboard);

    if(check){
        assert.equal(await readFile(output,'utf8'),svg,`${path.relative(process.cwd(),output)} is stale`);
    }else{
        await mkdir(path.dirname(output),{recursive:true});
        await writeFile(output,svg);
    }
    return svg;
}

const directInvocation=process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if(directInvocation){
    await main();
}

export {
    main,
    renderChart,
    selectCohort
};
