import { describe, expect, it, vi } from 'vitest';

import { createChartHistoryLoader } from '../chart-history-loader.js';

describe('chart history loader', () => {
  it('clears history state', () => {
    const onClearHistoryState = vi.fn();
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      onClearHistoryState,
    });

    loader.clearHistoryLoadState('BTC', '4h');

    expect(onClearHistoryState).toHaveBeenCalledTimes(1);
  });

  it('uses the series bars-before count instead of raw logical coordinates', async () => {
    const fetchHistoricalCandles = vi.fn(async () => []);
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => [{ t: 300, c: '3' }],
      fetchHistoricalCandles,
      historyPreloadThresholdBars: 200,
    });

    await loader.ensureHistoricalCandles({ from: 500, to: 550, barsBefore: 25 });

    expect(fetchHistoricalCandles).toHaveBeenCalledTimes(1);
  });

  it('prepends unique older candles, updates cache, and shifts the visible window', async () => {
    const candleCache = new Map();
    const evictCandleCache = vi.fn();
    const scheduleChartRender = vi.fn();
    const setViewStart = vi.fn();
    const requestVisibleLogicalRange = vi.fn();
    const candlesRef = {
      value: [
        { t: 300, c: '3' },
        { t: 400, c: '4' },
      ],
    };

    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => candlesRef.value,
      setCandles: (candles) => {
        candlesRef.value = candles;
      },
      fetchHistoricalCandles: vi.fn(async () => [
        { t: 100, c: '1' },
        { t: 200, c: '2' },
        { t: 300, c: 'duplicate-newest' },
      ]),
      candleCache,
      evictCandleCache,
      getViewStart: () => 25,
      setViewStart,
      getViewCount: () => 40,
      requestVisibleLogicalRange,
      scheduleChartRender,
    });

    await loader.ensureHistoricalCandles({ from: 10, to: 50 });
    await Promise.resolve();

    expect(candlesRef.value).toEqual([
      { t: 100, c: '1' },
      { t: 200, c: '2' },
      { t: 300, c: '3' },
      { t: 400, c: '4' },
    ]);
    expect(candleCache.get('BTC:4h')).toEqual(candlesRef.value);
    expect(evictCandleCache).toHaveBeenCalledTimes(1);
    expect(setViewStart).toHaveBeenCalledWith(27);
    // Two older bars prepended → logical range shifts by +2 so LC viewport stays put.
    expect(requestVisibleLogicalRange).toHaveBeenCalledWith({ from: 27, to: 66 });
    expect(scheduleChartRender).toHaveBeenCalledTimes(1);
  });

  it('shifts the live fractional logical range when prepending history', async () => {
    const requestVisibleLogicalRange = vi.fn();
    const setViewStart = vi.fn();
    const candlesRef = {
      value: [
        { t: 300, c: '3' },
        { t: 400, c: '4' },
      ],
    };

    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => candlesRef.value,
      setCandles: (candles) => {
        candlesRef.value = candles;
      },
      fetchHistoricalCandles: vi.fn(async () => [
        { t: 100, c: '1' },
        { t: 200, c: '2' },
      ]),
      getVisibleLogicalRange: () => ({ from: 10.25, to: 50.75 }),
      getViewStart: () => 10,
      setViewStart,
      getViewCount: () => 41,
      requestVisibleLogicalRange,
    });

    await loader.ensureHistoricalCandles({ from: 10.25, to: 50.75, barsBefore: 10 });
    await Promise.resolve();

    expect(requestVisibleLogicalRange).toHaveBeenCalledWith({ from: 12.25, to: 52.75 });
    expect(setViewStart).toHaveBeenCalledWith(12);
  });

  it('keeps walking older history after a successful prepend', async () => {
    const candlesRef = { value: [{ t: 400, c: '4' }] };
    const fetchHistoricalCandles = vi.fn(async ({ endTime }) => {
      if (endTime === 399) return [{ t: 200, c: '2' }];
      if (endTime === 199) return [{ t: 100, c: '1' }];
      return [];
    });
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '2h',
      getCandles: () => candlesRef.value,
      setCandles: (candles) => {
        candlesRef.value = candles;
      },
      fetchHistoricalCandles,
    });

    await loader.ensureHistoricalCandles({ from: 0, to: 10, barsBefore: 0 });
    await vi.waitFor(() => {
      expect(fetchHistoricalCandles).toHaveBeenCalledTimes(3);
    });
    expect(candlesRef.value.map((row) => row.t)).toEqual([100, 200, 400]);
  });

  it('marks history complete when no older candles are returned', async () => {
    const fetchHistoricalCandles = vi.fn(async () => []);
    const scheduleChartRender = vi.fn();
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => [{ t: 300, c: '3' }],
      fetchHistoricalCandles,
      scheduleChartRender,
    });

    await loader.ensureHistoricalCandles({ from: 10, to: 50 });
    await loader.ensureHistoricalCandles({ from: 10, to: 50 });

    expect(fetchHistoricalCandles).toHaveBeenCalledTimes(1);
    expect(scheduleChartRender).not.toHaveBeenCalled();
  });

  it('does not fetch older history when the in-memory cap is already full', async () => {
    const fetchHistoricalCandles = vi.fn(async () => [{ t: 50 }]);
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => [
        { t: 100, c: '1' },
        { t: 200, c: '2' },
        { t: 300, c: '3' },
      ],
      fetchHistoricalCandles,
      maxLoadedCandles: 3,
    });

    await loader.ensureHistoricalCandles({ barsBefore: 0 });
    await loader.ensureHistoricalCandles({ barsBefore: 0 });

    expect(fetchHistoricalCandles).not.toHaveBeenCalled();
  });

  it('marks history complete when an older chunk cannot be retained under the cap', async () => {
    const setCandles = vi.fn();
    const candlesRef = {
      value: [
        { t: 100, c: '1' },
        { t: 200, c: '2' },
      ],
    };
    const fetchHistoricalCandles = vi.fn(async () => {
      candlesRef.value = [
        { t: 100, c: '1' },
        { t: 200, c: '2' },
        { t: 300, c: '3' },
      ];
      return [{ t: 50, c: '0' }];
    });
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => candlesRef.value,
      setCandles,
      fetchHistoricalCandles,
      maxLoadedCandles: 3,
    });

    await loader.ensureHistoricalCandles({ barsBefore: 0 });
    await loader.ensureHistoricalCandles({ barsBefore: 0 });

    expect(fetchHistoricalCandles).toHaveBeenCalledTimes(1);
    expect(setCandles).not.toHaveBeenCalled();
  });

  it('keeps history retryable when the older-candle request fails', async () => {
    const fetchHistoricalCandles = vi.fn(async () => null);
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => [{ t: 300, c: '3' }],
      fetchHistoricalCandles,
    });

    await loader.ensureHistoricalCandles({ from: 10, to: 50 });
    await loader.ensureHistoricalCandles({ from: 10, to: 50 });

    expect(fetchHistoricalCandles).toHaveBeenCalledTimes(2);
  });

  it('drops a late history response after the chart selection changes', async () => {
    let resolveHistory;
    let coin = 'BTC';
    const setCandles = vi.fn();
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => coin,
      getCurrentTimeframe: () => '4h',
      getCandles: () => [{ t: 300, c: '3' }],
      setCandles,
      fetchHistoricalCandles: vi.fn(() => new Promise((resolve) => { resolveHistory = resolve; })),
    });

    const pending = loader.ensureHistoricalCandles({ from: 10, to: 50 });
    coin = 'ETH';
    loader.clearHistoryLoadState('ETH', '4h');
    resolveHistory([{ t: 200, c: '2' }]);
    await pending;

    expect(setCandles).not.toHaveBeenCalled();
  });

  it('calls setCandleCacheEntry to preserve LRU ordering on history prepend', async () => {
    const setCandleCacheEntry = vi.fn();
    const loader = createChartHistoryLoader({
      getCurrentCoin: () => 'BTC',
      getCurrentTimeframe: () => '4h',
      getCandles: () => [{ t: 300, c: '3' }],
      fetchHistoricalCandles: vi.fn(async () => [{ t: 100, c: '1' }]),
      setCandleCacheEntry,
    });

    await loader.ensureHistoricalCandles({ from: 10, to: 50 });
    await Promise.resolve();

    expect(setCandleCacheEntry).toHaveBeenCalledWith('BTC:4h', [
      { t: 100, c: '1' },
      { t: 300, c: '3' },
    ]);
  });
});
