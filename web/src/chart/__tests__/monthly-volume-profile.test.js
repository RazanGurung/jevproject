/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  computeMonthlyVolumeProfiles,
  computeVolumeProfiles,
  createMonthlyVolumeProfileOverlay,
  createVolumeProfileOverlay,
  findProfilePocs,
} from '../monthly-volume-profile.js';
import { resetColorPalette, setPaletteColor } from '../../services/color-palette.js';

const HOUR = 3600;
const DAY = 86400;

// 2024-01-01T00:00:00Z
const JAN_1 = Date.UTC(2024, 0, 1) / 1000;
// 2024-02-01T00:00:00Z
const FEB_1 = Date.UTC(2024, 1, 1) / 1000;

function makeCandles({ startSec, count, intervalSec = HOUR, price = 100, vol = 10, step = 0 }) {
  const candles = [];
  let cursor = startSec;
  for (let i = 0; i < count; i += 1) {
    const p = price + step * i;
    candles.push({
      t: cursor,
      o: String(p), h: String(p + 1), l: String(p - 1), c: String(p),
      v: String(vol),
    });
    cursor += intervalSec;
  }
  return candles;
}

describe('computeMonthlyVolumeProfiles', () => {
  it('splits bars into UTC calendar months', () => {
    const candles = [
      ...makeCandles({ startSec: JAN_1, count: 6 }),
      ...makeCandles({ startSec: FEB_1, count: 6 }),
    ];
    const profiles = computeMonthlyVolumeProfiles(candles);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].startTime).toBe(JAN_1);
    expect(profiles[0].endTime).toBe(JAN_1 + 5 * HOUR);
    expect(profiles[0].monthStart).toBe(JAN_1);
    expect(profiles[0].monthEnd).toBe(FEB_1);
    expect(profiles[0].barCount).toBe(6);
    expect(profiles[1].startTime).toBe(FEB_1);
    expect(profiles[1].monthStart).toBe(FEB_1);
    expect(profiles[1].monthEnd).toBe(Date.UTC(2024, 2, 1) / 1000);
    expect(profiles[1].barCount).toBe(6);
  });

  it('omits a left-truncated oldest month so its POC cannot jump when history extends', () => {
    const candles = [
      ...makeCandles({ startSec: FEB_1 - 6 * HOUR, count: 6 }),
      ...makeCandles({ startSec: FEB_1, count: 10 }),
    ];
    const profiles = computeMonthlyVolumeProfiles(candles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].monthStart).toBe(FEB_1);
    expect(profiles[0].barCount).toBe(10);
  });

  it('keeps the in-progress latest month even when it started mid-month', () => {
    const candles = makeCandles({ startSec: FEB_1 + 10 * DAY, count: 8, intervalSec: DAY });
    const profiles = computeMonthlyVolumeProfiles(candles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].monthStart).toBe(FEB_1);
  });

  it('keeps only the most recent keepMonths months', () => {
    const candles = [];
    for (let m = 0; m < 8; m += 1) {
      candles.push(...makeCandles({ startSec: Date.UTC(2024, m, 1) / 1000, count: 10, intervalSec: DAY }));
    }
    const profiles = computeMonthlyVolumeProfiles(candles);
    expect(profiles).toHaveLength(6);
    expect(profiles[0].startTime).toBe(Date.UTC(2024, 2, 1) / 1000);
  });

  it('caps input at maxBars', () => {
    const candles = makeCandles({ startSec: JAN_1, count: 20, intervalSec: DAY });
    const profiles = computeMonthlyVolumeProfiles(candles, { maxBars: 8 });
    // Only the last 8 daily bars survive: Jan 13..20
    expect(profiles).toHaveLength(1);
    expect(profiles[0].barCount).toBe(8);
    expect(profiles[0].startTime).toBe(JAN_1 + 12 * DAY);
  });

  it('drops months with fewer than minBars bars', () => {
    const candles = [
      ...makeCandles({ startSec: FEB_1 - 4 * HOUR, count: 4 }),
      ...makeCandles({ startSec: FEB_1, count: 5 }),
    ];
    const profiles = computeMonthlyVolumeProfiles(candles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].startTime).toBe(FEB_1);
  });

  it('distributes a bar volume evenly across the bins its range spans', () => {
    // Two bars define the month range [0, 100] with 10 bins of height 10.
    // Bar A spans the full range (vol 100 -> 10 per bin); bar B sits inside
    // bin 0 (vol 50 entirely in bin 0).
    const mk = (i, h, l, v) => ({ t: JAN_1 + i * HOUR, o: '50', h: String(h), l: String(l), c: '50', v: String(v) });
    const candles = [
      mk(0, 100, 0, 100),
      mk(1, 9, 1, 50),
      mk(2, 50, 50, 0),
      mk(3, 50, 50, 0),
      mk(4, 50, 50, 0),
    ];
    const profiles = computeMonthlyVolumeProfiles(candles, { bins: 10 });
    expect(profiles).toHaveLength(1);
    const { bins, pocPrice } = profiles[0];
    expect(bins).toHaveLength(10);
    // bin 0 holds 10 + 50 = 60 (max); every other bin holds 10
    const bin0 = bins.find((b) => b.priceLow === 0);
    expect(bin0.fraction).toBe(1);
    const others = bins.filter((b) => b.priceLow !== 0);
    for (const b of others) expect(b.fraction).toBeCloseTo(10 / 60, 10);
    expect(pocPrice).toBeCloseTo(5, 10); // lo + (0 + 0.5) * 10
  });

  it('picks the lowest-price bin on a POC volume tie', () => {
    // One bar spanning the full range -> equal volume in all bins.
    const candles = [
      { t: JAN_1, o: '50', h: '100', l: '0', c: '50', v: '100' },
      ...makeCandles({ startSec: JAN_1 + HOUR, count: 4, price: 50, vol: 0 }),
    ];
    const profiles = computeMonthlyVolumeProfiles(candles, { bins: 10 });
    expect(profiles[0].pocPrice).toBeCloseTo(5, 10);
  });

  it('computes Value Area (VAH and VAL) covering 70% of total volume', () => {
    // 10 bins of height 10 on exact range [0, 100].
    // Base candle sets range [0, 100] with 0 volume.
    // Concentrated volume at bin 4 (40 vol), bin 5 (20 vol), bin 3 (15 vol), total 100 vol.
    const mk = (i, p, v, h = p + 1, l = p - 1) => ({ t: JAN_1 + i * HOUR, o: String(p), h: String(h), l: String(l), c: String(p), v: String(v) });
    const candles = [
      mk(0, 50, 0, 100, 0), // anchors range lo=0, hi=100
      mk(1, 45, 40, 46, 44), // bin 4 (range 40-50)
      mk(2, 55, 20, 56, 54), // bin 5 (range 50-60)
      mk(3, 35, 15, 36, 34), // bin 3 (range 30-40)
      mk(4, 15, 10, 16, 14), // bin 1 (range 10-20)
      mk(5, 85, 15, 86, 84), // bin 8 (range 80-90)
    ];
    // Total vol: 40 + 20 + 15 + 10 + 15 = 100.
    // 70% of vol = 70.
    // POC is at bin 4 (40 vol).
    // Next bins: bin 5 (20 vol) vs bin 3 (15 vol) -> bin 5 selected (cum: 40 + 20 = 60).
    // Next bins: bin 6 (0 vol) vs bin 3 (15 vol) -> bin 3 selected (cum: 60 + 15 = 75 >= 70).
    // VA bins: 3, 4, 5. VAL = 30, VAH = 60.
    const profiles = computeMonthlyVolumeProfiles(candles, { bins: 10 });
    expect(profiles).toHaveLength(1);
    const p = profiles[0];
    expect(p.pocPrice).toBeCloseTo(45, 1);
    expect(p.valPrice).toBeCloseTo(30, 1);
    expect(p.vahPrice).toBeCloseTo(60, 1);

    const vaBins = p.bins.filter((b) => b.inValueArea);
    const nonVaBins = p.bins.filter((b) => !b.inValueArea);
    expect(vaBins.length).toBe(3);
    expect(nonVaBins.length).toBe(2);
    for (const b of vaBins) {
      expect(b.priceLow).toBeGreaterThanOrEqual(30);
      expect(b.priceHigh).toBeLessThanOrEqual(60);
    }
  });

  it('handles unsorted, duplicate, and millisecond timestamps', () => {
    const base = makeCandles({ startSec: JAN_1, count: 6 });
    const noisy = [
      base[3], base[1], base[0], base[2], base[4], base[5],
      { ...base[2] }, // duplicate
      { ...base[5], t: String((JAN_1 + 5 * HOUR) * 1000) }, // ms duplicate of last
    ];
    const profiles = computeMonthlyVolumeProfiles(noisy);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].barCount).toBe(6);
    expect(profiles[0].startTime).toBe(JAN_1);
    expect(profiles[0].endTime).toBe(JAN_1 + 5 * HOUR);
  });

  it('skips months with a degenerate price range or zero volume', () => {
    const flat = makeCandles({ startSec: JAN_1, count: 10 })
      .map((c) => ({ ...c, h: '100', l: '100' }));
    expect(computeMonthlyVolumeProfiles(flat)).toHaveLength(0);

    const noVol = makeCandles({ startSec: JAN_1, count: 10, vol: 0 });
    expect(computeMonthlyVolumeProfiles(noVol)).toHaveLength(0);
  });
});

