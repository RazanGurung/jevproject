import { describe, expect, it } from 'vitest';
import {
  computeWeekPathProjection,
  isoWeekStartUnix,
  isoWeekEndUnix,
  twoWeekHorizonEndUnix,
  remainingBarsToWeekEnd,
  remainingDayClass,
  WEEK_PATH_PROJECTION_DEFAULTS,
  WEEK_PATH_PROJECTION_MODELS,
  __WEEK_PATH_PROJECTION_INTERNALS,
} from '../week-path-projection.js';

/** Monday 00:00 UTC, 2023-01-02 */
const WEEK_ANCHOR = Math.floor(Date.UTC(2023, 0, 2, 0, 0, 0) / 1000);
const TWO_WEEK_SECONDS = 14 * 24 * 3600;

function syntheticWeekCandles(weekCount = 40, {
  interval = 2 * 3600,
  start = WEEK_ANCHOR,
  volatility = 1,
} = {}) {
  const barsPerWeek = Math.round((7 * 24 * 3600) / interval);
  const count = weekCount * barsPerWeek;
  const rows = [];
  let close = 100;
  for (let i = 0; i < count; i += 1) {
    const cycle = Math.sin(i / 9) * 0.0012 + Math.cos(i / 31) * 0.00055;
    const drift = (i % 140 < 85 ? 0.00018 : -0.00012);
    const open = close;
    close = Math.max(1, open * Math.exp((cycle + drift) * volatility));
    const spread = open * (0.0015 + Math.abs(Math.sin(i / 13)) * 0.001 * volatility);
    rows.push({
      t: start + i * interval,
      o: String(open),
      h: String(Math.max(open, close) + spread),
      l: String(Math.min(open, close) - spread),
      c: String(close),
      v: String(100 + (i % 37) * 7 + Math.round(40 * Math.abs(Math.sin(i / 17)))),
    });
  }
  return rows;
}

describe('week path geometry', () => {
  it('maps ISO week start/end and 2-week horizon in Monday-UTC terms', () => {
    // Wednesday mid-week
    const wed = Math.floor(Date.UTC(2023, 0, 4, 12, 0, 0) / 1000);
    expect(isoWeekStartUnix(wed)).toBe(WEEK_ANCHOR);
    expect(isoWeekEndUnix(wed)).toBe(WEEK_ANCHOR + 7 * 24 * 3600);
    expect(twoWeekHorizonEndUnix(wed)).toBe(WEEK_ANCHOR + TWO_WEEK_SECONDS);
    expect(WEEK_PATH_PROJECTION_DEFAULTS.horizonWeeks).toBe(2);
  });

  it('counts remaining 2h bars to the 2-week horizon end exactly', () => {
    // Monday open bar: full 14 days remain (168 bars of 2h)
    const mon = remainingBarsToWeekEnd(WEEK_ANCHOR, '2h');
    expect(mon.ok).toBe(true);
    expect(mon.remainingBars).toBe(168);
    expect(mon.weekEnd).toBe(WEEK_ANCHOR + TWO_WEEK_SECONDS);
    expect(remainingDayClass(168, '2h')).toBe(14);

    // Mid-week: Wednesday 00:00 = 2 days in → 12 days left = 144 bars
    const wed = remainingBarsToWeekEnd(WEEK_ANCHOR + 2 * 24 * 3600, '2h');
    expect(wed.ok).toBe(true);
    expect(wed.remainingBars).toBe(144);
    expect(remainingDayClass(144, '2h')).toBe(12);

    // Last bar of current week (Sunday 22:00): 1 bar to next Mon + full next week = 85
    const last = remainingBarsToWeekEnd(WEEK_ANCHOR + 7 * 24 * 3600 - 2 * 3600, '2h');
    expect(last.ok).toBe(true);
    expect(last.remainingBars).toBe(85);
    expect(remainingDayClass(85, '2h')).toBe(8);
  });

  it('rejects 1m 2-week density and weekly charts', () => {
    expect(remainingBarsToWeekEnd(WEEK_ANCHOR, '1m')).toMatchObject({
      ok: false,
      reason: 'horizon-too-long-for-timeframe',
    });
    expect(remainingBarsToWeekEnd(WEEK_ANCHOR, '1w')).toMatchObject({
      ok: false,
      reason: 'horizon-too-short-for-timeframe',
    });
  });
});

