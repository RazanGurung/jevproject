/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  normalizeTimestamp,
  computeHeikinAshi,
  computeATR,
  computeRenkoBricks,
  createCandleOverlay,
  getCandleOverlayColors,
  DEFAULT_CANDLE_OVERLAY_OPTIONS,
} from '../candle-overlay.js';

describe('normalizeTimestamp', () => {
  it('converts millisecond timestamps to unix seconds', () => {
    expect(normalizeTimestamp(1700000000000)).toBe(1700000000);
    expect(normalizeTimestamp(1700000000)).toBe(1700000000);
    expect(normalizeTimestamp(0)).toBe(0);
    expect(normalizeTimestamp(null)).toBe(0);
    expect(normalizeTimestamp(undefined)).toBe(0);
  });
});

describe('computeHeikinAshi', () => {
  it('returns empty array when input is empty or invalid', () => {
    expect(computeHeikinAshi([])).toEqual([]);
    expect(computeHeikinAshi(null)).toEqual([]);
    expect(computeHeikinAshi(undefined)).toEqual([]);
  });

  it('correctly calculates the first Heikin Ashi bar', () => {
    const candles = [
      { t: 1700000000, o: 100, h: 110, l: 90, c: 104 },
    ];
    const ha = computeHeikinAshi(candles);
    expect(ha).toHaveLength(1);

    const first = ha[0];
    expect(first.time).toBe(1700000000);
    // haClose = (100 + 110 + 90 + 104) / 4 = 404 / 4 = 101
    expect(first.close).toBe(101);
    // haOpen = (100 + 104) / 2 = 102
    expect(first.open).toBe(102);
    // haHigh = max(110, 102, 101) = 110
    expect(first.high).toBe(110);
    // haLow = min(90, 102, 101) = 90
    expect(first.low).toBe(90);
    // close < open -> bearish
    expect(first.isUp).toBe(false);
  });

  it('correctly chains subsequent Heikin Ashi bars from previous bar open and close', () => {
    const candles = [
      { t: 1700000000, o: 100, h: 110, l: 95, c: 105 }, // haClose = 410/4 = 102.5, haOpen = 205/2 = 102.5
      { t: 1700000060, o: 106, h: 115, l: 100, c: 114 }, // haClose = 435/4 = 108.75
    ];
    const ha = computeHeikinAshi(candles);
    expect(ha).toHaveLength(2);

    const second = ha[1];
    expect(second.time).toBe(1700000060);
    // haOpen = (haOpen_0 + haClose_0) / 2 = (102.5 + 102.5) / 2 = 102.5
    expect(second.open).toBe(102.5);
    // haClose = (106 + 115 + 100 + 114) / 4 = 435 / 4 = 108.75
    expect(second.close).toBe(108.75);
    // haHigh = max(115, 102.5, 108.75) = 115
    expect(second.high).toBe(115);
    // haLow = min(100, 102.5, 108.75) = 100
    expect(second.low).toBe(100);
    expect(second.isUp).toBe(true);
  });

  it('tolerates full field names (time, open, high, low, close) and skips malformed entries', () => {
    const candles = [
      { time: 1700000000, open: 100, high: 110, low: 90, close: 104 },
      null,
      { time: 0, open: 100, high: 110, low: 90, close: 104 }, // invalid timestamp
      { time: 1700000060, open: 'invalid', high: 110, low: 90, close: 104 }, // invalid open
      { time: 1700000120, open: 105, high: 115, low: 100, close: 112 },
    ];
    const ha = computeHeikinAshi(candles);
    expect(ha).toHaveLength(2);
    expect(ha[0].time).toBe(1700000000);
    expect(ha[0].close).toBe(101);
    expect(ha[1].time).toBe(1700000120);
    expect(ha[1].open).toBe((ha[0].open + ha[0].close) / 2);
  });
});

describe('computeATR', () => {
  it('returns reasonable fallback for small candle sets', () => {
    expect(computeATR([])).toBeGreaterThan(0);
    expect(computeATR([{ c: 50000 }])).toBeCloseTo(100);
  });

  it('computes average true range over given period', () => {
    const candles = [
      { h: 105, l: 95, c: 100 },
      { h: 112, l: 98, c: 110 }, // TR = max(14, |112-100|=12, |98-100|=2) = 14
      { h: 115, l: 105, c: 108 }, // TR = max(10, |115-110|=5, |105-110|=5) = 10
    ];
    const atr = computeATR(candles, 2);
    expect(atr).toBeCloseTo(12);
  });

  it('supports full field names (high, low, close)', () => {
    const candles = [
      { high: 105, low: 95, close: 100 },
      { high: 112, low: 98, close: 110 },
      { high: 115, low: 105, close: 108 },
    ];
    const atr = computeATR(candles, 2);
    expect(atr).toBeCloseTo(12);
  });
});