function createMockChart() {
  const timeScale = {
    timeToIndex: vi.fn((t) => Math.floor((t - JAN_1) / HOUR)),
    logicalToCoordinate: vi.fn((l) => l * 10),
  };
  return { timeScale: () => timeScale, ts: timeScale };
}

function createMockSeries() {
  return {
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
    priceToCoordinate: vi.fn((p) => 1000 - p),
  };
}

function createFakeTarget() {
  const context = {
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    rect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
  };
  return {
    context,
    useBitmapCoordinateSpace: (cb) => cb({ context, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
  };
}

describe('monthly volume profile overlay', () => {
  it('uses the current profile color when first enabled after a palette change', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createMonthlyVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      options: { bins: 10 },
    });

    setPaletteColor('profile', '#12AB34');
    try {
      const candles = makeCandles({ startSec: JAN_1, count: 5, price: 100, vol: 10, step: 1 });
      overlay.setCandles(candles, 'BTC', '1h');
      const primitive = series.attachPrimitive.mock.calls[0][0];
      primitive.attached({ chart, series, requestUpdate: vi.fn() });
      const target = createFakeTarget();
      primitive.paneViews()[0].renderer().draw(target);
      expect(target.context.strokeStyle).toBe('rgba(18, 171, 52, 0.8)');
      expect(target.context.fillStyle).toMatch(/^rgba\(18, 171, 52, /);
    } finally {
      resetColorPalette();
    }
  });

  it('attaches one primitive and dedupes identical candle sets', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createMonthlyVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
    });

    const candles = makeCandles({ startSec: JAN_1, count: 30, step: 1 });
    overlay.setCandles(candles, 'BTC', '1h');
    overlay.setCandles(candles, 'BTC', '1h');

    expect(series.attachPrimitive).toHaveBeenCalledTimes(1);

    overlay.detach();
    expect(series.detachPrimitive).toHaveBeenCalledTimes(1);
  });

  it('re-attaches when the candle series is recreated', () => {
    const chart = createMockChart();
    let series = createMockSeries();
    const overlay = createMonthlyVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
    });

    const candles = makeCandles({ startSec: JAN_1, count: 30, step: 1 });
    overlay.setCandles(candles, 'BTC', '1h');
    const oldSeries = series;

    series = createMockSeries();
    overlay.setCandles(candles, 'BTC', '1h');

    expect(oldSeries.detachPrimitive).toHaveBeenCalledTimes(1);
    expect(series.attachPrimitive).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the series lacks attachPrimitive (stub mode)', () => {
    const chart = createMockChart();
    const series = { priceToCoordinate: () => null };
    const overlay = createMonthlyVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
    });
    expect(() => {
      overlay.setCandles(makeCandles({ startSec: JAN_1, count: 30 }), 'BTC', '1h');
      overlay.detach();
    }).not.toThrow();
  });

  it('draws boxes anchored at month start with widths monotone in bin volume', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createMonthlyVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      options: { bins: 10, period: 'monthly' },
    });

    // Concentrate volume around price 100 so bins differ.
    const candles = [
      { t: JAN_1 + 0 * HOUR, o: '100', h: '110', l: '90', c: '100', v: '10' },
      { t: JAN_1 + 1 * HOUR, o: '100', h: '101', l: '99', c: '100', v: '100' },
      { t: JAN_1 + 2 * HOUR, o: '100', h: '101', l: '99', c: '100', v: '100' },
      { t: JAN_1 + 3 * HOUR, o: '100', h: '110', l: '90', c: '100', v: '10' },
      { t: JAN_1 + 4 * HOUR, o: '100', h: '110', l: '90', c: '105', v: '10' },
    ];
    overlay.setCandles(candles, 'BTC', '1h');

    const primitive = series.attachPrimitive.mock.calls[0][0];
    const requestUpdate = vi.fn();
    primitive.attached({ chart, series, requestUpdate });

    const view = primitive.paneViews()[0];
    expect(view.zOrder()).toBe('bottom');

    const target = createFakeTarget();
    view.renderer().draw(target);

    const rects = target.context.fillRect.mock.calls;
    expect(rects.length).toBeGreaterThan(0);
    // All boxes anchor at the month-start x (logical index 0 -> coordinate 0).
    for (const [x] of rects) expect(x).toBe(0);
    // The widest box must belong to the densest bin (fraction 1).
    const widths = rects.map((args) => args[2]);
    const maxWidth = Math.max(...widths);
    expect(maxWidth).toBeGreaterThan(Math.min(...widths));

    // Lines drawn: POC only (from month start to last bar). VAH/VAL lines are omitted.
    expect(target.context.stroke).toHaveBeenCalledTimes(1);
    expect(target.context.moveTo).toHaveBeenCalledWith(0, expect.any(Number));
    expect(target.context.lineTo).toHaveBeenCalledWith(40, expect.any(Number));
  });

  it('draws the POC as a dotted blue line regardless of close and omits VAH/VAL lines', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createMonthlyVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      options: { bins: 10, period: 'monthly' },
    });

    const candles = [
      { t: JAN_1 + 0 * HOUR, o: '100', h: '101', l: '99', c: '100', v: '100' },
      ...makeCandles({ startSec: JAN_1 + HOUR, count: 4, price: 100, vol: 1 }),
    ];
    overlay.setCandles(candles, 'BTC', '1h');

    const primitive = series.attachPrimitive.mock.calls[0][0];
    primitive.attached({ chart, series, requestUpdate: vi.fn() });
    const view = primitive.paneViews()[0];

    const strokesFor = (close) => {
      overlay.updateLast([{ ...candles[candles.length - 1], c: String(close) }], '1h');
      const target = createFakeTarget();
      const seen = [];
      target.context.stroke.mockImplementation(() => seen.push({
        strokeStyle: target.context.strokeStyle,
        lineWidth: target.context.lineWidth,
        lineCap: target.context.lineCap,
      }));
      view.renderer().draw(target);
      return { seen, context: target.context };
    };

    const above = strokesFor(500);
    const below = strokesFor(1);
    expect(above.seen).toHaveLength(1);
    expect(below.seen).toHaveLength(1);
    // Stroke is the primary POC line
    expect(above.seen[0]).toEqual(below.seen[0]);
    expect(above.seen[0].strokeStyle).toBe('rgba(48, 110, 181, 0.8)');
    expect(above.seen[0].lineWidth).toBe(1);
    expect(above.seen[0].lineCap).toBe('round');
    expect(above.context.setLineDash).toHaveBeenCalledWith([1, 4]);
    expect(above.context.setLineDash).toHaveBeenLastCalledWith([]);
    expect(above.context.save).toHaveBeenCalledTimes(1);
    expect(above.context.restore).toHaveBeenCalledTimes(1);
  });
});

