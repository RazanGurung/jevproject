/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSwitchCoin } from '../coin-switch.js';
import { AppState as RuntimeAppState, ConnectionState, candleCache, coin24hChanges } from '../../state/store.js';

function createBaseDeps(overrides = {}) {
  const AppState = {
    ui: { userEditedPrice: false, chartPreviewLevels: [] },
    market: { candles: [], allMids: {} },
  };

  return {
    AppState,
    setLegacy: vi.fn((key, value) => {
      if (key === 'currentCoin') {
        globalThis.window.currentCoin = value;
        AppState.trading = AppState.trading || {};
        AppState.trading.currentCoin = value;
        RuntimeAppState.trading.currentCoin = value;
      }
      if (key === 'currentPrice') {
        globalThis.window.currentPrice = value;
        AppState.trading = AppState.trading || {};
        AppState.trading.currentPrice = value;
      }
    }),
    updateTicketLayoutMode: vi.fn(),
    getEffectiveWalletAddress: vi.fn(() => ''),
    getMaxLeverage: vi.fn(() => 10),
    ensureMaxLeverageDefault: vi.fn(),
    setBookVersion: vi.fn(),
    clearScalePreview: vi.fn(() => {
      AppState.ui.chartPreviewLevels = [];
    }),
    getEffectiveCurrentTimeframe: vi.fn(() => '1m'),
    syncLimitPreviewLevels: vi.fn(() => {
      AppState.ui.chartPreviewLevels = [{ price: 100, isBuy: true, label: 'BUY $100' }];
      return true;
    }),
    drawChart: vi.fn(),
    scheduleChartRender: vi.fn(),
    coinToTabId: vi.fn((coin) => coin.toLowerCase()),
    updateSizeSliderMax: vi.fn(),
    scheduleRender: vi.fn(),
    renderTwapStatus: vi.fn(),
    syncLegacyGlobals: vi.fn(),
    resetMarketRuntimeState: vi.fn(),
    syncMarketRuntimeMirrors: vi.fn(),
    updateChartLevels: vi.fn(),
    fmtPrice: vi.fn((value) => String(value)),
    getEffectiveCurrentOrderType: vi.fn(() => 'limit'),
    getAutoLimitPriceForSide: vi.fn(() => 101),
    applyTicketPrice: vi.fn(() => true),
    getEffectiveCurrentSide: vi.fn(() => 'buy'),
    updateTopBar: vi.fn(),
    updateSummary: vi.fn(),
    syncActiveTradeState: vi.fn(),
    renderOrderFlow: vi.fn(),
    cancelPendingRenders: vi.fn(),
    fetchWithDedup: vi.fn(),
    hlPost: vi.fn(),
    subscribeMarket: vi.fn(),
    setDesiredMarketSubscription: vi.fn(),
    getDesiredTradeCoins: vi.fn(() => ['BTC']),
    renderSignalRadar: vi.fn(),
    scheduleSignalRadarRender: vi.fn(),
    scheduleLayoutRender: vi.fn(),
    refreshTickerNews: vi.fn(() => Promise.resolve()),
    beginChartSession: vi.fn(),
    completeChartSession: vi.fn(),
    failChartSession: vi.fn(),
    fetchCandles: vi.fn(() => Promise.resolve()),
    fetchL2Snapshot: vi.fn(() => Promise.resolve()),
    initChart: vi.fn(),
    clearHistoryLoadState: vi.fn(),
    refreshExchangeInfo: vi.fn(),
    getAllMids: vi.fn(() => ({})),
    ...overrides,
  };
}

