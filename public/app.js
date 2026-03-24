const state = {
  hostChart: null,
  accessChart: null,
  serviceProbeChart: null,
  containerMemChart: null,
  containerCpuChart: null,
  volumeGrowthChart: null,
  logGrowthChart: null,
  started: false,
  intervalId: null,
  autoRefreshEnabled: true,
  refreshIntervalMs: 60000,
  whitelistIps: [],
  lastData: null,
  selectedRange: '6h',
  appliedRange: '6h',
  appliedCustomFrom: '',
  appliedCustomTo: '',
  systemAlertsPage: 1,
  systemAlertsPerPage: 20,
  systemAlertsFiltered: [],
  accessPage: 1,
  accessPerPage: 50,
  accessFiltered: [],
  errorPage: 1,
  errorPerPage: 50,
  errorSorted: [],
  diskDirectoriesPage: 1,
  diskFilesPage: 1,
  diskPerPage: 10,
  selectedConfigFile: null,
  dashboardRequest: null,
  dashboardRequestMode: null
};

async function postAlertAction(action, ids = []) {
  const response = await fetch('/api/alerts/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ids })
  });
  if (!response.ok) {
    throw new Error(`Alert action failed with ${response.status}`);
  }
}

async function refreshAlertState() {
  const data = await fetchDashboard(false);
  state.lastData = data;
  renderSystemAlertsTable(data.alertHistory || []);
  renderAlertBell(data);
  updateGenerationLabel(data.generatedAt, data.refreshIntervalMs);
}

async function runAlertAction(action, ids = [], button = null) {
  if (button) button.disabled = true;
  try {
    await postAlertAction(action, ids);
    await refreshAlertState();
  } finally {
    if (button) button.disabled = false;
  }
}

async function markAlertRead(id, button = null) {
  if (!id) return;
  await runAlertAction('mark-read', [id], button);
}

async function acknowledgeAlert(id, button = null) {
  if (!id) return;
  await runAlertAction('acknowledge', [id], button);
}

async function snoozeAlert(id, duration = '1h', button = null) {
  if (!id) return;
  const action = duration === '24h' ? 'snooze-24h' : 'snooze-1h';
  await runAlertAction(action, [id], button);
}

async function clearAlert(id, button = null) {
  if (!id) return;
  await runAlertAction('clear', [id], button);
}

async function markAllAlertsRead(button = null) {
  await runAlertAction('mark-all-read', [], button);
}

async function acknowledgeAllAlerts(button = null) {
  await runAlertAction('acknowledge-all', [], button);
}

async function clearAllAlerts(button = null) {
  await runAlertAction('clear-all', [], button);
}

async function restoreClearedAlerts(button = null) {
  await runAlertAction('restore-cleared', [], button);
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || 'B'}`;
}

function formatTimestamp(value) {
  return new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatShortTime(value) {
  return new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelativeTime(value) {
  if (!value) return 'unknown';
  const deltaMs = Math.max(0, Date.now() - value);
  const deltaMinutes = Math.floor(deltaMs / 60000);
  if (deltaMinutes <= 0) return 'just now';
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function getSnapshotFreshnessMeta(timestamp, refreshMs) {
  const ageMs = Math.max(0, Date.now() - Number(timestamp || 0));
  const intervalMs = Math.max(1000, Number(refreshMs || state.refreshIntervalMs || 60000));

  if (!timestamp) {
    return {
      tone: 'bad',
      label: 'Snapshot unavailable',
      detail: 'No container snapshot has been collected yet.',
      ageMs: 0
    };
  }

  if (ageMs <= (intervalMs * 1.5)) {
    return {
      tone: 'good',
      label: 'Live snapshot',
      detail: `Last collected ${formatRelativeTime(timestamp)} at ${formatShortTime(timestamp)}.`,
      ageMs
    };
  }

  if (ageMs <= (intervalMs * 4)) {
    return {
      tone: 'warn',
      label: 'Aging snapshot',
      detail: `Last collected ${formatRelativeTime(timestamp)} at ${formatShortTime(timestamp)}.`,
      ageMs
    };
  }

  return {
    tone: 'bad',
    label: 'Stale snapshot',
    detail: `Last collected ${formatRelativeTime(timestamp)} at ${formatShortTime(timestamp)}. The page is showing older container data.`,
    ageMs
  };
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function rangeLabel() {
  const r = state.appliedRange || '6h';
  if (r === 'custom') return 'Custom';
  return r;
}

function getPendingCustomRange() {
  const from = document.getElementById('customFrom')?.value || '';
  const to = document.getElementById('customTo')?.value || '';
  if (!from || !to) return null;
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!fromMs || !toMs || toMs <= fromMs) return null;
  return { from, to, fromMs, toMs };
}

function hasPendingRangeChanges() {
  if ((state.selectedRange || '6h') !== (state.appliedRange || '6h')) {
    return true;
  }
  if ((state.selectedRange || '6h') !== 'custom') {
    return false;
  }
  const pending = getPendingCustomRange();
  if (!pending) return false;
  return pending.from !== (state.appliedCustomFrom || '') || pending.to !== (state.appliedCustomTo || '');
}

function updateRangeApplyButton() {
  const button = document.getElementById('rangeApplyBtn');
  if (!button) return;
  const selectedRange = state.selectedRange || '6h';
  const needsCustomValues = selectedRange === 'custom';
  const pending = getPendingCustomRange();
  button.disabled = needsCustomValues ? !pending || !hasPendingRangeChanges() : !hasPendingRangeChanges();
}

function syncRangeUi() {
  document.querySelectorAll('.range-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === state.selectedRange);
  });
  const wrap = document.getElementById('customRangeWrap');
  if (wrap) {
    wrap.style.display = state.selectedRange === 'custom' ? 'flex' : 'none';
  }
  updateRangeApplyButton();
}

function showLoadError(error) {
  const message = error?.message || 'Unknown error';
  const summary = document.getElementById('summaryCards');
  if (summary) {
    summary.innerHTML = `<div class="empty-state">Dashboard failed to load: ${escapeHtml(message)}</div>`;
  }
}

async function applySelectedRange() {
  const nextRange = state.selectedRange || '6h';
  if (nextRange === 'custom') {
    const pending = getPendingCustomRange();
    if (!pending) {
      updateRangeApplyButton();
      return;
    }
    state.appliedCustomFrom = pending.from;
    state.appliedCustomTo = pending.to;
    localStorage.setItem('monitor:customFrom', pending.from);
    localStorage.setItem('monitor:customTo', pending.to);
  }
  state.appliedRange = nextRange;
  localStorage.setItem('monitor:range', state.appliedRange);
  syncRangeUi();
  await render();
}

function normalizeIpListInput(value) {
  return Array.from(new Set(String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)));
}

function updateWhitelistUI(ips) {
  state.whitelistIps = Array.isArray(ips) ? ips : [];
  const input = document.getElementById('whitelistIps');
  const status = document.getElementById('whitelistStatus');
  if (input && document.activeElement !== input) {
    input.value = state.whitelistIps.join(', ');
  }
  if (status) {
    status.textContent = state.whitelistIps.length
      ? `${state.whitelistIps.length} IP${state.whitelistIps.length === 1 ? '' : 's'} saved`
      : '0 IPs saved';
  }
}

async function saveWhitelist() {
  const input = document.getElementById('whitelistIps');
  const button = document.getElementById('saveWhitelistBtn');
  if (!input || !button) return;

  const ips = normalizeIpListInput(input.value);
  button.disabled = true;
  button.textContent = 'Saving...';
  try {
    const response = await fetch('/api/whitelist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ips })
    });
    if (!response.ok) {
      throw new Error(`Whitelist save failed with ${response.status}`);
    }
    const payload = await response.json();
    updateWhitelistUI(payload.ips || []);
    await render();
  } finally {
    button.disabled = false;
    button.textContent = 'Save whitelist';
  }
}

function isBotUserAgent(ua) {
  if (!ua) return false;
  return /bot|crawl|spider|slurp|semrush|ahref/i.test(ua);
}

function hasActiveAccessFilters() {
  const search = document.getElementById('accessSearch')?.value.trim();
  const status = document.getElementById('accessStatusFilter')?.value;
  const method = document.getElementById('accessMethodFilter')?.value;
  const botsOnly = document.getElementById('accessBotsOnly')?.getAttribute('aria-pressed') === 'true';
  const errorsOnly = document.getElementById('accessErrorsOnly')?.getAttribute('aria-pressed') === 'true';
  return Boolean(search || status || method || botsOnly || errorsOnly);
}

function setBotsOnlyUI(enabled) {
  const button = document.getElementById('accessBotsOnly');
  if (!button) return;
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  button.classList.toggle('active', enabled);
}

function setErrorsOnlyUI(enabled) {
  const button = document.getElementById('accessErrorsOnly');
  if (!button) return;
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  button.classList.toggle('active', enabled);
}

function showTab(tabName) {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach((content) => content.classList.remove('active'));
  document.getElementById(`tab-${tabName}`)?.classList.add('active');
}

function openMatchingRequests(searchValue) {
  showTab('logs');
  const searchInput = document.getElementById('accessSearch');
  if (searchInput) searchInput.value = searchValue || '';
  filterAccessLog();
  document.getElementById('accessLogPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openMatchingRequestsWithOptions(searchValue, options = {}) {
  if (typeof options.botsOnly === 'boolean') {
    setBotsOnlyUI(options.botsOnly);
  }
  if (typeof options.errorsOnly === 'boolean') {
    setErrorsOnlyUI(options.errorsOnly);
  }
  openMatchingRequests(searchValue);
}

function renderAccessSection(entries) {
  const baseEntries = applyExcludeIps(entries || []);
  if (hasActiveAccessFilters()) {
    filterAccessLog();
    return;
  }
  renderAccessLog(baseEntries);
}

function updateAutoRefreshUI() {
  const label = document.getElementById('refreshIntervalLabel');
  const button = document.getElementById('autoRefreshToggle');
  const seconds = Math.round((state.refreshIntervalMs || 60000) / 1000);
  if (label) {
    label.textContent = state.autoRefreshEnabled ? `Auto-refresh: ${seconds}s` : 'Auto-refresh paused';
  }
  if (button) {
    button.textContent = state.autoRefreshEnabled ? 'Pause Auto-refresh' : 'Resume Auto-refresh';
    button.classList.toggle('is-paused', !state.autoRefreshEnabled);
    button.setAttribute('aria-pressed', state.autoRefreshEnabled ? 'true' : 'false');
  }
}

function stopAutoRefresh() {
  if (state.intervalId) {
    window.clearInterval(state.intervalId);
    state.intervalId = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!state.autoRefreshEnabled) {
    updateAutoRefreshUI();
    return;
  }
  state.intervalId = window.setInterval(() => {
    render().catch(() => {});
  }, state.refreshIntervalMs || 60000);
  updateAutoRefreshUI();
}

function toggleAutoRefresh() {
  state.autoRefreshEnabled = !state.autoRefreshEnabled;
  localStorage.setItem('monitor:autoRefreshEnabled', state.autoRefreshEnabled ? 'true' : 'false');
  startAutoRefresh();
}

function renderLogsOverview(data) {
  const wrapper = document.getElementById('logsOverview');
  if (!wrapper) return;
  const access = data.recentAccess || [];
  const total = access.length;
  const ok = access.filter((e) => e.status >= 200 && e.status < 300).length;
  const r3xx = access.filter((e) => e.status >= 300 && e.status < 400).length;
  const r4xx = access.filter((e) => e.status >= 400 && e.status < 500).length;
  const r5xx = access.filter((e) => e.status >= 500).length;

  const hosts = {};
  const uris = {};
  access.forEach((e) => {
    const h = e.host || '-';
    hosts[h] = (hosts[h] || 0) + 1;
    const u = e.uri || '/';
    uris[u] = (uris[u] || 0) + 1;
  });
  const topHost = Object.entries(hosts).sort((a, b) => b[1] - a[1])[0];
  const topUri = Object.entries(uris).sort((a, b) => b[1] - a[1])[0];

  wrapper.innerHTML = [
    createSummaryCard('Total Requests', formatNumber(total), `${formatNumber(ok)} successful`, 'good'),
    createSummaryCard('2xx Success', formatNumber(ok), `${total ? Math.round((ok / total) * 100) : 0}% of total`, 'good'),
    createSummaryCard('3xx Redirect', formatNumber(r3xx), `${total ? Math.round((r3xx / total) * 100) : 0}% of total`, r3xx > 0 ? 'warn' : 'good'),
    createSummaryCard('4xx Errors', formatNumber(r4xx), `${total ? Math.round((r4xx / total) * 100) : 0}% of total`, r4xx > 0 ? 'warn' : 'good'),
    createSummaryCard('5xx Errors', formatNumber(r5xx), `${total ? Math.round((r5xx / total) * 100) : 0}% of total`, r5xx > 0 ? 'bad' : 'good'),
    createSummaryCard('Top Host', topHost ? escapeHtml(topHost[0]) : '-', topHost ? `${formatNumber(topHost[1])} hits` : 'No data', 'good', 'host'),
  ].join('');
}

function buildPagerMarkup(page, totalPages) {
  if (totalPages <= 1) return '';
  let buttons = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">&laquo; Prev</button>`;
  const maxButtons = 5;
  let startPage = Math.max(1, page - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  if (endPage - startPage + 1 < maxButtons) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }
  if (startPage > 1) {
    buttons += `<button class="page-btn" data-page="1">1</button>`;
    if (startPage > 2) buttons += '<span class="page-ellipsis">…</span>';
  }
  for (let current = startPage; current <= endPage; current += 1) {
    buttons += `<button class="page-btn${current === page ? ' active' : ''}" data-page="${current}">${current}</button>`;
  }
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) buttons += '<span class="page-ellipsis">…</span>';
    buttons += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
  }
  buttons += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next &raquo;</button>`;
  return buttons;
}

function renderDiskHotspotTable(entries, options) {
  const {
    tbody,
    countEl,
    paginationEl,
    emptyLabel,
    page,
    perPage
  } = options;

  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * perPage;
  const pageEntries = entries.slice(start, start + perPage);

  if (!total) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state" style="border:none">${emptyLabel}</td></tr>`;
    if (countEl) countEl.textContent = '0 entries';
    if (paginationEl) paginationEl.innerHTML = '';
    return safePage;
  }

  tbody.innerHTML = pageEntries.map((entry, index) => `
    <tr>
      <td>${start + index + 1}</td>
      <td class="mono disk-path-cell" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</td>
      <td class="nowrap"><strong>${formatBytes(entry.sizeBytes)}</strong></td>
    </tr>
  `).join('');

  if (countEl) {
    countEl.textContent = `${start + 1}-${Math.min(start + perPage, total)} of ${total} entries`;
  }
  if (paginationEl) {
    paginationEl.innerHTML = buildPagerMarkup(safePage, totalPages);
  }

  return safePage;
}

