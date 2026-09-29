/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  formatNotionalCompact,
  getWhaleRadius,
  normalizeTimestamp,
  computeWhaleMarkers,
  createWhaleMarkersOverlay,
  MEGA_WHALE_USD,
  MAJOR_WHALE_USD,
} from '../whale-markers.js';

describe('formatNotionalCompact', () => {
  it('formats USD values into clean compact string labels', () => {
    expect(formatNotionalCompact(0)).toBe('$0');
    expect(formatNotionalCompact(500)).toBe('$500');
    expect(formatNotionalCompact(100000)).toBe('$100k');
    expect(formatNotionalCompact(250000)).toBe('$250k');
    expect(formatNotionalCompact(1000000)).toBe('$1.0M');
    expect(formatNotionalCompact(1250000)).toBe('$1.3M');
    expect(formatNotionalCompact(10500000)).toBe('$11M');
  });
});

describe('normalizeTimestamp', () => {
  it('converts millisecond timestamps to unix seconds', () => {
    expect(normalizeTimestamp(1700000000000)).toBe(1700000000);
    expect(normalizeTimestamp(1700000000)).toBe(1700000000);
    expect(normalizeTimestamp(0)).toBe(0);
  });
});

describe('getWhaleRadius', () => {
  it('scales circle radii logarithmically with trade notional', () => {
    const r100k = getWhaleRadius(100000, 100000);
    const r250k = getWhaleRadius(250000, 100000);
    const r500k = getWhaleRadius(500000, 100000);
    const r1m = getWhaleRadius(1000000, 100000);
    const r5m = getWhaleRadius(5000000, 100000);

    expect(r100k).toBeGreaterThanOrEqual(3.5);
    expect(r250k).toBeGreaterThan(r100k);
    expect(r500k).toBeGreaterThan(r250k);
    expect(r1m).toBeGreaterThan(r500k);
    expect(r5m).toBeGreaterThanOrEqual(r1m);
    expect(r5m).toBeLessThanOrEqual(14);
  });
});

