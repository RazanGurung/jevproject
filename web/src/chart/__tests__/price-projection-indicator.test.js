/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import {
  createPriceProjectionOverlay,
  logicalIndexForUnix,
  occupancyCellAlpha,
} from '../price-projection-indicator.js';
import { utcMonthStartUnix } from '../price-projection.js';
import { resetColorPalette, setPaletteColor } from '../../services/color-palette.js';

function syntheticCandles(count = 4_000) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = open * Math.exp(Math.sin(index / 10) * 0.001 + 0.0001);
    rows.push({
      t: 1_700_000_000 + index * 4 * 3600,
      o: String(open),
      h: String(Math.max(open, close) * 1.002),
      l: String(Math.min(open, close) * 0.998),
      c: String(close),
      v: String(100 + index % 31),
    });
  }
  return rows;
}

function harness() {
  const candleSeries = {
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
    priceToCoordinate: vi.fn(() => 10),
  };
  const chart = {
    addSeries: vi.fn(),
    removeSeries: vi.fn(),
    timeScale: () => ({
      timeToIndex: () => 0,
      logicalToCoordinate: () => 0,
    }),
  };
  const overlay = createPriceProjectionOverlay({
    getChart: () => chart,
    getCandleSeries: () => candleSeries,
  });
  return { chart, candleSeries, overlay };
}

describe('occupancyCellAlpha', () => {
  it('keeps elapsed month-to-date fainter than remaining-horizon cells', () => {
    expect(occupancyCellAlpha(1, false)).toBeCloseTo(0.80, 5);
    expect(occupancyCellAlpha(1, true)).toBeCloseTo(0.20, 5);
    expect(occupancyCellAlpha(0.5, true)).toBeLessThan(occupancyCellAlpha(0.5, false) * 0.45);
  });
});

describe('logicalIndexForUnix', () => {
  it('extends past the last candle instead of snapping future times to it', () => {
    const scale = {
      timeToIndex: (time) => (Number(time) <= 1_000 ? 10 : 10),
    };
    expect(logicalIndexForUnix(scale, 1_000, 1_000, 100)).toBe(10);
    expect(logicalIndexForUnix(scale, 1_400, 1_000, 100)).toBeCloseTo(14, 8);
    expect(logicalIndexForUnix(scale, 900, 1_000, 100)).toBe(10);
  });
});

