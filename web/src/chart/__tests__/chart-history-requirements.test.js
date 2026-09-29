import { describe, expect, it } from 'vitest';

import {
  CHART_DISPLAY_LOOKBACK_MS,
  DAY_MS,
  DEFAULT_TIMEFRAME,
  INDICATOR_STABLE_LOOKBACK_MS,
  UPSTREAM_CANDLE_CAP,
  getInitialHistoryLookbackMs,
  hasEnoughCachedHistory,
  intervalMs,
  reachableLookbackMs,
} from '../chart-history-requirements.js';

describe('chart history requirements', () => {
  it('matches the backend default landing timeframe', () => {
    expect(DEFAULT_TIMEFRAME).toBe('2h');
  });

  it('clamps declared windows to Hyperliquid 5000-candle retention', () => {
    expect(getInitialHistoryLookbackMs('1m')).toBe(UPSTREAM_CANDLE_CAP * intervalMs('1m'));
    expect(getInitialHistoryLookbackMs('5m')).toBe(UPSTREAM_CANDLE_CAP * intervalMs('5m'));
    expect(getInitialHistoryLookbackMs('15m')).toBe(UPSTREAM_CANDLE_CAP * intervalMs('15m'));
    expect(getInitialHistoryLookbackMs('30m')).toBe(UPSTREAM_CANDLE_CAP * intervalMs('30m'));
    expect(getInitialHistoryLookbackMs('1h')).toBe(INDICATOR_STABLE_LOOKBACK_MS);
    expect(getInitialHistoryLookbackMs('2h')).toBe(INDICATOR_STABLE_LOOKBACK_MS);
    expect(getInitialHistoryLookbackMs('4h')).toBe(INDICATOR_STABLE_LOOKBACK_MS);
    expect(getInitialHistoryLookbackMs('8h')).toBe(INDICATOR_STABLE_LOOKBACK_MS);
    expect(getInitialHistoryLookbackMs('1d')).toBe(INDICATOR_STABLE_LOOKBACK_MS);
    expect(getInitialHistoryLookbackMs('1w')).toBe(720 * DAY_MS);
    expect(getInitialHistoryLookbackMs('1M')).toBe(3100 * DAY_MS);
  });

  it('keeps 1h inside the 5000-bar cap so a single snapshot can fill indicator-stable depth', () => {
    expect(INDICATOR_STABLE_LOOKBACK_MS).toBeLessThan(UPSTREAM_CANDLE_CAP * intervalMs('1h'));
    expect(CHART_DISPLAY_LOOKBACK_MS['1h']).toBe(INDICATOR_STABLE_LOOKBACK_MS);
  });

  it('treats a reachable-span cache as complete so 30m/1m do not refetch forever', () => {
    const now = Date.UTC(2026, 3, 17, 18);
    const thirtyMRequired = getInitialHistoryLookbackMs('30m');
    const candles = [
      { t: now - thirtyMRequired },
      { t: now },
    ];
    expect(hasEnoughCachedHistory(candles, thirtyMRequired, now)).toBe(true);
    expect(hasEnoughCachedHistory(
      [{ t: now - 20 * DAY_MS }, { t: now }],
      thirtyMRequired,
      now,
    )).toBe(false);
  });

  it('treats a 5000-bar snapshot as complete even when empty buckets shorten the span', () => {
    const now = Date.UTC(2026, 3, 17, 18);
    const candles = Array.from({ length: 4750 }, (_, i) => ({ t: now - i * 60_000 }));
    candles.reverse();
    expect(hasEnoughCachedHistory(candles, 7 * DAY_MS, now)).toBe(true);
  });

  it('does not clamp 2h/4h 190d because those stay under the 5000-bar cap', () => {
    expect(reachableLookbackMs('2h', INDICATOR_STABLE_LOOKBACK_MS)).toBe(INDICATOR_STABLE_LOOKBACK_MS);
    expect(reachableLookbackMs('4h', INDICATOR_STABLE_LOOKBACK_MS)).toBe(INDICATOR_STABLE_LOOKBACK_MS);
  });
});
