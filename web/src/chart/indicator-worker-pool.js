import {
  INDICATOR_WORKER_SCRIPT,
  computeVolumeProfilesPure,
  computeHeikinAshiPure,
  computeRenkoBricksPure,
} from './indicator-worker-code.js';

let workerInstance = null;
let workerUrl = null;
let nextRequestId = 1;
const pendingRequests = new Map();
const latestRequestIdByType = new Map();

const stats = {
  workerActive: false,
  totalJobs: 0,
  workerJobs: 0,
  fallbackJobs: 0,
  lastDurationMs: 0,
  errors: 0,
};

function hasWorkerSupport() {
  return (
    typeof Worker !== 'undefined'
    && typeof Blob !== 'undefined'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function'
  );
}

function getOrCreateWorker() {
  if (workerInstance) return workerInstance;
  if (!hasWorkerSupport()) return null;

  try {
    const blob = new Blob([INDICATOR_WORKER_SCRIPT], { type: 'application/javascript' });
    workerUrl = URL.createObjectURL(blob);
    workerInstance = new Worker(workerUrl);

    workerInstance.onmessage = (e) => {
      const { id, success, result, error, durationMs } = e.data || {};
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);

      stats.lastDurationMs = Number(durationMs || 0);

      // Check if this result was superseded by a newer request of the same type
      if (latestRequestIdByType.get(pending.type) !== id) {
        pending.resolve(null); // Discard superseded/stale result
        return;
      }

      if (success) {
        stats.workerJobs++;
        pending.resolve(result);
      } else {
        stats.errors++;
        pending.reject(new Error(error || 'Worker execution failed'));
      }
    };

    workerInstance.onerror = (err) => {
      stats.errors++;
      stats.workerActive = false;
      console.warn('[IndicatorWorker] Worker error, falling back to sync:', err);
      // Reject all pending requests so they can fall back
      for (const [id, pending] of pendingRequests.entries()) {
        pendingRequests.delete(id);
        pending.reject(err);
      }
      terminateIndicatorWorker();
    };

    stats.workerActive = true;
    return workerInstance;
  } catch (err) {
    stats.workerActive = false;
    console.warn('[IndicatorWorker] Failed to create worker:', err);
    return null;
  }
}

export function terminateIndicatorWorker() {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  if (workerUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(workerUrl);
    workerUrl = null;
  }
  stats.workerActive = false;
}

/**
 * Executes an indicator computation either in the worker thread or falls back
 * synchronously on the main thread if workers are unavailable.
 */
export async function executeIndicatorTask(type, payload, fallbackFn) {
  stats.totalJobs++;
  const id = ++nextRequestId;
  latestRequestIdByType.set(type, id);

  const worker = getOrCreateWorker();
  if (!worker) {
    stats.fallbackJobs++;
    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const result = fallbackFn();
    const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    stats.lastDurationMs = end - start;
    return result;
  }

  return new Promise((resolve, reject) => {
    // 5-second timeout safeguard to ensure the UI never hangs
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        stats.fallbackJobs++;
        try {
          resolve(fallbackFn());
        } catch (err) {
          reject(err);
        }
      }
    }, 5000);

    pendingRequests.set(id, {
      type,
      resolve: (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      reject: (err) => {
        clearTimeout(timer);
        // On worker failure, try synchronous fallback
        try {
          stats.fallbackJobs++;
          resolve(fallbackFn());
        } catch (fallbackErr) {
          reject(fallbackErr);
        }
      },
    });

    try {
      worker.postMessage({ id, type, payload });
    } catch (postErr) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      stats.fallbackJobs++;
      resolve(fallbackFn());
    }
  });
}

/**
 * Offloads Volume Profile calculations to the Web Worker.
 */
export async function calculateVolumeProfilesAsync(candles, options = {}) {
  return executeIndicatorTask(
    'VOLUME_PROFILES',
    { candles, options },
    () => computeVolumeProfilesPure(candles, options),
  );
}

/**
 * Offloads Heikin Ashi calculations to the Web Worker.
 */
export async function calculateHeikinAshiAsync(candles = []) {
  return executeIndicatorTask(
    'HEIKIN_ASHI',
    { candles },
    () => computeHeikinAshiPure(candles),
  );
}

/**
 * Offloads Renko Brick calculations to the Web Worker.
 */
export async function calculateRenkoBricksAsync(candles = [], options = {}) {
  return executeIndicatorTask(
    'RENKO_BRICKS',
    { candles, options },
    () => computeRenkoBricksPure(candles, options),
  );
}

/**
 * Returns diagnostic metrics for the indicator worker pool.
 */
export function getIndicatorWorkerStats() {
  return { ...stats };
}
