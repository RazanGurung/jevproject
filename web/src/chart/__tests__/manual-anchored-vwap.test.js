/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeManualAnchoredVwap,
  createManualAnchoredVwapOverlay,
  deserializeManualAnchors,
  findManualPivotCandidates,
  formatManualAnchorDate,
  normalizeManualAnchorSigma,
  resolveManualPivot,
  serializeManualAnchors,
} from '../manual-anchored-vwap.js';

function makeOverlay() {
  const series = [];
  const chart = {
    addSeries: vi.fn(() => {
      const item = { setData: vi.fn(), applyOptions: vi.fn() };
      series.push(item);
      return item;
    }),
    removeSeries: vi.fn(),
    applyOptions: vi.fn(),
    timeScale: () => ({ timeToIndex: () => 0, logicalToCoordinate: () => 10 }),
  };
  const candleSeries = {
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
    priceToCoordinate: (price) => price,
  };
  const overlay = createManualAnchoredVwapOverlay({
    getChart: () => chart,
    getCandleSeries: () => candleSeries,
    LineSeries: Symbol('LineSeries'),
    LineStyle: { Solid: 0, Dotted: 1 },
  });
  return { overlay, chart, series, candleSeries };
}
import { resetColorPalette, setPaletteColor } from '../../services/color-palette.js';

function candle(t, price, { high = price, low = price, close = price, volume = 10 } = {}) {
  return { t, o: String(price), h: String(high), l: String(low), c: String(close), v: String(volume) };
}

describe('manual anchored VWAP pivot resolution', () => {
  const rows = [
    candle(100, 10), candle(200, 11), candle(300, 12, { high: 16, low: 11 }),
    candle(400, 11), candle(500, 10), candle(600, 9, { high: 10, low: 5 }),
    candle(700, 10), candle(800, 11), candle(900, 10),
  ];

  it('finds confirmed highs and lows using two candles on each side', () => {
    expect(findManualPivotCandidates(rows, 4)).toEqual(expect.arrayContaining([
      expect.objectContaining({ time: 300, price: 16, kind: 'high' }),
      expect.objectContaining({ time: 600, price: 5, kind: 'low' }),
    ]));
  });

  it('chooses the candidate nearest the click in screen coordinates', () => {
    const resolved = resolveManualPivot(rows, 4, { x: 60, y: 50 }, (candidate) => ({
      x: candidate.time / 10,
      y: candidate.price * 10,
    }));
    expect(resolved).toMatchObject({ time: 600, price: 5, kind: 'low' });
  });

  it('falls back to the clicked candle HLC3 when no confirmed pivot can be projected', () => {
    const resolved = resolveManualPivot(rows, 3, { x: 0, y: 0 }, () => null);
    expect(resolved).toMatchObject({ time: 400, kind: 'hlc3' });
    expect(resolved.price).toBeCloseTo(11, 8);
  });
});

