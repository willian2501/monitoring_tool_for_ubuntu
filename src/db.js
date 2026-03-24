const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createEmptyStore() {
  return {
    latestSnapshot: null,
    snapshots: [],
    accessRollups: [],
    accessEntries: [],
    logEntries: [],
    hostSeries: [],
    geoCache: {},
    state: {}
  };
}

function toHistoricalPayload(payload) {
  const source = payload || {};
  return {
    generatedAt: source.generatedAt || 0,
    host: source.host || null,
    serviceProbes: Array.isArray(source.serviceProbes) ? source.serviceProbes : [],
    storageGrowth: source.storageGrowth || null,
    summary: source.summary || null
  };
}

function normalizeStore(rawStore) {
  const store = { ...createEmptyStore(), ...(rawStore || {}) };
  const snapshots = Array.isArray(store.snapshots) ? store.snapshots : [];
  const sortedSnapshots = snapshots
    .filter((entry) => entry && Number.isFinite(entry.collectedAt))
    .sort((left, right) => left.collectedAt - right.collectedAt);

  if (!store.latestSnapshot && sortedSnapshots.length) {
    store.latestSnapshot = sortedSnapshots[sortedSnapshots.length - 1];
  }

  store.snapshots = sortedSnapshots.map((entry) => ({
    collectedAt: entry.collectedAt,
    payload: toHistoricalPayload(entry.payload)
  }));

  return store;
}

