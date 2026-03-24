const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const IMPORTANT_LOG_PATTERN = /(error|warn|fatal|exception|failed|timeout|denied|refused)/i;

function parseKeyValueFile(filePath, separator = ':') {
  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};
  content.split(/\r?\n/).forEach((line) => {
    const index = line.indexOf(separator);
    if (index === -1) {
      return;
    }

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) {
      result[key] = value;
    }
  });
  return result;
}

function safeReadText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function toMegabytes(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function toGigabytes(bytes) {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10;
}

function toPercent(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 10;
}

function normalizeContainerName(name) {
  return (name || '').replace(/^\//, '');
}

function parseDockerCpuPercent(stats) {
  const totalUsage = stats.cpu_stats?.cpu_usage?.total_usage || 0;
  const previousUsage = stats.precpu_stats?.cpu_usage?.total_usage || 0;
  const systemUsage = stats.cpu_stats?.system_cpu_usage || 0;
  const previousSystem = stats.precpu_stats?.system_cpu_usage || 0;
  const onlineCpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

  const cpuDelta = totalUsage - previousUsage;
  const systemDelta = systemUsage - previousSystem;
  if (cpuDelta <= 0 || systemDelta <= 0) {
    return 0;
  }

  return Math.round(((cpuDelta / systemDelta) * onlineCpus * 100) * 10) / 10;
}

function guessLogLevel(message) {
  if (/fatal|panic|exception/i.test(message)) {
    return 'fatal';
  }
  if (/error|failed|denied|refused/i.test(message)) {
    return 'error';
  }
  if (/warn|deprecated|retry/i.test(message)) {
    return 'warn';
  }
  return 'info';
}

function tailLines(filePath, maxLines, maxBytes = 256 * 1024) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const stats = fs.statSync(filePath);
  const start = Math.max(0, stats.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stats.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const content = buffer.toString('utf8');
    return content.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

function toDisplayPath(rootPath, fullPath) {
  const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/');
  return relativePath ? `/${relativePath}` : '/';
}

function insertTopSizedEntry(entries, candidate, limit) {
  if (!candidate || !Number.isFinite(candidate.sizeBytes)) {
    return;
  }

  const existingIndex = entries.findIndex((entry) => entry.path === candidate.path);
  if (existingIndex >= 0) {
    if (entries[existingIndex].sizeBytes >= candidate.sizeBytes) {
      return;
    }
    entries.splice(existingIndex, 1);
  }

  const insertionIndex = entries.findIndex((entry) => candidate.sizeBytes > entry.sizeBytes);
  if (insertionIndex === -1) {
    if (entries.length < limit) {
      entries.push(candidate);
    }
  } else {
    entries.splice(insertionIndex, 0, candidate);
  }

  if (entries.length > limit) {
    entries.length = limit;
  }
}

function safeFileSize(filePath) {
  try {
    return fs.existsSync(filePath) ? Number(fs.statSync(filePath).size || 0) : 0;
  } catch (_) {
    return 0;
  }
}

function parseProcessStat(statLine) {
  const match = String(statLine || '').match(/^(\d+)\s+\((.*)\)\s+(\S+)\s+(.*)$/);
  if (!match) {
    return null;
  }

  const fields = String(match[4] || '').trim().split(/\s+/);
  if (fields.length < 22) {
    return null;
  }

  return {
    pid: Number(match[1] || 0),
    name: match[2] || '',
    state: match[3] || '?',
    utime: Number(fields[10] || 0),
    stime: Number(fields[11] || 0),
    nice: Number(fields[15] || 0),
    threads: Number(fields[16] || 0),
    startTime: Number(fields[18] || 0),
    rssPages: Number(fields[20] || 0)
  };
}

function readCommandLine(filePath, fallback = '') {
  const raw = safeReadText(filePath).replace(/\0+/g, ' ').trim();
  return raw || fallback || '';
}

function inferKnownService(name, command) {
  const rawName = String(name || '').trim();
  const rawCommand = String(command || '').trim();
  const text = `${rawName} ${rawCommand}`.toLowerCase();

  if (text.includes('dockerd')) return 'Docker Engine';
  if (text.includes('mysqld')) return 'MySQL';
  if (text.includes('caddy')) return 'Caddy';
  if (text.includes('nginx')) return 'Nginx';
  if (text.includes('ollama')) return 'Ollama';
  if (text.includes('n8n')) return 'n8n';
  if (text.includes('apache2') || text.includes('httpd')) return 'Apache HTTP Server';
  if (text.includes('php-fpm')) return 'PHP-FPM';
  if (text.includes('/app/src/server.js') || (text.includes('node') && text.includes('/app/src/server.js'))) return 'Monitoring Tool API';
  if (text.includes('azuremonitoragent') || text.includes('telegraf')) return 'Azure Monitor Agent';
  if (rawName.startsWith('ksoftirqd')) return 'Kernel SoftIRQ Worker';
  if (rawName.startsWith('kcompactd')) return 'Kernel Memory Compaction';
  if (rawName.startsWith('kworker')) return 'Kernel Worker';
  if (rawName.startsWith('migration')) return 'Kernel Migration Worker';
  if (rawName.startsWith('jbd2')) return 'Filesystem Journal';
  if (rawName.startsWith('systemd')) return 'systemd';
  if (rawName) return rawName;
  return rawCommand || 'Unknown process';
}

function sumDirectorySize(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return 0;
  }

  let totalBytes = 0;
  const stack = [rootPath];
  while (stack.length) {
    const currentPath = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        totalBytes += safeFileSize(fullPath);
      }
    }
  }

  return totalBytes;
}

