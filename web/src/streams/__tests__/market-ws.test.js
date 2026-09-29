/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../chart/chart-render.js', () => ({
  scheduleChartRender: vi.fn(),
  bufferLiveChartCandle: vi.fn(),
}));

vi.mock('../../services/market-service.js', () => ({
  fetchCandles: vi.fn(),
  ensureActiveCvdRefresh: vi.fn(),
}));

vi.mock('../../render/trades.js', () => ({
  renderLiquidations: vi.fn(),
  renderOrderFlow: vi.fn(),
  renderTrades: vi.fn(),
}));

describe('market ws orderbook chart state', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="topPrice"></div><input id="priceInput" />';
    window.updateTopBar = vi.fn();
    window.updateSummary = vi.fn();
    window.syncLimitPreviewLevels = vi.fn(() => false);
    window.limitPriceAutoTrack = true;
    window.limitPreviewAutoTrack = true;
    window.userEditedPrice = false;
    window.PriceFeed = { update: vi.fn() };
    window.currentOrderType = 'limit';
    window.currentSide = 'buy';
    window.__PEZ_CONFIG__ = undefined;
    window.sessionStorage.clear();
    global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  });

  it('writes live orderbook depth into the canonical book state', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setBookVersion } = await import('../../state/runtime-mirrors.js');
    const { handleBook } = await import('../market-ws.js');

    setBookVersion(0);
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.book = { bids: [], asks: [] };

    handleBook({
      coin: 'BTC',
      levels: [
        [{ px: '100.0', sz: '2.0' }, { px: '99.5', sz: '3.0' }],
        [{ px: '100.5', sz: '1.5' }, { px: '101.0', sz: '4.0' }],
      ],
    });

    expect(AppState.market.book.bids).toHaveLength(2);
    expect(AppState.market.book.asks).toHaveLength(2);
    expect(AppState.market.book.bids[0]).toEqual(
      expect.objectContaining({ price: 100, size: 2 })
    );
    expect(AppState.market.book.asks[0]).toEqual(
      expect.objectContaining({ price: 100.5, size: 1.5 })
    );
    expect(AppState.market.book.bids).toHaveLength(2);
  });

  it('ignores partial book payloads without bumping book version or mutating the last good snapshot', async () => {
    const { AppState } = await import('../../state/store.js');
    const { getBookVersionValue, setBookVersion } = await import('../../state/runtime-mirrors.js');
    const { handleBook } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.market.book = {
      bids: [{ px: 100, sz: 2, price: 100, size: 2 }],
      asks: [{ px: 101, sz: 3, price: 101, size: 3 }],
    };
    setBookVersion(4);

    handleBook({
      coin: 'BTC',
      levels: [
        [{ px: '99.5', sz: '1.0' }],
        null,
      ],
    });

    expect(getBookVersionValue()).toBe(4);
    expect(AppState.market.book).toEqual({
      bids: [{ px: 100, sz: 2, price: 100, size: 2 }],
      asks: [{ px: 101, sz: 3, price: 101, size: 3 }],
    });
  });

  it('caches a background (non-active) coin\'s book without touching the active render state', async () => {
    const { AppState } = await import('../../state/store.js');
    const { getBookVersionValue, setBookVersion } = await import('../../state/runtime-mirrors.js');
    const { getCachedBook } = await import('../../state/market-book.js');
    const { handleBook } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.market.book = { bids: [], asks: [] };
    AppState.market.bookCache = new Map();
    setBookVersion(0);

    handleBook({
      coin: 'ETH',
      levels: [
        [{ px: '3000', sz: '1.0' }],
        [{ px: '3001', sz: '2.0' }],
      ],
    });

    // Cached for the background coin...
    const cached = getCachedBook(AppState.market, 'ETH');
    expect(cached).not.toBeNull();
    expect(cached.bids).toHaveLength(1);

    // ...but the active coin's render-facing state is untouched.
    expect(AppState.market.book).toEqual({ bids: [], asks: [] });
    expect(getBookVersionValue()).toBe(0);
  });

  it('still caches the active coin\'s own book alongside its normal live-update behavior', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setBookVersion } = await import('../../state/runtime-mirrors.js');
    const { getCachedBook } = await import('../../state/market-book.js');
    const { handleBook } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.book = { bids: [], asks: [] };
    AppState.market.bookCache = new Map();
    setBookVersion(0);

    handleBook({
      coin: 'BTC',
      levels: [
        [{ px: '100.0', sz: '2.0' }],
        [{ px: '100.5', sz: '1.5' }],
      ],
    });

    expect(AppState.market.book.bids).toHaveLength(1);
    const cached = getCachedBook(AppState.market, 'BTC');
    expect(cached).not.toBeNull();
    expect(cached.bids).toBe(AppState.market.book.bids);
  });

  it('treats canonical market candles as the primary live candle buffer', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setBookVersion } = await import('../../state/runtime-mirrors.js');
    const { handleCandle } = await import('../market-ws.js');

    setBookVersion(0);
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.candles = [
      { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10', s: 'BTC', i: '1m' },
    ];
    handleCandle({
      coin: 'BTC',
      interval: '1m',
      candle: { t: 1060, o: '100', h: '103', l: '99', c: '102', v: '12', s: 'BTC', i: '1m' },
    });

    expect(AppState.market.candles).toHaveLength(2);
    expect(AppState.market.candles[1]).toEqual(
      expect.objectContaining({ t: 1060, c: '102' })
    );
  });

  it('updates the dedicated RVWAP source even when the generic 4h cache is absent', async () => {
    const {
      AppState,
      candleCache,
      rvwapSourceCache,
      setRvwapSourceCacheEntry,
    } = await import('../../state/store.js');
    const { handleCandle } = await import('../market-ws.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';
    AppState.market.rvwapSource = {
      coin: 'BTC',
      interval: '4h',
      status: 'ready',
      count: 1,
      firstTime: 1000 * 1000,
      lastTime: 1000 * 1000,
    };
    setRvwapSourceCacheEntry('BTC', [
      { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10', s: 'BTC', i: '4h' },
    ]);
    candleCache.delete('BTC:4h');

    handleCandle({
      coin: 'BTC',
      interval: '4h',
      candle: { t: 15400, o: '100', h: '103', l: '99', c: '102', v: '12', s: 'BTC', i: '4h' },
    });

    expect(candleCache.has('BTC:4h')).toBe(false);
    expect(rvwapSourceCache.get('BTC')).toHaveLength(2);
    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({
      count: 2,
      firstTime: 1000 * 1000,
      lastTime: 15400 * 1000,
    }));
  });

  it('stages live 4h candles while the RVWAP history snapshot is loading', async () => {
    const { AppState, rvwapSourceCache } = await import('../../state/store.js');
    const { handleCandle } = await import('../market-ws.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';
    AppState.market.rvwapSource = {
      coin: 'BTC', interval: '4h', status: 'loading', complete: false,
    };

    handleCandle({
      coin: 'BTC',
      interval: '4h',
      candle: { t: 15400, o: '100', h: '103', l: '99', c: '102', v: '12', s: 'BTC', i: '4h' },
    });

    expect(rvwapSourceCache.get('BTC')).toEqual([
      expect.objectContaining({ t: 15400, c: '102' }),
    ]);
    expect(AppState.market.rvwapSource.status).toBe('loading');
  });

  it('rechecks active CVD enrichment when a new candle can complete the prior thin-market tail', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleCandle } = await import('../market-ws.js');
    const { ensureActiveCvdRefresh } = await import('../../services/market-service.js');
    ensureActiveCvdRefresh.mockClear();

    AppState.trading.currentCoin = 'xyz:SKHX';
    AppState.trading.currentTimeframe = '1h';
    AppState.market.candles = [
      { t: 1000, o: '100', h: '102', l: '99', c: '101', v: '12', s: 'xyz:SKHX', i: '1h' },
    ];

    handleCandle({
      coin: 'xyz:SKHX',
      interval: '1h',
      candle: { t: 4600, o: '101', h: '103', l: '100', c: '102', v: '4', s: 'xyz:SKHX', i: '1h', cvdDelta: 2 },
    });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ensureActiveCvdRefresh).toHaveBeenCalledWith(
      'xyz:SKHX',
      '1h',
      AppState.market.candles,
    );
  });

  it('replaces the active 1m candle with a fresh buffer when the timestamp matches', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setBookVersion } = await import('../../state/runtime-mirrors.js');
    const { handleCandle } = await import('../market-ws.js');
    const { bufferLiveChartCandle } = await import('../../chart/chart-render.js');

    setBookVersion(0);
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    const initialCandles = [
      { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10', s: 'BTC', i: '1m' },
      { t: 1060, o: '100', h: '103', l: '99', c: '102', v: '12', s: 'BTC', i: '1m' },
    ];
    AppState.market.candles = initialCandles;

    handleCandle({
      coin: 'BTC',
      interval: '1m',
      candle: { t: 1060, o: '100', h: '104', l: '99', c: '103', v: '14', s: 'BTC', i: '1m' },
    });

    expect(AppState.market.candles).toHaveLength(2);
    expect(AppState.market.candles).not.toBe(initialCandles);
    expect(AppState.market.candles[1]).toEqual(
      expect.objectContaining({ t: 1060, h: '104', c: '103', v: '14' })
    );
    expect(bufferLiveChartCandle).toHaveBeenCalledWith(
      expect.objectContaining({
        candle: expect.objectContaining({ t: 1060, c: '103' }),
        candles: AppState.market.candles,
        timeframe: '1m',
      })
    );
  });

  it('requests an active snapshot refresh when a streamed candle skips over a 1m gap', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setBookVersion } = await import('../../state/runtime-mirrors.js');
    const { handleCandle } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');

    setBookVersion(0);
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.candles = [
      { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10', s: 'BTC', i: '1m' },
    ];

    handleCandle({
      coin: 'BTC',
      interval: '1m',
      candle: { t: 1180, o: '100', h: '103', l: '99', c: '102', v: '12', s: 'BTC', i: '1m' },
    });

    await vi.waitFor(() => {
      expect(fetchCandles).toHaveBeenCalledWith(expect.objectContaining({
        coin: 'BTC',
        timeframe: '1m',
        forceAuthoritative: true,
        repairFromTime: 1000,
      }));
    });
  });

  it('posts market subscriptions to the resolved API base with a stable client id', async () => {
    window.__PEZ_CONFIG__ = { apiBaseUrl: 'https://api.example.test/base' };
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    global.fetch = fetchMock;

    const { subscribeMarket } = await import('../market-ws.js');

    await subscribeMarket('BTC', '1m', new Set(['BTC', 'ETH']));

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/base/api/market-subscribe');
    const body = JSON.parse(options.body);
    expect(body.coin).toBe('BTC');
    expect(body.interval).toBe('1m');
    expect(body.tradeCoins).toEqual(['BTC', 'ETH']);
    expect(typeof body.clientId).toBe('string');
    expect(body.clientId.length).toBeGreaterThan(0);
  });

  it('rebuilds the warm trade set when coin is set without tradeCoins', async () => {
    window.__PEZ_CONFIG__ = { apiBaseUrl: 'https://api.example.test/base' };
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    global.fetch = fetchMock;
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.trackedCoins = ['ETH', 'SOL'];
    AppState.trading.recentCoins = ['ETH', 'SOL'];
    const { subscribeMarket } = await import('../market-ws.js');

    await subscribeMarket('BTC', '2h');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tradeCoins).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('hydrates accepted pairs from subscription flow snapshots before their next trade', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        acceptedTradeCoins: ['BTC', 'ETH'],
        droppedTradeCoins: ['SOL'],
        flowSnapshots: {
          ETH: {
            buyVol: 1200, sellVol: 800, whaleBuyVol: 0, whaleSellVol: 0,
            sampleCount: 20, sampleCapacity: 500, oldestTimeMs: 100, newestTimeMs: 200,
          },
        },
      }),
    });
    const { AppState } = await import('../../state/store.js');
    const { subscribeMarket } = await import('../market-ws.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.market.flowCache = new Map();
    AppState.market.whaleFlowCache = new Map();
    AppState.market.flowMetaCache = new Map();

    await subscribeMarket('BTC', '1m', ['BTC', 'ETH', 'SOL']);

    expect(AppState.connection.acceptedTradeCoins).toEqual(['BTC', 'ETH']);
    expect(AppState.connection.droppedTradeCoins).toEqual(['SOL']);
    expect(AppState.market.flowCache.get('ETH')).toEqual(expect.objectContaining({
      buyVol: 1200, sellVol: 800, sampleCount: 20, sampleCapacity: 500,
    }));
  });

  it('repaints active Flow within one frame after subscription hydration', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        acceptedTradeCoins: ['BTC'],
        flowSnapshots: {
          BTC: { revision: 4, buyVol: 4000, sellVol: 2000, sampleCount: 40, sampleCapacity: 500 },
        },
      }),
    });
    const { AppState } = await import('../../state/store.js');
    const { subscribeMarket } = await import('../market-ws.js');
    const tradesRenderModule = await import('../../render/trades.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.connection.marketState = 'connected';
    AppState.connection.marketEpoch = 3;
    tradesRenderModule.renderOrderFlow.mockClear();

    await subscribeMarket('BTC', '1m', ['BTC']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(AppState.market.orderFlow).toEqual(expect.objectContaining({ buyVol: 4000, sampleCount: 40 }));
    expect(tradesRenderModule.renderOrderFlow).toHaveBeenCalled();
  });

  it('ignores an older HTTP Flow revision that resolves after a newer trade snapshot', async () => {
    let resolveFetch;
    global.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const { AppState } = await import('../../state/store.js');
    const { handleTrades, subscribeMarket } = await import('../market-ws.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.connection.marketState = 'connected';
    AppState.connection.marketEpoch = 6;

    const pending = subscribeMarket('BTC', '1m', ['BTC']);
    handleTrades([{ tid: 9, time: 9, px: '100', sz: '1', side: 'B' }], 'BTC', {
      flow: { revision: 9, buyVol: 9000, sellVol: 900, sampleCount: 9 },
    });
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        acceptedTradeCoins: ['BTC'],
        flowSnapshots: { BTC: { revision: 8, buyVol: 8000, sellVol: 800, sampleCount: 8 } },
      }),
    });
    await pending;

    expect(AppState.market.flowCache.get('BTC')).toEqual(expect.objectContaining({ buyVol: 9000, sampleCount: 9 }));
    expect(AppState.market.flowFreshnessCache.get('BTC').revision).toBe(9);
  });

  it('ignores superseded A to B to A subscription responses', async () => {
    const pendingFetches = [];
    global.fetch = vi.fn(() => new Promise((resolve) => pendingFetches.push(resolve)));
    const { AppState } = await import('../../state/store.js');
    const { subscribeMarket } = await import('../market-ws.js');
    AppState.connection.marketState = 'connected';
    AppState.connection.marketEpoch = 7;

    AppState.trading.currentCoin = 'BTC';
    const firstA = subscribeMarket('BTC', '1m', ['BTC']);
    AppState.trading.currentCoin = 'ETH';
    const b = subscribeMarket('ETH', '1m', ['ETH']);
    AppState.trading.currentCoin = 'BTC';
    const finalA = subscribeMarket('BTC', '1m', ['BTC']);
    expect(pendingFetches).toHaveLength(3);

    const response = (body) => ({ ok: true, status: 200, json: async () => body });
    pendingFetches[2](response({
      acceptedTradeCoins: ['BTC'],
      flowSnapshots: { BTC: { revision: 30, buyVol: 3000, sampleCount: 30 } },
    }));
    await finalA;
    pendingFetches[1](response({
      acceptedTradeCoins: ['ETH'],
      flowSnapshots: { ETH: { revision: 20, buyVol: 2000, sampleCount: 20 } },
    }));
    pendingFetches[0](response({
      acceptedTradeCoins: ['BTC'],
      flowSnapshots: { BTC: { revision: 10, buyVol: 1000, sampleCount: 10 } },
    }));
    await Promise.all([firstA, b]);

    expect(AppState.connection.acceptedTradeCoins).toEqual(['BTC']);
    expect(AppState.market.flowCache.get('BTC')).toEqual(expect.objectContaining({ buyVol: 3000, sampleCount: 30 }));
    expect(AppState.market.flowCache.has('ETH')).toBe(false);
  });

  it('invalidates Flow freshness on a new stream epoch without deleting caches', async () => {
    const { AppState } = await import('../../state/store.js');
    const { applyFlowSnapshot } = await import('../../state/market-trades.js');
    const { beginMarketStreamEpoch, syncActiveTradeState } = await import('../market-ws.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.connection.marketState = 'connected';
    AppState.connection.marketEpoch = 11;
    AppState.connection.acceptedTradeCoins = ['BTC'];
    applyFlowSnapshot(AppState.market, 'BTC', {
      revision: 5, buyVol: 5000, sellVol: 1000, sampleCount: 50,
    }, { marketEpoch: 11 });
    syncActiveTradeState('BTC', { requireCurrentEpoch: true });
    expect(AppState.market.orderFlow.buyVol).toBe(5000);

    beginMarketStreamEpoch();

    expect(AppState.connection.marketEpoch).toBe(12);
    expect(AppState.market.orderFlow.sampleCount).toBe(0);
    expect(AppState.market.flowCache.get('BTC').buyVol).toBe(5000);
    expect(AppState.market.flowFreshnessCache.get('BTC').marketEpoch).toBe(11);
  });

  it('does not repost identical market subscription intent for the same client', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    global.fetch = fetchMock;

    const { subscribeMarket } = await import('../market-ws.js');

    await subscribeMarket('BTC', '1m', ['BTC', 'ETH']);
    await subscribeMarket('BTC', '1m', ['BTC', 'ETH']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reposts identical market subscription intent after resetMarketSubscriptions', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    global.fetch = fetchMock;

    const { subscribeMarket, resetMarketSubscriptions } = await import('../market-ws.js');

    await subscribeMarket('BTC', '1m', ['BTC', 'ETH']);
    resetMarketSubscriptions();
    await subscribeMarket('BTC', '1m', ['BTC', 'ETH']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('subscribes from canonical market subscription intent when called without arguments', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    global.fetch = fetchMock;

    const { setDesiredMarketSubscription } = await import('../../state/market-subscription-state.js');
    const { subscribeMarket } = await import('../market-ws.js');

    setDesiredMarketSubscription({
      coin: 'SOL',
      interval: '5m',
      tradeCoins: ['BTC', 'SOL'],
    });
    await subscribeMarket();

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.coin).toBe('SOL');
    expect(body.interval).toBe('5m');
    expect(body.tradeCoins).toEqual(['BTC', 'SOL']);
  });

  it('does not stringify an overrides object into coin [object Object]', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    global.fetch = fetchMock;

    const { AppState } = await import('../../state/store.js');
    const { setDesiredMarketSubscription } = await import('../../state/market-subscription-state.js');
    const { subscribeMarket } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';
    setDesiredMarketSubscription({
      coin: 'BTC',
      interval: '2h',
      tradeCoins: ['BTC'],
    });
    await subscribeMarket({ coin: 'ETH', interval: '4h' });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.coin).toBe('BTC');
    expect(body.coin).not.toBe('[object Object]');
  });

  it('sends the dedicated 4h indicator interval while an RVWAP is enabled', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    global.fetch = fetchMock;

    const { setRvwapLookbackVisible } = await import('../../state/store.js');
    const { setDesiredMarketSubscription } = await import('../../state/market-subscription-state.js');
    const { subscribeMarket } = await import('../market-ws.js');
    setRvwapLookbackVisible('90D', true);
    setDesiredMarketSubscription({ coin: 'BTC', interval: '2h', tradeCoins: ['BTC'] });
    await subscribeMarket();

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).indicatorIntervals).toEqual(['4h']);
  });

  it('does not repost an identical market subscription while the first request is still in flight', async () => {
    let resolveFetch;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    global.fetch = fetchMock;

    const { subscribeMarket } = await import('../market-ws.js');

    const first = subscribeMarket('BTC', '1m', ['BTC']);
    const second = subscribeMarket('BTC', '1m', ['BTC']);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, status: 200 });
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not commit subscription dedupe state when market-subscribe fails', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = fetchMock;

    const { subscribeMarket } = await import('../market-ws.js');

    const first = subscribeMarket('BTC', '1m', ['BTC', 'ETH']);
    await vi.runAllTimersAsync();
    await first;
    const second = subscribeMarket('BTC', '1m', ['BTC', 'ETH']);
    await second;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('coalesces active trade panel rendering to one animation frame per trade burst', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleTrades } = await import('../market-ws.js');
    const tradesRenderModule = await import('../../render/trades.js');

    const callbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      callbacks.push(cb);
      return callbacks.length;
    });

    AppState.trading.currentCoin = 'BTC';

    handleTrades([{ time: 1, px: '100', sz: '100', side: 'B' }], 'BTC');
    handleTrades([{ time: 2, px: '101', sz: '100', side: 'A' }], 'BTC');

    expect(tradesRenderModule.renderOrderFlow).not.toHaveBeenCalled();

    callbacks.forEach((cb) => cb?.());

    expect(tradesRenderModule.renderOrderFlow).toHaveBeenCalledTimes(1);
  });

  it('attributes trade bursts to the payload coin when the relay uses symbol field s', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleTrades } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.market.tradeCache = new Map();
    AppState.market.largeTradeCache = new Map();
    AppState.market.liquidationCache = new Map();
    AppState.market.flowCache = new Map();
    AppState.market.whaleFlowCache = new Map();

    handleTrades([{ time: 1, px: '100', sz: '2', side: 'B', s: 'ETH' }], '');

    expect(AppState.market.tradeCache.get('ETH')).toEqual([
      expect.objectContaining({ coin: 'ETH', s: 'ETH' }),
    ]);
    expect(AppState.market.tradeCache.get('BTC') || []).toEqual([]);
  });

  it('renders the backend-cached per-coin rolling flow as-is when activating a coin', async () => {
    const { AppState } = await import('../../state/store.js');
    const { syncActiveTradeState } = await import('../market-ws.js');

    // The backend owns exact window eviction; the browser only mirrors the
    // per-coin flow cache into the active render slice.
    AppState.trading.currentCoin = 'BTC';
    AppState.market.flowCache = new Map([['BTC', { buyVol: 1000, sellVol: 500 }]]);
    AppState.market.whaleFlowCache = new Map([['BTC', { buyVol: 400, sellVol: 200 }]]);
    AppState.market.tradeCache = new Map([['BTC', []]]);
    AppState.market.largeTradeCache = new Map([['BTC', []]]);
    AppState.market.liquidationCache = new Map([['BTC', []]]);

    syncActiveTradeState('BTC');

    expect(AppState.market.orderFlow).toEqual({ buyVol: 1000, sellVol: 500 });
    expect(AppState.market.largeTradeFlow).toEqual({ buyVol: 400, sellVol: 200 });
  });

  it('does not copy an ineligible Flow cache onto the HUD when a tick has no _flow', async () => {
    const { AppState } = await import('../../state/store.js');
    const { applyFlowSnapshot } = await import('../../state/market-trades.js');
    const { beginMarketStreamEpoch, handleTrades } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.connection.marketState = 'connected';
    AppState.connection.marketEpoch = 11;
    AppState.connection.acceptedTradeCoins = ['BTC'];
    applyFlowSnapshot(AppState.market, 'BTC', {
      revision: 5, buyVol: 5000, sellVol: 1000, sampleCount: 50,
    }, { marketEpoch: 11 });

    beginMarketStreamEpoch();
    expect(AppState.market.orderFlow.sampleCount).toBe(0);

    handleTrades([{ time: 1, px: '100', sz: '1', side: 'B' }], 'BTC');

    expect(AppState.market.orderFlow).toEqual(expect.objectContaining({
      buyVol: 0, sellVol: 0, sampleCount: 0,
    }));
    expect(AppState.market.flowCache.get('BTC').buyVol).toBe(5000);
  });

  it('applies the backend _flow annotation from a trades message', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleTrades } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.market.tradeCache = new Map();
    AppState.market.largeTradeCache = new Map();
    AppState.market.flowCache = new Map();
    AppState.market.whaleFlowCache = new Map();

    handleTrades([{ time: 1, px: '100', sz: '2', side: 'B' }], 'BTC', {
      flow: {
        buyVol: 1000, sellVol: 500, whaleBuyVol: 400, whaleSellVol: 200,
        sampleCount: 2, sampleCapacity: 500, oldestTimeMs: 1, newestTimeMs: 2,
      },
    });

    expect(AppState.market.flowCache.get('BTC')).toEqual(expect.objectContaining({
      buyVol: 1000, sellVol: 500, sampleCount: 2, sampleCapacity: 500,
    }));
    expect(AppState.market.orderFlow).toEqual(expect.objectContaining({ buyVol: 1000, sellVol: 500, sampleCount: 2 }));
    expect(AppState.market.largeTradeFlow).toEqual(expect.objectContaining({ buyVol: 400, sellVol: 200, sampleCount: 2 }));
  });

  it('refreshes the active 1m chart and tracked ticket input on mids updates', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleMids } = await import('../market-ws.js');
    const { scheduleChartRender } = await import('../../chart/chart-render.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.candles = [{ t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' }];

    const priceInput = document.getElementById('priceInput');

    handleMids({
      mids: { BTC: '105' },
    });

    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(AppState.trading.currentPrice).toBe(105);
    expect(scheduleChartRender).toHaveBeenCalled();
    expect(priceInput.value).not.toBe('');
    expect(window.userEditedPrice).toBe(false);
  });

  it('keeps overwriting the 1m auto-tracked ticket price on repeated mids updates', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleMids } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';

    const priceInput = document.getElementById('priceInput');

    handleMids({ mids: { BTC: '105.26' } });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Auto-track uses snapToTick + trimTrailingZeros:false to display the
    // coin's tick precision (BTC → 2 decimals).
    expect(priceInput.value).toBe('105.50');

    handleMids({ mids: { BTC: '106.24' } });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(priceInput.value).toBe('106.00');
  });

  it('schedules DOM ladder render on active coin allMids update', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleMids } = await import('../market-ws.js');
    const runtime = await import('../market-render-runtime.js');
    const spy = vi.spyOn(runtime, 'scheduleLiveDomLadderRender');

    AppState.trading.currentCoin = 'BTC';
    handleMids({ mids: { BTC: '105' } });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('applies current price when a trade breaches the inside book spread', async () => {
    const { AppState } = await import('../../state/store.js');
    const { handleTrades } = await import('../market-ws.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.market.book = {
      bids: [{ px: 100, sz: 2 }],
      asks: [{ px: 101, sz: 3 }],
    };

    // Trade sweeping above ask
    handleTrades([{ time: 1000, px: '103.5', sz: '1', side: 'B', coin: 'BTC' }], 'BTC');
    expect(AppState.trading.currentPrice).toBe(103.5);
    expect(AppState.market.allMids.BTC).toBe('103.5');

    // Trade sweeping below bid
    handleTrades([{ time: 1001, px: '98.5', sz: '1', side: 'A', coin: 'BTC' }], 'BTC');
    expect(AppState.trading.currentPrice).toBe(98.5);
    expect(AppState.market.allMids.BTC).toBe('98.5');
  });

  it('backfills the active chart on resume when the in-memory candle tail is stale', async () => {
    const { AppState } = await import('../../state/store.js');
    const { recoverActiveCandlesIfStale } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');
    fetchCandles.mockClear();

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    const nowSec = Math.floor(Date.now() / 1000);
    AppState.market.candles = [
      { t: nowSec - 600, o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];

    expect(recoverActiveCandlesIfStale()).toBe(true);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCandles).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'BTC', timeframe: '1m', forceAuthoritative: true,
    }));

    // Cooldown: an immediate second probe still reports the gap but does not
    // issue another fetch.
    recoverActiveCandlesIfStale();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('backfills a high-timeframe chart immediately after reconnect when it predates the current bucket', async () => {
    const { AppState } = await import('../../state/store.js');
    const { recoverActiveCandlesAfterReconnect } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');
    fetchCandles.mockClear();

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '4h';
    const interval = 4 * 60 * 60;
    const now = Date.now();
    const currentBucket = Math.floor(now / 1000 / interval) * interval;
    AppState.market.candles = [
      { t: currentBucket - interval, o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];

    expect(recoverActiveCandlesAfterReconnect(now)).toBe(true);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCandles).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'BTC', timeframe: '4h', forceAuthoritative: true,
    }));
  });

  it('does not treat a current calendar-month 1M bar as stale after reconnect', async () => {
    const { AppState } = await import('../../state/store.js');
    const { recoverActiveCandlesAfterReconnect } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');
    fetchCandles.mockClear();

    const now = Date.UTC(2026, 7, 13, 18, 0, 0);
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1M';
    AppState.market.candles = [
      { t: Date.UTC(2026, 7, 1) / 1000, o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];

    expect(recoverActiveCandlesAfterReconnect(now)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('does not treat a current Monday-aligned 1w bar as stale on Thursday reconnect', async () => {
    const { AppState } = await import('../../state/store.js');
    const { recoverActiveCandlesAfterReconnect } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');
    fetchCandles.mockClear();

    const now = Date.UTC(2026, 7, 13, 18, 0, 0);
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1w';
    AppState.market.candles = [
      { t: Date.UTC(2026, 7, 10) / 1000, o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];

    expect(recoverActiveCandlesAfterReconnect(now)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCandles).not.toHaveBeenCalled();
  });

  it('backfills 1M after reconnect when the tail is still the previous calendar month', async () => {
    const { AppState } = await import('../../state/store.js');
    const { recoverActiveCandlesAfterReconnect } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');
    fetchCandles.mockClear();

    const now = Date.UTC(2026, 7, 13, 18, 0, 0);
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1M';
    AppState.market.candles = [
      { t: Date.UTC(2026, 6, 1) / 1000, o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];

    expect(recoverActiveCandlesAfterReconnect(now)).toBe(true);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCandles).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'BTC', timeframe: '1M', forceAuthoritative: true,
    }));
  });

  it('forces a same-bucket SKHX snapshot after browser suspension', async () => {
    const { AppState } = await import('../../state/store.js');
    const { recoverActiveCandlesIfStale } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');
    fetchCandles.mockClear();

    AppState.trading.currentCoin = 'xyz:SKHX';
    AppState.trading.currentTimeframe = '4h';
    const interval = 4 * 60 * 60;
    const now = Date.now();
    const currentBucket = Math.floor(now / 1000 / interval) * interval;
    AppState.market.candles = [
      {
        t: currentBucket,
        o: '186000',
        h: '187000',
        l: '185000',
        c: '186500',
        v: '12',
        cvdDelta: 3,
      },
    ];

    expect(recoverActiveCandlesIfStale(now, { forceAuthoritative: true })).toBe(true);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchCandles).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'xyz:SKHX',
      timeframe: '4h',
      forceAuthoritative: true,
      repairFromTime: currentBucket,
    }));
  });

  it('skips the resume backfill when the in-memory candle tail is fresh', async () => {
    const { AppState } = await import('../../state/store.js');
    const { recoverActiveCandlesIfStale } = await import('../market-ws.js');
    const { fetchCandles } = await import('../../services/market-service.js');
    fetchCandles.mockClear();

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    const nowSec = Math.floor(Date.now() / 1000);
    AppState.market.candles = [
      { t: nowSec - 30, o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];

    expect(recoverActiveCandlesIfStale()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCandles).not.toHaveBeenCalled();
  });
});