describe('price projection overlay', () => {
  it('draws the live occupancy map on the candle series and adds no fan lines', () => {
    const { chart, candleSeries, overlay } = harness();
    const candles = syntheticCandles();
    overlay.setOptions({ visible: true });
    expect(overlay.setCandles(candles, 'BTC', '4h', 1)).toBe(true);
    const firstDebug = overlay.getDebugState();
    expect(firstDebug.monthCount).toBeGreaterThanOrEqual(1);
    expect(firstDebug.drawnMonthCount).toBe(1);
    expect(firstDebug.horizonDays).toBeGreaterThan(0);
    expect(firstDebug.horizonDays).toBeLessThanOrEqual(31);
    expect(chart.addSeries).not.toHaveBeenCalled();
    expect(firstDebug.seriesCount).toBe(0);
    expect(firstDebug.originMode).toBe('month-open-live');
    expect(firstDebug.occupancySliceCount).toBeGreaterThan(0);
    expect(firstDebug.occupancyAttached).toBe(true);
    expect(candleSeries.attachPrimitive).toHaveBeenCalled();
    overlay.setCandles(candles, 'BTC', '4h', 1);
    expect(overlay.getDebugState().computeCount).toBe(firstDebug.computeCount);
    expect(overlay.getDebugState()).toMatchObject({
      enabled: true,
      attached: true,
      seriesCount: 0,
      status: 'ready',
    });
  });

  it('recomputes the live fan when the current month grows, and on a revision', () => {
    const { overlay } = harness();
    const candles = syntheticCandles();
    overlay.setOptions({ visible: true });
    overlay.setCandles(candles, 'BTC', '4h', 1);
    expect(overlay.getDebugState().computeCount).toBe(1);
    const firstStatus = overlay.getStatus();
    expect(firstStatus.originMode).toBe('month-open-live');

    const last = candles.at(-1);
    const lastTime = Number(last.t);
    const grown = candles.map((row) => ({ ...row }));
    grown.push({
      ...last,
      t: lastTime + 4 * 3600,
      o: last.c,
      c: String(Number(last.c) * 1.0001),
      h: String(Math.max(Number(last.h), Number(last.c) * 1.0001)),
    });
    expect(utcMonthStartUnix(grown.at(-1).t)).toBe(utcMonthStartUnix(lastTime));
    overlay.setCandles(grown, 'BTC', '4h', 1);
    expect(overlay.getDebugState().computeCount).toBe(2);
    const grownStatus = overlay.getStatus();
    expect(grownStatus.anchorTime).toBe(firstStatus.anchorTime);
    expect(grownStatus.horizonBars).toBe(firstStatus.horizonBars);
    expect(grownStatus.originMode).toBe('month-open-live');

    overlay.setCandles(grown, 'BTC', '4h', 1);
    expect(overlay.getDebugState().computeCount).toBe(2);

    overlay.setCandles(grown, 'BTC', '4h', 2);
    expect(overlay.getDebugState().computeCount).toBe(3);
  });

  it('recomputes when a mid-series bar is repaired before the latest month open', () => {
    const { overlay } = harness();
    const candles = syntheticCandles();
    overlay.setOptions({ visible: true });
    overlay.setCandles(candles, 'BTC', '4h', 1);
    expect(overlay.getDebugState().computeCount).toBe(1);

    const repaired = candles.map((row) => ({ ...row }));
    const latestStart = utcMonthStartUnix(repaired.at(-1).t);
    const prefix = repaired.filter((row) => Number(row.t) < latestStart);
    const mid = Math.floor((prefix.length - 1) / 2);
    repaired[mid] = {
      ...repaired[mid],
      c: String(Number(repaired[mid].c) * 1.05),
      h: String(Math.max(Number(repaired[mid].h), Number(repaired[mid].c) * 1.05)),
    };
    overlay.setCandles(repaired, 'BTC', '4h', 1);
    expect(overlay.getDebugState().computeCount).toBe(2);

    overlay.setCandles(repaired, 'BTC', '4h', 1);
    expect(overlay.getDebugState().computeCount).toBe(2);
  });

  it('paints occupancy with the live MAP palette color', () => {
    const { overlay, candleSeries } = harness();
    overlay.setOptions({ visible: true });
    overlay.setCandles(syntheticCandles(), 'BTC', '4h', 1);
    const primitive = candleSeries.attachPrimitive.mock.calls[0][0];
    primitive.attached({ requestUpdate: vi.fn() });
    setPaletteColor('projection', '#12AB34');
    try {
      overlay.applyTheme();
      const context = {
        fillRect: vi.fn(),
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
        lineJoin: '',
        lineCap: '',
      };
      primitive.paneViews()[0].renderer().draw({
        useBitmapCoordinateSpace: (cb) => cb({
          context,
          horizontalPixelRatio: 1,
          verticalPixelRatio: 1,
        }),
      });
      expect(context.fillStyle).toMatch(/^rgba\(18, 171, 52, /);
      expect(Number(String(context.fillStyle).match(/[\d.]+(?=\)$)/)?.[0] || 0))
        .toBeGreaterThanOrEqual(0.28);
      expect(context.stroke).not.toHaveBeenCalled();
      expect(context.beginPath).not.toHaveBeenCalled();
    } finally {
      resetColorPalette();
    }
  });

  it('publishes unavailable reasons and detaches occupancy when disabled', () => {
    const { chart, candleSeries, overlay } = harness();
    const statuses = [];
    overlay.setOnStatusChange((status) => statuses.push(status));
    overlay.setOptions({ visible: true });
    overlay.setCandles(syntheticCandles(100), 'BTC', '4h', 1);
    expect(statuses.at(-1)).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient-history',
    });

    overlay.setOptions({ visible: false });
    expect(chart.addSeries).not.toHaveBeenCalled();
    expect(overlay.getDebugState().seriesCount).toBe(0);
    expect(overlay.getDebugState().occupancyAttached).toBe(false);
    expect(candleSeries.detachPrimitive).toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({ status: 'disabled' });
  });
});
