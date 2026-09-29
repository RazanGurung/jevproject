/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_VWAP_PERIODS,
  computeSessionVwaps,
  createSessionVwapOverlay,
  isSessionPeriodSupported,
  timeframeToMinutes,
} from '../session-vwap.js';

const HOUR = 3600;
const DAY = 86400;

// 2024-01-01T00:00:00Z (Monday)
const JAN_1 = Date.UTC(2024, 0, 1) / 1000;
// 2024-01-02T00:00:00Z (Tuesday)
const JAN_2 = Date.UTC(2024, 0, 2) / 1000;
// 2024-01-08T00:00:00Z (Next Monday)
const JAN_8 = Date.UTC(2024, 0, 8) / 1000;
// 2024-02-01T00:00:00Z (February 1)
const FEB_1 = Date.UTC(2024, 1, 1) / 1000;

function makeCandles({ startSec, count, intervalSec = HOUR, price = 100, vol = 10, step = 0 }) {
  const candles = [];
  let cursor = startSec;
  for (let i = 0; i < count; i += 1) {
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

describe('timeframeToMinutes and isSessionPeriodSupported', () => {
  it('converts common timeframe strings to minutes', () => {
    expect(timeframeToMinutes('1m')).toBe(1);
    expect(timeframeToMinutes('5m')).toBe(5);
    expect(timeframeToMinutes('1h')).toBe(60);
    expect(timeframeToMinutes('4h')).toBe(240);
    expect(timeframeToMinutes('1d')).toBe(1440);
    expect(timeframeToMinutes('1w')).toBe(10080);
    expect(timeframeToMinutes('1M')).toBe(43200);
  });

  it('correctly filters supported periods per timeframe', () => {
    // Intraday: daily, weekly, monthly all supported
    expect(isSessionPeriodSupported('daily', '1h')).toBe(true);
    expect(isSessionPeriodSupported('weekly', '1h')).toBe(true);
    expect(isSessionPeriodSupported('monthly', '1h')).toBe(true);

    // 1d: daily not supported (< 1440 min), weekly and monthly are supported
    expect(isSessionPeriodSupported('daily', '1d')).toBe(false);
    expect(isSessionPeriodSupported('weekly', '1d')).toBe(true);
    expect(isSessionPeriodSupported('monthly', '1d')).toBe(true);

    // 1w: daily and weekly not supported, monthly is supported
    expect(isSessionPeriodSupported('daily', '1w')).toBe(false);
    expect(isSessionPeriodSupported('weekly', '1w')).toBe(false);
    expect(isSessionPeriodSupported('monthly', '1w')).toBe(true);

    // 1M: none supported
    expect(isSessionPeriodSupported('daily', '1M')).toBe(false);
    expect(isSessionPeriodSupported('weekly', '1M')).toBe(false);
    expect(isSessionPeriodSupported('monthly', '1M')).toBe(false);
  });
});

describe('computeSessionVwaps', () => {
  it('splits bars into daily sessions and computes accurate cumulative VWAP', () => {
    // Day 1 (Jan 1): 2 bars. Bar 0: H=101, L=99, C=100 (HLC3=100), V=10.
    //               Bar 1: H=103, L=101, C=102 (HLC3=102), V=10.
    // Day 2 (Jan 2): 2 bars. Bar 0: H=201, L=199, C=200 (HLC3=200), V=5.
    const candles = [
      { t: JAN_1, o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: JAN_1 + HOUR, o: '102', h: '103', l: '101', c: '102', v: '10' },
      { t: JAN_2, o: '200', h: '201', l: '199', c: '200', v: '5' },
      { t: JAN_2 + HOUR, o: '204', h: '205', l: '203', c: '204', v: '5' },
    ];

    const result = computeSessionVwaps(candles, '1h', { daily: true });
    expect(result.daily).toHaveLength(2);

    const day1 = result.daily[0];
    expect(day1.startTime).toBe(JAN_1);
    expect(day1.endTime).toBe(JAN_1 + HOUR);
    expect(day1.points).toHaveLength(2);
    // Bar 0: vwap = 100
    expect(day1.points[0].vwap).toBe(100);
    // Bar 1: sumVol = 20, sumVP = 10*100 + 10*102 = 2020 -> vwap = 101
    expect(day1.points[1].vwap).toBe(101);
    expect(day1.closeVwap).toBe(101);
    expect(day1.priorVwap).toBeNull();

    const day2 = result.daily[1];
    expect(day2.startTime).toBe(JAN_2);
    expect(day2.endTime).toBe(JAN_2 + HOUR);
    expect(day2.points).toHaveLength(2);
    // Bar 0: vwap = 200
    expect(day2.points[0].vwap).toBe(200);
    // Bar 1: sumVol = 10, sumVP = 5*200 + 5*204 = 2020 -> vwap = 202
    expect(day2.points[1].vwap).toBe(202);
    expect(day2.closeVwap).toBe(202);
    // Day 2 correctly inherits Day 1 closeVwap as priorVwap!
    expect(day2.priorVwap).toBe(101);
  });

  it('splits bars into weekly sessions resetting at Monday 00:00 UTC', () => {
    const candles = [
      ...makeCandles({ startSec: JAN_1, count: 5, intervalSec: DAY, price: 100 }),
      ...makeCandles({ startSec: JAN_8, count: 3, intervalSec: DAY, price: 150 }),
    ];

    const result = computeSessionVwaps(candles, '1d', { weekly: true });
    expect(result.weekly).toHaveLength(2);
    expect(result.weekly[0].sessionStart).toBe(JAN_1);
    expect(result.weekly[1].sessionStart).toBe(JAN_8);
    expect(result.weekly[1].priorVwap).toBeCloseTo(result.weekly[0].closeVwap, 4);
  });

  it('splits bars into monthly sessions resetting at 1st of month 00:00 UTC', () => {
    const candles = [
      ...makeCandles({ startSec: JAN_1, count: 10, intervalSec: DAY, price: 100 }),
      ...makeCandles({ startSec: FEB_1, count: 5, intervalSec: DAY, price: 120 }),
    ];

    const result = computeSessionVwaps(candles, '1d', { monthly: true });
    expect(result.monthly).toHaveLength(2);
    expect(result.monthly[0].sessionStart).toBe(JAN_1);
    expect(result.monthly[1].sessionStart).toBe(FEB_1);
    expect(result.monthly[1].priorVwap).toBeCloseTo(result.monthly[0].closeVwap, 4);
  });

  it('retains up to maxSessions and derives priorVwap from older preceding session if available', () => {
    const candles = [];
    for (let day = 0; day < 6; day += 1) {
      candles.push(...makeCandles({ startSec: JAN_1 + day * DAY, count: 4, intervalSec: HOUR, price: 100 + day * 10 }));
    }
    // MAX_SESSIONS_BY_PERIOD.daily is 4. So 6 days -> keep last 4 days (days 2, 3, 4, 5)
    const result = computeSessionVwaps(candles, '1h', { daily: true });
    expect(result.daily).toHaveLength(4);
    // Oldest kept is day 2. Preceding was day 1 (price 110, HLC3 110).
    expect(result.daily[0].startTime).toBe(JAN_1 + 2 * DAY);
    expect(result.daily[0].priorVwap).toBeCloseTo(110, 1);
  });

  it('returns empty lists when options are disabled or inputs empty', () => {
    expect(computeSessionVwaps([], '1h', { daily: true })).toEqual({ daily: [], weekly: [], monthly: [] });
    const candles = makeCandles({ startSec: JAN_1, count: 5 });
    expect(computeSessionVwaps(candles, '1h', {})).toEqual({ daily: [], weekly: [], monthly: [] });
  });
});

describe('createSessionVwapOverlay', () => {
  it('attaches and detaches primitive cleanly', () => {
    let attachedPrimitive = null;
    const seriesMock = {
      attachPrimitive: vi.fn((prim) => { attachedPrimitive = prim; }),
      detachPrimitive: vi.fn((prim) => { if (attachedPrimitive === prim) attachedPrimitive = null; }),
      priceToCoordinate: vi.fn((price) => price),
    };
    const chartMock = {
      timeScale: () => ({
        timeToIndex: vi.fn((t) => t),
        logicalToCoordinate: vi.fn((idx) => idx),
      }),
    };

    const overlay = createSessionVwapOverlay({
      getChart: () => chartMock,
      getCandleSeries: () => seriesMock,
    });

    const candles = [
      ...makeCandles({ startSec: JAN_1, count: 4, intervalSec: HOUR, price: 100 }),
      ...makeCandles({ startSec: JAN_2, count: 4, intervalSec: HOUR, price: 110 }),
    ];

    // Off by default -> does not attach
    overlay.setCandles(candles, 'BTC', '1h', 1);
    expect(seriesMock.attachPrimitive).not.toHaveBeenCalled();

    // Turn daily on
    overlay.setOptions({ daily: true });
    overlay.setCandles(candles, 'BTC', '1h', 2);
    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(attachedPrimitive).not.toBeNull();

    // Check debug state
    const debug = overlay.getDebugState();
    expect(debug.dailyCount).toBe(2);
    expect(debug.options.daily).toBe(true);

    // Call draw through paneViews
    const paneView = attachedPrimitive.paneViews()[0];
    expect(paneView.zOrder()).toBe('bottom');

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
    };
    const target = {
      useBitmapCoordinateSpace: vi.fn((fn) => fn({ context: ctx, horizontalPixelRatio: 1, verticalPixelRatio: 1 })),
    };
    paneView.renderer().draw(target);
    expect(target.useBitmapCoordinateSpace).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();

    // Detach
    overlay.detach();
    expect(seriesMock.detachPrimitive).toHaveBeenCalled();
  });

  it('reads dynamic colors from color palette and updates on applyTheme', async () => {
    const { getSessionColors } = await import('../session-vwap.js');
    const { resetColorPalette, setPaletteColor } = await import('../../services/color-palette.js');

    resetColorPalette();
    expect(getSessionColors().daily).toBe('#22cce6');
    expect(getSessionColors().weekly).toBe('#4a9eff');
    expect(getSessionColors().monthly).toBe('#a78bfa');

    setPaletteColor('sessionDaily', '#ffaa00');
    setPaletteColor('sessionWeekly', '#00ffaa');
    setPaletteColor('sessionMonthly', '#ee00ff');

    expect(getSessionColors().daily).toBe('#ffaa00');
    expect(getSessionColors().weekly).toBe('#00ffaa');
    expect(getSessionColors().monthly).toBe('#ee00ff');

    resetColorPalette();
  });
});