describe('computeWhaleMarkers', () => {
  it('computes historical whale markers using HLC3 typical price and USD notional', () => {
    const candles = [
      // 1. Below minNotional ($90k) -> ignored
      { t: 1700000000, o: 90000, h: 91000, l: 89000, c: 90000, v: 1.0, cvdDelta: 0.5 },
      // 2. Regular whale ($180k) -> buyer-dominant by cvdDelta
      { t: 1700000060, o: 90000, h: 91000, l: 89000, c: 90000, v: 2.0, cvdDelta: 1.0 },
      // 3. Major whale ($360k) -> seller-dominant by cvdDelta
      { t: 1700000120, o: 90000, h: 92000, l: 89000, c: 90000, v: 4.0, cvdDelta: -2.0 },
      // 4. Mega whale ($1.35M) -> buyer-dominant
      { t: 1700000180, o: 90000, h: 93000, l: 89000, c: 90000, v: 15.0, cvdDelta: 8.0 },
    ];

    const markers = computeWhaleMarkers(candles, { minNotional: 100000, clusterRadius: 0 });
    expect(markers).toHaveLength(3);

    // Marker 1 ($180k)
    expect(markers[0].time).toBe(1700000060);
    expect(markers[0].price).toBeCloseTo((91000 + 89000 + 90000) / 3);
    expect(markers[0].notional).toBe(180000);
    expect(markers[0].isBuy).toBe(true);
    expect(markers[0].isMajorWhale).toBe(false);
    expect(markers[0].isMegaWhale).toBe(false);

    // Marker 2 ($360k)
    expect(markers[1].time).toBe(1700000120);
    expect(markers[1].price).toBeCloseTo((92000 + 89000 + 90000) / 3);
    expect(markers[1].notional).toBe(360000);
    expect(markers[1].isBuy).toBe(false);
    expect(markers[1].isMajorWhale).toBe(true);
    expect(markers[1].isMegaWhale).toBe(false);

    // Marker 3 ($1.35M)
    expect(markers[2].time).toBe(1700000180);
    expect(markers[2].price).toBeCloseTo((93000 + 89000 + 90000) / 3);
    expect(markers[2].notional).toBe(1350000);
    expect(markers[2].isBuy).toBe(true);
    expect(markers[2].isMajorWhale).toBe(true);
    expect(markers[2].isMegaWhale).toBe(true);
  });

  it('falls back to close >= open when cvdDelta is unavailable', () => {
    const candles = [
      { t: 1700000000, o: 90000, h: 92000, l: 89000, c: 91000, v: 2.0 },
      { t: 1700000060, o: 91000, h: 91500, l: 89000, c: 89500, v: 2.0 },
    ];

    const markers = computeWhaleMarkers(candles, { minNotional: 100000, clusterRadius: 0 });
    expect(markers).toHaveLength(2);
    expect(markers[0].isBuy).toBe(true); // 91000 >= 90000
    expect(markers[1].isBuy).toBe(false); // 89500 < 91000
  });

  it('detects tape speed surges from trade count n at important swing levels', () => {
    // 10 baseline candles with normal tape speed (n = 40)
    const candles = [];
    for (let i = 0; i < 10; i++) {
      candles.push({
        t: 1700000000 + (i * 60),
        o: 100, h: 102, l: 98, c: 100,
        v: 1500, n: 40, // $150k turnover
      });
    }

    // Candle 10: high tape speed (n = 160 -> 4x baseline) at new swing high (h = 105)
    candles.push({
      t: 1700000000 + (10 * 60),
      o: 100, h: 105, l: 99, c: 104,
      v: 2000, n: 160,
    });

    // Candle 11: ordinary bar with baseline volume and baseline tape speed (filtered out)
    candles.push({
      t: 1700000000 + (11 * 60),
      o: 104, h: 104.5, l: 103, c: 103.5,
      v: 1500, n: 40,
    });

    const markers = computeWhaleMarkers(candles, { minNotional: 100000 });
    const surgeMarker = markers.find((m) => m.time === 1700000000 + (10 * 60));
    expect(surgeMarker).toBeDefined();
    expect(surgeMarker.tapeSpeedRatio).toBeGreaterThanOrEqual(3.5);
    expect(['swing', 'breakout']).toContain(surgeMarker.levelType);

    const ordinaryMarker = markers.find((m) => m.time === 1700000000 + (11 * 60));
    expect(ordinaryMarker).toBeUndefined();
  });

  it('qualifies absorption wicks at range extremes', () => {
    const candles = [];
    for (let i = 0; i < 10; i++) {
      candles.push({
        t: 1700000000 + (i * 60),
        o: 100, h: 102, l: 98, c: 100,
        v: 1000, n: 50,
      });
    }

    // Absorption wick: upper wick rejection (high = 106, close = 101, upper wick 5 / 7 = 71%)
    candles.push({
      t: 1700000000 + (10 * 60),
      o: 100, h: 106, l: 99, c: 101,
      v: 3000, n: 150, // 3x volume surge
    });

    const markers = computeWhaleMarkers(candles, { minNotional: 100000 });
    const absorptionMarker = markers.find((m) => m.time === 1700000000 + (10 * 60));
    expect(absorptionMarker).toBeDefined();
    expect(['absorption', 'sweep']).toContain(absorptionMarker.levelType);
  });

  it('suppresses adjacent cluster bars to leave only the dominant climax peak', () => {
    const candles = [];
    for (let i = 0; i < 10; i++) {
      candles.push({
        t: 1700000000 + (i * 60),
        o: 100, h: 101, l: 99, c: 100,
        v: 1000, n: 50,
      });
    }

    // Multi-bar run: three consecutive high-speed breakout bars (indices 10, 11, 12)
    candles.push({
      t: 1700000000 + (10 * 60),
      o: 100, h: 104, l: 100, c: 103,
      v: 3000, n: 120, // $309k
    });
    candles.push({
      t: 1700000000 + (11 * 60), // dominant climax bar
      o: 103, h: 110, l: 102, c: 109,
      v: 8000, n: 350, // $872k
    });
    candles.push({
      t: 1700000000 + (12 * 60),
      o: 109, h: 111, l: 107, c: 108,
      v: 4500, n: 220, // $486k
    });

    // Default clusterRadius = 2: only the climax bar (index 11) is retained
    const clusteredMarkers = computeWhaleMarkers(candles, { minNotional: 100000, clusterRadius: 2 });
    expect(clusteredMarkers.some((m) => m.time === 1700000000 + (10 * 60))).toBe(false);
    expect(clusteredMarkers.some((m) => m.time === 1700000000 + (11 * 60))).toBe(true);
    expect(clusteredMarkers.some((m) => m.time === 1700000000 + (12 * 60))).toBe(false);

    // With clusterRadius = 0: all three candidates are emitted
    const rawMarkers = computeWhaleMarkers(candles, { minNotional: 100000, clusterRadius: 0 });
    const runMarkers = rawMarkers.filter((m) => m.time >= 1700000000 + (10 * 60));
    expect(runMarkers).toHaveLength(3);
  });
});