describe('manual anchored VWAP math', () => {
  it('uses volume-weighted HLC3 and multiplier bands from the event forward', () => {
    const rows = [candle(100, 10, { volume: 10 }), candle(200, 20, { volume: 30 })];
    const output = computeManualAnchoredVwap(rows, 100, 2);
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      time: 100,
      vwap: 10,
      upper: 10,
      lower: 10,
      midUpper: 10,
      midLower: 10,
    });
    expect(output[1].vwap).toBeCloseTo(17.5, 8);
    expect(output[1].upper).toBeCloseTo(26.160254, 5);
    expect(output[1].lower).toBeCloseTo(8.839746, 5);
    expect(output[1].midUpper).toBeCloseTo((17.5 + 26.160254) / 2, 5);
    expect(output[1].midLower).toBeCloseTo((17.5 + 8.839746) / 2, 5);
  });

  it('computes 4 standard deviations when sigma is 4', () => {
    const rows = [candle(100, 10, { volume: 10 }), candle(200, 20, { volume: 30 })];
    const output = computeManualAnchoredVwap(rows, 100, 4);
    expect(output).toHaveLength(2);
    expect(output[1].vwap).toBeCloseTo(17.5, 8);
    expect(output[1].upper).toBeCloseTo(34.820508, 5);
    expect(output[1].lower).toBeCloseTo(0.179492, 5);
    expect(output[1].midUpper).toBeCloseTo((17.5 + 34.820508) / 2, 5);
    expect(output[1].midLower).toBeCloseTo((17.5 + 0.179492) / 2, 5);
  });

  it('prorates the containing candle when an exact event falls inside it', () => {
    const rows = [candle(100, 10, { volume: 100 }), candle(200, 20, { volume: 100 })];
    const output = computeManualAnchoredVwap(rows, 150, 1);
    expect(output).toHaveLength(2);
    expect(output[1].vwap).toBeCloseTo((10 * 50 + 20 * 100) / 150, 8);
  });

  it('skips zero-volume rows without creating a synthetic seed', () => {
    const rows = [candle(100, 100, { volume: 0 }), candle(200, 110, { volume: 5 })];
    expect(computeManualAnchoredVwap(rows, 100, 2)).toEqual([
      { time: 200, vwap: 110, upper: 110, lower: 110, midUpper: 110, midLower: 110 },
    ]);
  });

  it('withholds output when the anchor predates loaded history', () => {
    expect(computeManualAnchoredVwap([candle(200, 20), candle(300, 30)], 100, 2)).toEqual([]);
  });
});

