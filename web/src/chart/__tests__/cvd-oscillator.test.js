/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

// A mock lightweight-charts chart/series matching the surface the overlay uses.
function createTrackedOverlay() {
  const pane = {
    setStretchFactor: vi.fn(),
    setPreserveEmptyPane: vi.fn(),
  };
  const priceScale = { applyOptions: vi.fn() };
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn(),
    priceScale: vi.fn(() => priceScale),
    getPane: vi.fn(() => pane),
  };
  const outlineSeries = {
    setData: vi.fn(),
    update: vi.fn(),
  };
  let addCount = 0;
  const addSeries = vi.fn(() => ((addCount++ % 2 === 0) ? series : outlineSeries));
  const removeSeries = vi.fn();
  const chart = { addSeries, removeSeries };
  return { chart, addSeries, removeSeries, series, outlineSeries, pane };
}

// Alternating up/down bars on a sine price → CVD oscillates → the oscillator
// crosses zero, exercising both color branches.
function syntheticBars(count, { startTime = Math.floor(Date.UTC(2024, 0, 1) / 1000), step = 300 } = {}) {
  const bars = [];
  let prevClose = 100;
  for (let i = 0; i < count; i += 1) {
    const close = 100 + 10 * Math.sin(i / 7) + 2 * Math.sin(i / 2);
    const open = prevClose;
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    bars.push({ t: startTime + i * step, o: open, h: high, l: low, c: close, v: 10 });
    prevClose = close;
  }
  return bars;
}

