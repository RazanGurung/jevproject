import { describe, expect, it } from 'vitest';

import {
  candleCloseTimeMs,
  currentBucketOpenSeconds,
  mergeCandle,
  mondayUtcWeekStartSeconds,
  normalizeCandleSeries,
  selectClosedCandles,
} from '../market-candles.js';

describe('market candle merge policy', () => {
  it('selects only completed fixed-interval candles without dropping sparse closed tails', () => {
    const now = Date.UTC(2026, 6, 30, 12, 30);
    const old = now - (3 * 60 * 60_000);
    const active = now - (30 * 60_000);
    const candles = [
      { t: old, o: '100', h: '101', l: '99', c: '100', v: '1' },
      { t: active, o: '100', h: '102', l: '99', c: '101', v: '2' },
    ];

    expect(selectClosedCandles(candles, '1h', now)).toEqual([candles[0]]);
    expect(selectClosedCandles([candles[0]], '1h', now)).toEqual([candles[0]]);
  });

  it('prefers explicit exchange close times and handles weekly/monthly boundaries', () => {
    const monthStart = Date.UTC(2026, 6, 1);
    const nextMonth = Date.UTC(2026, 7, 1);
    const weeklyStart = Date.UTC(2026, 6, 27);
    const explicit = { t: monthStart, T: monthStart + 1234 };

    expect(candleCloseTimeMs(explicit, '1M')).toBe(monthStart + 1234);
    expect(candleCloseTimeMs({ t: monthStart }, '1M')).toBe(nextMonth);
    expect(candleCloseTimeMs({ t: weeklyStart }, '1w'))
      .toBe(weeklyStart + 7 * 24 * 60 * 60_000);
    expect(selectClosedCandles([explicit], '1M', monthStart + 1233)).toEqual([]);
    expect(selectClosedCandles([explicit], '1M', monthStart + 1234)).toEqual([explicit]);
  });

  it('opens the current 1M bucket on the UTC month start, not a 30-day unix multiple', () => {
    const midAugust = Date.UTC(2026, 7, 13, 18, 0, 0);
    const augustOpen = Date.UTC(2026, 7, 1) / 1000;
    const thirtyDayUnix = Math.floor((midAugust / 1000) / (30 * 24 * 60 * 60)) * (30 * 24 * 60 * 60);

    expect(currentBucketOpenSeconds('1M', midAugust)).toBe(augustOpen);
    expect(currentBucketOpenSeconds('1M', midAugust)).not.toBe(thirtyDayUnix);
  });

  it('opens the current 1w bucket on Monday 00:00 UTC even on Thursday', () => {
    const thursday = Date.UTC(2026, 7, 13, 18, 0, 0);
    const monday = Date.UTC(2026, 7, 10) / 1000;
    expect(currentBucketOpenSeconds('1w', thursday)).toBe(monday);
    expect(mondayUtcWeekStartSeconds(thursday / 1000)).toBe(monday);
  });

  it('keeps fixed-interval reconnect buckets on unix alignment', () => {
    const now = Date.UTC(2026, 7, 13, 18, 12, 0);
    const fourHours = 4 * 60 * 60;
    expect(currentBucketOpenSeconds('4h', now)).toBe(Math.floor((now / 1000) / fourHours) * fourHours);
  });

  it('normalizes snapshots into one ordered, deduplicated, valid canonical series', () => {
    const normalized = normalizeCandleSeries([
      { t: 2000, o: '101', h: '103', l: '100', c: '102', v: '4' },
      { t: 1000, o: '99', h: '102', l: '98', c: '100', v: '2' },
      { t: 2000, o: '101', h: '104', l: '100', c: '103', v: '5' },
      { t: 3000, o: 'bad', h: '104', l: '100', c: '103', v: '5' },
    ]);

    expect(normalized.map((c) => c.t)).toEqual([1000, 2000]);
    expect(normalized[1].c).toBe('103');
  });

  it('does not truncate deep historical state when a live candle appends', () => {
    const existing = Array.from({ length: 5001 }, (_, index) => ({
      t: 1000 + index * 60,
      o: '100', h: '101', l: '99', c: '100', v: '1',
    }));
    const merged = mergeCandle({
      existing,
      incoming: { t: 1000 + 5001 * 60, o: '100', h: '102', l: '99', c: '101', v: '2' },
    });

    expect(merged).toHaveLength(5002);
    expect(merged[0].t).toBe(existing[0].t);
  });
  it('preserves the exchange open when appending a 1m candle', () => {
    const existing = [
      { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', s: 'BTC', i: '1m' },
    ];

    const merged = mergeCandle({
      existing,
      incoming: { t: 1060, o: '98', h: '102', l: '99', c: '101', v: '12', s: 'BTC', i: '1m' },
    });

    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual(
      expect.objectContaining({
        t: 1060,
        o: '98',
        h: '102',
        l: '99',
        c: '101',
      })
    );
  });

  it('does not expand the exchange range to force visual continuity', () => {
    const merged = mergeCandle({
      existing: [
        { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', s: 'BTC', i: '1m' },
      ],
      incoming: { t: 1060, o: '98', h: '100', l: '99', c: '99.5', v: '12', s: 'BTC', i: '1m' },
    });

    expect(merged[1]).toEqual(
      expect.objectContaining({
        o: '98',
        h: '100',
        l: '99',
      })
    );
  });

  it('keeps the higher-trade same-bucket snapshot', () => {
    const existing = [
      { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', n: 8, s: 'BTC', i: '1m' },
    ];
    const merged = mergeCandle({
      existing,
      incoming: { t: 1000, o: '98', h: '99', l: '97', c: '98.5', v: '4', n: 3, s: 'BTC', i: '1m' },
    });
    expect(merged).toEqual([
      expect.objectContaining({ t: 1000, c: '100.5', n: 8 }),
    ]);
  });

  it('does not rewrite same-bucket 1m updates', () => {
    const existing = [
      { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', s: 'BTC', i: '1m' },
    ];

    const merged = mergeCandle({
      existing,
      incoming: { t: 1000, o: '98', h: '102', l: '97', c: '101', v: '12', s: 'BTC', i: '1m' },
    });

    expect(merged).toEqual([
      expect.objectContaining({ t: 1000, o: '98', c: '101' }),
    ]);
  });

  it('preserves the complete Hyperliquid candle payload on append', () => {
    const incoming = {
      t: 1060,
      T: 1119,
      s: 'BTC',
      i: '1m',
      o: '100.5',
      c: '101.25',
      h: '102',
      l: '100',
      v: '12.75',
      n: 42,
    };

    const merged = mergeCandle({
      existing: [{ t: 1000, T: 1059, s: 'BTC', i: '1m', o: '99', c: '100.5', h: '101', l: '98', v: '10', n: 30 }],
      incoming,
    });

    expect(merged[1]).toEqual(incoming);
    expect(merged[1]).not.toBe(incoming);
  });

  it('does not rewrite non-1m candles', () => {
    const merged = mergeCandle({
      existing: [
        { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', s: 'BTC', i: '5m' },
      ],
      incoming: { t: 1300, o: '98', h: '102', l: '99', c: '101', v: '12', s: 'BTC', i: '5m' },
    });

    expect(merged[1]).toEqual(
      expect.objectContaining({
        t: 1300,
        o: '98',
      })
    );
  });

  it('carries the enriched cvdDelta on same-bucket updates', () => {
    const existing = [
      { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', s: 'BTC', i: '4h', cvdDelta: 42 },
    ];

    const merged = mergeCandle({
      existing,
      incoming: { t: 1000, o: '98', h: '102', l: '97', c: '101', v: '12', s: 'BTC', i: '4h', cvdDelta: 55 },
    });

    expect(merged[0].cvdDelta).toBe(55);
  });

  it('preserves the last known cvdDelta when a bare tick replaces the bucket', () => {
    const existing = [
      { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', s: 'BTC', i: '4h', cvdDelta: 42 },
    ];

    const merged = mergeCandle({
      existing,
      incoming: { t: 1000, o: '98', h: '102', l: '97', c: '101', v: '12', s: 'BTC', i: '4h' },
    });

    expect(merged[0].cvdDelta).toBe(42);
  });

  it('drops out-of-order incoming candles', () => {
    const existing = [
      { t: 1000, o: '98', h: '101', l: '97', c: '100.5', v: '10', s: 'BTC', i: '1m' },
      { t: 1060, o: '100.5', h: '102', l: '99', c: '101', v: '12', s: 'BTC', i: '1m' },
    ];

    const merged = mergeCandle({
      existing,
      incoming: { t: 1000, o: '98', h: '99', l: '95', c: '96', v: '5', s: 'BTC', i: '1m' },
    });

    expect(merged).toBe(existing);
  });
});
