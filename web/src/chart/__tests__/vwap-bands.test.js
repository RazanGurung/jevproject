/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetColorPalette, setPaletteColor } from '../../services/color-palette.js';

function createTrackedOverlay() {
  const trackedSeries = [];
  const addSeries = vi.fn(() => {
    const series = {
      setData: vi.fn(),
      update: vi.fn(),
      applyOptions: vi.fn(),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      priceToCoordinate: vi.fn((p) => 100 - p * 2),
    };
    trackedSeries.push(series);
    return series;
  });

  const removeSeries = vi.fn();
  const chart = {
    addSeries,
    removeSeries,
  };

  return { trackedSeries, addSeries, removeSeries, chart };
}

function latestSeriesPoints(trackedSeries) {
  const [vwap, upperInner, lowerInner, upperOuter, lowerOuter] = trackedSeries.map((s) => (
    s.setData.mock.calls.at(-1)?.[0] || []
  ));
  return {
    vwap,
    upperInner,
    lowerInner,
    upperOuter,
    lowerOuter,
    lastVwap: vwap.at(-1),
    lastUpperInner: upperInner.at(-1),
    lastLowerInner: lowerInner.at(-1),
    lastUpperOuter: upperOuter.at(-1),
    lastLowerOuter: lowerOuter.at(-1),
  };
}

function visiblePoints(points) {
  return points.filter((p) => Number.isFinite(p?.value));
}

function makeCandles({ startSec, count, intervalSec, price, vol = 10, step = 0 }) {
  const candles = [];
  let cursor = startSec;
  for (let i = 0; i < count; i++) {
    const p = price + step * i;
    candles.push({
      t: cursor,
      o: String(p),
      h: String(p + 1),
      l: String(p - 1),
      c: String(p),
      v: String(vol),
    });
    cursor += intervalSec;
  }
  return candles;
}