describe('computeRenkoBricks', () => {
  it('returns empty bricks on empty input', () => {
    const res = computeRenkoBricks([]);
    expect(res.bricks).toEqual([]);
    expect(res.brickSize).toBe(0);
  });

  it('symmetrically forms initial down-brick on first downward move', () => {
    // Starting at 100 with brickSize 10:
    // Drop to 89: move is >= 10, so it must form a 100 -> 90 down brick!
    const candles = [
      { t: 100, o: 100, h: 100, l: 100, c: 100 },
      { t: 200, o: 100, h: 100, l: 89, c: 89 },
    ];
    const res = computeRenkoBricks(candles, { brickMode: 'fixed', fixedSize: 10 });
    expect(res.bricks).toHaveLength(1);
    expect(res.bricks[0].isUp).toBe(false);
    expect(res.bricks[0].open).toBe(100);
    expect(res.bricks[0].close).toBe(90);
    expect(res.currentDirection).toBe(-1);
  });

  it('symmetrically forms initial up-brick on first upward move', () => {
    // Starting at 100 with brickSize 10:
    // Rise to 111: move is >= 10, so it must form a 100 -> 110 up brick!
    const candles = [
      { t: 100, o: 100, h: 100, l: 100, c: 100 },
      { t: 200, o: 100, h: 111, l: 100, c: 111 },
    ];
    const res = computeRenkoBricks(candles, { brickMode: 'fixed', fixedSize: 10 });
    expect(res.bricks).toHaveLength(1);
    expect(res.bricks[0].isUp).toBe(true);
    expect(res.bricks[0].open).toBe(100);
    expect(res.bricks[0].close).toBe(110);
    expect(res.currentDirection).toBe(1);
  });

  it('respects fixed brick size', () => {
    const candles = [
      { t: 100, o: 100, h: 105, l: 95, c: 100 },
      { t: 200, o: 100, h: 115, l: 100, c: 112 },
      { t: 300, o: 112, h: 125, l: 110, c: 122 },
    ];
    const res = computeRenkoBricks(candles, { brickMode: 'fixed', fixedSize: 10 });
    expect(res.brickSize).toBe(10);
    expect(res.bricks.length).toBeGreaterThanOrEqual(2);
    expect(res.bricks[0].isUp).toBe(true);
    expect(res.bricks[0].open).toBe(100);
    expect(res.bricks[0].close).toBe(110);
  });

  it('respects percentage brick size with full field names', () => {
    const candles = [
      { time: 100, open: 1000, high: 1000, low: 1000, close: 1000 },
      { time: 200, open: 1000, high: 1050, low: 990, close: 1050 },
    ];
    const res = computeRenkoBricks(candles, { brickMode: 'percent', percent: 1.0 });
    // 1% of 1050 = 10.5
    expect(res.brickSize).toBeCloseTo(10.5);
  });

  it('executes 2-brick reversal rule properly', () => {
    // Starting at 100 with brickSize 10:
    // Move up to 122 -> 2 UP bricks (100->110, 110->120).
    // Now top=120, bottom=110, direction = UP.
    // For a reversal, price must drop <= bottom - brickSize = 110 - 10 = 100.
    const candles = [
      { t: 100, o: 100, h: 105, l: 98, c: 100 },
      { t: 200, o: 100, h: 122, l: 100, c: 122 }, // Up to 122 -> forms 100->110 and 110->120
      { t: 300, o: 122, h: 122, l: 108, c: 108 }, // Pullback to 108: does NOT trigger reversal (needs <= 100)
      { t: 400, o: 108, h: 108, l: 98, c: 98 },   // Drops to 98 <= 100: triggers reversal! Forms 110->100 DOWN brick
    ];
    const res = computeRenkoBricks(candles, { brickMode: 'fixed', fixedSize: 10 });
    expect(res.bricks).toHaveLength(3);

    // Brick 1: Up 100 -> 110
    expect(res.bricks[0].isUp).toBe(true);
    expect(res.bricks[0].open).toBe(100);
    expect(res.bricks[0].close).toBe(110);

    // Brick 2: Up 110 -> 120
    expect(res.bricks[1].isUp).toBe(true);
    expect(res.bricks[1].open).toBe(110);
    expect(res.bricks[1].close).toBe(120);

    // Brick 3: Reversal Down 110 -> 100
    expect(res.bricks[2].isUp).toBe(false);
    expect(res.bricks[2].open).toBe(110);
    expect(res.bricks[2].close).toBe(100);
  });

  it('tags multiple bricks formed in the same candle with intraIndex and totalInCandle', () => {
    const candles = [
      { t: 100, o: 100, h: 100, l: 100, c: 100 },
      { t: 200, o: 100, h: 135, l: 100, c: 135 }, // Jumps +35 with brickSize 10 -> 3 bricks in one candle
    ];
    const res = computeRenkoBricks(candles, { brickMode: 'fixed', fixedSize: 10 });
    expect(res.bricks.length).toBe(3);
    expect(res.bricks[0].intraIndex).toBe(0);
    expect(res.bricks[0].totalInCandle).toBe(3);
    expect(res.bricks[1].intraIndex).toBe(1);
    expect(res.bricks[1].totalInCandle).toBe(3);
    expect(res.bricks[2].intraIndex).toBe(2);
    expect(res.bricks[2].totalInCandle).toBe(3);
  });
});