describe('quarterly volume profile support', () => {
  const APR_1 = Date.UTC(2024, 3, 1) / 1000;
  const JUL_1 = Date.UTC(2024, 6, 1) / 1000;

  it('groups bars by calendar quarters when period is quarterly', () => {
    const candles = [
      // Q1: Jan, Feb, Mar
      ...makeCandles({ startSec: JAN_1, count: 6, intervalSec: DAY }),
      ...makeCandles({ startSec: FEB_1, count: 6, intervalSec: DAY }),
      ...makeCandles({ startSec: Date.UTC(2024, 2, 1) / 1000, count: 6, intervalSec: DAY }),
      // Q2: Apr
      ...makeCandles({ startSec: APR_1, count: 6, intervalSec: DAY }),
    ];

    const quarterly = computeVolumeProfiles(candles, { period: 'quarterly' });
    expect(quarterly).toHaveLength(2);
    expect(quarterly[0].period).toBe('quarterly');
    expect(quarterly[0].startTime).toBe(JAN_1);
    expect(quarterly[0].periodStart).toBe(JAN_1);
    expect(quarterly[0].periodEnd).toBe(APR_1);
    expect(quarterly[0].barCount).toBe(18);

    expect(quarterly[1].period).toBe('quarterly');
    expect(quarterly[1].startTime).toBe(APR_1);
    expect(quarterly[1].periodStart).toBe(APR_1);
    expect(quarterly[1].periodEnd).toBe(JUL_1);
    expect(quarterly[1].barCount).toBe(6);
  });

  it('defaults overlay to visible range period and supports switching to quarterly and monthly', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
    });

    expect(overlay.getPeriod()).toBe('visible');
    expect(overlay.getDebugState().period).toBe('visible');

    const candles = [
      ...makeCandles({ startSec: JAN_1, count: 6, intervalSec: DAY }),
      ...makeCandles({ startSec: FEB_1, count: 6, intervalSec: DAY }),
    ];
    overlay.setCandles(candles, 'BTC', '1d');
    expect(overlay.getDebugState().profileCount).toBe(1);

    overlay.setPeriod('monthly');
    expect(overlay.getPeriod()).toBe('monthly');
    expect(overlay.getDebugState().period).toBe('monthly');
    expect(overlay.getDebugState().profileCount).toBe(2); // Split into Jan and Feb

    overlay.setPeriod('quarterly');
    expect(overlay.getPeriod()).toBe('quarterly');
    expect(overlay.getDebugState().profileCount).toBe(1);

    overlay.setPeriod('visible');
    expect(overlay.getPeriod()).toBe('visible');
    expect(overlay.getDebugState().period).toBe('visible');
    expect(overlay.getDebugState().profileCount).toBe(1);
  });
});

