/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('account stream canonical order revisions', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="statusDot"></div>';

    class MockWebSocket {
      static instances = [];
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.readyState = MockWebSocket.CONNECTING;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        MockWebSocket.instances.push(this);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    global.WebSocket = MockWebSocket;
    window.localStorage.clear();
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({}),
    }));

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0xabc';
    AppState.account.openOrders = [];
    AppState.account.lastOrderRevision = 0;
    AppState.account.state = {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    };

    window.fetchAccount = vi.fn();
    window.showToast = vi.fn();
    window.renderFills = vi.fn();
    window.renderTwapStatus = vi.fn();
    window.StrategyManager = null;
    window.applyBotStatus = vi.fn();
    window.onAccountStreamConnectionStateChange = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates the websocket without putting the API token in the URL', async () => {
    window.localStorage.setItem('pez.apiToken', 'smoke token');
    const { connectAccountStream } = await import('../account-stream.js');
    connectAccountStream();

    const socket = global.WebSocket.instances[0];
    expect(socket.url).not.toContain('smoke');
    expect(socket.protocols).toEqual(['pez-token.c21va2UgdG9rZW4']);
  });

  it('ignores older webData2 order revisions after a newer snapshot has been applied', async () => {
    const { connectAccountStream } = await import('../account-stream.js');
    const { AppState } = await import('../../state/store.js');

    connectAccountStream();

    const es = global.WebSocket.instances[0];
    expect(es).toBeTruthy();
    es.readyState = global.WebSocket.OPEN;

    await es.onmessage({
      data: JSON.stringify({
        eventId: 1,
        channel: 'webData2',
        data: {
          orders: [{ oid: 200, coin: 'BTC', side: 'B', limitPx: 50000, sz: 0.01 }],
          orderRevision: 2,
          assetPositions: [],
          marginSummary: {},
          crossMarginSummary: {},
          riskSummary: {},
        },
      }),
    });

    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 200, coin: 'BTC' }),
    ]);
    expect(AppState.account.lastOrderRevision).toBe(2);

    await es.onmessage({
      data: JSON.stringify({
        eventId: 2,
        channel: 'webData2',
        data: {
          orders: [{ oid: 100, coin: 'ETH', side: 'A', limitPx: 3000, sz: 0.5 }],
          orderRevision: 1,
          assetPositions: [],
          marginSummary: {},
          crossMarginSummary: {},
          riskSummary: {},
        },
      }),
    });

    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 200, coin: 'BTC' }),
    ]);
    expect(AppState.account.lastOrderRevision).toBe(2);
  });

  it('accepts webData3 account snapshots without changing the canonical downstream flow', async () => {
    const { connectAccountStream } = await import('../account-stream.js');
    const { AppState } = await import('../../state/store.js');

    connectAccountStream();

    const es = global.WebSocket.instances[0];
    expect(es).toBeTruthy();
    es.readyState = global.WebSocket.OPEN;

    await es.onmessage({
      data: JSON.stringify({
        eventId: 20,
        channel: 'webData3',
        data: {
          orders: [{ oid: 300, coin: 'SOL', side: 'B', limitPx: 150, sz: 2 }],
          orderRevision: 3,
          assetPositions: [],
          marginSummary: {},
          crossMarginSummary: {},
          riskSummary: {},
        },
      }),
    });

    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 300, coin: 'SOL' }),
    ]);
    expect(AppState.account.lastOrderRevision).toBe(3);
  });

  it('reuses the existing stream when connect is called repeatedly for the same account', async () => {
    const { connectAccountStream, getConnectionState } = await import('../account-stream.js');
    const { ConnectionState } = await import('../../state/store.js');

    connectAccountStream();
    connectAccountStream();

    expect(global.WebSocket.instances).toHaveLength(1);
    expect(getConnectionState()).toBe(ConnectionState.CONNECTING);

    const es = global.WebSocket.instances[0];
    es.readyState = global.WebSocket.OPEN;
    es.onopen?.();

    connectAccountStream();

    expect(global.WebSocket.instances).toHaveLength(1);
    expect(getConnectionState()).toBe(ConnectionState.CONNECTED);
  });

  it('forwards connection state changes to the bot host callback', async () => {
    const { connectAccountStream } = await import('../account-stream.js');
    const { ConnectionState } = await import('../../state/store.js');

    connectAccountStream();

    expect(window.onAccountStreamConnectionStateChange).toHaveBeenCalledWith(ConnectionState.CONNECTING);

    const es = global.WebSocket.instances[0];
    es.readyState = global.WebSocket.OPEN;
    es.onopen?.();

    expect(window.onAccountStreamConnectionStateChange).toHaveBeenLastCalledWith(ConnectionState.CONNECTED);
  });

  it('forwards botStatus stream messages to the bot bridge', async () => {
    const { connectAccountStream } = await import('../account-stream.js');

    connectAccountStream();

    const es = global.WebSocket.instances[0];
    await es.onmessage({
      data: JSON.stringify({
        eventId: 3,
        channel: 'botStatus',
        data: {
          running: true,
          strategy: 'rvwap-short-bollinger',
          coin: 'BTC',
          orderIds: [1, 2, 3],
        },
      }),
    });

    expect(window.applyBotStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        running: true,
        strategy: 'rvwap-short-bollinger',
        coin: 'BTC',
        orderIds: [1, 2, 3],
      }),
    );
  });

  it('dedupes within one socket but accepts a restarted event sequence after reconnect', async () => {
    const { connectAccountStream } = await import('../account-stream.js');
    connectAccountStream();
    const first = global.WebSocket.instances[0];
    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();

    const frame = JSON.stringify({
      eventId: 9,
      channel: 'botStatus',
      data: { running: true, strategy: 'rvwap-bollinger', coin: 'BTC' },
    });
    await first.onmessage?.({ data: frame });
    await first.onmessage?.({ data: frame });
    expect(window.applyBotStatus).toHaveBeenCalledTimes(1);

    first.close();
    await vi.advanceTimersByTimeAsync(0);
    const second = global.WebSocket.instances[1];
    second.readyState = global.WebSocket.OPEN;
    second.onopen?.();
    await second.onmessage?.({ data: frame });

    expect(window.applyBotStatus).toHaveBeenCalledTimes(2);
  });

  it('ignores stale socket close callbacks after a replacement connection is created', async () => {
    const { connectAccountStream, getConnectionState, getAccountStreamSocket } = await import('../account-stream.js');
    const { ConnectionState } = await import('../../state/store.js');

    connectAccountStream();
    const first = global.WebSocket.instances[0];

    first.readyState = global.WebSocket.CLOSED;
    connectAccountStream('refresh');
    const second = global.WebSocket.instances[1];

    second.readyState = global.WebSocket.OPEN;
    second.onopen?.();

    first.onclose?.();

    expect(global.WebSocket.instances).toHaveLength(2);
    expect(getAccountStreamSocket()).toBe(second);
    expect(getConnectionState()).toBe(ConnectionState.CONNECTED);
  });

  it('reconnects immediately on the first drop and backs off from the second attempt', async () => {
    const { connectAccountStream } = await import('../account-stream.js');

    connectAccountStream();
    const first = global.WebSocket.instances[0];
    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();

    first.close();
    expect(global.WebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(global.WebSocket.instances).toHaveLength(2);

    global.WebSocket.instances[1].close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(global.WebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(global.WebSocket.instances).toHaveLength(3);
  });

  it('treats a frozen heartbeat tick in a visible tab as system wake and reconnects', async () => {
    const { connectAccountStream } = await import('../account-stream.js');
    const { getTransportMetricsSnapshot } = await import('../../services/transport-metrics.js');

    connectAccountStream();
    const socket = global.WebSocket.instances[0];
    socket.readyState = global.WebSocket.OPEN;
    socket.onopen?.();

    // System sleep freezes timers while wall-clock time keeps moving: jump the
    // clock without firing ticks, then let the next heartbeat tick land late.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getTransportMetricsSnapshot().stream.wakeDetections).toBe(1);
    expect(global.WebSocket.instances).toHaveLength(2);
  });

  it('suppresses a stream refresh that lands right after a fresh connect', async () => {
    const { connectAccountStream, refreshAccountStream } = await import('../account-stream.js');
    const { getTransportMetricsSnapshot } = await import('../../services/transport-metrics.js');

    connectAccountStream();
    expect(global.WebSocket.instances).toHaveLength(1);

    refreshAccountStream('converging-trigger');
    expect(global.WebSocket.instances).toHaveLength(1);
    expect(getTransportMetricsSnapshot().stream.refreshSuppressed).toBe(1);

    await vi.advanceTimersByTimeAsync(2_500);
    refreshAccountStream('later');
    expect(global.WebSocket.instances).toHaveLength(2);
  });

  it('resetReconnectBackoff short-circuits a pending reconnect timer', async () => {
    const { connectAccountStream, resetReconnectBackoff } = await import('../account-stream.js');
    const { getTransportMetricsSnapshot } = await import('../../services/transport-metrics.js');

    connectAccountStream();
    const first = global.WebSocket.instances[0];
    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();
    first.close();
    await vi.advanceTimersByTimeAsync(0);
    // Second drop schedules a 1.5s retry; resume should not wait for it.
    global.WebSocket.instances[1].close();
    expect(global.WebSocket.instances).toHaveLength(2);

    resetReconnectBackoff('resume');
    expect(global.WebSocket.instances).toHaveLength(3);
    expect(getTransportMetricsSnapshot().stream.fastReconnects).toBe(1);
  });

  it('keeps retrying the stream connection instead of falling back to polling after repeated errors', async () => {
    const { connectAccountStream, getConnectionState } = await import('../account-stream.js');
    const { ConnectionState } = await import('../../state/store.js');

    connectAccountStream();

    for (let attempt = 0; attempt < 12; attempt++) {
      const current = global.WebSocket.instances.at(-1);
      current.onerror?.();
      await vi.runOnlyPendingTimersAsync();
    }

    expect(global.WebSocket.instances).toHaveLength(13);
    expect(window.fetchAccount).not.toHaveBeenCalled();
    expect(getConnectionState()).toBe(ConnectionState.CONNECTING);
  });

  it('refreshes trading transport without touching market subscriptions', async () => {
    // Browser sockets fire onclose asynchronously; the shared mock fires it
    // synchronously inside close(), which hides the production ordering where
    // the close lands after the replacement socket is already assigned and the
    // onclose guard skips resetMarketSubscriptions().
    global.WebSocket.prototype.close = function () {
      this.readyState = global.WebSocket.CLOSED;
      setTimeout(() => this.onclose?.(), 0);
    };

    const { connectAccountStream, refreshAccountStream } = await import('../account-stream.js');
    const { setDesiredMarketSubscription } = await import('../../state/market-subscription-state.js');

    setDesiredMarketSubscription({ coin: 'BTC', interval: '1m', tradeCoins: ['BTC'] });

    const subscribeCalls = () =>
      global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/market-subscribe')).length;

    connectAccountStream();
    const first = global.WebSocket.instances[0];
    expect(first.url).toContain('/api/trading-stream');
    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeCalls()).toBe(0);

    // Past the refresh-suppression window, a wake/resume-style refresh
    // replaces the socket without changing the subscription key.
    await vi.advanceTimersByTimeAsync(2_500);
    refreshAccountStream('system-wake');
    const second = global.WebSocket.instances[1];
    expect(second).toBeTruthy();
    // The old socket's deferred onclose fires after the replacement exists.
    await vi.advanceTimersByTimeAsync(0);

    second.readyState = global.WebSocket.OPEN;
    second.onopen?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(subscribeCalls()).toBe(0);
  });
});