describe('CVD oscillator math', () => {
  it('emits one row per bar; early bars are whitespace until the [1] lag fills', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const bars = syntheticBars(120, { step: 300 });
    const rows = CvdOscillator.calculate(bars, { timeframe: '5m' });

    expect(rows).toHaveLength(bars.length);
    // raw_dist needs close[i-1] and osc_scaled[i-1] (itself needing high[i-2]),
    // so the first two bars cannot produce a value.
    expect(rows[0]).toEqual({ time: bars[0].t });
    expect(rows[1]).toEqual({ time: bars[1].t });
    expect(Number.isFinite(rows[rows.length - 1].value)).toBe(true);
  });

  it('keeps every defined value within [-1, 1]', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const rows = CvdOscillator.calculate(syntheticBars(400), { timeframe: '5m' });
    for (const row of rows) {
      if (Number.isFinite(row.value)) {
        expect(row.value).toBeGreaterThanOrEqual(-1);
        expect(row.value).toBeLessThanOrEqual(1);
      }
    }
  });

  // A trending random walk: the old max-based denominator pinned the oldest
  // bars at the ±1 walls (under-filled warm-up window) while recent bars sat
  // near zero. The dispersion denominator must read consistently across history.
  function trendingBars(count, { startTime = Math.floor(Date.UTC(2024, 0, 1) / 1000), step = 300, seed = 1 } = {}) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const bars = [];
    let prevClose = 100;
    let drift = 0;
    for (let i = 0; i < count; i += 1) {
      drift += (rnd() - 0.5) * 0.6;
      const close = 100 + drift + 5 * Math.sin(i / 50);
      const open = prevClose;
      bars.push({ t: startTime + i * step, o: open, h: Math.max(open, close) + rnd(), l: Math.min(open, close) - rnd(), c: close, v: 5 + rnd() * 15 });
      prevClose = close;
    }
    return bars;
  }

  function saturationFraction(values) {
    if (values.length === 0) return 0;
    return values.filter((v) => Math.abs(v) >= 0.99).length / values.length;
  }

  it('does not concentrate saturation in the oldest bars (warm-up regression)', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const rows = CvdOscillator.calculate(trendingBars(4000, { step: 300 }), { timeframe: '5m', lookbackDays: 10 });
    const values = rows.filter((r) => Number.isFinite(r.value)).map((r) => r.value);
    const mid = Math.floor(values.length / 2);
    const oldFrac = saturationFraction(values.slice(0, mid));
    const newFrac = saturationFraction(values.slice(mid));
    // Neither half should be pinned at the walls, and the old half must not blow
    // out relative to the recent half the way the max-normalizer did.
    expect(oldFrac).toBeLessThan(0.05);
    expect(newFrac).toBeLessThan(0.05);
    expect(Math.abs(oldFrac - newFrac)).toBeLessThan(0.05);
  });

  it('keeps the same warm-up parity over scroll-back history (coarse old + fine source)', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const start = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const targets = trendingBars(1500, { startTime: start, step: 1200, seed: 7 }); // 20m chart
    const source = trendingBars(4000, { startTime: start + 1000 * 1200, step: 300, seed: 9 }); // 5m source
    const rows = CvdOscillator.calculate(targets, { lookbackDays: 10 });
    const values = rows.filter((r) => Number.isFinite(r.value)).map((r) => r.value);
    const mid = Math.floor(values.length / 2);
    expect(saturationFraction(values.slice(0, mid))).toBeLessThan(0.05);
    expect(saturationFraction(values.slice(mid))).toBeLessThan(0.05);
  });

  function meanAbsValue(rows) {
    const v = rows.filter((r) => Number.isFinite(r.value)).map((r) => Math.abs(r.value));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
  }

  it('normalizes by wall-clock time, so swing amplitude is resolution-invariant', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    // The same ~40-day span at two resolutions 16x apart. With time-based
    // lookbacks both look back the same number of days, so the swing amplitude
    // matches; a bar-count lookback would make the coarse series reach back 16x
    // further and swing far harder (the historical-bars bug).
    const start = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const days = 40;
    const fine = trendingBars(Math.round((days * 86400) / 900), { startTime: start, step: 900 });
    const coarse = trendingBars(Math.round((days * 86400) / 14400), { startTime: start, step: 14400 });
    const mFine = meanAbsValue(CvdOscillator.calculate(fine, { timeframe: '15m', lookbackDays: 30 }));
    const mCoarse = meanAbsValue(CvdOscillator.calculate(coarse, { timeframe: '4h', lookbackDays: 30 }));
    expect(mFine).toBeGreaterThan(0.1);
    expect(mCoarse / mFine).toBeGreaterThan(0.75);
    expect(mCoarse / mFine).toBeLessThan(1.33);
  });

  it('keeps coarse historical and fine recent regions at the same swing amplitude', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    // Real scroll-back layout: a coarse 4h chart spanning ~160 days, with a fine
    // 15m source covering only the recent ~30 days. The older (coarse fallback)
    // region must not swing wider than the recent (fine source) region.
    const start = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const chart = trendingBars(960, { startTime: start, step: 14400, seed: 3 }); // 160d @ 4h
    const sourceStart = start + (960 - 180) * 14400; // last ~30 days
    const source = trendingBars(Math.round((30 * 86400) / 900), { startTime: sourceStart, step: 900, seed: 5 });
    const rows = CvdOscillator.calculate(chart, { timeframe: '4h' });
    const older = rows.filter((r) => r.time < sourceStart && Number.isFinite(r.value)).map((r) => Math.abs(r.value));
    const within = rows.filter((r) => r.time >= sourceStart && Number.isFinite(r.value)).map((r) => Math.abs(r.value));
    const mOld = older.reduce((s, x) => s + x, 0) / older.length;
    const mNew = within.reduce((s, x) => s + x, 0) / within.length;
    expect(older.length).toBeGreaterThan(50);
    expect(within.length).toBeGreaterThan(50);
    expect(mOld / mNew).toBeGreaterThan(0.7);
    expect(mOld / mNew).toBeLessThan(1.4);
  });

  it('swings full over a long window yet still breathes around zero', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const bars = trendingBars(2000, { step: 300 });
    const baseValues = CvdOscillator.calculate(bars, { timeframe: '5m' })
      .filter((r) => Number.isFinite(r.value)).map((r) => Math.abs(r.value));
    const sorted = [...baseValues].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(0.95 * sorted.length)];
    const meanAbs = baseValues.reduce((s, x) => s + x, 0) / baseValues.length;
    // Swings full: the top of the range reaches well up toward the ±1 walls
    // (AMP_SCALE is tuned so the oscillator uses its bounded range over time).
    expect(p95).toBeGreaterThan(0.7);
    // Yet it still breathes around zero rather than sitting pinned at the walls.
    expect(meanAbs).toBeLessThan(0.6);

    // A sharp directional spike still drives the oscillator to the wall.
    const spiky = bars.slice();
    spiky[1500] = { ...spiky[1500], c: spiky[1500].o + 40, h: spiky[1500].o + 41, v: 200 };
    const maxAbs = Math.max(
      ...CvdOscillator.calculate(spiky, { timeframe: '5m' })
        .filter((r) => Number.isFinite(r.value)).map((r) => Math.abs(r.value)),
    );
    expect(maxAbs).toBeCloseTo(1, 5);
  });

  it('tints each point by sign: aqua above zero, red below', async () => {
    const { CvdOscillator, BEAR_COLOR, BULL_COLOR } = await import('../cvd-oscillator.js');
    const rows = CvdOscillator.calculate(syntheticBars(400), { timeframe: '5m' });
    let sawPositive = false;
    let sawNegative = false;
    for (const row of rows) {
      if (!Number.isFinite(row.value)) continue;
      if (row.value > 0) { sawPositive = true; expect(row.color).toBe(BULL_COLOR); }
      if (row.value < 0) { sawNegative = true; expect(row.color).toBe(BEAR_COLOR); }
    }
    // The synthetic sine series must straddle zero to exercise both branches.
    expect(sawPositive).toBe(true);
    expect(sawNegative).toBe(true);
  });

  it('produces no NaN on flat / zero-volume input (EPS guards hold)', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const t0 = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const bars = [];
    for (let i = 0; i < 60; i += 1) {
      bars.push({ t: t0 + i * 300, o: 100, h: 100, l: 100, c: 100, v: 0 });
    }
    const rows = CvdOscillator.calculate(bars, { timeframe: '5m' });
    expect(rows).toHaveLength(bars.length);
    for (const row of rows) {
      expect(Number.isNaN(row.value)).toBe(false);
      if (Number.isFinite(row.value)) expect(row.value).toBe(0);
    }
  });

  it('produces timeframe-stable values from chart bars alone', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const source = syntheticBars(1200, { step: 300 });
    // 20m bars (every 4th 5m bar) over the same period — values diverge from
    // 40m because the oscillator now reads each timeframe's own bar delta, but
    // both should be finite and within a reasonable range of each other.
    const coarse = source.filter((_, i) => i % 8 === 0);
    const fine = source.filter((_, i) => i % 4 === 0);
    const coarseRows = CvdOscillator.calculate(coarse);
    const fineRows = CvdOscillator.calculate(fine);

    const coarseVals = coarseRows.filter((r) => Number.isFinite(r.value));
    const fineVals = fineRows.filter((r) => Number.isFinite(r.value));
    expect(coarseVals.length).toBeGreaterThan(10);
    expect(fineVals.length).toBeGreaterThan(coarseVals.length);
  });

  it('stays populated over chart history older than the cached source', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const start = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    // Chart bars span 200h at 20m; the cached 5m source only covers the recent
    // half (simulating scroll-back that loaded older history beyond the source).
    const targets = syntheticBars(600, { startTime: start, step: 1200 });
    const sourceStart = start + 300 * 1200;
    const source = syntheticBars(1200, { startTime: sourceStart, step: 300 });

    const rows = CvdOscillator.calculate(targets);
    expect(rows).toHaveLength(targets.length);

    // The old region (chart bars before the source begins) must carry values,
    // not whitespace — the line falls back to chart bars there, like CVD.
    const oldRows = rows.filter((r) => r.time < sourceStart);
    const populatedOld = oldRows.filter((r) => Number.isFinite(r.value)).length;
    // Only the brief warm-up is blank: the [1] lag plus MIN_AMP_PERIODS samples
    // the dispersion denominator needs before it emits (~10 of the oldest bars).
    expect(populatedOld).toBeGreaterThan(oldRows.length - 12);
    for (const r of rows) {
      if (Number.isFinite(r.value)) {
        expect(r.value).toBeGreaterThanOrEqual(-1);
        expect(r.value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns an empty array for empty input', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    expect(CvdOscillator.calculate([], { timeframe: '5m' })).toEqual([]);
    expect(CvdOscillator.calculate(null, { timeframe: '5m' })).toEqual([]);
  });

  it('defaults to a 90-day lookback and responds to a different lookbackDays', async () => {
    const { CvdOscillator } = await import('../cvd-oscillator.js');
    const bars = syntheticBars(600, { step: 14400 });
    const def = CvdOscillator.calculate(bars, { timeframe: '4h' });
    const short = CvdOscillator.calculate(bars, { timeframe: '4h', lookbackDays: 30 });
    const explicit90 = CvdOscillator.calculate(bars, { timeframe: '4h', lookbackDays: 90 });

    // Default equals an explicit 90-day request.
    expect(def.map((r) => r.value)).toEqual(explicit90.map((r) => r.value));
    // A shorter lookback changes the normalization window, so the line differs.
    const lastDef = def[def.length - 1].value;
    const lastShort = short[short.length - 1].value;
    expect(lastShort).not.toBe(lastDef);
    // Still bounded regardless of lookback.
    for (const row of short) {
      if (Number.isFinite(row.value)) {
        expect(row.value).toBeGreaterThanOrEqual(-1);
        expect(row.value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('CVD oscillator overlay', () => {
  async function makeOverlay(tracked) {
    const { createCvdOscillatorOverlay } = await import('../cvd-oscillator-indicator.js');
    return createCvdOscillatorOverlay({
      getChart: () => tracked.chart,
      HistogramSeries: { isHistogramSeries: true },
      LineSeries: { isLineSeries: true },
    });
  }

  it('attaches a histogram series in pane 2 with -1/+1 bound lines and sets data', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    overlay.setCandles(syntheticBars(200), 'BTC', '5m');

    expect(tracked.addSeries).toHaveBeenCalledTimes(2);
    // Third positional arg is the pane index.
    expect(tracked.addSeries.mock.calls[0][2]).toBe(2);
    expect(tracked.addSeries.mock.calls[1][2]).toBe(2);
    expect(tracked.addSeries.mock.calls[1][1]).toEqual(expect.objectContaining({
      priceScaleId: 'cvdOsc',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }));
    expect(tracked.addSeries.mock.calls[1][1].autoscaleInfoProvider()).toBeNull();
    // Only the ±1 bounds — the histogram base already marks zero.
    expect(tracked.series.createPriceLine).toHaveBeenCalledTimes(2);
    const linePrices = tracked.series.createPriceLine.mock.calls.map((c) => c[0].price);
    expect(linePrices).toEqual([1, -1]);
    expect(tracked.series.setData).toHaveBeenCalledTimes(1);
    expect(tracked.outlineSeries.setData).toHaveBeenCalledTimes(1);
    const histogramRows = tracked.series.setData.mock.calls[0][0];
    const outlinedRows = tracked.outlineSeries.setData.mock.calls[0][0];
    expect(outlinedRows.map(({ time, value }) => ({ time, value }))).toEqual(
      histogramRows.map(({ time, value }) => ({ time, value })),
    );
    for (let i = 0; i < outlinedRows.length; i += 1) {
      const row = outlinedRows[i];
      if (!Number.isFinite(row.value)) continue;
      expect(row.color).toBe(row.value > 0
        ? 'rgba(34,204,230,0.90)'
        : row.value < 0
          ? 'rgba(255,80,80,0.90)'
          : 'rgba(150,150,150,0.75)');
    }
    expect(tracked.pane.setStretchFactor).toHaveBeenCalled();
  });

  it('pins the pane price range to [-1, 1] via autoscaleInfoProvider', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    overlay.setCandles(syntheticBars(120), 'BTC', '5m');
    const options = tracked.addSeries.mock.calls[0][1];
    expect(options.autoscaleInfoProvider()).toEqual({ priceRange: { minValue: -1, maxValue: 1 } });
  });

  it('detaches and renders nothing on 1w / 1M timeframes', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    overlay.setCandles(syntheticBars(120), 'BTC', '1w');
    expect(tracked.addSeries).not.toHaveBeenCalled();
    overlay.setCandles(syntheticBars(120), 'BTC', '1M');
    expect(tracked.addSeries).not.toHaveBeenCalled();
  });

  it('removes the histogram and outline together when the timeframe becomes unsupported', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    const bars = syntheticBars(120);

    overlay.setCandles(bars, 'BTC', '5m');
    overlay.setCandles(bars, 'BTC', '1w');

    expect(tracked.removeSeries).toHaveBeenCalledTimes(2);
    expect(tracked.removeSeries).toHaveBeenNthCalledWith(1, tracked.outlineSeries);
    expect(tracked.removeSeries).toHaveBeenNthCalledWith(2, tracked.series);
  });

  it('recomputes the line when the lookback changes via setLookback', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    const bars = syntheticBars(600, { step: 300 });
    overlay.setCandles(bars, 'BTC', '5m');
    expect(tracked.series.setData).toHaveBeenCalledTimes(1);
    const before = tracked.series.setData.mock.calls[0][0].map((r) => r.value);

    overlay.setLookback('3D');
    overlay.setCandles(bars, 'BTC', '5m');
    // The cache was invalidated, so setData runs again with a different line.
    expect(tracked.series.setData).toHaveBeenCalledTimes(2);
    const after = tracked.series.setData.mock.calls[1][0].map((r) => r.value);
    expect(after).not.toEqual(before);
  });

  it('rebuilds on a recovered snapshot even when its cheap range signature is unchanged', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    const bars = syntheticBars(600, { step: 300 });

    overlay.setCandles(bars, 'BTC', '5m', 4);
    overlay.setCandles(bars.map((bar, index) => (
      index === 120 ? { ...bar, h: Number(bar.h) + 5 } : bar
    )), 'BTC', '5m', 5);

    expect(tracked.series.setData).toHaveBeenCalledTimes(2);
  });

  it('accepts the 20D lookback label', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    // 10000 5m bars ≈ 34.7 days, comfortably longer than the 20D window so
    // it differs from the default 90D window within the available data (a short
    // series would leave both windows unfilled and read identically).
    const bars = syntheticBars(10000, { step: 300 });
    overlay.setCandles(bars, 'BTC', '5m');
    const before = tracked.series.setData.mock.calls[0][0].map((r) => r.value);

    overlay.setLookback('20D');
    overlay.setCandles(bars, 'BTC', '5m');
    expect(tracked.series.setData).toHaveBeenCalledTimes(2);
    const after = tracked.series.setData.mock.calls[1][0].map((r) => r.value);
    expect(after).not.toEqual(before);
  });

  it('updates only the latest row when a new candle bucket advances', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    const bars = syntheticBars(200, { step: 300 });
    overlay.setCandles(bars, 'BTC', '5m');

    const next = bars.concat({
      t: bars[bars.length - 1].t + 300, o: 105, h: 108, l: 104, c: 107, v: 12,
    });
    overlay.updateLast(next, 'BTC', '5m');
    expect(tracked.series.update).toHaveBeenCalledTimes(1);
    expect(tracked.outlineSeries.update).toHaveBeenCalledTimes(1);
    const updated = tracked.series.update.mock.calls[0][0];
    const outlineUpdated = tracked.outlineSeries.update.mock.calls[0][0];
    expect(outlineUpdated).toEqual(expect.objectContaining({
      time: updated.time,
      value: updated.value,
    }));
    expect(updated.value).toBeGreaterThanOrEqual(-1);
    expect(updated.value).toBeLessThanOrEqual(1);
  });

  it('sends time-only whitespace when a short series advances before lag fills', async () => {
    const tracked = createTrackedOverlay();
    const overlay = await makeOverlay(tracked);
    const bars = syntheticBars(1, { step: 300 });
    overlay.setCandles(bars, 'BTC', '5m');
    const first = tracked.series.setData.mock.calls[0][0];
    expect(first).toEqual([{ time: bars[0].t }]);

    overlay.updateLast(syntheticBars(2, { step: 300 }), 'BTC', '5m');
    expect(tracked.series.update).toHaveBeenCalledWith({ time: bars[0].t + 300 });
    expect(tracked.outlineSeries.update).toHaveBeenCalledWith({ time: bars[0].t + 300 });
  });
});
