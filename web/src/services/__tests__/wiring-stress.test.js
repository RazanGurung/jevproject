/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../ui/market-ui.js', () => ({
  applyResolvedPrice: vi.fn(async (coin, price) => {
    const { setMarketPrice } = await import('../../state/market-state.js');
    setMarketPrice(coin, price);
    if (coin === window.currentCoin) window.currentPrice = price;
  }),
  applyExchangeLeverage: vi.fn(),
  updateExchangeHtml: vi.fn(),
  applyCandles: vi.fn(async (candles) => {
    const { AppState } = await import('../../state/store.js');
    AppState.market.candles = Array.isArray(candles) ? candles : [];
    window.candles = AppState.market.candles;
  }),
  applyVwapResult: vi.fn(),
  applyBookSnapshot: vi.fn(),
  applyCoin24hChange: vi.fn(),
  applyMarketMovers: vi.fn(),
}));

vi.mock('../../chart/chart-render.js', () => ({
  scheduleChartRender: vi.fn(),
  bufferLiveChartCandle: vi.fn(),
  clearHistoryLoadState: vi.fn(),
}));

vi.mock('../../chart/lightweight-chart.js', () => ({
  syncLivePriceLine: vi.fn(),
  syncProjectedLiveCandle: vi.fn(),
  invalidateLivePriceLine: vi.fn(),
  getLivePriceLineAgeMs: vi.fn(() => 0),
}));

vi.mock('../../render/trades.js', () => ({
  renderLiquidations: vi.fn(),
  renderOrderFlow: vi.fn(),
}));

vi.mock('../../ui/tabs.js', () => ({
  applyTicketPrice: vi.fn(),
  updateSummary: vi.fn(),
  updateTicketLayoutMode: vi.fn(),
  syncLimitAutoTrackState: vi.fn(() => false),
}));

vi.mock('../../ui/toast.js', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../ui/topbar.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateTopBar: vi.fn(),
    syncPriceConsumers: vi.fn(),
  };
});

vi.mock('../../ui/signal-radar.js', () => ({
  scheduleSignalRadarRender: vi.fn(),
  renderSignalRadar: vi.fn(),
}));

vi.mock('../../services/action-feedback.js', () => ({
  notifySuccess: vi.fn(),
}));

vi.mock('../../services/wallet-service.js', () => ({
  requireKey: vi.fn(() => true),
}));

vi.mock('../../services/risk-engine.js', () => ({
  evaluateOrderRisk: vi.fn(() => ({
    allowed: true,
    mode: 'normal',
    message: 'ok',
    cappedSizeUsd: 250,
  })),
}));

vi.mock('../../services/runtime-compat.js', () => ({
  isLegacyBotRunning: vi.fn(() => false),
  scheduleLegacyBotTradeUpdate: vi.fn(),
}));

vi.mock('../../utils/frame.js', () => ({
  scheduleFrame: vi.fn((callback) => {
    callback?.();
    return 1;
  }),
}));

