import { describe, expect, it } from 'vitest';

import {
  bucketEndMs,
  bucketStartMs,
  createLiveCandleProjectionController,
} from '../live-candle-projection.js';

describe('live forming candle projection', () => {
  const currentStart = Date.UTC(2026, 6, 18, 12, 0, 0);
  const candles = [
    { t: currentStart - 60_000, T: currentStart - 1, o: '99', h: '102', l: '98', c: '100', v: '8' },
    { t: currentStart, T: currentStart + 59_999, o: '100.5', h: '103', l: '99.5', c: '102', v: '4' },
  ];

  it('fixes open to the previous close and follows price while retaining wick extrema', () => {
    const controller = createLiveCandleProjectionController();

    expect(controller.project({ candles, coin: 'BTC', timeframe: '1m', price: 104, now: currentStart + 10_000 })).toEqual({
      t: currentStart,
      o: 100,
      h: 104,
      l: 99.5,
      c: 104,
      v: '4',
    });
    expect(controller.project({ candles, coin: 'BTC', timeframe: '1m', price: 98, now: currentStart + 20_000 })).toEqual({
      t: currentStart,
      o: 100,
      h: 104,
      l: 98,
      c: 98,
      v: '4',
    });
    expect(controller.project({ candles, coin: 'BTC', timeframe: '1m', price: 101, now: currentStart + 30_000 })).toEqual({
      t: currentStart,
      o: 100,
      h: 104,
      l: 98,
      c: 101,
      v: '4',
    });
  });

  it('opens a missing next bucket from the last canonical close without mutating canonical data', () => {
    const controller = createLiveCandleProjectionController();
    const before = structuredClone(candles);
    const projected = controller.project({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      price: 101.5,
      now: currentStart + 65_000,
    });

    expect(projected).toEqual({
      t: currentStart + 60_000,
      o: 102,
      h: 102,
      l: 101.5,
      c: 101.5,
      v: 0,
    });
    expect(candles).toEqual(before);
  });

  it('resets projection ownership across coin changes and rejects invalid prices', () => {
    const controller = createLiveCandleProjectionController();
    expect(controller.project({ candles, coin: 'BTC', timeframe: '1m', price: 104, now: currentStart + 10_000 })).not.toBeNull();
    expect(controller.project({ candles, coin: 'BTC', timeframe: '1m', price: 0, now: currentStart + 20_000 })).toBeNull();
    expect(controller.project({ candles, coin: 'ETH', timeframe: '1m', price: 200, now: currentStart + 20_000 })).toEqual(
      expect.objectContaining({ o: 100, h: 200, l: 99.5, c: 200 }),
    );
    expect(controller.getDebugState()).toEqual(expect.objectContaining({
      projectedCandleKey: 'ETH:1m',
      projectedCandleUpdateCount: 2,
    }));
    controller.reset();
    expect(controller.getDebugState().projectedCandleActive).toBe(false);
  });

  it('uses Monday UTC weekly boundaries and real calendar-month boundaries', () => {
    const saturday = Date.UTC(2026, 6, 18, 12);
    expect(new Date(bucketStartMs(saturday, '1w')).toISOString()).toBe('2026-07-13T00:00:00.000Z');
    expect(new Date(bucketEndMs(bucketStartMs(saturday, '1w'), '1w')).toISOString()).toBe('2026-07-19T23:59:59.999Z');

    const february = Date.UTC(2028, 1, 15, 12);
    const monthStart = bucketStartMs(february, '1M');
    expect(new Date(monthStart).toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(new Date(bucketEndMs(monthStart, '1M')).toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });
});
