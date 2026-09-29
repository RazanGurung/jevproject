import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('connection health', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('treats heartbeat-only sockets as not live until a market tick arrives', async () => {
    const { AppState, ConnectionState } = await import('../store.js');
    const { isMarketFeedLive, noteMarketTick, setMarketUpstreamConnected } = await import('../connection-health.js');

    AppState.connection.marketState = ConnectionState.CONNECTED;
    AppState.connection.marketUpstreamConnected = false;
    AppState.connection.marketLastTickAt = 0;
    expect(isMarketFeedLive()).toBe(false);

    setMarketUpstreamConnected(true);
    expect(isMarketFeedLive()).toBe(false);

    noteMarketTick(Date.now());
    expect(isMarketFeedLive()).toBe(true);
  });

  it('ages Live chrome to Sync after 15s without a market tick', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const { AppState, ConnectionState } = await import('../store.js');
    const {
      getConnectionChromeState,
      isTradingAllowed,
      noteMarketTick,
      setMarketUpstreamConnected,
    } = await import('../connection-health.js');

    AppState.connection.marketState = ConnectionState.CONNECTED;
    AppState.connection.tradingState = ConnectionState.DISCONNECTED;
    setMarketUpstreamConnected(true);
    noteMarketTick(now);
    expect(getConnectionChromeState(now).label).toBe('Live');
    expect(isTradingAllowed(now)).toBe(true);

    const later = now + 16_000;
    expect(isTradingAllowed(later)).toBe(false);
    expect(getConnectionChromeState(later).label).toBe('Sync');
    vi.useRealTimers();
  });

  it('does not reopen Place from a leftover tick after upstream drop', async () => {
    const now = Date.now();
    const { AppState, ConnectionState } = await import('../store.js');
    const {
      isTradingAllowed,
      noteMarketTick,
      setMarketUpstreamConnected,
    } = await import('../connection-health.js');

    AppState.connection.marketState = ConnectionState.CONNECTED;
    setMarketUpstreamConnected(true);
    noteMarketTick(now);
    expect(isTradingAllowed(now)).toBe(true);

    setMarketUpstreamConnected(false);
    expect(AppState.connection.marketLastTickAt).toBe(0);
    setMarketUpstreamConnected(true);
    expect(isTradingAllowed(now)).toBe(false);
  });
});
