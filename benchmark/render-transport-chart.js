import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildTransportDashboard} from './transport-dashboard.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
const defaultOutput=path.resolve(directory,'../docs/assets/node-ipc-transport-comparison.svg');
const labels=new Map([
    ['local','LOCAL'],['tcp','TCP'],['tls','TLS'],['udp4','UDP4'],['udp6','UDP6']
]);
const platformNames=new Map([['linux','Linux'],['darwin','macOS'],['win32','Windows']]);

function renderTransportChart(dashboard){
    assert.equal(dashboard.schemaVersion,1,'unsupported transport dashboard schema');
    assert.equal(dashboard.rankingEligible,false,'rankings must remain disabled');
    assert.equal(dashboard.certification,false,'certification must remain disabled');
    const cohort=selectCohort(dashboard.environments);
    const commit=cohort[0]?.commit || null;
    const panels=Array.from({length:6},(_,index) => panel(cohort[index],index)).join('\n');
    const description=cohort.length === 6
        ? `Six exact-environment panels from commit ${commit}. Each transport shows paired v12.0.0 and current medians. Rankings and certification are disabled.`
        : 'No complete six-environment paired transport cohort is tracked. Missing evidence remains pending.';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600" role="img" aria-labelledby="title description">
  <title id="title">node-ipc v12.0.0 versus current transport benchmark</title>
  <desc id="description">${escapeXml(description)}</desc>
  <rect width="1200" height="600" rx="18" fill="#050812"/>
  <rect x="1" y="1" width="1198" height="598" rx="17" fill="none" stroke="#21304a" stroke-width="2"/>
  <text x="38" y="42" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="25" font-weight="700">v12.0.0 vs current · transport comparison</text>
  <text x="38" y="67" fill="#9fb1c8" font-family="system-ui, sans-serif" font-size="14">Paired median milliseconds per one million completed messages · exact environment only</text>
  <text x="1162" y="42" fill="#72839b" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="13" text-anchor="end">${commit ? escapeXml(commit.slice(0,12)) : 'no cohort'}</text>
${panels}
  <text x="38" y="578" fill="#72839b" font-family="system-ui, sans-serif" font-size="13">Local means Unix-domain socket on Linux/macOS and named pipe on Windows. Hosted snapshots are noisy; rankings and certification are disabled.</text>
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
    return (cohorts[0] || []).sort(comparePanels).slice(0,6);
}

function cohortTime(cohort){
    return Math.max(...cohort.flatMap((environment) => environment.runs.map((run) => Date.parse(run.generatedAt))));
}

function comparePanels(left,right){
    const order=new Map([['linux',0],['darwin',1],['win32',2]]);
    const platform=(order.get(left.platform) ?? 99)-(order.get(right.platform) ?? 99);
    if(platform) return platform;
    const leftNode=Number(left.node.match(/^v(\d+)/u)?.[1] || 0);
    const rightNode=Number(right.node.match(/^v(\d+)/u)?.[1] || 0);
    return leftNode-rightNode || left.architecture.localeCompare(right.architecture,'en');
}

function panel(environment,index){
    const column=index%2;
    const row=Math.floor(index/2);
    const x=38+column*572;
    const y=87+row*153;
    const run=selectedRun(environment);
    if(!environment || !run){
        return `  <g class="environment" transform="translate(${x} ${y})">
    <rect width="552" height="140" rx="10" fill="#0c1322" stroke="#21304a"/>
    <text x="16" y="31" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="15" font-weight="700">Environment pending</text>
    <text x="16" y="61" fill="#72839b" font-family="system-ui, sans-serif" font-size="13">No accepted paired transport record</text>
  </g>`;
    }
    const title=`${platformNames.get(environment.platform) || environment.platform} · ${environment.architecture} · ${environment.node}`;
    const rows=run.transports.map((transport,row) => transportRow(transport,row)).join('\n');
    return `  <g class="environment" transform="translate(${x} ${y})">
    <rect width="552" height="140" rx="10" fill="#0c1322" stroke="#21304a"/>
    <text x="16" y="24" fill="#f2f7ff" font-family="system-ui, sans-serif" font-size="15" font-weight="700">${escapeXml(title)}</text>
    <text x="536" y="24" fill="#62f28c" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" text-anchor="end">PAIRED · SNAPSHOT</text>
${rows}
  </g>`;
}

function transportRow(transport,row){
    const y=48+row*18;
    const measured=transport.status === 'measured';
    const legacy=transport.legacy?.millisecondsPerMillion?.median;
    const current=transport.current?.millisecondsPerMillion?.median;
    const speedup=transport.paired?.speedup?.median;
    const value=measured && Number.isFinite(legacy) && Number.isFinite(current)
        ? `${formatMilliseconds(legacy)} → ${formatMilliseconds(current)} · ${speedup.toFixed(2)}×`
        : 'pending';
    return `    <text x="16" y="${y}" fill="#48d8ff" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" font-weight="700">${labels.get(transport.id)}</text>
    <text x="96" y="${y}" fill="${measured ? '#f2f7ff' : '#72839b'}" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11">${escapeXml(value)}</text>`;
}

function selectedRun(environment){
    if(!environment) return null;
    return [...environment.runs].sort((left,right) => right.generatedAt.localeCompare(left.generatedAt,'en'))[0] || null;
}

function formatMilliseconds(value){
    if(value >= 10000) return `${Math.round(value).toLocaleString('en-US')} ms`;
    if(value >= 1000) return `${value.toFixed(0)} ms`;
    return `${value.toFixed(1)} ms`;
}

function escapeXml(value){
    return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
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
    const dashboard=await buildTransportDashboard({resultsDirectory:option('results-directory',args)});
    const svg=renderTransportChart(dashboard);
    if(check) assert.equal(await readFile(output,'utf8'),svg,`${path.relative(process.cwd(),output)} is stale`);
    else{
        await mkdir(path.dirname(output),{recursive:true});
        await writeFile(output,svg);
    }
    return svg;
}

const directInvocation=process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if(directInvocation) await main();

export {main,renderTransportChart,selectCohort};