describe('manual anchored VWAP persistence and lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    resetColorPalette();
  });

  it('round-trips versioned anchors and rejects malformed or unknown versions', () => {
    const anchors = [{
      id: 'a', time: 123, price: 45.6, kind: 'high', color: '#306eb5', bandsVisible: true, sigma: 3,
    }];
    expect(deserializeManualAnchors(serializeManualAnchors(anchors))).toEqual(anchors);
    expect(deserializeManualAnchors('{"version":99,"anchors":[]}')).toEqual([]);
    expect(deserializeManualAnchors('not-json')).toEqual([]);
  });

  it('normalizes legacy per-anchor colors to the drawing-system blue and default band settings', () => {
    const stored = JSON.stringify({
      version: 1,
      anchors: [{ id: 'legacy', time: 123, price: 45.6, kind: 'low', color: '#ffb547' }],
    });
    expect(deserializeManualAnchors(stored)[0]).toMatchObject({
      color: '#306eb5',
      bandsVisible: false,
      sigma: 2,
    });
  });

  it('normalizes sigma values, supporting 1, 2, 3, and 4', () => {
    expect(normalizeManualAnchorSigma(1)).toBe(1);
    expect(normalizeManualAnchorSigma(2)).toBe(2);
    expect(normalizeManualAnchorSigma(3)).toBe(3);
    expect(normalizeManualAnchorSigma(4)).toBe(4);
    expect(normalizeManualAnchorSigma('4')).toBe(4);
    expect(normalizeManualAnchorSigma(5)).toBe(2);
    expect(normalizeManualAnchorSigma(0)).toBe(2);
    expect(normalizeManualAnchorSigma(-1)).toBe(2);
    expect(normalizeManualAnchorSigma(null)).toBe(2);
    expect(normalizeManualAnchorSigma(undefined)).toBe(2);
    expect(normalizeManualAnchorSigma('invalid')).toBe(2);
  });

  it('attaches one VWAP, outer bands, and midpoint bands for each persisted anchor', () => {
    localStorage.setItem('pez:manual-anchored-vwap:BTC', serializeManualAnchors([
      { id: 'a', time: 100, price: 10, kind: 'low', color: '#306eb5', bandsVisible: true, sigma: 2 },
      { id: 'b', time: 200, price: 20, kind: 'high', color: '#22cce6', bandsVisible: true, sigma: 2 },
    ]));
    const { overlay, chart, series } = makeOverlay();
    overlay.setOptions({ visible: true });
    overlay.setCandles([candle(100, 10), candle(200, 20)], 'BTC');

    expect(chart.addSeries).toHaveBeenCalledTimes(10);
    expect(chart.addSeries.mock.calls[0][1].color).toBe('#306eb5');
    expect(chart.addSeries.mock.calls[1][1].color).toBe('#306eb59e');
    expect(chart.addSeries.mock.calls[2][1].color).toBe('#306eb59e');
    expect(chart.addSeries.mock.calls[3][1].color).toBe('#306eb54d');
    expect(chart.addSeries.mock.calls[4][1].color).toBe('#306eb54d');
    expect(chart.addSeries.mock.calls[3][1].lineStyle).toBe(1);
    expect(chart.addSeries.mock.calls[4][1].lineStyle).toBe(1);
    expect(chart.addSeries.mock.calls[5][1].color).toBe('#306eb5');
    expect(chart.addSeries.mock.calls.every((call) => call[1].priceScaleId === 'right')).toBe(true);
    expect(chart.addSeries.mock.calls.every((call) => !('autoscaleInfoProvider' in call[1]))).toBe(true);
    expect(series.every((item) => item.setData.mock.calls.length > 0)).toBe(true);
    expect(overlay.getDebugState()).toMatchObject({ anchorCount: 2, renderedAnchorCount: 2, attached: true });

    overlay.setAnchorOptions('a', { bandsVisible: false });
    expect(series[0].setData.mock.calls.at(-1)[0].length).toBeGreaterThan(0);
    expect(series.slice(1, 5).every((item) => item.setData.mock.calls.at(-1)[0].length === 0)).toBe(true);
    expect(series.slice(6, 10).every((item) => item.setData.mock.calls.at(-1)[0].length > 0)).toBe(true);

    overlay.setOptions({ visible: false });
    expect(chart.removeSeries).toHaveBeenCalledTimes(10);
    expect(overlay.getDebugState().anchorCount).toBe(2);
  });

  it('keeps band visibility and sigma independent per persisted anchor', () => {
    localStorage.setItem('pez:manual-anchored-vwap:BTC', serializeManualAnchors([
      { id: 'a', time: 100, price: 10, kind: 'low', bandsVisible: true, sigma: 2 },
      { id: 'b', time: 200, price: 20, kind: 'high', bandsVisible: false, sigma: 2 },
    ]));
    const { overlay, series } = makeOverlay();
    overlay.setOptions({ visible: true });
    overlay.setCandles([candle(100, 10), candle(200, 20)], 'BTC');

    const bandLength = (index) => series[index].setData.mock.calls.at(-1)[0].length;
    expect(bandLength(1)).toBeGreaterThan(0);
    expect(bandLength(6)).toBe(0);
    expect(overlay.getDebugState().anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', bandsVisible: true, sigma: 2 }),
      expect.objectContaining({ id: 'b', bandsVisible: false, sigma: 2 }),
    ]));

    const beforeAUpper = series[1].setData.mock.calls.at(-1)[0].at(-1).value;
    overlay.setAnchorOptions('b', { bandsVisible: true, sigma: 3 });
    expect(bandLength(1)).toBeGreaterThan(0);
    expect(bandLength(6)).toBeGreaterThan(0);
    expect(series[1].setData.mock.calls.at(-1)[0].at(-1).value).toBe(beforeAUpper);
    expect(overlay.getAnchors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', bandsVisible: true, sigma: 2 }),
      expect.objectContaining({ id: 'b', bandsVisible: true, sigma: 3 }),
    ]));
    expect(deserializeManualAnchors(localStorage.getItem('pez:manual-anchored-vwap:BTC'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a', bandsVisible: true, sigma: 2 }),
        expect.objectContaining({ id: 'b', bandsVisible: true, sigma: 3 }),
      ]),
    );

    overlay.setAnchorOptions('b', { sigma: 4 });
    expect(overlay.getAnchors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', bandsVisible: true, sigma: 2 }),
      expect.objectContaining({ id: 'b', bandsVisible: true, sigma: 4 }),
    ]));
    expect(deserializeManualAnchors(localStorage.getItem('pez:manual-anchored-vwap:BTC'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a', bandsVisible: true, sigma: 2 }),
        expect.objectContaining({ id: 'b', bandsVisible: true, sigma: 4 }),
      ]),
    );
  });

  it('does not recalculate line data for viewport-only render cycles', () => {
    localStorage.setItem('pez:manual-anchored-vwap:BTC', serializeManualAnchors([
      { id: 'a', time: 100, price: 10, kind: 'low', color: '#306eb5', bandsVisible: true, sigma: 2 },
    ]));
    const series = [];
    const chart = {
      addSeries: vi.fn(() => {
        const item = { setData: vi.fn(), applyOptions: vi.fn() };
        series.push(item);
        return item;
      }),
      removeSeries: vi.fn(),
      timeScale: () => ({ timeToIndex: () => 0, logicalToCoordinate: () => 10 }),
    };
    const candleSeries = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      priceToCoordinate: (price) => price,
    };
    const overlay = createManualAnchoredVwapOverlay({
      getChart: () => chart,
      getCandleSeries: () => candleSeries,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1 },
    });
    const rows = [candle(100, 10), candle(200, 20)];

    overlay.setOptions({ visible: true });
    overlay.setCandles(rows, 'BTC', '1m', 7);
    expect(overlay.getDebugState().dataSetCount).toBe(5);

    const beforeCalls = series.map((item) => item.setData.mock.calls.length);
    const beforeSignature = overlay.getDebugState().lastRenderSignature;
    overlay.setOptions({ visible: true });
    overlay.setCandles(rows.map((row) => ({ ...row })), 'BTC', '1m', 7);
    expect(series.map((item) => item.setData.mock.calls.length)).toEqual(beforeCalls);
    expect(overlay.getDebugState().lastRenderSignature).toBe(beforeSignature);

    overlay.setCandles([
      rows[0],
      { ...rows[1], c: '21', h: '21' },
    ], 'BTC', '1m', 7);
    expect(overlay.getDebugState().dataSetCount).toBe(10);

    overlay.setCandles([
      rows[0],
      { ...rows[1], c: '21', h: '21' },
    ], 'BTC', '1m', 8);
    expect(overlay.getDebugState().dataSetCount).toBe(15);

    overlay.setAnchorOptions('a', { bandsVisible: false });
    expect(overlay.getDebugState().dataSetCount).toBe(20);
    expect(series.slice(1).every((item) => item.setData.mock.calls.at(-1)[0].length === 0)).toBe(true);
  });

  it('uses AVWAP color independently and reapplies live theme changes', () => {
    setPaletteColor('avwap', '#123ABC');
    setPaletteColor('rvwap', '#FEDCBA');
    localStorage.setItem('pez:manual-anchored-vwap:BTC', serializeManualAnchors([
      { id: 'a', time: 100, price: 10, kind: 'low', color: '#306eb5' },
    ]));
    const series = [];
    const chart = {
      addSeries: vi.fn(() => {
        const item = { setData: vi.fn(), applyOptions: vi.fn() };
        series.push(item);
        return item;
      }),
      removeSeries: vi.fn(),
      timeScale: () => ({ timeToIndex: () => 0, logicalToCoordinate: () => 10 }),
    };
    const candleSeries = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      priceToCoordinate: (price) => price,
    };
    const overlay = createManualAnchoredVwapOverlay({
      getChart: () => chart,
      getCandleSeries: () => candleSeries,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1 },
    });

    overlay.setOptions({ visible: true });
    overlay.setCandles([candle(100, 10), candle(200, 20)], 'BTC');
    expect(chart.addSeries.mock.calls[0][1].color).toBe('#123abc');

    setPaletteColor('avwap', '#654321');
    overlay.applyTheme();
    expect(series[0].applyOptions.mock.calls.at(-1)[0].color).toBe('#654321');
    expect(series[1].applyOptions.mock.calls.at(-1)[0].color).toBe('#6543219e');
  });

  it('draws a larger origin ring around the anchored VWAP start dot', () => {
    localStorage.setItem('pez:manual-anchored-vwap:BTC', serializeManualAnchors([
      { id: 'a', time: 100, price: 10, kind: 'low', color: '#306eb5' },
    ]));
    let primitive = null;
    const chart = {
      addSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
      removeSeries: vi.fn(),
      timeScale: () => ({ timeToIndex: () => 0, logicalToCoordinate: () => 20 }),
    };
    const candleSeries = {
      attachPrimitive: vi.fn((next) => { primitive = next; }),
      detachPrimitive: vi.fn(),
      priceToCoordinate: () => 30,
    };
    const overlay = createManualAnchoredVwapOverlay({
      getChart: () => chart,
      getCandleSeries: () => candleSeries,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1 },
    });
    overlay.setOptions({ visible: true });
    overlay.setCandles([candle(100, 10)], 'BTC');

    const context = {
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
    };
    primitive.paneViews()[0].renderer().draw({
      useBitmapCoordinateSpace: (draw) => draw({
        context,
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
    });

    expect(context.arc.mock.calls.slice(0, 2)).toEqual([
      [20, 30, 10, 0, Math.PI * 2],
      [20, 30, 4.5, 0, Math.PI * 2],
    ]);
    expect(context.stroke).toHaveBeenCalledTimes(2);
    expect(context.fill).toHaveBeenCalledTimes(1);
  });

  it('renders translucent background band fill between AVWAP upper and lower bands on canvas in bottom z-order', () => {
    localStorage.setItem('pez:manual-anchored-vwap:BTC', serializeManualAnchors([
      { id: 'b', time: 100, price: 10, kind: 'low', bandsVisible: true, sigma: 2 },
    ]));
    let primitive = null;
    const chart = {
      addSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
      removeSeries: vi.fn(),
      timeScale: () => ({
        timeToIndex: (t) => (t === 100 ? 0 : 1),
        logicalToCoordinate: (idx) => 20 + idx * 40,
      }),
    };
    const candleSeries = {
      attachPrimitive: vi.fn((next) => { primitive = next; }),
      detachPrimitive: vi.fn(),
      priceToCoordinate: (price) => 100 - price * 2,
    };
    const overlay = createManualAnchoredVwapOverlay({
      getChart: () => chart,
      getCandleSeries: () => candleSeries,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1 },
    });
    overlay.setOptions({ visible: true });
    overlay.setCandles([candle(100, 10), candle(200, 12)], 'BTC');

    expect(primitive).toBeTruthy();
    const views = primitive.paneViews();
    expect(views).toHaveLength(2);
    expect(views[1].zOrder()).toBe('bottom');

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
    views[1].renderer().draw({
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
  it('places, pivot-snaps a drag, persists, and deletes the selected anchor', () => {
    const rows = [
      candle(100, 10), candle(200, 11), candle(300, 12, { high: 16, low: 11 }),
      candle(400, 11), candle(500, 10), candle(600, 9, { high: 10, low: 5 }),
      candle(700, 10), candle(800, 11), candle(900, 10),
    ];
    const timeScale = {
      timeToIndex: (time) => (Number(time) - 100) / 100,
      logicalToCoordinate: (logical) => logical * 10,
      coordinateToTime: (x) => 100 + Math.round(x / 10) * 100,
      coordinateToLogical: (x) => x / 10,
    };
    const chart = {
      addSeries: vi.fn(() => ({ setData: vi.fn() })),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      timeScale: () => timeScale,
    };
    const candleSeries = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      priceToCoordinate: (price) => price * 10,
      coordinateToPrice: (coordinate) => coordinate / 10,
    };
    const overlay = createManualAnchoredVwapOverlay({
      getChart: () => chart,
      getCandleSeries: () => candleSeries,
      LineSeries: Symbol('LineSeries'),
      LineStyle: { Solid: 0, Dotted: 1 },
    });
    overlay.setOptions({ visible: true });
    overlay.setCandles(rows, 'BTC');
    overlay.setPlacementActive(true);
    expect(overlay.onClick(50, 52)).toBe(true);
    let saved = deserializeManualAnchors(localStorage.getItem('pez:manual-anchored-vwap:BTC'));
    expect(saved[0]).toMatchObject({
      time: 600, price: 5, kind: 'low', bandsVisible: false, sigma: 2,
    });
    expect(overlay.getSelectedAnchor()).toMatchObject({
      time: 600, price: 5, kind: 'low', bandsVisible: false, sigma: 2,
    });
    expect(overlay.getSelectedPoint()).toEqual({ x: 50, y: 50 });

    // Clearing the selected anchor owns the click so chart price-picking cannot
    // run as a second action from the same pointer event.
    expect(overlay.onClick(90, 90)).toBe(true);
    expect(overlay.hasSelection()).toBe(false);
    expect(overlay.getSelectedAnchor()).toBeNull();

    expect(overlay.onPointerDown(50, 50)).toBe(true);
    overlay.onPointerMove(20, 160);
    expect(overlay.onPointerUp()).toBe(true);
    saved = deserializeManualAnchors(localStorage.getItem('pez:manual-anchored-vwap:BTC'));
    expect(saved[0]).toMatchObject({ time: 300, price: 16, kind: 'high' });

    expect(overlay.removeSelected()).toBe(true);
    expect(overlay.getDebugState().anchorCount).toBe(0);
    expect(localStorage.getItem('pez:manual-anchored-vwap:BTC')).toBeNull();
  });

  it('formats anchor timestamps into short numerical DD/MM/YY date labels', () => {
    // 2026-08-25 14:30:00 UTC
    const aug25 = Date.UTC(2026, 7, 25, 14, 30) / 1000;
    expect(formatManualAnchorDate(aug25)).toBe('25/08/26');

    // 2026-01-05 00:00:00 UTC (single digit day and month padded to 2 digits)
    const jan05 = Date.UTC(2026, 0, 5, 0, 0) / 1000;
    expect(formatManualAnchorDate(jan05)).toBe('05/01/26');

    // Millisecond timestamp normalized to seconds
    expect(formatManualAnchorDate(aug25 * 1000)).toBe('25/08/26');

    // Invalid / null / empty inputs
    expect(formatManualAnchorDate(0)).toBe('');
    expect(formatManualAnchorDate(null)).toBe('');
    expect(formatManualAnchorDate(undefined)).toBe('');
    expect(formatManualAnchorDate('invalid')).toBe('');
  });

  it('configures anchored VWAP line with short date title and lastValueVisible matching RVWAP', () => {
    const timeA = Date.UTC(2026, 7, 25, 12, 0) / 1000;
    const timeB = Date.UTC(2026, 8, 10, 8, 0) / 1000;
    localStorage.setItem('pez:manual-anchored-vwap:BTC', serializeManualAnchors([
      { id: 'a', time: timeA, price: 100, kind: 'low', bandsVisible: true, sigma: 2 },
      { id: 'b', time: timeB, price: 110, kind: 'high', bandsVisible: false, sigma: 2 },
    ]));
    const { overlay, chart } = makeOverlay();
    overlay.setOptions({ visible: true });
    overlay.setCandles([candle(timeA, 100), candle(timeB, 110)], 'BTC');

    // 10 series created (5 for anchor a, 5 for anchor b)
    expect(chart.addSeries).toHaveBeenCalledTimes(10);

    // Anchor a main VWAP series has date title '25/08/26' and lastValueVisible: true
    expect(chart.addSeries.mock.calls[0][1].title).toBe('25/08/26');
    expect(chart.addSeries.mock.calls[0][1].lastValueVisible).toBe(true);

    // Anchor a band series have empty title and lastValueVisible: false
    for (let i = 1; i <= 4; i++) {
      expect(chart.addSeries.mock.calls[i][1].title).toBe('');
      expect(chart.addSeries.mock.calls[i][1].lastValueVisible).toBe(false);
    }

    // Anchor b main VWAP series has date title '10/09/26' and lastValueVisible: true
    expect(chart.addSeries.mock.calls[5][1].title).toBe('10/09/26');
    expect(chart.addSeries.mock.calls[5][1].lastValueVisible).toBe(true);

    // Anchor b band series have empty title and lastValueVisible: false
    for (let i = 6; i <= 9; i++) {
      expect(chart.addSeries.mock.calls[i][1].title).toBe('');
      expect(chart.addSeries.mock.calls[i][1].lastValueVisible).toBe(false);
    }

    // Debug state records latest values with chartLabel
    const debug = overlay.getDebugState();
    expect(debug.latestValuesByAnchor.a).toMatchObject({
      chartLabel: '25/08/26',
    });
    expect(debug.latestValuesByAnchor.b).toMatchObject({
      chartLabel: '10/09/26',
    });
  });
});
