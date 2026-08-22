const SITE_ROOT = new URL('../', document.currentScript?.src ?? window.location.href);
const BENCHMARK_ADAPTER_NAMES = new Map([
  ['node-net', 'node:net baseline'],
  ['node-ipc-raw', 'Raw'],
  ['node-ipc-fast', 'Fast'],
  ['node-ipc-guarded', 'Guarded'],
  ['node-ipc-assured', 'Assured']
]);

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
  const dashboard = await fetchJSON(panel);
  if (dashboard?.schemaVersion !== 1) throw new Error('Unsupported benchmark dashboard');
  if (dashboard.rankingEligible !== false || dashboard.certification !== false) {
    throw new Error('Benchmark ranking or certification must remain disabled');
  }

  const manifestPath = dashboard.source?.manifest;
  if (manifestPath !== 'data/benchmarks/index.json') throw new Error('Unexpected benchmark manifest path');
  const response = await fetch(new URL(manifestPath, SITE_ROOT), {cache: 'no-store'});
  if (!response.ok) throw new Error(`Benchmark manifest HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== dashboard.source.manifestSha256) throw new Error('Benchmark manifest integrity mismatch');

  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.schemaVersion !== dashboard.source.schemaVersion) throw new Error('Benchmark schema mismatch');
  if (!Array.isArray(manifest.results) || manifest.results.length !== dashboard.source.resultCount) {
    throw new Error('Benchmark result count mismatch');
  }
  if (manifest.comparisonState !== dashboard.source.comparisonState) throw new Error('Benchmark state mismatch');
  const indexed = new Map(manifest.results.map(record => [`data/benchmarks/${record.file}`, record.sha256]));
  const runs = dashboardRuns(dashboard);
  if (runs.length !== indexed.size) throw new Error('Benchmark dashboard record count mismatch');
  for (const {run} of runs) {
    if (run.rankingEligible !== false || run.certification !== false) throw new Error('Benchmark evidence policy mismatch');
    if (indexed.get(run.raw?.detail) !== run.raw?.sha256) throw new Error('Benchmark detail linkage mismatch');
  }
  return {dashboard, manifest};
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

function benchmarkTable(headers, rows) {
  const wrapper = element('div', {className: 'table-scroll'});
  const table = element('table');
  const head = element('thead');
  const headRow = element('tr');
  for (const label of headers) {
    headRow.append(element('th', {scope: 'col', textContent: label}));
  }
  head.append(headRow);
  const body = element('tbody');
  for (const values of rows) {
    const row = element('tr');
    for (const value of values) {
      const cell = element('td');
      if (value?.nodeType) cell.append(value);
      else cell.textContent = text(value);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function dashboardRuns(dashboard) {
  return (dashboard.environments ?? []).flatMap(environment => (environment.runs ?? []).map(run => ({environment, run})));
}

function currentCohort(dashboard) {
  const cohorts = new Map;
  for (const item of dashboardRuns(dashboard)) {
    const cohort = cohorts.get(item.environment.commit) ?? [];
    cohort.push(item);
    cohorts.set(item.environment.commit, cohort);
  }
  const selected = [...cohorts.values()].sort((left, right) => {
    const newest = items => Math.max(...items.map(item => Date.parse(item.run.generatedAt) || 0));
    return newest(right) - newest(left);
  })[0] ?? [];
  const current = new Map;
  for (const item of selected) {
    const previous = current.get(item.environment.key);
    if (!previous || item.run.generatedAt > previous.run.generatedAt) current.set(item.environment.key, item);
  }
  return [...current.values()].sort((left, right) => environmentName(left.environment).localeCompare(environmentName(right.environment), 'en'));
}

function environmentName(environment) {
  return `${text(environment.platform)} · ${text(environment.architecture)} · ${text(environment.node)}`;
}

function adapterName(id) {
  return BENCHMARK_ADAPTER_NAMES.get(id) ?? text(id);
}

function metric(distribution, suffix = '') {
  const value = number(distribution?.median);
  return value === null ? 'Pending' : `${formatNumber(Number(value.toFixed(3)))}${suffix}`;
}

function rawDetailLink(run) {
  const detail = run.raw?.detail;
  if (!/^data\/benchmarks\/run-[A-Za-z0-9-]+[.]json$/u.test(detail ?? '')) return 'Unavailable';
  return element('a', {href: new URL(detail, SITE_ROOT).href, textContent: 'Raw JSON'});
}

function profileResults(dashboard) {
  const rows = currentCohort(dashboard).flatMap(({environment, run}) => run.adapters.map(adapter => [
    environmentName(environment),
    adapterName(adapter.id),
    adapter.lane === 'mutually-authenticated-tls' ? 'Mutual TLS' : 'Plaintext',
    adapter.status === 'measured' ? metric(adapter.passes?.speed?.millisecondsPerMillion, ' ms') : 'Pending',
    adapter.status === 'measured' ? metric(adapter.passes?.speed?.framesPerSecond, ' msg/s') : 'Pending',
    adapter.status === 'measured' ? metric(adapter.passes?.latency?.p95RoundTripNanoseconds, ' ns') : 'Pending'
  ]));
  return benchmarkTable(['Environment', 'Adapter / profile', 'Lane', 'ms / 1M', 'Throughput', 'p95 round trip'], rows);
}

function resourceResults(dashboard) {
  const rows = currentCohort(dashboard).flatMap(({environment, run}) => run.adapters.map(adapter => [
    environmentName(environment),
    adapterName(adapter.id),
    adapter.status === 'measured' ? formatBytes(adapter.memory?.peakRssBytes?.median) : 'Pending',
    adapter.status === 'measured' ? formatBytes(adapter.memory?.afterCleanupRssBytes?.median) : 'Pending',
    adapter.status === 'measured' ? formatBytes(adapter.package?.installedBytes) : 'Pending',
    adapter.status === 'measured' ? `${formatNumber(adapter.gc?.events)} events · ${formatNumber(adapter.gc?.durationMs)} ms` : 'Pending',
    adapter.status === 'measured' ? adapter.cleanup?.clean === true ? 'Clean' : 'Failed' : 'Pending'
  ]));
  return benchmarkTable(['Environment', 'Adapter / profile', 'Peak RSS', 'Post-cleanup RSS', 'Installed', 'GC', 'Cleanup'], rows);
}

function runResults(dashboard) {
  const rows = dashboardRuns(dashboard)
    .sort((left, right) => right.run.generatedAt.localeCompare(left.run.generatedAt, 'en'))
    .map(({environment, run}) => [
      environmentName(environment),
      formatDate(run.generatedAt),
      `${text(run.comparisonState)} · ${text(run.classification)}`,
      run.provenance?.oracle?.implementation,
      `${text(run.provenance?.provider)} · ${text(run.provenance?.imageOS)} ${text(run.provenance?.imageVersion)}`,
      `${formatNumber(run.provenance?.cpu?.count)} × ${text(run.provenance?.cpu?.model)}`,
      shortCommit(run.provenance?.commit),
      run.resources?.cleanup?.clean === true ? 'Clean' : 'Failed',
      rawDetailLink(run)
    ]);
  return benchmarkTable(['Environment', 'Generated', 'Evidence', 'Oracle', 'Runner', 'CPU', 'Commit', 'Cleanup', 'Detail'], rows);
}

function benchmarkSummary(payload) {
  const {dashboard, manifest} = payload;
  const source = dashboard.source;
  const links = element('div', {className: 'button-row'}, [
    element('a', {className: 'button', href: new URL(source.manifest, SITE_ROOT).href, textContent: 'Raw manifest'})
  ]);
  return [dataList([
    ['Current comparison state', source.comparisonState],
    ['Tracked records', formatNumber(source.resultCount)],
    ['Manifest updated', formatDate(manifest.updatedAt)],
    ['Manifest SHA-256', source.manifestSha256],
    ['Rankings', 'Disabled'],
    ['Certification', 'Disabled']
  ]), links];
}

function renderBenchmark(panel, payload) {
  const output = panel.querySelector('[data-live-output]');
  const {dashboard} = payload;
  const runs = dashboardRuns(dashboard);
  output.replaceChildren(...benchmarkSummary(payload));

  if (!runs.length) {
    output.prepend(element('div', {className: 'callout warning'}, [
      element('strong', {textContent: 'No accepted benchmark records'}),
      element('p', {textContent: 'Missing evidence remains pending. Rankings and certification stay disabled.'})
    ]));
    status(panel, 'live', 'Dashboard and manifest verified; no benchmark records are available');
    return;
  }

  const view = panel.dataset.view ?? 'runs';
  const viewContent = view === 'profiles'
    ? profileResults(dashboard)
    : view === 'resources'
      ? resourceResults(dashboard)
      : runResults(dashboard);
  output.prepend(viewContent);
  status(panel, 'live', `Compact dashboard and manifest verified · ${formatNumber(runs.length)} tracked run${runs.length === 1 ? '' : 's'}`);
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
