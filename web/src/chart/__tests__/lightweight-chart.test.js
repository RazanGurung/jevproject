/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('lightweight chart native line cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = true;
    window.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = true;
    document.body.innerHTML = '<div id="uplot-chart"></div>';
  });

  it('cleans up native order and preview lines across sequential updates', async () => {
    const chartModule = await import('../lightweight-chart.js');

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      ],
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    chartModule.syncOrderLines([
      { oid: 1, price: 100, side: 'B' },
      { oid: 2, price: 105, side: 'A', tpsl: 'tp' },
    ]);
    chartModule.syncPreviewLines([
      { id: 'preview-buy', price: 99, isBuy: true, label: 'BUY $100' },
      { id: 'preview-sell', price: 106, isBuy: false, label: 'SELL $100' },
    ]);

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 2,
        previewLineCount: 2,
        hasLivePriceLine: false,
      })
    );

    chartModule.syncOrderLines([
      { oid: 2, price: 105, side: 'A', tpsl: 'tp' },
    ]);
    chartModule.syncPreviewLines([
      { id: 'preview-sell', price: 106, isBuy: false, label: 'SELL $100' },
    ]);

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 1,
        previewLineCount: 1,
      })
    );

    chartModule.syncOrderLines([]);
    chartModule.syncPreviewLines([]);

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 0,
        previewLineCount: 0,
      })
    );

    chartModule.removeLightweightChart();
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        hasChart: false,
        hasCandleSeries: false,
        orderLineCount: 0,
        previewLineCount: 0,
      })
    );
  });

  it('applies live candle updates directly without app-side buffering', async () => {
    const chartModule = await import('../lightweight-chart.js');

    const candles = [
      { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      { t: 1060, o: '100', h: '103', l: '99', c: '102', v: '12' },
    ];

    chartModule.syncLightweightChart({
      candles: candles.slice(0, 1),
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    chartModule.bufferLiveCandleSync({
      candle: candles[1],
      candles,
      timeframe: '1m',
    });

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        lastDataSignature: '1m:2:1000:1060:100:103:99:102:12',
      })
    );

    chartModule.syncLightweightChart({
      candles,
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 2,
      forceVisibleRange: false,
    });

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        lastDataSignature: '1m:2:1000:1060:100:103:99:102:12',
      })
    );
  });

  it('keeps every derived indicator on closed candles while the native tail remains live', async () => {
    const { AppState } = await import('../../state/store.js');
    const chartModule = await import('../lightweight-chart.js');
    const now = Date.now();
    const closed = {
      t: now - 120_000,
      T: now - 60_001,
      o: '99', h: '102', l: '98', c: '101', v: '10', cvdDelta: 4,
    };
    const forming = {
      t: now - 60_000,
      T: now + 30_000,
      o: '101', h: '104', l: '100', c: '103', v: '12', cvdDelta: 6,
    };

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.ui.monthlyVolumeProfileVisible = true;
    AppState.market.candles = [closed, forming];
    chartModule.syncLightweightChart({
      candles: AppState.market.candles,
      coin: 'BTC',
      timeframe: '1m',
      candleSnapshotRevision: 1,
    });
    const before = chartModule.getLightweightChartDebugState();
    expect(before.exchangeCandleCount).toBe(2);
    expect(before.indicatorSource).toEqual(expect.objectContaining({
      count: 1,
      excludedOpenCount: 1,
    }));
    expect(before.indicators.cvd.rowCount).toBe(1);
    expect(before.indicators.monthlyVolumeProfile.lastBarTime)
      .toBe(Math.floor(closed.t / 1000));

    const revisedForming = { ...forming, h: '106', c: '105', v: '20', cvdDelta: 9 };
    AppState.market.candles = [closed, revisedForming];
    chartModule.bufferLiveCandleSync({
      candle: revisedForming,
      candles: AppState.market.candles,
      coin: 'BTC',
      timeframe: '1m',
    });
    const during = chartModule.getLightweightChartDebugState();
    expect(during.lastDataSignature).toContain(':105:20');
    expect(during.indicatorSource.signature).toBe(before.indicatorSource.signature);
    expect(during.indicators.cvd.lastTime).toBe(before.indicators.cvd.lastTime);
    expect(during.indicators.cvd.lastValue).toBe(before.indicators.cvd.lastValue);
    expect(during.indicators.monthlyVolumeProfile.lastBarTime)
      .toBe(before.indicators.monthlyVolumeProfile.lastBarTime);

    const completedFormerTail = { ...revisedForming, T: now - 1 };
    const nextForming = {
      t: now,
      T: now + 59_999,
      o: '105', h: '106', l: '104', c: '105', v: '1', cvdDelta: 0,
    };
    AppState.market.candles = [closed, completedFormerTail, nextForming];
    chartModule.bufferLiveCandleSync({
      candle: nextForming,
      candles: AppState.market.candles,
      coin: 'BTC',
      timeframe: '1m',
    });
    const after = chartModule.getLightweightChartDebugState();
    expect(after.indicatorSource).toEqual(expect.objectContaining({
      count: 2,
      excludedOpenCount: 1,
    }));
    expect(after.indicators.cvd.rowCount).toBe(2);
    expect(after.indicators.cvd.lastTime).toBe(Math.floor(forming.t / 1000));
  });

  it('applies a closed live candle after a frame-sliced cold indicator rebuild', async () => {
    const frames = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    }));
    const { AppState } = await import('../../state/store.js');
    const chartModule = await import('../lightweight-chart.js');
    // Chart construction stays on the test stub; overlay work should still
    // frame-slice like production so a live tick can land during rebuild.
    globalThis.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = false;
    window.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = false;
    const start = 1_700_000_000_000;
    const candles = Array.from({ length: 1_501 }, (_, index) => ({
      t: start + index * 60_000,
      T: start + (index + 1) * 60_000 - 1,
      o: '100', h: '102', l: '99', c: '101', v: '10', cvdDelta: 1,
    }));
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';

    chartModule.syncLightweightChart({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      candleSnapshotRevision: 1,
    });
    expect(chartModule.getLightweightChartDebugState().indicators.cvd.rowCount).toBe(0);

    const latest = {
      ...candles.at(-1),
      t: candles.at(-1).t + 60_000,
      T: candles.at(-1).T + 60_000,
      cvdDelta: 2,
    };
    const withLatest = [...candles, latest];
    chartModule.bufferLiveCandleSync({
      candle: latest,
      candles: withLatest,
      coin: 'BTC',
      timeframe: '1m',
    });
    expect(chartModule.getLightweightChartDebugState().indicators.cvd.rowCount).toBe(0);

    while (frames.length > 0) frames.shift()();
    expect(chartModule.getLightweightChartDebugState().indicators.cvd).toEqual(
      expect.objectContaining({ rowCount: 1_502 }),
    );
    vi.unstubAllGlobals();
  });

  it('reattaches an enabled RVWAP from its dedicated source after a timeframe switch', async () => {
    const { AppState, setRvwapSourceCacheEntry } = await import('../../state/store.js');
    const chartModule = await import('../lightweight-chart.js');
    const start = 1713132000;
    const source = Array.from({ length: 60 }, (_, index) => {
      const price = 100 + index;
      return {
        t: start + index * 4 * 60 * 60,
        o: `${price}`,
        h: `${price + 2}`,
        l: `${price - 1}`,
        c: `${price + 1}`,
        v: `${10 + index}`,
      };
    });
    const display = source.slice(-4);
    AppState.ui.rvwapLookbacks = ['7D'];
    AppState.ui.rvwapBandLookbacks = [];
    AppState.market.rvwapSource = {
      coin: 'BTC',
      interval: '4h',
      status: 'ready',
      loadedAt: 1,
      count: source.length,
    };
    setRvwapSourceCacheEntry('BTC', source);

    chartModule.syncLightweightChart({
      candles: display,
      coin: 'BTC',
      timeframe: '2h',
      viewStart: 0,
      viewCount: display.length,
    });
    const before = chartModule.getLightweightChartDebugState().indicators.vwapBands;
    expect(before.instances['7D']).toEqual(expect.objectContaining({
      attached: true,
      rowCount: source.length,
    }));
    expect(before.instances['7D'].centerCount).toBeGreaterThan(0);

    chartModule.syncLightweightChart({
      candles: display,
      coin: 'BTC',
      timeframe: '4h',
      viewStart: 0,
      viewCount: display.length,
    });
    const after = chartModule.getLightweightChartDebugState().indicators.vwapBands;
    expect(after.instances['7D']).toEqual(expect.objectContaining({
      attached: true,
      rowCount: source.length,
    }));
    expect(after.instances['7D'].centerCount).toBe(before.instances['7D'].centerCount);
  });

  it('keeps an enabled RVWAP when switching coins if the new coin already has a source cache', async () => {
    const { AppState, setRvwapSourceCacheEntry } = await import('../../state/store.js');
    const chartModule = await import('../lightweight-chart.js');
    const start = 1713132000;
    const makeSource = (basePrice) => Array.from({ length: 60 }, (_, index) => {
      const price = basePrice + index;
      return {
        t: start + index * 4 * 60 * 60,
        o: `${price}`,
        h: `${price + 2}`,
        l: `${price - 1}`,
        c: `${price + 1}`,
        v: `${10 + index}`,
      };
    });
    const btcSource = makeSource(100);
    const ethSource = makeSource(200);
    const display = (source) => source.slice(-4);
    AppState.ui.rvwapLookbacks = ['7D'];
    AppState.ui.rvwapBandLookbacks = [];
    AppState.market.rvwapSource = {
      coin: 'BTC',
      interval: '4h',
      status: 'ready',
      loadedAt: 1,
      count: btcSource.length,
    };
    setRvwapSourceCacheEntry('BTC', btcSource, {
      complete: true, status: 'ready', coin: 'BTC', loadedAt: 1, count: btcSource.length,
    });
    setRvwapSourceCacheEntry('ETH', ethSource, {
      complete: true, status: 'ready', coin: 'ETH', loadedAt: 2, count: ethSource.length,
    });

    chartModule.syncLightweightChart({
      candles: display(btcSource),
      coin: 'BTC',
      timeframe: '2h',
      viewStart: 0,
      viewCount: 4,
    });
    expect(chartModule.getLightweightChartDebugState().indicators.vwapBands.instances['7D'])
      .toEqual(expect.objectContaining({ attached: true, rowCount: btcSource.length }));

    chartModule.syncLightweightChart({
      candles: display(ethSource),
      coin: 'ETH',
      timeframe: '2h',
      viewStart: 0,
      viewCount: 4,
    });
    expect(chartModule.getLightweightChartDebugState().indicators.vwapBands.instances['7D'])
      .toEqual(expect.objectContaining({ attached: true, rowCount: ethSource.length }));
  });

  it('fits active candles across timeframe switches without an expanded RVWAP axis', async () => {
    const { AppState, setRvwapSourceCacheEntry } = await import('../../state/store.js');
    const chartModule = await import('../lightweight-chart.js');
    const HOUR = 60 * 60;
    const sourceStart = 1_700_000_000;
    const source = Array.from({ length: 120 }, (_, index) => ({
      t: sourceStart + index * 4 * HOUR,
      o: '99',
      h: '102',
      l: '98',
      c: '100',
      v: '10',
    }));
    const display = Array.from({ length: 40 }, (_, index) => ({
      t: sourceStart + 80 * 4 * HOUR + index * 2 * HOUR,
      o: '199',
      h: '202',
      l: '198',
      c: '200',
      v: '20',
    }));
    const to = display[display.length - 1].t;

    AppState.ui.rvwapLookbacks = ['7D'];
    AppState.ui.rvwapBandLookbacks = [];
    AppState.market.rvwapSource = {
      coin: 'SOL',
      interval: '4h',
      status: 'ready',
      loadedAt: 2,
      count: source.length,
    };
    setRvwapSourceCacheEntry('SOL', source);

    const timeframes = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '1w', '1M'];
    for (const [index, timeframe] of timeframes.entries()) {
      chartModule.syncLightweightChart({
        candles: display,
        coin: 'SOL',
        timeframe,
        fitContent: index === 0,
      });

      expect(chartModule.getLightweightChartDebugState()).toEqual(
        expect.objectContaining({
          timeScaleBarSpacing: 800 / 45,
          timeScaleRightOffset: 5,
          visibleLogicalRange: {
            from: 0,
            to: 44,
          },
          overviewLogicalRange: {
            from: 0,
            to: 44,
          },
          overviewCoversLoadedCandles: true,
          conflation: expect.objectContaining({
            enabled: true,
            active: false,
            factor: 1,
          }),
          lastSeriesMeta: expect.objectContaining({
            coin: 'SOL',
            timeframe,
            lastTime: to,
          }),
        })
      );
    }
  });

  it('preserves manual zoom until the next timeframe reset', async () => {
    const chartModule = await import('../lightweight-chart.js');
    const candles = [
      { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      { t: 1060, o: '100', h: '102', l: '99', c: '101', v: '11' },
    ];

    chartModule.syncLightweightChart({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      fitContent: true,
    });
    chartModule.getChart().timeScale().applyOptions({ barSpacing: 17 });
    expect(chartModule.getLightweightChartDebugState().timeScaleBarSpacing).toBe(17);

    chartModule.syncLightweightChart({
      candles,
      coin: 'BTC',
      timeframe: '1m',
    });
    const zoomedState = chartModule.getLightweightChartDebugState();
    expect(zoomedState.seriesRecreateCount).toBe(0);
    expect(zoomedState.timeScaleBarSpacing).toBe(17);

    chartModule.syncLightweightChart({
      candles,
      coin: 'BTC',
      timeframe: '5m',
    });
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        timeScaleBarSpacing: 800 / 7,
        visibleLogicalRange: { from: 0, to: 6 },
        overviewLogicalRange: { from: 0, to: 6 },
        overviewCoversLoadedCandles: true,
      })
    );
  });

  it('loads long histories as a conflated overview and reveals originals when zoomed in', async () => {
    const chartModule = await import('../lightweight-chart.js');
    const candles = Array.from({ length: 2_000 }, (_, index) => ({
      t: 1_700_000_000 + index * 60,
      o: '99',
      h: '102',
      l: '98',
      c: '100',
      v: '10',
    }));

    chartModule.syncLightweightChart({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      fitContent: true,
    });

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        visibleLogicalRange: { from: 0, to: 2_004 },
        timeScaleBarSpacing: 800 / 2_005,
        timeScaleMinBarSpacing: 0.001,
        overviewLogicalRange: { from: 0, to: 2_004 },
        overviewCoversLoadedCandles: true,
        visibleLogicalSlotCount: 2_005,
        conflation: expect.objectContaining({
          enabled: true,
          active: true,
          factor: 2,
          effectiveBarSpacing: (800 / 2_005) * 2,
        }),
      })
    );

    chartModule.getChart().timeScale().applyOptions({ barSpacing: 4 });
    expect(chartModule.getLightweightChartDebugState().conflation).toEqual(
      expect.objectContaining({
        enabled: true,
        active: false,
        factor: 1,
        effectiveBarSpacing: 4,
      })
    );
  });

  it('tracks the live price line natively inside lightweight charts', async () => {
    const chartModule = await import('../lightweight-chart.js');

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      ],
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    chartModule.syncLivePriceLine(101, 99);
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        hasLivePriceLine: true,
      })
    );

    chartModule.syncLivePriceLine(0, 0);
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        hasLivePriceLine: false,
      })
    );
  });

  it('projects the forming candle without changing canonical metadata or forcing setData', async () => {
    const chartModule = await import('../lightweight-chart.js');
    const start = Date.UTC(2026, 6, 18, 12);
    const candles = [
      { t: start - 60_000, T: start - 1, o: '99', h: '101', l: '98', c: '100', v: '10' },
      { t: start, T: start + 59_999, o: '100', h: '102', l: '99', c: '101', v: '3' },
    ];

    chartModule.syncLightweightChart({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      viewStart: 0,
      viewCount: 2,
    });
    const before = chartModule.getLightweightChartDebugState();

    const applied = chartModule.syncProjectedLiveCandle({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      price: 103,
      now: start + 10_000,
    });
    expect(applied, JSON.stringify(chartModule.getLightweightChartDebugState())).toBe(true);

    const projected = chartModule.getLightweightChartDebugState();
    expect(projected).toEqual(expect.objectContaining({
      lastDataSignature: before.lastDataSignature,
      lastSeriesMeta: before.lastSeriesMeta,
      setDataCount: before.setDataCount,
      projectedUpdateCount: before.projectedUpdateCount + 1,
      projectedCandleSourcePrice: 103,
      projectedCandle: expect.objectContaining({ o: 100, h: 103, l: 99, c: 103 }),
    }));

    chartModule.bufferLiveCandleSync({
      candle: { ...candles[1], h: '103.5', c: '102.5', v: '4' },
      candles: [candles[0], { ...candles[1], h: '103.5', c: '102.5', v: '4' }],
      coin: 'BTC',
      timeframe: '1m',
    });
    expect(chartModule.getLightweightChartDebugState().rejectedUpdateCount).toBe(0);
  });

  it('expands a fitted overview when projection opens the next bucket', async () => {
    const chartModule = await import('../lightweight-chart.js');
    const start = Date.UTC(2026, 6, 18, 12);
    const candles = [
      { t: start - 120_000, T: start - 60_001, o: '99', h: '101', l: '98', c: '100', v: '10' },
      { t: start - 60_000, T: start - 1, o: '100', h: '102', l: '99', c: '101', v: '3' },
    ];

    chartModule.syncLightweightChart({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      fitContent: true,
    });
    expect(chartModule.getLightweightChartDebugState()).toEqual(expect.objectContaining({
      visibleLogicalRange: { from: 0, to: 6 },
      overviewLogicalRange: { from: 0, to: 6 },
    }));

    expect(chartModule.syncProjectedLiveCandle({
      candles,
      coin: 'BTC',
      timeframe: '1m',
      price: 103,
      now: start + 10_000,
    })).toBe(true);
    expect(chartModule.getLightweightChartDebugState()).toEqual(expect.objectContaining({
      visibleLogicalRange: { from: 0, to: 7 },
      overviewLogicalRange: { from: 0, to: 7 },
      overviewCoversLoadedCandles: true,
    }));
  });

  it('recreates preview lines after the chart is torn down and rebuilt', async () => {
    const chartModule = await import('../lightweight-chart.js');

    const previewLevels = [
      { id: 'preview-buy', price: 99.5, isBuy: true, label: 'BUY $100' },
      { id: 'preview-sell', price: 100.5, isBuy: false, label: 'SELL $100' },
    ];

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      ],
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    chartModule.syncPreviewLines(previewLevels);
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        previewLineCount: 2,
      })
    );

    chartModule.removeLightweightChart();
    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      ],
      timeframe: '1m',
      width: 620,
      height: 320,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    chartModule.syncPreviewLines(previewLevels);
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        hasChart: true,
        hasCandleSeries: true,
        previewLineCount: 2,
      })
    );
  });

  it('removes the lightweight chart without errors', async () => {
    const chartModule = await import('../lightweight-chart.js');

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      ],
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        hasChart: true,
        hasCandleSeries: true,
      })
    );

    chartModule.removeLightweightChart();

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        hasChart: false,
        hasCandleSeries: false,
      })
    );
  });

  it('rebuilds the main series when the active coin changes', async () => {
    const chartModule = await import('../lightweight-chart.js');

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99000', h: '101000', l: '98000', c: '100000', v: '10' },
      ],
      coin: 'BTC',
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });
    chartModule.syncOrderLines([
      { oid: 1, price: 100000, side: 'B' },
    ]);

    const initialSeries = chartModule.getCandleSeries();

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '190', h: '201', l: '189', c: '200', v: '20' },
      ],
      coin: 'SOL',
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    expect(chartModule.getCandleSeries()).not.toBe(initialSeries);
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 0,
        lastDataSignature: 'SOL:1m:1:1000:1000:190:201:189:200:20',
      })
    );
  });

  it('clears every native line family when the active series is rebuilt', async () => {
    const chartModule = await import('../lightweight-chart.js');

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99000', h: '101000', l: '98000', c: '100000', v: '10' },
      ],
      coin: 'BTC',
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });
    chartModule.syncOrderLines([
      { oid: 1, price: 100000, side: 'B' },
      { oid: 2, price: 101500, side: 'A', tpsl: 'tp', reduceOnly: true },
      { oid: 3, price: 98500, side: 'B', tpsl: 'sl', reduceOnly: true },
    ]);
    chartModule.syncPositionLines(
      [{ coin: 'BTC', side: 'long', price: 99500 }],
      [{ coin: 'BTC', side: 'short', price: 85000 }],
    );
    chartModule.syncPreviewLines([
      { id: 'preview-buy', price: 99000, isBuy: true },
    ]);
    chartModule.syncLivePriceLine(100250, 99000);

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 3,
        positionLineCount: 1,
        liquidationLineCount: 1,
        previewLineCount: 1,
        hasLivePriceLine: true,
      })
    );

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '190', h: '201', l: '189', c: '200', v: '20' },
      ],
      coin: 'SOL',
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 0,
        positionLineCount: 0,
        liquidationLineCount: 0,
        previewLineCount: 0,
        hasLivePriceLine: false,
      })
    );
  });

  it('rebuilds the main series when switching into an empty loading state', async () => {
    const chartModule = await import('../lightweight-chart.js');

    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      ],
      coin: 'BTC',
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });
    chartModule.syncPreviewLines([
      { id: 'preview-buy', price: 99, isBuy: true, label: 'BUY $100' },
    ]);

    const initialSeries = chartModule.getCandleSeries();

    chartModule.syncLightweightChart({
      candles: [],
      coin: 'SOL',
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    expect(chartModule.getCandleSeries()).not.toBe(initialSeries);
    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        previewLineCount: 0,
        lastDataSignature: 'SOL:1m:0:::::::',
      })
    );
  });

  it('force-repaints after resume because autoSize ignores public resize()', async () => {
    const container = document.getElementById('uplot-chart');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    const { containerHasLayout } = await import('../lightweight-chart-core.js');
    expect(containerHasLayout(container)).toBe(true);

    const chartModule = await import('../lightweight-chart.js');
    chartModule.syncLightweightChart({
      candles: [{ t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' }],
      timeframe: '1m',
      width: 800,
      height: 400,
    });
    const chart = chartModule.getChart();
    expect(chart.autoSizeActive()).toBe(true);

    const result = chartModule.recoverChartAfterResume();
    expect(result).toEqual({ ok: true, recreated: false });
    expect(chart._lastResize).toEqual({
      width: 800,
      height: 400,
      forceRepaint: true,
      autoSize: false,
    });
    expect(chart.autoSizeActive()).toBe(true);
  });

  it('sizes the chart from #chartWrap and restores a fluid host after resize', async () => {
    document.body.innerHTML = '<div id="chartWrap"><div id="uplot-chart"></div></div>';
    const wrap = document.getElementById('chartWrap');
    const container = document.getElementById('uplot-chart');
    Object.defineProperty(wrap, 'clientWidth', { value: 1200, configurable: true });
    Object.defineProperty(wrap, 'clientHeight', { value: 640, configurable: true });
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const chartModule = await import('../lightweight-chart.js');
    chartModule.syncLightweightChart({
      candles: [{ t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' }],
      timeframe: '1m',
      width: 800,
      height: 400,
    });
    const chart = chartModule.getChart();
    const result = chartModule.recoverChartAfterResume();
    expect(result).toEqual({ ok: true, recreated: false });
    expect(chart._lastResize).toEqual({
      width: 1200,
      height: 640,
      forceRepaint: true,
      autoSize: false,
    });
    expect(container.style.width).toBe('100%');
    expect(container.style.height).toBe('100%');
  });
});

