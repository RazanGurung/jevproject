/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(rows) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
  };
}

describe('market service', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    global.fetch = vi.fn();
    window.scheduleOrderbookRender = vi.fn();
    window.updateTopBar = vi.fn();
    window.PriceFeed = { update: vi.fn() };
    // book lives on AppState
    // Most service fixtures isolate the visible-candle request. Tests that
    // exercise the dedicated RVWAP source enable it explicitly.
    const { AppState, setCurrentCoin, rvwapSourceCache, rvwapSourceMetaCache } = await import('../../state/store.js');
    AppState.ui.rvwapLookbacks = [];
    AppState.ui.rvwapBandLookbacks = [];
    setCurrentCoin('BTC');
    rvwapSourceCache.clear();
    rvwapSourceMetaCache.clear();
  });

  afterEach(async () => {
    const { cancelRvwapHydrationWork, cancelRvwapSourceRetries } = await import('../market-service.js');
    cancelRvwapHydrationWork();
    cancelRvwapSourceRetries();
    vi.useRealTimers();
  });

  it('hydrates the canonical book from L2 snapshot fallback', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        levels: [
          [{ px: '100.0', sz: '2.0' }, { px: '99.5', sz: '3.0' }],
          [{ px: '100.5', sz: '1.5' }, { px: '101.0', sz: '4.0' }],
        ],
      }),
    });

    const { AppState } = await import('../../state/store.js');
    AppState.market.book = { bids: [], asks: [] };

    const { fetchL2Snapshot } = await import('../market-service.js');
    await fetchL2Snapshot('BTC');

    expect(AppState.market.book.bids[0]).toEqual(
      expect.objectContaining({ px: 100, sz: 2, price: 100, size: 2 })
    );
    expect(AppState.market.book.asks[0]).toEqual(
      expect.objectContaining({ px: 100.5, sz: 1.5, price: 100.5, size: 1.5 })
    );
    expect(AppState.market.book.bids).toHaveLength(2);
    expect(AppState.market.book.asks).toHaveLength(2);
  });

  it('deduplicates concurrent candle snapshot fetches for the same coin and timeframe', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
        { t: 2, o: '100.5', h: '102', l: '100', c: '101', v: '12' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');

    const [first, second] = await Promise.all([
      fetchCandles({ coin: 'BTC', timeframe: '1m', background: true }),
      fetchCandles({ coin: 'BTC', timeframe: '1m', background: true }),
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
  });

  it('loads one dedicated 600-day 4h RVWAP source for concurrent callers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));
    const now = Date.now();
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: Math.floor((now - 600 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
        { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      ]),
    });

    const { AppState, rvwapSourceCache } = await import('../../state/store.js');
    const { ensureRvwapSource } = await import('../market-service.js');
    const [first, second] = await Promise.all([
      ensureRvwapSource({ coin: 'BTC' }),
      ensureRvwapSource({ coin: 'BTC' }),
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, request] = global.fetch.mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body.interval).toBe('4h');
    expect(Number(body.endTime) - Number(body.startTime)).toBe(600 * 24 * 60 * 60 * 1000);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(rvwapSourceCache.get('BTC')).toHaveLength(2);
    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({
      coin: 'BTC',
      interval: '4h',
      status: 'ready',
      count: 2,
    }));
    vi.useRealTimers();
  });

  it('uses a completed background hydration immediately when RVWAP is selected', async () => {
    const now = Math.floor(Date.now() / 1000);
    global.fetch.mockResolvedValue(jsonResponse([
      { t: now - 600 * 24 * 60 * 60, o: '100', h: '102', l: '99', c: '101', v: '10' },
      { t: now, o: '101', h: '103', l: '100', c: '102', v: '12' },
    ]));

    const { setCurrentCoin } = await import('../../state/store.js');
    const { hydrateRvwapSource, ensureRvwapSource } = await import('../market-service.js');
    setCurrentCoin('BTC');
    const hydrated = await hydrateRvwapSource({ coin: 'BTC', updateActive: true });
    const selected = await ensureRvwapSource({ coin: 'BTC' });

    expect(hydrated).toHaveLength(2);
    expect(selected).toEqual(hydrated);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).urgency).toBe('hydrate');
  });

  it('treats a 202 hydration probe as pending without poisoning the source cache', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ status: 'warming' }),
    });

    const { rvwapSourceCache, rvwapSourceMetaCache } = await import('../../state/store.js');
    const { hydrateRvwapSource } = await import('../market-service.js');
    const result = await hydrateRvwapSource({ coin: 'BTC' });

    expect(result).toBeNull();
    expect(rvwapSourceCache.has('BTC')).toBe(false);
    expect(rvwapSourceMetaCache.has('BTC')).toBe(false);
  });

  it('probes the active coin first and then every accepted watchlist coin', async () => {
    const now = Math.floor(Date.now() / 1000);
    global.fetch.mockImplementation(async (_url, options) => {
      const { coin } = JSON.parse(options.body);
      return jsonResponse([
        { t: now - 600 * 24 * 60 * 60, o: '100', h: '102', l: '99', c: '101', v: '10', s: coin, i: '4h' },
        { t: now, o: '101', h: '103', l: '100', c: '102', v: '12', s: coin, i: '4h' },
      ]);
    });

    const { setCurrentCoin } = await import('../../state/store.js');
    const { setWatchlistRvwapHydration, stopWatchlistRvwapHydration } = await import('../market-service.js');
    setCurrentCoin('BTC');
    setWatchlistRvwapHydration(['ETH', 'SOL']);

    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
    const bodies = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies.map((body) => body.coin)).toEqual(['BTC', 'ETH', 'SOL']);
    expect(bodies.every((body) => body.urgency === 'hydrate')).toBe(true);
    stopWatchlistRvwapHydration();
  });

  it('merges a staged live 4h row over a late hydration snapshot', async () => {
    const pending = deferred();
    const now = Math.floor(Date.now() / 1000);
    global.fetch.mockReturnValue(pending.promise);

    const { rvwapSourceCache, setRvwapSourceCacheEntry } = await import('../../state/store.js');
    const { hydrateRvwapSource } = await import('../market-service.js');
    const hydration = hydrateRvwapSource({ coin: 'BTC' });
    setRvwapSourceCacheEntry('BTC', [
      { t: now, o: '101', h: '105', l: '100', c: '104', v: '20' },
    ]);
    pending.resolve(jsonResponse([
      { t: now - 14400, o: '100', h: '102', l: '99', c: '101', v: '10' },
      { t: now, o: '101', h: '103', l: '100', c: '102', v: '12' },
    ]));
    await hydration;

    expect(rvwapSourceCache.get('BTC').at(-1)).toEqual(expect.objectContaining({ c: '104', v: '20' }));
  });

  it('does not let a late RVWAP response from the previous coin replace active status', async () => {
    const btc = deferred();
    const eth = deferred();
    global.fetch.mockImplementation((_url, options) => {
      const body = JSON.parse(options.body);
      return body.coin === 'BTC' ? btc.promise : eth.promise;
    });

    const { AppState, setCurrentCoin, setRvwapLookbackVisible } = await import('../../state/store.js');
    const { ensureRvwapSource } = await import('../market-service.js');
    const now = Math.floor(Date.now() / 1000);
    setRvwapLookbackVisible('7D', true);

    setCurrentCoin('BTC');
    const btcLoad = ensureRvwapSource({ coin: 'BTC' });
    setCurrentCoin('ETH');
    const ethLoad = ensureRvwapSource({ coin: 'ETH' });

    eth.resolve(jsonResponse([
      { t: now - 14400, o: '200', h: '202', l: '199', c: '201', v: '20' },
      { t: now, o: '201', h: '203', l: '200', c: '202', v: '22' },
    ]));
    await ethLoad;
    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({ coin: 'ETH', status: 'ready' }));

    btc.resolve(jsonResponse([
      { t: now - 14400, o: '100', h: '102', l: '99', c: '101', v: '10' },
      { t: now, o: '101', h: '103', l: '100', c: '102', v: '12' },
    ]));
    await btcLoad;

    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({ coin: 'ETH', status: 'ready' }));
  });

  it('does not let a late RVWAP failure overwrite a newer successful coin', async () => {
    const btc = deferred();
    const eth = deferred();
    global.fetch.mockImplementation((_url, options) => {
      const body = JSON.parse(options.body);
      return body.coin === 'BTC' ? btc.promise : eth.promise;
    });

    const { AppState, setCurrentCoin, setRvwapLookbackVisible } = await import('../../state/store.js');
    const { ensureRvwapSource } = await import('../market-service.js');
    const now = Math.floor(Date.now() / 1000);
    setRvwapLookbackVisible('7D', true);

    setCurrentCoin('BTC');
    const btcLoad = ensureRvwapSource({ coin: 'BTC' });
    setCurrentCoin('ETH');
    const ethLoad = ensureRvwapSource({ coin: 'ETH' });
    eth.resolve(jsonResponse([
      { t: now - 14400, o: '200', h: '202', l: '199', c: '201', v: '20' },
      { t: now, o: '201', h: '203', l: '200', c: '202', v: '22' },
    ]));
    await ethLoad;

    btc.reject(new Error('old coin offline'));
    await btcLoad;

    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({
      coin: 'ETH',
      status: 'ready',
      error: '',
    }));
  });

  it('adopts a completed RVWAP cache immediately when the active coin changes', async () => {
    const now = Math.floor(Date.now() / 1000);
    global.fetch.mockImplementation((_url, options) => {
      const { coin } = JSON.parse(options.body);
      const price = coin === 'BTC' ? 100 : 200;
      return Promise.resolve(jsonResponse([
        { t: now - 14400, o: `${price}`, h: `${price + 2}`, l: `${price - 1}`, c: `${price + 1}`, v: '10' },
        { t: now, o: `${price + 1}`, h: `${price + 3}`, l: `${price}`, c: `${price + 2}`, v: '12' },
      ]));
    });

    const { AppState, setCurrentCoin, setRvwapLookbackVisible } = await import('../../state/store.js');
    const { ensureRvwapSource, scheduleActiveRvwapHydration } = await import('../market-service.js');
    setRvwapLookbackVisible('7D', true);
    setCurrentCoin('BTC');
    await ensureRvwapSource({ coin: 'BTC' });
    setCurrentCoin('ETH');
    await ensureRvwapSource({ coin: 'ETH' });
    expect(AppState.market.rvwapSource.coin).toBe('ETH');

    setCurrentCoin('BTC');
    scheduleActiveRvwapHydration('BTC');

    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({
      coin: 'BTC',
      status: 'ready',
    }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('reuses each completed RVWAP source when revisiting a coin', async () => {
    const now = Math.floor(Date.now() / 1000);
    global.fetch.mockImplementation((_url, options) => {
      const { coin } = JSON.parse(options.body);
      const price = coin === 'BTC' ? 100 : 200;
      return Promise.resolve(jsonResponse([
        { t: now - 14400, o: `${price}`, h: `${price + 2}`, l: `${price - 1}`, c: `${price + 1}`, v: '10' },
        { t: now, o: `${price + 1}`, h: `${price + 3}`, l: `${price}`, c: `${price + 2}`, v: '12' },
      ]));
    });

    const { AppState, setCurrentCoin } = await import('../../state/store.js');
    const { ensureRvwapSource } = await import('../market-service.js');
    setCurrentCoin('BTC');
    await ensureRvwapSource({ coin: 'BTC' });
    setCurrentCoin('ETH');
    await ensureRvwapSource({ coin: 'ETH' });
    setCurrentCoin('BTC');
    await ensureRvwapSource({ coin: 'BTC' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({ coin: 'BTC', status: 'ready' }));
  });

  it('does not treat an ordinary 4h chart cache as a completed RVWAP source', async () => {
    const now = Math.floor(Date.now() / 1000);
    global.fetch.mockResolvedValue(jsonResponse([
      { t: now - 14400, o: '100', h: '102', l: '99', c: '101', v: '10' },
      { t: now, o: '101', h: '103', l: '100', c: '102', v: '12' },
    ]));

    const { candleCache, rvwapSourceCache, setCandleCacheEntry } = await import('../../state/store.js');
    setCandleCacheEntry('BTC:4h', [
      { t: now, o: '99', h: '101', l: '98', c: '100', v: '8' },
    ]);
    const { ensureRvwapSource } = await import('../market-service.js');
    await ensureRvwapSource({ coin: 'BTC' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(candleCache.get('BTC:4h')).toHaveLength(1);
    expect(rvwapSourceCache.get('BTC')).toHaveLength(2);
  });

  it('keeps a fresh completed RVWAP visible when an authoritative refresh fails', async () => {
    const now = Math.floor(Date.now() / 1000);
    global.fetch
      .mockResolvedValueOnce(jsonResponse([
        { t: now - 14400, o: '100', h: '102', l: '99', c: '101', v: '10' },
        { t: now, o: '101', h: '103', l: '100', c: '102', v: '12' },
      ]))
      .mockRejectedValueOnce(new Error('refresh offline'));

    const { AppState, setRvwapLookbackVisible } = await import('../../state/store.js');
    const { ensureRvwapSource, cancelRvwapSourceRetries } = await import('../market-service.js');
    setRvwapLookbackVisible('7D', true);
    await ensureRvwapSource({ coin: 'BTC' });
    await ensureRvwapSource({ coin: 'BTC', force: true });

    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({
      coin: 'BTC',
      status: 'ready',
      count: 2,
      error: 'refresh offline',
    }));
    cancelRvwapSourceRetries();
  });

  it('retries a failed active RVWAP source and stops after success', async () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    global.fetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([
        { t: now - 14400, o: '100', h: '102', l: '99', c: '101', v: '10' },
        { t: now, o: '101', h: '103', l: '100', c: '102', v: '12' },
      ]));

    const { AppState, setRvwapLookbackVisible } = await import('../../state/store.js');
    const { ensureRvwapSource } = await import('../market-service.js');
    setRvwapLookbackVisible('7D', true);
    await ensureRvwapSource({ coin: 'BTC' });
    expect(AppState.market.rvwapSource.status).toBe('error');

    await vi.advanceTimersByTimeAsync(1000);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(AppState.market.rvwapSource).toEqual(expect.objectContaining({ coin: 'BTC', status: 'ready' }));
    await vi.advanceTimersByTimeAsync(20000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('cancels a pending RVWAP retry when every preset is disabled', async () => {
    vi.useFakeTimers();
    global.fetch.mockResolvedValue(jsonResponse([]));

    const { setRvwapLookbackVisible } = await import('../../state/store.js');
    const { ensureRvwapSource, cancelRvwapSourceRetries } = await import('../market-service.js');
    setRvwapLookbackVisible('7D', true);
    await ensureRvwapSource({ coin: 'BTC' });
    setRvwapLookbackVisible('7D', false);
    cancelRvwapSourceRetries();

    await vi.advanceTimersByTimeAsync(20000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('forces an authoritative repair past a fresh cache and preserves older scrollback', async () => {
    const now = Date.now();
    const oldTime = Math.floor((now - 8 * 24 * 60 * 60 * 1000) / 1000);
    const repairedTime = Math.floor((now - 60 * 1000) / 1000);
    const tailTime = Math.floor(now / 1000);
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: repairedTime, o: '101', h: '104', l: '100', c: '103', v: '20' },
        { t: tailTime, o: '103', h: '105', l: '102', c: '104', v: '12' },
      ]),
    });

    const { candleCache, setCandleCacheEntry } = await import('../../state/store.js');
    setCandleCacheEntry('BTC:1m', [
      { t: oldTime, o: '90', h: '91', l: '89', c: '90', v: '10' },
      { t: repairedTime, o: '100', h: '102', l: '99', c: '101', v: '10' },
      { t: tailTime, o: '101', h: '103', l: '100', c: '102', v: '10' },
    ]);

    const { fetchCandles } = await import('../market-service.js');
    const result = await fetchCandles({
      coin: 'BTC',
      timeframe: '1m',
      background: true,
      forceAuthoritative: true,
      repairFromTime: repairedTime,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result[0].t).toBe(oldTime);
    expect(result.find((c) => c.t === repairedTime)?.c).toBe('103');
    expect(candleCache.get('BTC:1m')).toEqual(result);
  });

  it('creates an abort signal for an authoritative active fetch with the initial null token', async () => {
    const now = Date.now();
    const calls = [];
    global.fetch = vi.fn((_url, opts = {}) => {
      calls.push(opts);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { t: Math.floor((now - 8 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
          { t: Math.floor(now / 1000), o: '100', h: '102', l: '99', c: '101', v: '12' },
        ]),
      });
    });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';

    const { fetchCandles } = await import('../market-service.js');
    const result = await fetchCandles({
      coin: 'BTC',
      timeframe: '1m',
      requestToken: null,
      forceAuthoritative: true,
    });

    expect(result).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal.aborted).toBe(false);
  });

  it('aborts an in-flight initial-null-token repair when a real selection token supersedes it', async () => {
    const calls = [];
    global.fetch = vi.fn((_url, opts = {}) => {
      const signal = opts.signal;
      calls.push({ body: opts.body ? JSON.parse(opts.body) : null, signal });
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal) {
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail);
        }
      });
    });

    const { AppState } = await import('../../state/store.js');
    const { setActiveCandleRequestToken } = await import('../../state/trading-runtime.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';

    const { fetchCandles } = await import('../market-service.js');
    const initialRepair = fetchCandles({
      coin: 'BTC',
      timeframe: '2h',
      requestToken: null,
      forceAuthoritative: true,
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    AppState.trading.currentTimeframe = '4h';
    setActiveCandleRequestToken('tok-4h');
    const nextSelection = fetchCandles({ coin: 'BTC', timeframe: '4h', requestToken: 'tok-4h' });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const initialCall = calls.find((call) => call.body?.interval === '2h');
    expect(initialCall?.signal).toBeInstanceOf(AbortSignal);
    expect(initialCall.signal.aborted).toBe(true);
    await expect(initialRepair).resolves.toBeNull();
    nextSelection.catch(() => {});
  });

  it('aborts a superseded active chart load when the selection changes', async () => {
    const calls = [];
    global.fetch = vi.fn((url, opts = {}) => {
      const signal = opts.signal;
      calls.push({ body: opts.body ? JSON.parse(opts.body) : null, signal });
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal) {
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail);
        }
        // otherwise never resolves — we only assert the abort path
      });
    });

    const { AppState } = await import('../../state/store.js');
    const { setActiveCandleRequestToken } = await import('../../state/trading-runtime.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';

    const { fetchCandles } = await import('../market-service.js');

    setActiveCandleRequestToken('tok-2h');
    const p1 = fetchCandles({ coin: 'BTC', timeframe: '2h', requestToken: 'tok-2h' });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    // User switches to 4h: new token + selection.
    AppState.trading.currentTimeframe = '4h';
    setActiveCandleRequestToken('tok-4h');
    const p2 = fetchCandles({ coin: 'BTC', timeframe: '4h', requestToken: 'tok-4h' });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    const firstCall = calls.find((c) => c.body?.interval === '2h');
    expect(firstCall).toBeTruthy();
    expect(firstCall.signal.aborted).toBe(true); // the superseded 2h load was cancelled
    await expect(p1).resolves.toBeNull(); // aborted -> resolves null, no error/cooldown
    p2.catch(() => {}); // 4h request stays pending in this test; avoid unhandled rejection
  });

  it('reuses exchange info results inside the dedup window during repeated refreshes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T14:00:05.000Z'));

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { universe: [{ name: 'BTC' }] },
          [{ markPx: '100', dayNtlVlm: '1000', openInterest: '10' }],
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { fundingRate: '0.0001' },
        ]),
      });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';

    const { refreshExchangeInfo } = await import('../market-service.js');
    await refreshExchangeInfo('BTC', { includeActiveAssetData: false });

    vi.setSystemTime(new Date('2026-04-18T14:00:10.000Z'));
    await refreshExchangeInfo('BTC', { includeActiveAssetData: false });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('requests Hyperliquid-reachable 1m history for weekly anchored CVD', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T18:00:00.000Z'));

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'BTC', timeframe: '1m', background: true });

    const [, request] = global.fetch.mock.calls[0];
    const body = JSON.parse(request.body);
    const endTime = Number(body.endTime);
    const startTime = Number(body.startTime);

    const { getInitialHistoryLookbackMs } = await import('../../chart/chart-history-requirements.js');
    expect(endTime - startTime).toBe(getInitialHistoryLookbackMs('1m'));

    vi.useRealTimers();
  });

  it('loads reachable 5m history for chart indicators', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'BTC', timeframe: '5m', background: true });

    const [, request] = global.fetch.mock.calls[0];
    const body = JSON.parse(request.body);
    const endTime = Number(body.endTime);
    const startTime = Number(body.startTime);

    const { getInitialHistoryLookbackMs } = await import('../../chart/chart-history-requirements.js');
    expect(endTime - startTime).toBe(getInitialHistoryLookbackMs('5m'));

    vi.useRealTimers();
  });

  it('loads reachable 15m history for chart indicators', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'BTC', timeframe: '15m', background: true });

    const [, request] = global.fetch.mock.calls[0];
    const body = JSON.parse(request.body);
    const endTime = Number(body.endTime);
    const startTime = Number(body.startTime);

    const { getInitialHistoryLookbackMs } = await import('../../chart/chart-history-requirements.js');
    expect(endTime - startTime).toBe(getInitialHistoryLookbackMs('15m'));

    vi.useRealTimers();
  });

  it.each([
    ['30m'],
    ['1h'],
    ['2h'],
    ['4h'],
    ['8h'],
    ['1d'],
    ['1w'],
    ['1M'],
  ])('keeps enough initial history for %s charts', async (timeframe) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'BTC', timeframe, background: true });

    const [, request] = global.fetch.mock.calls[0];
    const body = JSON.parse(request.body);
    const endTime = Number(body.endTime);
    const startTime = Number(body.startTime);

    const { getInitialHistoryLookbackMs } = await import('../../chart/chart-history-requirements.js');
    expect(endTime - startTime).toBe(getInitialHistoryLookbackMs(timeframe));

    vi.useRealTimers();
  });

  it('serves a 30m cache that only covers Hyperliquid retention without refetching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const { getInitialHistoryLookbackMs } = await import('../../chart/chart-history-requirements.js');
    const reachable = getInitialHistoryLookbackMs('30m');
    const { candleCache } = await import('../../state/store.js');
    candleCache.set('BTC:30m', [
      { t: Math.floor((now - reachable) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ]);

    const { fetchCandles } = await import('../market-service.js');
    const candles = await fetchCandles({ coin: 'BTC', timeframe: '30m', background: true });

    expect(candles).toHaveLength(2);
    expect(global.fetch).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('refetches cached candles when the cached span is shorter than the configured lookback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const { candleCache } = await import('../../state/store.js');
    candleCache.set('BTC:4h', [
      { t: Math.floor((now - 15 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ]);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'BTC', timeframe: '4h', background: true });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, request] = global.fetch.mock.calls[0];
    const body = JSON.parse(request.body);
    const { getInitialHistoryLookbackMs } = await import('../../chart/chart-history-requirements.js');
    expect(Number(body.endTime) - Number(body.startTime)).toBe(getInitialHistoryLookbackMs('4h'));

    vi.useRealTimers();
  });

  it('refetches cached candles when the span is sufficient but the tail is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const { candleCache } = await import('../../state/store.js');
    // Span covers the full 190d lookback, but the last candle is 12h old —
    // beyond the 10h (2.5 × 4h) tail-freshness bound.
    candleCache.set('BTC:4h', [
      { t: Math.floor((now - 192 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - 12 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ]);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'BTC', timeframe: '4h', background: true });

    expect(global.fetch).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('background still bypasses a fresh cache once when recent completed bars lack cvdDelta, then honors the retry cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const fourHMs = 4 * 60 * 60 * 1000;
    const { candleCache } = await import('../../state/store.js');
    // Span + tail both pass the cache fast-path, but no bar carries cvdDelta —
    // the signature of a series fetched during the server's CVD warm-up window.
    const unenriched = [
      { t: Math.floor((now - 192 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - 3 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - 2 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];
    candleCache.set('ETH:4h', unenriched);

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10', cvdDelta: 5 },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'ETH', timeframe: '4h', background: true });
    expect(global.fetch).toHaveBeenCalledTimes(1); // cache bypassed to upgrade the series

    // If the refetch had also come back unenriched, the retry must wait out the
    // cooldown instead of hammering: re-seed the unenriched cache and confirm
    // an immediate second call serves from cache.
    candleCache.set('ETH:4h', unenriched);
    await fetchCandles({ coin: 'ETH', timeframe: '4h', background: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('active chart paints a span+tail-fresh cache immediately even when cvdDelta is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const fourHMs = 4 * 60 * 60 * 1000;
    const { AppState, candleCache } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'ETH';
    AppState.trading.currentTimeframe = '4h';
    AppState.market.allMids.ETH = '100';
    const unenriched = [
      { t: Math.floor((now - 192 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - 3 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - 2 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];
    candleCache.set('ETH:4h', unenriched);

    const { fetchCandles } = await import('../market-service.js');
    const result = await fetchCandles({ coin: 'ETH', timeframe: '4h' });

    // Instant switch path: never block the visible chart on a CVD upgrade REST.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toHaveLength(5);
    expect(AppState.market.candles).toHaveLength(5);

    vi.useRealTimers();
  });

  it('serves a fresh cache without a fetch when recent bars carry cvdDelta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const fourHMs = 4 * 60 * 60 * 1000;
    const { candleCache } = await import('../../state/store.js');
    candleCache.set('SOL:4h', [
      { t: Math.floor((now - 192 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 1 },
      { t: Math.floor((now - 3 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 2 },
      { t: Math.floor((now - 2 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: -1 },
      { t: Math.floor((now - fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 3 },
      { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ]);

    const { fetchCandles } = await import('../market-service.js');
    const result = await fetchCandles({ coin: 'SOL', timeframe: '4h', background: true });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toHaveLength(5);

    vi.useRealTimers();
  });

  it('bypasses a fresh cache when a bar days back (outside the last-bars tail check) lacks cvdDelta — a healed sleep/wake gap bucket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const fourHMs = 4 * 60 * 60 * 1000;
    const dayMs = 24 * 60 * 60 * 1000;
    const { AppState, candleCache } = await import('../../state/store.js');
    AppState.market.allMids['xyz:SKHX'] = '101';
    // Tail bars all carry cvdDelta (would pass the old last-3-bar check), but a
    // bar from 2 days ago — well within the CVD-relevant window, well
    // outside the tail — has cvdDelta: null, e.g. from a sleep/wake gap bucket
    // that has since scrolled out of the tail but whose server-side enrichment
    // was never re-fetched.
    const withOrphanedGap = [
      { t: Math.floor((now - 192 * dayMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 1 },
      { t: Math.floor((now - 2 * dayMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: null },
      { t: Math.floor((now - 2 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: -1 },
      { t: Math.floor((now - fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 3 },
      { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ];
    candleCache.set('AVAX:4h', withOrphanedGap);

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10', cvdDelta: 5 },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'AVAX', timeframe: '4h', background: true });
    expect(global.fetch).toHaveBeenCalledTimes(1); // the orphaned gap bar forced a refetch

    vi.useRealTimers();
  });

  it('does not refetch for a null cvdDelta bar older than the CVD-relevant window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const fourHMs = 4 * 60 * 60 * 1000;
    const dayMs = 24 * 60 * 60 * 1000;
    const { candleCache } = await import('../../state/store.js');
    // The only null cvdDelta bar is 166 days back — long past any anchor reset
    // (weekly by default) — so healing it wouldn't change what's on screen and
    // it must not trigger indefinite retries.
    candleCache.set('DOGE:4h', [
      { t: Math.floor((now - 192 * dayMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: null },
      { t: Math.floor((now - 3 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 2 },
      { t: Math.floor((now - 2 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: -1 },
      { t: Math.floor((now - fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 3 },
      { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ]);

    const { fetchCandles } = await import('../market-service.js');
    const result = await fetchCandles({ coin: 'DOGE', timeframe: '4h', background: true });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toHaveLength(5);

    vi.useRealTimers();
  });

  it('refetches when a thin market last candle is completed and still lacks cvdDelta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const fourHMs = 4 * 60 * 60 * 1000;
    const dayMs = 24 * 60 * 60 * 1000;
    const { AppState, candleCache } = await import('../../state/store.js');
    AppState.market.allMids['xyz:SKHX'] = '101';
    candleCache.set('xyz:SKHX:4h', [
      { t: Math.floor((now - 192 * dayMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 1 },
      { t: Math.floor((now - 12 * fourHMs) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10', cvdDelta: 2 },
      // No current bucket exists on this thin pair. This final row closed four
      // hours ago and must not receive the ordinary live-tail exemption.
      { t: Math.floor((now - 2 * fourHMs) / 1000), o: '100', h: '102', l: '99', c: '101', v: '12' },
    ]);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: Math.floor((now - 2 * fourHMs) / 1000), o: '100', h: '102', l: '99', c: '101', v: '12', cvdDelta: 7 },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'xyz:SKHX', timeframe: '4h', background: true });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('preserves a previously enriched completed delta when a transient authoritative snapshot is bare', async () => {
    const now = Date.now();
    const oneHMs = 60 * 60 * 1000;
    const completedTime = Math.floor((now - 2 * oneHMs) / 1000);
    const tailTime = Math.floor(now / 1000);
    const { AppState, candleCache, setCandleCacheEntry } = await import('../../state/store.js');
    AppState.market.allMids['xyz:SKHX'] = '102';
    setCandleCacheEntry('xyz:SKHX:1h', [
      { t: Math.floor((now - 192 * 24 * oneHMs) / 1000), o: '95', h: '96', l: '94', c: '95', v: '8', cvdDelta: 1 },
      { t: completedTime, o: '100', h: '102', l: '99', c: '101', v: '12', cvdDelta: 7 },
      { t: tailTime, o: '101', h: '103', l: '100', c: '102', v: '4', cvdDelta: 2 },
    ]);

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: completedTime, o: '100', h: '102', l: '99', c: '101', v: '12' },
        { t: tailTime, o: '101', h: '103', l: '100', c: '102.5', v: '5' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    const result = await fetchCandles({
      coin: 'xyz:SKHX',
      timeframe: '1h',
      background: true,
      forceAuthoritative: true,
    });

    expect(result.find((c) => c.t === completedTime)?.cvdDelta).toBe(7);
    expect(result.find((c) => c.t === tailTime)?.cvdDelta).toBe(2);
    expect(result.find((c) => c.t === tailTime)?.c).toBe('102.5');
    expect(candleCache.get('xyz:SKHX:1h')).toEqual(result);
  });

  it('automatically refetches an active fallback chart after the CVD source warm-up window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));
    vi.doMock('../../ui/market-ui.js', async () => {
      const { setMarketCandles } = await import('../../state/market-state.js');
      return {
        applyResolvedPrice: vi.fn(),
        applyExchangeLeverage: vi.fn(),
        updateExchangeHtml: vi.fn(),
        applyCandles: vi.fn(async (candles) => setMarketCandles(candles, { snapshot: true })),
        applyVwapResult: vi.fn(),
        applyBookSnapshot: vi.fn(),
        applyCoin24hChange: vi.fn(),
        applyMarketMovers: vi.fn(),
      };
    });

    const now = Date.now();
    const oneHMs = 60 * 60 * 1000;
    const oldTime = Math.floor((now - 192 * 24 * oneHMs) / 1000);
    const completedTime = Math.floor((now - 2 * oneHMs) / 1000);
    const openTime = Math.floor(now / oneHMs) * oneHMs / 1000;
    const fallback = [
      { t: oldTime, o: '95', h: '96', l: '94', c: '95', v: '8', cvdDelta: 1 },
      { t: completedTime, o: '100', h: '102', l: '99', c: '101', v: '12' },
      { t: openTime, o: '101', h: '103', l: '100', c: '102', v: '4' },
    ];
    const enriched = fallback.map((candle) => (
      candle.t === completedTime ? { ...candle, cvdDelta: 7 } : candle
    ));
    global.fetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.urgency === 'hydrate') {
        return { ok: true, status: 202, text: async () => JSON.stringify({ status: 'warming' }) };
      }
      const visibleCalls = global.fetch.mock.calls.filter(([, request]) => {
        const requestBody = JSON.parse(request.body);
        return requestBody.urgency !== 'hydrate';
      }).length;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(visibleCalls === 1 ? fallback : enriched),
      };
    });

    const { AppState, candleCache } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'xyz:SKHX';
    AppState.trading.currentTimeframe = '1h';
    AppState.market.allMids['xyz:SKHX'] = '102';
    const { fetchCandles } = await import('../market-service.js');

    await fetchCandles({ coin: 'xyz:SKHX', timeframe: '1h' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(candleCache.get('xyz:SKHX:1h').find((c) => c.t === completedTime)?.cvdDelta).toBeUndefined();

    await vi.advanceTimersByTimeAsync(30_000);

    const visibleCalls = global.fetch.mock.calls.filter(([, request]) => (
      JSON.parse(request.body).urgency !== 'hydrate'
    ));
    expect(visibleCalls).toHaveLength(2);
    expect(candleCache.get('xyz:SKHX:1h').find((c) => c.t === completedTime)?.cvdDelta).toBe(7);
    expect(AppState.market.candles.find((c) => c.t === completedTime)?.cvdDelta).toBe(7);

    vi.doUnmock('../../ui/market-ui.js');
    vi.useRealTimers();
  });

  it('serves cached candles without a fetch when span and tail are both fresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const { candleCache } = await import('../../state/store.js');
    candleCache.set('BTC:4h', [
      { t: Math.floor((now - 192 * 24 * 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
      { t: Math.floor((now - 60 * 60 * 1000) / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
    ]);

    const { fetchCandles } = await import('../market-service.js');
    const candles = await fetchCandles({ coin: 'BTC', timeframe: '4h', background: true });

    expect(candles).toHaveLength(2);
    expect(global.fetch).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('preloads older candle chunks before rendering when the first snapshot is short', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T18:00:00.000Z'));

    const now = Date.now();
    const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000;
    const oldChunkStart = now - 192 * 24 * 60 * 60 * 1000;

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { t: Math.floor(fifteenDaysAgo / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
          { t: Math.floor(now / 1000), o: '100', h: '101', l: '99', c: '100', v: '10' },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { t: Math.floor(oldChunkStart / 1000), o: '95', h: '96', l: '94', c: '95', v: '10' },
        ]),
      });

    const { candleCache } = await import('../../state/store.js');
    const { fetchCandles } = await import('../market-service.js');
    const candles = await fetchCandles({ coin: 'BTC', timeframe: '4h', background: true });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(candles).toHaveLength(3);
    expect(candleCache.get('BTC:4h')).toHaveLength(3);

    vi.useRealTimers();
  });











  it('includes the xyz dex when fetching active xyz candles', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { universe: [{ name: 'CL' }] },
        [{ markPx: '80.5' }],
      ]),
    });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '80', h: '81', l: '79', c: '80.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'xyz:CL', timeframe: '1m', background: true });

    const [, request] = global.fetch.mock.calls[1];
    const body = JSON.parse(request.body);

    expect(body.coin).toBe('xyz:CL');
    expect(body.dex).toBe('xyz');
  });

  it('fetches only the requested exchange candle interval', async () => {
    window.BOT = { running: true };

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 1, o: '100', h: '101', l: '99', c: '100.5', v: '10' },
      ]),
    });

    const { fetchCandles } = await import('../market-service.js');
    await fetchCandles({ coin: 'BTC', timeframe: '1m' });
    await Promise.resolve();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, request] = global.fetch.mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body.interval).toBe('1m');
  });

  it('sets an explicit chart notice when an active candle load returns no data', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.candles = [];

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    });

    const { fetchCandles } = await import('../market-service.js');
    const result = await fetchCandles({ coin: 'BTC', timeframe: '1m' });

    expect(result).toBeNull();
    expect(AppState.ui.chartNotice).toBe('No chart data');
  });

});
