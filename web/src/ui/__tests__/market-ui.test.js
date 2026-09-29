/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../chart/chart-render.js', () => ({
  initChart: vi.fn(),
  updateChart: vi.fn(),
}));

describe('market ui candle application', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    window.PriceFeed = { update: vi.fn() };

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'xyz:CL';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.candles = [];
  });

  it('bootstraps the chart on the first active candle load', async () => {
    const { applyCandles } = await import('../market-ui.js');
    const chartRender = await import('../../chart/chart-render.js');

    await applyCandles([
      { t: 1, o: '80', h: '81', l: '79', c: '80.5', v: '10' },
    ], 'xyz:CL', '1m');

    expect(chartRender.initChart).toHaveBeenCalledTimes(1);
    expect(chartRender.updateChart).not.toHaveBeenCalled();
  });

  it('updates an existing active chart when candle count is unchanged', async () => {
    document.body.innerHTML = '<canvas id="chartCanvas"></canvas>';

    const { applyCandles } = await import('../market-ui.js');
    const chartRender = await import('../../chart/chart-render.js');

    // The canvas already exists, so the persistent chart schedules a series
    // sync rather than rebuilding the compatibility canvas.
    await applyCandles([
      { t: 1, o: '80', h: '81', l: '79', c: '80.5', v: '10' },
    ], 'xyz:CL', '1m');
    expect(chartRender.updateChart).toHaveBeenCalledTimes(1);
    expect(chartRender.initChart).not.toHaveBeenCalled();
    vi.clearAllMocks();

    // Second load: same coin/timeframe and same candle count → incremental update
    // of the existing series, not a full rebuild.
    await applyCandles([
      { t: 1, o: '80', h: '81.5', l: '79', c: '81', v: '12' },
    ], 'xyz:CL', '1m');

    expect(chartRender.updateChart).toHaveBeenCalledTimes(1);
    expect(chartRender.initChart).not.toHaveBeenCalled();
  });

  it('does not write AppState candles for a superseded selection', async () => {
    const { applyCandles } = await import('../market-ui.js');
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'ETH';
    AppState.market.candles = [{ t: 9 }];
    AppState.market.candleSnapshotRevision = 3;

    await applyCandles([
      { t: 1, o: '80', h: '81', l: '79', c: '80.5', v: '10' },
    ], 'xyz:CL', '1m');

    expect(AppState.market.candles).toEqual([{ t: 9 }]);
    expect(AppState.market.candleSnapshotRevision).toBe(3);
  });
});

describe('applyMarketMovers membership gate', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('does not re-warm subscriptions when only mover ranking changes', async () => {
    vi.doMock('../controls.js', () => ({
      updateCoinTabChange: vi.fn(),
      renderMoverRows: vi.fn(),
    }));
    const { AppState } = await import('../../state/store.js');
    const { applyMarketMovers } = await import('../market-ui.js');
    const { renderMoverRows } = await import('../controls.js');
    AppState.trading.trackedCoins = ['BTC', 'ETH'];
    const events = [];
    const onChange = (event) => events.push(event.type);
    document.addEventListener('pez:tracked-coins-changed', onChange);

    applyMarketMovers(
      [{ coin: 'ETH', change: 2 }],
      [{ coin: 'BTC', change: -1 }],
    );

    expect(AppState.trading.trackedCoins).toEqual(['ETH', 'BTC']);
    expect(renderMoverRows).toHaveBeenCalled();
    expect(events).toEqual([]);

    applyMarketMovers(
      [{ coin: 'ETH', change: 2 }, { coin: 'SOL', change: 1 }],
      [{ coin: 'BTC', change: -1 }],
    );
    expect(AppState.trading.trackedCoins).toEqual(['ETH', 'SOL', 'BTC']);
    expect(events).toEqual(['pez:tracked-coins-changed']);

    document.removeEventListener('pez:tracked-coins-changed', onChange);
    vi.doUnmock('../controls.js');
  });

  it('filters out hidden tickers from top movers and updates when hide list changes', async () => {
    vi.doMock('../controls.js', () => ({
      updateCoinTabChange: vi.fn(),
      renderMoverRows: vi.fn(),
    }));
    const { AppState } = await import('../../state/store.js');
    const { applyMarketMovers } = await import('../market-ui.js');
    const { renderMoverRows } = await import('../controls.js');
    const { addToHideList, removeFromHideList, clearHideList } = await import('../../services/hide-list-store.js');

    clearHideList();
    addToHideList('BTC');

    applyMarketMovers(
      [{ coin: 'ETH', change: 5 }, { coin: 'BTC', change: 3 }],
      [{ coin: 'SOL', change: -2 }, { coin: 'DOGE', change: -4 }]
    );

    expect(AppState.market.topGainers.map((g) => g.coin)).toEqual(['ETH']);
    expect(renderMoverRows).toHaveBeenCalledWith(
      [{ coin: 'ETH', change: 5 }],
      [{ coin: 'SOL', change: -2 }, { coin: 'DOGE', change: -4 }]
    );

    // Unhiding BTC restores it to movers immediately
    removeFromHideList('BTC');
    expect(AppState.market.topGainers.map((g) => g.coin)).toEqual(['ETH', 'BTC']);

    // Hiding ETH immediately removes it
    addToHideList('ETH');
    expect(AppState.market.topGainers.map((g) => g.coin)).toEqual(['BTC']);

    clearHideList();
    vi.doUnmock('../controls.js');
  });
});
