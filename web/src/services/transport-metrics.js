function createTransportMetrics() {
  return {
    api: {
      requests: 0,
      successes: 0,
      errors: 0,
      rateLimits: 0,
      dedupHits: 0,
      byUrl: {},
      lastError: null,
      lastRequestAt: 0,
    },
    stream: {
      connectAttempts: 0,
      connects: 0,
      reconnectSchedules: 0,
      refreshes: 0,
      refreshSuppressed: 0,
      fastReconnects: 0,
      heartbeatTimeouts: 0,
      wakeDetections: 0,
      marketWakeDetections: 0,
      marketConnectAttempts: 0,
      marketConnects: 0,
      marketReconnectSchedules: 0,
      marketRefreshes: 0,
      marketHeartbeatTimeouts: 0,
      marketLastRefreshReason: '',
      candleResumeBackfills: 0,
      pollingEnabled: 0,
      pollingDisabled: 0,
      pollingTicks: 0,
      lastEventAt: 0,
    },
    resume: {
      events: 0,
      closedRecoveries: 0,
      staleRecoveries: 0,
      healthyRecoveries: 0,
      silentRecoveries: 0,
      overlayArmed: 0,
      lastEventAt: 0,
    },
  };
}

let transportMetrics = createTransportMetrics();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function syncTransportMetricsWindow() {
  if (typeof window === 'undefined') return;
  window.transportMetrics = clone(transportMetrics);
}

function ensureUrlMetrics(url) {
  const key = String(url || 'unknown');
  if (!transportMetrics.api.byUrl[key]) {
    transportMetrics.api.byUrl[key] = {
      requests: 0,
      successes: 0,
      errors: 0,
      rateLimits: 0,
      lastStatus: 0,
      lastError: '',
      lastRequestAt: 0,
    };
  }
  return transportMetrics.api.byUrl[key];
}

function recordApiResult({ url, status = 0, ok = false, message = '' } = {}) {
  const now = Date.now();
  const rateLimited = Number(status) === 429 || /429|rate limit/i.test(String(message || ''));
  const apiMetrics = transportMetrics.api;
  const urlMetrics = ensureUrlMetrics(url);

  apiMetrics.requests++;
  apiMetrics.lastRequestAt = now;
  urlMetrics.requests++;
  urlMetrics.lastStatus = Number(status) || 0;
  urlMetrics.lastRequestAt = now;

  if (ok) {
    apiMetrics.successes++;
    urlMetrics.successes++;
  } else {
    apiMetrics.errors++;
    urlMetrics.errors++;
    apiMetrics.lastError = {
      url: String(url || ''),
      status: Number(status) || 0,
      message: String(message || ''),
      at: now,
    };
    urlMetrics.lastError = String(message || '');
  }

  if (rateLimited) {
    apiMetrics.rateLimits++;
    urlMetrics.rateLimits++;
  }

  syncTransportMetricsWindow();
}

function recordApiDedupHit() {
  transportMetrics.api.dedupHits++;
  transportMetrics.api.lastRequestAt = Date.now();
  syncTransportMetricsWindow();
}

function recordStreamEvent(name) {
  const key = String(name || '').trim();
  if (!key) return;
  if (!Object.prototype.hasOwnProperty.call(transportMetrics.stream, key)) {
    transportMetrics.stream[key] = 0;
  }
  transportMetrics.stream[key]++;
  transportMetrics.stream.lastEventAt = Date.now();
  syncTransportMetricsWindow();
}

function recordMarketRefresh(reason = 'refresh') {
  transportMetrics.stream.marketRefreshes++;
  transportMetrics.stream.marketLastRefreshReason = String(reason || 'refresh');
  transportMetrics.stream.lastEventAt = Date.now();
  syncTransportMetricsWindow();
}

function recordResumeEvent(name) {
  const key = String(name || '').trim();
  if (!key) return;
  if (!Object.prototype.hasOwnProperty.call(transportMetrics.resume, key)) {
    transportMetrics.resume[key] = 0;
  }
  transportMetrics.resume[key]++;
  transportMetrics.resume.lastEventAt = Date.now();
  syncTransportMetricsWindow();
}

function getTransportMetricsSnapshot() {
  return clone(transportMetrics);
}

function resetTransportMetricsForTests() {
  transportMetrics = createTransportMetrics();
  syncTransportMetricsWindow();
}

syncTransportMetricsWindow();

export {
  getTransportMetricsSnapshot,
  recordApiDedupHit,
  recordApiResult,
  recordMarketRefresh,
  recordResumeEvent,
  recordStreamEvent,
  resetTransportMetricsForTests,
};
