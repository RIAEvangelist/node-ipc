const SITE_ROOT = new URL('../', document.currentScript?.src ?? window.location.href);

const text = value => value === null || value === undefined || value === '' ? 'Not reported' : String(value);
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const formatNumber = value => {
  const parsed = number(value);
  return parsed === null ? text(value) : new Intl.NumberFormat('en-US').format(parsed);
};
const formatBytes = value => {
  const parsed = number(value);
  if (parsed === null) return text(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = parsed;
  let unit = 0;
  while (Math.abs(size) >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
};
const formatDate = value => {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
};
const shortCommit = value => value ? String(value).slice(0, 12) : 'Not reported';

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(options)) {
    if (name === 'className') node.className = value;
    else if (name === 'textContent') node.textContent = value;
    else if (name === 'styleProperty') node.style.setProperty(value.name, value.value);
    else node.setAttribute(name, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) node.append(child);
  }
  return node;
}

function dataList(entries) {
  const list = element('dl', {className: 'data-list'});
  for (const [label, value] of entries) {
    const item = element('div');
    item.append(element('dt', {textContent: label}), element('dd', {textContent: text(value)}));
    list.append(item);
  }
  return list;
}

function status(panel, state, message) {
  const line = panel.querySelector('[data-live-status]');
  if (!line) return;
  const dot = line.querySelector('.status-dot');
  if (dot) dot.className = `status-dot ${state}`;
  const label = line.querySelector('[data-status-label]');
  if (label) label.textContent = message;
}

