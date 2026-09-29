/**
 * Market candle merge policy.
 *
 * Domain helpers used by stream handlers to fold incoming live candle ticks
 * into existing candle arrays. Pulled out of `streams/market-ws.js` so the
 * stream handler stays a transport-only adapter and the merge rules live in
 * one testable place.
 *
 * Merge:
 *   - Same bucket (incoming.t === last.t): replace the last entry with the
 *     latest exchange payload.
 *   - New bucket (incoming.t > last.t): append it unchanged.
 *   - Out of order (incoming.t < last.t): drop. lightweight-charts requires
 *     ordered data and series.update() rejects bars older than the latest.
 */

// Match the infinite-history loader's in-memory cap. A live tick must not
// silently collapse a 5,000+ bar historical snapshot to a short tail, which
// would desynchronize canonical candles from the already-rendered native and
// indicator series.
const DEFAULT_MAX_CANDLES = 40000;
const FIXED_TIMEFRAME_MS = Object.freeze({
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
});
const WEEK_SECONDS = 7 * 24 * 60 * 60;
// Unix epoch (1970-01-01) was a Thursday. Shift four days so integer week
// boundaries land on Monday 00:00 UTC — the Hyperliquid 1w cadence.
const MONDAY_EPOCH_OFFSET_SECONDS = 4 * 24 * 60 * 60;

function mondayUtcWeekStartSeconds(timeSeconds) {
  const numeric = Number(timeSeconds);
  if (!Number.isFinite(numeric)) return 0;
  return Math.floor((numeric - MONDAY_EPOCH_OFFSET_SECONDS) / WEEK_SECONDS)
    * WEEK_SECONDS + MONDAY_EPOCH_OFFSET_SECONDS;
}

// Open of the in-progress exchange bucket for this timeframe at nowMs.
// 1M uses the UTC calendar month start; 1w uses Monday 00:00 UTC. Fixed
// intervals use unix alignment. 30-day / Thursday-unix approximations are
// lookback math only and must not be used here.
function currentBucketOpenSeconds(timeframe = '', nowMs = Date.now()) {
  const nowSec = Math.floor(Number(nowMs) / 1000);
  if (!(nowSec > 0)) return 0;
  if (timeframe === '1M') {
    const date = new Date(nowSec * 1000);
    return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
  }
  if (timeframe === '1w') {
    return mondayUtcWeekStartSeconds(nowSec);
  }
  const durationMs = FIXED_TIMEFRAME_MS[timeframe];
  if (!(durationMs > 0)) return 0;
  const intervalSec = durationMs / 1000;
  return Math.floor(nowSec / intervalSec) * intervalSec;
}

function epochMilliseconds(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric >= 100_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
}

function candleCloseTimeMs(candle, timeframe = '') {
  const explicitEnd = epochMilliseconds(candle?.T);
  if (explicitEnd > 0) return explicitEnd;

  const openMs = epochMilliseconds(candle?.t);
  if (!(openMs > 0)) return 0;
  const interval = String(timeframe || candle?.i || '');
  if (interval === '1w') return openMs + (7 * 24 * 60 * 60_000);
  if (interval === '1M') {
    const date = new Date(openMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  const duration = FIXED_TIMEFRAME_MS[interval];
  return duration ? openMs + duration : 0;
}

/**
 * Return only exchange candles whose buckets have completed.
 *
 * Do not assume the final row is forming: sparse markets can legitimately end
 * on an older, already-closed candle. Hyperliquid's explicit end time wins
 * when present; synthetic/test rows fall back to the selected timeframe.
 */
function selectClosedCandles(candles = [], timeframe = '', nowMs = Date.now()) {
  const now = epochMilliseconds(nowMs);
  if (!(now > 0)) return [];
  return (Array.isArray(candles) ? candles : []).filter((candle) => {
    const closeTime = candleCloseTimeMs(candle, timeframe);
    return closeTime > 0 && closeTime <= now;
  });
}

function candleTimeSeconds(candle) {
  const numeric = Number(candle?.t || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric >= 100000000000) return Math.floor(numeric / 1000);
  return Math.floor(numeric);
}

function isValidExchangeCandle(candle) {
  const time = candleTimeSeconds(candle);
  const open = Number.parseFloat(candle?.o);
  const high = Number.parseFloat(candle?.h);
  const low = Number.parseFloat(candle?.l);
  const close = Number.parseFloat(candle?.c);
  const volume = Number.parseFloat(candle?.v);
  return time > 0
    && Number.isFinite(open)
    && Number.isFinite(high)
    && Number.isFinite(low)
    && Number.isFinite(close)
    && Number.isFinite(volume)
    && volume >= 0
    && high >= Math.max(open, close)
    && low <= Math.min(open, close)
    && high >= low;
}

/**
 * Produce the one canonical candle array consumed by the native series and all
 * derived indicators. Rows are never rewritten or synthesized: malformed rows
 * are rejected, duplicate timestamps use the latest authoritative payload, and
 * the result is strictly time ordered.
 */
function normalizeCandleSeries(candles = []) {
  const byTime = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    if (!isValidExchangeCandle(candle)) continue;
    byTime.set(candleTimeSeconds(candle), { ...candle });
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, candle]) => candle);
}

function mergeCandleSeries(...series) {
  return normalizeCandleSeries(series.flatMap((candles) => Array.isArray(candles) ? candles : []));
}

function mergeCandle({ existing, incoming, max = DEFAULT_MAX_CANDLES } = {}) {
  if (!incoming) return Array.isArray(existing) ? existing : [];
  const list = Array.isArray(existing) ? existing : [];
  const lastBar = list[list.length - 1];
  const lastTime = candleTimeSeconds(lastBar);
  const incomingTime = candleTimeSeconds(incoming);

  if (lastTime > 0 && incomingTime > 0 && incomingTime < lastTime) {
    return list;
  }
  if (lastBar && lastTime > 0 && incomingTime === lastTime) {
    const incomingTrades = Number(incoming?.n);
    const lastTrades = Number(lastBar?.n);
    if (Number.isFinite(incomingTrades) && Number.isFinite(lastTrades) && incomingTrades < lastTrades) {
      return list;
    }
    const merged = { ...incoming };
    // Keep the server-computed composite CVD delta: enriched ticks carry their
    // own; a bare tick (older server, enrichment declined) must not wipe the
    // snapshot's value or the tail CVD bar flips to the directional fallback.
    if (merged.cvdDelta == null && lastBar.cvdDelta != null) {
      merged.cvdDelta = lastBar.cvdDelta;
    }
    return list.slice(0, -1).concat(merged);
  }
  const next = list.concat({ ...incoming });
  return next.length > max ? next.slice(-max) : next;
}

export {
  DEFAULT_MAX_CANDLES,
  candleCloseTimeMs,
  candleTimeSeconds,
  currentBucketOpenSeconds,
  isValidExchangeCandle,
  mergeCandle,
  mergeCandleSeries,
  mondayUtcWeekStartSeconds,
  normalizeCandleSeries,
  selectClosedCandles,
};