describe('visible range profile with low volume node (LVN) boxes', () => {
  it('computes LVN boxes for visible range profile based on PineScript logic', () => {
    // 6 bars with high volume at price 100-104 and 116-120, low volume at 106-114
    const candles = [
      { t: JAN_1 + 0 * HOUR, o: '100', h: '104', l: '100', c: '102', v: '100' },
      { t: JAN_1 + 1 * HOUR, o: '102', h: '104', l: '100', c: '103', v: '100' },
      { t: JAN_1 + 2 * HOUR, o: '106', h: '110', l: '106', c: '108', v: '2' },
      { t: JAN_1 + 3 * HOUR, o: '110', h: '114', l: '110', c: '112', v: '3' },
      { t: JAN_1 + 4 * HOUR, o: '116', h: '120', l: '116', c: '118', v: '100' },
      { t: JAN_1 + 5 * HOUR, o: '118', h: '120', l: '116', c: '119', v: '100' },
    ];

    const profiles = computeVolumeProfiles(candles, { period: 'visible', bins: 20 });
    expect(profiles).toHaveLength(1);
    const visibleProfile = profiles[0];
    expect(visibleProfile.period).toBe('visible');
    expect(Array.isArray(visibleProfile.lvnBoxes)).toBe(true);
    expect(visibleProfile.lvnBoxes.length).toBeGreaterThanOrEqual(1);

    const lvn = visibleProfile.lvnBoxes[0];
    expect(lvn.bottom).toBeGreaterThanOrEqual(100);
    expect(lvn.top).toBeLessThanOrEqual(120);
    expect(lvn.top).toBeGreaterThan(lvn.bottom);
    expect(lvn.startTime).toBe(JAN_1 + 2 * HOUR);
    expect(lvn.endTime).toBe(JAN_1 + 3 * HOUR);
    expect(lvn.startIndex).toBe(2);
    expect(lvn.endIndex).toBe(3);
    expect(lvn.volume).toBeGreaterThan(0);
  });

  it('omits LVN boxes for quarterly and monthly periods ("just to the visible range profile")', () => {
    const candles = [
      { t: JAN_1 + 0 * HOUR, o: '100', h: '104', l: '100', c: '102', v: '100' },
      { t: JAN_1 + 1 * HOUR, o: '102', h: '104', l: '100', c: '103', v: '100' },
      { t: JAN_1 + 2 * HOUR, o: '106', h: '110', l: '106', c: '108', v: '2' },
      { t: JAN_1 + 3 * HOUR, o: '110', h: '114', l: '110', c: '112', v: '3' },
      { t: JAN_1 + 4 * HOUR, o: '116', h: '120', l: '116', c: '118', v: '100' },
      { t: JAN_1 + 5 * HOUR, o: '118', h: '120', l: '116', c: '119', v: '100' },
    ];

    const monthlyProfiles = computeVolumeProfiles(candles, { period: 'monthly', bins: 20 });
    expect(monthlyProfiles[0].lvnBoxes).toEqual([]);

    const quarterlyProfiles = computeVolumeProfiles(candles, { period: 'quarterly', bins: 20 });
    expect(quarterlyProfiles[0].lvnBoxes).toEqual([]);
  });

  it('respects lvnThreshold and maxLvnBoxes options', () => {
    const candles = [
      { t: JAN_1 + 0 * HOUR, o: '100', h: '104', l: '100', c: '102', v: '100' },
      { t: JAN_1 + 1 * HOUR, o: '102', h: '104', l: '100', c: '103', v: '100' },
      { t: JAN_1 + 2 * HOUR, o: '106', h: '110', l: '106', c: '108', v: '2' },
      { t: JAN_1 + 3 * HOUR, o: '110', h: '114', l: '110', c: '112', v: '3' },
      { t: JAN_1 + 4 * HOUR, o: '116', h: '120', l: '116', c: '118', v: '100' },
      { t: JAN_1 + 5 * HOUR, o: '118', h: '120', l: '116', c: '119', v: '100' },
    ];

    // If threshold is very low (e.g. 0.001), 2 and 3 vol are not low enough to trigger
    const tight = computeVolumeProfiles(candles, { period: 'visible', bins: 20, lvnThreshold: 0.0001 });
    expect(tight[0].lvnBoxes.length).toBe(0);

    // If maxLvnBoxes is 1, caps at 1
    const capped = computeVolumeProfiles(candles, { period: 'visible', bins: 20, maxLvnBoxes: 1 });
    expect(capped[0].lvnBoxes.length).toBeLessThanOrEqual(1);
  });

  it('draws LVN boxes on canvas and allows toggling with setLvnVisible', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      options: { bins: 20 },
    });

    const candles = [
      { t: JAN_1 + 0 * HOUR, o: '100', h: '104', l: '100', c: '102', v: '100' },
      { t: JAN_1 + 1 * HOUR, o: '102', h: '104', l: '100', c: '103', v: '100' },
      { t: JAN_1 + 2 * HOUR, o: '106', h: '110', l: '106', c: '108', v: '2' },
      { t: JAN_1 + 3 * HOUR, o: '110', h: '114', l: '110', c: '112', v: '3' },
      { t: JAN_1 + 4 * HOUR, o: '116', h: '120', l: '116', c: '118', v: '100' },
      { t: JAN_1 + 5 * HOUR, o: '118', h: '120', l: '116', c: '119', v: '100' },
    ];

    overlay.setCandles(candles, 'BTC', '1h');
    const primitive = series.attachPrimitive.mock.calls[0][0];
    const requestUpdate = vi.fn();
    primitive.attached({ chart, series, requestUpdate });

    const target = createFakeTarget();
    primitive.paneViews()[0].renderer().draw(target);

    // Check that LVN fill was applied with alpha 0.12 and border with alpha 0.22
    expect(target.context.fillRect).toHaveBeenCalled();
    expect(target.context.strokeRect).toHaveBeenCalled();

    // Toggle LVN visibility off
    expect(overlay.getLvnVisible()).toBe(true);
    overlay.setLvnVisible(false);
    expect(overlay.getLvnVisible()).toBe(false);
    expect(overlay.getDebugState().lvnVisible).toBe(false);

    const targetOff = createFakeTarget();
    primitive.paneViews()[0].renderer().draw(targetOff);
    expect(targetOff.context.strokeRect).not.toHaveBeenCalled();

    // Toggle LVN visibility back on
    overlay.setLvnVisible(true);
    expect(overlay.getLvnVisible()).toBe(true);
    expect(overlay.getDebugState().lvnVisible).toBe(true);
  });

  it('uses 100 default bins (doubled bar count) for improved profile accuracy', () => {
    const candles = [
      { t: JAN_1 + 0 * HOUR, o: '100', h: '200', l: '100', c: '150', v: '1000' },
      ...makeCandles({ startSec: JAN_1 + 1 * HOUR, count: 5, price: 150, vol: 100 }),
    ];
    // Default computation without explicit bins option
    const profiles = computeVolumeProfiles(candles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].bins).toHaveLength(100);

    const { chart, series } = createMockChart();
    const overlay = createVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
    });
    expect(overlay.getDebugState().bins).toBe(100);
  });
});