async function fetchJSON(panel) {
  const source = panel.dataset.source;
  const url = new URL((source || '').replace(/^\//, ''), SITE_ROOT);
  const response = await fetch(url, {cache: 'no-store'});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function benchmarkPayload(panel) {
  const manifest = await fetchJSON(panel);
  const records = Array.isArray(manifest?.results) ? manifest.results : [];
  if (!records.length) return manifest;
  const latest = [...records].sort((a, b) => new Date(b.generatedAt ?? 0) - new Date(a.generatedAt ?? 0))[0];
  if (!latest.file) return manifest;
  const response = await fetch(new URL(`data/benchmarks/${encodeURIComponent(latest.file)}`, SITE_ROOT), {cache: 'no-store'});
  if (!response.ok) throw new Error(`Benchmark detail HTTP ${response.status}`);
  const detail = await response.json();
  detail.manifest = {
    classification: latest.classification,
    cleanupClean: latest.cleanupClean,
    dirty: latest.dirty,
    file: latest.file,
    publishable: latest.publishable,
    rankingEligible: latest.rankingEligible,
    resultCount: records.length,
    updatedAt: manifest.updatedAt
  };
  return detail;
}

function initNavigation() {
  const button = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-site-nav]');
  if (!button || !nav) return;

  const setOpen = open => {
    nav.dataset.open = String(open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Close' : 'Menu';
  };

  button.addEventListener('click', () => setOpen(nav.dataset.open !== 'true'));
  nav.addEventListener('click', event => {
    if (event.target.closest('a') && window.matchMedia('(max-width: 980px)').matches) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      setOpen(false);
      document.querySelectorAll('.nav-cluster[open]').forEach(item => item.removeAttribute('open'));
    }
  });
  document.addEventListener('click', event => {
    document.querySelectorAll('.nav-cluster[open]').forEach(item => {
      if (!item.contains(event.target)) item.removeAttribute('open');
    });
  });
}

function initCopyButtons() {
  document.querySelectorAll('pre').forEach(block => {
    const button = element('button', {className: 'copy-button', type: 'button', 'aria-label': 'Copy code', textContent: 'Copy'});
    button.addEventListener('click', async () => {
      const code = block.querySelector('code')?.textContent ?? block.textContent;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select text';
      }
      window.setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    });
    block.prepend(button);
  });
}

function summaryValue(payload, key) {
  return payload?.summary?.[key] ?? payload?.[key] ?? null;
}

function renderTestResults(panel, payload) {
  const output = panel.querySelector('[data-live-output]');
  const total = number(summaryValue(payload, 'total'));
  const reportedPassed = summaryValue(payload, 'passedCount') ?? summaryValue(payload, 'passed');
  const reportedFailed = summaryValue(payload, 'failureCount') ?? summaryValue(payload, 'failedCount') ?? summaryValue(payload, 'failed');
  const passed = Array.isArray(reportedPassed) ? reportedPassed.length : number(reportedPassed);
  const failed = Array.isArray(reportedFailed) ? reportedFailed.length : number(reportedFailed);
  const skipped = number(summaryValue(payload, 'skipped')) ?? 0;
  if (total === null && passed === null) throw new Error('No test summary fields');

  output.replaceChildren();
  const metrics = element('div', {className: 'metric-grid'});
  for (const [label, value, note] of [
    ['Correctness cases', total, 'Unit + functional + integration + regression'],
    ['Passed', passed, failed === 0 ? 'All reported cases passed' : 'Review failures before release'],
    ['Failed', failed, 'Must be zero for a green correctness gate'],
    ['Skipped', skipped, 'Tracked separately from passing cases']
  ]) {
    const metric = element('div', {className: 'metric'});
    metric.append(
      element('span', {className: 'metric-label', textContent: label}),
      element('strong', {className: 'metric-value', textContent: formatNumber(value)}),
      element('span', {className: 'metric-note', textContent: note})
    );
    metrics.append(metric);
  }
  output.append(metrics);

  const sets = payload?.sets ?? payload?.summary?.sets;
  if (sets && typeof sets === 'object') {
    const entries = Array.isArray(sets)
      ? sets.map(item => [item.name ?? item.type ?? 'Set', item.total ?? item.count ?? 'Not reported'])
      : Object.entries(sets).map(([name, item]) => [name, typeof item === 'object' ? item.total ?? item.count ?? JSON.stringify(item) : item]);
    output.append(element('p', {className: 'divider-label', textContent: 'Reported sets'}), dataList(entries));
  }

  output.append(dataList([
    ['Generated', formatDate(payload.generatedAt ?? payload.timestamp)],
    ['Commit', shortCommit(payload.commit ?? payload.repository?.commit)],
    ['Duration', summaryValue(payload, 'durationMs') === null ? 'Not reported' : `${formatNumber(summaryValue(payload, 'durationMs'))} ms`],
    ['Runner', payload.runner ?? payload.runtime ?? payload.system?.node ?? 'Vanilla Test + Node.js']
  ]));
  status(panel, failed > 0 ? 'error' : 'live', failed > 0 ? 'Generated results report failures' : 'Fresh generated results loaded');
}

function coveragePercent(payload, key) {
  const value = payload?.total?.[key]?.pct
    ?? payload?.summary?.[key]?.pct
    ?? payload?.summary?.[key]
    ?? payload?.[key]?.pct
    ?? payload?.[`${key}Pct`]
    ?? payload?.[key];
  return number(value);
}

function renderCoverage(panel, payload) {
  const output = panel.querySelector('[data-live-output]');
  const entries = [
    ['Statements', coveragePercent(payload, 'statements')],
    ['Branches', coveragePercent(payload, 'branches')],
    ['Functions', coveragePercent(payload, 'functions')],
    ['Lines', coveragePercent(payload, 'lines')]
  ];
  if (entries.every(([, value]) => value === null)) throw new Error('No coverage percentages');

  output.replaceChildren();
  const metrics = element('div', {className: 'metric-grid'});
  for (const [label, value] of entries) {
    const metric = element('div', {className: 'metric'});
    metric.append(
      element('span', {className: 'metric-label', textContent: label}),
      element('strong', {className: 'metric-value', textContent: value === null ? 'N/A' : `${value.toFixed(2)}%`}),
      element('div', {className: 'progress'}, element('span', {styleProperty: {name: '--progress', value: `${Math.max(0, Math.min(value ?? 0, 100))}%`}}))
    );
    metrics.append(metric);
  }
  output.append(metrics, dataList([
    ['Generated', formatDate(payload.generatedAt ?? payload.timestamp)],
    ['Commit', shortCommit(payload.commit ?? payload.repository?.commit)],
    ['Provider', payload.provider ?? 'Vanilla Test native V8 coverage'],
    ['Report', 'Open the browsable line-by-line report below']
  ]));
  status(panel, 'live', 'Fresh generated coverage summary loaded');
}

function benchmarkRuns(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.runs)) return payload.runs;
  if (Array.isArray(payload?.results)) return payload.results;
  if (payload?.samples || payload?.schemaVersion) return [payload];
  return [];
}

function adapterNames(run) {
  const configured = run?.config?.adapters;
  if (Array.isArray(configured)) return [...new Set(configured)];
  return [...new Set((run?.samples ?? []).map(sample => sample.adapter).filter(Boolean))];
}

