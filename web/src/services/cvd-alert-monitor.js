/**
 * CVD alert monitor - watches the top-movers coins and fires an alert when a
 * coin's backend-computed CVD distance crosses up through +0.98 or down through
 * -0.98. The browser receives only compact confirmed readings and owns alert
 * hysteresis; candle hydration, oscillator math, and closed-bar selection stay
 * on the server.
 *
 * Crossings are edge-triggered with a hysteresis band: a coin fires at most once
 * per excursion and only re-arms after the value pulls back inside ±0.5, so a
 * coin parked near the line doesn't chatter. The factory takes injected deps so
 * the crossing logic is unit-testable without DOM/network.
 *
 * The backend contract supplies only the latest closed 1h bar, so a coin can be
 * evaluated at most once per confirmed bar and never repaints mid-bar.
 */

const CROSS_THRESHOLD = 0.98;
const REARM_THRESHOLD = 0.5;
const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_SCAN_BATCH_SIZE = 40;

const MUTE_STORAGE_KEY = 'pez:cvd-alerts-muted';

// localStorage-backed mute flag (default = unmuted), matching the pez:* key
// convention used elsewhere (e.g. watchlist-store.js).
export function isCvdAlertsMuted() {
  try {
    return globalThis.localStorage?.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCvdAlertsMuted(muted) {
  try {
    if (muted) globalThis.localStorage?.setItem(MUTE_STORAGE_KEY, '1');
    else globalThis.localStorage?.removeItem(MUTE_STORAGE_KEY);
  } catch {
    // localStorage unavailable — mute is a best-effort preference.
  }
}

function uniqueCoins(coins) {
  const out = [];
  const seen = new Set();
  for (const coin of Array.isArray(coins) ? coins : []) {
    if (coin && !seen.has(coin)) {
      seen.add(coin);
      out.push(coin);
    }
  }
  return out;
}

export function createCvdAlertMonitor({
  getMoverCoins = () => [],
  fetchReadings = async () => ({ readings: [] }),
  onAlert = () => {},
  isMuted = isCvdAlertsMuted,
  getIsConnected = () => false,
  setIntervalFn = (cb, ms) => globalThis.setInterval(cb, ms),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
  intervalMs = DEFAULT_INTERVAL_MS,
  scanBatchSize = DEFAULT_SCAN_BATCH_SIZE,
} = {}) {
  // coin -> { armedHigh, armedLow, lastBarTime }. armed flags start undefined
  // until the first finite reading establishes a baseline.
  const state = new Map();
  let intervalId = null;
  let checkPromise = null;
  const batchSize = Math.max(1, Math.floor(Number(scanBatchSize) || DEFAULT_SCAN_BATCH_SIZE));

  function applyReading(coin, barTime, value, muted) {
    if (!coin || !Number.isFinite(barTime) || !Number.isFinite(value)) return;
    let st = state.get(coin);
    if (st && st.lastBarTime === barTime) return;

    if (!st) {
      st = { armedHigh: undefined, armedLow: undefined, lastBarTime: barTime };
      state.set(coin, st);
    } else {
      st.lastBarTime = barTime;
    }

    if (st.armedHigh === undefined) {
      st.armedHigh = value < CROSS_THRESHOLD;
      st.armedLow = value > -CROSS_THRESHOLD;
      return;
    }

    if (st.armedHigh && value >= CROSS_THRESHOLD) {
      st.armedHigh = false;
      if (!muted) onAlert({ coin, direction: 'up', value });
    } else if (!st.armedHigh && value < REARM_THRESHOLD) {
      st.armedHigh = true;
    }

    if (st.armedLow && value <= -CROSS_THRESHOLD) {
      st.armedLow = false;
      if (!muted) onAlert({ coin, direction: 'down', value });
    } else if (!st.armedLow && value > -REARM_THRESHOLD) {
      st.armedLow = true;
    }
  }

  async function runCheck() {
    if (!getIsConnected()) return;
    const coins = uniqueCoins(getMoverCoins());

    // Prune state for coins that have dropped off the mover list so a later
    // re-appearance re-establishes its baseline instead of replaying a stale
    // crossing.
    for (const coin of [...state.keys()]) {
      if (!coins.includes(coin)) state.delete(coin);
    }
    if (coins.length === 0) return;

    // Crossing state advances even while muted (so unmuting doesn't replay an
    // old excursion); only the onAlert callback is suppressed.
    const muted = isMuted();

    const monitored = new Set(coins);
    // The backend intentionally caps each compact scan request at 40 coins.
    // Process larger mover + watchlist sets sequentially so every coin remains
    // covered without turning one timer tick into a burst of upstream work.
    for (let offset = 0; offset < coins.length; offset += batchSize) {
      const payload = await fetchReadings(coins.slice(offset, offset + batchSize));
      const readings = Array.isArray(payload) ? payload : payload?.readings;
      for (const reading of Array.isArray(readings) ? readings : []) {
        if (!monitored.has(reading?.coin)) continue;
        applyReading(reading.coin, Number(reading.barTime), Number(reading.value), muted);
      }
    }
  }

  function checkMovers() {
    // A scan can legitimately run across a minute boundary when several
    // batches need store healing. Reuse the active pass instead of stacking a
    // second full-universe scan on the same backend lane.
    if (checkPromise) return checkPromise;
    checkPromise = runCheck().finally(() => {
      checkPromise = null;
    });
    return checkPromise;
  }

  function start() {
    if (intervalId) return;
    // Self-gates on getIsConnected, so it's safe to start before the market is
    // connected — the interval just no-ops until it is.
    checkMovers().catch(() => {});
    intervalId = setIntervalFn(() => {
      checkMovers().catch(() => {});
    }, intervalMs);
  }

  function stop() {
    if (intervalId) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
  }

  return { checkMovers, start, stop };
}

export default { createCvdAlertMonitor, isCvdAlertsMuted, setCvdAlertsMuted };