describe('vwap bands overlay', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColorPalette();
  });

  it('creates 5 line series and renders vwap + bands', async () => {
    const { trackedSeries, chart, addSeries } = createTrackedOverlay();

    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '5D' },
    });

    const start = 1713132000;
    const candles = makeCandles({
      startSec: start,
      count: 500,
      intervalSec: 3600,
      price: 50000,
      vol: 10,
      step: 0,
    });

    overlay.setCandles(candles, 'BTC', '1h');

    expect(addSeries).toHaveBeenCalledTimes(5);
    expect(addSeries.mock.calls[1][1].color).toBe('rgba(48, 110, 181, 0.3)');
    expect(addSeries.mock.calls[2][1].color).toBe('rgba(48, 110, 181, 0.3)');
    expect(addSeries.mock.calls[3][1].color).toBe('rgba(48, 110, 181, 0.62)');
    expect(addSeries.mock.calls[4][1].color).toBe('rgba(48, 110, 181, 0.62)');

    const points = latestSeriesPoints(trackedSeries);
    expect(points.lastVwap?.value).toBeGreaterThan(0);
    expect(points.lastUpperInner?.value).toBeGreaterThan(points.lastVwap?.value);
    expect(points.lastLowerInner?.value).toBeLessThan(points.lastVwap?.value);
    expect(points.lastUpperOuter?.value).toBeGreaterThan(points.lastUpperInner?.value);
    expect(points.lastLowerOuter?.value).toBeLessThan(points.lastLowerInner?.value);

    expect(visiblePoints(points.vwap).length).toBeGreaterThan(3);
  });

  it('ignores duplicate closed input while bands are hidden and rebuilds bands when restored', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '5D' },
    });
    const candles = makeCandles({
      startSec: 1713132000,
      count: 500,
      intervalSec: 3600,
      price: 50000,
    });

    overlay.setCandles(candles, 'BTC', '1h');
    overlay.setBandsVisible(false);
    expect(trackedSeries.slice(1).every((series) => series.setData.mock.calls.at(-1)?.[0]?.length === 0)).toBe(true);

    const beforeDuplicate = overlay.getDebugState();
    overlay.updateLast(candles, '1h');
    expect(trackedSeries[0].update).not.toHaveBeenCalled();
    expect(trackedSeries.slice(1).every((series) => series.update.mock.calls.length === 0)).toBe(true);
    expect(overlay.getDebugState().lastCenterValue).toBe(beforeDuplicate.lastCenterValue);

    overlay.setBandsVisible(true);
    overlay.setCandles(candles, 'BTC', '1h');
    expect(trackedSeries.slice(1).every((series) => series.setData.mock.calls.at(-1)?.[0]?.length > 0)).toBe(true);
    expect(overlay.getDebugState().bandsVisible).toBe(true);
  });

  it('withholds the centerline until lookback elapses, then plots bands with it', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '5D' },
    });
    const short = makeCandles({
      startSec: 1713132000,
      count: 18,
      intervalSec: 4 * 3600,
      price: 50000,
    });
    overlay.setCandles(short, 'BTC', '4h', 1);
    expect(trackedSeries[0].setData.mock.calls.at(-1)[0]).toHaveLength(0);
    expect(trackedSeries[1].setData.mock.calls.at(-1)[0]).toHaveLength(0);

    // 101 4h bars ≈ 16.7d: past the 5D centerline window, short of 5D × 5.5
    // stdev warmup. Bands must still render with the centerline.
    const warmed = makeCandles({
      startSec: 1713132000,
      count: 101,
      intervalSec: 4 * 3600,
      price: 50000,
    });
    overlay.setCandles(warmed, 'BTC', '4h', 2);
    const center = trackedSeries[0].setData.mock.calls.at(-1)[0];
    const innerUpper = trackedSeries[1].setData.mock.calls.at(-1)[0];
    expect(center.length).toBeGreaterThan(0);
    expect(innerUpper.length).toBe(center.length);
    expect(overlay.getDebugState().insufficientHistory).toBe(false);
  });

  it('renders 90D bands across the same span as the centerline', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '90D' },
    });
    const DAY = 86400;
    const candles = makeCandles({
      startSec: 1700000000,
      count: 600 * 6 + 1,
      intervalSec: 4 * 3600,
      price: 50000,
    });
    overlay.setCandles(candles, 'BTC', '4h', 1);
    const debug = overlay.getDebugState();
    expect(debug.centerCount).toBeGreaterThan(0);
    expect(debug.bandCount).toBe(debug.centerCount);
    const firstCenter = trackedSeries[0].setData.mock.calls.at(-1)[0][0];
    const firstBand = trackedSeries[1].setData.mock.calls.at(-1)[0][0];
    expect(firstBand.time).toBe(firstCenter.time);
    expect(firstCenter.time - 1700000000).toBeGreaterThanOrEqual(90 * DAY);
    expect(firstCenter.time - 1700000000).toBeLessThan(90 * DAY + 4 * 3600);
  });

  it('renders a 365D TWAP centerline without bands from the 90D plot gate', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '365D', bandsVisible: true },
    });
    const DAY = 86400;
    const start = 1700000000;
    const tooShort = makeCandles({
      startSec: start,
      count: 80 * 6,
      intervalSec: 4 * 3600,
      price: 50000,
    });
    overlay.setCandles(tooShort, 'BTC', '4h', 1);
    expect(trackedSeries[0].setData.mock.calls.at(-1)[0]).toHaveLength(0);
    expect(trackedSeries[1].setData.mock.calls.at(-1)[0]).toHaveLength(0);

    // 200d of 4h: past the 90D plot gate, short of a full 365D window.
    const expanding = makeCandles({
      startSec: start,
      count: 200 * 6,
      intervalSec: 4 * 3600,
      price: 50000,
    });
    overlay.setCandles(expanding, 'BTC', '4h', 2);
    const expandingCenter = trackedSeries[0].setData.mock.calls.at(-1)[0];
    expect(expandingCenter.length).toBeGreaterThan(0);
    expect(trackedSeries[1].setData.mock.calls.at(-1)[0]).toHaveLength(0);
    expect(expandingCenter[0].time - start).toBeGreaterThanOrEqual(90 * DAY);
    expect(expandingCenter[0].time - start).toBeLessThan(90 * DAY + 4 * 3600);

    const warmed = makeCandles({
      startSec: start,
      count: 600 * 6 + 1,
      intervalSec: 4 * 3600,
      price: 50000,
    });
    overlay.setCandles(warmed, 'BTC', '4h', 3);
    overlay.setBandsVisible(true);
    const center = trackedSeries[0].setData.mock.calls.at(-1)[0];
    const innerUpper = trackedSeries[1].setData.mock.calls.at(-1)[0];
    const debug = overlay.getDebugState();
    expect(center.length).toBeGreaterThan(expandingCenter.length);
    expect(innerUpper).toHaveLength(0);
    expect(debug.bandsVisible).toBe(false);
    expect(debug.bandCount).toBe(0);
    expect(debug.insufficientHistory).toBe(false);
    expect(center[0].time - start).toBeGreaterThanOrEqual(90 * DAY);
    expect(center[0].time - start).toBeLessThan(90 * DAY + 4 * 3600);
  });

  it('starts the 365D TWAP at the same source time as 90D RVWAP', async () => {
    const DAY = 86400;
    const start = 1700000000;
    const candles = makeCandles({
      startSec: start,
      count: 600 * 6 + 1,
      intervalSec: 4 * 3600,
      price: 50000,
    });
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const firstPoint = async (lookback) => {
      const { trackedSeries, chart } = createTrackedOverlay();
      const overlay = createVwapBandsOverlay({
        getChart: () => chart,
        LineSeries: Symbol('LineSeries'),
        LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
        options: { lookback },
      });
      overlay.setCandles(candles, 'BTC', '4h', 1);
      return trackedSeries[0].setData.mock.calls.at(-1)[0][0];
    };

    const ninety = await firstPoint('90D');
    const yearly = await firstPoint('365D');
    expect(ninety.time - start).toBeGreaterThanOrEqual(90 * DAY);
    expect(ninety.time - start).toBeLessThan(90 * DAY + 4 * 3600);
    expect(yearly.time).toBe(ninety.time);
  });

  it('does not let a volume spike pull 365D TWAP the way 90D VWAP moves', async () => {
    const start = 1700000000;
    const intervalSec = 4 * 3600;
    const count = 200 * 6;
    const candles = makeCandles({
      startSec: start,
      count,
      intervalSec,
      price: 50000,
      vol: 10,
    });
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = {
      ...last,
      o: '60000',
      h: '60001',
      l: '59999',
      c: '60000',
      v: '1000000',
    };

    const lastValue = async (lookback) => {
      const { trackedSeries, chart } = createTrackedOverlay();
      const { createVwapBandsOverlay } = await import('../vwap-bands.js');
      const overlay = createVwapBandsOverlay({
        getChart: () => chart,
        LineSeries: Symbol('LineSeries'),
        LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
        options: { lookback },
      });
      overlay.setCandles(candles, 'BTC', '4h', 1);
      return trackedSeries[0].setData.mock.calls.at(-1)[0].at(-1).value;
    };

    const vwap = await lastValue('90D');
    const twap = await lastValue('365D');
    expect(vwap).toBeGreaterThan(51000);
    expect(twap).toBeLessThan(vwap);
    expect(Math.abs(twap - 50000)).toBeLessThan(50);
  });

  it('uses RVWAP color independently and reapplies live theme changes', async () => {
    setPaletteColor('rvwap', '#123ABC');
    setPaletteColor('avwap', '#FEDCBA');
    const { trackedSeries, chart, addSeries } = createTrackedOverlay();
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '5D' },
    });

    overlay.setCandles(makeCandles({
      startSec: 1713132000,
      count: 100,
      intervalSec: 3600,
      price: 50000,
    }), 'BTC', '1h');
    expect(addSeries.mock.calls[0][1].color).toBe('rgba(18, 58, 188, 0.85)');

    setPaletteColor('rvwap', '#654321');
    overlay.applyTheme();
    expect(trackedSeries[0].applyOptions.mock.calls.at(-1)[0].color)
      .toBe('rgba(101, 67, 33, 0.85)');
    expect(trackedSeries[1].applyOptions.mock.calls.at(-1)[0].color)
      .toBe('rgba(101, 67, 33, 0.3)');
  });

  it('shares the candle price scale and keeps native autoscaling enabled', async () => {
    const { addSeries, chart } = createTrackedOverlay();

    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });

    const start = 1713132000;
    const candles = makeCandles({ startSec: start, count: 100, intervalSec: 3600, price: 50000 });

    overlay.setCandles(candles, 'BTC');

    const calls = addSeries.mock.calls;
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call[1].priceScaleId).toBe('right');
      expect(call[1]).not.toHaveProperty('autoscaleInfoProvider');
    }
  });

  it('converges kalman vwap toward flat price', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();

    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '5D', kalmanGain: 0.2 },
    });

    const start = 1713132000;
    const candles = makeCandles({ startSec: start, count: 200, intervalSec: 3600, price: 50000 });

    overlay.setCandles(candles, 'BTC', '1h');

    const points = visiblePoints(trackedSeries[0].setData.mock.calls.at(-1)[0]);
    const lastFew = points.slice(-5);

    for (const pt of lastFew) {
      expect(Math.abs(pt.value - 50000)).toBeLessThan(50);
    }
  });

  it('expands bands when price breaches them', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();

    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: {
        lookback: '5D',
        kalmanGain: 0.2,
        innerMult: 1.0,
        outerMult: 2.0,
        innerDecay: 0.5,
        outerDecay: 0.5,
      },
    });

    const start = 1713132000;
    const candles = makeCandles({ startSec: start, count: 500, intervalSec: 3600, price: 50000 });

    overlay.setCandles(candles, 'BTC', '1h');

    const pointsBefore = latestSeriesPoints(trackedSeries);

    await vi.dynamicImportSettled();

    const spikeCandles = makeCandles({
      startSec: start + 600 * 3600,
      count: 10,
      intervalSec: 3600,
      price: 52000,
      vol: 50,
      step: 0,
    });
    overlay.setCandles(
      [...candles, ...spikeCandles],
      'BTC', '1h',
    );

    const pointsAfter = latestSeriesPoints(trackedSeries);

    const upperSpreadBefore = pointsBefore.lastUpperInner.value - pointsBefore.lastVwap.value;
    const upperSpreadAfter = pointsAfter.lastUpperInner.value - pointsAfter.lastVwap.value;

    expect(upperSpreadAfter).toBeGreaterThanOrEqual(upperSpreadBefore);
  });

  it('handles revised closed input on the same timestamp without replaying duplicates', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();

    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '5D' },
    });

    const start = 1713132000;
    const base = makeCandles({
      startSec: start,
      count: 200,
      intervalSec: 3600,
      price: 50000,
    });

    overlay.setCandles(base, 'BTC', '1h');

    const lastBar = base[base.length - 1];
    for (let i = 0; i < 5; i++) {
      const updated = base.slice(0, -1).concat([{
        ...lastBar,
        c: String(50000 + i),
        h: String(50001 + i),
        l: String(49999 + i),
      }]);
      overlay.updateLast(updated, '1h');
    }

    const updateCalls = trackedSeries[0].update.mock.calls;
    expect(updateCalls.length).toBe(4);
  });

  it('renders roughly the same vwap and band width across timeframes', async () => {
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');

    const DAY = 86400;
    const t0 = 1700000000;
    const spanDays = 600; // fills the 90D preset's 495D deviation window

    // Deterministic price curve sampled identically at every timeframe.
    const priceAt = (t) => {
      const x = t - t0;
      const base = 50000;
      return base
        + 0.00000005 * x * base
        + 0.06 * base * Math.sin((2 * Math.PI * x) / (20 * DAY))
        + 0.02 * base * Math.sin((2 * Math.PI * x) / (3 * DAY));
    };

    const curveCandles = (intervalSec) => {
      const candles = [];
      const end = t0 + spanDays * DAY;
      for (let t = t0; t <= end; t += intervalSec) {
        const p = priceAt(t);
        candles.push({
          t,
          o: String(p),
          h: String(p * 1.002),
          l: String(p * 0.998),
          c: String(p),
          v: '10',
        });
      }
      return candles;
    };

    const lastBands = (lookback, intervalSec) => {
      const { trackedSeries, chart } = createTrackedOverlay();
      const overlay = createVwapBandsOverlay({
        getChart: () => chart,
        LineSeries: Symbol('LineSeries'),
        LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
        options: { lookback },
      });
      overlay.setCandles(curveCandles(intervalSec), 'BTC', 'tf');
      const p = latestSeriesPoints(trackedSeries);
      return {
        vwap: p.lastVwap.value,
        width: p.lastUpperInner.value - p.lastLowerInner.value,
      };
    };

    const intervals = [14400, 28800, 43200, 86400]; // 4h, 8h, 12h, 1d

    for (const lookback of ['7D', '30D', '90D']) {
      const results = intervals.map((sec) => lastBands(lookback, sec));
      const vwaps = results.map((r) => r.vwap);
      const widths = results.map((r) => r.width);

      const mean = vwaps.reduce((a, b) => a + b, 0) / vwaps.length;
      const spread = (Math.max(...vwaps) - Math.min(...vwaps)) / mean;
      // Pre-fix this was ~6%; interval-normalization brings it under ~1.5%.
      expect(spread).toBeLessThan(0.015);

      // Band widths should no longer diverge by more than ~2x across timeframes.
      expect(Math.max(...widths) / Math.min(...widths)).toBeLessThan(2);
    }
  });

  it('projects full-resolution RVWAP rows onto coarse active candle timestamps', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();
    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: { lookback: '5D' },
    });
    const source = makeCandles({
      startSec: 1713132000,
      count: 600,
      intervalSec: 4 * 3600,
      price: 50000,
      step: 1,
    });
    const display = source
      .slice(96)
      .filter((_, index) => index % 42 === 0)
      .map((candle) => ({ ...candle }));
    const displayTimes = new Set(display.map((candle) => candle.t));

    overlay.setCandles(source, 'BTC', '4h', 1, {
      displayCandles: display,
      displayTimeframe: '1w',
    });

    const rendered = trackedSeries[0].setData.mock.calls.at(-1)[0];
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThanOrEqual(display.length);
    expect(rendered.every((point) => displayTimes.has(point.time))).toBe(true);
    expect(overlay.getDebugState()).toEqual(expect.objectContaining({
      rowCount: source.length,
      renderedRowCount: display.length,
    }));

    const revised = source.slice(0, -1).concat([{
      ...source.at(-1),
      c: '52000',
      h: '52001',
    }]);
    overlay.updateLast(revised, '4h', {
      displayCandles: display,
      displayTimeframe: '1w',
    });
    expect(trackedSeries[0].update.mock.calls.at(-1)[0].time).toBe(display.at(-1).t);
  });

  it('detaches and reattaches on coin change', async () => {
    const { addSeries, removeSeries, chart } = createTrackedOverlay();

    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });

    const start = 1713132000;
    const candles = makeCandles({ startSec: start, count: 100, intervalSec: 3600, price: 50000 });

    overlay.setCandles(candles, 'BTC', '1h');
    expect(addSeries).toHaveBeenCalledTimes(5);

    overlay.setCandles(candles, 'ETH', '1h');
    expect(removeSeries).toHaveBeenCalledTimes(5);
    expect(addSeries).toHaveBeenCalledTimes(10);
  });
});