function renderDiskUsageHotspots(diskUsageHotspots) {
  const directoriesBody = document.getElementById('diskTopDirectoriesRows');
  const filesBody = document.getElementById('diskTopFilesRows');
  const directoriesHeading = document.getElementById('diskTopDirectoriesHeading');
  const filesHeading = document.getElementById('diskTopFilesHeading');
  const metaEl = document.getElementById('diskHotspotsMeta');
  const directoriesCountEl = document.getElementById('diskDirectoriesCount');
  const directoriesPaginationEl = document.getElementById('diskDirectoriesPagination');
  const filesCountEl = document.getElementById('diskFilesCount');
  const filesPaginationEl = document.getElementById('diskFilesPagination');
  if (!directoriesBody || !filesBody) return;

  const hotspots = diskUsageHotspots || null;
  const directories = hotspots?.topDirectories || [];
  const files = hotspots?.topFiles || [];

  if (directoriesHeading) directoriesHeading.textContent = `Largest Root Folders (${directories.length || 0})`;
  if (filesHeading) filesHeading.textContent = `Largest Files (${files.length || 0})`;

  if (metaEl) {
    if (!hotspots?.scannedAt) {
      metaEl.textContent = 'Disk scan pending';
    } else {
      const meta = [
        `Scanned ${formatRelativeTime(hotspots.scannedAt)}`,
        `${formatNumber(hotspots.directoryCount || 0)} root folders`,
        `${formatNumber(hotspots.fileCount || 0)} largest files found`
      ];
      if (hotspots.truncated) {
        meta.push('file scan timed out early');
      }
      if ((hotspots.errors || []).length) {
        meta.push(`${hotspots.errors.length} read errors`);
      }
      metaEl.textContent = meta.join(' • ');
    }
  }

  if (!hotspots?.scannedAt) {
    directoriesBody.innerHTML = '<tr><td colspan="3" class="empty-state" style="border:none">Disk scan is still warming up. Refresh in a few seconds.</td></tr>';
    filesBody.innerHTML = '<tr><td colspan="3" class="empty-state" style="border:none">Disk scan is still warming up. Refresh in a few seconds.</td></tr>';
    if (directoriesCountEl) directoriesCountEl.textContent = '0 entries';
    if (filesCountEl) filesCountEl.textContent = '0 entries';
    if (directoriesPaginationEl) directoriesPaginationEl.innerHTML = '';
    if (filesPaginationEl) filesPaginationEl.innerHTML = '';
    return;
  }

  state.diskDirectoriesPage = renderDiskHotspotTable(directories, {
    tbody: directoriesBody,
    countEl: directoriesCountEl,
    paginationEl: directoriesPaginationEl,
    emptyLabel: 'No folder size data available yet.',
    page: state.diskDirectoriesPage,
    perPage: state.diskPerPage
  });

  state.diskFilesPage = renderDiskHotspotTable(files, {
    tbody: filesBody,
    countEl: filesCountEl,
    paginationEl: filesPaginationEl,
    emptyLabel: 'No file size data available yet.',
    page: state.diskFilesPage,
    perPage: state.diskPerPage
  });
}

function renderTopProcesses(topProcesses) {
  const tbody = document.getElementById('topProcessesRows');
  const heading = document.getElementById('topProcessesHeading');
  const metaEl = document.getElementById('topProcessesMeta');
  if (!tbody) return;

  const sample = topProcesses || { collectedAt: 0, processes: [] };
  const processes = Array.isArray(sample.processes) ? sample.processes.slice(0, 10) : [];

  if (heading) heading.textContent = `Top Processes (${processes.length})`;
  if (metaEl) {
    metaEl.textContent = sample.collectedAt
      ? `Sampled ${formatRelativeTime(sample.collectedAt)} · top 10 by CPU, then memory · memory shows MB and % of RAM`
      : 'Process sample pending';
  }

  if (!processes.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state" style="border:none">No process data available yet.</td></tr>';
    return;
  }

  tbody.innerHTML = processes.map((process) => `
    <tr>
      <td class="mono nowrap">${escapeHtml(String(process.pid || 0))}</td>
      <td class="disk-path-cell" title="${escapeHtml(process.command || process.name || '-')}">
        <div><strong>${escapeHtml(process.serviceLabel || process.name || '-')}</strong></div>
        <div class="mono muted-copy">${escapeHtml(process.command || process.name || '-')}</div>
      </td>
      <td class="nowrap">${Number(process.cpuPercent || 0).toFixed(1)}%</td>
      <td class="nowrap"><strong>${Number(process.memoryMb || 0).toFixed(1)} MB</strong><div class="muted-copy">${Number(process.memoryPercent || 0).toFixed(1)}% RAM</div></td>
      <td class="nowrap">${escapeHtml(process.state || '-')}</td>
    </tr>
  `).join('');
}

function renderBotDetection(accessEntries) {
  const summaryEl = document.getElementById('botDetectionSummary');
  const ipListEl = document.getElementById('botIpList');
  const targetListEl = document.getElementById('botTargetList');
  if (!summaryEl || !ipListEl || !targetListEl) return;

  const access = accessEntries || [];
  const bots = access.filter((entry) => isBotUserAgent(entry.userAgent));
  if (!bots.length) {
    summaryEl.innerHTML = '<div class="empty-state">No known bot signatures detected in the current time range.</div>';
    ipListEl.innerHTML = '<div class="empty-state">No bot source IPs found.</div>';
    targetListEl.innerHTML = '<div class="empty-state">No bot target paths found.</div>';
    return;
  }

  const total = access.length;
  const botErrors = bots.filter((entry) => entry.status >= 400).length;
  const uniqueIps = new Set(bots.map((entry) => entry.clientIp).filter(Boolean));
  const targets = {};
  const ips = {};
  bots.forEach((entry) => {
    const ip = entry.clientIp || '-';
    const target = entry.uri || '/';
    ips[ip] = (ips[ip] || 0) + 1;
    targets[target] = (targets[target] || 0) + 1;
  });

  const topIp = Object.entries(ips).sort((a, b) => b[1] - a[1])[0];
  const topTarget = Object.entries(targets).sort((a, b) => b[1] - a[1])[0];
  const ipEntries = Object.entries(ips).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const targetEntries = Object.entries(targets).sort((a, b) => b[1] - a[1]).slice(0, 8);

  summaryEl.innerHTML = [
    createSummaryCard('Bot Requests', formatNumber(bots.length), `${total ? Math.round((bots.length / total) * 100) : 0}% of all traffic`, bots.length > total * 0.2 ? 'warn' : 'good'),
    createSummaryCard('Bot Errors', formatNumber(botErrors), `${bots.length ? Math.round((botErrors / bots.length) * 100) : 0}% of bot traffic`, botErrors > 0 ? 'warn' : 'good'),
    createSummaryCard('Bot IPs', formatNumber(uniqueIps.size), topIp ? `${escapeHtml(topIp[0])} most active` : 'No data', 'good', topIp ? 'host' : ''),
    createSummaryCard('Top Bot Target', topTarget ? escapeHtml(topTarget[0]) : '-', topTarget ? `${formatNumber(topTarget[1])} hits` : 'No data', 'good', topTarget ? 'host' : '')
  ].join('');

  const maxIp = Math.max(...ipEntries.map(([, count]) => count), 1);
  ipListEl.innerHTML = ipEntries.map(([ip, count]) => `
    <div class="top-path-row bot-report-link" data-search="${escapeHtml(ip)}" data-bots-only="true">
      <div>
        <div class="mono">${escapeHtml(ip)}</div>
        <div class="path-bar"><span style="width:${(count / maxIp) * 100}%"></span></div>
      </div>
      <strong>${formatNumber(count)}</strong>
    </div>
  `).join('');

  const maxTarget = Math.max(...targetEntries.map(([, count]) => count), 1);
  targetListEl.innerHTML = targetEntries.map(([target, count]) => `
    <div class="top-path-row bot-report-link" data-search="${escapeHtml(target)}" data-bots-only="true">
      <div>
        <div class="mono url-text" title="${escapeHtml(target)}">${escapeHtml(target)}</div>
        <div class="path-bar"><span style="width:${(count / maxTarget) * 100}%"></span></div>
      </div>
      <strong>${formatNumber(count)}</strong>
    </div>
  `).join('');

  document.querySelectorAll('.bot-report-link').forEach((row) => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      openMatchingRequestsWithOptions(row.dataset.search || '', { botsOnly: row.dataset.botsOnly === 'true' });
    });
  });
}

function statusClass(status) {
  if (status >= 500) return 'status-5xx';
  if (status >= 400) return 'status-4xx';
  if (status >= 300) return 'status-3xx';
  return 'status-2xx';
}

function levelBadge(level) {
  const cls = level === 'fatal' || level === 'error' ? 'badge-error'
    : level === 'warn' ? 'badge-warn' : 'badge-info';
  return `<span class="log-badge ${cls}">${level}</span>`;
}

function createSummaryCard(title, value, meta, tone = 'good', variant = '') {
  const cls = variant ? ` stat-value--${variant}` : '';
  return `
    <article class="stat-card">
      <h3>${title}</h3>
      <div class="stat-value${cls}">${value}</div>
      <div class="stat-meta"><span class="dot status-${tone}"></span> ${meta}</div>
    </article>
  `;
}

function parseDevice(ua) {
  if (!ua) return 'Unknown';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (isBotUserAgent(ua)) return 'Bot';
  return 'Other';
}

function parseBrowser(ua) {
  if (!ua) return 'Unknown';
  if (isBotUserAgent(ua)) return 'Bot';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\//i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
  if (/MSIE|Trident/i.test(ua)) return 'IE';
  return 'Other';
}