vi.mock('../../state/coin-meta.js', () => ({
  getTickSize: vi.fn(() => 0.1),
  getCoinDecimals: vi.fn(() => 3),
  getMaxLeverage: vi.fn(() => 20),
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createJsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (data === '' ? '' : JSON.stringify(data)),
    json: async () => data,
  };
}

function makeCandles(coin, timeframe, closes = []) {
  const intervalSeconds = timeframe === '5m' ? 300 : 60;
  return closes.map((close, index) => {
    const closeNumber = Number(close);
    const openNumber = closeNumber - 1;
    return {
      t: 1_700_000_000 + (index * intervalSeconds),
      o: String(openNumber),
      h: String(closeNumber + 1),
      l: String(openNumber - 1),
      c: String(closeNumber),
      v: String(10 + index),
      s: coin,
      i: timeframe,
    };
  });
}

function seedDom() {
  document.body.innerHTML = `
    <div id="coinTabs">
      <button id="tab-btc" class="coin-tab active" data-action="switchCoin" data-arg="BTC"></button>
      <button id="tab-sol" class="coin-tab" data-action="switchCoin" data-arg="SOL"></button>
    </div>
    <div id="coinDropdown"></div>
    <div id="chartTitle"></div>
    <div id="topPrice"></div>
    <input id="priceInput" value="108.9" />
    <input id="sizeInput" value="250" />
    <input id="tpPctInput" value="" />
    <input id="slPctInput" value="" />
    <input id="sizeSlider" value="250" />
    <div id="fundingVal"></div>
    <div id="oiVal"></div>
    <button id="placeBtn">Place Order</button>
    <select id="playbookSelect"><option selected>Manual</option></select>
  `;
}

describe('switching wiring stress', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { AppState, coin24hChanges } = await import('../../state/store.js');
    Object.keys(coin24hChanges).forEach((coin) => delete coin24hChanges[coin]);
    // This stress case isolates chart-switch wiring; RVWAP lifecycle has its
    // own dedicated source/churn coverage.
    AppState.ui.rvwapLookbacks = [];
    AppState.ui.rvwapBandLookbacks = [];
    seedDom();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.__PEZ_CONFIG__ = undefined;
    window.PriceFeed = { update: vi.fn() };
    window.chartCanvas = {};
    window.chartPreviewLevels = [];
    window.scalePreviewLevels = [];
    global.requestAnimationFrame = vi.fn((callback) => {
      callback?.();
      return 1;
    });
  });

  it('keeps active chart, stream, and order state coherent across rapid coin/timeframe switches', async () => {
    const { AppState, candleCache, setCurrentTimeframe } = await import('../../state/store.js');
    const { beginChartSession, completeChartSession, failChartSession } = await import('../../state/chart-session.js');
    const { setMarketCandles } = await import('../../state/market-state.js');
    const { setLegacy, syncLegacyGlobals } = await import('../../state/legacy-globals.js');
    const {
      setActiveCandleRequestToken,
      getActiveCandleRequestToken,
      setLimitAutoTrackForTimeframe,
      setUserEditedPrice,
    } = await import('../../state/trading-runtime.js');
    const { resetOrderState } = await import('../../state/account-state-orders.js');
    const chartRenderModule = await import('../../chart/chart-render.js');
    const tradesModule = await import('../../render/trades.js');
    const tabsModule = await import('../../ui/tabs.js');
    const topbarModule = await import('../../ui/topbar.js');
    const signalRadarModule = await import('../../ui/signal-radar.js');
    const { createSwitchCoin } = await import('../coin-switch.js');
    const { fetchCandles } = await import('../market-service.js');
    const { fetchWithDedup, hlPost } = await import('../api.js');
    const { placeOrder } = await import('../trading-service.js');
    const { handleUserFills, handleOrderUpdates } = await import('../stream-handler.js');
    const {
      getDesiredTradeCoins,
      setDesiredMarketSubscription,
    } = await import('../../state/market-subscription-state.js');
    const {
      beginTimeframeSwitch,
      completeTimeframeSwitch,
    } = await import('../../ui/ticket-chart-actions.js');
    const {
      handleBook,
      handleCandle,
      handleMids,
      handleTrades,
      resetMarketSubscriptions,
      subscribeMarket,
      syncActiveTradeState,
    } = await import('../../streams/market-ws.js');

    resetOrderState();
    resetMarketSubscriptions();
    candleCache.clear();
    window.candleCache = candleCache;

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 100;
    AppState.trading.trackedCoins = ['BTC', 'SOL'];
    AppState.trading.lastDeployedPlan = null;
    AppState.connection.marketState = 'connected';
    AppState.connection.marketUpstreamConnected = true;
    AppState.connection.marketLastTickAt = Date.now();
    AppState.market.candles = [];
    AppState.market.book = { bids: [], asks: [] };
    AppState.market.allMids = { BTC: '100', SOL: '200' };
    AppState.market.lastPriceUpdateAt = { BTC: Date.now(), SOL: Date.now() };
    AppState.market.trades = [];
    AppState.market.largeTrades = [];
    AppState.market.tradeCache = new Map();
    AppState.market.largeTradeCache = new Map();
    AppState.market.flowCache = new Map();
    AppState.market.whaleFlowCache = new Map();
    AppState.market.flowMetaCache = new Map();
    AppState.market.whaleEventCache = new Map();
    AppState.market.whaleResponseCache = new Map();
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    };
    AppState.account.openOrders = [];
    AppState.account.fills = [];
    syncLegacyGlobals();

    const pendingSnapshots = new Map();
    const subscriptionBodies = [];
    const orderBodies = [];

    global.fetch = vi.fn((url, options = {}) => {
      const resolvedUrl = String(url);
      const body = options.body ? JSON.parse(options.body) : null;

      if (resolvedUrl.endsWith('/api/market-subscribe')) {
        subscriptionBodies.push(body);
        return Promise.resolve(createJsonResponse(''));
      }

      if (resolvedUrl.endsWith('/api/order')) {
        orderBodies.push(body);
        return Promise.resolve(createJsonResponse({
          accepted: true,
          oid: 900,
          latencyMs: 5,
        }));
      }

      if (resolvedUrl.endsWith('/api/hl') && body?.type === 'candleSnapshot') {
        const key = `${body.req.coin}:${body.req.interval}`;
        const wait = deferred();
        const queue = pendingSnapshots.get(key) || [];
        queue.push(wait);
        pendingSnapshots.set(key, queue);
        return wait.promise.then((data) => createJsonResponse(data));
      }

	  if (resolvedUrl.endsWith('/api/chart-candles')) {
		const key = `${body.coin}:${body.interval}`;
		const wait = deferred();
		const queue = pendingSnapshots.get(key) || [];
		queue.push(wait);
		pendingSnapshots.set(key, queue);
		return wait.promise.then((data) => createJsonResponse(data));
	  }

      if (resolvedUrl.endsWith('/api/hl')) {
        return Promise.resolve(createJsonResponse([]));
      }

      throw new Error(`Unhandled fetch: ${resolvedUrl}`);
    });

    const resolveSnapshot = async (key, candles) => {
      const queue = pendingSnapshots.get(key) || [];
      const next = queue.shift();
      if (!next) throw new Error(`No pending snapshot for ${key}`);
      next.resolve(candles);
      await Promise.resolve();
      await Promise.resolve();
    };

    const reconcileTimeframePreview = ({ timeframe }) => {
      const requestToken = `tf:${AppState.trading.currentCoin}:${timeframe}:${Date.now()}`;
      setLimitAutoTrackForTimeframe(timeframe);
      setUserEditedPrice(false);
      setActiveCandleRequestToken(requestToken);
      return requestToken;
    };

    const switchCoin = createSwitchCoin({
      AppState,
      setLegacy,
      updateTicketLayoutMode: tabsModule.updateTicketLayoutMode,
      getEffectiveWalletAddress: () => AppState.account.walletAddress,
      getMaxLeverage: () => 20,
      ensureMaxLeverageDefault: vi.fn(),
      setBookVersion: vi.fn(),
      clearScalePreview: vi.fn(() => {
        window.chartPreviewLevels = [];
        window.scalePreviewLevels = [];
      }),
      getEffectiveCurrentTimeframe: () => AppState.trading.currentTimeframe,
      syncLimitPreviewLevels: vi.fn(() => false),
      drawChart: vi.fn(),
      scheduleChartRender: chartRenderModule.scheduleChartRender,
      coinToTabId: (coin) => coin.toLowerCase(),
      updateSizeSliderMax: vi.fn(),
      scheduleRender: vi.fn(),
      renderTwapStatus: vi.fn(),
      syncLegacyGlobals,
      resetMarketRuntimeState: vi.fn(),
      syncMarketRuntimeMirrors: vi.fn(),
      fmtPrice: (value) => String(value),
      getEffectiveCurrentOrderType: () => AppState.trading.currentOrderType,
      getAutoLimitPriceForSide: () => Number(AppState.market.allMids[AppState.trading.currentCoin] || 0),
      applyTicketPrice: tabsModule.applyTicketPrice,
      getEffectiveCurrentSide: () => AppState.trading.currentSide,
      updateTopBar: topbarModule.updateTopBar,
      updateSummary: tabsModule.updateSummary,
      syncActiveTradeState,
      renderOrderFlow: tradesModule.renderOrderFlow,
      fetchWithDedup,
      hlPost,
      subscribeMarket,
      setDesiredMarketSubscription,
      getDesiredTradeCoins,
      renderSignalRadar: signalRadarModule.renderSignalRadar,
      beginChartSession,
      completeChartSession,
      failChartSession,
      fetchCandles,
      initChart: vi.fn(),
      clearHistoryLoadState: chartRenderModule.clearHistoryLoadState,
      refreshExchangeInfo: vi.fn(),
      getAllMids: () => AppState.market.allMids,
    });

    switchCoin('SOL');
    expect(AppState.trading.currentCoin).toBe('SOL');
    expect(AppState.trading.currentTimeframe).toBe('1m');

    const sol5mToken = beginTimeframeSwitch({
      timeframe: '5m',
      tabElement: null,
      currentCoin: 'SOL',
      currentOrderType: 'limit',
      setCurrentTimeframe,
      applyTimeframeTabButton: vi.fn(),
      reconcileTimeframePreview,
      setLimitAutoTrackForTimeframe,
      resetUserEditedPrice: () => setUserEditedPrice(false),
      setActiveCandleRequestToken,
      syncLimitPreviewLevels: vi.fn(() => false),
      clearAllPreviewSync: vi.fn(),
      clearScalePreview: vi.fn(),
      getChartPreviewLevels: () => [],
      syncLimitAutoTrackState: tabsModule.syncLimitAutoTrackState,
      updateLimitPriceEntryUi: vi.fn(),
      applyPreviewButtonVisibility: vi.fn(),
      setMarketCandles,
      setDesiredMarketSubscription,
      beginChartSession,
      clearHistoryLoadState: chartRenderModule.clearHistoryLoadState,
    });
    const sol5mFetch = fetchCandles({ coin: 'SOL', timeframe: '5m', requestToken: sol5mToken });

    switchCoin('BTC');
    expect(AppState.trading.currentCoin).toBe('BTC');
    expect(AppState.trading.currentTimeframe).toBe('5m');

    const btc1mToken = beginTimeframeSwitch({
      timeframe: '1m',
      tabElement: null,
      currentCoin: 'BTC',
      currentOrderType: 'limit',
      setCurrentTimeframe,
      applyTimeframeTabButton: vi.fn(),
      reconcileTimeframePreview,
      setLimitAutoTrackForTimeframe,
      resetUserEditedPrice: () => setUserEditedPrice(false),
      setActiveCandleRequestToken,
      syncLimitPreviewLevels: vi.fn(() => false),
      clearAllPreviewSync: vi.fn(),
      clearScalePreview: vi.fn(),
      getChartPreviewLevels: () => [],
      syncLimitAutoTrackState: tabsModule.syncLimitAutoTrackState,
      updateLimitPriceEntryUi: vi.fn(),
      applyPreviewButtonVisibility: vi.fn(),
      setMarketCandles,
      setDesiredMarketSubscription,
      beginChartSession,
      clearHistoryLoadState: chartRenderModule.clearHistoryLoadState,
    });
    const btc1mFetch = fetchCandles({ coin: 'BTC', timeframe: '1m', requestToken: btc1mToken });

    await resolveSnapshot('SOL:1m', makeCandles('SOL', '1m', [200, 201]));
    await resolveSnapshot('SOL:5m', makeCandles('SOL', '5m', [202, 203]));
    await sol5mFetch;
    await resolveSnapshot('BTC:5m', makeCandles('BTC', '5m', [104, 105]));

    expect(AppState.trading.currentCoin).toBe('BTC');
    expect(AppState.trading.currentTimeframe).toBe('1m');
    expect(AppState.market.candles).toEqual([]);

    await resolveSnapshot('BTC:1m', makeCandles('BTC', '1m', [106, 107]));
    await btc1mFetch;
    await Promise.resolve();
    await Promise.resolve();

    const completed = await completeTimeframeSwitch({
      requestToken: btc1mToken,
      timeframe: '1m',
      currentCoin: 'BTC',
      getActiveCandleRequestToken,
      completeChartSession,
      loadMarketActions: async () => ({
        subscribeMarket,
      }),
      requestChartRefresh: chartRenderModule.scheduleChartRender,
    });

    expect(completed).toBe(true);
    expect(AppState.market.candles).toEqual(
      expect.arrayContaining([expect.objectContaining({ s: 'BTC', i: '1m', c: '107' })])
    );

    const staleRenderCount = tradesModule.renderOrderFlow.mock.calls.length;
    handleCandle({
      coin: 'SOL',
      interval: '1m',
      candle: { t: 1_700_000_500, o: '203', h: '204', l: '202', c: '203.5', v: '8', s: 'SOL', i: '1m' },
    });
    handleBook({
      coin: 'SOL',
      levels: [
        [{ px: '203.0', sz: '2.0' }],
        [{ px: '204.0', sz: '2.0' }],
      ],
    });
    handleTrades([{ time: 1, px: '203', sz: '20', side: 'B' }], 'SOL');

    expect(AppState.market.candles.at(-1)).toEqual(expect.objectContaining({ s: 'BTC', i: '1m', c: '107' }));
    expect(tradesModule.renderOrderFlow.mock.calls.length).toBe(staleRenderCount);

    handleMids({ mids: { BTC: '108.5', SOL: '204.2' } });
    handleBook({
      coin: 'BTC',
      levels: [
        [{ px: '108.4', sz: '2.0' }, { px: '108.3', sz: '1.5' }],
        [{ px: '108.6', sz: '1.8' }, { px: '108.7', sz: '1.2' }],
      ],
    });
    handleCandle({
      coin: 'BTC',
      interval: '1m',
      candle: { t: 1_700_000_560, o: '107', h: '110', l: '106', c: '109', v: '14', s: 'BTC', i: '1m' },
    });
    handleTrades([{ time: 2, px: '109', sz: '2500', side: 'B' }], 'BTC');

    expect(AppState.trading.currentPrice).toBe(109);
    expect(AppState.market.book.bids[0]).toEqual(
      expect.objectContaining({ price: 108.4, size: 2 })
    );
    expect(AppState.market.candles.at(-1)).toEqual(expect.objectContaining({ s: 'BTC', i: '1m', c: '109' }));
    expect(tradesModule.renderOrderFlow).toHaveBeenCalled();

    await placeOrder({
      sizeUsd: 250,
      rawLimitPrice: 108.9,
      tpPct: 0,
      slPct: 0,
      selectedPlaybook: 'Manual',
      submitButtonEl: document.getElementById('placeBtn'),
      syncSizeUsd: vi.fn(),
    });

    expect(orderBodies).toEqual([
      expect.objectContaining({
        coin: 'BTC',
        isBuy: true,
        sz: 250,
        limitPx: 108.9,
      }),
    ]);
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 900, coin: 'BTC', side: 'B' }),
    ]);

    const fillResult = await handleUserFills([
      { oid: 900, coin: 'BTC', px: '109', sz: '2.294', side: 'B', time: 3 },
    ]);

    expect(fillResult).toEqual(expect.objectContaining({
      type: 'userFills',
      filledOids: [900],
    }));
    // Fills alone no longer remove the order (a partial fill is not
    // terminal); the terminal orderUpdate that follows a full fill does.
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 900, coin: 'BTC' }),
    ]);
    handleOrderUpdates({ orderUpdates: [{ oid: 900, status: 'filled' }] });
    expect(AppState.account.openOrders).toEqual([]);
    expect(AppState.account.fills).toEqual([
      expect.objectContaining({ oid: 900, coin: 'BTC' }),
    ]);

    const snapshotCalls = global.fetch.mock.calls.filter(([url, options]) => {
	  if (!String(url).endsWith('/api/chart-candles')) return false;
      const body = JSON.parse(options.body);
	  return body?.coin && body?.interval;
    });
    const subscriptionIntents = subscriptionBodies.map((body) => `${body.coin}:${body.interval}`);
    const snapshotIntents = snapshotCalls.map(([, options]) => {
      const body = JSON.parse(options.body);
	  return `${body.coin}:${body.interval}`;
    });

    expect(snapshotIntents).toEqual(['SOL:1m', 'SOL:5m', 'BTC:5m', 'BTC:1m']);
    expect(subscriptionIntents).toEqual(['SOL:1m', 'BTC:5m', 'BTC:1m']);
    expect(getActiveCandleRequestToken()).toBe(btc1mToken);
  });
});