function getDirectorySizeWithDu(dirPath, timeoutMs) {
  try {
    const output = execFileSync('du', ['-sb', '--', dirPath], {
      encoding: 'utf8',
      timeout: Math.max(1000, Number(timeoutMs || 1000))
    });
    const match = String(output || '').match(/^(\d+)/);
    return match ? Number(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function shellEscape(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function parseSizedPathOutput(output, rootPath) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      const fullPath = match[2].trim();
      return {
        path: toDisplayPath(rootPath, fullPath),
        name: path.basename(fullPath),
        sizeBytes: Number(match[1] || 0)
      };
    })
    .filter(Boolean);
}

function getCommandStdout(error) {
  if (!error) return '';
  if (typeof error.stdout === 'string') return error.stdout;
  if (Buffer.isBuffer(error.stdout)) return error.stdout.toString('utf8');
  return '';
}

function parseServiceProbes(rawConfig, defaultPort) {
  const probes = [];
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig);
      if (Array.isArray(parsed)) {
        parsed.forEach((probe, index) => {
          if (!probe || typeof probe !== 'object' || !probe.url) {
            return;
          }
          const name = String(probe.name || `Service ${index + 1}`).trim();
          const url = String(probe.url || '').trim();
          if (!url) {
            return;
          }
          probes.push({
            id: String(probe.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '') || `service-${index + 1}`,
            name,
            url,
            method: String(probe.method || 'GET').toUpperCase(),
            timeoutMs: Number(probe.timeoutMs || 5000),
            expectedStatusMin: Number(probe.expectedStatusMin || 200),
            expectedStatusMax: Number(probe.expectedStatusMax || 400)
          });
        });
      }
    } catch (_) {
      // Ignore invalid probe config.
    }
  }

  const defaultProbeId = 'monitoring-api';
  if (!probes.some((probe) => probe.id === defaultProbeId)) {
    probes.unshift({
      id: defaultProbeId,
      name: 'Monitoring API',
      url: `http://127.0.0.1:${defaultPort || 3000}/health`,
      method: 'GET',
      timeoutMs: 3000,
      expectedStatusMin: 200,
      expectedStatusMax: 400
    });
  }

  return probes;
}