describe('week path projection model', () => {
  it('builds deterministic calibrated 2-week paths from valid history', () => {
    // End series mid-week so remaining horizon is material (not horizon-complete).
    const interval = 2 * 3600;
    // Longer history so non-overlapping 2-week calibration blocks still fit.
    const candles = syntheticWeekCandles(80, { interval });
    // Drop the last ~1.5 days so origin is roughly mid/late week with remaining > 0.
    const trimmed = candles.slice(0, candles.length - 18);
    const first = computeWeekPathProjection(trimmed, { timeframe: '2h' });
    const second = computeWeekPathProjection(trimmed, { timeframe: '2h' });

    expect(first).toEqual(second);
    expect(first.status).toBe('ready');
    expect(first.model).toMatchObject({
      id: WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE,
      purpose: 'research-only',
    });
    expect(first.evidenceStatus).toBe('unvalidated');
    expect(first.model?.validationReportId || first.validationReportId)
      .toBe('week-path-projection-walk-forward-1786546708882');
    expect(first.remainingBars).toBeGreaterThan(0);
    // Late-week remaining should still cover into the following week (≥7d-ish).
    expect(first.remainingDays).toBeGreaterThanOrEqual(7);
    expect(first.horizonBars).toBe(first.remainingBars);
    expect(first.lastProjectionTime).toBe(first.weekEnd);
    expect(first.weekEnd - first.weekStart).toBe(TWO_WEEK_SECONDS);
    expect(first.paths.q50).toHaveLength(first.remainingBars + 1);
    expect(first.paths.q50[0]).toEqual({
      time: first.anchorTime,
      value: first.anchorPrice,
    });
    expect(first.envelope).toMatchObject({
      high50: expect.any(Number),
      high80: expect.any(Number),
      low50: expect.any(Number),
      low80: expect.any(Number),
    });
    expect(first.envelope.high80).toBeGreaterThanOrEqual(first.envelope.high50);
    expect(first.envelope.low80).toBeLessThanOrEqual(first.envelope.low50);
    expect(first.calibration.originCount).toBeGreaterThanOrEqual(5);
    expect(first.calibration).toMatchObject({
      method: 'rolling-origin-multiplicative-scale-aci-lite',
      guarantee: 'empirical-only-dependent-series',
    });
    expect(first.volModel).toBe(WEEK_PATH_PROJECTION_DEFAULTS.volModel);
    expect(first.pathModel).toBe('coherent-terminal-rank');

    for (let index = 0; index < first.paths.q25.length; index += 1) {
      const values = ['q10', 'q25', 'q50', 'q75', 'q90']
        .map((key) => first.paths[key][index].value);
      expect(values.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
      // Zero-median baseline pins q50; bands must nest around it.
      expect(values[0]).toBeLessThanOrEqual(values[1]);
      expect(values[1]).toBeLessThanOrEqual(values[2] + 1e-9);
      expect(values[2]).toBeLessThanOrEqual(values[3] + 1e-9);
      expect(values[3]).toBeLessThanOrEqual(values[4] + 1e-9);
    }
  }, 180_000);

  it('treats Monday open as full 2-week horizon (bar opens never land on remaining 0)', () => {
    // Bar times are opens: last bar of week still has remaining into next week;
    // the following Monday open starts a fresh full 14-day window.
    const weekEnd = WEEK_ANCHOR + 7 * 24 * 3600;
    const lastBar = remainingBarsToWeekEnd(weekEnd - 2 * 3600, '2h');
    expect(lastBar.ok).toBe(true);
    expect(lastBar.remainingBars).toBe(85);
    const nextMonday = remainingBarsToWeekEnd(weekEnd, '2h');
    expect(nextMonday.ok).toBe(true);
    expect(nextMonday.remainingBars).toBe(168);
  });

  it('returns insufficient-history for short series', () => {
    const candles = syntheticWeekCandles(2, { interval: 2 * 3600 });
    const result = computeWeekPathProjection(candles, { timeframe: '2h' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('insufficient-history');
  });

  it('day-class pooling groups same remaining-day class and allows longer candidates', () => {
    const { remainingMatches } = __WEEK_PATH_PROJECTION_INTERNALS;
    expect(remainingDayClass(144, '2h')).toBe(12);
    expect(remainingDayClass(156, '2h')).toBe(13);
    // Exact match always.
    expect(remainingMatches(144, 144, '2h', { baseline: true })).toBe(true);
    // Longer path in different day class must not pool.
    expect(remainingMatches(156, 144, '2h', { baseline: true })).toBe(false);
    // Longer path same day class: candidate must have at least horizon bars.
    expect(remainingDayClass(140, '2h')).toBe(12);
    expect(remainingMatches(140, 144, '2h', { baseline: true })).toBe(false); // candidate < horizon
    expect(remainingMatches(144, 140, '2h', { baseline: true })).toBe(true); // candidate > horizon, same class
    // Non-baseline requires exact length.
    expect(remainingMatches(144, 140, '2h', { baseline: false })).toBe(false);
    expect(remainingMatches(140, 140, '2h', { baseline: false })).toBe(true);
  });
});
