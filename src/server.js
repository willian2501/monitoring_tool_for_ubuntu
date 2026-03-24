const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { X509Certificate } = require('crypto');
const { openDatabase } = require('./db');
const { MonitorCollector } = require('./collector');

const port = Number(process.env.PORT || 3000);
const db = openDatabase(process.env.DB_PATH || '/data/monitor.db');
const publicDir = '/usr/share/nginx/html';
const configRootPath = process.env.CONFIG_ROOT_PATH || '/host-root';
const CONFIG_CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS || 30000);

let geoLookupPromise = null;
let configSnapshotCache = { value: null, expiresAt: 0 };
let caddyOverviewCache = { value: null, expiresAt: 0, key: '' };
let alertNotifyPromise = null;

const collector = new MonitorCollector(db, {
  intervalMs: Number(process.env.COLLECTION_INTERVAL_MS || 180000),
  hostIntervalMs: Number(process.env.HOST_COLLECTION_INTERVAL_MS || 30000),
  retentionDays: Number(process.env.DATA_RETENTION_DAYS || 7),
  caddyLogDir: process.env.CADDY_LOG_DIR || '/host-caddy-logs',
  selectedLogContainers: process.env.SELECTED_LOG_CONTAINERS || '',
  configRootPath,
  serviceProbes: process.env.SERVICE_PROBES || '',
  defaultServiceProbePort: port
});

const RANGE_MS = {
  '5m': 300000,
  '1h': 3600000,
  '6h': 21600000,
  '24h': 86400000,
  '3d': 259200000,
  '7d': 604800000,
  '14d': 1209600000
};

function parseRange(str) {
  return RANGE_MS[str] || RANGE_MS['6h'];
}

function getAccessBucketMs(rangeMs) {
  if (rangeMs <= 3600000) return 60000;
  if (rangeMs <= 21600000) return 300000;
  if (rangeMs <= 86400000) return 900000;
  if (rangeMs <= 259200000) return 3600000;
  return 10800000;
}

function getHostBucketMs(rangeMs) {
  if (rangeMs <= 3600000) return 60000;
  if (rangeMs <= 21600000) return 300000;
  if (rangeMs <= 86400000) return 600000;
  if (rangeMs <= 259200000) return 1800000;
  return 3600000;
}

function normalizeIpList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)));
  }
  return Array.from(new Set(String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)));
}

function getWhitelistIps() {
  return normalizeIpList(db.getState('accessWhitelistIps', []));
}

function filterEntriesByWhitelist(entries, whitelistIps) {
  if (!whitelistIps.length) return entries;
  const set = new Set(whitelistIps);
  return entries.filter((entry) => !set.has(String(entry.clientIp || '').trim().toLowerCase()));
}

function aggregateAccessEntries(entries, bucketMs) {
  const buckets = new Map();
  entries.forEach((entry) => {
    const key = entry.capturedAt - (entry.capturedAt % bucketMs);
    if (!buckets.has(key)) {
      buckets.set(key, { bucketAt: key, totalRequests: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0 });
    }
    const bucket = buckets.get(key);
    bucket.totalRequests += 1;
    if (entry.status >= 500) bucket.status5xx += 1;
    else if (entry.status >= 400) bucket.status4xx += 1;
    else if (entry.status >= 300) bucket.status3xx += 1;
    else bucket.status2xx += 1;
  });
  return Array.from(buckets.values()).sort((a, b) => a.bucketAt - b.bucketAt);
}

function buildTopUrlsFromEntries(entries, limit = 15) {
  const urls = {};
  entries.forEach((entry) => {
    const url = entry.fullUrl || `${entry.host || ''}${entry.uri || ''}`;
    urls[url] = (urls[url] || 0) + 1;
  });
  return Object.entries(urls)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url, count]) => ({ url, count }));
}