class MonitorCollector {
  constructor(db, options = {}) {
    this.db = db;
    this.dockerSocketPath = options.socketPath || '/var/run/docker.sock';
    this.procPath = options.procPath || '/host/proc';
    this.sysPath = options.sysPath || '/host/sys';
    this.rootPath = options.rootPath || '/host-root';
    this.caddyLogDir = options.caddyLogDir || '/host-caddy-logs';
    this.configRootPath = options.configRootPath || '/host-root';
    this.intervalMs = options.intervalMs || 60000;
    this.hostIntervalMs = Math.max(5000, Number(options.hostIntervalMs || 30000));
    this.retentionDays = options.retentionDays || 14;
    this.selectedLogContainers = (options.selectedLogContainers || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    this.diskScanTtlMs = Number(options.diskScanTtlMs || (15 * 60 * 1000));
    this.diskScanMaxEntries = Number(options.diskScanMaxEntries || 50);
    this.diskScanTimeoutMs = Number(options.diskScanTimeoutMs || 15000);
    this.serviceProbes = parseServiceProbes(options.serviceProbes || '', options.defaultServiceProbePort || 3000);
    this.diskScanExcludedTopDirs = new Set(
      String(options.diskScanExcludedTopDirs || 'proc,sys,dev,run,mnt,media,lost+found')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    );
    this.lastCollectedAt = 0;
    this.lastHostCollectedAt = 0;
    this.timer = null;
    this.hostTimer = null;
    this.collectPromise = null;
    this.hostSamplePromise = null;
    this.diskUsageHotspotsPromise = null;
    this.diskUsageHotspotsCache = {
      value: this.db.getState('hostDiskUsageHotspots', null),
      expiresAt: 0
    };
  }

  dockerRequestJson(requestPath) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.dockerSocketPath,
        path: requestPath,
        method: 'GET'
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Docker API request failed: ${requestPath} -> ${res.statusCode}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async start() {
    await this.collectAndStore();
    this.getDiskUsageHotspots();
    this.timer = setInterval(() => {
      this.collectAndStore().catch((error) => {
        console.error('[custom-tool] collection failed', error);
      });
    }, this.intervalMs);
    if (this.hostIntervalMs < this.intervalMs) {
      this.hostTimer = setInterval(() => {
        this.collectHostAndStore().catch((error) => {
          console.error('[custom-tool] host sampling failed', error);
        });
      }, this.hostIntervalMs);
    }
  }

  async ensureFresh(options = {}) {
    const force = Boolean(options.force);
    const requestedStaleAfterMs = Number(options.staleAfterMs);
    const staleAfterMs = Number.isFinite(requestedStaleAfterMs)
      ? Math.max(0, requestedStaleAfterMs)
      : Math.max(30000, Math.floor(this.intervalMs / 2));

    if (force || !this.lastCollectedAt || (Date.now() - this.lastCollectedAt) > staleAfterMs) {
      await this.collectAndStore();
    }
  }

  async collectHostAndStore(now = Date.now(), options = {}) {
    const fromFullCollect = Boolean(options.fromFullCollect);
    if (!fromFullCollect && this.collectPromise) {
      const payload = await this.collectPromise;
      return payload.host;
    }
    if (this.hostSamplePromise) {
      return this.hostSamplePromise;
    }

    this.hostSamplePromise = Promise.resolve().then(() => {
      const host = this.collectHostMetrics(now);
      const topProcesses = this.collectTopProcesses(now);
      this.db.setLatestHostSample(now, host, { persist: !fromFullCollect });
      this.db.setState('host:topProcesses', {
        collectedAt: now,
        processes: topProcesses
      });
      this.lastHostCollectedAt = now;
      return host;
    }).finally(() => {
      this.hostSamplePromise = null;
    });

    return this.hostSamplePromise;
  }

  getDiskUsageHotspots() {
    const now = Date.now();
    if (this.diskUsageHotspotsCache.value && this.diskUsageHotspotsCache.expiresAt > now) {
      return this.diskUsageHotspotsCache.value;
    }

    if (!this.diskUsageHotspotsPromise) {
      this.refreshDiskUsageHotspots().catch((error) => {
        console.error('[custom-tool] disk hotspot scan failed', error);
      });
    }

    return this.diskUsageHotspotsCache.value;
  }

  async refreshDiskUsageHotspots(force = false) {
    const now = Date.now();
    if (!force && this.diskUsageHotspotsCache.value && this.diskUsageHotspotsCache.expiresAt > now) {
      return this.diskUsageHotspotsCache.value;
    }
    if (this.diskUsageHotspotsPromise) {
      return this.diskUsageHotspotsPromise;
    }

    this.diskUsageHotspotsPromise = Promise.resolve()
      .then(() => this.scanDiskUsageHotspots())
      .then((value) => {
        this.diskUsageHotspotsCache = {
          value,
          expiresAt: Date.now() + this.diskScanTtlMs
        };
        this.db.setState('hostDiskUsageHotspots', value);
        return value;
      })
      .finally(() => {
        this.diskUsageHotspotsPromise = null;
      });

    return this.diskUsageHotspotsPromise;
  }

  scanDiskUsageHotspots() {
    const startedAt = Date.now();
    const errors = [];
    let topFiles = [];
    let topDirectories = [];
    let fileCount = 0;
    let directoryCount = 0;
    let truncated = false;

    const pushError = (targetPath, error) => {
      if (errors.length >= 12) {
        return;
      }
      errors.push({
        path: targetPath,
        code: error?.code || 'UNKNOWN',
        message: error?.message || 'Unknown error'
      });
    };

    let rootEntries = [];
    try {
      rootEntries = fs.readdirSync(this.rootPath, { withFileTypes: true });
    } catch (error) {
      pushError('/', error);
    }

    const rootDirectories = rootEntries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !this.diskScanExcludedTopDirs.has(entry.name))
      .map((entry) => path.join(this.rootPath, entry.name));
    directoryCount = rootDirectories.length;

    if (rootDirectories.length) {
      try {
        const output = execFileSync('du', ['-xsb', '--', ...rootDirectories], {
          encoding: 'utf8',
          timeout: Math.max(45000, this.diskScanTimeoutMs * 3)
        });
        topDirectories = parseSizedPathOutput(output, this.rootPath)
          .sort((left, right) => right.sizeBytes - left.sizeBytes)
          .slice(0, this.diskScanMaxEntries);
      } catch (error) {
        const partialOutput = getCommandStdout(error);
        if (partialOutput) {
          topDirectories = parseSizedPathOutput(partialOutput, this.rootPath)
            .sort((left, right) => right.sizeBytes - left.sizeBytes)
            .slice(0, this.diskScanMaxEntries);
          truncated = true;
        } else {
          pushError('/', error);
        }
      }

      if (topDirectories.length < Math.min(rootDirectories.length, this.diskScanMaxEntries)) {
        const existingPaths = new Set(topDirectories.map((entry) => entry.path));
        rootDirectories.forEach((fullPath) => {
          const displayPath = toDisplayPath(this.rootPath, fullPath);
          if (existingPaths.has(displayPath)) {
            return;
          }
          const sizeBytes = getDirectorySizeWithDu(fullPath, Math.max(15000, this.diskScanTimeoutMs));
          if (!Number.isFinite(sizeBytes)) {
            return;
          }
          topDirectories.push({
            path: displayPath,
            name: path.basename(fullPath),
            sizeBytes
          });
        });
        topDirectories = topDirectories
          .sort((left, right) => right.sizeBytes - left.sizeBytes)
          .slice(0, this.diskScanMaxEntries);
      }
    }

    const excludedPrunes = Array.from(this.diskScanExcludedTopDirs)
      .map((dirName) => `-path ${shellEscape(path.posix.join(this.rootPath.replace(/\\/g, '/'), dirName))}`)
      .join(' -o ');
    const filesCommand = `find ${shellEscape(this.rootPath)} -xdev \\( ${excludedPrunes} \\) -prune -o -type f -printf '%s\\t%p\\n' 2>/dev/null | sort -nr | head -n ${Math.max(10, this.diskScanMaxEntries)}`;

    try {
      const output = execFileSync('sh', ['-lc', filesCommand], {
        encoding: 'utf8',
        timeout: Math.max(30000, this.diskScanTimeoutMs * 2)
      });
      topFiles = parseSizedPathOutput(output, this.rootPath).slice(0, this.diskScanMaxEntries);
      fileCount = topFiles.length;
    } catch (error) {
      const partialOutput = getCommandStdout(error);
      if (partialOutput) {
        topFiles = parseSizedPathOutput(partialOutput, this.rootPath).slice(0, this.diskScanMaxEntries);
        fileCount = topFiles.length;
      }
      truncated = true;
      if (!partialOutput) {
        pushError('/', error);
      }
    }

    const totalSizeBytes = topDirectories.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0);
    return {
      scannedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      rootPath: '/',
      totalSizeBytes,
      fileCount,
      directoryCount,
      truncated,
      topFiles,
      topDirectories,
      errors
    };
  }

  async collectAndStore() {
    if (this.collectPromise) {
      return this.collectPromise;
    }
    this.collectPromise = (async () => {
      const now = Date.now();
      const host = await this.collectHostAndStore(now, { fromFullCollect: true });
      const containers = await this.collectContainerMetrics();
      this.ingestCaddyAccessLogs();
      this.ingestImportantContainerLogs(containers);
      const dockerOverview = await this.collectDockerOverview(containers);
      const serviceProbes = await this.collectServiceProbes(now);
      const storageGrowth = this.collectStorageGrowth(containers, dockerOverview);
      const configFingerprint = this.collectConfigFingerprint();

      const recentRollups = this.db.getAccessRollupsSince(now - (24 * 60 * 60 * 1000));
      const lastHourRollups = recentRollups.filter((item) => item.bucketAt >= now - (60 * 60 * 1000));

      const totalRequestsLastHour = lastHourRollups.reduce((sum, item) => sum + item.totalRequests, 0);
      const totalErrorsLastHour = lastHourRollups.reduce((sum, item) => sum + item.status4xx + item.status5xx, 0);

      const payload = {
        generatedAt: now,
        host,
        containers,
        dockerOverview,
        serviceProbes,
        storageGrowth,
        summary: {
          runningContainers: containers.filter((container) => container.state === 'running').length,
          totalContainers: containers.length,
          healthyContainers: containers.filter((container) => !container.health || container.health === 'healthy').length,
          totalRequestsLastHour,
          totalErrorsLastHour,
          requestErrorRate: totalRequestsLastHour ? Math.round((totalErrorsLastHour / totalRequestsLastHour) * 1000) / 10 : 0
        }
      };

      this.emitOperationsEvents(now, {
        containers,
        serviceProbes,
        configFingerprint
      });

      this.db.insertSnapshot(now, payload);
      this.db.pruneBefore(now - (this.retentionDays * 24 * 60 * 60 * 1000));
      this.lastCollectedAt = now;
      return payload;
    })().finally(() => {
      this.collectPromise = null;
    });
    return this.collectPromise;
  }

  async collectServiceProbes(now) {
    const checks = this.serviceProbes.map(async (probe) => {
      const startedAt = Date.now();
      try {
        const url = new URL(probe.url);
        const client = url.protocol === 'https:' ? https : http;
        const result = await new Promise((resolve, reject) => {
          const req = client.request(url, {
            method: probe.method || 'GET',
            timeout: probe.timeoutMs || 5000,
            headers: { 'User-Agent': 'RaceWeek-Monitor/1.0' }
          }, (res) => {
            res.resume();
            res.on('end', () => resolve({ statusCode: res.statusCode || 0 }));
          });
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy(new Error('Probe timeout'));
          });
          req.end();
        });

        const responseTimeMs = Date.now() - startedAt;
        const statusCode = Number(result.statusCode || 0);
        return {
          id: probe.id,
          name: probe.name,
          url: probe.url,
          method: probe.method || 'GET',
          checkedAt: now,
          responseTimeMs,
          statusCode,
          ok: statusCode >= probe.expectedStatusMin && statusCode < probe.expectedStatusMax,
          error: ''
        };
      } catch (error) {
        return {
          id: probe.id,
          name: probe.name,
          url: probe.url,
          method: probe.method || 'GET',
          checkedAt: now,
          responseTimeMs: Date.now() - startedAt,
          statusCode: 0,
          ok: false,
          error: error?.message || 'Probe failed'
        };
      }
    });

    return Promise.all(checks);
  }

  collectStorageGrowth(containers, dockerOverview) {
    const containerLogBytes = (containers || []).reduce((sum, container) => sum + safeFileSize(container.logPath), 0);
    const caddyLogBytes = sumDirectorySize(this.caddyLogDir);
    const volumeBytes = Math.round(Number(dockerOverview?.diskUsage?.volumesMb || 0) * 1024 * 1024);
    return {
      volumesBytes: volumeBytes,
      containerLogBytes,
      caddyLogBytes,
      totalLogBytes: containerLogBytes + caddyLogBytes
    };
  }

  collectConfigFingerprint() {
    const preferredFileNames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Caddyfile', '.env'];
    const fingerprints = [];
    preferredFileNames.forEach((fileName) => {
      const filePath = path.join(this.configRootPath, fileName);
      if (!fs.existsSync(filePath)) {
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fingerprints.push(`${fileName}:${Math.floor(stat.mtimeMs || 0)}:${stat.size}`);
        }
      } catch (_) {
        // Ignore unreadable files.
      }
    });
    return fingerprints.join('|');
  }

  emitOperationsEvents(now, currentState) {
    const previous = this.db.getState('operations:lastState', null);
    const existingEvents = this.db.getState('operations:timeline', []);
    const events = Array.isArray(existingEvents) ? existingEvents.slice() : [];

    const pushEvent = (event) => {
      events.unshift({
        id: `${event.type}:${event.target || 'system'}:${now}`,
        at: now,
        ...event
      });
    };

    if (previous) {
      const previousContainers = new Map((previous.containers || []).map((container) => [container.name, container]));
      const currentContainerNames = new Set((currentState.containers || []).map((container) => container.name));

      (currentState.containers || []).forEach((container) => {
        const last = previousContainers.get(container.name);
        if (!last) {
          pushEvent({ type: 'container-new', category: 'Deploy', severity: 'info', target: container.name, title: `Container detected: ${container.name}`, desc: `Container ${container.name} is now present with image ${container.image}.` });
          return;
        }
        if (last.state !== container.state) {
          pushEvent({ type: 'container-state', category: 'Container', severity: container.state === 'running' ? 'info' : 'warning', target: container.name, title: `Container state changed: ${container.name}`, desc: `${container.name} changed from ${last.state} to ${container.state}.` });
        }
        if ((container.restartCount || 0) > (last.restartCount || 0)) {
          pushEvent({ type: 'container-restart', category: 'Container', severity: 'warning', target: container.name, title: `Container restarted: ${container.name}`, desc: `${container.name} restart count increased from ${last.restartCount || 0} to ${container.restartCount || 0}.` });
        }
        if (last.image !== container.image) {
          pushEvent({ type: 'container-image', category: 'Deploy', severity: 'info', target: container.name, title: `Image updated: ${container.name}`, desc: `${container.name} image changed from ${last.image} to ${container.image}.` });
        }
      });

      (previous.containers || []).forEach((container) => {
        if (!container?.name || currentContainerNames.has(container.name)) {
          return;
        }
        pushEvent({ type: 'container-removed', category: 'Deploy', severity: 'warning', target: container.name, title: `Container removed: ${container.name}`, desc: `Container ${container.name} is no longer reported by Docker and has been removed from the current inventory.` });
      });

      const previousProbes = new Map((previous.serviceProbes || []).map((probe) => [probe.id, probe]));
      (currentState.serviceProbes || []).forEach((probe) => {
        const last = previousProbes.get(probe.id);
        if (!last) {
          return;
        }
        if (Boolean(last.ok) !== Boolean(probe.ok)) {
          pushEvent({ type: 'probe-state', category: 'Service', severity: probe.ok ? 'info' : 'warning', target: probe.name, title: `Probe state changed: ${probe.name}`, desc: probe.ok ? `${probe.name} recovered with ${probe.statusCode} in ${probe.responseTimeMs} ms.` : `${probe.name} probe failed (${probe.error || probe.statusCode || 'unknown'}).` });
        }
      });

      if ((previous.configFingerprint || '') !== (currentState.configFingerprint || '')) {
        pushEvent({ type: 'config-change', category: 'Config', severity: 'info', target: 'config', title: 'Configuration files changed', desc: 'Tracked compose, Caddy, or env files changed since the last collection.' });
      }
    }

    this.db.setState('operations:timeline', events.slice(0, 200));
    this.db.setState('operations:lastState', {
      collectedAt: now,
      containers: (currentState.containers || []).map((container) => ({
        name: container.name,
        state: container.state,
        restartCount: container.restartCount,
        image: container.image
      })),
      serviceProbes: (currentState.serviceProbes || []).map((probe) => ({
        id: probe.id,
        ok: probe.ok,
        statusCode: probe.statusCode
      })),
      configFingerprint: currentState.configFingerprint || ''
    });
  }

  collectHostMetrics(now) {
    const meminfo = parseKeyValueFile(path.join(this.procPath, 'meminfo'));
    const loadavg = safeReadText(path.join(this.procPath, 'loadavg')).trim().split(/\s+/);
    const uptimeRaw = safeReadText(path.join(this.procPath, 'uptime')).trim().split(/\s+/)[0] || '0';
    const cpuLine = safeReadText(path.join(this.procPath, 'stat')).split(/\r?\n/)[0] || 'cpu 0 0 0 0 0 0 0 0';
    const networkLines = safeReadText(path.join(this.procPath, 'net', 'dev')).split(/\r?\n/).slice(2);

    const cpuParts = cpuLine.trim().split(/\s+/).slice(1).map((value) => Number(value));
    const idle = (cpuParts[3] || 0) + (cpuParts[4] || 0);
    const total = cpuParts.reduce((sum, value) => sum + value, 0);
    const previousCpu = this.db.getState('host:cpu', { idle: 0, total: 0, at: now });
    const totalDelta = total - previousCpu.total;
    const idleDelta = idle - previousCpu.idle;
    const cpuPercent = totalDelta > 0 ? Math.round((1 - (idleDelta / totalDelta)) * 1000) / 10 : 0;
    this.db.setState('host:cpu', { idle, total, at: now });

    let rxBytes = 0;
    let txBytes = 0;
    networkLines.forEach((line) => {
      if (!line.includes(':')) {
        return;
      }
      const [iface, valuesText] = line.split(':');
      if (iface.trim() === 'lo') {
        return;
      }
      const values = valuesText.trim().split(/\s+/).map((value) => Number(value));
      rxBytes += values[0] || 0;
      txBytes += values[8] || 0;
    });

    const previousNetwork = this.db.getState('host:network', { rxBytes, txBytes, at: now });
    const elapsedSeconds = Math.max(1, (now - previousNetwork.at) / 1000);
    const rxRate = Math.max(0, rxBytes - previousNetwork.rxBytes) / elapsedSeconds;
    const txRate = Math.max(0, txBytes - previousNetwork.txBytes) / elapsedSeconds;
    this.db.setState('host:network', { rxBytes, txBytes, at: now });

    const statfs = fs.statfsSync(this.rootPath);
    const diskTotal = statfs.bsize * statfs.blocks;
    const diskFree = statfs.bsize * statfs.bavail;
    const diskUsed = diskTotal - diskFree;

    const memoryTotal = Number(meminfo.MemTotal?.split(/\s+/)[0] || 0) * 1024;
    const memoryAvailable = Number(meminfo.MemAvailable?.split(/\s+/)[0] || 0) * 1024;
    const memoryUsed = Math.max(0, memoryTotal - memoryAvailable);

    return {
      cpuPercent,
      memoryTotalMb: toMegabytes(memoryTotal),
      memoryUsedMb: toMegabytes(memoryUsed),
      memoryPercent: toPercent(memoryUsed, memoryTotal),
      swapTotalMb: toMegabytes(Number(meminfo.SwapTotal?.split(/\s+/)[0] || 0) * 1024),
      swapUsedMb: toMegabytes((Number(meminfo.SwapTotal?.split(/\s+/)[0] || 0) - Number(meminfo.SwapFree?.split(/\s+/)[0] || 0)) * 1024),
      diskTotalGb: toGigabytes(diskTotal),
      diskUsedGb: toGigabytes(diskUsed),
      diskPercent: toPercent(diskUsed, diskTotal),
      loadAverage: loadavg.slice(0, 3).map((value) => Number(value || 0)),
      uptimeSeconds: Math.floor(Number(uptimeRaw || 0)),
      networkRxPerSecKb: Math.round((rxRate / 1024) * 10) / 10,
      networkTxPerSecKb: Math.round((txRate / 1024) * 10) / 10
    };
  }

  collectTopProcesses(now, limit = 10) {
    const statLines = safeReadText(path.join(this.procPath, 'stat')).split(/\r?\n/).filter(Boolean);
    const cpuLine = statLines[0] || 'cpu 0 0 0 0 0 0 0 0';
    const cpuParts = cpuLine.trim().split(/\s+/).slice(1).map((value) => Number(value));
    const totalCpuJiffies = cpuParts.reduce((sum, value) => sum + value, 0);
    const cpuCount = Math.max(1, statLines.filter((line) => /^cpu\d+\s/.test(line)).length);
    const meminfo = parseKeyValueFile(path.join(this.procPath, 'meminfo'));
    const memoryTotalBytes = Number(meminfo.MemTotal?.split(/\s+/)[0] || 0) * 1024;
    const previousState = this.db.getState('host:processCpuState', {
      version: 2,
      totalCpuJiffies,
      at: now,
      cpuCount,
      processes: {}
    });
    const previousProcesses = previousState?.version === 2 ? (previousState.processes || {}) : {};
    const totalDelta = Math.max(0, totalCpuJiffies - Number(previousState.totalCpuJiffies || totalCpuJiffies));
    const nextProcesses = {};
    let entries = [];

    try {
      entries = fs.readdirSync(this.procPath, { withFileTypes: true });
    } catch (_) {
      return [];
    }

    const processes = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => {
        const pid = Number(entry.name);
        const procDir = path.join(this.procPath, entry.name);
        const parsed = parseProcessStat(safeReadText(path.join(procDir, 'stat')).trim());
        if (!parsed) {
          return null;
        }

        const totalProcessJiffies = Math.max(0, Number(parsed.utime || 0) + Number(parsed.stime || 0));
        nextProcesses[String(pid)] = {
          totalProcessJiffies,
          startTime: Number(parsed.startTime || 0)
        };
        const previousProcess = previousProcesses[String(pid)] || null;
        const previousProcessJiffies = previousProcess && Number(previousProcess.startTime || 0) === Number(parsed.startTime || 0)
          ? Number(previousProcess.totalProcessJiffies || totalProcessJiffies)
          : totalProcessJiffies;
        const processDelta = Math.max(0, totalProcessJiffies - previousProcessJiffies);
        const rssBytes = Math.max(0, Number(parsed.rssPages || 0) * 4096);
        const command = readCommandLine(path.join(procDir, 'cmdline'), parsed.name || String(pid));

        return {
          pid,
          name: parsed.name || String(pid),
          command,
          serviceLabel: inferKnownService(parsed.name, command),
          state: parsed.state || '-',
          cpuPercent: totalDelta > 0 ? Math.round(((processDelta / totalDelta) * cpuCount) * 1000) / 10 : 0,
          memoryPercent: memoryTotalBytes > 0 ? Math.round(((rssBytes / memoryTotalBytes) * 1000)) / 10 : 0,
          memoryMb: toMegabytes(rssBytes),
          threads: Number(parsed.threads || 0),
          nice: Number(parsed.nice || 0)
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (right.cpuPercent !== left.cpuPercent) return right.cpuPercent - left.cpuPercent;
        if (right.memoryMb !== left.memoryMb) return right.memoryMb - left.memoryMb;
        return left.pid - right.pid;
      })
      .slice(0, Math.max(1, limit));

    this.db.setState('host:processCpuState', {
      version: 2,
      totalCpuJiffies,
      at: now,
      cpuCount,
      processes: nextProcesses
    });
    return processes;
  }

  async collectDockerOverview(containers = []) {
    const overview = { images: [], networks: [], volumes: [], diskUsage: null };
    try {
      const images = await this.dockerRequestJson('/images/json');
      overview.images = (images || []).map((img) => {
        const tags = img.RepoTags || [];
        const sizeMb = Math.round((img.Size || 0) / 1048576);
        const created = img.Created ? new Date(img.Created * 1000).toISOString() : null;
        return { id: (img.Id || '').replace('sha256:', '').slice(0, 12), tags, sizeMb, created, containers: img.Containers ?? 0 };
      }).sort((a, b) => b.sizeMb - a.sizeMb);
    } catch (_) { /* Docker API may not be available */ }

    try {
      const networks = await this.dockerRequestJson('/networks');
      const networkUsage = new Map();
      containers.forEach((container) => {
        (container.networks || []).forEach((network) => {
          if (!network?.name) return;
          if (!networkUsage.has(network.name)) {
            networkUsage.set(network.name, []);
          }
          networkUsage.get(network.name).push({
            containerName: container.name,
            containerId: String(container.id || '').slice(0, 12),
            ipv4: network.ipv4 || '',
            ipv6: network.ipv6 || ''
          });
        });
      });

      const networkMap = new Map((networks || []).map((net) => [net.Name, net]));
      networkUsage.forEach((_, networkName) => {
        if (!networkMap.has(networkName)) {
          networkMap.set(networkName, { Name: networkName, Driver: 'unknown', Scope: 'local', Id: networkName });
        }
      });

      overview.networks = Array.from(networkMap.values()).map((net) => {
        const connectedContainers = (networkUsage.get(net.Name) || []).sort((left, right) => left.containerName.localeCompare(right.containerName));
        return {
          name: net.Name,
          driver: net.Driver,
          scope: net.Scope,
          containerCount: connectedContainers.length,
          connectedContainers,
          id: (net.Id || '').slice(0, 12)
        };
      }).sort((left, right) => {
        if (right.containerCount !== left.containerCount) return right.containerCount - left.containerCount;
        return left.name.localeCompare(right.name);
      });
    } catch (_) { /* ignore */ }

    try {
      const volumes = await this.dockerRequestJson('/volumes');
      const vList = volumes?.Volumes || [];
      overview.volumes = vList.map((v) => {
        return { name: v.Name?.slice(0, 40) || '-', driver: v.Driver || '-', mountpoint: v.Mountpoint || '-' };
      });
    } catch (_) { /* ignore */ }

    try {
      const df = await this.dockerRequestJson('/system/df');
      if (df) {
        const imgSize = (df.Images || []).reduce((s, i) => s + (i.Size || 0), 0);
        const containerSize = (df.Containers || []).reduce((s, c) => s + (c.SizeRw || 0), 0);
        const volumeSize = (df.Volumes || []).reduce((s, v) => s + (v.UsageData?.Size || 0), 0);
        const buildCache = (df.BuildCache || []).reduce((s, b) => s + (b.Size || 0), 0);
        overview.diskUsage = {
          imagesMb: Math.round(imgSize / 1048576),
          containersMb: Math.round(containerSize / 1048576),
          volumesMb: Math.round(volumeSize / 1048576),
          buildCacheMb: Math.round(buildCache / 1048576),
          totalMb: Math.round((imgSize + containerSize + volumeSize + buildCache) / 1048576)
        };
      }
    } catch (_) { /* ignore */ }

    return overview;
  }

  async collectContainerMetrics() {
    const containers = await this.dockerRequestJson('/containers/json?all=1');
    const output = [];

    for (const item of containers) {
      const name = normalizeContainerName(item.Names?.[0] || item.Id);
      const inspect = await this.dockerRequestJson(`/containers/${item.Id}/json`);

      let cpuPercent = 0;
      let memoryUsedMb = 0;
      let memoryLimitMb = 0;
      let memoryPercent = 0;

      if (inspect.State?.Running) {
        try {
          const stats = await this.dockerRequestJson(`/containers/${item.Id}/stats?stream=false`);
          cpuPercent = parseDockerCpuPercent(stats);
          memoryUsedMb = toMegabytes(stats.memory_stats?.usage || 0);
          memoryLimitMb = toMegabytes(stats.memory_stats?.limit || 0);
          memoryPercent = toPercent(stats.memory_stats?.usage || 0, stats.memory_stats?.limit || 0);
        } catch (error) {
          cpuPercent = 0;
        }
      }

      const portBindings = inspect.HostConfig?.PortBindings || {};
      const ports = [];
      const exposedExternal = new Set();

      // Collect published (host-bound) ports
      Object.entries(portBindings).forEach(([containerPort, bindings]) => {
        if (bindings && bindings.length) {
          bindings.forEach((b) => {
            const hostPort = b.HostPort;
            const hostIp = b.HostIp || '0.0.0.0';
            ports.push(`${hostIp}:${hostPort}->${containerPort}`);
            if (hostIp === '0.0.0.0' || hostIp === '::') {
              exposedExternal.add(hostPort);
            }
          });
        }
      });

      // Fallback: use item.Ports from listing if no bindings found
      if (!ports.length && item.Ports && item.Ports.length) {
        item.Ports.forEach((p) => {
          if (p.PublicPort) {
            ports.push(`${p.IP || '0.0.0.0'}:${p.PublicPort}->${p.PrivatePort}/${p.Type}`);
            if (!p.IP || p.IP === '0.0.0.0' || p.IP === '::') {
              exposedExternal.add(String(p.PublicPort));
            }
          } else {
            ports.push(`${p.PrivatePort}/${p.Type}`);
          }
        });
      }

      const networks = Object.entries(inspect.NetworkSettings?.Networks || {}).map(([networkName, networkInfo]) => ({
        name: networkName,
        ipv4: networkInfo?.IPAddress || '',
        ipv6: networkInfo?.GlobalIPv6Address || '',
        mac: networkInfo?.MacAddress || '',
        gateway: networkInfo?.Gateway || '',
        endpointId: networkInfo?.EndpointID ? String(networkInfo.EndpointID).slice(0, 12) : ''
      }));
      const primaryNetwork = networks.find((network) => network.ipv4) || networks[0] || null;
      const mounts = (inspect.Mounts || []).map((mount) => ({
        type: mount.Type || '',
        name: mount.Name || '',
        source: mount.Source || '',
        destination: mount.Destination || '',
        mode: mount.Mode || '',
        readWrite: Boolean(mount.RW)
      }));

      output.push({
        id: item.Id,
        name,
        image: item.Image,
        state: item.State,
        status: item.Status,
        health: inspect.State?.Health?.Status || null,
        restartCount: inspect.RestartCount || 0,
        cpuPercent,
        memoryUsedMb,
        memoryLimitMb,
        memoryPercent,
        logPath: inspect.LogPath || null,
        ports: ports.join(', ') || '-',
        exposedExternal: exposedExternal.size > 0,
        networks,
        networkNames: networks.map((network) => network.name),
        primaryIp: primaryNetwork?.ipv4 || primaryNetwork?.ipv6 || '',
        primaryNetwork: primaryNetwork?.name || '',
        mounts
      });
    }

    return output.sort((left, right) => right.memoryUsedMb - left.memoryUsedMb);
  }

  ingestCaddyAccessLogs() {
    if (!fs.existsSync(this.caddyLogDir)) {
      return;
    }

    const files = fs.readdirSync(this.caddyLogDir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => path.join(this.caddyLogDir, name));

    files.forEach((filePath) => {
      const lines = this.readNewLines(filePath, `caddy:${filePath}`);
      if (!lines.length) {
        return;
      }

      const buckets = new Map();
      const accessEntries = [];

      lines.forEach((line) => {
        try {
          const entry = JSON.parse(line);
          const unixSeconds = Number(entry.ts || entry.timestamp || 0);
          const capturedAt = unixSeconds > 0 ? Math.floor(unixSeconds * 1000) : Date.now();
          const bucketAt = capturedAt - (capturedAt % 60000);
          const request = entry.request || {};
          const status = Number(entry.status || entry.resp_headers?.status || 0);
          const durationMs = entry.duration ? Math.round((Number(entry.duration) / 1e6) * 10) / 10 : 0;
          const pathKey = request.uri || request.path || '/';
          const clientIp = request.remote_ip || request.remote_addr || (request.headers && request.headers['X-Forwarded-For'] && request.headers['X-Forwarded-For'][0]) || '-';
          const userAgent = (request.headers && request.headers['User-Agent'] && request.headers['User-Agent'][0]) || '-';
          const size = Number(entry.size || entry.resp_headers?.['Content-Length'] || 0);
          const proto = request.proto || '-';
          const host = request.host || '-';
          const method = request.method || 'GET';

          accessEntries.push({
            capturedAt,
            clientIp,
            method,
            host,
            uri: pathKey,
            fullUrl: `${host}${pathKey}`,
            status,
            durationMs,
            size,
            userAgent,
            proto
          });

          if (!buckets.has(bucketAt)) {
            buckets.set(bucketAt, {
              bucketAt,
              totalRequests: 0,
              status2xx: 0,
              status3xx: 0,
              status4xx: 0,
              status5xx: 0,
              avgDurationMs: 0,
              topPaths: {},
              durations: []
            });
          }

          const rollup = buckets.get(bucketAt);
          rollup.totalRequests += 1;
          if (status >= 200 && status < 300) {
            rollup.status2xx += 1;
          } else if (status >= 300 && status < 400) {
            rollup.status3xx += 1;
          } else if (status >= 400 && status < 500) {
            rollup.status4xx += 1;
          } else if (status >= 500) {
            rollup.status5xx += 1;
          }
          rollup.durations.push(durationMs);
          rollup.topPaths[pathKey] = (rollup.topPaths[pathKey] || 0) + 1;
        } catch (error) {
          // Ignore malformed lines.
        }
      });

      if (accessEntries.length) {
        this.db.insertAccessEntries(accessEntries);
      }

      buckets.forEach((rollup) => {
        const totalDuration = rollup.durations.reduce((sum, value) => sum + value, 0);
        const topPaths = Object.fromEntries(
          Object.entries(rollup.topPaths)
            .sort((left, right) => right[1] - left[1])
            .slice(0, 8)
        );

        this.db.mergeAccessRollup({
          bucketAt: rollup.bucketAt,
          totalRequests: rollup.totalRequests,
          status2xx: rollup.status2xx,
          status3xx: rollup.status3xx,
          status4xx: rollup.status4xx,
          status5xx: rollup.status5xx,
          avgDurationMs: rollup.totalRequests ? totalDuration / rollup.totalRequests : 0,
          topPaths
        });
      });
    });
  }

  ingestImportantContainerLogs(containers) {
    const byName = new Map(containers.map((container) => [container.name, container]));
    const entries = [];

    this.selectedLogContainers.forEach((name) => {
      const container = byName.get(name);
      if (!container?.logPath || !fs.existsSync(container.logPath)) {
        return;
      }

      const lines = this.readNewLines(container.logPath, `container:${container.logPath}`);
      lines.forEach((line) => {
        try {
          const parsed = JSON.parse(line);
          const message = String(parsed.log || '').trim();
          if (!message || !IMPORTANT_LOG_PATTERN.test(message)) {
            return;
          }

          const capturedAt = parsed.time ? Date.parse(parsed.time) : Date.now();
          entries.push({
            capturedAt,
            sourceType: 'container',
            sourceName: container.name,
            level: guessLogLevel(message),
            message
          });
        } catch (error) {
          // Ignore malformed lines.
        }
      });
    });

    if (entries.length) {
      this.db.insertLogEntries(entries);
    }
  }

  readNewLines(filePath, stateKey) {
    const stats = fs.statSync(filePath);
    const state = this.db.getState(stateKey, { offset: 0, remainder: '' });
    let offset = state.offset || 0;
    let remainder = state.remainder || '';

    if (stats.size < offset) {
      offset = 0;
      remainder = '';
    }

    if (offset === 0 && stats.size > (5 * 1024 * 1024)) {
      offset = stats.size - (5 * 1024 * 1024);
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesToRead = stats.size - offset;
      const buffer = Buffer.alloc(Math.max(0, bytesToRead));
      if (bytesToRead > 0) {
        fs.readSync(fd, buffer, 0, bytesToRead, offset);
      }
      const text = remainder + buffer.toString('utf8');
      const parts = text.split(/\r?\n/);
      const nextRemainder = parts.pop() || '';
      this.db.setState(stateKey, { offset: stats.size, remainder: nextRemainder });
      return parts.filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  }

  getRecentAccessSamples(limit = 100) {
    if (!fs.existsSync(this.caddyLogDir)) {
      return [];
    }

    const files = fs.readdirSync(this.caddyLogDir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => path.join(this.caddyLogDir, name));

    const samples = [];
    files.forEach((filePath) => {
      tailLines(filePath, limit).forEach((line) => {
        try {
          const parsed = JSON.parse(line);
          const request = parsed.request || {};
          const clientIp = request.remote_ip || request.remote_addr || (request.headers && request.headers['X-Forwarded-For'] && request.headers['X-Forwarded-For'][0]) || '-';
          const userAgent = (request.headers && request.headers['User-Agent'] && request.headers['User-Agent'][0]) || '-';
          const host = request.host || '-';
          const uri = request.uri || '/';
          samples.push({
            capturedAt: parsed.ts ? Math.floor(Number(parsed.ts) * 1000) : Date.now(),
            method: request.method || 'GET',
            host,
            uri,
            fullUrl: `${host}${uri}`,
            status: Number(parsed.status || 0),
            durationMs: parsed.duration ? Math.round((Number(parsed.duration) / 1e6) * 10) / 10 : 0,
            size: Number(parsed.size || 0),
            clientIp,
            userAgent,
            proto: request.proto || '-'
          });
        } catch (error) {
          // Ignore malformed lines.
        }
      });
    });

    return samples
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .slice(0, limit);
  }

  getLiveContainerTails(containers, limit = 12) {
    const selected = new Set(this.selectedLogContainers);
    return containers
      .filter((container) => selected.has(container.name) && container.logPath && fs.existsSync(container.logPath))
      .map((container) => ({
        name: container.name,
        lines: tailLines(container.logPath, limit)
          .map((line) => {
            try {
              const parsed = JSON.parse(line);
              const message = String(parsed.log || '').trim();
              return {
                capturedAt: parsed.time ? Date.parse(parsed.time) : Date.now(),
                level: guessLogLevel(message),
                message
              };
            } catch (error) {
              return {
                capturedAt: Date.now(),
                level: 'info',
                message: line.trim()
              };
            }
          })
          .filter((entry) => entry.message)
          .slice(-limit)
      }));
  }
}

module.exports = {
  MonitorCollector
};