function buildBreakdown(accessEntries, parseFn) {
  const counts = {};
  for (const e of accessEntries) {
    const key = parseFn(e.userAgent);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function formatBreakdownMeta(breakdown, total) {
  const top = breakdown.slice(0, 3);
  return top.map(([name, count]) => `${name} ${Math.round((count / total) * 100)}%`).join(' · ');
}

function renderSummary(latest, accessEntries) {
  const summary = latest.summary;
  const access = accessEntries || [];
  const total = access.length;

  const devices = buildBreakdown(access, parseDevice);
  const browsers = buildBreakdown(access, parseBrowser);

  const cards = [
    createSummaryCard('Requests (1h)', formatNumber(summary.totalRequestsLastHour), `${summary.totalErrorsLastHour} 4xx/5xx · ${summary.requestErrorRate}% error rate`, summary.requestErrorRate >= 5 ? 'bad' : summary.requestErrorRate >= 2 ? 'warn' : 'good'),
    createSummaryCard('Devices', devices.length ? `${devices[0][0]}` : '-', total ? formatBreakdownMeta(devices, total) : 'No data', 'good'),
    createSummaryCard('Browsers', browsers.length ? `${browsers[0][0]}` : '-', total ? formatBreakdownMeta(browsers, total) : 'No data', 'good')
  ];
  document.getElementById('summaryCards').innerHTML = cards.join('');
}

function summarizeNetworkTraffic(host, hostSeries = []) {
  const series = Array.isArray(hostSeries)
    ? hostSeries.filter((entry) => Number.isFinite(Number(entry.networkRxPerSecKb)) && Number.isFinite(Number(entry.networkTxPerSecKb)))
    : [];

  if (!series.length) {
    return {
      rx: Number(host.networkRxPerSecKb || 0),
      tx: Number(host.networkTxPerSecKb || 0),
      meta: 'Latest sampled rate'
    };
  }

  const totals = series.reduce((acc, entry) => ({
    rx: acc.rx + Number(entry.networkRxPerSecKb || 0),
    tx: acc.tx + Number(entry.networkTxPerSecKb || 0)
  }), { rx: 0, tx: 0 });
  const peakRx = Math.max(...series.map((entry) => Number(entry.networkRxPerSecKb || 0)));
  const peakTx = Math.max(...series.map((entry) => Number(entry.networkTxPerSecKb || 0)));
  const avgRx = Math.round((totals.rx / series.length) * 10) / 10;
  const avgTx = Math.round((totals.tx / series.length) * 10) / 10;

  return {
    rx: avgRx,
    tx: avgTx,
    meta: `Avg over ${rangeLabel()} · peak RX ${peakRx} KB/s · TX ${peakTx} KB/s`
  };
}

function renderHostMetrics(latest, hostSeries = []) {
  const host = latest?.host || {};
  const summary = latest?.summary || {};
  const allContainers = Array.isArray(latest?.containers) ? latest.containers : [];
  const runningContainerEntries = allContainers.filter((container) => container.state === 'running');
  const totalContainers = runningContainerEntries.length || Number(summary.runningContainers || 0);
  const runningContainers = totalContainers;
  const hiddenStoppedContainers = Math.max(0, allContainers.length - runningContainerEntries.length);
  const totalRequestsLastHour = Number(summary.totalRequestsLastHour || 0);
  const totalErrorsLastHour = Number(summary.totalErrorsLastHour || 0);
  const total5xxLastHour = Number(summary.total5xxLastHour || 0);
  const networkTraffic = summarizeNetworkTraffic(host, hostSeries);

  const items = [
    { label: 'VM CPU', value: `${host.cpuPercent}%`, meta: `Load ${host.loadAverage.join(' / ')}`, tone: host.cpuPercent >= 85 ? 'bad' : host.cpuPercent >= 65 ? 'warn' : 'good' },
    { label: 'VM Memory', value: `${host.memoryPercent}%`, meta: `${host.memoryUsedMb} MB of ${host.memoryTotalMb} MB`, tone: host.memoryPercent >= 85 ? 'bad' : host.memoryPercent >= 70 ? 'warn' : 'good' },
    { label: 'Disk Usage', value: `${host.diskUsedGb} GB / ${host.diskTotalGb} GB`, tone: host.diskPercent >= 90 ? 'bad' : host.diskPercent >= 80 ? 'warn' : 'good' },
    { label: 'Disk Percent', value: `${host.diskPercent}%`, tone: host.diskPercent >= 90 ? 'bad' : host.diskPercent >= 80 ? 'warn' : 'good' },
    { label: 'Network Traffic', value: `RX ${networkTraffic.rx} KB/s`, secondaryValue: `TX ${networkTraffic.tx} KB/s`, meta: networkTraffic.meta, tone: 'good' },
    { label: 'Containers Running', value: `${runningContainers}/${totalContainers}`, meta: totalContainers ? (hiddenStoppedContainers > 0 ? `${hiddenStoppedContainers} stopped hidden` : 'All running') : 'No containers detected', tone: 'good' },
    { label: '5xx Errors', value: formatNumber(total5xxLastHour), meta: `${formatNumber(totalErrorsLastHour)} total 4xx/5xx out of ${formatNumber(totalRequestsLastHour)} requests`, tone: total5xxLastHour >= 5 ? 'bad' : total5xxLastHour > 0 ? 'warn' : 'good' },
    { label: 'Uptime', value: formatDuration(host.uptimeSeconds), tone: 'good' }
  ];
  document.getElementById('hostMetrics').innerHTML = items.map((item) => `
    <div class="metric-card tone-${item.tone || 'good'}">
      <h3>${item.label}</h3>
      <p>${item.value}</p>
      ${item.secondaryValue ? `<p class="metric-secondary-value">${item.secondaryValue}</p>` : ''}
      ${item.meta ? `<span class="metric-meta"><span class="dot status-${item.tone || 'good'}"></span> ${item.meta}</span>` : ''}
    </div>
  `).join('');
}

function renderTopUrls(urls) {
  const wrapper = document.getElementById('topUrls');
  const heading = document.getElementById('topUrlsHeading');
  if (heading) heading.textContent = `Top URLs (${rangeLabel()})`;
  if (!urls || !urls.length) {
    wrapper.innerHTML = '<div class="empty-state">No URL data yet.</div>';
    return;
  }

  const max = Math.max(...urls.map((item) => item.count), 1);
  wrapper.innerHTML = urls.map((item) => `
    <div class="top-path-row">
      <div>
        <div class="mono url-text" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
        <div class="path-bar"><span style="width:${(item.count / max) * 100}%"></span></div>
      </div>
      <strong>${formatNumber(item.count)}</strong>
    </div>
  `).join('');
}

function renderTopClientIps(ips) {
  const wrapper = document.getElementById('topClientIps');
  const heading = document.getElementById('clientIpsHeading');
  if (heading) heading.textContent = `Top Client IPs (${rangeLabel()})`;
  if (!ips || !ips.length) {
    wrapper.innerHTML = '<div class="empty-state">No client IP data yet.</div>';
    return;
  }

  const max = Math.max(...ips.map((item) => item.count), 1);
  wrapper.innerHTML = ips.map((item) => {
    const geoText = item.country
      ? `${countryFlag(item.countryCode)} ${item.city ? item.city + ', ' : ''}${item.country}`
      : '';
    return `
      <div class="top-path-row ip-row" data-ip="${escapeHtml(item.ip)}">
        <div>
          <div class="ip-info">
            <span class="mono">${escapeHtml(item.ip)}</span>
            ${geoText ? `<span class="geo-label">${escapeHtml(geoText)}</span>` : ''}
          </div>
          <div class="path-bar"><span style="width:${(item.count / max) * 100}%"></span></div>
        </div>
        <strong>${formatNumber(item.count)}</strong>
      </div>
    `;
  }).join('');

  wrapper.querySelectorAll('.ip-row').forEach((row) => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      document.getElementById('accessSearch').value = row.dataset.ip;
      filterAccessLog();
      row.closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

function renderErrorBreakdown(errors) {
  const wrapper = document.getElementById('errorBreakdown');
  const counter = document.getElementById('errorCount');
  const paginationEl = document.getElementById('errorPagination');

  if (!errors || !errors.length) {
    wrapper.innerHTML = '<div class="empty-state">No HTTP errors in selected time range.</div>';
    if (counter) counter.textContent = '0 entries';
    if (paginationEl) paginationEl.innerHTML = '';
    state.errorSorted = [];
    return;
  }

  const grouped = {};
  errors.forEach((e) => {
    const key = `${e.status} ${e.method} ${e.host || '-'} ${e.uri}`;
    if (!grouped[key]) {
      grouped[key] = {
        status: e.status,
        method: e.method,
        host: e.host || '-',
        uri: e.uri,
        count: 0,
        lastIp: e.clientIp,
        lastAt: e.capturedAt,
        lastEntry: e
      };
    }
    grouped[key].count++;
    if (e.capturedAt > grouped[key].lastAt) {
      grouped[key].lastAt = e.capturedAt;
      grouped[key].lastIp = e.clientIp;
      grouped[key].lastEntry = e;
    }
  });

  state.errorSorted = Object.values(grouped).sort((a, b) => {
    if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
    return b.count - a.count;
  });
  renderErrorPage();
}

function renderErrorPage() {
  const wrapper = document.getElementById('errorBreakdown');
  const counter = document.getElementById('errorCount');
  const paginationEl = document.getElementById('errorPagination');
  const sorted = state.errorSorted;
  const total = sorted.length;
  const perPage = state.errorPerPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (state.errorPage > totalPages) state.errorPage = totalPages;
  const page = state.errorPage;
  const start = (page - 1) * perPage;
  const pageEntries = sorted.slice(start, start + perPage);

  wrapper.innerHTML = `
    <div class="table-scroll">
      <table class="data-table error-table">
        <thead><tr><th>Status</th><th>Method</th><th>Host</th><th>URL</th><th>Count</th><th>Last IP</th><th>Last Seen</th></tr></thead>
        <tbody>${pageEntries.map((e, i) => `
          <tr data-idx="${start + i}">
            <td><span class="status-badge ${statusClass(e.status)}">${e.status}</span></td>
            <td>${e.method}</td>
            <td class="mono" title="${escapeHtml(e.host || '-')}">${escapeHtml(e.host || '-')}</td>
            <td class="mono url-text" title="${escapeHtml(e.uri)}">${escapeHtml(e.uri)}</td>
            <td><strong>${e.count}</strong></td>
            <td class="mono">${escapeHtml(e.lastIp)}</td>
            <td>${formatShortTime(e.lastAt)}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    </div>
  `;

  if (counter) counter.textContent = `${start + 1}–${Math.min(start + perPage, total)} of ${total} entries`;

  if (paginationEl) {
    let btns = '';
    btns += `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">&laquo; Prev</button>`;
    const maxBtns = 7;
    let pStart = Math.max(1, page - Math.floor(maxBtns / 2));
    let pEnd = Math.min(totalPages, pStart + maxBtns - 1);
    if (pEnd - pStart + 1 < maxBtns) pStart = Math.max(1, pEnd - maxBtns + 1);
    if (pStart > 1) btns += `<button class="page-btn" data-page="1">1</button><span class="page-ellipsis">…</span>`;
    for (let i = pStart; i <= pEnd; i++) {
      btns += `<button class="page-btn${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (pEnd < totalPages) btns += `<span class="page-ellipsis">…</span><button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
    btns += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next &raquo;</button>`;
    paginationEl.innerHTML = btns;
  }
}

function renderSystemAlertsTable(historyEntries) {
  const wrapper = document.getElementById('systemAlertsHistory');
  const counter = document.getElementById('systemAlertsCount');
  const paginationEl = document.getElementById('systemAlertsPagination');
  if (!wrapper) return;

  const entries = Array.isArray(historyEntries) ? historyEntries : [];
  if (!entries.length) {
    wrapper.innerHTML = '<div class="empty-state">No system alerts recorded yet.</div>';
    if (counter) counter.textContent = '0 entries';
    if (paginationEl) paginationEl.innerHTML = '';
    return;
  }

  const search = document.getElementById('systemAlertsSearch')?.value.trim().toLowerCase() || '';
  const filtered = !search
    ? entries
    : entries.filter((entry) => {
      const haystack = [
        entry.severity,
        entry.category,
        entry.title,
        entry.desc,
        entry.state
      ].map((value) => String(value || '').toLowerCase()).join(' ');
      return haystack.includes(search);
    });
  state.systemAlertsFiltered = filtered;

  if (!filtered.length) {
    wrapper.innerHTML = '<div class="empty-state">No system alerts match the current search.</div>';
    if (counter) counter.textContent = '0 matching entries';
    if (paginationEl) paginationEl.innerHTML = '';
    return;
  }

  const total = filtered.length;
  const perPage = state.systemAlertsPerPage || 20;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(state.systemAlertsPage || 1, totalPages);
  state.systemAlertsPage = page;
  const start = (page - 1) * perPage;
  const pageEntries = filtered.slice(start, start + perPage);

  const severityClass = (severity) => severity === 'critical'
    ? 'status-5xx'
    : severity === 'warning'
      ? 'status-4xx'
      : severity === 'healthy'
        ? 'status-2xx'
        : 'status-3xx';

  wrapper.innerHTML = `
    <div class="table-scroll">
      <table class="data-table alert-history-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Category</th>
            <th>Alert</th>
            <th>Status</th>
            <th>First Seen</th>
            <th>Last Seen</th>
            <th>Resolved</th>
          </tr>
        </thead>
        <tbody>
          ${pageEntries.map((entry) => `
            <tr>
              <td><span class="status-badge ${severityClass(entry.severity)}">${escapeHtml(entry.severity)}</span></td>
              <td>${escapeHtml(entry.category || '-')}</td>
              <td>
                <div class="alert-history-title">${escapeHtml(entry.title || '-')}</div>
                <div class="alert-history-desc" title="${escapeHtml(entry.desc || '')}">${escapeHtml(entry.desc || '-')}</div>
              </td>
              <td><span class="alert-state-pill ${escapeHtml(entry.state || 'active')}">${escapeHtml(entry.state || 'active')}</span></td>
              <td>${entry.firstSeenAt ? formatShortTime(entry.firstSeenAt) : '-'}</td>
              <td>${entry.lastSeenAt ? formatShortTime(entry.lastSeenAt) : '-'}</td>
              <td>${entry.resolvedAt ? formatShortTime(entry.resolvedAt) : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  if (counter) counter.textContent = `${start + 1}-${Math.min(start + perPage, total)} of ${total} entries`;
  if (paginationEl) {
    let btns = '';
    btns += `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">&laquo; Prev</button>`;
    const maxBtns = 7;
    let pStart = Math.max(1, page - Math.floor(maxBtns / 2));
    let pEnd = Math.min(totalPages, pStart + maxBtns - 1);
    if (pEnd - pStart + 1 < maxBtns) pStart = Math.max(1, pEnd - maxBtns + 1);
    if (pStart > 1) btns += `<button class="page-btn" data-page="1">1</button><span class="page-ellipsis">…</span>`;
    for (let i = pStart; i <= pEnd; i++) {
      btns += `<button class="page-btn${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (pEnd < totalPages) btns += `<span class="page-ellipsis">…</span><button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
    btns += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next &raquo;</button>`;
    paginationEl.innerHTML = btns;
  }
}

function renderContainers(containers) {
  const sorted = [...containers].sort((a, b) => b.memoryUsedMb - a.memoryUsedMb);
  const running = containers.filter((c) => c.state === 'running').length;
  const healthy = containers.filter((c) => c.health === 'healthy').length;
  const heading = document.getElementById('containerHeading');
  if (heading) heading.textContent = `Container Health and Utilization — ${running}/${containers.length} running · ${healthy} healthy`;
  const rows = sorted.map((container) => `
    <tr>
      <td><strong>${escapeHtml(container.name)}</strong></td>
      <td><span class="pill"><span class="dot status-${container.state === 'running' ? 'good' : 'bad'}"></span>${container.state}</span></td>
      <td>${container.health || 'n/a'}</td>
      <td>${container.cpuPercent}%</td>
      <td>${container.memoryUsedMb} MB${container.memoryLimitMb ? ` / ${container.memoryLimitMb} MB` : ''}</td>
      <td>${container.networks?.length ? `
        <div class="network-badge-list">
          ${container.networks.map((network) => `
            <div class="network-badge" title="${escapeHtml(`${container.name}${network.ipv4 ? ` - ${network.ipv4}` : ''}${network.ipv6 ? ` - ${network.ipv6}` : ''}`)}">
              <span class="network-ip mono">${escapeHtml(network.ipv4 || network.ipv6 || '-')}</span>
            </div>
          `).join('')}
        </div>` : '<span class="muted-copy">No network IP</span>'}</td>
      <td>${container.exposedExternal ? '<span class="pill pill-exposed">External</span>' : '<span class="pill pill-internal">Internal</span>'}</td>
      <td>${container.restartCount}</td>
      <td class="nowrap" title="${container.lastSeenAt ? escapeHtml(formatTimestamp(container.lastSeenAt)) : 'Unknown'}">${container.lastSeenAt ? escapeHtml(formatRelativeTime(container.lastSeenAt)) : '-'}</td>
      <td class="mono">${escapeHtml(container.image)}</td>
    </tr>
  `).join('');
  document.getElementById('containerRows').innerHTML = rows || '<tr><td colspan="10">No containers discovered.</td></tr>';
}

function renderContainerFreshness(timestamp, refreshMs) {
  const badge = document.getElementById('containerFreshnessBadge');
  const meta = document.getElementById('containerFreshnessMeta');
  if (!badge || !meta) return;

  const freshness = getSnapshotFreshnessMeta(timestamp, refreshMs);
  badge.className = `pill panel-status-pill panel-status-pill-${freshness.tone}`;
  badge.textContent = freshness.label;
  meta.textContent = freshness.detail;
}

function renderContainerSummary(containers, dockerOverview, caddyOverview) {
  const el = document.getElementById('containerSummaryCards');
  if (!el) return;

  const running = containers.filter((c) => c.state === 'running').length;
  const stopped = containers.length - running;
  const healthy = containers.filter((c) => c.health === 'healthy').length;
  const unhealthy = containers.filter((c) => c.health && c.health !== 'healthy').length;
  const totalMemMb = containers.reduce((s, c) => s + (c.memoryUsedMb || 0), 0);
  const totalCpu = containers.reduce((s, c) => s + (c.cpuPercent || 0), 0);
  const restarts = containers.reduce((s, c) => s + (c.restartCount || 0), 0);
  const imageCount = dockerOverview?.images?.length || 0;
  const networkCount = dockerOverview?.networks?.length || 0;
  const volumeCount = dockerOverview?.volumes?.length || 0;
  const diskMb = dockerOverview?.diskUsage?.totalMb || 0;
  const caddyCounts = caddyOverview?.counts || {};
  const caddyContainer = caddyOverview?.container || null;

  const cards = [
    createSummaryCard('Running', `${running} / ${containers.length}`, stopped > 0 ? `${stopped} stopped` : 'All running', stopped > 0 ? 'warn' : 'good'),
    createSummaryCard('Health', `${healthy} healthy`, unhealthy > 0 ? `${unhealthy} unhealthy` : 'All containers healthy', unhealthy > 0 ? 'bad' : 'good'),
    createSummaryCard('Caddy Hosts', formatNumber(caddyCounts.hostnames || 0), caddyContainer ? `${caddyContainer.name} routing layer` : 'Edge Caddy not detected', caddyContainer ? 'good' : 'warn'),
    createSummaryCard('Caddy Certificates', formatNumber(caddyCounts.certificates || 0), (caddyCounts.certificates || 0) ? `${formatNumber(caddyCounts.renewSoon || 0)} renew soon` : 'No certificates discovered', (caddyCounts.urgent || 0) > 0 ? 'bad' : (caddyCounts.renewSoon || 0) > 0 ? 'warn' : 'good'),
    createSummaryCard('Total CPU', `${totalCpu.toFixed(1)}%`, `Across ${running} containers`, totalCpu > 80 ? 'bad' : totalCpu > 50 ? 'warn' : 'good'),
    createSummaryCard('Total Memory', `${totalMemMb.toFixed(0)} MB`, `Across ${running} containers`, 'good'),
    createSummaryCard('Restarts', formatNumber(restarts), restarts > 0 ? 'Some containers restarted' : 'No restarts', restarts > 5 ? 'bad' : restarts > 0 ? 'warn' : 'good'),
    createSummaryCard('Docker Disk', diskMb > 1024 ? `${(diskMb / 1024).toFixed(1)} GB` : `${diskMb} MB`, `${imageCount} images · ${volumeCount} volumes`, diskMb > 10240 ? 'warn' : 'good'),
    createSummaryCard('Images', formatNumber(imageCount), `${networkCount} networks`, 'good'),
    createSummaryCard('Volumes', formatNumber(volumeCount), `${networkCount} networks configured`, 'good')
  ];
  el.innerHTML = cards.join('');
}

function renderContainerMemChart(containers) {
  const canvas = document.getElementById('containerMemChart');
  if (!canvas) return;
  const sorted = [...containers].filter((c) => c.state === 'running').sort((a, b) => b.memoryUsedMb - a.memoryUsedMb).slice(0, 15);
  const config = {
    type: 'bar',
    data: {
      labels: sorted.map((c) => c.name),
      datasets: [{
        label: 'Memory (MB)',
        data: sorted.map((c) => c.memoryUsedMb),
        backgroundColor: sorted.map((c) => c.memoryPercent >= 85 ? 'rgba(239, 68, 68, 0.65)' : c.memoryPercent >= 60 ? 'rgba(245, 158, 11, 0.6)' : 'rgba(37, 99, 235, 0.6)'),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x} MB` } } },
      scales: { x: { grid: { color: 'rgba(0,0,0,0.05)' }, title: { display: true, text: 'MB' } }, y: { grid: { display: false } } }
    }
  };
  if (state.containerMemChart) state.containerMemChart.destroy();
  state.containerMemChart = new Chart(canvas, config);
}

function renderContainerCpuChart(containers) {
  const canvas = document.getElementById('containerCpuChart');
  if (!canvas) return;
  const sorted = [...containers].filter((c) => c.state === 'running' && c.cpuPercent > 0).sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 15);
  if (!sorted.length) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.containerCpuChart) { state.containerCpuChart.destroy(); state.containerCpuChart = null; }
    return;
  }
  const config = {
    type: 'bar',
    data: {
      labels: sorted.map((c) => c.name),
      datasets: [{
        label: 'CPU %',
        data: sorted.map((c) => c.cpuPercent),
        backgroundColor: sorted.map((c) => c.cpuPercent >= 50 ? 'rgba(239, 68, 68, 0.65)' : c.cpuPercent >= 20 ? 'rgba(245, 158, 11, 0.6)' : 'rgba(16, 185, 129, 0.6)'),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x}%` } } },
      scales: { x: { grid: { color: 'rgba(0,0,0,0.05)' }, title: { display: true, text: '%' }, max: 100 }, y: { grid: { display: false } } }
    }
  };
  if (state.containerCpuChart) state.containerCpuChart.destroy();
  state.containerCpuChart = new Chart(canvas, config);
}

function renderDockerDiskUsage(dockerOverview) {
  const el = document.getElementById('dockerDiskUsage');
  if (!el) return;
  const du = dockerOverview?.diskUsage;
  if (!du) {
    el.innerHTML = '<div class="empty-state">No Docker disk usage data available.</div>';
    return;
  }
  const items = [
    { label: 'Images', value: du.imagesMb > 1024 ? `${(du.imagesMb / 1024).toFixed(1)} GB` : `${du.imagesMb} MB`, raw: du.imagesMb, color: '#2563eb' },
    { label: 'Containers', value: du.containersMb > 1024 ? `${(du.containersMb / 1024).toFixed(1)} GB` : `${du.containersMb} MB`, raw: du.containersMb, color: '#7c3aed' },
    { label: 'Volumes', value: du.volumesMb > 1024 ? `${(du.volumesMb / 1024).toFixed(1)} GB` : `${du.volumesMb} MB`, raw: du.volumesMb, color: '#10b981' },
    { label: 'Build Cache', value: du.buildCacheMb > 1024 ? `${(du.buildCacheMb / 1024).toFixed(1)} GB` : `${du.buildCacheMb} MB`, raw: du.buildCacheMb, color: '#f59e0b' }
  ];
  const total = du.totalMb || 1;
  el.innerHTML = `
    <div class="docker-disk-bar">
      ${items.map((i) => `<div class="docker-disk-segment" style="flex:${Math.max(i.raw, 1)};background:${i.color}" title="${i.label}: ${i.value}"></div>`).join('')}
    </div>
    <div class="docker-disk-legend">
      ${items.map((i) => `
        <div class="docker-disk-legend-item">
          <span class="docker-disk-swatch" style="background:${i.color}"></span>
          <span class="docker-disk-legend-label">${i.label}</span>
          <strong>${i.value}</strong>
          <span class="docker-disk-legend-pct">${Math.round((i.raw / total) * 100)}%</span>
        </div>
      `).join('')}
      <div class="docker-disk-legend-item docker-disk-total">
        <span class="docker-disk-legend-label">Total</span>
        <strong>${du.totalMb > 1024 ? `${(du.totalMb / 1024).toFixed(1)} GB` : `${du.totalMb} MB`}</strong>
      </div>
    </div>
  `;
}

function renderDockerImages(dockerOverview) {
  const tbody = document.getElementById('dockerImageRows');
  const heading = document.getElementById('dockerImagesHeading');
  if (!tbody) return;
  const images = dockerOverview?.images || [];
  if (heading) heading.textContent = `Images (${images.length})`;
  if (!images.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="border:none">No image data.</td></tr>';
    return;
  }
  tbody.innerHTML = images.map((img) => `
    <tr>
      <td class="mono" title="${escapeHtml(img.tags.join(', '))}">${escapeHtml(img.tags[0] || img.id)}</td>
      <td class="nowrap">${img.sizeMb > 1024 ? `${(img.sizeMb / 1024).toFixed(1)} GB` : `${img.sizeMb} MB`}</td>
      <td class="nowrap">${img.created ? formatTimestamp(img.created) : '-'}</td>
      <td>${img.containers}</td>
    </tr>
  `).join('');
}

function renderDockerNetworks(dockerOverview) {
  const tbody = document.getElementById('dockerNetworkRows');
  const heading = document.getElementById('dockerNetworksHeading');
  if (!tbody) return;
  const networks = dockerOverview?.networks || [];
  if (heading) heading.textContent = `Networks (${networks.length})`;
  if (!networks.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state" style="border:none">No network data.</td></tr>';
    return;
  }
  tbody.innerHTML = networks.map((net) => `
    <tr>
      <td><strong>${escapeHtml(net.name)}</strong></td>
      <td>${escapeHtml(net.driver)}</td>
      <td>${escapeHtml(net.scope)}</td>
      <td>
        <div class="network-usage-cell">
          <div class="network-usage-count">${net.containerCount} container${net.containerCount === 1 ? '' : 's'}</div>
          ${net.connectedContainers?.length ? `
            <div class="network-usage-list">
              ${net.connectedContainers.map((container) => `
                <div class="network-usage-item" title="${escapeHtml(`${container.containerName}${container.ipv4 ? ` - ${container.ipv4}` : ''}${container.ipv6 ? ` - ${container.ipv6}` : ''}`)}">
                  <span class="network-usage-name">${escapeHtml(container.containerName)}</span>
                  <span class="network-usage-ip mono">${escapeHtml(container.ipv4 || container.ipv6 || '-')}</span>
                </div>
              `).join('')}
            </div>
          ` : '<span class="muted-copy">No attached containers detected</span>'}
        </div>
      </td>
    </tr>
  `).join('');
}

function renderDockerVolumes(dockerOverview) {
  const tbody = document.getElementById('dockerVolumeRows');
  const heading = document.getElementById('dockerVolumesHeading');
  if (!tbody) return;
  const volumes = dockerOverview?.volumes || [];
  if (heading) heading.textContent = `Volumes (${volumes.length})`;
  if (!volumes.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state" style="border:none">No volume data.</td></tr>';
    return;
  }
  tbody.innerHTML = volumes.map((v) => `
    <tr>
      <td class="mono" title="${escapeHtml(v.name)}">${escapeHtml(v.name.length > 30 ? v.name.slice(0, 30) + '...' : v.name)}</td>
      <td>${escapeHtml(v.driver)}</td>
      <td class="mono url-text" title="${escapeHtml(v.mountpoint)}">${escapeHtml(v.mountpoint)}</td>
    </tr>
  `).join('');
}

function renderConfigExplorer(configSnapshot) {
  const summaryEl = document.getElementById('configSummaryCards');
  const rootEl = document.getElementById('configRootLabel');
  const composeSummaryEl = document.getElementById('configComposeSummary');
  const fileListEl = document.getElementById('configFileList');
  const viewerPathEl = document.getElementById('configViewerPath');
  const viewerTitleEl = document.getElementById('configViewerTitle');
  const viewerMetaEl = document.getElementById('configViewerMeta');
  const viewerContentEl = document.getElementById('configViewerContent');
  if (!summaryEl || !fileListEl || !viewerContentEl) return;

  const defaultRootPath = '/host-root';
  const expectedHostPath = 'Set CONFIG_ROOT_PATH to a mounted host directory that contains your docker-compose.yml or Caddyfile.';

  const snapshot = configSnapshot || { available: false, files: [], composeSummary: { serviceNames: [], volumeNames: [], networkNames: [] }, envSummary: { variableCount: 0 }, rootPath: defaultRootPath };
  if (rootEl) rootEl.textContent = snapshot.rootPath || defaultRootPath;

  if (!snapshot.available) {
    summaryEl.innerHTML = '<div class="empty-state">Configuration folder is not mounted or not available inside the monitoring container.</div>';
    if (composeSummaryEl) composeSummaryEl.innerHTML = '';
    fileListEl.innerHTML = '<div class="empty-state">No config files found.</div>';
    if (viewerPathEl) viewerPathEl.textContent = 'Unavailable';
    if (viewerTitleEl) viewerTitleEl.textContent = 'Configuration Viewer';
    if (viewerMetaEl) viewerMetaEl.textContent = '';
    viewerContentEl.textContent = expectedHostPath;
    return;
  }

  const files = snapshot.files || [];
  const compose = snapshot.composeSummary || {};
  const env = snapshot.envSummary || {};
  const selectedRelPath = files.some((file) => file.relPath === state.selectedConfigFile)
    ? state.selectedConfigFile
    : (files.find((file) => /(^|\/)docker-compose\.ya?ml$/i.test(file.relPath))?.relPath
      || files.find((file) => /(^|\/)Caddyfile$/i.test(file.relPath))?.relPath
      || files[0]?.relPath
      || null);
  state.selectedConfigFile = selectedRelPath;
  const selectedFile = files.find((file) => file.relPath === selectedRelPath) || null;

  summaryEl.innerHTML = [
    createSummaryCard('Config Files', formatNumber(snapshot.fileCount || files.length), `${formatNumber(snapshot.directoryCount || 0)} folders discovered`, files.length ? 'good' : 'warn'),
    createSummaryCard('Compose Services', formatNumber((compose.serviceNames || []).length), (compose.serviceNames || []).length ? compose.serviceNames.slice(0, 3).join(' · ') : 'No compose file detected', (compose.serviceNames || []).length ? 'good' : 'warn'),
    createSummaryCard('Env Variables', formatNumber(env.variableCount || 0), env.variableCount ? 'Loaded from .env' : 'No .env file detected', env.variableCount ? 'good' : 'warn'),
    createSummaryCard('Last Updated', snapshot.lastModifiedAt ? formatShortTime(snapshot.lastModifiedAt) : '-', snapshot.totalBytes ? formatBytes(snapshot.totalBytes) : 'No text config content', 'good')
  ].join('');

  if (composeSummaryEl) {
    const serviceChips = (compose.serviceNames || []).map((name) => `<span class="config-chip">Service: ${escapeHtml(name)}</span>`);
    const volumeChips = (compose.volumeNames || []).slice(0, 4).map((name) => `<span class="config-chip subtle">Volume: ${escapeHtml(name)}</span>`);
    const networkChips = (compose.networkNames || []).slice(0, 4).map((name) => `<span class="config-chip subtle">Network: ${escapeHtml(name)}</span>`);
    composeSummaryEl.innerHTML = [...serviceChips, ...volumeChips, ...networkChips].join('') || '<span class="config-chip subtle">No compose structure parsed yet.</span>';
  }

  fileListEl.innerHTML = files.length
    ? files.map((file) => `
      <button type="button" class="config-file-item${file.relPath === selectedRelPath ? ' active' : ''}" data-config-file="${escapeHtml(file.relPath)}">
        <span class="config-file-name">${escapeHtml(file.name)}</span>
        <span class="config-file-path">${escapeHtml(file.relPath)}</span>
      </button>
    `).join('')
    : '<div class="empty-state">No config files found.</div>';

  if (!selectedFile) {
    if (viewerPathEl) viewerPathEl.textContent = 'No file selected';
    if (viewerTitleEl) viewerTitleEl.textContent = 'Configuration Viewer';
    if (viewerMetaEl) viewerMetaEl.textContent = '';
    viewerContentEl.textContent = 'No readable config files were detected.';
    return;
  }

  if (viewerPathEl) viewerPathEl.textContent = selectedFile.relPath;
  if (viewerTitleEl) viewerTitleEl.textContent = selectedFile.name;
  if (viewerMetaEl) {
    viewerMetaEl.textContent = `${formatBytes(selectedFile.size || 0)} • ${selectedFile.modifiedAt ? formatTimestamp(selectedFile.modifiedAt) : 'Unknown date'}${selectedFile.truncated ? ' • preview truncated' : ''}`;
  }
  viewerContentEl.textContent = selectedFile.content || 'File is empty.';
}

function formatDateOnly(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function renderCaddyOverview(caddyOverview) {
  const summaryEl = document.getElementById('caddySummaryCards');
  const hostsEl = document.getElementById('caddyHostsList');
  const certRowsEl = document.getElementById('caddyCertRows');
  const hostsHeadingEl = document.getElementById('caddyHostsHeading');
  const certHeadingEl = document.getElementById('caddyCertHeading');
  if (!summaryEl || !hostsEl || !certRowsEl) return;

  const overview = caddyOverview || { container: null, sites: [], certificates: [], counts: { sites: 0, hostnames: 0, certificates: 0, renewSoon: 0, urgent: 0 } };
  const container = overview.container;
  const sites = overview.sites || [];
  const certificates = overview.certificates || [];
  const counts = overview.counts || {};

  summaryEl.innerHTML = [
    createSummaryCard('Edge Caddy', container ? (container.health || container.state || 'unknown') : 'Not found', container ? `${container.name} · ${container.primaryIp || 'no IP'}` : 'Container not detected', container?.state === 'running' ? 'good' : 'bad'),
    createSummaryCard('Configured Hosts', formatNumber(counts.hostnames || 0), `${formatNumber(counts.sites || 0)} site blocks`, (counts.hostnames || 0) > 0 ? 'good' : 'warn'),
    createSummaryCard('Certificates', formatNumber(counts.certificates || 0), counts.certificates ? `${formatNumber(counts.renewSoon || 0)} renew soon` : 'No certificates found', (counts.urgent || 0) > 0 ? 'bad' : (counts.renewSoon || 0) > 0 ? 'warn' : 'good'),
    createSummaryCard('Published Ports', container?.ports && container.ports !== '-' ? container.ports : '-', container?.primaryNetwork ? `Network ${container.primaryNetwork}` : 'No network info', 'good', 'host')
  ].join('');

  if (hostsHeadingEl) hostsHeadingEl.textContent = `Configured Hosts (${sites.length})`;
  if (!sites.length) {
    hostsEl.innerHTML = '<div class="empty-state">No Caddy hosts could be parsed from the current Caddyfile.</div>';
  } else {
    hostsEl.innerHTML = sites.map((site) => {
      const hostLabels = site.hosts.length ? site.hosts : site.addresses;
      const upstreams = site.upstreams.length ? site.upstreams.join(' · ') : 'No reverse_proxy target found';
      const tlsState = site.tlsDirectives.length ? site.tlsDirectives.join(' · ') : 'Automatic HTTPS managed by Caddy';
      return `
        <article class="caddy-site-card">
          <div class="caddy-site-hosts">${hostLabels.map((host) => `<span class="caddy-host-chip">${escapeHtml(host)}</span>`).join('')}</div>
          <div class="caddy-site-meta">
            <span class="caddy-site-label">Upstream</span>
            <strong>${escapeHtml(upstreams)}</strong>
          </div>
          <div class="caddy-site-meta">
            <span class="caddy-site-label">TLS</span>
            <span>${escapeHtml(tlsState)}</span>
          </div>
          ${site.redirects.length ? `<div class="caddy-site-meta"><span class="caddy-site-label">Redirect</span><span>${escapeHtml(site.redirects.join(' · '))}</span></div>` : ''}
        </article>
      `;
    }).join('');
  }

  if (certHeadingEl) certHeadingEl.textContent = `Certificates (${certificates.length})`;
  if (!certificates.length) {
    certRowsEl.innerHTML = '<tr><td colspan="5" class="empty-state" style="border:none">No Caddy certificates were found from the current data volume.</td></tr>';
  } else {
    certRowsEl.innerHTML = certificates.map((cert) => {
      const renewalClass = cert.renewalState === 'urgent' ? 'status-5xx' : cert.renewalState === 'soon' ? 'status-4xx' : 'status-2xx';
      const renewalLabel = cert.daysRemaining == null
        ? 'Unknown'
        : cert.daysRemaining <= 0
          ? 'Expired'
          : `${cert.daysRemaining}d left`;
      return `
        <tr>
          <td>
            <div class="alert-history-title">${escapeHtml(cert.commonName)}</div>
            <div class="alert-history-desc">${escapeHtml((cert.subjectAltNames || []).join(' · ') || cert.storagePath)}</div>
          </td>
          <td class="mono">${escapeHtml(cert.issuer || '-')}</td>
          <td>${formatDateOnly(cert.validFrom)}</td>
          <td>${formatDateOnly(cert.validTo)}</td>
          <td><span class="status-badge ${renewalClass}">${escapeHtml(renewalLabel)}</span></td>
        </tr>
      `;
    }).join('');
  }
}

function renderContainersTab(data) {
  const containers = data.latest?.containers || [];
  const dockerOverview = data.dockerOverview || {};
  const snapshotGeneratedAt = data.snapshotGeneratedAt || data.latest?.generatedAt || 0;
  const containersWithLastSeen = containers.map((container) => ({
    ...container,
    lastSeenAt: container.lastSeenAt || snapshotGeneratedAt || 0
  }));
  const runningContainers = containersWithLastSeen.filter((container) => container.state === 'running');

  renderContainerFreshness(snapshotGeneratedAt, data.snapshotRefreshIntervalMs || data.refreshIntervalMs);
  renderContainerSummary(runningContainers, dockerOverview, data.caddyOverview || null);
  renderContainers(runningContainers);
  renderContainerMemChart(runningContainers);
  renderContainerCpuChart(runningContainers);
  renderDockerDiskUsage(dockerOverview);
  renderDockerImages(dockerOverview);
  renderDockerNetworks(dockerOverview);
  renderDockerVolumes(dockerOverview);
  renderStorageGrowthCharts(data.series?.storageGrowth || []);
  renderOperationsTimeline(data.events || []);
  renderConfigExplorer(data.configSnapshot || null);
  renderCaddyOverview(data.caddyOverview || null);
  renderImportantLogs(data.recentLogs || []);
  renderLiveTails(data.liveContainerLogs || []);
}

// East US server location (Virginia)
const SERVER_LAT = 37.3719;
const SERVER_LON = -79.8164;



function mercatorX(lon, w) { return ((lon + 180) / 360) * w; }
function mercatorY(lat, h) {
  const latRad = (lat * Math.PI) / 180;
  const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return (h / 2) - (h * mercN) / (2 * Math.PI);
}

function renderGeoMap(topClientIps, topCountries) {
  const mapEl = document.getElementById('geoMap');
  const listEl = document.getElementById('geoCountries');
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;

  const points = (topClientIps || []).filter((ip) => ip.lat != null && ip.lon != null && ip.country !== 'Private');
  const mapPoints = isMobile ? points.slice(0, 8) : points;
  const desktopArcLimit = 8;
  const arcPoints = isMobile ? [] : mapPoints.slice(0, desktopArcLimit);
  const hasHiddenDesktopArcs = !isMobile && mapPoints.length > desktopArcLimit;
  const countries = topCountries || [];

  const W = 900;
  const H = 460;
  const serverX = mercatorX(SERVER_LON, W);
  const serverY = mercatorY(SERVER_LAT, H);
  const maxCount = Math.max(...mapPoints.map((p) => p.count), 1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="geo-svg">`;

  svg += `
    <defs>
      <linearGradient id="geoArc" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="#7aa2ff" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#2563eb" stop-opacity="0.9"/>
      </linearGradient>
      <filter id="geoGlow">
        <feGaussianBlur stdDeviation="5" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
  `;

  svg += `<rect x="36" y="32" width="${isMobile ? 270 : hasHiddenDesktopArcs ? 290 : 230}" height="${isMobile ? 78 : hasHiddenDesktopArcs ? 76 : 60}" rx="8" fill="rgba(255,255,255,0.85)"/>`;
  svg += `<text x="48" y="50" font-size="12" fill="#6b7280" font-family="'IBM Plex Mono', monospace">${isMobile ? 'Top public IP origins to East US' : 'Public IP request flow to East US'}</text>`;
  svg += `<g transform="translate(48 72)">`;
  svg += `<circle cx="8" cy="8" r="5" fill="#2563eb" opacity="0.82" stroke="#fff" stroke-width="1"/>`;
  svg += `<text x="22" y="12" font-size="11" fill="#4b5563" font-family="Space Grotesk, sans-serif">Public IP origin</text>`;
  svg += `<polygon points="132,1 139,8 132,15 125,8" fill="#ef4444" stroke="#fff" stroke-width="1.2"/>`;
  svg += `<text x="148" y="12" font-size="11" fill="#4b5563" font-family="Space Grotesk, sans-serif">East US server</text>`;
  svg += `</g>`;
  if (isMobile) {
    svg += `<text x="48" y="95" font-size="12" fill="#4b5563" font-family="Space Grotesk, sans-serif">Simplified mobile view · swipe horizontally</text>`;
  } else if (hasHiddenDesktopArcs) {
    svg += `<text x="48" y="95" font-size="12" fill="#4b5563" font-family="Space Grotesk, sans-serif">Showing top ${desktopArcLimit} heaviest routes to reduce map clutter</text>`;
  }

  if (!isMobile) {
    arcPoints.forEach((p) => {
      const px = mercatorX(p.lon, W);
      const py = mercatorY(p.lat, H);
      const midX = (px + serverX) / 2;
      const midY = Math.max(24, Math.min(py, serverY) - 34 - Math.abs(px - serverX) * 0.08);
      const opacity = 0.2 + (p.count / maxCount) * 0.5;
      const width = 1.4 + (p.count / maxCount) * 2.6;
      svg += `<path d="M ${px} ${py} Q ${midX} ${midY} ${serverX} ${serverY}" fill="none" stroke="url(#geoArc)" stroke-width="${width.toFixed(2)}" stroke-linecap="round" opacity="${opacity.toFixed(2)}"/>`;
    });
  }

  mapPoints.forEach((p, index) => {
    const px = mercatorX(p.lon, W);
    const py = mercatorY(p.lat, H);
    const r = isMobile ? 6 + (p.count / maxCount) * 7 : 3 + (p.count / maxCount) * 5;
    svg += `<circle cx="${px}" cy="${py}" r="${(r + 4).toFixed(2)}" fill="#60a5fa" opacity="0.12" filter="url(#geoGlow)"/>`;
    svg += `<circle cx="${px}" cy="${py}" r="${r.toFixed(2)}" fill="#2563eb" opacity="0.82" stroke="#fff" stroke-width="1.3">`;
    svg += `<title>${escapeHtml(p.city ? p.city + ', ' + p.country : p.country)} — ${p.count} requests</title>`;
    svg += `</circle>`;
    if (isMobile && index < 4) {
      const label = escapeHtml(p.countryCode || p.country || '');
      svg += `<text x="${px + 10}" y="${py - 10}" font-size="14" fill="#1f2937" font-family="Space Grotesk, sans-serif" font-weight="700">${label}</text>`;
    }
  });

  svg += `<circle cx="${serverX}" cy="${serverY}" r="14" fill="#ef4444" opacity="0.16" filter="url(#geoGlow)"/>`;
  svg += `<polygon points="${serverX},${serverY - 10} ${serverX + 7},${serverY} ${serverX},${serverY + 10} ${serverX - 7},${serverY}" fill="#ef4444" stroke="#fff" stroke-width="1.5"/>`;
  svg += `<text x="${serverX + 14}" y="${serverY + 4}" font-size="12" fill="#1f2937" font-family="Space Grotesk, sans-serif" font-weight="700">East US</text>`;

  svg += `</svg>`;
  mapEl.innerHTML = `${isMobile ? '<div class="geo-mobile-hint">Swipe to explore map</div>' : ''}${svg}`;

  // Country list
  if (!countries.length) {
    listEl.innerHTML = '<div class="empty-state">No public IP geo data yet.</div>';
    return;
  }

  const totalReqs = countries.reduce((sum, c) => sum + c.count, 0);
  listEl.innerHTML = `
    <h3 class="geo-countries-title">Top Countries</h3>
    <div class="geo-country-list">
      ${countries.map((c, i) => {
        const pct = ((c.count / totalReqs) * 100).toFixed(1);
        return `
          <div class="geo-country-row">
            <span class="geo-rank">${i + 1}</span>
            <span class="geo-flag">${countryFlag(c.countryCode)}</span>
            <span class="geo-country-name">${escapeHtml(c.country)}</span>
            <div class="geo-bar-wrap"><div class="geo-bar" style="width:${pct}%"></div></div>
            <span class="geo-count">${formatNumber(c.count)}</span>
            <span class="geo-pct">${pct}%</span>
          </div>`;
      }).join('')}
    </div>
  `;
}

function renderAccessLog(entries) {
  const tbody = document.getElementById('accessLogRows');
  const counter = document.getElementById('accessLogCount');
  const paginationEl = document.getElementById('accessPagination');

  state.accessFiltered = entries || [];
  const total = state.accessFiltered.length;
  const perPage = state.accessPerPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (state.accessPage > totalPages) state.accessPage = totalPages;
  const page = state.accessPage;
  const start = (page - 1) * perPage;
  const pageEntries = state.accessFiltered.slice(start, start + perPage);

  if (!total) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state" style="border:none">No matching access log entries.</td></tr>';
    counter.textContent = '0 entries';
    if (paginationEl) paginationEl.innerHTML = '';
    return;
  }

  tbody.innerHTML = pageEntries.map((e, i) => `
    <tr data-idx="${start + i}">
      <td class="nowrap">${formatTimestamp(e.capturedAt)}</td>
      <td><span class="status-badge ${statusClass(e.status)}">${e.status}</span></td>
      <td>${e.method}</td>
      <td class="mono url-text" title="${escapeHtml(e.fullUrl || e.host + e.uri)}">${escapeHtml(e.fullUrl || e.host + e.uri)}</td>
      <td class="mono">${escapeHtml(e.clientIp || '-')}</td>
      <td class="nowrap">${e.durationMs} ms</td>
      <td class="nowrap">${formatBytes(e.size || 0)}</td>
      <td class="ua-text" title="${escapeHtml(e.userAgent || '-')}">${escapeHtml(e.userAgent || '-')}</td>
    </tr>
  `).join('');
  counter.textContent = `${start + 1}–${Math.min(start + perPage, total)} of ${total} entries`;

  if (paginationEl) {
    let btns = '';
    btns += `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">&laquo; Prev</button>`;
    const maxBtns = 7;
    let pStart = Math.max(1, page - Math.floor(maxBtns / 2));
    let pEnd = Math.min(totalPages, pStart + maxBtns - 1);
    if (pEnd - pStart + 1 < maxBtns) pStart = Math.max(1, pEnd - maxBtns + 1);
    if (pStart > 1) btns += `<button class="page-btn" data-page="1">1</button><span class="page-ellipsis">…</span>`;
    for (let i = pStart; i <= pEnd; i++) {
      btns += `<button class="page-btn${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (pEnd < totalPages) btns += `<span class="page-ellipsis">…</span><button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
    btns += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next &raquo;</button>`;
    paginationEl.innerHTML = btns;
  }
}

function renderImportantLogs(logs) {
  const wrapper = document.getElementById('importantLogs');
  const counter = document.getElementById('logCount');

  if (!logs || !logs.length) {
    wrapper.innerHTML = '<div class="empty-state">No matching log entries.</div>';
    if (counter) counter.textContent = '0 entries';
    return;
  }

  wrapper.innerHTML = logs.map((entry) => `
    <div class="log-entry">
      <div class="log-meta">
        <span>${formatTimestamp(entry.capturedAt)}</span>
        <span>${levelBadge(entry.level)} ${escapeHtml(entry.sourceName || '')}</span>
      </div>
      <div class="log-message">${escapeHtml(entry.message)}</div>
    </div>
  `).join('');
  if (counter) counter.textContent = `${logs.length} entries`;
}

function renderLiveTails(tails, searchTerm) {
  const wrapper = document.getElementById('liveTails');
  if (!tails || !tails.length) {
    wrapper.innerHTML = '<div class="empty-state">No selected container log tails available yet.</div>';
    return;
  }

  const search = (searchTerm || '').toLowerCase();

  wrapper.innerHTML = tails.map((tail) => {
    const lines = search
      ? tail.lines.filter((entry) => entry.message.toLowerCase().includes(search))
      : tail.lines;
    return `
      <div class="tail-column">
        <h3>${escapeHtml(tail.name)} <span class="tail-count">${lines.length} lines</span></h3>
        ${lines.length === 0 ? '<div class="empty-state">No matching lines.</div>' : lines.map((entry) => `
          <div class="tail-entry">
            <div class="tail-meta">
              <span>${formatTimestamp(entry.capturedAt)}</span>
              <span>${levelBadge(entry.level)}</span>
            </div>
            <div class="log-message">${escapeHtml(entry.message)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

function updateGenerationLabel(timestamp, refreshMs) {
  document.getElementById('generationLabel').textContent = `Updated ${formatShortTime(timestamp)}`;
  if (refreshMs) {
    state.refreshIntervalMs = refreshMs;
    startAutoRefresh();
    return;
  }
  updateAutoRefreshUI();
}

function renderHostChart(series) {
  const labels = series.map((entry) => formatShortTime(entry.collectedAt));
  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'CPU %',
          data: series.map((entry) => entry.cpuPercent),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.1)',
          tension: 0.35,
          fill: true
        },
        {
          label: 'Memory %',
          data: series.map((entry) => entry.memoryPercent),
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124, 58, 237, 0.08)',
          tension: 0.35,
          fill: true
        }
      ]
    },
    options: chartOptions()
  };

  if (state.hostChart) {
    state.hostChart.destroy();
  }
  state.hostChart = new Chart(document.getElementById('hostChart'), config);
}

function renderAccessChart(series) {
  const labels = series.map((entry) => formatShortTime(entry.bucketAt));
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Requests',
          data: series.map((entry) => entry.totalRequests),
          backgroundColor: 'rgba(37, 99, 235, 0.6)',
          borderRadius: 3,
          yAxisID: 'y'
        },
        {
          label: '4xx',
          data: series.map((entry) => entry.status4xx),
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.15)',
          tension: 0.35,
          type: 'line',
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 5,
          yAxisID: 'y'
        },
        {
          label: '5xx',
          data: series.map((entry) => entry.status5xx),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          tension: 0.35,
          type: 'line',
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 5,
          yAxisID: 'y'
        }
      ]
    },
    options: chartOptions(false, 'Requests')
  };

  if (state.accessChart) {
    state.accessChart.destroy();
  }
  state.accessChart = new Chart(document.getElementById('accessChart'), config);
}

function renderServiceProbes(probes, series) {
  const cardsEl = document.getElementById('serviceProbeCards');
  const canvas = document.getElementById('serviceProbeChart');
  if (!cardsEl || !canvas) return;

  const items = Array.isArray(probes) ? probes : [];
  if (!items.length) {
    cardsEl.innerHTML = '<div class="empty-state">No service probes configured.</div>';
    if (state.serviceProbeChart) {
      state.serviceProbeChart.destroy();
      state.serviceProbeChart = null;
    }
    return;
  }

  cardsEl.innerHTML = items.map((probe) => {
    const tone = probe.ok ? 'good' : 'bad';
    const meta = probe.ok
      ? `${probe.statusCode || 0} in ${formatNumber(probe.responseTimeMs || 0)} ms`
      : (probe.error || `Status ${probe.statusCode || 0}`);
    return createSummaryCard(probe.name, probe.ok ? 'Up' : 'Down', meta, tone, 'host');
  }).join('');

  const grouped = Array.isArray(series) ? series : [];
  const labels = grouped[0]?.points?.map((point) => formatShortTime(point.collectedAt)) || [];
  const palette = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#7c3aed', '#0891b2'];
  const datasets = grouped.slice(0, 6).map((probe, index) => ({
    label: probe.name,
    data: (probe.points || []).map((point) => point.ok ? point.responseTimeMs : null),
    borderColor: palette[index % palette.length],
    backgroundColor: 'transparent',
    tension: 0.35,
    spanGaps: true,
    pointRadius: 2,
    pointHoverRadius: 4
  }));

  if (state.serviceProbeChart) {
    state.serviceProbeChart.destroy();
  }
  state.serviceProbeChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: chartOptions(false, 'Response ms')
  });
}

function renderPerformanceInsights(performance) {
  const cardsEl = document.getElementById('latencySummaryCards');
  const rowsEl = document.getElementById('slowEndpointsRows');
  if (!cardsEl || !rowsEl) return;

  const details = performance || { count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, slowEndpoints: [] };
  cardsEl.innerHTML = [
    createSummaryCard('Latency Samples', formatNumber(details.count || 0), 'Requests with measured duration', 'good'),
    createSummaryCard('P50', `${formatNumber(details.p50Ms || 0)} ms`, 'Median response time', (details.p50Ms || 0) >= 1000 ? 'warn' : 'good'),
    createSummaryCard('P95', `${formatNumber(details.p95Ms || 0)} ms`, 'Tail latency', (details.p95Ms || 0) >= 2000 ? 'bad' : (details.p95Ms || 0) >= 1000 ? 'warn' : 'good'),
    createSummaryCard('P99', `${formatNumber(details.p99Ms || 0)} ms`, 'Worst regular requests', (details.p99Ms || 0) >= 3000 ? 'bad' : (details.p99Ms || 0) >= 1500 ? 'warn' : 'good'),
    createSummaryCard('Max', `${formatNumber(details.maxMs || 0)} ms`, 'Slowest observed request', (details.maxMs || 0) >= 5000 ? 'bad' : (details.maxMs || 0) >= 2000 ? 'warn' : 'good')
  ].join('');

  const slowEndpoints = Array.isArray(details.slowEndpoints) ? details.slowEndpoints : [];
  if (!slowEndpoints.length) {
    rowsEl.innerHTML = '<tr><td colspan="6" class="empty-state" style="border:none">Not enough request samples to rank slow endpoints yet.</td></tr>';
    return;
  }

  rowsEl.innerHTML = slowEndpoints.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.method || 'GET')}</td>
      <td class="mono" title="${escapeHtml(entry.host || '-')}">${escapeHtml(entry.host || '-')}</td>
      <td class="mono url-text" title="${escapeHtml(entry.uri || '/')}">${escapeHtml(entry.uri || '/')}</td>
      <td>${formatNumber(entry.count || 0)}</td>
      <td>${formatNumber(entry.p95DurationMs || 0)} ms</td>
      <td>${formatNumber(entry.errors || 0)}</td>
    </tr>
  `).join('');
}

function renderStorageGrowthCharts(series) {
  const volumeCanvas = document.getElementById('volumeGrowthChart');
  const logCanvas = document.getElementById('logGrowthChart');
  const summaryEl = document.getElementById('storageGrowthSummary');
  const volumeMetaEl = document.getElementById('volumeGrowthMeta');
  const logMetaEl = document.getElementById('logGrowthMeta');
  if (!volumeCanvas || !logCanvas) return;

  const points = Array.isArray(series) ? series : [];
  const labels = points.map((point) => formatShortTime(point.collectedAt));

  const formatStorageValue = (bytes) => {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024 * 1024) {
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatStorageDelta = (bytes) => {
    const value = Number(bytes || 0);
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${formatStorageValue(value)}`;
  };

  const buildStorageTrend = (values, type) => {
    const list = Array.isArray(values) ? values.map((value) => Number(value || 0)) : [];
    const latest = list.length ? list[list.length - 1] : 0;
    const earliest = list.length ? list[0] : 0;
    const delta = latest - earliest;
    const peak = list.length ? Math.max(...list) : 0;
    const absDelta = Math.abs(delta);
    const warnThreshold = type === 'volumes' ? 128 * 1024 * 1024 : 64 * 1024 * 1024;
    const badThreshold = type === 'volumes' ? 512 * 1024 * 1024 : 256 * 1024 * 1024;
    let tone = 'good';
    let status = `Stable across ${rangeLabel()}`;

    if (delta >= badThreshold) {
      tone = 'bad';
      status = `Rapid growth across ${rangeLabel()}`;
    } else if (delta >= warnThreshold) {
      tone = 'warn';
      status = `Growing across ${rangeLabel()}`;
    } else if (absDelta < (8 * 1024 * 1024)) {
      tone = 'good';
      status = `Flat across ${rangeLabel()}`;
    }

    return { latest, earliest, delta, peak, tone, status };
  };

  const volumes = buildStorageTrend(points.map((point) => point.volumesBytes || 0), 'volumes');
  const containerLogs = buildStorageTrend(points.map((point) => point.containerLogBytes || 0), 'logs');
  const caddyLogs = buildStorageTrend(points.map((point) => point.caddyLogBytes || 0), 'logs');
  const combinedLogsDelta = containerLogs.delta + caddyLogs.delta;
  const combinedLogsTone = combinedLogsDelta >= 256 * 1024 * 1024 ? 'bad' : combinedLogsDelta >= 64 * 1024 * 1024 ? 'warn' : 'good';
  const combinedLogsStatus = combinedLogsDelta >= 256 * 1024 * 1024
    ? 'Logs are growing quickly'
    : combinedLogsDelta >= 64 * 1024 * 1024
      ? 'Logs are accumulating'
      : 'Logs are stable';

  if (state.volumeGrowthChart) {
    state.volumeGrowthChart.destroy();
  }
  if (state.logGrowthChart) {
    state.logGrowthChart.destroy();
  }

  if (!points.length) {
    state.volumeGrowthChart = null;
    state.logGrowthChart = null;
    if (summaryEl) {
      summaryEl.innerHTML = '<div class="empty-state">Storage trend cards will appear after a few snapshots are collected.</div>';
    }
    if (volumeMetaEl) volumeMetaEl.textContent = 'Waiting for storage trend data';
    if (logMetaEl) logMetaEl.textContent = 'Waiting for storage trend data';
    return;
  }

  if (summaryEl) {
    summaryEl.innerHTML = [
      createSummaryCard('Volumes Now', formatStorageValue(volumes.latest), `${volumes.status} · ${formatStorageDelta(volumes.delta)}`, volumes.tone),
      createSummaryCard('Container Logs', formatStorageValue(containerLogs.latest), `${containerLogs.status} · ${formatStorageDelta(containerLogs.delta)}`, containerLogs.tone),
      createSummaryCard('Caddy Logs', formatStorageValue(caddyLogs.latest), `${caddyLogs.status} · ${formatStorageDelta(caddyLogs.delta)}`, caddyLogs.tone),
      createSummaryCard('Storage Signal', combinedLogsStatus, `Peak volume footprint ${formatStorageValue(volumes.peak)} in ${rangeLabel()}`, combinedLogsTone)
    ].join('');
  }

  if (volumeMetaEl) {
    volumeMetaEl.textContent = `${volumes.status} · now ${formatStorageValue(volumes.latest)} · delta ${formatStorageDelta(volumes.delta)}`;
  }
  if (logMetaEl) {
    logMetaEl.textContent = `${combinedLogsStatus} · container ${formatStorageDelta(containerLogs.delta)} · caddy ${formatStorageDelta(caddyLogs.delta)}`;
  }

  state.volumeGrowthChart = new Chart(volumeCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Volumes',
        data: points.map((point) => Math.round(((point.volumesBytes || 0) / (1024 * 1024)) * 10) / 10),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.12)',
        tension: 0.35,
        fill: true
      }]
    },
    options: chartOptions(false, 'MB')
  });

  state.logGrowthChart = new Chart(logCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Container Logs',
          data: points.map((point) => Math.round(((point.containerLogBytes || 0) / (1024 * 1024)) * 10) / 10),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.08)',
          tension: 0.35,
          fill: true
        },
        {
          label: 'Caddy Logs',
          data: points.map((point) => Math.round(((point.caddyLogBytes || 0) / (1024 * 1024)) * 10) / 10),
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.08)',
          tension: 0.35,
          fill: true
        }
      ]
    },
    options: chartOptions(false, 'MB')
  });
}

function renderOperationsTimeline(events) {
  const wrapper = document.getElementById('operationsTimeline');
  if (!wrapper) return;

  const items = Array.isArray(events) ? events : [];
  if (!items.length) {
    wrapper.innerHTML = '<div class="empty-state">No deploy, config, restart, or probe state changes captured yet.</div>';
    return;
  }

  wrapper.innerHTML = `<div class="timeline-list">${items.map((entry) => `
    <article class="timeline-item">
      <div class="timeline-time">${formatTimestamp(entry.at)}</div>
      <div>
        <div class="timeline-title-row">
          <strong>${escapeHtml(entry.title || entry.type || 'Event')}</strong>
          <span class="status-badge ${entry.severity === 'warning' ? 'status-4xx' : entry.severity === 'critical' ? 'status-5xx' : 'status-2xx'}">${escapeHtml(entry.category || 'System')}</span>
        </div>
        <div class="timeline-desc">${escapeHtml(entry.desc || '')}</div>
      </div>
    </article>
  `).join('')}</div>`;
}

function chartOptions(hasSecondaryAxis = false, primaryAxisTitle = '') {
  const scales = {
    x: {
      ticks: { color: '#6b7280', maxTicksLimit: 8, font: { size: 11 } },
      grid: { color: '#f3f4f6' }
    },
    y: {
      beginAtZero: true,
      ticks: {
        color: '#6b7280',
        font: { size: 11 },
        precision: 0,
        callback: (value) => formatNumber(value)
      },
      title: primaryAxisTitle
        ? {
            display: true,
            text: primaryAxisTitle,
            color: '#6b7280',
            font: { size: 12, weight: '600' }
          }
        : undefined,
      grid: { color: '#f3f4f6' }
    }
  };

  if (hasSecondaryAxis) {
    scales.y1 = {
      position: 'right',
      ticks: { color: '#6b7280', font: { size: 11 } },
      grid: { drawOnChartArea: false }
    };
  }

  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: '#374151', font: { size: 12 } }
      }
    },
    scales
  };
}

async function fetchDashboard(force = false) {
  if (state.dashboardRequest) {
    if (!force && state.dashboardRequestMode === 'read') {
      return state.dashboardRequest;
    }
    if (force && state.dashboardRequestMode === 'force') {
      return state.dashboardRequest;
    }
  }

  let range = state.appliedRange || '6h';
  let url;
  if (range === 'custom') {
    const from = state.appliedCustomFrom || '';
    const to = state.appliedCustomTo || '';
    if (from && to) {
      const fromMs = new Date(from).getTime();
      const toMs = new Date(to).getTime();
      if (fromMs && toMs && toMs > fromMs) {
        const customMs = toMs - fromMs;
        const baseUrl = force ? '/api/refresh' : '/api/dashboard';
        url = `${baseUrl}?range=custom&from=${fromMs}&to=${toMs}`;
      }
    }
    if (!url) range = '6h';
  }
  if (!url) {
    url = force
      ? `/api/refresh?range=${encodeURIComponent(range)}`
      : `/api/dashboard?range=${encodeURIComponent(range)}`;
  }
  const options = force ? { method: 'POST' } : {};
  const mode = force ? 'force' : 'read';
  const requestPromise = fetch(url, options)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      return response.json();
    })
    .finally(() => {
      if (state.dashboardRequest === requestPromise) {
        state.dashboardRequest = null;
        state.dashboardRequestMode = null;
      }
    });

  state.dashboardRequest = requestPromise;
  state.dashboardRequestMode = mode;
  return requestPromise;
}

function getExcludedIps() {
  const el = document.getElementById('accessExcludeIp');
  if (!el) return [];
  const raw = el.value.trim();
  if (raw) localStorage.setItem('monitor:excludeIps', raw);
  else localStorage.removeItem('monitor:excludeIps');
  if (!raw) return [];
  return raw.split(',').map((ip) => ip.trim().toLowerCase()).filter(Boolean);
}

function applyExcludeIps(entries) {
  const excludedIps = getExcludedIps();
  if (!excludedIps.length) return entries;
  return entries.filter((e) => !excludedIps.includes((e.clientIp || '').toLowerCase()));
}

function filterAccessLog() {
  const entries = (state.lastData && state.lastData.recentAccess) || [];
  const search = document.getElementById('accessSearch').value.trim().toLowerCase();
  const status = document.getElementById('accessStatusFilter').value;
  const method = document.getElementById('accessMethodFilter').value;
  const botsOnly = document.getElementById('accessBotsOnly')?.getAttribute('aria-pressed') === 'true';
  const errorsOnly = document.getElementById('accessErrorsOnly')?.getAttribute('aria-pressed') === 'true';

  let filtered = entries;

  filtered = applyExcludeIps(filtered);

  if (botsOnly) {
    filtered = filtered.filter((e) => isBotUserAgent(e.userAgent));
  }

  if (errorsOnly) {
    filtered = filtered.filter((e) => e.status >= 400);
  }

  if (status === '2xx') filtered = filtered.filter((e) => e.status >= 200 && e.status < 300);
  else if (status === '3xx') filtered = filtered.filter((e) => e.status >= 300 && e.status < 400);
  else if (status === '4xx') filtered = filtered.filter((e) => e.status >= 400 && e.status < 500);
  else if (status === '5xx') filtered = filtered.filter((e) => e.status >= 500 && e.status < 600);
  else if (status === 'errors') filtered = filtered.filter((e) => e.status >= 400);

  if (method) {
    filtered = filtered.filter((e) => e.method === method);
  }

  if (search) {
    filtered = filtered.filter((e) => {
      const url = (e.fullUrl || e.host + e.uri || '').toLowerCase();
      const ip = (e.clientIp || '').toLowerCase();
      const ua = (e.userAgent || '').toLowerCase();
      const device = parseDevice(e.userAgent).toLowerCase();
      const browser = parseBrowser(e.userAgent).toLowerCase();
      return url.includes(search) || ip.includes(search) || ua.includes(search) || device.includes(search) || browser.includes(search);
    });
  }

  state.accessPage = 1;
  renderAccessLog(filtered);
}

function applyAccessSearch(value) {
  const searchInput = document.getElementById('accessSearch');
  if (!searchInput) return;
  searchInput.value = value || '';
  filterAccessLog();
  searchInput.focus();
}

async function copyText(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function setCopyFeedback(button, text) {
  const original = button.dataset.label || 'Copy';
  button.textContent = text;
  window.clearTimeout(button._copyTimer);
  button._copyTimer = window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function addExcludedIp(ip) {
  const trimmedIp = (ip || '').trim();
  if (!trimmedIp || trimmedIp === '-') return;
  const el = document.getElementById('accessExcludeIp');
  if (!el) return;
  const parts = el.value.split(',').map((value) => value.trim()).filter(Boolean);
  if (!parts.some((value) => value.toLowerCase() === trimmedIp.toLowerCase())) {
    parts.push(trimmedIp);
  }
  el.value = parts.join(', ');
  localStorage.setItem('monitor:excludeIps', el.value);
  filterAccessLog();
}

function filterLogs() {
  const entries = (state.lastData && state.lastData.recentLogs) || [];
  const search = document.getElementById('logSearch').value.trim().toLowerCase();
  const level = document.getElementById('logLevelFilter').value;

  let filtered = entries;

  if (level) {
    filtered = filtered.filter((e) => e.level === level);
  }

  if (search) {
    filtered = filtered.filter((e) => {
      const msg = (e.message || '').toLowerCase();
      const src = (e.sourceName || '').toLowerCase();
      return msg.includes(search) || src.includes(search);
    });
  }

  renderImportantLogs(filtered);
}

/* ── Alert Generation & Bell ──────────────────────── */

function generateAlerts(data) {
  if (Array.isArray(data?.alerts) && data.alerts.length) {
    return data.alerts;
  }

  const alerts = [];
  const host = data.latest?.host;
  const access = data.recentAccess || [];
  const summary = data.latest?.summary || {};
  const containers = data.latest?.containers || [];

  // — Host resource alerts —
  if (host) {
    if (host.cpuPercent >= 85) {
      alerts.push({ id: 'host:cpu', severity: 'critical', category: 'Host', title: 'CPU usage critical', desc: `CPU at ${host.cpuPercent}% — exceeds the 85% critical threshold. Load averages: ${host.loadAverage.join(' / ')}. Sustained high CPU can cause slow responses and container instability. Investigate top processes or consider scaling up.`, state: 'active' });
    } else if (host.cpuPercent >= 65) {
      alerts.push({ id: 'host:cpu', severity: 'warning', category: 'Host', title: 'CPU usage elevated', desc: `CPU at ${host.cpuPercent}% — approaching the 85% critical threshold. This is a warning that resource headroom is shrinking. Monitor the trend and check for unexpected workloads.`, state: 'active' });
    }

    if (host.memoryPercent >= 85) {
      alerts.push({ id: 'host:memory', severity: 'critical', category: 'Host', title: 'Memory usage critical', desc: `Memory at ${host.memoryPercent}% — ${host.memoryUsedMb} MB of ${host.memoryTotalMb} MB used. When memory runs out the system may start OOM-killing containers or processes. Consider freeing caches, restarting leaky services, or adding RAM.`, state: 'active' });
    } else if (host.memoryPercent >= 70) {
      alerts.push({ id: 'host:memory', severity: 'warning', category: 'Host', title: 'Memory usage elevated', desc: `Memory at ${host.memoryPercent}% — ${host.memoryUsedMb} MB of ${host.memoryTotalMb} MB in use. The 85% critical threshold is approaching. Check for memory-hungry containers or build caches consuming RAM.`, state: 'active' });
    }

    if (host.diskPercent >= 90) {
      alerts.push({ id: 'host:disk', severity: 'critical', category: 'Host', title: 'Disk space critical', desc: `Disk at ${host.diskPercent}% — ${host.diskUsedGb} GB of ${host.diskTotalGb} GB used. Running out of disk space can crash databases, prevent Docker from pulling images, and corrupt logs. Clean up old images (docker system prune) or expand the volume.`, state: 'active' });
    } else if (host.diskPercent >= 80) {
      alerts.push({ id: 'host:disk', severity: 'warning', category: 'Host', title: 'Disk space warning', desc: `Disk at ${host.diskPercent}% — ${host.diskUsedGb} GB of ${host.diskTotalGb} GB used. The 90% critical threshold is approaching. Consider removing unused Docker images, old logs, or temporary build artifacts.`, state: 'active' });
    }

    if (host.swapTotalMb > 0) {
      const swapPct = Math.round((host.swapUsedMb / host.swapTotalMb) * 100);
      if (swapPct >= 85) {
        alerts.push({ id: 'host:swap', severity: 'critical', category: 'Host', title: 'Swap usage critical', desc: `Swap at ${swapPct}% — ${host.swapUsedMb} MB of ${host.swapTotalMb} MB used. Heavy swap usage means the system is paging memory to disk, causing significant performance degradation. Physical RAM is nearly exhausted; investigate high-memory processes.`, state: 'active' });
      } else if (swapPct >= 50) {
        alerts.push({ id: 'host:swap', severity: 'warning', category: 'Host', title: 'Swap usage elevated', desc: `Swap at ${swapPct}% — ${host.swapUsedMb} MB of ${host.swapTotalMb} MB used. The system is dipping into swap, which means physical memory is under pressure. Performance may degrade as disk-backed memory is much slower than RAM.`, state: 'active' });
      }
    }
  }

  // — Traffic & error alerts —
  const errorRate = parseFloat(summary.requestErrorRate) || 0;
  if (errorRate >= 10) {
    alerts.push({ id: 'traffic:error-rate', severity: 'critical', category: 'Traffic', title: 'High error rate', desc: `${errorRate}% of requests returned 4xx/5xx status codes — ${summary.totalErrorsLastHour} errors in the last hour. A rate above 10% signals a serious problem such as a broken route, backend crash, or upstream failure. Check the HTTP Errors table for patterns.`, state: 'active' });
  } else if (errorRate >= 3) {
    alerts.push({ id: 'traffic:error-rate', severity: 'warning', category: 'Traffic', title: 'Elevated error rate', desc: `${errorRate}% of requests returned errors — ${summary.totalErrorsLastHour} errors in the last hour. The warning threshold is 3%. Common causes include bots hitting missing pages, broken API calls, or misconfigured redirects. Review the HTTP Errors table to identify the affected paths.`, state: 'active' });
  }

  const r5xx = access.filter((e) => e.status >= 500).length;
  if (r5xx > 0) {
    alerts.push({ id: 'traffic:server-errors', severity: r5xx >= 10 ? 'critical' : 'warning', category: 'Traffic', title: `${r5xx} server error${r5xx > 1 ? 's' : ''} (5xx)`, desc: `${r5xx} request${r5xx > 1 ? 's' : ''} returned 5xx (server error) status in the current time range. 5xx errors mean the server or an upstream service failed to handle the request — this is different from 4xx client errors. Common causes: application crash, timeout, out-of-memory, or misconfigured reverse proxy.`, state: 'active' });
  }

  // — Bot / suspicious traffic alerts —
  const bots = access.filter((e) => isBotUserAgent(e.userAgent));
  if (access.length > 0) {
    const botPct = Math.round((bots.length / access.length) * 100);
    if (botPct >= 40) {
      alerts.push({ id: 'security:bot-traffic', severity: 'warning', category: 'Security', title: 'Heavy bot traffic', desc: `${botPct}% of all requests (${formatNumber(bots.length)} of ${formatNumber(access.length)}) come from known bot user agents. Heavy bot traffic can skew analytics, waste bandwidth, and increase server load. Consider blocking aggressive crawlers or serving them cached responses.`, state: 'active' });
    }
  }

  // Suspicious: single IP making too many requests
  if (access.length > 20) {
    const ipCounts = {};
    access.forEach((e) => { if (e.clientIp) ipCounts[e.clientIp] = (ipCounts[e.clientIp] || 0) + 1; });
    const topIps = Object.entries(ipCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [ip, count] of topIps) {
      const pct = Math.round((count / access.length) * 100);
      if (pct >= 50 && count > 50) {
        alerts.push({ id: `security:ip-concentration:${ip}`, severity: 'warning', category: 'Security', title: 'Suspicious IP concentration', desc: `IP ${ip} accounts for ${pct}% of total traffic (${formatNumber(count)} of ${formatNumber(access.length)} requests). A single IP generating this much traffic may indicate a scraper, DDoS attempt, or misconfigured client. Check if this IP should be rate-limited or blocked.`, state: 'active' });
      }
    }
  }

  // — Container alerts —
  for (const c of containers) {
    if (c.state && c.state !== 'running') {
      alerts.push({ id: `containers:down:${c.name || c.id}`, severity: 'critical', category: 'Containers', title: `Container down: ${c.name || c.id}`, desc: `Container "${c.name || c.id}" is in state "${c.state}" instead of "running". A stopped container means that service is currently unavailable. Check docker logs for crash reasons and consider restarting it.`, state: 'active' });
    }
  }

  // — Overall health —
  if (alerts.length === 0) {
    alerts.push({ id: 'system:healthy', severity: 'healthy', category: 'System', title: 'All systems healthy', desc: 'No thresholds have been exceeded. All host resources (CPU, memory, disk, swap) are within normal ranges, error rates are low, and all containers are running. The system is operating normally.', state: 'active' });
  }

  return alerts;
}

function buildAlertMeta(item) {
  const meta = [];
  if (item.state === 'read' && item.readAt) {
    meta.push(`Read ${formatRelativeTime(item.readAt)} (${formatShortTime(item.readAt)})`);
  } else if (item.state === 'acknowledged' && item.acknowledgedAt) {
    meta.push(`Acknowledged ${formatRelativeTime(item.acknowledgedAt)} (${formatShortTime(item.acknowledgedAt)})`);
  } else if (item.state === 'snoozed' && item.snoozedUntil) {
    meta.push(`Snoozed until ${formatShortTime(item.snoozedUntil)}`);
  } else if (item.state === 'cleared' && item.clearedAt) {
    meta.push(`Cleared ${formatRelativeTime(item.clearedAt)} (${formatShortTime(item.clearedAt)})`);
  } else if (item.severity !== 'healthy') {
    meta.push('Unread');
  }
  if (item.firstSeenAt) {
    meta.push(`Detected ${formatRelativeTime(item.firstSeenAt)} (${formatShortTime(item.firstSeenAt)})`);
  }
  if (item.lastSeenAt) {
    meta.push(`Last seen ${formatRelativeTime(item.lastSeenAt)} (${formatShortTime(item.lastSeenAt)})`);
  }
  if (item.notifiedAt) {
    meta.push(`Notified ${formatRelativeTime(item.notifiedAt)} (${formatShortTime(item.notifiedAt)})`);
  }
  return meta;
}

function renderAlertBell(data) {
  const bellBtn = document.getElementById('alertBellBtn');
  const listEl = document.getElementById('alertList');
  const countEl = document.getElementById('alertPanelCount');
  const labelEl = document.getElementById('alertBellLabel');
  const markAllReadBtn = document.getElementById('alertMarkAllReadBtn');
  const acknowledgeAllBtn = document.getElementById('alertAcknowledgeAllBtn');
  const clearAllBtn = document.getElementById('alertClearAllBtn');
  const restoreBtn = document.getElementById('alertRestoreBtn');
  if (!bellBtn || !listEl) return;

  const allAlerts = generateAlerts(data);
  const alerts = allAlerts.filter((item) => item.state !== 'cleared');
  const clearedCount = allAlerts.filter((item) => item.state === 'cleared').length;

  const actionableAlerts = alerts.filter((item) => item.severity === 'critical' || item.severity === 'warning');
  const unreadActionable = actionableAlerts.filter((item) => !['read', 'acknowledged', 'snoozed'].includes(item.state));
  const criticals = unreadActionable.filter((item) => item.severity === 'critical');
  const warnings = unreadActionable.filter((item) => item.severity === 'warning');

  // Update bell badge
  const existingBadge = bellBtn.querySelector('.alert-badge');
  if (existingBadge) existingBadge.remove();

  bellBtn.classList.remove('has-alerts', 'has-warnings');
  if (criticals.length > 0) {
    bellBtn.classList.add('has-alerts');
    bellBtn.insertAdjacentHTML('beforeend', `<span class="alert-badge">${unreadActionable.length}</span>`);
    labelEl.textContent = 'Alerts';
  } else if (warnings.length > 0) {
    bellBtn.classList.add('has-warnings');
    bellBtn.insertAdjacentHTML('beforeend', `<span class="alert-badge warn-badge">${unreadActionable.length}</span>`);
    labelEl.textContent = 'Alerts';
  } else if (actionableAlerts.length > 0) {
    labelEl.textContent = 'Read';
  } else {
    labelEl.textContent = 'Healthy';
  }

  // Update count label
  if (countEl) {
    if (actionableAlerts.length > 0) {
      countEl.textContent = `${unreadActionable.length} unread • ${actionableAlerts.length} visible`;
    } else if (clearedCount > 0) {
      countEl.textContent = `${clearedCount} cleared`;
    } else {
      countEl.textContent = 'All clear';
    }
  }

  if (markAllReadBtn) markAllReadBtn.style.display = unreadActionable.length > 0 ? '' : 'none';
  if (acknowledgeAllBtn) acknowledgeAllBtn.style.display = actionableAlerts.length > 0 ? '' : 'none';
  if (clearAllBtn) clearAllBtn.style.display = actionableAlerts.length > 0 ? '' : 'none';
  if (restoreBtn) restoreBtn.style.display = clearedCount > 0 ? '' : 'none';

  // Render alert items grouped by category
  const categories = {};
  alerts.forEach((a) => {
    if (!categories[a.category]) categories[a.category] = [];
    categories[a.category].push(a);
  });

  const severityOrder = { critical: 0, warning: 1, info: 2, healthy: 3 };
  const sortedCategories = Object.entries(categories).sort((a, b) => {
    const aMin = Math.min(...a[1].map((x) => severityOrder[x.severity] ?? 2));
    const bMin = Math.min(...b[1].map((x) => severityOrder[x.severity] ?? 2));
    return aMin - bMin;
  });

  let html = '';
  for (const [cat, items] of sortedCategories) {
    html += `<div class="alert-section-label">${escapeHtml(cat)}</div>`;
    for (const item of items) {
      const meta = buildAlertMeta(item);
      const showActions = item.severity !== 'healthy';
      const stateLabel = item.state === 'read'
        ? 'Read'
        : item.state === 'acknowledged'
          ? 'Acknowledged'
          : item.state === 'snoozed'
            ? 'Snoozed'
            : 'Active';
      html += `
        <div class="alert-item${item.state === 'read' ? ' is-read' : ''}">
          <span class="alert-dot ${item.severity}"></span>
          <div class="alert-body">
            <div class="alert-title-row">
              <p class="alert-title">${escapeHtml(item.title)}</p>
              ${showActions ? `<span class="alert-state-pill ${escapeHtml(item.state || 'active')}">${escapeHtml(stateLabel)}</span>` : ''}
            </div>
            <p class="alert-desc">${escapeHtml(item.desc)}</p>
            ${meta.length ? `<p class="alert-meta">${escapeHtml(meta.join(' • '))}</p>` : ''}
          </div>
          ${showActions ? `<div class="alert-actions">
            ${!['acknowledged', 'snoozed'].includes(item.state) ? `<button type="button" class="alert-action-btn" data-alert-action="acknowledge" data-alert-id="${escapeHtml(item.id)}">Acknowledge</button>` : ''}
            ${item.state !== 'snoozed' ? `<button type="button" class="alert-action-btn" data-alert-action="snooze-1h" data-alert-id="${escapeHtml(item.id)}">Snooze 1h</button>` : ''}
            ${item.state !== 'read' ? `<button type="button" class="alert-action-btn" data-alert-action="mark-read" data-alert-id="${escapeHtml(item.id)}">Mark read</button>` : ''}
            <button type="button" class="alert-action-btn clear" data-alert-action="clear" data-alert-id="${escapeHtml(item.id)}">Clear</button>
          </div>` : ''}
        </div>`;
    }
  }
  if (!html) {
    html = clearedCount > 0
      ? '<div class="alert-empty">All current alerts are cleared. Use Restore cleared to make them visible again.</div>'
      : '<div class="alert-empty">All systems healthy — no alerts.</div>';
  }
  listEl.innerHTML = html;
}

async function render() {
  const data = await fetchDashboard(false);
  state.lastData = data;
  updateWhitelistUI(data.whitelistIps || []);
  if (!data.latest) {
    return;
  }

  renderSummary(data.latest, data.recentAccess || []);
  renderHostMetrics(data.latest, data.series.host || []);
  renderTopUrls(data.topUrls || []);
  renderTopClientIps(data.topClientIps || []);
  renderErrorBreakdown(data.recentErrors || []);
  renderGeoMap(data.topClientIps || [], data.topCountries || []);
  renderAccessSection(data.recentAccess || []);
  renderBotDetection(data.recentAccess || []);
  renderContainersTab(data);
  renderHostChart(data.series.host || []);
  renderAccessChart(data.series.access || []);
  renderServiceProbes(data.serviceProbes || [], data.series.serviceProbes || []);
  renderPerformanceInsights(data.performance || null);
  renderLogsOverview(data);
  renderDiskUsageHotspots(data.diskUsageHotspots || null);
  renderTopProcesses(data.topProcesses || null);
  renderSystemAlertsTable(data.alertHistory || []);
  renderAlertBell(data);
  updateGenerationLabel(data.generatedAt, data.refreshIntervalMs);
}

async function refreshNow() {
  const button = document.getElementById('refreshButton');
  if (!button) {
    return;
  }

  button.disabled = true;
  button.textContent = 'Refreshing...';
  try {
    const data = await fetchDashboard(true);
    state.lastData = data;
    updateWhitelistUI(data.whitelistIps || []);
    renderSummary(data.latest, data.recentAccess || []);
    renderHostMetrics(data.latest, data.series.host || []);
    renderTopUrls(data.topUrls || []);
    renderTopClientIps(data.topClientIps || []);
    renderErrorBreakdown(data.recentErrors || []);
    renderGeoMap(data.topClientIps || [], data.topCountries || []);
    renderAccessSection(data.recentAccess || []);
    renderBotDetection(data.recentAccess || []);
    renderContainersTab(data);
    renderHostChart(data.series.host || []);
    renderAccessChart(data.series.access || []);
    renderServiceProbes(data.serviceProbes || [], data.series.serviceProbes || []);
    renderPerformanceInsights(data.performance || null);
    renderLogsOverview(data);
    renderDiskUsageHotspots(data.diskUsageHotspots || null);
    renderTopProcesses(data.topProcesses || null);
    renderSystemAlertsTable(data.alertHistory || []);
    renderAlertBell(data);
    updateGenerationLabel(data.generatedAt, data.refreshIntervalMs);
  } catch (error) {
    showLoadError(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh Now';
  }
}

function startMonitoringDashboard() {
  if (state.started) {
    return;
  }

  state.started = true;

  // Restore persisted exclude IPs
  const savedExclude = localStorage.getItem('monitor:excludeIps');
  if (savedExclude) {
    const el = document.getElementById('accessExcludeIp');
    if (el) el.value = savedExclude;
  }
  const savedAutoRefresh = localStorage.getItem('monitor:autoRefreshEnabled');
  if (savedAutoRefresh === 'false') {
    state.autoRefreshEnabled = false;
  }
  updateAutoRefreshUI();

  // Range selector
  const savedRange = localStorage.getItem('monitor:range');
  if (savedRange && ['5m', '1h', '6h', '24h', '3d', '7d', '14d', 'custom'].includes(savedRange)) {
    state.selectedRange = savedRange;
    state.appliedRange = savedRange;
    if (savedRange === 'custom') {
      const sf = localStorage.getItem('monitor:customFrom');
      const st = localStorage.getItem('monitor:customTo');
      if (sf) {
        document.getElementById('customFrom').value = sf;
        state.appliedCustomFrom = sf;
      }
      if (st) {
        document.getElementById('customTo').value = st;
        state.appliedCustomTo = st;
      }
    }
  }
  syncRangeUi();

  document.querySelectorAll('.range-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedRange = btn.dataset.range;
      syncRangeUi();
    });
  });

  document.getElementById('rangeApplyBtn')?.addEventListener('click', () => {
    applySelectedRange().catch(showLoadError);
  });
  document.getElementById('customFrom')?.addEventListener('input', updateRangeApplyButton);
  document.getElementById('customTo')?.addEventListener('input', updateRangeApplyButton);
  document.getElementById('customFrom')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('rangeApplyBtn')?.disabled) {
      applySelectedRange().catch(showLoadError);
    }
  });
  document.getElementById('customTo')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !document.getElementById('rangeApplyBtn')?.disabled) {
      applySelectedRange().catch(showLoadError);
    }
  });

  // Tab switching
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      showTab(btn.dataset.tab);
    });
  });

  document.getElementById('refreshButton')?.addEventListener('click', () => {
    refreshNow().catch(showLoadError);
  });
  document.getElementById('autoRefreshToggle')?.addEventListener('click', () => toggleAutoRefresh());

  // Alert bell toggle
  document.getElementById('alertBellBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('alertPanel');
    if (panel) panel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('alertPanel');
    const wrap = e.target.closest('.alert-bell-wrap');
    if (panel && !wrap) panel.classList.remove('open');
  });
  document.getElementById('alertMarkAllReadBtn')?.addEventListener('click', (e) => {
    markAllAlertsRead(e.currentTarget).catch(() => {});
  });
  document.getElementById('alertAcknowledgeAllBtn')?.addEventListener('click', (e) => {
    acknowledgeAllAlerts(e.currentTarget).catch(() => {});
  });
  document.getElementById('alertClearAllBtn')?.addEventListener('click', (e) => {
    clearAllAlerts(e.currentTarget).catch(() => {});
  });
  document.getElementById('alertRestoreBtn')?.addEventListener('click', (e) => {
    restoreClearedAlerts(e.currentTarget).catch(() => {});
  });
  document.getElementById('alertList')?.addEventListener('click', (e) => {
    const button = e.target.closest('.alert-action-btn');
    if (!button) return;
    const alertId = button.dataset.alertId || '';
    const action = button.dataset.alertAction || '';
    if (action === 'mark-read') {
      markAlertRead(alertId, button).catch(() => {});
      return;
    }
    if (action === 'acknowledge') {
      acknowledgeAlert(alertId, button).catch(() => {});
      return;
    }
    if (action === 'snooze-1h') {
      snoozeAlert(alertId, '1h', button).catch(() => {});
      return;
    }
    if (action === 'snooze-24h') {
      snoozeAlert(alertId, '24h', button).catch(() => {});
      return;
    }
    if (action === 'clear') {
      clearAlert(alertId, button).catch(() => {});
    }
  });
  document.getElementById('saveWhitelistBtn')?.addEventListener('click', () => saveWhitelist().catch(() => {}));
  document.getElementById('whitelistIps')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveWhitelist().catch(() => {});
  });

  // Access log filters
  document.getElementById('accessFilterBtn')?.addEventListener('click', () => filterAccessLog());
  document.getElementById('accessClearBtn')?.addEventListener('click', () => {
    document.getElementById('accessSearch').value = '';
    document.getElementById('accessStatusFilter').value = '';
    document.getElementById('accessMethodFilter').value = '';
    setBotsOnlyUI(false);
    setErrorsOnlyUI(false);
    document.getElementById('accessExcludeIp').value = '';
    localStorage.removeItem('monitor:excludeIps');
    state.accessPage = 1;
    if (state.lastData) renderAccessSection(state.lastData.recentAccess || []);
  });
  document.getElementById('accessBotsOnly')?.addEventListener('click', () => {
    const current = document.getElementById('accessBotsOnly')?.getAttribute('aria-pressed') === 'true';
    setBotsOnlyUI(!current);
    filterAccessLog();
  });
  document.getElementById('accessErrorsOnly')?.addEventListener('click', () => {
    const current = document.getElementById('accessErrorsOnly')?.getAttribute('aria-pressed') === 'true';
    setErrorsOnlyUI(!current);
    filterAccessLog();
  });
  document.getElementById('accessSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') filterAccessLog();
  });

  // Per-page selector
  document.getElementById('accessPerPage')?.addEventListener('change', (e) => {
    state.accessPerPage = parseInt(e.target.value, 10);
    state.accessPage = 1;
    renderAccessLog(state.accessFiltered);
  });

  // Pagination clicks (delegated)
  document.getElementById('accessPagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    state.accessPage = parseInt(btn.dataset.page, 10);
    renderAccessLog(state.accessFiltered);
    document.getElementById('accessLogRows')?.closest('.table-scroll')?.scrollTo(0, 0);
  });

  // Double-click access log row to expand full details
  document.getElementById('accessLogRows')?.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tr');
    if (!row || row.classList.contains('detail-row')) return;
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('detail-row')) {
      existing.remove();
      return;
    }
    const idx = parseInt(row.dataset.idx, 10);
    const entry = state.accessFiltered[idx];
    if (!entry) return;
    const detailFields = [
      { label: 'Time', value: formatTimestamp(entry.capturedAt) },
      { label: 'Status', value: String(entry.status || '-') },
      { label: 'Method', value: entry.method || '-' },
      { label: 'Protocol', value: entry.proto || '-' },
      { label: 'Host', value: entry.host || '-', mono: true, filterable: true },
      { label: 'Path', value: entry.uri || '-', mono: true, stack: true, filterable: true, copyable: true },
      { label: 'Full URL', value: entry.fullUrl || `${entry.host || ''}${entry.uri || ''}` || '-', mono: true, stack: true, filterable: true, copyable: true },
      { label: 'Client IP', value: entry.clientIp || '-', mono: true, filterable: true, copyable: true },
      { label: 'Duration', value: `${entry.durationMs || 0} ms` },
      { label: 'Response Size', value: formatBytes(entry.size || 0) },
      { label: 'Device', value: parseDevice(entry.userAgent), filterable: true },
      { label: 'Browser', value: parseBrowser(entry.userAgent), filterable: true },
      { label: 'User Agent', value: entry.userAgent || '-', mono: true, stack: true, filterable: true, copyable: true }
    ];
    const detail = document.createElement('tr');
    detail.className = 'detail-row';
    detail.innerHTML = `<td colspan="8"><div class="detail-content">${detailFields.map((field) => `<div class="detail-field${field.stack ? ' detail-field--stack' : ''}"><span class="detail-label">${escapeHtml(field.label)}</span><div class="detail-main"><button class="detail-value${field.mono ? ' mono' : ''}${field.filterable ? ' detail-filter' : ''}"${field.filterable ? ` type="button" data-filter="${escapeHtml(field.value)}" title="Filter access log by ${escapeHtml(field.label)}"` : ' type="button" disabled'}>${escapeHtml(field.value)}</button>${field.copyable ? `<button type="button" class="detail-copy" data-copy="${escapeHtml(field.value)}" data-label="Copy" title="Copy ${escapeHtml(field.label)}">Copy</button>` : ''}</div></div>`).join('')}<div class="detail-actions">${entry.clientIp && entry.clientIp !== '-' ? `<button type="button" class="detail-exclude" data-ip="${escapeHtml(entry.clientIp)}">Exclude this IP</button>` : ''}</div></div></td>`;
    row.after(detail);
  });

  document.getElementById('accessLogRows')?.addEventListener('click', async (e) => {
    const excludeButton = e.target.closest('.detail-exclude');
    if (excludeButton) {
      addExcludedIp(excludeButton.dataset.ip || '');
      return;
    }

    const filterButton = e.target.closest('.detail-filter');
    if (filterButton && !filterButton.disabled) {
      applyAccessSearch(filterButton.dataset.filter || '');
      return;
    }

    const copyButton = e.target.closest('.detail-copy');
    if (!copyButton) return;
    try {
      await copyText(copyButton.dataset.copy || '');
      setCopyFeedback(copyButton, 'Copied');
    } catch {
      setCopyFeedback(copyButton, 'Failed');
    }
  });

  // Error per-page selector
  document.getElementById('errorPerPage')?.addEventListener('change', (e) => {
    state.errorPerPage = parseInt(e.target.value, 10);
    state.errorPage = 1;
    renderErrorPage();
  });

  // Error pagination clicks (delegated)
  document.getElementById('errorPagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    state.errorPage = parseInt(btn.dataset.page, 10);
    renderErrorPage();
    document.getElementById('errorBreakdown')?.querySelector('.table-scroll')?.scrollTo(0, 0);
  });

  document.getElementById('systemAlertsFilterBtn')?.addEventListener('click', () => {
    state.systemAlertsPage = 1;
    renderSystemAlertsTable((state.lastData && state.lastData.alertHistory) || []);
  });
  document.getElementById('systemAlertsClearBtn')?.addEventListener('click', () => {
    const searchInput = document.getElementById('systemAlertsSearch');
    if (searchInput) searchInput.value = '';
    state.systemAlertsPage = 1;
    renderSystemAlertsTable((state.lastData && state.lastData.alertHistory) || []);
  });
  document.getElementById('systemAlertsSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.systemAlertsPage = 1;
      renderSystemAlertsTable((state.lastData && state.lastData.alertHistory) || []);
    }
  });
  document.getElementById('systemAlertsPerPage')?.addEventListener('change', (e) => {
    state.systemAlertsPerPage = parseInt(e.target.value, 10);
    state.systemAlertsPage = 1;
    renderSystemAlertsTable(state.systemAlertsFiltered.length ? state.systemAlertsFiltered : ((state.lastData && state.lastData.alertHistory) || []));
  });
  document.getElementById('systemAlertsPagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    state.systemAlertsPage = parseInt(btn.dataset.page, 10);
    renderSystemAlertsTable((state.lastData && state.lastData.alertHistory) || []);
    document.getElementById('systemAlertsHistory')?.querySelector('.table-scroll')?.scrollTo(0, 0);
  });

  document.getElementById('diskDirectoriesPagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    state.diskDirectoriesPage = parseInt(btn.dataset.page, 10);
    renderDiskUsageHotspots(state.lastData?.diskUsageHotspots || null);
  });

  document.getElementById('diskFilesPagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
    if (!btn || btn.disabled) return;
    state.diskFilesPage = parseInt(btn.dataset.page, 10);
    renderDiskUsageHotspots(state.lastData?.diskUsageHotspots || null);
  });

  document.getElementById('errorBreakdown')?.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tbody tr');
    if (!row || row.classList.contains('detail-row')) return;
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('detail-row')) {
      existing.remove();
      return;
    }

    const idx = parseInt(row.dataset.idx, 10);
    const entry = state.errorSorted[idx];
    const sample = entry && entry.lastEntry;
    if (!entry || !sample) return;

    const detailFields = [
      { label: 'Status', value: String(entry.status || '-') },
      { label: 'Occurrences', value: formatNumber(entry.count || 0) },
      { label: 'Last Seen', value: formatTimestamp(entry.lastAt) },
      { label: 'Method', value: sample.method || '-' },
      { label: 'Protocol', value: sample.proto || '-' },
      { label: 'Host', value: sample.host || '-', mono: true, filterable: true },
      { label: 'Path', value: sample.uri || '-', mono: true, stack: true, filterable: true, copyable: true },
      { label: 'Full URL', value: sample.fullUrl || `${sample.host || ''}${sample.uri || ''}` || '-', mono: true, stack: true, filterable: true, copyable: true },
      { label: 'Last IP', value: sample.clientIp || '-', mono: true, filterable: true, copyable: true },
      { label: 'Duration', value: `${sample.durationMs || 0} ms` },
      { label: 'Response Size', value: formatBytes(sample.size || 0) },
      { label: 'Device', value: parseDevice(sample.userAgent), filterable: true },
      { label: 'Browser', value: parseBrowser(sample.userAgent), filterable: true },
      { label: 'User Agent', value: sample.userAgent || '-', mono: true, stack: true, filterable: true, copyable: true }
    ];

    const detail = document.createElement('tr');
    detail.className = 'detail-row';
    detail.innerHTML = `<td colspan="7"><div class="detail-content">${detailFields.map((field) => `<div class="detail-field${field.stack ? ' detail-field--stack' : ''}"><span class="detail-label">${escapeHtml(field.label)}</span><div class="detail-main"><button class="detail-value${field.mono ? ' mono' : ''}${field.filterable ? ' detail-filter' : ''}"${field.filterable ? ` type="button" data-filter="${escapeHtml(field.value)}" title="Filter access log by ${escapeHtml(field.label)}"` : ' type="button" disabled'}>${escapeHtml(field.value)}</button>${field.copyable ? `<button type="button" class="detail-copy" data-copy="${escapeHtml(field.value)}" data-label="Copy" title="Copy ${escapeHtml(field.label)}">Copy</button>` : ''}</div></div>`).join('')}<div class="detail-actions"><button type="button" class="detail-open-matching" data-search="${escapeHtml(sample.uri || sample.fullUrl || '')}">Open matching requests</button>${sample.clientIp && sample.clientIp !== '-' ? `<button type="button" class="detail-exclude" data-ip="${escapeHtml(sample.clientIp)}">Exclude this IP</button>` : ''}</div></div></td>`;
    row.after(detail);
  });

  document.getElementById('errorBreakdown')?.addEventListener('click', async (e) => {
    const openButton = e.target.closest('.detail-open-matching');
    if (openButton) {
      openMatchingRequests(openButton.dataset.search || '');
      return;
    }

    const excludeButton = e.target.closest('.detail-exclude');
    if (excludeButton) {
      addExcludedIp(excludeButton.dataset.ip || '');
      return;
    }

    const filterButton = e.target.closest('.detail-filter');
    if (filterButton && !filterButton.disabled) {
      applyAccessSearch(filterButton.dataset.filter || '');
      return;
    }

    const copyButton = e.target.closest('.detail-copy');
    if (!copyButton) return;
    try {
      await copyText(copyButton.dataset.copy || '');
      setCopyFeedback(copyButton, 'Copied');
    } catch {
      setCopyFeedback(copyButton, 'Failed');
    }
  });

  // Log filters
  document.getElementById('logFilterBtn')?.addEventListener('click', () => filterLogs());
  document.getElementById('logClearBtn')?.addEventListener('click', () => {
    document.getElementById('logSearch').value = '';
    document.getElementById('logLevelFilter').value = '';
    if (state.lastData) renderImportantLogs(state.lastData.recentLogs || []);
  });
  document.getElementById('logSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') filterLogs();
  });

  // Live tail search
  document.getElementById('tailSearch')?.addEventListener('input', () => {
    if (state.lastData) {
      renderLiveTails(state.lastData.liveContainerLogs || [], document.getElementById('tailSearch').value);
    }
  });
  document.getElementById('configFileList')?.addEventListener('click', (e) => {
    const button = e.target.closest('[data-config-file]');
    if (!button) return;
    state.selectedConfigFile = button.dataset.configFile || null;
    if (state.lastData) renderConfigExplorer(state.lastData.configSnapshot || null);
  });
  document.getElementById('tailClearBtn')?.addEventListener('click', () => {
    document.getElementById('tailSearch').value = '';
    if (state.lastData) renderLiveTails(state.lastData.liveContainerLogs || []);
  });

  render().catch(showLoadError);
  startAutoRefresh();
}

window.startMonitoringDashboard = startMonitoringDashboard;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => startMonitoringDashboard(), { once: true });
} else {
  startMonitoringDashboard();
}