function buildTopClientIpsFromEntries(entries, limit = 15) {
  const ips = {};
  entries.forEach((entry) => {
    if (entry.clientIp && entry.clientIp !== '-') {
      ips[entry.clientIp] = (ips[entry.clientIp] || 0) + 1;
    }
  });
  return Object.entries(ips)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ip, count]) => ({ ip, count }));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function buildPerformanceInsights(entries) {
  const durations = entries
    .map((entry) => Number(entry.durationMs || 0))
    .filter((value) => Number.isFinite(value) && value >= 0);

  const grouped = new Map();
  entries.forEach((entry) => {
    const key = `${entry.method || 'GET'} ${entry.host || '-'} ${entry.uri || '/'}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        method: entry.method || 'GET',
        host: entry.host || '-',
        uri: entry.uri || '/',
        durations: [],
        count: 0,
        errors: 0
      });
    }
    const bucket = grouped.get(key);
    bucket.count += 1;
    bucket.durations.push(Number(entry.durationMs || 0));
    if ((entry.status || 0) >= 400) {
      bucket.errors += 1;
    }
  });

  const slowEndpoints = Array.from(grouped.values())
    .map((item) => ({
      method: item.method,
      host: item.host,
      uri: item.uri,
      count: item.count,
      errors: item.errors,
      avgDurationMs: item.count ? Math.round((item.durations.reduce((sum, value) => sum + value, 0) / item.count) * 10) / 10 : 0,
      p95DurationMs: percentile(item.durations, 95),
      maxDurationMs: item.durations.length ? Math.max(...item.durations) : 0
    }))
    .filter((item) => item.count >= 2)
    .sort((left, right) => {
      if (right.p95DurationMs !== left.p95DurationMs) return right.p95DurationMs - left.p95DurationMs;
      if (right.avgDurationMs !== left.avgDurationMs) return right.avgDurationMs - left.avgDurationMs;
      return right.count - left.count;
    })
    .slice(0, 10);

  return {
    count: durations.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: durations.length ? Math.max(...durations) : 0,
    slowEndpoints
  };
}

function buildServiceProbeSeries(snapshotSeries) {
  const byProbe = new Map();
  snapshotSeries.forEach((entry) => {
    (entry.payload?.serviceProbes || []).forEach((probe) => {
      if (!byProbe.has(probe.id)) {
        byProbe.set(probe.id, {
          id: probe.id,
          name: probe.name,
          points: []
        });
      }
      byProbe.get(probe.id).points.push({
        collectedAt: entry.collectedAt,
        responseTimeMs: probe.responseTimeMs || 0,
        statusCode: probe.statusCode || 0,
        ok: Boolean(probe.ok)
      });
    });
  });
  return Array.from(byProbe.values());
}

function buildStorageGrowthSeries(snapshotSeries) {
  return snapshotSeries
    .map((entry) => ({
      collectedAt: entry.collectedAt,
      volumesBytes: Number(entry.payload?.storageGrowth?.volumesBytes || 0),
      containerLogBytes: Number(entry.payload?.storageGrowth?.containerLogBytes || 0),
      caddyLogBytes: Number(entry.payload?.storageGrowth?.caddyLogBytes || 0),
      totalLogBytes: Number(entry.payload?.storageGrowth?.totalLogBytes || 0)
    }))
    .filter((entry) => entry.volumesBytes || entry.totalLogBytes || entry.containerLogBytes || entry.caddyLogBytes);
}

function getOperationalEvents(since) {
  const events = db.getState('operations:timeline', []);
  return (Array.isArray(events) ? events : [])
    .filter((entry) => !since || (entry.at || 0) >= since)
    .sort((left, right) => (right.at || 0) - (left.at || 0))
    .slice(0, 50);
}

function safeRelativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join('/');
}

function isTextConfigFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  if (['.yml', '.yaml', '.env', '.json', '.conf', '.txt', '.md', '.caddyfile', '.toml', '.ini'].includes(ext)) return true;
  if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', '.env', 'Caddyfile'].includes(base)) return true;
  return ext === '' && !base.includes('.');
}

function summarizeCompose(content) {
  if (!content) {
    return { serviceNames: [], volumeNames: [], networkNames: [] };
  }

  const lines = String(content).split(/\r?\n/);
  const sections = { services: [], volumes: [], networks: [] };
  let currentSection = null;

  for (const line of lines) {
    const rootSection = line.match(/^(services|volumes|networks):\s*$/);
    if (rootSection) {
      currentSection = rootSection[1];
      continue;
    }
    if (!currentSection) continue;
    if (/^[^\s]/.test(line) && !/^(services|volumes|networks):\s*$/.test(line)) {
      currentSection = null;
      continue;
    }
    const itemMatch = line.match(/^  ([A-Za-z0-9._-]+):\s*$/);
    if (itemMatch) {
      sections[currentSection].push(itemMatch[1]);
    }
  }

  return {
    serviceNames: sections.services,
    volumeNames: sections.volumes,
    networkNames: sections.networks
  };
}

function summarizeEnv(content) {
  if (!content) return { variableCount: 0, keys: [] };
  const keys = String(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.slice(0, line.indexOf('=')).trim())
    .filter(Boolean);
  return { variableCount: keys.length, keys };
}

function readConfigSnapshot(rootPath) {
  const displayRoot = String(rootPath || '/host-root').replace(/^\/host-root/, '') || '/';
  if (!fs.existsSync(rootPath)) {
    return {
      available: false,
      rootPath: displayRoot,
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      files: [],
      composeSummary: { serviceNames: [], volumeNames: [], networkNames: [] },
      envSummary: { variableCount: 0, keys: [] },
      lastModifiedAt: null
    };
  }

  const preferredFileNames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Caddyfile'];
  const files = [];
  const directoryCount = 0;
  let totalBytes = 0;
  let lastModifiedAt = 0;
  const maxFileBytes = 200 * 1024;

  preferredFileNames.forEach((fileName) => {
    const fullPath = path.join(rootPath, fileName);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
    const stat = fs.statSync(fullPath);
    totalBytes += stat.size;
    lastModifiedAt = Math.max(lastModifiedAt, stat.mtimeMs || 0);
    let content = fs.readFileSync(fullPath, 'utf8');
    let truncated = false;
    if (Buffer.byteLength(content, 'utf8') > maxFileBytes) {
      content = content.slice(0, maxFileBytes);
      truncated = true;
    }
    files.push({
      relPath: safeRelativePath(rootPath, fullPath),
      name: path.basename(fullPath),
      size: stat.size,
      modifiedAt: stat.mtimeMs || 0,
      content,
      truncated
    });
  });

  const composeFile = files.find((file) => /(^|\/)docker-compose\.ya?ml$/i.test(file.relPath) || /(^|\/)compose\.ya?ml$/i.test(file.relPath));
  const envPath = path.join(rootPath, '.env');
  const envFile = fs.existsSync(envPath) && fs.statSync(envPath).isFile()
    ? { content: fs.readFileSync(envPath, 'utf8') }
    : null;

  return {
    available: true,
    rootPath: displayRoot,
    fileCount: files.length,
    directoryCount,
    totalBytes,
    files,
    composeSummary: summarizeCompose(composeFile?.content || ''),
    envSummary: summarizeEnv(envFile?.content || ''),
    lastModifiedAt: lastModifiedAt || null
  };
}

function getCachedConfigSnapshot() {
  const now = Date.now();
  if (configSnapshotCache.value && configSnapshotCache.expiresAt > now) {
    return configSnapshotCache.value;
  }
  const snapshot = readConfigSnapshot(configRootPath);
  configSnapshotCache = { value: snapshot, expiresAt: now + CONFIG_CACHE_TTL_MS };
  return snapshot;
}

function mapHostPathToMountedPath(hostPath) {
  if (!hostPath || typeof hostPath !== 'string' || !hostPath.startsWith('/')) return null;
  return path.join('/host-root', hostPath.replace(/^\/+/, ''));
}

function extractAddressesFromLabel(rawLabel) {
  return String(rawLabel || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/^https?:\/\//i, '').replace(/^tls:\/\//i, ''));
}

function parseCaddyfileSites(content) {
  const lines = String(content || '').split(/\r?\n/);
  const sites = [];
  let currentSite = null;
  let braceDepth = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (!currentSite && line === '{') {
      braceDepth += 1;
      continue;
    }

    if (!currentSite && line.endsWith('{')) {
      const label = line.slice(0, -1).trim();
      if (label) {
        const addresses = extractAddressesFromLabel(label);
        currentSite = {
          label,
          addresses,
          hosts: addresses.filter((address) => /[a-z]/i.test(address) && !address.startsWith(':')),
          upstreams: [],
          redirects: [],
          tlsDirectives: []
        };
      }
      braceDepth = 1;
      continue;
    }

    if (!currentSite) continue;

    if (line.startsWith('reverse_proxy ')) {
      const upstreamText = line.replace(/^reverse_proxy\s+/, '');
      const upstreams = upstreamText
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)
        .filter((value) => !value.startsWith('{'));
      currentSite.upstreams.push(...upstreams);
    } else if (line.startsWith('redir ') || line.startsWith('redir\t')) {
      currentSite.redirects.push(line.replace(/^redir\s+/, ''));
    } else if (line.startsWith('tls ')) {
      currentSite.tlsDirectives.push(line.replace(/^tls\s+/, ''));
    }

    const openCount = (rawLine.match(/\{/g) || []).length;
    const closeCount = (rawLine.match(/\}/g) || []).length;
    braceDepth += openCount - closeCount;
    if (braceDepth <= 0) {
      sites.push({
        ...currentSite,
        upstreams: Array.from(new Set(currentSite.upstreams)),
        redirects: Array.from(new Set(currentSite.redirects)),
        tlsDirectives: Array.from(new Set(currentSite.tlsDirectives))
      });
      currentSite = null;
      braceDepth = 0;
    }
  }

  return sites;
}

function walkForCertificates(dirPath, output) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkForCertificates(fullPath, output);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.crt')) {
      output.push(fullPath);
    }
  }
}

function readCaddyCertificates(edgeCaddyContainer) {
  if (!edgeCaddyContainer) return [];
  const dataMount = (edgeCaddyContainer.mounts || []).find((mount) => mount.destination === '/data' && mount.source);
  const mountedDataPath = mapHostPathToMountedPath(dataMount?.source || '');
  if (!mountedDataPath) return [];
  const certRoot = path.join(mountedDataPath, 'caddy', 'certificates');
  if (!fs.existsSync(certRoot)) return [];

  const certFiles = [];
  walkForCertificates(certRoot, certFiles);

  return certFiles.map((certFile) => {
    try {
      const pem = fs.readFileSync(certFile, 'utf8');
      const cert = new X509Certificate(pem);
      const validFrom = Date.parse(cert.validFrom);
      const validTo = Date.parse(cert.validTo);
      const subjectAltNames = String(cert.subjectAltName || '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('DNS:'))
        .map((part) => part.replace(/^DNS:/, '').trim());
      const commonNameMatch = String(cert.subject || '').match(/CN\s*=\s*([^,]+)/i);
      const commonName = commonNameMatch ? commonNameMatch[1].trim() : path.basename(path.dirname(certFile));
      const daysRemaining = Number.isFinite(validTo)
        ? Math.max(0, Math.ceil((validTo - Date.now()) / (24 * 60 * 60 * 1000)))
        : null;
      return {
        commonName,
        subjectAltNames,
        issuer: String(cert.issuer || '').replace(/\n/g, ', '),
        validFrom: Number.isFinite(validFrom) ? validFrom : null,
        validTo: Number.isFinite(validTo) ? validTo : null,
        daysRemaining,
        renewalState: daysRemaining == null ? 'unknown' : daysRemaining <= 14 ? 'urgent' : daysRemaining <= 30 ? 'soon' : 'healthy',
        storagePath: certFile.replace(/\\/g, '/'),
        serialNumber: cert.serialNumber || ''
      };
    } catch (_) {
      return null;
    }
  }).filter(Boolean).sort((left, right) => (left.daysRemaining ?? 999999) - (right.daysRemaining ?? 999999));
}

function buildCaddyOverview(latestPayload, configSnapshot) {
  const containers = latestPayload?.containers || [];
  const edgeCaddy = containers.find((container) => container.name === 'edge-caddy' || container.image.startsWith('caddy:')) || null;
  const caddyfile = (configSnapshot?.files || []).find((file) => file.name === 'Caddyfile');
  const sites = parseCaddyfileSites(caddyfile?.content || '');
  const certificates = readCaddyCertificates(edgeCaddy);

  return {
    container: edgeCaddy
      ? {
          name: edgeCaddy.name,
          state: edgeCaddy.state,
          status: edgeCaddy.status,
          health: edgeCaddy.health,
          image: edgeCaddy.image,
          ports: edgeCaddy.ports,
          primaryIp: edgeCaddy.primaryIp,
          primaryNetwork: edgeCaddy.primaryNetwork,
          networkNames: edgeCaddy.networkNames || []
        }
      : null,
    sites,
    certificates,
    counts: {
      sites: sites.length,
      hostnames: sites.reduce((sum, site) => sum + (site.hosts.length || site.addresses.length || 0), 0),
      certificates: certificates.length,
      renewSoon: certificates.filter((cert) => cert.renewalState === 'soon' || cert.renewalState === 'urgent').length,
      urgent: certificates.filter((cert) => cert.renewalState === 'urgent').length
    }
  };
}

function getCachedCaddyOverview(latestPayload, configSnapshot) {
  const container = (latestPayload?.containers || []).find((item) => item.name === 'edge-caddy' || item.image.startsWith('caddy:'));
  const key = JSON.stringify({
    generatedAt: latestPayload?.generatedAt || latestPayload?.summary?.totalRequestsLastHour || 0,
    configModifiedAt: configSnapshot?.lastModifiedAt || 0,
    edgeCaddyId: container?.id || '',
    edgeCaddyState: container?.state || ''
  });
  const now = Date.now();
  if (caddyOverviewCache.value && caddyOverviewCache.expiresAt > now && caddyOverviewCache.key === key) {
    return caddyOverviewCache.value;
  }
  const overview = buildCaddyOverview(latestPayload, configSnapshot);
  caddyOverviewCache = { value: overview, expiresAt: now + CONFIG_CACHE_TTL_MS, key };
  return overview;
}

function buildLatestPayloadWithFilteredAccess(latestPayload, lastHourEntries) {
  if (!latestPayload) return null;
  const totalRequestsLastHour = lastHourEntries.length;
  const totalErrorsLastHour = lastHourEntries.filter((entry) => entry.status >= 400).length;
  const total5xxLastHour = lastHourEntries.filter((entry) => entry.status >= 500).length;
  return {
    ...latestPayload,
    summary: {
      ...(latestPayload.summary || {}),
      totalRequestsLastHour,
      totalErrorsLastHour,
      total5xxLastHour,
      requestErrorRate: totalRequestsLastHour ? Math.round((totalErrorsLastHour / totalRequestsLastHour) * 1000) / 10 : 0
    }
  };
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value || 0);
}

function buildCurrentAlerts(latestPayload, accessEntries) {
  const alerts = [];
  const host = latestPayload?.host;
  const summary = latestPayload?.summary || {};
  const containers = latestPayload?.containers || [];

  if (host) {
    const loadAverage = Array.isArray(host.loadAverage) ? host.loadAverage.join(' / ') : '-';

    if (host.cpuPercent >= 85) {
      alerts.push({
        id: 'host:cpu',
        severity: 'critical',
        category: 'Host',
        title: 'CPU usage critical',
        desc: `CPU at ${host.cpuPercent}% — exceeds the 85% critical threshold. Load averages: ${loadAverage}. Sustained high CPU can cause slow responses and container instability. Investigate top processes or consider scaling up.`
      });
    } else if (host.cpuPercent >= 65) {
      alerts.push({
        id: 'host:cpu',
        severity: 'warning',
        category: 'Host',
        title: 'CPU usage elevated',
        desc: `CPU at ${host.cpuPercent}% — approaching the 85% critical threshold. This is a warning that resource headroom is shrinking. Monitor the trend and check for unexpected workloads.`
      });
    }

    if (host.memoryPercent >= 85) {
      alerts.push({
        id: 'host:memory',
        severity: 'critical',
        category: 'Host',
        title: 'Memory usage critical',
        desc: `Memory at ${host.memoryPercent}% — ${host.memoryUsedMb} MB of ${host.memoryTotalMb} MB used. When memory runs out the system may start OOM-killing containers or processes. Consider freeing caches, restarting leaky services, or adding RAM.`
      });
    } else if (host.memoryPercent >= 70) {
      alerts.push({
        id: 'host:memory',
        severity: 'warning',
        category: 'Host',
        title: 'Memory usage elevated',
        desc: `Memory at ${host.memoryPercent}% — ${host.memoryUsedMb} MB of ${host.memoryTotalMb} MB in use. The 85% critical threshold is approaching. Check for memory-hungry containers or build caches consuming RAM.`
      });
    }

    if (host.diskPercent >= 90) {
      alerts.push({
        id: 'host:disk',
        severity: 'critical',
        category: 'Host',
        title: 'Disk space critical',
        desc: `Disk at ${host.diskPercent}% — ${host.diskUsedGb} GB of ${host.diskTotalGb} GB used. Running out of disk space can crash databases, prevent Docker from pulling images, and corrupt logs. Clean up old images (docker system prune) or expand the volume.`
      });
    } else if (host.diskPercent >= 80) {
      alerts.push({
        id: 'host:disk',
        severity: 'warning',
        category: 'Host',
        title: 'Disk space warning',
        desc: `Disk at ${host.diskPercent}% — ${host.diskUsedGb} GB of ${host.diskTotalGb} GB used. The 90% critical threshold is approaching. Consider removing unused Docker images, old logs, or temporary build artifacts.`
      });
    }

    if (host.swapTotalMb > 0) {
      const swapPct = Math.round((host.swapUsedMb / host.swapTotalMb) * 100);
      if (swapPct >= 85) {
        alerts.push({
          id: 'host:swap',
          severity: 'critical',
          category: 'Host',
          title: 'Swap usage critical',
          desc: `Swap at ${swapPct}% — ${host.swapUsedMb} MB of ${host.swapTotalMb} MB used. Heavy swap usage means the system is paging memory to disk, causing significant performance degradation. Physical RAM is nearly exhausted; investigate high-memory processes.`
        });
      } else if (swapPct >= 50) {
        alerts.push({
          id: 'host:swap',
          severity: 'warning',
          category: 'Host',
          title: 'Swap usage elevated',
          desc: `Swap at ${swapPct}% — ${host.swapUsedMb} MB of ${host.swapTotalMb} MB used. The system is dipping into swap, which means physical memory is under pressure. Performance may degrade as disk-backed memory is much slower than RAM.`
        });
      }
    }
  }

  const errorRate = parseFloat(summary.requestErrorRate) || 0;
  if (errorRate >= 10) {
    alerts.push({
      id: 'traffic:error-rate',
      severity: 'critical',
      category: 'Traffic',
      title: 'High error rate',
      desc: `${errorRate}% of requests returned 4xx/5xx status codes — ${summary.totalErrorsLastHour} errors in the last hour. A rate above 10% signals a serious problem such as a broken route, backend crash, or upstream failure. Check the HTTP Errors table for patterns.`
    });
  } else if (errorRate >= 3) {
    alerts.push({
      id: 'traffic:error-rate',
      severity: 'warning',
      category: 'Traffic',
      title: 'Elevated error rate',
      desc: `${errorRate}% of requests returned errors — ${summary.totalErrorsLastHour} errors in the last hour. The warning threshold is 3%. Common causes include bots hitting missing pages, broken API calls, or misconfigured redirects. Review the HTTP Errors table to identify the affected paths.`
    });
  }

  const serverErrorCount = accessEntries.filter((entry) => entry.status >= 500).length;
  if (serverErrorCount > 0) {
    alerts.push({
      id: 'traffic:server-errors',
      severity: serverErrorCount >= 10 ? 'critical' : 'warning',
      category: 'Traffic',
      title: `${serverErrorCount} server error${serverErrorCount > 1 ? 's' : ''} (5xx)`,
      desc: `${serverErrorCount} request${serverErrorCount > 1 ? 's' : ''} returned 5xx (server error) status in the current time range. 5xx errors mean the server or an upstream service failed to handle the request — this is different from 4xx client errors. Common causes: application crash, timeout, out-of-memory, or misconfigured reverse proxy.`
    });
  }

  const botEntries = accessEntries.filter((entry) => /bot|crawl|spider|slurp|semrush|ahref/i.test(entry.userAgent || ''));
  if (accessEntries.length > 0) {
    const botPct = Math.round((botEntries.length / accessEntries.length) * 100);
    if (botPct >= 40) {
      alerts.push({
        id: 'security:bot-traffic',
        severity: 'warning',
        category: 'Security',
        title: 'Heavy bot traffic',
        desc: `${botPct}% of all requests (${formatCount(botEntries.length)} of ${formatCount(accessEntries.length)}) come from known bot user agents. Heavy bot traffic can skew analytics, waste bandwidth, and increase server load. Consider blocking aggressive crawlers or serving them cached responses.`
      });
    }
  }

  if (accessEntries.length > 20) {
    const ipCounts = {};
    accessEntries.forEach((entry) => {
      if (entry.clientIp) ipCounts[entry.clientIp] = (ipCounts[entry.clientIp] || 0) + 1;
    });
    const topIps = Object.entries(ipCounts).sort((left, right) => right[1] - left[1]).slice(0, 3);
    for (const [ip, count] of topIps) {
      const pct = Math.round((count / accessEntries.length) * 100);
      if (pct >= 50 && count > 50) {
        alerts.push({
          id: `security:ip-concentration:${ip}`,
          severity: 'warning',
          category: 'Security',
          title: 'Suspicious IP concentration',
          desc: `IP ${ip} accounts for ${pct}% of total traffic (${formatCount(count)} of ${formatCount(accessEntries.length)} requests). A single IP generating this much traffic may indicate a scraper, DDoS attempt, or misconfigured client. Check if this IP should be rate-limited or blocked.`
        });
      }
    }
  }

  for (const container of containers) {
    if (container.state && container.state !== 'running') {
      const name = container.name || container.id;
      alerts.push({
        id: `containers:down:${name}`,
        severity: 'critical',
        category: 'Containers',
        title: `Container down: ${name}`,
        desc: `Container "${name}" is in state "${container.state}" instead of "running". A stopped container means that service is currently unavailable. Check docker logs for crash reasons and consider restarting it.`
      });
    }
  }

  if (alerts.length === 0) {
    alerts.push({
      id: 'system:healthy',
      severity: 'healthy',
      category: 'System',
      title: 'All systems healthy',
      desc: 'No thresholds have been exceeded. All host resources (CPU, memory, disk, swap) are within normal ranges, error rates are low, and all containers are running. The system is operating normally.'
    });
  }

  return alerts;
}

function getAlertRegistry() {
  return db.getState('alertRegistry', {});
}

function getAlertRegistrySyncedAt() {
  return Number(db.getState('alertRegistry:lastSyncedAt', 0) || 0);
}

function pruneAlertRegistry(registry, now) {
  const cutoff = now - (30 * 24 * 60 * 60 * 1000);
  Object.keys(registry).forEach((id) => {
    const alert = registry[id];
    if (alert && alert.status === 'resolved' && (alert.resolvedAt || 0) < cutoff) {
      delete registry[id];
    }
  });
}

function syncAlertRegistry(currentAlerts, generatedAt) {
  const registry = { ...getAlertRegistry() };
  const activeIds = new Set(currentAlerts.map((alert) => alert.id));

  currentAlerts.forEach((alert) => {
    const existing = registry[alert.id];
    const isNewOccurrence = !existing || existing.status === 'resolved';
    const existingStatus = isNewOccurrence
      ? 'active'
      : (existing.status === 'snoozed' && (existing.snoozedUntil || 0) > generatedAt)
        ? 'snoozed'
        : (existing.status === 'acknowledged')
          ? 'acknowledged'
          : 'active';
    registry[alert.id] = {
      ...existing,
      id: alert.id,
      category: alert.category,
      severity: alert.severity,
      title: alert.title,
      desc: alert.desc,
      firstSeenAt: isNewOccurrence ? generatedAt : (existing.firstSeenAt || generatedAt),
      lastSeenAt: generatedAt,
      resolvedAt: null,
      status: existingStatus,
      readAt: isNewOccurrence ? null : (existing.readAt || null),
      acknowledgedAt: isNewOccurrence ? null : (existing.acknowledgedAt || null),
      clearedAt: isNewOccurrence ? null : (existing.clearedAt || null),
      snoozedUntil: isNewOccurrence ? null : ((existing.snoozedUntil || 0) > generatedAt ? existing.snoozedUntil : null),
      notifiedAt: isNewOccurrence ? null : (existing.notifiedAt || null),
      lastStatusChangeAt: isNewOccurrence
        ? generatedAt
        : (existing.lastStatusChangeAt || existing.firstSeenAt || generatedAt)
    };
  });

  Object.keys(registry).forEach((id) => {
    if (activeIds.has(id)) return;
    const alert = registry[id];
    if (!alert || alert.status === 'resolved') return;
    registry[id] = {
      ...alert,
      status: 'resolved',
      resolvedAt: generatedAt,
      lastStatusChangeAt: generatedAt
    };
  });

  pruneAlertRegistry(registry, generatedAt);
  db.setState('alertRegistry', registry);
  db.setState('alertRegistry:lastSyncedAt', generatedAt);
  return registry;
}

function attachAlertState(currentAlerts, registry) {
  return currentAlerts.map((alert) => {
    const stored = registry[alert.id] || {};
    return {
      ...alert,
      state: stored.status || 'active',
      firstSeenAt: stored.firstSeenAt || null,
      lastSeenAt: stored.lastSeenAt || null,
      resolvedAt: stored.resolvedAt || null,
      readAt: stored.readAt || null,
      acknowledgedAt: stored.acknowledgedAt || null,
      clearedAt: stored.clearedAt || null,
      snoozedUntil: stored.snoozedUntil || null,
      notifiedAt: stored.notifiedAt || null,
      lastStatusChangeAt: stored.lastStatusChangeAt || null
    };
  });
}

function buildAlertHistory(registry) {
  return Object.values(registry)
    .sort((left, right) => {
      const leftAt = left.lastSeenAt || left.lastStatusChangeAt || left.firstSeenAt || 0;
      const rightAt = right.lastSeenAt || right.lastStatusChangeAt || right.firstSeenAt || 0;
      return rightAt - leftAt;
    })
    .map((entry) => ({
      id: entry.id,
      category: entry.category,
      severity: entry.severity,
      title: entry.title,
      desc: entry.desc,
      state: entry.status || 'active',
      firstSeenAt: entry.firstSeenAt || null,
      lastSeenAt: entry.lastSeenAt || null,
      resolvedAt: entry.resolvedAt || null,
      readAt: entry.readAt || null,
      acknowledgedAt: entry.acknowledgedAt || null,
      clearedAt: entry.clearedAt || null,
      snoozedUntil: entry.snoozedUntil || null,
      notifiedAt: entry.notifiedAt || null,
      lastStatusChangeAt: entry.lastStatusChangeAt || null
    }));
}

function persistAlertRegistry(registry) {
  pruneAlertRegistry(registry, Date.now());
  db.setState('alertRegistry', registry);
}

function warmAlertNotifications(currentAlerts, generatedAt) {
  const webhookUrl = String(process.env.ALERT_WEBHOOK_URL || '').trim();
  if (!webhookUrl || alertNotifyPromise) return;

  const registry = { ...getAlertRegistry() };
  const candidates = currentAlerts.filter((alert) => {
    const stored = registry[alert.id];
    return stored
      && stored.firstSeenAt === generatedAt
      && !stored.notifiedAt
      && (alert.severity === 'critical' || alert.severity === 'warning');
  });
  if (!candidates.length) return;

  alertNotifyPromise = Promise.resolve().then(async () => {
    const targetUrl = new URL(webhookUrl);
    const client = targetUrl.protocol === 'https:' ? https : http;
    for (const alert of candidates) {
      const payload = JSON.stringify({
        source: 'raceweek-monitor',
        type: 'alert',
        generatedAt,
        alert
      });
      await new Promise((resolve) => {
        const req = client.request(targetUrl, {
          method: 'POST',
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', resolve);
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
        req.write(payload);
        req.end();
      });
      if (registry[alert.id]) {
        registry[alert.id] = {
          ...registry[alert.id],
          notifiedAt: Date.now()
        };
      }
    }
    persistAlertRegistry(registry);
  }).finally(() => {
    alertNotifyPromise = null;
  });
}

function updateAlertState(action, ids) {
  const registry = { ...getAlertRegistry() };
  const now = Date.now();
  let targetIds = Array.isArray(ids)
    ? ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];

  if (action === 'mark-all-read') {
    targetIds = Object.keys(registry).filter((id) => ['active', 'read'].includes(registry[id]?.status));
  } else if (action === 'acknowledge-all') {
    targetIds = Object.keys(registry).filter((id) => ['active', 'read', 'acknowledged'].includes(registry[id]?.status));
  } else if (action === 'clear-all') {
    targetIds = Object.keys(registry).filter((id) => ['active', 'read', 'acknowledged', 'snoozed'].includes(registry[id]?.status));
  } else if (action === 'restore-cleared') {
    targetIds = Object.keys(registry).filter((id) => registry[id]?.status === 'cleared');
  }

  targetIds.forEach((id) => {
    const alert = registry[id];
    if (!alert || alert.status === 'resolved') return;

    if (action === 'mark-read' || action === 'mark-all-read') {
      registry[id] = {
        ...alert,
        status: 'read',
        readAt: alert.readAt || now,
        lastStatusChangeAt: now
      };
      return;
    }

    if (action === 'acknowledge' || action === 'acknowledge-all') {
      registry[id] = {
        ...alert,
        status: 'acknowledged',
        acknowledgedAt: alert.acknowledgedAt || now,
        snoozedUntil: null,
        lastStatusChangeAt: now
      };
      return;
    }

    if (action === 'snooze-1h' || action === 'snooze-24h') {
      const durationMs = action === 'snooze-24h' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
      registry[id] = {
        ...alert,
        status: 'snoozed',
        snoozedUntil: now + durationMs,
        lastStatusChangeAt: now
      };
      return;
    }

    if (action === 'clear' || action === 'clear-all') {
      registry[id] = {
        ...alert,
        status: 'cleared',
        clearedAt: alert.clearedAt || now,
        lastStatusChangeAt: now
      };
      return;
    }

    if (action === 'restore-cleared' && alert.status === 'cleared') {
      registry[id] = {
        ...alert,
        status: 'active',
        clearedAt: null,
        lastStatusChangeAt: now
      };
    }
  });

  persistAlertRegistry(registry);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function aggregateAccessRollups(rollups, bucketMs) {
  if (bucketMs <= 60000) return rollups;
  const buckets = new Map();
  rollups.forEach((r) => {
    const key = r.bucketAt - (r.bucketAt % bucketMs);
    if (!buckets.has(key)) {
      buckets.set(key, { bucketAt: key, totalRequests: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0 });
    }
    const b = buckets.get(key);
    b.totalRequests += r.totalRequests;
    b.status2xx += (r.status2xx || 0);
    b.status3xx += (r.status3xx || 0);
    b.status4xx += (r.status4xx || 0);
    b.status5xx += (r.status5xx || 0);
  });
  return Array.from(buckets.values()).sort((a, b) => a.bucketAt - b.bucketAt);
}

function aggregateHostSeries(points, bucketMs) {
  if (bucketMs <= 60000) {
    return points.map((p) => ({
      collectedAt: p.t, cpuPercent: p.cpu, memoryPercent: p.mem,
      networkRxPerSecKb: p.rx, networkTxPerSecKb: p.tx
    }));
  }
  const buckets = new Map();
  points.forEach((p) => {
    const key = p.t - (p.t % bucketMs);
    if (!buckets.has(key)) {
      buckets.set(key, { t: key, cpuSum: 0, memSum: 0, count: 0, rxMax: 0, txMax: 0 });
    }
    const b = buckets.get(key);
    b.cpuSum += p.cpu;
    b.memSum += p.mem;
    b.count++;
    b.rxMax = Math.max(b.rxMax, p.rx || 0);
    b.txMax = Math.max(b.txMax, p.tx || 0);
  });
  return Array.from(buckets.values())
    .sort((a, b) => a.t - b.t)
    .map((b) => ({
      collectedAt: b.t,
      cpuPercent: Math.round((b.cpuSum / b.count) * 10) / 10,
      memoryPercent: Math.round((b.memSum / b.count) * 10) / 10,
      networkRxPerSecKb: b.rxMax,
      networkTxPerSecKb: b.txMax
    }));
}

async function lookupGeoIps(ips) {
  const toCheck = ips.filter((ip) => !db.getGeoInfo(ip));
  if (!toCheck.length) return;
  try {
    const body = JSON.stringify(toCheck.slice(0, 100).map((ip) => ({
      query: ip, fields: 'status,country,countryCode,city,lat,lon,query'
    })));
    await new Promise((resolve) => {
      const req = http.request({
        hostname: 'ip-api.com', port: 80, path: '/batch', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const results = JSON.parse(data);
            const batch = [];
            for (const r of results) {
              const info = r.status === 'success'
                ? { country: r.country, countryCode: r.countryCode, city: r.city, lat: r.lat, lon: r.lon, cachedAt: Date.now() }
                : { country: 'Private', countryCode: '', city: '', lat: null, lon: null, cachedAt: Date.now() };
              batch.push([r.query, info]);
            }
            if (batch.length) db.setGeoBatch(batch);
          } catch (e) { /* ignore */ }
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
  } catch (e) { /* geo unavailable */ }
}

function warmGeoIps(ips) {
  const toCheck = ips.filter((ip) => ip && !db.getGeoInfo(ip));
  if (!toCheck.length || geoLookupPromise) return;
  geoLookupPromise = lookupGeoIps(toCheck).finally(() => {
    geoLookupPromise = null;
  });
}

function aggregateCountries(enrichedIps) {
  const map = {};
  for (const ip of enrichedIps) {
    if (!ip.country || ip.country === 'Private') continue;
    if (!map[ip.countryCode]) {
      map[ip.countryCode] = { country: ip.country, countryCode: ip.countryCode, count: 0, lat: ip.lat, lon: ip.lon };
    }
    map[ip.countryCode].count += ip.count;
  }
  return Object.values(map).sort((a, b) => b.count - a.count);
}

async function buildResponse(rangeMs, since) {
  if (!since) since = Date.now() - rangeMs;
  const latest = db.getLatestSnapshot();
  const latestHostSample = db.getLatestHostSample();
  const snapshotGeneratedAt = Number(latest?.collectedAt || 0);
  const hostGeneratedAt = Number(latestHostSample?.collectedAt || 0);
  const snapshotSeries = db.getSnapshotsSince(since);
  const hostPoints = db.getHostSeriesSince(since);
  const whitelistIps = getWhitelistIps();
  const accessEntries = filterEntriesByWhitelist(db.getAccessEntries({ since }), whitelistIps);
  const lastHourEntries = filterEntriesByWhitelist(db.getAccessEntries({ since: Date.now() - RANGE_MS['1h'] }), whitelistIps);
  const recentLogs = db.getRecentLogs(80);
  const latestPayloadBase = latest?.payload
    ? {
        ...latest.payload,
        host: latestHostSample?.host || latest.payload.host
      }
    : null;
  const latestPayload = buildLatestPayloadWithFilteredAccess(latestPayloadBase, lastHourEntries);
  const currentContainers = latestPayload?.containers || [];
  const generatedAt = Math.max(snapshotGeneratedAt, hostGeneratedAt) || Date.now();

  const hostBucketMs = getHostBucketMs(rangeMs);
  const accessBucketMs = getAccessBucketMs(rangeMs);

  // Fallback to snapshots if hostSeries is empty (first deploy)
  let hostChartData;
  if (hostPoints.length) {
    hostChartData = aggregateHostSeries(hostPoints, hostBucketMs);
  } else {
    const snapshotSeries = db.getSnapshotsSince(since);
    hostChartData = snapshotSeries.map((entry) => ({
      collectedAt: entry.collectedAt,
      cpuPercent: entry.payload.host.cpuPercent,
      memoryPercent: entry.payload.host.memoryPercent,
      networkRxPerSecKb: entry.payload.host.networkRxPerSecKb,
      networkTxPerSecKb: entry.payload.host.networkTxPerSecKb
    }));
  }

  const filteredTopClientIps = buildTopClientIpsFromEntries(accessEntries, 15);
  const countrySourceIps = buildTopClientIpsFromEntries(accessEntries, 50);
  warmGeoIps(Array.from(new Set([...filteredTopClientIps, ...countrySourceIps].map((item) => item.ip))));
  const enrichedIps = filteredTopClientIps.map((item) => {
    const geo = db.getGeoInfo(item.ip);
    return { ...item, country: geo?.country || '', countryCode: geo?.countryCode || '', city: geo?.city || '', lat: geo?.lat ?? null, lon: geo?.lon ?? null };
  });
  const enrichedCountryIps = countrySourceIps.map((item) => {
    const geo = db.getGeoInfo(item.ip);
    return { ...item, country: geo?.country || '', countryCode: geo?.countryCode || '', city: geo?.city || '', lat: geo?.lat ?? null, lon: geo?.lon ?? null };
  });
  const currentAlerts = buildCurrentAlerts(latestPayload, lastHourEntries);
  const alertRegistry = getAlertRegistrySyncedAt() === snapshotGeneratedAt
    ? getAlertRegistry()
    : syncAlertRegistry(currentAlerts, snapshotGeneratedAt);
  warmAlertNotifications(currentAlerts, snapshotGeneratedAt);
  const configSnapshot = getCachedConfigSnapshot();
  const caddyOverview = getCachedCaddyOverview(latestPayload, configSnapshot);
  const diskUsageHotspots = collector.getDiskUsageHotspots();
  const topProcesses = db.getState('host:topProcesses', { collectedAt: 0, processes: [] });

  return {
    generatedAt,
    snapshotGeneratedAt,
    refreshIntervalMs: Number(process.env.HOST_COLLECTION_INTERVAL_MS || 30000),
    snapshotRefreshIntervalMs: Number(process.env.COLLECTION_INTERVAL_MS || 180000),
    latest: latestPayload,
    serviceProbes: latestPayload?.serviceProbes || [],
    performance: buildPerformanceInsights(accessEntries),
    events: getOperationalEvents(since),
    series: {
      host: hostChartData,
      access: aggregateAccessEntries(accessEntries, accessBucketMs),
      serviceProbes: buildServiceProbeSeries(snapshotSeries),
      storageGrowth: buildStorageGrowthSeries(snapshotSeries)
    },
    topUrls: buildTopUrlsFromEntries(accessEntries, 15),
    topClientIps: enrichedIps,
    topCountries: aggregateCountries(enrichedCountryIps),
    recentErrors: accessEntries.filter((entry) => entry.status >= 400),
    recentLogs,
    recentAccess: accessEntries,
    whitelistIps,
    liveContainerLogs: collector.getLiveContainerTails(currentContainers, 40),
    dockerOverview: latestPayload?.dockerOverview || null,
    diskUsageHotspots,
    topProcesses,
    alerts: attachAlertState(currentAlerts, alertRegistry),
    alertHistory: buildAlertHistory(alertRegistry),
    configSnapshot,
    caddyOverview
  };
}

function resolveRange(parsedUrl) {
  const range = parsedUrl.searchParams.get('range') || '6h';
  if (range === 'custom') {
    const from = Number(parsedUrl.searchParams.get('from'));
    const to = Number(parsedUrl.searchParams.get('to'));
    if (from && to && to > from) {
      const maxRange = 14 * 24 * 60 * 60 * 1000;
      const rangeMs = Math.min(to - from, maxRange);
      return { rangeMs, since: to - rangeMs };
    }
  }
  const rangeMs = parseRange(range);
  return { rangeMs, since: Date.now() - rangeMs };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const parsedUrl = new URL(req.url, `http://localhost:${port}`);
  const requestPath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  const filePath = path.join(publicDir, requestPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const extension = path.extname(filePath);
  const contentType = extension === '.html'
    ? 'text/html; charset=utf-8'
    : extension === '.css'
      ? 'text/css; charset=utf-8'
      : extension === '.js'
        ? 'application/javascript; charset=utf-8'
        : extension === '.svg'
          ? 'image/svg+xml'
          : 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true, timestamp: Date.now() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/dashboard') {
      if (!db.getLatestSnapshot()) {
        await collector.collectAndStore();
      } else {
        collector.ensureFresh().catch((error) => {
          console.error('[custom-tool] background refresh failed, serving last snapshot', error);
        });
      }
      const { rangeMs, since } = resolveRange(parsedUrl);
      sendJson(res, 200, await buildResponse(rangeMs, since));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/refresh') {
      await collector.collectAndStore();
      const { rangeMs, since } = resolveRange(parsedUrl);
      sendJson(res, 200, await buildResponse(rangeMs, since));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/access') {
      const params = parsedUrl.searchParams;
      const limit = Math.min(Number(params.get('limit') || 200), 1000);
      const opts = { limit };
      if (params.get('search')) opts.search = params.get('search');
      if (params.get('ip')) opts.ip = params.get('ip');
      if (params.get('method')) opts.method = params.get('method');
      if (params.get('status')) {
        const s = params.get('status');
        if (s === '2xx') { opts.statusMin = 200; opts.statusMax = 300; }
        else if (s === '3xx') { opts.statusMin = 300; opts.statusMax = 400; }
        else if (s === '4xx') { opts.statusMin = 400; opts.statusMax = 500; }
        else if (s === '5xx') { opts.statusMin = 500; opts.statusMax = 600; }
        else if (s === 'errors') { opts.statusMin = 400; }
      }
      sendJson(res, 200, { entries: filterEntriesByWhitelist(db.getAccessEntries(opts), getWhitelistIps()) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/whitelist') {
      sendJson(res, 200, { ips: getWhitelistIps() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/whitelist') {
      const body = await readJsonBody(req);
      const ips = normalizeIpList(body.ips || []);
      db.setState('accessWhitelistIps', ips);
      sendJson(res, 200, { ok: true, ips });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/alerts/action') {
      const body = await readJsonBody(req);
      const action = String(body.action || '').trim();
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const allowed = new Set(['mark-read', 'acknowledge', 'acknowledge-all', 'snooze-1h', 'snooze-24h', 'clear', 'mark-all-read', 'clear-all', 'restore-cleared']);
      if (!allowed.has(action)) {
        sendJson(res, 400, { error: 'Invalid alert action' });
        return;
      }
      updateAlertState(action, ids);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/logs') {
      const params = parsedUrl.searchParams;
      const limit = Math.min(Number(params.get('limit') || 200), 1000);
      const opts = {};
      if (params.get('search')) opts.search = params.get('search');
      if (params.get('level')) opts.level = params.get('level');
      if (params.get('source')) opts.source = params.get('source');
      sendJson(res, 200, { entries: db.getRecentLogs(limit, opts) });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[custom-tool] request failed', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

collector.start().catch((error) => {
  console.error('[custom-tool] startup failed', error);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`[custom-tool] api listening on ${port}`);
});