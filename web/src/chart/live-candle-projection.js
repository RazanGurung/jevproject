/**
 * Display-only forming candle projection.
 *
 * Canonical Hyperliquid candles remain untouched. Between exchange candle
 * messages, the active native candlestick follows the same mid/L2 price as the
 * live price line: open is fixed, close follows price, and wicks retain every
 * observed extreme. A later authoritative series update replaces this visual
 * projection.
 */

const FIXED_INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
});

function epochMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric >= 100_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
}

function mondayUtcStartMs(value) {
  const date = new Date(value);
  const day = date.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function bucketStartMs(value, timeframe = '2h') {
  const nowMs = epochMs(value);
  if (!(nowMs > 0)) return 0;
  if (timeframe === '1w') return mondayUtcStartMs(nowMs);
  if (timeframe === '1M') {
    const date = new Date(nowMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  const interval = FIXED_INTERVAL_MS[timeframe] || FIXED_INTERVAL_MS['2h'];
  return Math.floor(nowMs / interval) * interval;
}

function bucketEndMs(startMs, timeframe = '2h') {
  if (!(startMs > 0)) return 0;
  if (timeframe === '1w') return startMs + (7 * 24 * 60 * 60_000) - 1;
  if (timeframe === '1M') {
    const date = new Date(startMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
  }
  const interval = FIXED_INTERVAL_MS[timeframe] || FIXED_INTERVAL_MS['2h'];
  return startMs + interval - 1;
}

function finitePrice(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : NaN;
}

function resolveActiveBucket(candles, timeframe, nowMs) {
  const last = candles[candles.length - 1];
  const tailStart = epochMs(last?.t);
  if (!(tailStart > 0)) return null;
  const explicitEnd = epochMs(last?.T);
  const tailEnd = explicitEnd >= tailStart ? explicitEnd : bucketEndMs(tailStart, timeframe);
  if (nowMs >= tailStart && nowMs <= tailEnd) {
    return { startMs: tailStart, authoritative: last, authoritativeIndex: candles.length - 1 };
  }

  const calculatedStart = bucketStartMs(nowMs, timeframe);
  if (!(calculatedStart > tailStart)) return null;
  return { startMs: calculatedStart, authoritative: null, authoritativeIndex: -1 };
}

function createLiveCandleProjectionController() {
  let state = null;
  let updateCount = 0;

  function reset() {
    state = null;
  }

  function project({ candles = [], coin = '', timeframe = '2h', price, now = Date.now() } = {}) {
    const list = Array.isArray(candles) ? candles : [];
    const livePrice = finitePrice(price);
    const nowMs = epochMs(now);
    if (!coin || !timeframe || !Number.isFinite(livePrice) || !(nowMs > 0) || list.length === 0) return null;

    const bucket = resolveActiveBucket(list, timeframe, nowMs);
    if (!bucket) return null;
    const key = `${coin}:${timeframe}`;
    const previousCanonical = bucket.authoritativeIndex > 0
      ? list[bucket.authoritativeIndex - 1]
      : list[list.length - 1];
    const authoritative = bucket.authoritative;
    const open = finitePrice(
      authoritative
        ? (bucket.authoritativeIndex > 0 ? previousCanonical?.c : authoritative?.o)
        : previousCanonical?.c,
    );
    if (!Number.isFinite(open)) return null;

    const sameProjection = state?.key === key && state.bucketStartMs === bucket.startMs;
    const previousHigh = sameProjection ? finitePrice(state.candle.h) : NaN;
    const previousLow = sameProjection ? finitePrice(state.candle.l) : NaN;
    const authoritativeHigh = finitePrice(authoritative?.h);
    const authoritativeLow = finitePrice(authoritative?.l);
    const highs = [open, livePrice, previousHigh, authoritativeHigh].filter(Number.isFinite);
    const lows = [open, livePrice, previousLow, authoritativeLow].filter(Number.isFinite);
    const candle = {
      t: bucket.startMs,
      o: open,
      h: Math.max(...highs),
      l: Math.min(...lows),
      c: livePrice,
      v: authoritative?.v ?? 0,
    };

    state = {
      key,
      coin,
      timeframe,
      bucketStartMs: bucket.startMs,
      sourcePrice: livePrice,
      updatedAt: nowMs,
      candle,
    };
    updateCount += 1;
    return { ...candle };
  }

  function getDebugState() {
    return {
      projectedCandleActive: Boolean(state),
      projectedCandleKey: state?.key || '',
      projectedCandle: state ? { ...state.candle } : null,
      projectedCandleSourcePrice: state?.sourcePrice ?? null,
      projectedCandleUpdatedAt: state?.updatedAt || 0,
      projectedCandleUpdateCount: updateCount,
    };
  }

  return { project, reset, getDebugState };
}

export {
  bucketEndMs,
  bucketStartMs,
  createLiveCandleProjectionController,
  epochMs,
};