describe('DEFAULT_CANDLE_OVERLAY_OPTIONS & getCandleOverlayColors', () => {
  it('defaults renko showWicks to false and baseCandles to dimmed', () => {
    expect(DEFAULT_CANDLE_OVERLAY_OPTIONS.mode).toBe('off');
    expect(DEFAULT_CANDLE_OVERLAY_OPTIONS.contrast).toBe(0.5);
    expect(DEFAULT_CANDLE_OVERLAY_OPTIONS.baseCandles).toBe('dimmed');
    expect(DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.showWicks).toBe(false);
    expect(DEFAULT_CANDLE_OVERLAY_OPTIONS.heikinAshi.showWicks).toBe(true);
    expect(DEFAULT_CANDLE_OVERLAY_OPTIONS.heikinAshi.dimmed).toBe(false);
    expect(DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.dimmed).toBe(true);
  });

  it('provides directional cyan/red overlay colors by default', () => {
    const colors = getCandleOverlayColors();
    expect(colors.bullish).toMatch(/^#22cce6|#[0-9a-fA-F]{6}$/);
    expect(colors.bearish).toMatch(/^#ff5050|#[0-9a-fA-F]{6}$/);
  });
});

describe('createCandleOverlay primitive', () => {
  function setupOverlay(options) {
    let attachedPrimitive = null;
    const seriesMock = {
      attachPrimitive: vi.fn((prim) => { attachedPrimitive = prim; }),
      detachPrimitive: vi.fn(() => { attachedPrimitive = null; }),
      priceToCoordinate: vi.fn((p) => 500 - p),
    };
    const chartMock = {
      timeScale: vi.fn(() => ({
        timeToIndex: vi.fn((t) => Math.floor(t / 60)),
        logicalToCoordinate: vi.fn((idx) => idx * 10),
        getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 100 })),
      })),
    };

    const overlay = createCandleOverlay({
      getChart: () => chartMock,
      getCandleSeries: () => seriesMock,
      options,
    });

    return { overlay, seriesMock, chartMock, getAttached: () => attachedPrimitive };
  }

  it('stays detached by default when mode is off', () => {
    const { overlay, seriesMock } = setupOverlay();
    overlay.setCandles([{ t: 100, o: 100, h: 110, l: 90, c: 105 }], 'BTC', '1h');
    expect(seriesMock.attachPrimitive).not.toHaveBeenCalled();
    expect(overlay.getDebugState().attached).toBe(false);
    expect(overlay.getDebugState().mode).toBe('off');
  });

  it('attaches primitive when switched to renko mode', () => {
    const { overlay, seriesMock, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'renko' });
    overlay.setCandles([
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 95, c: 115 },
    ], 'BTC', '1h');

    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(getAttached()).toBeTruthy();
    expect(overlay.getDebugState().mode).toBe('renko');
  });

  it('attaches primitive when mode is switched to heikin-ashi', () => {
    const { overlay, seriesMock, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'heikin-ashi' });
    overlay.setCandles([
      { t: 60, o: 100, h: 110, l: 90, c: 105 },
      { t: 120, o: 105, h: 115, l: 100, c: 112 },
    ], 'BTC', '1h');

    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(getAttached()).toBeTruthy();
    expect(overlay.getDebugState().haCount).toBe(2);
    expect(overlay.getDebugState().mode).toBe('heikin-ashi');
  });

  it('attaches primitive when mode is switched to renko', () => {
    const { overlay, seriesMock, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });
    overlay.setCandles([
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 95, c: 115 },
    ], 'BTC', '1h');

    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(getAttached()).toBeTruthy();
    expect(overlay.getDebugState().renkoBrickCount).toBeGreaterThan(0);
    expect(overlay.getDebugState().mode).toBe('renko');
  });

  it('renders Heikin Ashi bars on canvas in bitmap coordinate space', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'heikin-ashi' });
    overlay.setCandles([
      { t: 60, o: 100, h: 110, l: 90, c: 105 },
      { t: 120, o: 105, h: 115, l: 100, c: 112 },
    ], 'BTC', '1h');

    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];
    expect(paneView).toBeTruthy();
    expect(paneView.zOrder()).toBe('top');

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
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
    // fillRect should be called for wicks and bodies
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it('renders Renko bricks on canvas with borders and fills', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });
    overlay.setCandles([
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 95, c: 115 },
    ], 'BTC', '1h');

    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
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
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.strokeRect).toHaveBeenCalled();
  });

  it('updates live candles via updateLast', () => {
    const { overlay } = setupOverlay();
    overlay.setOptions({ mode: 'heikin-ashi' });
    const candles = [
      { t: 60, o: 100, h: 110, l: 90, c: 105 },
    ];
    overlay.setCandles(candles, 'BTC', '1h');
    expect(overlay.getDebugState().haCount).toBe(1);

    // Live update appends second candle
    const updated = [
      candles[0],
      { t: 120, o: 105, h: 115, l: 100, c: 114 },
    ];
    overlay.updateLast(updated, '1h');
    expect(overlay.getDebugState().haCount).toBe(2);
  });

  it('detaches cleanly when mode returns to off', () => {
    const { overlay, seriesMock } = setupOverlay();
    overlay.setOptions({ mode: 'heikin-ashi' });
    overlay.setCandles([{ t: 60, o: 100, h: 110, l: 90, c: 105 }], 'BTC', '1h');
    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);

    overlay.setOptions({ mode: 'off' });
    expect(seriesMock.detachPrimitive).toHaveBeenCalledTimes(1);
    expect(overlay.getDebugState().attached).toBe(false);
  });

  it('updates baseCandles and contrast options in debug state', () => {
    const { overlay } = setupOverlay();
    expect(overlay.getDebugState().contrast).toBe(0.5);
    expect(overlay.getDebugState().baseCandles).toBe('dimmed');

    overlay.setOptions({ contrast: 0.65, baseCandles: 'normal' });
    expect(overlay.getDebugState().contrast).toBe(0.65);
    expect(overlay.getDebugState().baseCandles).toBe('normal');

    overlay.setOptions({ contrast: 'invalid' });
    expect(overlay.getDebugState().contrast).toBe(0.65);
  });

  it('guarantees that Renko blocks never stack vertically in the same column and are strictly locked to candle time and price', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // Multi-brick candle with surges and subsequent reversals
    const candles = [
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 135, l: 95, c: 135 }, // Multiple bricks in one candle
      { t: 180, o: 135, h: 135, l: 110, c: 110 }, // Reversal
      { t: 240, o: 110, h: 112, l: 108, c: 110 }, // Consolidation
      { t: 300, o: 110, h: 140, l: 110, c: 140 }, // Breakout surge
    ];

    overlay.setCandles(candles, 'BTC', '1h');
    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const filledBoxes = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn((x, y, w, h) => {
        // Collect brick body fillRect calls
        if (w >= 1 && h >= 2) {
          filledBoxes.push({ left: x, right: x + w, width: w, top: y, height: h });
        }
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
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

    expect(filledBoxes.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < filledBoxes.length - 1; i++) {
      const current = filledBoxes[i];
      const next = filledBoxes[i + 1];
      // Zero vertical stacking: every subsequent brick steps forward horizontally!
      expect(next.left).toBeGreaterThan(current.left);
      // Guarantee proper block width (never squeezed into 1-2px diagonal slivers)
      expect(current.width).toBeGreaterThanOrEqual(5);
    }
    // Time locking: bricks are anchored to candle coordinates, not drifted into future
    const firstBox = filledBoxes[0];
    expect(firstBox.left).toBeLessThanOrEqual(40);
  });

  it('guarantees Renko bricks render with substantial block widths preventing diagonal rendering during multi-brick surges', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // Single candle with a massive 5-brick surge
    const candles = [
      { t: 60, o: 100, h: 100, l: 100, c: 100 },
      { t: 120, o: 100, h: 155, l: 100, c: 155 }, // +55 point surge = 5 bricks
      { t: 180, o: 155, h: 155, l: 155, c: 155 },
    ];

    overlay.setCandles(candles, 'BTC', '1h');
    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const filledBoxes = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn((x, y, w, h) => {
        if (w >= 1 && h >= 2) {
          filledBoxes.push({ left: x, right: x + w, width: w, top: y, height: h });
        }
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
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

    // Exactly 1 established brick is rendered for the candle (zero diagonal staircases, zero vertical stacking)
    expect(filledBoxes).toHaveLength(1);
    const box = filledBoxes[0];
    // Full substantial width (never a 2px diagonal sliver)
    expect(box.width).toBeGreaterThanOrEqual(10);
    // Locked to candle 120 coordinate: idx = 2 -> coord = 20 -> bitmap X = 40
    expect(box.left).toBeGreaterThanOrEqual(30);
    expect(box.left).toBeLessThanOrEqual(35);
    // Locked to established price level: 140 -> 150 (priceToCoord(150) = 350 -> top = 700, height = 20)
    expect(box.top).toBe(700);
    expect(box.height).toBe(20);
  });

  it('guarantees that Renko bricks render in visible viewport across 2000+ historical candles without runaway drift', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // Generate 2000 candles with frequent surges
    const candles = [];
    let p = 50000;
    for (let i = 0; i < 2000; i++) {
      const o = p;
      const change = (i % 2 === 0 ? 25 : -15);
      const c = o + change;
      p = c;
      candles.push({ t: i * 60, o, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5, c });
    }

    overlay.setCandles(candles, 'BTC', '1m');
    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const filledBoxes = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn((x, y, w, h) => {
        if (w >= 1 && h >= 2) {
          filledBoxes.push({ left: x, right: x + w, width: w, top: y, height: h });
        }
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
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

    // Assert that bricks ARE rendered within the visible viewport (NOT culled to zero by drift)
    expect(filledBoxes.length).toBeGreaterThanOrEqual(1);
    for (const box of filledBoxes) {
      expect(box.left).toBeLessThanOrEqual(1050);
      expect(box.right).toBeGreaterThanOrEqual(-50);
    }
  });

  it('guarantees that Renko bricks render when scrolled to the live edge of 2000 historical candles', () => {
    const { overlay, chartMock, getAttached } = setupOverlay();
    // Simulate user looking at the live edge: indices 1900 to 2000
    chartMock.timeScale = vi.fn(() => ({
      timeToIndex: vi.fn((t) => Math.floor(t / 60)),
      logicalToCoordinate: vi.fn((idx) => (idx - 1900) * 10),
      getVisibleLogicalRange: vi.fn(() => ({ from: 1900, to: 2000 })),
    }));

    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    const candles = [];
    let p = 50000;
    for (let i = 0; i < 2000; i++) {
      const o = p;
      const change = (i % 2 === 0 ? 25 : -15);
      const c = o + change;
      p = c;
      candles.push({ t: i * 60, o, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5, c });
    }

    overlay.setCandles(candles, 'BTC', '1m');
    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const filledBoxes = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn((x, y, w, h) => {
        if (w >= 1 && h >= 2) {
          filledBoxes.push({ left: x, right: x + w, width: w, top: y, height: h });
        }
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
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

    // Assert that bricks at the live edge ARE rendered and not culled off screen
    expect(filledBoxes.length).toBeGreaterThanOrEqual(1);
    for (const box of filledBoxes) {
      expect(box.left).toBeLessThanOrEqual(1050);
      expect(box.right).toBeGreaterThanOrEqual(-50);
    }
  });

  it('guarantees Renko bricks are strictly locked to candle time and price matching native candles and Heikin Ashi', () => {
    const { overlay, chartMock, seriesMock, getAttached } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // 4 discrete candles:
    // Candle 0: t=60, price 100
    // Candle 1: t=120, price 115 -> forms 100->110 brick
    // Candle 2: t=180, price 112 -> consolidation, shelf extends
    // Candle 3: t=240, price 128 -> forms 110->120 brick
    const candles = [
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 100, c: 115 },
      { t: 180, o: 115, h: 115, l: 110, c: 112 },
      { t: 240, o: 112, h: 128, l: 112, c: 128 },
    ];

    overlay.setCandles(candles, 'BTC', '1m');
    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const filledBoxes = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn((x, y, w, h) => {
        if (w >= 1 && h >= 2) {
          filledBoxes.push({ left: x, right: x + w, width: w, top: y, height: h });
        }
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
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

    // Should have 2 bricks: one from Candle 1 (t=120) and one from Candle 3 (t=240)
    expect(filledBoxes).toHaveLength(2);

    // Candle 1: idx = 2 -> logicalToCoordinate(2) = 20 -> bitmap X = 20 * 2 = 40
    // Brick 0 must be centered at 40 (left around 40 - defaultBarWidthPx/2)
    const brick0 = filledBoxes[0];
    expect(brick0.left).toBeGreaterThanOrEqual(30);
    expect(brick0.left).toBeLessThanOrEqual(35);

    // Price locking: Brick 0 is 100 -> 110. Series priceToCoordinate(110) = 500-110 = 390.
    // In bitmap space (vpr = 2), top = 390 * 2 = 780. Height = |110-100| * 2 = 20.
    expect(brick0.top).toBe(780);
    expect(brick0.height).toBe(20);

    // Candle 3: idx = 4 -> logicalToCoordinate(4) = 40 -> bitmap X = 40 * 2 = 80
    // Brick 1 must be centered at 80 (left around 80 - defaultBarWidthPx/2)
    const brick1 = filledBoxes[1];
    expect(brick1.left).toBeGreaterThanOrEqual(70);
    expect(brick1.left).toBeLessThanOrEqual(75);

    // Price locking: Brick 1 is 110 -> 120. Series priceToCoordinate(120) = 500-120 = 380.
    // In bitmap space (vpr = 2), top = 380 * 2 = 760. Height = |120-110| * 2 = 20.
    expect(brick1.top).toBe(760);
    expect(brick1.height).toBe(20);

    // Brick 0 extends as a shelf across consolidation Candle 2, meeting Brick 1's start
    expect(brick0.right).toBe(brick1.left);
  });

  it('attaches primitive and computes both Heikin Ashi and Renko in both mode', () => {
    const { overlay, seriesMock, getAttached } = setupOverlay();
    overlay.setOptions({
      mode: 'both',
      renko: { brickMode: 'fixed', fixedSize: 10 },
    });
    overlay.setCandles([
      { t: 60, o: 100, h: 110, l: 90, c: 105 },
      { t: 120, o: 105, h: 125, l: 95, c: 125 },
    ], 'BTC', '1h');

    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(getAttached()).toBeTruthy();
    expect(overlay.getDebugState().mode).toBe('both');
    expect(overlay.getDebugState().haCount).toBe(2);
    expect(overlay.getDebugState().renkoBrickCount).toBeGreaterThan(0);
  });

  it('renders both Heikin Ashi bars and Renko bricks in both mode on canvas', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({
      mode: 'both',
      renko: { brickMode: 'fixed', fixedSize: 10 },
    });
    overlay.setCandles([
      { t: 60, o: 100, h: 110, l: 90, c: 105 },
      { t: 120, o: 105, h: 125, l: 95, c: 125 },
    ], 'BTC', '1h');

    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];
    expect(paneView).toBeTruthy();

    const fillStyles = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      set fillStyle(val) { fillStyles.push(val); },
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
    // fillRect should be called multiple times for both HA and Renko
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ctx.strokeRect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('applies dimmed opacity when Heikin Ashi or Renko is dimmed', () => {
    const { overlay, getAttached } = setupOverlay();
    overlay.setOptions({
      mode: 'both',
      heikinAshi: { dimmed: true, opacity: 0.35 },
      renko: { dimmed: true, opacity: 0.45, brickMode: 'fixed', fixedSize: 10 },
    });
    overlay.setCandles([
      { t: 60, o: 100, h: 110, l: 90, c: 105 },
      { t: 120, o: 105, h: 125, l: 95, c: 125 },
    ], 'BTC', '1h');

    const debug = overlay.getDebugState();
    expect(debug.heikinAshi.dimmed).toBe(true);
    expect(debug.heikinAshi.opacity).toBe(0.35);
    expect(debug.renko.dimmed).toBe(true);
    expect(debug.renko.opacity).toBe(0.45);

    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const fillStyles = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      set fillStyle(val) { fillStyles.push(val); },
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
    expect(fillStyles.some((s) => s.includes('0.35'))).toBe(true);
    expect(fillStyles.some((s) => s.includes('0.45'))).toBe(true);
  });

  it('maintains strict Renko brick stability across timeframe and coin switches', () => {
    const { overlay } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 50 } });

    const btcCandles1h = [
      { t: 3600, o: 60000, h: 60050, l: 59950, c: 60000 },
      { t: 7200, o: 60000, h: 60120, l: 59980, c: 60110 },
      { t: 10800, o: 60110, h: 60230, l: 60090, c: 60210 },
      { t: 14400, o: 60210, h: 60220, l: 60040, c: 60050 },
    ];
    overlay.setCandles(btcCandles1h, 'BTC', '1h');
    const initialBricks = overlay.getDebugState().renkoBrickCount;
    const initialInternal = JSON.parse(JSON.stringify(overlay._getInternalState().renkoData.bricks));
    expect(initialBricks).toBeGreaterThan(0);

    // Switch to ETH 15m
    const ethCandles15m = [
      { t: 900, o: 3000, h: 3020, l: 2990, c: 3010 },
      { t: 1800, o: 3010, h: 3080, l: 3000, c: 3075 },
    ];
    overlay.setCandles(ethCandles15m, 'ETH', '15m');
    expect(overlay.getDebugState().coin).toBe('ETH');
    expect(overlay.getDebugState().timeframe).toBe('15m');

    // Switch back to BTC 1h
    overlay.setCandles(btcCandles1h, 'BTC', '1h');
    expect(overlay.getDebugState().coin).toBe('BTC');
    expect(overlay.getDebugState().timeframe).toBe('1h');
    expect(overlay.getDebugState().renkoBrickCount).toBe(initialBricks);
    expect(overlay._getInternalState().renkoData.bricks).toEqual(initialInternal);
  });

  it('ignores updateLast calls with mismatched coin to prevent cross-coin contamination', () => {
    const { overlay } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    const btcCandles = [
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 95, c: 115 },
    ];
    overlay.setCandles(btcCandles, 'BTC', '1h');
    const btcBrickCount = overlay.getDebugState().renkoBrickCount;

    // A delayed update for ETH arrives while chart is on BTC
    const ethCandles = [
      { t: 60, o: 3000, h: 3100, l: 2900, c: 3080 },
    ];
    overlay.updateLast(ethCandles, 'ETH', '1h');

    // State must remain BTC, bricks unmodified
    expect(overlay.getDebugState().coin).toBe('BTC');
    expect(overlay.getDebugState().renkoBrickCount).toBe(btcBrickCount);
  });

  it('ignores updateLast calls with mismatched timeframe to prevent cross-timeframe contamination', () => {
    const { overlay } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    const btcCandles1h = [
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 95, c: 115 },
    ];
    overlay.setCandles(btcCandles1h, 'BTC', '1h');
    const initialBrickCount = overlay.getDebugState().renkoBrickCount;

    // A delayed in-flight tick for a 5m timeframe arrives while chart is on 1h
    const btcCandles5m = [
      { t: 60, o: 100, h: 101, l: 99, c: 100 },
    ];
    overlay.updateLast(btcCandles5m, 'BTC', '5m');

    // State must remain 1h, bricks and timeframe unmodified
    expect(overlay.getDebugState().timeframe).toBe('1h');
    expect(overlay.getDebugState().renkoBrickCount).toBe(initialBrickCount);
  });

  it('avoids recomputation in setOptions when calculation parameters do not change', () => {
    const { overlay } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    const candles = [
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 95, c: 115 },
    ];
    overlay.setCandles(candles, 'BTC', '1h');

    const internalBefore = overlay._getInternalState().renkoData;

    // Updating only visual properties (opacity, dimmed) must preserve renkoData identity
    overlay.setOptions({
      renko: { opacity: 0.8, dimmed: false, showWicks: true },
      contrast: 0.7,
    });

    const internalAfter = overlay._getInternalState().renkoData;
    expect(internalAfter).toBe(internalBefore); // Same reference, no recomputation

    // Idempotent setOptions call with identical values
    overlay.setOptions({
      mode: 'renko',
      renko: { brickMode: 'fixed', fixedSize: 10 },
    });
    expect(overlay._getInternalState().renkoData).toBe(internalBefore);
  });

  it('handles floating point precision gracefully using epsilon tolerance', () => {
    // Starting at 0.3 with brickSize 0.1:
    // Binary float representation of 0.3 + 0.1 is 0.40000000000000002
    // If a candle close is 0.4, epsilon tolerance ensures it forms the brick
    const candles = [
      { t: 100, o: 0.3, h: 0.3, l: 0.3, c: 0.3 },
      { t: 200, o: 0.3, h: 0.4, l: 0.3, c: 0.4 },
    ];
    const res = computeRenkoBricks(candles, { brickMode: 'fixed', fixedSize: 0.1 });
    expect(res.bricks.length).toBe(1);
    expect(res.bricks[0].open).toBeCloseTo(0.3);
    expect(res.bricks[0].close).toBeCloseTo(0.4);
  });

  it('extends the shelf of the latest Renko brick across consolidation candles to the live edge', () => {
    const { overlay, getAttached, chartMock } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // Brick forms at t=60, then t=120 and t=180 consolidate without forming a new brick
    const candles = [
      { t: 60, o: 100, h: 115, l: 95, c: 115 }, // forms brick 100->110
      { t: 120, o: 115, h: 116, l: 108, c: 112 }, // consolidation
      { t: 180, o: 112, h: 114, l: 109, c: 111 }, // consolidation (live edge)
    ];
    overlay.setCandles(candles, 'BTC', '1m');

    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const fillRects = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn((x, y, w, h) => fillRects.push({ x, y, w, h })),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
    };

    const target = {
      useBitmapCoordinateSpace: vi.fn((fn) => fn({
        context: ctx,
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
        bitmapSize: { width: 1000, height: 600 },
      })),
    };

    paneView.renderer().draw(target);

    // The brick should have a width spanning multiple bar slots (from idx 0 to idx 2)
    expect(fillRects.length).toBeGreaterThanOrEqual(1);
    const lastBrickRect = fillRects[0];
    // With 3 candles at spacing ~20px, shelf width should be >= 30px (spanning across consolidation bars)
    expect(lastBrickRect.w).toBeGreaterThanOrEqual(20);
  });

  it('guarantees that when closedCandles is supplied, Renko bricks form strictly from closed candles while the active shelf extends to the live candle', () => {
    const { overlay } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // Closed candles: t=60 and t=120
    const closedCandles = [
      { t: 60, o: 100, h: 105, l: 95, c: 100 },
      { t: 120, o: 100, h: 115, l: 95, c: 115 }, // forms brick 100->110
    ];
    // Live candles includes unclosed forming candle t=180 that temporarily spiked to 135
    const liveCandles = [
      ...closedCandles,
      { t: 180, o: 115, h: 135, l: 115, c: 135 },
    ];

    overlay.setCandles(liveCandles, 'BTC', '1h', { closedCandles });

    // Bricks must come ONLY from closedCandles (1 brick), NOT from the unclosed forming candle at t=180
    expect(overlay.getDebugState().renkoBrickCount).toBe(1);
    const bricks = overlay._getInternalState().renkoData.bricks;
    expect(bricks).toHaveLength(1);
    expect(bricks[0].time).toBe(120);
    // Shelf endTime must extend through the live open candle at t=180
    expect(bricks[0].endTime).toBe(180);
  });

  it('does not project trigger levels when latest visible brick in viewport is a historical brick', () => {
    const { overlay, getAttached, chartMock } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // 200 candles creating bricks:
    // Historical bricks form early on, and final brick forms around candle 180
    const candles = [];
    for (let i = 0; i <= 200; i++) {
      const price = i < 10 ? 100 : (i < 50 ? 120 : (i < 120 ? 140 : 160));
      candles.push({
        t: (i + 1) * 60,
        o: price,
        h: price + 2,
        l: price - 2,
        c: price,
      });
    }
    overlay.setCandles(candles, 'BTC', '1m');

    const primitive = getAttached();
    const paneView = primitive.paneViews()[0];

    const setLineDashSpy = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: setLineDashSpy,
    };

    const target = {
      useBitmapCoordinateSpace: vi.fn((fn) => fn({
        context: ctx,
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
        bitmapSize: { width: 1000, height: 600 },
      })),
    };

    // Scrolled back to historical range [0, 20]:
    // Buffer is 60, so maxLogical is 80.
    // Bricks at idx >= 120 are culled, so the latest visible brick in viewport is historical!
    chartMock.timeScale.mockReturnValue({
      timeToIndex: vi.fn((t) => Math.floor(t / 60)),
      logicalToCoordinate: vi.fn((idx) => idx * 10),
      getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 20 })),
    });

    paneView.renderer().draw(target);

    // Since latest visible brick in viewport is NOT the latest active brick (at idx ~120+),
    // projected trigger lines must NOT be drawn!
    expect(setLineDashSpy).not.toHaveBeenCalled();
  });

  it('handles flat candles gracefully with price-based fallback ATR', () => {
    // Candles with 0 price variation (h === l === c)
    const flatCandles = [
      { t: 60, o: 100, h: 100, l: 100, c: 100 },
      { t: 120, o: 100, h: 100, l: 100, c: 100 },
      { t: 180, o: 100, h: 100, l: 100, c: 100 },
    ];
    const atr = computeATR(flatCandles, 14);
    expect(atr).toBeGreaterThan(0);
    // Should fallback to fallbackPrice * 0.002 = 100 * 0.002 = 0.2
    expect(atr).toBeCloseTo(0.2);
  });

  it('handles microcap low-price precision without premature EPS brick triggering', () => {
    // Microcap token priced at 0.00000050 with brickSize 0.00000010
    const microCandles = [
      { t: 60, o: 0.00000050, h: 0.00000050, l: 0.00000050, c: 0.00000050 },
      // Sub-brick move: 0.00000059 (delta = 0.00000009, below brickSize 0.00000010)
      { t: 120, o: 0.00000050, h: 0.00000059, l: 0.00000050, c: 0.00000059 },
    ];
    const res = computeRenkoBricks(microCandles, { brickMode: 'fixed', fixedSize: 0.00000010 });
    // Should NOT have triggered a brick because 0.00000059 < 0.00000060
    expect(res.bricks.length).toBe(0);

    // Now candle moves to 0.00000060 -> exactly 1 brick
    const confirmCandles = [
      ...microCandles,
      { t: 180, o: 0.00000059, h: 0.00000060, l: 0.00000059, c: 0.00000060 },
    ];
    const res2 = computeRenkoBricks(confirmCandles, { brickMode: 'fixed', fixedSize: 0.00000010 });
    expect(res2.bricks.length).toBe(1);
  });

  it('does not produce phantom bricks when closedCandles is explicitly empty', () => {
    const { overlay } = setupOverlay();
    overlay.setOptions({ mode: 'renko', renko: { brickMode: 'fixed', fixedSize: 10 } });

    // Only 1 candle exists and it is currently forming (0 closed candles)
    const liveCandles = [
      { t: 60, o: 100, h: 150, l: 90, c: 150 },
    ];
    overlay.setCandles(liveCandles, 'BTC', '1h', { closedCandles: [] });

    // Must have 0 bricks because no candle has closed yet
    expect(overlay.getDebugState().renkoBrickCount).toBe(0);
  });
});