function benchmarkLabels(run) {
  const dirty = run?.repository?.dirty;
  const oracle = run?.oracle?.implementation;
  const labels = [];
  labels.push(dirty === true ? 'DIRTY TREE' : dirty === false ? 'CLEAN TREE' : 'TREE STATE UNKNOWN');
  labels.push(oracle === 'standard-c' ? 'C ORACLE' : oracle === 'node-net' ? 'NON-C SMOKE' : 'ORACLE UNKNOWN');
  if (run?.evidence?.publishable === false || run?.manifest?.publishable === false) labels.push('NOT PUBLISHABLE');
  return labels;
}

function rawSamplesTable(samples) {
  const wrapper = element('div', {className: 'table-scroll'});
  const table = element('table');
  const head = element('thead');
  const headRow = element('tr');
  for (const label of ['#', 'Pass', 'Adapter', 'ms / million', 'p95 latency', 'Cleanup', 'GC observed']) {
    headRow.append(element('th', {scope: 'col', textContent: label}));
  }
  head.append(headRow);
  const body = element('tbody');
  samples.forEach((sample, index) => {
    const row = element('tr');
    const values = [
      sample.index ?? index,
      sample.pass,
      sample.adapter,
      number(sample.metrics?.millisecondsPerMillion)?.toFixed(3) ?? 'Not reported',
      sample.latencyNs?.p95 ? `${formatNumber(sample.latencyNs.p95)} ns` : 'Not measured',
      sample.cleanup?.clean === true ? 'Clean' : sample.cleanup?.clean === false ? 'Not clean' : 'Unknown',
      sample.gc?.observed === true ? 'Yes' : sample.gc?.observed === false ? 'No' : 'Unknown'
    ];
    values.forEach(value => row.append(element('td', {textContent: text(value)})));
    body.append(row);
  });
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function renderBenchmark(panel, payload) {
  const output = panel.querySelector('[data-live-output]');
  const runs = benchmarkRuns(payload);
  if (!runs.length) {
    output.replaceChildren(
      element('div', {className: 'callout warning'}, [
        element('strong', {textContent: '0 verified comparative runs'}),
        element('p', {textContent: 'The tracked manifest is valid but empty. There is no verified comparison to publish, so rankings are disabled and the page invents no performance result.'})
      ]),
      dataList([
        ['Comparative runs', '0'],
        ['Comparison state', payload?.comparisonState ?? 'no-verified-runs'],
        ['Manifest updated', formatDate(payload?.updatedAt)],
        ['Rankings', 'Disabled']
      ])
    );
    status(panel, 'live', 'Tracked manifest loaded; no comparative results are available');
    return;
  }
  const run = [...runs].sort((a, b) => new Date(b.generatedAt ?? 0) - new Date(a.generatedAt ?? 0))[0];
  const samples = Array.isArray(run.samples) ? run.samples : [];
  const labels = benchmarkLabels(run);
  const adapters = adapterNames(run);

  output.replaceChildren();
  const pills = element('div', {className: 'pills'});
  labels.forEach(label => pills.append(element('span', {className: `pill ${label === 'CLEAN TREE' || label === 'C ORACLE' ? 'good' : 'warn'}`, textContent: label})));
  output.append(pills);

  const machine = run.system?.machine?.id ?? run.system?.machine ?? run.system?.hostname ?? run.machine?.id ?? run.machine ?? run.runner?.name ?? 'Not reported';
  output.append(
    element('p', {className: 'divider-label', textContent: 'Run provenance'}),
    dataList([
      ['Generated', formatDate(run.generatedAt)],
      ['Machine', machine],
      ['OS', `${text(run.system?.platform ?? run.os)} ${text(run.system?.release ?? '')}`.trim()],
      ['Architecture', run.system?.architecture ?? run.system?.arch ?? run.architecture],
      ['Node', run.system?.node ?? run.node],
      ['Commit', shortCommit(run.repository?.commit ?? run.commit)],
      ['Tree', run.repository?.dirty === true ? 'Dirty — development result' : run.repository?.dirty === false ? 'Clean' : 'Unknown'],
      ['Classification', run.evidence?.classification ?? run.manifest?.classification ?? 'Not reported'],
      ['Publishable', run.evidence?.publishable === true || run.manifest?.publishable === true ? 'Yes' : 'No — evidence only'],
      ['Ranking eligible', run.evidence?.rankingEligible === true || run.manifest?.rankingEligible === true ? 'Yes' : 'No'],
      ['Exclusion reasons', Array.isArray(run.evidence?.reasons) ? run.evidence.reasons.join(', ') : 'Not reported'],
      ['Oracle source', `${text(run.oracle?.implementation)} · ${shortCommit(run.oracle?.source?.sha256 ?? run.oracle?.sourceSha256)}`],
      ['Oracle build', run.oracle?.build ? JSON.stringify(run.oracle.build) : 'No compiled C build — smoke only'],
      ['Adapters', adapters.join(', ') || 'Not reported']
    ])
  );

  output.append(
    element('p', {className: 'divider-label', textContent: 'Configuration and accounting'}),
    dataList([
      ['Passes', Array.isArray(run.config?.passes) ? run.config.passes.join(', ') : run.config?.passes],
      ['Frames', run.config?.frames ? JSON.stringify(run.config.frames) : 'Not reported'],
      ['Payload', run.config?.payloadBytes === undefined ? 'Not reported' : `${formatNumber(run.config.payloadBytes)} bytes`],
      ['Samples per pass', run.config?.samplesPerPass],
      ['Warm-up frames', formatNumber(run.config?.warmupFrames)],
      ['Raw samples retained', formatNumber(samples.length)],
      ['Cleanup', run.cleanup?.clean === true ? `Clean (${formatNumber(run.cleanup.samples)} samples)` : run.cleanup?.clean === false ? 'Not clean — not publishable' : 'Not reported'],
      ['Memory peak', formatBytes(run.memory?.maximumWorkerRssBytes)],
      ['GC', run.gc ? `${formatNumber(run.gc.events)} events · ${formatNumber(run.gc.forcedRuns)} forced · ${text(run.gc.durationMs)} ms` : 'Not reported'],
      ['Package footprint', run.packageFootprint ? `${formatBytes(run.packageFootprint.totalInstalledBytes ?? run.packageFootprint.installedBytes ?? run.memory?.packageInstalledBytes?.['node-ipc'])}` : 'Not captured in this run']
    ])
  );

  const comparable = run.repository?.dirty === false
    && run.oracle?.implementation === 'standard-c'
    && adapters.includes('node-ipc')
    && adapters.length > 1
    && (run.evidence?.rankingEligible === true || run.manifest?.rankingEligible === true);
  const notice = element('div', {className: `callout ${comparable ? 'success' : 'warning'}`});
  notice.append(
    element('strong', {textContent: comparable ? 'Comparable adapter evidence is present.' : 'No vehicle ranking is published.'}),
    element('p', {textContent: comparable
      ? 'This clean C-oracle run includes node-ipc and comparator adapters. Vehicle tiers still require explicit, like-for-like profile results before they can be ranked.'
      : 'Rankings are withheld until comparable, clean-tree, standard-C-oracle results include real node-ipc adapters. Dirty-tree and Node-oracle runs remain clearly labelled smoke evidence.'})
  );
  output.append(notice);

  if (samples.length) {
    output.append(element('p', {className: 'divider-label', textContent: 'Raw samples'}), rawSamplesTable(samples));
  } else {
    output.append(element('div', {className: 'callout warning'}, [
      element('strong', {textContent: 'No raw samples are attached.'}),
      element('p', {textContent: 'The provenance is visible, but this run cannot support a performance comparison.'})
    ]));
  }
  status(panel, 'live', `${formatNumber(runs.length)} tracked benchmark run${runs.length === 1 ? '' : 's'} loaded`);
}

async function initLivePanels() {
  for (const panel of document.querySelectorAll('[data-live-panel]')) {
    status(panel, 'loading', 'Loading generated workflow data…');
    try {
      const payload = panel.dataset.kind === 'benchmarks' ? await benchmarkPayload(panel) : await fetchJSON(panel);
      if (panel.dataset.kind === 'tests') renderTestResults(panel, payload);
      else if (panel.dataset.kind === 'coverage') renderCoverage(panel, payload);
      else if (panel.dataset.kind === 'benchmarks') renderBenchmark(panel, payload);
    } catch (error) {
      status(panel, 'error', 'Generated data is unavailable; showing the documented static fallback');
      const output = panel.querySelector('[data-live-output]');
      const fallback = panel.querySelector('[data-static-fallback]');
      if (output && fallback) output.replaceChildren(fallback.content.cloneNode(true));
      console.info(`node-ipc docs: ${panel.dataset.kind} data unavailable`, error);
    }
  }
}

function initYear() {
  document.querySelectorAll('[data-current-year]').forEach(node => { node.textContent = new Date().getFullYear(); });
}

initNavigation();
initCopyButtons();
initLivePanels();
initYear();
