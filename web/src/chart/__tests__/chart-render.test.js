/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('chart render offscreen placement', () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = true;
    window.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = true;
  });

  it('starts fully zoomed out after a fresh chart load reset', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));

    const { AppState } = await import('../../state/store.js');
    const { setViewStart, setViewCount, getViewStart, getViewCount } = await import('../chart-state.js');
    const { clearHistoryLoadState, updateChart } = await import('../chart-render.js');

    AppState.market.candles = Array.from({ length: 150 }, (_, index) => ({
      t: 1000 + index * 60,
      o: '99',
      h: '101',
      l: '98',
      c: '100',
      v: '10',
    }));

    clearHistoryLoadState('BTC', '4h');
    updateChart();

    expect(getViewStart()).toBe(0);
    expect(getViewCount()).toBe(150);
  });

  it('refits when background enrichment expands the default dataset', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
    });
    document.body.innerHTML = `
      <div id="chartWrap"><div id="uplot-chart"></div></div>
      <div id="chartTitle"></div>
    `;
    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 400, configurable: true });

    const { AppState } = await import('../../state/store.js');
    const { initChart, drawChart, updateChart } = await import('../chart-render.js');
    const { getLightweightChartDebugState } = await import('../lightweight-chart.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1d';
    const makeCandles = (count) => Array.from({ length: count }, (_, index) => ({
      t: 1_700_000_000 + index * 86_400,
      o: '99',
      h: '101',
      l: '98',
      c: '100',
      v: '10',
    }));

    AppState.market.candles = makeCandles(100);
    initChart();
    drawChart();
    expect(getLightweightChartDebugState().visibleLogicalRange).toEqual({ from: 0, to: 104 });

    // Production enrichment path: applyCandles → updateChart (not re-initChart).
    // Default auto-fit must still re-open the full expanded history.
    AppState.market.candles = makeCandles(1_100);
    updateChart();
    drawChart();
    expect(getLightweightChartDebugState().visibleLogicalRange).toEqual({ from: 0, to: 1_104 });
    expect(getLightweightChartDebugState().overviewCoversLoadedCandles).toBe(true);
  });

  it('keeps a short first paint from sticking after auto-fit is cleared once', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
    });
    document.body.innerHTML = `
      <div id="chartWrap"><div id="uplot-chart"></div></div>
      <div id="chartTitle"></div>
    `;
    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 400, configurable: true });

    const { AppState } = await import('../../state/store.js');
    const { getViewCount } = await import('../chart-state.js');
    const { initChart, drawChart, updateChart } = await import('../chart-render.js');
    const { getLightweightChartDebugState } = await import('../lightweight-chart.js');
    AppState.trading.currentCoin = 'ETH';
    AppState.trading.currentTimeframe = '2h';
    const makeCandles = (count) => Array.from({ length: count }, (_, index) => ({
      t: 1_700_000_000 + index * 7_200,
      o: '99',
      h: '101',
      l: '98',
      c: '100',
      v: '10',
    }));

    AppState.market.candles = makeCandles(80);
    initChart();
    drawChart();
    // First paint clears needsFitContent after success — view model is full 80.
    expect(getViewCount()).toBe(80);
    expect(getLightweightChartDebugState().visibleLogicalRange).toEqual({ from: 0, to: 84 });

    AppState.market.candles = makeCandles(500);
    updateChart();
    drawChart();
    expect(getViewCount()).toBe(500);
    expect(getLightweightChartDebugState().visibleLogicalRange).toEqual({ from: 0, to: 504 });
  });

  it('preserves a manual scrolled-back window when updating an existing chart', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
    });

    const { AppState } = await import('../../state/store.js');
    const { setViewStart, setViewCount, getViewStart, getViewCount } = await import('../chart-state.js');
    const { initChart, drawChart, updateChart } = await import('../chart-render.js');

    document.body.innerHTML = `
      <div id="chartWrap">
        <div id="uplot-chart"></div>
      </div>
      <div id="chartTitle"></div>
    `;
    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 400, configurable: true });

    setViewStart(25);
    setViewCount(80);
    AppState.market.candles = Array.from({ length: 150 }, (_, index) => ({
      t: 1000 + index * 60,
      o: '99',
      h: '101',
      l: '98',
      c: '100',
      v: '10',
    }));

    initChart();
    drawChart();
    setViewStart(25);
    setViewCount(80);
    updateChart();

    expect(getViewStart()).toBe(25);
    expect(getViewCount()).toBe(80);
  });

  it('clears native lightweight lines when switching into a loading-state pair', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
    });

    const { AppState, chartLevelCache } = await import('../../state/store.js');
    const { setChartPreviewLevels } = await import('../chart-preview-state.js');
    const { initChart, drawChart } = await import('../chart-render.js');
    const { getLightweightChartDebugState } = await import('../lightweight-chart.js');

    document.body.innerHTML = `
      <div id="chartWrap">
        <div id="uplot-chart"></div>
      </div>
      <div id="chartTitle"></div>
    `;
    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 400, configurable: true });

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentPrice = 101;
    AppState.market.candles = [
      { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
    ];
    chartLevelCache.clear();
    chartLevelCache.set('BTC', {
      positions: [],
      orders: [{ oid: 1, price: 100, side: 'B' }],
      liquidations: [],
      levels: [],
    });
    setChartPreviewLevels([{ id: 'preview-buy', price: 99, isBuy: true, label: 'BUY $100' }]);

    initChart();
    drawChart();

    expect(getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 1,
        previewLineCount: 1,
        hasLivePriceLine: true,
      })
    );

    AppState.trading.currentCoin = 'ETH';
    AppState.trading.currentPrice = 0;
    AppState.market.candles = [];
    chartLevelCache.delete('ETH');
    setChartPreviewLevels([]);

    drawChart();

    expect(getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 0,
        previewLineCount: 0,
        hasLivePriceLine: false,
      })
    );
  });

  it('stays in loading mode while candles are empty even if the current coin still has order lines', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    const fillText = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText,
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
    });

    const { AppState, chartLevelCache } = await import('../../state/store.js');
    const { initChart, drawChart } = await import('../chart-render.js');
    const { getLightweightChartDebugState } = await import('../lightweight-chart.js');

    document.body.innerHTML = `
      <div id="chartWrap">
        <div id="uplot-chart"></div>
      </div>
      <div id="chartTitle"></div>
    `;
    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 400, configurable: true });

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentPrice = 101;
    AppState.ui.isLoadingChart = true;
    AppState.market.candles = [];
    chartLevelCache.clear();
    chartLevelCache.set('BTC', {
      positions: [],
      orders: [{ oid: 1, price: 100, side: 'B' }],
      liquidations: [],
      levels: [],
    });

    initChart();
    drawChart();

    expect(fillText).toHaveBeenCalledWith('Loading...', 400, 200);
    expect(getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        orderLineCount: 1,
        hasLivePriceLine: false,
      })
    );
  });
});