describe('createWhaleMarkersOverlay', () => {
  function setupOverlay() {
    let attachedPrimitive = null;
    const seriesMock = {
      attachPrimitive: vi.fn((p) => { attachedPrimitive = p; }),
      detachPrimitive: vi.fn((p) => { if (attachedPrimitive === p) attachedPrimitive = null; }),
      priceToCoordinate: vi.fn((price) => Number(price) / 100),
    };
    const chartMock = {
      timeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 0, to: 100 }),
        timeToIndex: vi.fn((time) => Math.floor((Number(time) - 1700000000) / 10)),
        logicalToCoordinate: vi.fn((idx) => idx * 10),
      }),
    };

    const overlay = createWhaleMarkersOverlay({
      getChart: () => chartMock,
      getCandleSeries: () => seriesMock,
    });

    return { overlay, seriesMock, chartMock, getAttached: () => attachedPrimitive };
  }

  it('attaches and detaches primitive based on visibility options', () => {
    const { overlay, seriesMock } = setupOverlay();

    overlay.setOptions({ visible: true });
    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);

    overlay.setOptions({ visible: false });
    expect(seriesMock.detachPrimitive).toHaveBeenCalledTimes(1);
  });

  it('provides autoscaleInfo returning null to maintain zero vertical price distortion', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({ visible: true });
    const primitive = getAttached();
    expect(primitive).toBeTruthy();
    expect(primitive.autoscaleInfo()).toBeNull();
  });

  it('filters historical candles below minNotional and updates debug state', () => {
    const { overlay } = setupOverlay();
    const candles = [
      { t: 1700000060, o: 90000, h: 91000, l: 89000, c: 90000, v: 1.0 }, // $90k -> below
      { t: 1700000120, o: 90000, h: 91000, l: 89000, c: 90000, v: 2.0 }, // $180k -> qualifies
      { t: 1700000180, o: 90000, h: 91000, l: 89000, c: 90000, v: 12.0 }, // $1.08M -> qualifies
    ];

    overlay.setOptions({ visible: true, minNotional: 150000, clusterRadius: 0 });
    overlay.setCandles(candles, 'BTC', '');

    const debug = overlay.getDebugState();
    expect(debug.visible).toBe(true);
    expect(debug.minNotional).toBe(150000);
    expect(debug.coin).toBe('BTC');
    expect(debug.markerCount).toBe(2);
    expect(debug.attached).toBe(true);
  });

  it('recomputes markers dynamically when minNotional option changes', () => {
    const { overlay } = setupOverlay();
    const candles = [
      { t: 1700000060, o: 90000, h: 91000, l: 89000, c: 90000, v: 1.5 }, // $135k
      { t: 1700000120, o: 90000, h: 91000, l: 89000, c: 90000, v: 3.5 }, // $315k
      { t: 1700000180, o: 90000, h: 91000, l: 89000, c: 90000, v: 15.0 }, // $1.35M
    ];

    overlay.setOptions({ visible: true, minNotional: 100000, clusterRadius: 0 });
    overlay.setCandles(candles, 'BTC', '');
    expect(overlay.getDebugState().markerCount).toBe(3);

    // Increase minNotional to $250k
    overlay.setOptions({ minNotional: 250000 });
    expect(overlay.getDebugState().markerCount).toBe(2);

    // Increase minNotional to $1M
    overlay.setOptions({ minNotional: 1000000 });
    expect(overlay.getDebugState().markerCount).toBe(1);
  });

  it('renders circles and distinguishes mega whales over $1M with badges and dashed halos', () => {
    const { overlay, getAttached } = setupOverlay();
    const candles = [
      // Standard whale: $180k
      { t: 1700000060, o: 90000, h: 91000, l: 89000, c: 90000, v: 2.0, cvdDelta: 1.0 },
      // Major whale: $350k
      { t: 1700000120, o: 90000, h: 91000, l: 89000, c: 90000, v: 3.88, cvdDelta: -2.0 },
      // Mega whale: $1.5M
      { t: 1700000180, o: 90000, h: 91000, l: 89000, c: 90000, v: 16.67, cvdDelta: 10.0 },
    ];

    overlay.setOptions({ visible: true, minNotional: 100000, clusterRadius: 0 });
    overlay.setCandles(candles, 'BTC', '');

    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];
    expect(paneView).toBeTruthy();
    expect(paneView.zOrder()).toBe('bottom');

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 40 })),
    };

    const target = {
      useBitmapCoordinateSpace: vi.fn((fn) => fn({
        context: ctx,
        horizontalPixelRatio: 2,
        verticalPixelRatio: 2,
        bitmapSize: { width: 1000, height: 600 },
      })),
    };

    paneView.renderer().draw(target);

    expect(target.useBitmapCoordinateSpace).toHaveBeenCalledTimes(1);
    expect(ctx.arc).toHaveBeenCalled();
    // setLineDash is called for the mega whale dashed accent ring
    expect(ctx.setLineDash).toHaveBeenCalledWith([expect.any(Number), expect.any(Number)]);
    // fillText is called for the mega whale compact badge text (e.g. $1.5M)
    expect(ctx.fillText).toHaveBeenCalledWith('$1.5M', expect.any(Number), expect.any(Number));
  });

  it('strictly excludes the current forming bar and updates only when closed candles complete', () => {
    const { overlay } = setupOverlay();
    const now = Date.now();
    // Closed candle (completed bucket): 1h duration, ended well in past
    const closedCandle = {
      t: now - 7200000,
      T: now - 3600000,
      o: 90000, h: 91000, l: 89000, c: 90000,
      v: 3.0, // $270k
      cvdDelta: 1.0,
    };
    // Forming candle (current open bucket): ends in future
    const formingCandle = {
      t: now - 1800000,
      T: now + 1800000,
      o: 90000, h: 92000, l: 89000, c: 91000,
      v: 20.0, // huge volume, but live/forming!
      cvdDelta: 10.0,
    };

    overlay.setOptions({ visible: true, minNotional: 100000, clusterRadius: 0 });
    overlay.setCandles([closedCandle, formingCandle], 'BTC', '1h');

    // Only the closed candle must be retained
    const internal = overlay._getInternalState();
    expect(internal.rawCandles).toHaveLength(1);
    expect(internal.rawCandles[0].t).toBe(closedCandle.t);
    expect(internal.markers).toHaveLength(1);
    expect(internal.markers[0].notional).toBe(270000);

    // Live update on forming candle should NOT add forming candle
    formingCandle.v = 30.0;
    overlay.updateLast([closedCandle, formingCandle], '1h');
    expect(internal.rawCandles).toHaveLength(1);

    // When forming candle completes and becomes closed
    const newlyClosedCandle = {
      ...formingCandle,
      T: now - 1000, // completed
    };
    overlay.updateLast([closedCandle, newlyClosedCandle], '1h');
    expect(internal.rawCandles).toHaveLength(2);
    expect(internal.markers).toHaveLength(2);
  });
});
