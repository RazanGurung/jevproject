/**
 * Chart history depth for display candles and indicator warmup.
 * Mirrors internal/chartrequirements/requirements.go so the browser
 * requests the same window the candle store warms and retains.
 */

export const UPSTREAM_CANDLE_CAP = 5000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const CVD_WEEK_LOOKBACK_MS = 8 * DAY_MS;
export const DEFAULT_TIMEFRAME = '2h';

export const TIMEFRAME_MS = Object.freeze({
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': DAY_MS,
  '1w': 7 * DAY_MS,
  '1M': 30 * DAY_MS,
});

// 90d viewport + 90d CVD oscillator + six UTC months of volume profile
// (~186d) plus calendar slack. Matches IndicatorStableLookbackMs.
export const INDICATOR_STABLE_LOOKBACK_MS = 190 * DAY_MS;

export const CHART_DISPLAY_LOOKBACK_MS = Object.freeze({
  '1m': 7 * DAY_MS,
  '5m': 20 * DAY_MS,
  '15m': INDICATOR_STABLE_LOOKBACK_MS,
  '30m': INDICATOR_STABLE_LOOKBACK_MS,
  '1h': INDICATOR_STABLE_LOOKBACK_MS,
  '2h': INDICATOR_STABLE_LOOKBACK_MS,
  '4h': INDICATOR_STABLE_LOOKBACK_MS,
  '8h': INDICATOR_STABLE_LOOKBACK_MS,
  '1d': INDICATOR_STABLE_LOOKBACK_MS,
  '1w': 720 * DAY_MS,
  '1M': 3100 * DAY_MS,
});

export function intervalMs(timeframe) {
  return TIMEFRAME_MS[timeframe] || 0;
}

export function reachableLookbackMs(interval, requestedMs) {
  const requested = Number(requestedMs) || 0;
  if (requested <= 0) return requested;
  const width = intervalMs(interval);
  if (width <= 0) return requested;
  const capMs = UPSTREAM_CANDLE_CAP * width;
  if (capMs > 0 && capMs < requested) return capMs;
  return requested;
}

export function getInitialHistoryLookbackMs(timeframe) {
  const configured = CHART_DISPLAY_LOOKBACK_MS[timeframe] || (2 * 60 * 60 * 1000);
  const width = intervalMs(timeframe);
  const withCvdWeek = width > intervalMs('5m')
    ? Math.max(configured, CVD_WEEK_LOOKBACK_MS)
    : configured;
  return reachableLookbackMs(timeframe, withCvdWeek);
}

export function candleTimeMs(candle) {
  const raw = Number(candle?.t || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100_000_000_000 ? raw : raw * 1000;
}

export function hasEnoughCachedHistory(candles, requiredLookbackMs, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length === 0) return false;
  // A full Hyperliquid response is the deepest history that interval can
  // ever yield. Treat it as complete even when the wall-clock span is a
  // little short of the declared window (empty buckets, listing age).
  if (candles.length >= Math.floor(UPSTREAM_CANDLE_CAP * 0.95)) return true;
  const first = candleTimeMs(candles[0]);
  const last = candleTimeMs(candles[candles.length - 1]);
  if (!(first > 0) || !(last >= first)) return false;
  const span = Math.max(last, now) - first;
  const required = Number(requiredLookbackMs) || 0;
  if (!(required > 0)) return true;
  return span >= required * 0.9;
}