function openDatabase(databasePath) {
  ensureParentDir(databasePath);

  let store = createEmptyStore();
  if (fs.existsSync(databasePath)) {
    try {
      store = normalizeStore(JSON.parse(fs.readFileSync(databasePath, 'utf8')));
    } catch (error) {
      store = createEmptyStore();
    }
  }

  function persist() {
    fs.writeFileSync(databasePath, JSON.stringify(store), 'utf8');
  }

  function buildHostSeriesPoint(collectedAt, host) {
    return {
      t: collectedAt,
      cpu: Number(host?.cpuPercent || 0),
      mem: Number(host?.memoryPercent || 0),
      disk: Number(host?.diskPercent || 0),
      rx: Number(host?.networkRxPerSecKb || 0),
      tx: Number(host?.networkTxPerSecKb || 0)
    };
  }

  return {
    insertSnapshot(collectedAt, payload) {
      store.latestSnapshot = { collectedAt, payload };
      store.snapshots = store.snapshots.filter((entry) => entry.collectedAt !== collectedAt);
      store.snapshots.push({ collectedAt, payload: toHistoricalPayload(payload) });
      store.snapshots.sort((left, right) => left.collectedAt - right.collectedAt);
      persist();
    },
    getLatestSnapshot() {
      return store.latestSnapshot || (store.snapshots.length ? store.snapshots[store.snapshots.length - 1] : null);
    },
    getSnapshotsSince(since) {
      return store.snapshots.filter((entry) => entry.collectedAt >= since);
    },
    getAccessRollupsSince(since) {
      return store.accessRollups
        .filter((entry) => entry.bucketAt >= since)
        .sort((left, right) => left.bucketAt - right.bucketAt);
    },
    mergeAccessRollup(rollup) {
      const existing = store.accessRollups.find((entry) => entry.bucketAt === rollup.bucketAt);
      if (!existing) {
        store.accessRollups.push({ ...rollup });
      } else {
        const mergedCount = existing.totalRequests + rollup.totalRequests;
        existing.avgDurationMs = mergedCount === 0
          ? 0
          : ((existing.avgDurationMs * existing.totalRequests) + (rollup.avgDurationMs * rollup.totalRequests)) / mergedCount;
        existing.totalRequests = mergedCount;
        existing.status2xx += rollup.status2xx;
        existing.status3xx += rollup.status3xx;
        existing.status4xx += rollup.status4xx;
        existing.status5xx += rollup.status5xx;
        existing.topPaths = existing.topPaths || {};
        Object.entries(rollup.topPaths || {}).forEach(([pathKey, count]) => {
          existing.topPaths[pathKey] = (existing.topPaths[pathKey] || 0) + count;
        });
      }
      store.accessRollups.sort((left, right) => left.bucketAt - right.bucketAt);
      persist();
    },
    insertLogEntries(entries) {
      store.logEntries.push(...entries);
      store.logEntries.sort((left, right) => right.capturedAt - left.capturedAt);
      persist();
    },
    getRecentLogs(limit, opts = {}) {
      let filtered = store.logEntries;
      if (opts.search) {
        const pattern = new RegExp(opts.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filtered = filtered.filter((e) => pattern.test(e.message) || pattern.test(e.sourceName));
      }
      if (opts.level) {
        filtered = filtered.filter((e) => e.level === opts.level);
      }
      if (opts.source) {
        filtered = filtered.filter((e) => e.sourceName === opts.source);
      }
      return filtered
        .sort((left, right) => right.capturedAt - left.capturedAt)
        .slice(0, limit);
    },
    insertAccessEntries(entries) {
      store.accessEntries.push(...entries);
      store.accessEntries.sort((left, right) => right.capturedAt - left.capturedAt);
      const maxEntries = 10000;
      if (store.accessEntries.length > maxEntries) {
        store.accessEntries = store.accessEntries.slice(0, maxEntries);
      }
      persist();
    },
    getAccessEntries(opts = {}) {
      let filtered = store.accessEntries;
      if (opts.since !== undefined) {
        filtered = filtered.filter((e) => e.capturedAt >= opts.since);
      }
      if (opts.statusMin !== undefined) {
        filtered = filtered.filter((e) => e.status >= opts.statusMin);
      }
      if (opts.statusMax !== undefined) {
        filtered = filtered.filter((e) => e.status < opts.statusMax);
      }
      if (opts.ip) {
        filtered = filtered.filter((e) => e.clientIp === opts.ip);
      }
      if (opts.method) {
        filtered = filtered.filter((e) => e.method === opts.method);
      }
      if (opts.search) {
        const pattern = new RegExp(opts.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filtered = filtered.filter((e) => pattern.test(e.fullUrl) || pattern.test(e.uri) || pattern.test(e.clientIp) || pattern.test(e.userAgent));
      }
      return filtered
        .sort((left, right) => right.capturedAt - left.capturedAt)
        .slice(0, opts.limit || filtered.length);
    },
    getTopUrls(since, limit = 15) {
      const urls = {};
      store.accessEntries
        .filter((e) => e.capturedAt >= since)
        .forEach((e) => {
          urls[e.fullUrl] = (urls[e.fullUrl] || 0) + 1;
        });
      return Object.entries(urls)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([url, count]) => ({ url, count }));
    },
    getTopClientIps(since, limit = 15) {
      const ips = {};
      store.accessEntries
        .filter((e) => e.capturedAt >= since)
        .forEach((e) => {
          if (e.clientIp && e.clientIp !== '-') {
            ips[e.clientIp] = (ips[e.clientIp] || 0) + 1;
          }
        });
      return Object.entries(ips)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([ip, count]) => ({ ip, count }));
    },
    getErrorEntries(since) {
      return store.accessEntries
        .filter((e) => e.capturedAt >= since && e.status >= 400)
        .sort((left, right) => right.capturedAt - left.capturedAt);
    },
    getState(key, fallback = null) {
      return Object.prototype.hasOwnProperty.call(store.state, key) ? store.state[key] : fallback;
    },
    setState(key, value) {
      store.state[key] = value;
      persist();
    },
    insertHostSeriesPoint(point, options = {}) {
      if (!store.hostSeries) store.hostSeries = [];
      store.hostSeries.push(point);
      if (options.persist) {
        persist();
      }
    },
    getHostSeriesSince(since) {
      return (store.hostSeries || []).filter((p) => p.t >= since);
    },
    setLatestHostSample(collectedAt, host, options = {}) {
      if (!store.hostSeries) store.hostSeries = [];
      store.hostSeries.push(buildHostSeriesPoint(collectedAt, host));
      store.state.latestHostSample = { collectedAt, host };
      if (options.persist !== false) {
        persist();
      }
    },
    getLatestHostSample() {
      return store.state.latestHostSample || null;
    },
    getGeoInfo(ip) {
      return (store.geoCache || {})[ip] || null;
    },
    setGeoBatch(entries) {
      if (!store.geoCache) store.geoCache = {};
      for (const [ip, data] of entries) {
        store.geoCache[ip] = data;
      }
      persist();
    },
    pruneBefore(cutoff) {
      store.snapshots = store.snapshots.filter((entry) => entry.collectedAt >= cutoff);
      store.hostSeries = (store.hostSeries || []).filter((entry) => entry.t >= cutoff);
      store.accessRollups = store.accessRollups.filter((entry) => entry.bucketAt >= cutoff);
      store.accessEntries = (store.accessEntries || []).filter((entry) => entry.capturedAt >= cutoff);
      store.logEntries = store.logEntries.filter((entry) => entry.capturedAt >= cutoff);
      const geoCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const cache = store.geoCache || {};
      Object.keys(cache).forEach((ip) => {
        if (cache[ip].cachedAt < geoCutoff) delete cache[ip];
      });
      persist();
    }
  };
}

module.exports = {
  openDatabase
};