describe('coin switch stale-state handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = `
      <div id="coinDropdown"></div>
      <div id="chartTitle"></div>
      <div id="topPrice"></div>
      <input id="priceInput" />
      <div id="fundingVal"></div>
      <div id="oiVal"></div>
      <button id="placeBtn">Place Order</button>
      <button id="tab-btc" class="coin-tab active"></button>
      <button id="tab-sol" class="coin-tab"></button>
    `;
    candleCache.clear();
    Object.keys(coin24hChanges).forEach((coin) => delete coin24hChanges[coin]);
    window.currentPrice = 0;
    window.currentCoin = 'BTC';
    RuntimeAppState.trading.currentCoin = 'BTC';
    RuntimeAppState.connection.marketState = ConnectionState.CONNECTED;
    RuntimeAppState.connection.marketUpstreamConnected = true;
    RuntimeAppState.connection.marketLastTickAt = Date.now();
    window.chartCanvas = {};
  });

  it('does not leave stale preview lines behind across rapid A -> B -> A switches', async () => {
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100', SOL: '200' })),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);

    switchCoin('BTC');
    expect(deps.AppState.ui.chartPreviewLevels).toHaveLength(1);
    expect(deps.scheduleChartRender).toHaveBeenCalled();

    deps.syncLimitPreviewLevels.mockImplementationOnce(() => {
      deps.AppState.ui.chartPreviewLevels = [{ price: 200, isBuy: true, label: 'BUY $200' }];
      return true;
    });
    switchCoin('SOL');
    expect(deps.AppState.ui.chartPreviewLevels).toEqual([
      expect.objectContaining({ price: 200 }),
    ]);

    deps.syncLimitPreviewLevels.mockImplementationOnce(() => {
      deps.AppState.ui.chartPreviewLevels = [{ price: 100, isBuy: true, label: 'BUY $100' }];
      return true;
    });
    switchCoin('BTC');
    expect(deps.AppState.ui.chartPreviewLevels).toEqual([
      expect.objectContaining({ price: 100 }),
    ]);
  });

  it('initializes the default pair once but ignores repeated active-pair clicks', () => {
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100' })),
    });
    const switchCoin = createSwitchCoin(deps);

    expect(switchCoin('BTC')).toBe(true);
    expect(switchCoin('BTC')).toBe(false);

    expect(deps.beginChartSession).toHaveBeenCalledTimes(1);
    expect(deps.fetchCandles).toHaveBeenCalledTimes(1);
    expect(deps.refreshExchangeInfo).toHaveBeenCalledTimes(1);
  });

  it('ignores the first picker click when startup already owns a ready chart for that coin', () => {
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100' })),
    });
    deps.AppState.ui.chartSession = {
      status: 'ready',
      coin: 'BTC',
      timeframe: '1m',
      requestToken: 'startup-token',
    };
    const switchCoin = createSwitchCoin(deps);

    expect(switchCoin('BTC')).toBe(false);
    expect(deps.beginChartSession).not.toHaveBeenCalled();
    expect(deps.fetchCandles).not.toHaveBeenCalled();
    expect(deps.refreshExchangeInfo).not.toHaveBeenCalled();
  });

  it('prunes per-coin trade/DOM caches down to the subscribed set on switch', async () => {
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100', SOL: '200' })),
      getDesiredTradeCoins: vi.fn(() => ['SOL', 'BTC']),
    });
    // Seed caches for a coin that is no longer subscribed (DOGE).
    deps.AppState.market.tradeCache = new Map([['BTC', []], ['DOGE', []]]);
    deps.AppState.market.largeTradeCache = new Map([['DOGE', []]]);
    deps.AppState.market.flowCache = new Map([['SOL', { buyVol: 1, sellVol: 2 }], ['DOGE', { buyVol: 3, sellVol: 4 }]]);
    deps.AppState.market.whaleFlowCache = new Map([['DOGE', { buyVol: 0, sellVol: 0 }]]);
    deps.AppState.market.tradeSeenKeys = new Map([['DOGE', new Set(['1:1:1:B'])]]);
    deps.AppState.market.domTradeCache = new Map([['BTC', new Map()], ['DOGE', new Map()]]);
    deps.AppState.market.bookCache = new Map([['BTC', { bids: [], asks: [] }], ['DOGE', { bids: [], asks: [] }]]);

    const switchCoin = createSwitchCoin(deps);
    switchCoin('SOL');

    expect([...deps.AppState.market.tradeCache.keys()]).toEqual(['BTC']);
    expect(deps.AppState.market.largeTradeCache.size).toBe(0);
    expect([...deps.AppState.market.flowCache.keys()]).toEqual(['SOL']);
    expect(deps.AppState.market.whaleFlowCache.size).toBe(0);
    expect(deps.AppState.market.tradeSeenKeys.size).toBe(0);
    expect([...deps.AppState.market.domTradeCache.keys()]).toEqual(['BTC']);
    expect([...deps.AppState.market.bookCache.keys()]).toEqual(['BTC']);
  });

  it('restores a previously-cached book instantly on switching back to that coin', async () => {
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100', SOL: '200' })),
      // SOL must stay in the subscribed/kept set, otherwise
      // resetCoinSwitchRuntimeCaches' pruneMarketCoinCaches call (which runs
      // before the restore) would evict its bookCache entry first.
      getDesiredTradeCoins: vi.fn(() => ['SOL', 'BTC']),
    });
    const cachedSolBook = { bids: [{ px: 200, sz: 1 }], asks: [{ px: 201, sz: 2 }] };
    deps.AppState.market.bookCache = new Map([['SOL', cachedSolBook]]);

    const switchCoin = createSwitchCoin(deps);
    switchCoin('SOL');

    expect(deps.AppState.market.book).toEqual(cachedSolBook);
    // Restore copies out rather than aliases the cached entry.
    expect(deps.AppState.market.book).not.toBe(cachedSolBook);
  });

  it('leaves the reset (empty) book state when the new coin has never streamed a book', async () => {
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100', SOL: '200' })),
    });
    deps.AppState.market.bookCache = new Map();

    const switchCoin = createSwitchCoin(deps);
    switchCoin('SOL');

    // resetMarketRuntimeState is a vi.fn() mock here (does not actually reset
    // AppState.market.book), so with no cache entry the restore branch must
    // be skipped entirely and leave `book` untouched.
    expect(deps.AppState.market.book).toBeUndefined();
  });

  it('uses a guarded REST book snapshot when a cold pair has not streamed promptly', async () => {
    vi.useFakeTimers();
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ SOL: '200' })),
    });
    deps.AppState.market.bookCache = new Map();
    const switchCoin = createSwitchCoin(deps);

    switchCoin('SOL');
    expect(deps.fetchL2Snapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(deps.fetchL2Snapshot).toHaveBeenCalledWith('SOL', {
      shouldApply: expect.any(Function),
    });
    expect(deps.fetchL2Snapshot.mock.calls[0][1].shouldApply()).toBe(true);
    vi.useRealTimers();
  });

  it('uses scheduled redraws instead of immediate drawChart for cached-candle coin switches', async () => {
    candleCache.set('BTC:1m', [{ t: 1, o: '1', h: '1', l: '1', c: '1', v: '1' }]);
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100' })),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);

    switchCoin('BTC');

    expect(deps.scheduleChartRender).toHaveBeenCalled();
    expect(deps.drawChart).not.toHaveBeenCalled();
    expect(deps.fetchCandles).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'BTC',
      timeframe: '1m',
    }));
  });

  it('starts RVWAP source hydration as soon as the destination pair is current', () => {
    candleCache.set('SOL:1m', [{ t: 1, o: '1', h: '1', l: '1', c: '1', v: '1' }]);
    const scheduleActiveRvwapHydration = vi.fn();
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ SOL: '200' })),
      fetchCandles: vi.fn(() => Promise.resolve()),
      scheduleActiveRvwapHydration,
    });
    const switchCoin = createSwitchCoin(deps);
    switchCoin('SOL');
    expect(scheduleActiveRvwapHydration).toHaveBeenCalledWith('SOL');
    expect(scheduleActiveRvwapHydration.mock.invocationCallOrder[0])
      .toBeLessThan(deps.scheduleChartRender.mock.invocationCallOrder[0]);
  });

  it('repaints immediately on no-cache coin switches so stale charts do not remain visible', async () => {
    const deps = createBaseDeps({
      getEffectiveCurrentTimeframe: vi.fn(() => '4h'),
      getEffectiveCurrentOrderType: vi.fn(() => 'market'),
      getAllMids: vi.fn(() => ({ SOL: '200' })),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);

    switchCoin('SOL');

    expect(deps.scheduleChartRender).toHaveBeenCalledTimes(1);
    expect(deps.drawChart).not.toHaveBeenCalled();
    expect(deps.refreshTickerNews).toHaveBeenCalledWith('SOL');
    expect(deps.fetchCandles).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'SOL',
    }));
  });

  it('clears stale currentPrice and refreshes chart levels on no-mid coin switches', async () => {
    window.currentPrice = 65000;
    const deps = createBaseDeps({
      getEffectiveCurrentTimeframe: vi.fn(() => '4h'),
      getEffectiveCurrentOrderType: vi.fn(() => 'market'),
      getAllMids: vi.fn(() => ({})),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);

    switchCoin('SOL');

    expect(deps.setLegacy).toHaveBeenCalledWith('currentPrice', 0);
    expect(deps.updateChartLevels).toHaveBeenCalledTimes(1);
    expect(deps.updateTopBar).toHaveBeenCalledTimes(1);
  });

  it('ignores stale hip3 mark-price completion after switching to a different coin', async () => {
    let resolveMeta;
    const metaPromise = new Promise((resolve) => {
      resolveMeta = resolve;
    });
    const deps = createBaseDeps({
      getEffectiveCurrentTimeframe: vi.fn(() => '4h'),
      getEffectiveCurrentOrderType: vi.fn(() => 'limit'),
      getAllMids: vi.fn(() => ({ 'xyz:CL': '80', BTC: '100' })),
      fetchWithDedup: vi.fn(() => metaPromise),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);
    const priceInput = document.getElementById('priceInput');
    const placeBtn = document.getElementById('placeBtn');

    switchCoin('xyz:CL');
    expect(placeBtn.disabled).toBe(true);

    switchCoin('BTC');
    expect(window.currentCoin).toBe('BTC');

    resolveMeta?.([
      { universe: [{ name: 'CL' }] },
      [{ markPx: '81.25' }],
    ]);
    await metaPromise;
    await Promise.resolve();

    expect(deps.applyTicketPrice).toHaveBeenCalledTimes(2);
    expect(window.currentPrice).toBe(100);
    expect(priceInput.placeholder).toBe('100');
    expect(placeBtn.textContent).toBe('Place Order');
  });

  it('schedules one target-owned book repaint after coin switch', async () => {
    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ BTC: '100' })),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);

    switchCoin('BTC');

    expect(deps.setDesiredMarketSubscription).toHaveBeenCalledWith({
      coin: 'BTC',
      interval: '1m',
    });
    expect(deps.subscribeMarket).toHaveBeenCalledTimes(1);
    expect(deps.cancelPendingRenders).toHaveBeenCalledTimes(1);
    expect(deps.syncActiveTradeState).toHaveBeenCalledWith('BTC', { requireCurrentEpoch: true });
    expect(deps.scheduleLayoutRender).toHaveBeenCalledWith({
      book: true,
      reason: 'symbol:BTC',
    });
    expect(deps.renderOrderFlow).not.toHaveBeenCalled();
  });

  it('skips duplicate active-asset exchange info fetches on wallet-connected coin switches', async () => {
    const deps = createBaseDeps({
      getEffectiveWalletAddress: vi.fn(() => '0x123'),
      getAllMids: vi.fn(() => ({ BTC: '100' })),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);

    switchCoin('BTC');

    expect(deps.ensureMaxLeverageDefault).toHaveBeenCalledWith('BTC');
    expect(deps.refreshExchangeInfo).toHaveBeenCalledWith('BTC', { includeActiveAssetData: false });
  });

  it('does not unlock Place while the market feed is stale', async () => {
    const { ConnectionState } = await import('../../state/store.js');
    RuntimeAppState.connection.marketState = ConnectionState.CONNECTED;
    RuntimeAppState.connection.marketUpstreamConnected = false;
    RuntimeAppState.connection.marketLastTickAt = 0;

    const deps = createBaseDeps({
      getAllMids: vi.fn(() => ({ ETH: '200' })),
      fetchCandles: vi.fn(() => Promise.resolve()),
    });
    const switchCoin = createSwitchCoin(deps);
    switchCoin('ETH');

    const placeBtn = document.getElementById('placeBtn');
    expect(placeBtn.disabled).toBe(true);
    expect(placeBtn.dataset.feedLocked).toBe('1');
  });
});
