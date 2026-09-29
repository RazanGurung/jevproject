/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  handleMids: vi.fn(),
  subscribeMarket: vi.fn(() => Promise.resolve()),
  resetMarketSubscriptions: vi.fn(),
  beginMarketStreamEpoch: vi.fn(),
  recoverActiveCandlesIfStale: vi.fn(),
  recoverActiveCandlesAfterReconnect: vi.fn(),
}));

vi.mock('../market-ws.js', () => ({
  handleBook: vi.fn(),
  handleTrades: vi.fn(),
  handleMarketLiquidations: vi.fn(),
  handleCandle: vi.fn(),
  ...handlers,
}));

const uiHandlers = vi.hoisted(() => ({
  updateConnectionStatusUI: vi.fn(),
}));

vi.mock('../account-stream-ui.js', () => uiHandlers);

describe('isolated market stream transport', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    Object.values(handlers).forEach((fn) => fn.mockClear());
    uiHandlers.updateConnectionStatusUI.mockClear();
    window.sessionStorage.clear();
    window.localStorage.clear();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });

    class MockWebSocket {
      static instances = [];
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.readyState = MockWebSocket.CONNECTING;
        MockWebSocket.instances.push(this);
      }
      close() { this.readyState = MockWebSocket.CLOSED; }
    }
    global.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('owns market subscription recovery and dispatches only market data', async () => {
    const { connectMarketStream } = await import('../market-stream.js');
    connectMarketStream();
    const socket = global.WebSocket.instances[0];
    expect(socket.url).toContain('/api/market-stream?clientId=');

    socket.readyState = global.WebSocket.OPEN;
    socket.onopen?.();
    await Promise.resolve();
    expect(handlers.resetMarketSubscriptions).toHaveBeenCalledOnce();
    expect(handlers.beginMarketStreamEpoch).toHaveBeenCalledOnce();
    expect(handlers.subscribeMarket).toHaveBeenCalledOnce();
    expect(handlers.recoverActiveCandlesAfterReconnect).toHaveBeenCalledOnce();

    await socket.onmessage?.({
      data: JSON.stringify({ eventId: 1, channel: 'allMids', data: { mids: { BTC: '100' } } }),
    });
    expect(handlers.handleMids).toHaveBeenCalledWith({ mids: { BTC: '100' } });
  });

  it('does not treat loopback heartbeats as market payload for resume age', async () => {
    const { connectMarketStream, getMarketStreamMessageAgeMs } = await import('../market-stream.js');
    connectMarketStream();
    const socket = global.WebSocket.instances[0];
    socket.readyState = global.WebSocket.OPEN;
    socket.onopen?.();
    await socket.onmessage?.({
      data: JSON.stringify({ eventId: 1, channel: 'allMids', data: { mids: { BTC: '100' } } }),
    });
    vi.setSystemTime(Date.now() + 20_000);
    await socket.onmessage?.({
      data: JSON.stringify({ type: 'heartbeat', time: Date.now() }),
    });
    expect(getMarketStreamMessageAgeMs()).toBeGreaterThanOrEqual(20_000);
  });

  it('dedupes within one socket but accepts a restarted event sequence after reconnect', async () => {
    const { connectMarketStream } = await import('../market-stream.js');
    connectMarketStream();
    const first = global.WebSocket.instances[0];
    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();

    const frame = JSON.stringify({ eventId: 7, channel: 'allMids', data: { mids: { BTC: '100' } } });
    await first.onmessage?.({ data: frame });
    await first.onmessage?.({ data: frame });
    expect(handlers.handleMids).toHaveBeenCalledTimes(1);

    first.readyState = global.WebSocket.CLOSED;
    first.onclose?.();
    await vi.advanceTimersByTimeAsync(0);
    const second = global.WebSocket.instances[1];
    second.readyState = global.WebSocket.OPEN;
    second.onopen?.();
    await second.onmessage?.({ data: frame });

    expect(handlers.handleMids).toHaveBeenCalledTimes(2);
    expect(handlers.beginMarketStreamEpoch).toHaveBeenCalledTimes(2);
  });

  it('stops the old heartbeat while reconnecting and recycles a hung CONNECTING socket', async () => {
    const { connectMarketStream } = await import('../market-stream.js');
    connectMarketStream();
    const first = global.WebSocket.instances[0];
    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();

    first.readyState = global.WebSocket.CLOSED;
    first.onclose?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(global.WebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(50_000);
    expect(global.WebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(global.WebSocket.instances.length).toBeGreaterThan(2);
  });

  it('sends the API token as a websocket subprotocol, never in the URL', async () => {
    window.localStorage.setItem('pez.apiToken', 'smoke token');
    const { connectMarketStream } = await import('../market-stream.js');
    connectMarketStream();
    const socket = global.WebSocket.instances[0];
    expect(socket.url).not.toContain('smoke');
    expect(socket.protocols).toEqual(['pez-token.c21va2UgdG9rZW4']);
  });

  it('forces a same-bucket snapshot and market-only reconnect after a visible system wake', async () => {
    const { connectMarketStream } = await import('../market-stream.js');
    const { getTransportMetricsSnapshot, resetTransportMetricsForTests } = await import('../../services/transport-metrics.js');
    resetTransportMetricsForTests();

    connectMarketStream();
    const first = global.WebSocket.instances[0];
    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();
    await Promise.resolve();

    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getTransportMetricsSnapshot().stream.marketWakeDetections).toBe(1);
    expect(getTransportMetricsSnapshot().stream.marketRefreshes).toBe(1);
    expect(getTransportMetricsSnapshot().stream.marketLastRefreshReason).toBe('system-wake');
    expect(handlers.recoverActiveCandlesIfStale).toHaveBeenCalledWith(
      expect.any(Number),
      { forceAuthoritative: true },
    );
    expect(global.WebSocket.instances).toHaveLength(2);

    const second = global.WebSocket.instances[1];
    second.readyState = global.WebSocket.OPEN;
    second.onopen?.();
    await Promise.resolve();
    expect(handlers.resetMarketSubscriptions).toHaveBeenCalledTimes(2);
    expect(handlers.subscribeMarket).toHaveBeenCalledTimes(2);
  });

  it('records market-specific connect and reconnect lifecycle metrics', async () => {
    const { connectMarketStream } = await import('../market-stream.js');
    const { getTransportMetricsSnapshot, resetTransportMetricsForTests } = await import('../../services/transport-metrics.js');
    resetTransportMetricsForTests();

    connectMarketStream();
    const first = global.WebSocket.instances[0];
    expect(getTransportMetricsSnapshot().stream.marketConnectAttempts).toBe(1);

    first.readyState = global.WebSocket.OPEN;
    first.onopen?.();
    expect(getTransportMetricsSnapshot().stream.marketConnects).toBe(1);

    first.readyState = global.WebSocket.CLOSED;
    first.onclose?.();
    expect(getTransportMetricsSnapshot().stream.marketReconnectSchedules).toBe(1);
  });

  it('does not classify hidden-tab timer throttling as system sleep', async () => {
    const { connectMarketStream } = await import('../market-stream.js');
    const { getTransportMetricsSnapshot, resetTransportMetricsForTests } = await import('../../services/transport-metrics.js');
    resetTransportMetricsForTests();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });

    connectMarketStream();
    const socket = global.WebSocket.instances[0];
    socket.readyState = global.WebSocket.OPEN;
    socket.onopen?.();

    vi.setSystemTime(Date.now() + 31_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(getTransportMetricsSnapshot().stream.marketWakeDetections).toBe(0);
    expect(handlers.recoverActiveCandlesIfStale).not.toHaveBeenCalled();
    expect(global.WebSocket.instances).toHaveLength(1);
  });

  it('treats only live market channels as ticks and refreshes chrome on heartbeat', async () => {
    const { connectMarketStream } = await import('../market-stream.js');
    const { AppState } = await import('../../state/store.js');
    AppState.connection.marketLastTickAt = 0;
    uiHandlers.updateConnectionStatusUI.mockClear();

    connectMarketStream();
    const socket = global.WebSocket.instances[0];
    socket.readyState = global.WebSocket.OPEN;
    socket.onopen?.();

    await socket.onmessage?.({
      data: JSON.stringify({ eventId: 21, channel: 'allMids', data: { mids: { BTC: '100' }, snapshot: true } }),
    });
    expect(AppState.connection.marketLastTickAt).toBe(0);

    await socket.onmessage?.({
      data: JSON.stringify({ eventId: 22, channel: 'liquidations', data: [{ coin: 'BTC' }] }),
    });
    expect(AppState.connection.marketLastTickAt).toBe(0);

    await socket.onmessage?.({
      data: JSON.stringify({ eventId: 23, type: 'heartbeat', time: '2026-08-25T00:00:00Z' }),
    });
    expect(AppState.connection.marketLastTickAt).toBe(0);
    expect(uiHandlers.updateConnectionStatusUI).toHaveBeenCalled();

    await socket.onmessage?.({
      data: JSON.stringify({ eventId: 24, channel: 'allMids', data: { mids: { BTC: '101' } } }),
    });
    expect(AppState.connection.marketLastTickAt).toBeGreaterThan(0);

    await socket.onmessage?.({
      data: JSON.stringify({ eventId: 25, type: 'upstream', connected: false }),
    });
    expect(AppState.connection.marketLastTickAt).toBe(0);
    expect(AppState.connection.marketUpstreamConnected).toBe(false);
  });
});