describe('3 POCs in range profile', () => {
  it('findProfilePocs extracts up to 3 distinct POC peaks sorted by volume descending', () => {
    // 100 bins with 3 distinct volume nodes
    const vols = new Array(100).fill(0);
    // Node 1 at bin 50 (dominant global maximum, 1000 vol)
    vols[49] = 900; vols[50] = 1000; vols[51] = 920;
    // Node 2 at bin 80 (second largest peak, 750 vol)
    vols[79] = 600; vols[80] = 750; vols[81] = 620;
    // Node 3 at bin 20 (third largest peak, 500 vol)
    vols[19] = 400; vols[20] = 500; vols[21] = 420;

    const pocs = findProfilePocs(vols, 100, 1, 100);
    expect(pocs).toHaveLength(3);

    expect(pocs[0].rank).toBe(1);
    expect(pocs[0].index).toBe(50);
    expect(pocs[0].volume).toBe(1000);
    expect(pocs[0].price).toBeCloseTo(150.5);

    expect(pocs[1].rank).toBe(2);
    expect(pocs[1].index).toBe(80);
    expect(pocs[1].volume).toBe(750);
    expect(pocs[1].price).toBeCloseTo(180.5);

    expect(pocs[2].rank).toBe(3);
    expect(pocs[2].index).toBe(20);
    expect(pocs[2].volume).toBe(500);
    expect(pocs[2].price).toBeCloseTo(120.5);
  });

  it('findProfilePocs falls back to next highest bins if fewer than 3 peaks exist', () => {
    // Monotonic / unimodal distribution with only 1 local peak
    const vols = [0, 10, 40, 100, 50, 20, 0];
    const pocs = findProfilePocs(vols, 0, 10, 7);
    expect(pocs).toHaveLength(3);

    expect(pocs[0].rank).toBe(1);
    expect(pocs[0].index).toBe(3); // 100 vol
    expect(pocs[0].volume).toBe(100);

    expect(pocs[1].rank).toBe(2);
    expect(pocs[1].index).toBe(4); // 50 vol
    expect(pocs[1].volume).toBe(50);

    expect(pocs[2].rank).toBe(3);
    expect(pocs[2].index).toBe(2); // 40 vol
    expect(pocs[2].volume).toBe(40);
  });

  it('findProfilePocs handles single-bin and empty distributions gracefully', () => {
    expect(findProfilePocs([], 0, 10)).toEqual([]);
    expect(findProfilePocs([0, 0, 0], 0, 10)).toEqual([]);

    const single = findProfilePocs([0, 100, 0], 0, 10, 3);
    expect(single).toHaveLength(1);
    expect(single[0].rank).toBe(1);
    expect(single[0].index).toBe(1);
    expect(single[0].volume).toBe(100);
  });

  it('computeVolumeProfiles attaches pocs and ensures pocPrice equals largest POC (rank 1)', () => {
    const mk = (i, p, v, h = p + 1, l = p - 1) => ({ t: JAN_1 + i * HOUR, o: String(p), h: String(h), l: String(l), c: String(p), v: String(v) });
    const candles = [
      mk(0, 50, 0, 100, 0), // anchors range lo=0, hi=100
      mk(1, 50, 500, 51, 49), // bin ~50 (dominant peak)
      mk(2, 80, 300, 81, 79), // bin ~80 (second peak)
      mk(3, 20, 200, 21, 19), // bin ~20 (third peak)
      mk(4, 50, 10, 51, 49),
    ];

    const profiles = computeVolumeProfiles(candles, { period: 'visible', bins: 100 });
    expect(profiles).toHaveLength(1);
    const p = profiles[0];

    expect(Array.isArray(p.pocs)).toBe(true);
    expect(p.pocs).toHaveLength(3);
    expect(p.pocs[0].rank).toBe(1);
    expect(p.pocs[1].rank).toBe(2);
    expect(p.pocs[2].rank).toBe(3);

    // Largest POC volume >= second >= third
    expect(p.pocs[0].volume).toBeGreaterThanOrEqual(p.pocs[1].volume);
    expect(p.pocs[1].volume).toBeGreaterThanOrEqual(p.pocs[2].volume);

    // Primary pocPrice equals the largest POC price
    expect(p.pocPrice).toBe(p.pocs[0].price);
  });

  it('renders 3 POCs for visible range with thickest line for largest, thinner for second, thinnest for third', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      options: { period: 'visible', bins: 100 },
    });

    const mk = (i, p, v, h = p + 1, l = p - 1) => ({ t: JAN_1 + i * HOUR, o: String(p), h: String(h), l: String(l), c: String(p), v: String(v) });
    const candles = [
      mk(0, 50, 0, 100, 0), // range [0, 100]
      mk(1, 50, 500, 51, 49), // largest POC (rank 1)
      mk(2, 80, 300, 81, 79), // second largest POC (rank 2)
      mk(3, 20, 200, 21, 19), // third largest POC (rank 3)
      mk(4, 50, 10, 51, 49),
    ];

    overlay.setCandles(candles, 'BTC', '1h');
    const primitive = series.attachPrimitive.mock.calls[0][0];
    primitive.attached({ chart, series, requestUpdate: vi.fn() });

    const target = createFakeTarget();
    const drawnLines = [];
    target.context.stroke.mockImplementation(() => {
      drawnLines.push({
        lineWidth: target.context.lineWidth,
        strokeStyle: target.context.strokeStyle,
        lineCap: target.context.lineCap,
      });
    });

    primitive.paneViews()[0].renderer().draw(target);

    // Filter strokes that correspond to POC lines (which use lineCap 'round')
    const pocStrokes = drawnLines.filter((s) => s.lineCap === 'round');
    expect(pocStrokes).toHaveLength(3);

    // Drawn in reverse order (rank 3 -> rank 2 -> rank 1)
    // Rank 3: thinnest line (lineWidth 1)
    // Rank 2: thinner line (lineWidth 2)
    // Rank 1: thickest line (lineWidth 3)
    expect(pocStrokes[0].lineWidth).toBe(1);
    expect(pocStrokes[1].lineWidth).toBe(2);
    expect(pocStrokes[2].lineWidth).toBe(3);

    // Largest POC has strictly the thickest line, second is thinner, third is thinnest
    expect(pocStrokes[2].lineWidth).toBeGreaterThan(pocStrokes[1].lineWidth);
    expect(pocStrokes[1].lineWidth).toBeGreaterThan(pocStrokes[0].lineWidth);

    // All use PROFILE semantic color
    for (const stroke of pocStrokes) {
      expect(stroke.strokeStyle).toBe('rgba(48, 110, 181, 0.8)');
    }

    // Check debug state includes pocCount: 3
    expect(overlay.getDebugState().pocCount).toBe(3);
  });

  it('preserves single POC line when period is monthly or quarterly', () => {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createVolumeProfileOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      options: { period: 'monthly', bins: 100 },
    });

    const mk = (i, p, v, h = p + 1, l = p - 1) => ({ t: JAN_1 + i * HOUR, o: String(p), h: String(h), l: String(l), c: String(p), v: String(v) });
    const candles = [
      mk(0, 50, 0, 100, 0),
      mk(1, 50, 500, 51, 49),
      mk(2, 80, 300, 81, 79),
      mk(3, 20, 200, 21, 19),
      mk(4, 50, 10, 51, 49),
    ];

    overlay.setCandles(candles, 'BTC', '1h');
    const primitive = series.attachPrimitive.mock.calls[0][0];
    primitive.attached({ chart, series, requestUpdate: vi.fn() });

    const target = createFakeTarget();
    const drawnLines = [];
    target.context.stroke.mockImplementation(() => {
      drawnLines.push({
        lineWidth: target.context.lineWidth,
        strokeStyle: target.context.strokeStyle,
        lineCap: target.context.lineCap,
      });
    });

    primitive.paneViews()[0].renderer().draw(target);

    const pocStrokes = drawnLines.filter((s) => s.lineCap === 'round');
    // In monthly mode, exactly 1 POC stroke is drawn per month (not 3)
    expect(pocStrokes).toHaveLength(1);
    expect(pocStrokes[0].lineWidth).toBe(1);
  });
});


