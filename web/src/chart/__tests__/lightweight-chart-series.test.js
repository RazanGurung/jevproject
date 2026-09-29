import { describe, expect, it, vi } from 'vitest';

import { createSeriesSyncController } from '../lightweight-chart-series.js';

describe('lightweight chart series sync controller', () => {
  it('normalizes second timestamps as-is and millisecond timestamps as unix seconds', () => {
    const candleUpdate = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });

    // First sync to establish metadata
    controller.syncSeries({
      candles: [
        { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    // Now update with a second-timestamp candle
    controller.updateSeries({
      candle: { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      candles: [
        { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(candleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ time: 1713300000 })
    );

    // Reset and test with millisecond timestamp
    lastSeriesMeta = null;
    lastDataSignature = '';
    candleUpdate.mockClear();

    controller.syncSeries({
      candles: [
        { t: 1713299940000, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    controller.updateSeries({
      candle: { t: 1713300000000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      candles: [
        { t: 1713299940000, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(candleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ time: 1713300000 })
    );

    lastSeriesMeta = null;
    lastDataSignature = '';
    candleUpdate.mockClear();
    const setData = vi.fn();
    const msThresholdController = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });
    msThresholdController.syncSeries({
      candles: [{ t: 100_000_000_000, o: '1', h: '2', l: '0', c: '1', v: '1' }],
      timeframe: '1m',
      coin: 'BTC',
    });
    expect(setData).toHaveBeenCalledWith([
      expect.objectContaining({ time: 100_000_000 }),
    ]);
  });

  it('skips update when the incoming candle time is older than the last known candle', () => {
    const candleUpdate = vi.fn();
    let lastSeriesMeta = { length: 2, firstTime: 1713299940, lastTime: 1713300000, coin: 'BTC', timeframe: '1m' };

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => '',
      setLastDataSignature: () => {},
      applyThemeIfNeeded: () => {},
    });

    const result = controller.updateSeries({
      candle: { t: 1713299940, o: '100', h: '101', l: '99', c: '100', v: '10' },
      candles: [
        { t: 1713299940, o: '100', h: '101', l: '99', c: '100', v: '10' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(result).toBe(false);
    expect(candleUpdate).not.toHaveBeenCalled();
  });

  it('recovers a Value is null update by rebuilding canonical setData', () => {
    const candleUpdate = vi.fn(() => {
      throw new Error('Value is null');
    });
    const candleSetData = vi.fn();
    const clearCrosshair = vi.fn();
    let lastSeriesMeta = {
      length: 2,
      firstTime: 1713299940,
      lastTime: 1713300000,
      coin: 'BTC',
      timeframe: '1m',
    };
    let lastDataSignature = '';
    const candles = [
      { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
      { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    ];

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
      clearCrosshair,
    });

    const result = controller.updateSeries({
      candle: candles[1],
      candles,
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(result).toBe(true);
    expect(candleUpdate).toHaveBeenCalledOnce();
    expect(candleSetData).toHaveBeenCalledWith([
      expect.objectContaining({ time: 1713299940, close: 100 }),
      expect.objectContaining({ time: 1713300000, close: 100.5 }),
    ]);
    expect(clearCrosshair).toHaveBeenCalled();
    expect(controller.getDebugState().rejectedUpdateCount).toBe(0);
    expect(controller.getDebugState().setDataCount).toBe(1);
  });

  it('does not clear the crosshair on normal candle updates, preserving labels when mouse stops', () => {
    const candleUpdate = vi.fn();
    const clearCrosshair = vi.fn();
    let lastSeriesMeta = {
      length: 2,
      firstTime: 1713299940,
      lastTime: 1713300000,
      coin: 'BTC',
      timeframe: '1m',
    };
    const candles = [
      { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
      { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    ];

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => '',
      setLastDataSignature: () => {},
      applyThemeIfNeeded: () => {},
      clearCrosshair,
    });

    const result = controller.updateSeries({
      candle: candles[1],
      candles,
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(result).toBe(true);
    expect(candleUpdate).toHaveBeenCalledOnce();
    expect(clearCrosshair).not.toHaveBeenCalled();
  });

  it('renders ordered candles across gaps while recovery runs independently', () => {
    const candleUpdate = vi.fn();
    let lastSeriesMeta = { length: 2, firstTime: 1713299940, lastTime: 1713300000, coin: 'BTC', timeframe: '1m' };

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => '',
      setLastDataSignature: () => {},
      applyThemeIfNeeded: () => {},
    });

    // 3 minutes later — gap > 2.5× the 1m interval
    const result = controller.updateSeries({
      candle: { t: 1713300180, o: '100', h: '101', l: '99', c: '100', v: '10' },
      candles: [
        { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
        { t: 1713300180, o: '100', h: '101', l: '99', c: '100', v: '10' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(result).toBe(true);
    expect(candleUpdate).toHaveBeenCalledWith(expect.objectContaining({ time: 1713300180 }));
  });

  it('rejects live updates whose coin or timeframe does not match the mounted series', () => {
    const candleUpdate = vi.fn();
    let lastSeriesMeta = { length: 2, firstTime: 1713299940, lastTime: 1713300000, coin: 'BTC', timeframe: '1m' };

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => '',
      setLastDataSignature: () => {},
      applyThemeIfNeeded: () => {},
    });

    expect(controller.updateSeries({
      candle: { t: 1713300060, o: '100', h: '101', l: '99', c: '100', v: '10' },
      candles: [{ t: 1713300060, o: '100', h: '101', l: '99', c: '100', v: '10' }],
      timeframe: '1m',
      coin: 'ETH',
    })).toBe(false);
    expect(controller.updateSeries({
      candle: { t: 1713300060, o: '100', h: '101', l: '99', c: '100', v: '10' },
      candles: [{ t: 1713300060, o: '100', h: '101', l: '99', c: '100', v: '10' }],
      timeframe: '1h',
      coin: 'BTC',
    })).toBe(false);
    expect(candleUpdate).not.toHaveBeenCalled();
  });

  it('forces a full reload when the coin changes even if candle span metadata matches', () => {
    const candleSetData = vi.fn();
    const candleUpdate = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });

    const btcCandles = [
      { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
      { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    ];
    const ethCandles = [
      { t: 1713299940, o: '199', h: '200', l: '198', c: '200', v: '9' },
      { t: 1713300000, o: '200', h: '201', l: '199', c: '200.5', v: '10' },
    ];

    controller.syncSeries({ candles: btcCandles, timeframe: '1m', coin: 'BTC' });
    expect(candleSetData).toHaveBeenCalledTimes(1);

    controller.syncSeries({ candles: ethCandles, timeframe: '1m', coin: 'ETH' });

    expect(candleSetData).toHaveBeenCalledTimes(2);
    expect(candleUpdate).not.toHaveBeenCalled();
    expect(lastDataSignature).toBe('ETH:1m:2:1713299940:1713300000:200:201:199:200.5:10');
  });

  it('clears the candle series explicitly when the chart enters an empty loading state', () => {
    const candleSetData = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: vi.fn(), setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });

    controller.syncSeries({
      candles: [
        { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    controller.syncSeries({
      candles: [],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(candleSetData).toHaveBeenLastCalledWith([]);
    expect(lastSeriesMeta).toEqual(
      expect.objectContaining({
        coin: 'BTC',
        timeframe: '1m',
        length: 0,
      })
    );
    expect(lastDataSignature).toBe('BTC:1m:0:::::::');
  });

  it('skips syncSeries when the data signature matches (dedup)', () => {
    const candleSetData = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: vi.fn(), setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });

    const candles = [
      { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
      { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    ];

    controller.syncSeries({ candles, timeframe: '1m', coin: 'BTC' });
    expect(candleSetData).toHaveBeenCalledTimes(1);

    // Same data again — should be deduped
    controller.syncSeries({ candles, timeframe: '1m', coin: 'BTC' });
    expect(candleSetData).toHaveBeenCalledTimes(1);
  });

  it('forces a full sync for an authoritative snapshot revision with the same candle span', () => {
    const candleSetData = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';
    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: vi.fn(), setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });
    const candles = [
      { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
      { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    ];

    controller.syncSeries({ candles, timeframe: '1m', coin: 'BTC' });
    controller.syncSeries({ candles, timeframe: '1m', coin: 'BTC', force: true });

    expect(candleSetData).toHaveBeenCalledTimes(2);
  });

  it('applies updateSeries for a same-timestamp live tick (replaces last bar)', () => {
    const candleUpdate = vi.fn();
    let lastSeriesMeta = { length: 2, firstTime: 1713299940, lastTime: 1713300000, coin: 'BTC', timeframe: '1m' };
    let lastDataSignature = 'BTC:1m:2:1713299940:1713300000:100.5:10';

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });

    const result = controller.updateSeries({
      candle: { t: 1713300000, o: '100', h: '102', l: '99', c: '101', v: '12' },
      candles: [
        { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000, o: '100', h: '102', l: '99', c: '101', v: '12' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(result).toBe(true);
    expect(candleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        time: 1713300000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
      })
    );
  });

  it('applies updateSeries for a new candle (appends new bar)', () => {
    const candleUpdate = vi.fn();
    let lastSeriesMeta = { length: 2, firstTime: 1713299940, lastTime: 1713300000, coin: 'BTC', timeframe: '1m' };
    let lastDataSignature = 'BTC:1m:2:1713299940:1713300000:100.5:10';

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });

    const result = controller.updateSeries({
      candle: { t: 1713300060, o: '101', h: '103', l: '100', c: '102', v: '15' },
      candles: [
        { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
        { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
        { t: 1713300060, o: '101', h: '103', l: '100', c: '102', v: '15' },
      ],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(result).toBe(true);
    expect(candleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        time: 1713300060,
        open: 101,
        high: 103,
        low: 100,
        close: 102,
      })
    );
  });

  it('reconciles the final canonical revision behind an already projected next bucket', () => {
    const candleUpdate = vi.fn((_bar, historicalUpdate) => {
      if (historicalUpdate === true) {
        throw new Error('Historical updates are not supported when conflation is enabled.');
      }
    });
    const candleSetData = vi.fn();
    const setVisibleLogicalRange = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';
    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
      getTimeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 12.4, to: 80.1 }),
        setVisibleLogicalRange,
      }),
    });
    const canonical = [{ t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' }];
    controller.syncSeries({ candles: canonical, timeframe: '1m', coin: 'BTC' });
    controller.updateSeries({
      candle: { t: 1713300060, o: '100.5', h: '102', l: '100.5', c: '102', v: 0 },
      candles: canonical,
      timeframe: '1m',
      coin: 'BTC',
      updateKind: 'projection',
      preserveCanonicalMeta: true,
    });

    const applied = controller.updateSeries({
      candle: { ...canonical[0], h: '103', c: '102.5', v: '12' },
      candles: [{ ...canonical[0], h: '103', c: '102.5', v: '12' }],
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(applied).toBe(true);
    expect(candleUpdate).toHaveBeenCalledTimes(1);
    expect(candleUpdate).not.toHaveBeenCalledWith(expect.anything(), true);
    expect(candleSetData).toHaveBeenCalledTimes(2);
    expect(candleSetData).toHaveBeenLastCalledWith(
      [expect.objectContaining({ time: 1713300000, high: 103, close: 102.5 })],
    );
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 12.4, to: 80.1 });
    const reprojected = controller.updateSeries({
      candle: { t: 1713300060, o: '102.5', h: '104', l: '102', c: '103', v: 0 },
      candles: [{ ...canonical[0], h: '103', c: '102.5', v: '12' }],
      timeframe: '1m',
      coin: 'BTC',
      updateKind: 'projection',
      preserveCanonicalMeta: true,
    });
    expect(reprojected).toBe(true);
    expect(candleUpdate).toHaveBeenCalledTimes(2);
    expect(candleUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 1713300060, open: 102.5, close: 103 }),
    );
    expect(controller.getDebugState()).toEqual({
      setDataCount: 2,
      updateCount: 2,
      authoritativeUpdateCount: 1,
      projectedUpdateCount: 2,
      reconciliationSetDataCount: 1,
      headEvictionSetDataCount: 0,
      rejectedUpdateCount: 0,
    });
  });

  it('restores the visible logical range after a forced setData rebuild', () => {
    const candleSetData = vi.fn();
    const setVisibleLogicalRange = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';
    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: vi.fn(), setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
      getTimeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 12.4, to: 80.1 }),
        setVisibleLogicalRange,
      }),
    });
    const candles = [
      { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
      { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    ];
    const repaired = [
      candles[0],
      { ...candles[1], h: '104', c: '100.5', v: '10' },
    ];

    controller.syncSeries({ candles, timeframe: '1m', coin: 'BTC' });
    controller.syncSeries({ candles: repaired, timeframe: '1m', coin: 'BTC', force: true });

    expect(candleSetData).toHaveBeenCalledTimes(2);
    expect(setVisibleLogicalRange).toHaveBeenCalledTimes(2);
    expect(setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 12.4, to: 80.1 });
  });

  it('rebuilds via setData and shifts the visible range when a live append evicts the series head', () => {
    const candleUpdate = vi.fn();
    const candleSetData = vi.fn();
    const setVisibleLogicalRange = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';
    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
      getTimeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 10.5, to: 40.25 }),
        setVisibleLogicalRange,
      }),
    });
    const first = [
      { t: 1000, o: '1', h: '2', l: '1', c: '1.5', v: '1' },
      { t: 1060, o: '1', h: '2', l: '1', c: '1.5', v: '1' },
      { t: 1120, o: '1', h: '2', l: '1', c: '1.5', v: '1' },
    ];
    controller.syncSeries({ candles: first, timeframe: '1m', coin: 'BTC' });
    candleSetData.mockClear();
    setVisibleLogicalRange.mockClear();
    const incoming = { t: 1180, o: '1', h: '2', l: '1', c: '1.6', v: '1' };
    const next = first.slice(1).concat(incoming);

    const ok = controller.updateSeries({
      candle: incoming,
      candles: next,
      timeframe: '1m',
      coin: 'BTC',
    });

    expect(ok).toBe(true);
    expect(candleUpdate).not.toHaveBeenCalled();
    expect(candleSetData).toHaveBeenCalledTimes(1);
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 9.5, to: 39.25 });
    expect(controller.getDebugState().headEvictionSetDataCount).toBe(1);
  });

  it('does not treat a same-length wick revision as a no-op when only high/low change', () => {
    const candleSetData = vi.fn();
    let lastSeriesMeta = null;
    let lastDataSignature = '';
    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: vi.fn(), setData: candleSetData }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });
    const candles = [
      { t: 1713299940, o: '99', h: '100', l: '98', c: '100.5', v: '10' },
      { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
    ];
    controller.syncSeries({ candles, timeframe: '1m', coin: 'BTC' });
    const wickOnly = [
      candles[0],
      { ...candles[1], h: '108', l: '97' },
    ];
    controller.syncSeries({ candles: wickOnly, timeframe: '1m', coin: 'BTC' });
    expect(candleSetData).toHaveBeenCalledTimes(2);
  });

  it('exposes no mid-price projection API and accepts the next real candle', () => {
    const candleUpdate = vi.fn();
    let lastSeriesMeta = {
      length: 2,
      firstTime: 1713299940,
      lastTime: 1713300000,
      lastOpen: 100,
      lastHigh: 101,
      lastLow: 99,
      lastClose: 100.5,
      coin: 'BTC',
      timeframe: '1m',
    };

    const controller = createSeriesSyncController({
      getCandleSeries: () => ({ update: candleUpdate, setData: vi.fn() }),
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => '',
      setLastDataSignature: () => {},
      applyThemeIfNeeded: () => {},
    });

    expect(controller.projectLastBar).toBeUndefined();
    const applied = controller.updateSeries({
        candle: { t: 1713300060, o: '100.5', h: '103', l: '100', c: '102', v: '15' },
        candles: [
          { t: 1713299940, o: '99', h: '100', l: '98', c: '100', v: '9' },
          { t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
          { t: 1713300060, o: '100.5', h: '103', l: '100', c: '102', v: '15' },
        ],
        timeframe: '1m',
        coin: 'BTC',
      });

    expect(applied).toBe(true);
    expect(candleUpdate).toHaveBeenCalledWith(expect.objectContaining({ time: 1713300060 }));
  });

  it('reports setData, update, and rejected-update diagnostics', () => {
    const candleSeries = { update: vi.fn(), setData: vi.fn() };
    let lastSeriesMeta = null;
    let lastDataSignature = '';
    const controller = createSeriesSyncController({
      getCandleSeries: () => candleSeries,
      getLastSeriesMeta: () => lastSeriesMeta,
      setLastSeriesMeta: (value) => { lastSeriesMeta = value; },
      getLastDataSignature: () => lastDataSignature,
      setLastDataSignature: (value) => { lastDataSignature = value; },
      applyThemeIfNeeded: () => {},
    });
    const candles = [{ t: 1713300000, o: '100', h: '101', l: '99', c: '100.5', v: '10' }];

    controller.syncSeries({ candles, timeframe: '1m', coin: 'BTC' });
    controller.updateSeries({ candle: { ...candles[0], c: '101' }, candles, timeframe: '1m', coin: 'BTC' });
    controller.updateSeries({ candle: { ...candles[0], t: 1713299940 }, candles, timeframe: '1m', coin: 'BTC' });

    expect(controller.getDebugState()).toEqual({
      setDataCount: 1,
      updateCount: 1,
      authoritativeUpdateCount: 1,
      projectedUpdateCount: 0,
      reconciliationSetDataCount: 0,
      headEvictionSetDataCount: 0,
      rejectedUpdateCount: 1,
    });
  });
});