describe('RVWAP overlay set', () => {
  it('frame-slices large multi-preset rebuilds and cancels stale navigation work', async () => {
    const frames = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    }));
    const { addSeries, chart } = createTrackedOverlay();
    const { createRvwapOverlaySet } = await import('../vwap-bands.js');
    const overlays = createRvwapOverlaySet({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });
    const candles = makeCandles({
      startSec: 1713132000,
      count: 2_001,
      intervalSec: 4 * 3600,
      price: 50000,
    });

    overlays.setEnabledLookbacks(['7D', '30D', '90D', '365D']);
    overlays.setCandles(candles, 'BTC', '4h', 1);
    overlays.setCandles(candles, 'ETH', '4h', 2);
    expect(addSeries).not.toHaveBeenCalled();

    while (frames.length > 0) frames.shift()();

    expect(addSeries).toHaveBeenCalledTimes(20);
    expect(overlays.getDebugState()).toMatchObject({
      attached: true,
      rowCount: 2_001,
      enabledLookbacks: ['7D', '30D', '90D', '365D'],
      instances: {
        '7D': { attached: true, rowCount: 2_001 },
        '30D': { attached: true, rowCount: 2_001 },
        '90D': { attached: true, rowCount: 2_001 },
        '365D': { attached: true, rowCount: 2_001, bandsVisible: false },
      },
    });
    vi.unstubAllGlobals();
  });

  it('renders independent uniformly blue five-line instances for each enabled preset', async () => {
    const { trackedSeries, addSeries, chart } = createTrackedOverlay();
    const { createRvwapOverlaySet } = await import('../vwap-bands.js');
    const overlays = createRvwapOverlaySet({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });
    const candles = makeCandles({
      startSec: 1713132000,
      count: 500,
      intervalSec: 3600,
      price: 50000,
    });

    overlays.setEnabledLookbacks(['30D', '7D', '14D']);
    overlays.setBandsEnabledLookbacks(['30D']);
    overlays.setCandles(candles, 'BTC', '1h', 1);

    expect(addSeries).toHaveBeenCalledTimes(10);
    expect(addSeries.mock.calls[0][1].color).toBe('rgba(48, 110, 181, 0.95)');
    expect(addSeries.mock.calls[0][1].title).toBe('7D');
    expect(addSeries.mock.calls[0][1].lineWidth).toBe(1);
    expect(addSeries.mock.calls[0][1].lastValueVisible).toBe(true);
    expect(addSeries.mock.calls[1][1].color).toBe('rgba(48, 110, 181, 0.30)');
    expect(addSeries.mock.calls[1][1].title).toBe('');
    expect(addSeries.mock.calls[1][1].lastValueVisible).toBe(false);
    expect(addSeries.mock.calls[4][1].color).toBe('rgba(48, 110, 181, 0.62)');
    expect(addSeries.mock.calls[5][1].color).toBe('rgba(48, 110, 181, 0.95)');
    expect(addSeries.mock.calls[5][1].title).toBe('30D');
    expect(addSeries.mock.calls[5][1].lineWidth).toBe(2);
    expect(addSeries.mock.calls[5][1].lastValueVisible).toBe(true);
    expect(addSeries.mock.calls[6][1].color).toBe('rgba(48, 110, 181, 0.30)');
    expect(addSeries.mock.calls[6][1].title).toBe('');
    expect(addSeries.mock.calls[6][1].lastValueVisible).toBe(false);
    expect(addSeries.mock.calls[9][1].color).toBe('rgba(48, 110, 181, 0.62)');
    expect(overlays.getDebugState()).toMatchObject({
      attached: true,
      rowCount: 500,
      enabledLookbacks: ['7D', '30D'],
      bandsEnabledLookbacks: ['30D'],
      instances: {
        '7D': { attached: true, rowCount: 500, bandsVisible: false, chartLabel: '7D', lineWidth: 1 },
        '30D': { attached: true, rowCount: 500, bandsVisible: true, chartLabel: '30D', lineWidth: 2 },
        '90D': { attached: false, rowCount: 0, bandsVisible: false, chartLabel: '90D', lineWidth: 3 },
        '365D': { attached: false, rowCount: 0, bandsVisible: false, chartLabel: '365D', lineWidth: 4 },
      },
    });
    expect(trackedSeries[0].setData.mock.calls.at(-1)[0].length).toBeGreaterThan(0);
    expect(trackedSeries.slice(1, 5).every((series) => series.setData.mock.calls.at(-1)[0].length === 0)).toBe(true);
  });

  it('detaches only disabled presets, updates the remainder, and reattaches cleanly', async () => {
    const { trackedSeries, addSeries, removeSeries, chart } = createTrackedOverlay();
    const { createRvwapOverlaySet } = await import('../vwap-bands.js');
    const overlays = createRvwapOverlaySet({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });
    const candles = makeCandles({
      startSec: 1713132000,
      count: 500,
      intervalSec: 3600,
      price: 50000,
    });

    overlays.setEnabledLookbacks(['7D', '30D']);
    overlays.setCandles(candles, 'BTC', '1h', 1);
    overlays.setEnabledLookbacks(['7D']);
    expect(removeSeries).toHaveBeenCalledTimes(5);

    const revised = candles.slice(0, -1).concat([{
      ...candles.at(-1),
      c: String(Number(candles.at(-1).c) + 10),
      h: String(Number(candles.at(-1).h) + 10),
    }]);
    overlays.updateLast(revised, '1h');
    expect(trackedSeries.slice(0, 5).every((series) => series.update.mock.calls.length === 1)).toBe(true);
    expect(trackedSeries.slice(5, 10).every((series) => series.update.mock.calls.length === 0)).toBe(true);

    overlays.setEnabledLookbacks(['7D', '30D']);
    overlays.setCandles(candles, 'BTC', '1h', 2);
    expect(addSeries).toHaveBeenCalledTimes(15);
    expect(overlays.getDebugState().instances['30D'].attached).toBe(true);
  });

  it('supports hiding every preset', async () => {
    const { removeSeries, chart } = createTrackedOverlay();
    const { createRvwapOverlaySet } = await import('../vwap-bands.js');
    const overlays = createRvwapOverlaySet({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });
    const candles = makeCandles({ startSec: 1713132000, count: 100, intervalSec: 3600, price: 50000 });

    overlays.setEnabledLookbacks(['30D']);
    overlays.setCandles(candles, 'BTC', '1h');
    overlays.setEnabledLookbacks([]);

    expect(removeSeries).toHaveBeenCalledTimes(5);
    expect(overlays.getDebugState()).toMatchObject({ attached: false, enabledLookbacks: [] });
  });

  it('keeps 365D centerline-only even when bands are requested', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();
    const { createRvwapOverlaySet } = await import('../vwap-bands.js');
    const overlays = createRvwapOverlaySet({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });
    const candles = makeCandles({
      startSec: 1700000000,
      count: 600 * 6 + 1,
      intervalSec: 4 * 3600,
      price: 50000,
    });

    overlays.setEnabledLookbacks(['365D']);
    overlays.setBandsEnabledLookbacks(['365D', '30D']);
    overlays.setCandles(candles, 'BTC', '4h', 1);

    expect(overlays.getDebugState()).toMatchObject({
      attached: true,
      enabledLookbacks: ['365D'],
      bandsEnabledLookbacks: ['30D'],
      instances: {
        '365D': {
          attached: true,
          bandsVisible: false,
          bandCount: 0,
        },
      },
    });
    expect(overlays.getDebugState().instances['365D'].centerCount).toBeGreaterThan(0);
    expect(trackedSeries[0].setData.mock.calls.at(-1)[0].length).toBeGreaterThan(0);
    expect(trackedSeries.slice(1, 5).every((series) => series.setData.mock.calls.at(-1)[0].length === 0)).toBe(true);
  });

  it('computes 365D TWAP from deeper 1d display history instead of the 4h source', async () => {
    const { trackedSeries, chart } = createTrackedOverlay();
    const { createRvwapOverlaySet } = await import('../vwap-bands.js');
    const overlays = createRvwapOverlaySet({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    });
    const DAY = 86400;
    const displayStart = 1_600_000_000;
    const sourceStart = displayStart + 800 * DAY;
    const display = makeCandles({
      startSec: displayStart,
      count: 1200,
      intervalSec: DAY,
      price: 50000,
    });
    const source = makeCandles({
      startSec: sourceStart,
      count: 300 * 6,
      intervalSec: 4 * 3600,
      price: 50000,
    });

    overlays.setEnabledLookbacks(['90D', '365D']);
    overlays.setCandles(source, 'BTC', '4h', 1, {
      displayCandles: display,
      displayTimeframe: '1d',
    });

    const ninety = trackedSeries[0].setData.mock.calls.at(-1)[0];
    const yearly = trackedSeries[5].setData.mock.calls.at(-1)[0];
    expect(ninety[0].time).toBeGreaterThanOrEqual(sourceStart + 90 * DAY);
    expect(yearly[0].time - displayStart).toBeGreaterThanOrEqual(90 * DAY);
    expect(yearly[0].time - displayStart).toBeLessThan(90 * DAY + DAY);
    expect(yearly[0].time).toBeLessThan(ninety[0].time);
    expect(yearly.length).toBeGreaterThan(ninety.length);
  });

  it('attaches series primitive and renders translucent canvas background fill between upper and lower bands in bottom z-order', async () => {
    let primitive = null;
    const { trackedSeries, chart } = createTrackedOverlay();
    trackedSeries[0] = {
      setData: vi.fn(),
      update: vi.fn(),
      applyOptions: vi.fn(),
      attachPrimitive: vi.fn((p) => { primitive = p; }),
      detachPrimitive: vi.fn(),
      priceToCoordinate: (price) => 100 - price * 2,
    };
    chart.addSeries = vi.fn(() => trackedSeries[0]);
    chart.timeScale = () => ({
      timeToIndex: (t) => Math.floor((t - 100) / 3600),
      logicalToCoordinate: (idx) => 20 + idx * 10,
    });

    const { createVwapBandsOverlay } = await import('../vwap-bands.js');
    const overlay = createVwapBandsOverlay({
      getChart: () => chart,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
      options: {
        lookback: '7D',
        bandsVisible: true,
        bandsSupported: true,
      },
    });

    const candles = makeCandles({
      startSec: 100,
      count: 200,
      intervalSec: 3600,
      price: 100,
    });
    overlay.setCandles(candles, 'BTC', '1h');

    expect(trackedSeries[0].attachPrimitive).toHaveBeenCalled();
    const attachedPrim = trackedSeries[0].attachPrimitive.mock.calls[0][0];
    expect(attachedPrim).toBeTruthy();
    expect(attachedPrim.autoscaleInfo()).toBeNull();

    const views = attachedPrim.paneViews();
    expect(views).toHaveLength(1);
    expect(views[0].zOrder()).toBe('bottom');
    const context = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillStyle: '',
    };
    views[0].renderer().draw({
      useBitmapCoordinateSpace: (draw) => draw({
        context,
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
    });

    expect(context.beginPath).toHaveBeenCalled();
    expect(context.fill).toHaveBeenCalled();
    expect(context.closePath).toHaveBeenCalled();
  });
});
