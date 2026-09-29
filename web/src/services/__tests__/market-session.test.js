/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('requestMarketSubscription', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reuses stored intent instead of passing the overrides object as coin', async () => {
    const subscribeMarket = vi.fn(() => Promise.resolve({ ok: true }));
    const { AppState } = await import('../../state/store.js');
    const { configureMarketSession, requestMarketSubscription } = await import('../market-session.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';
    configureMarketSession({
      loadMarketActions: async () => ({ subscribeMarket }),
    });

    await requestMarketSubscription();

    expect(subscribeMarket).toHaveBeenCalledTimes(1);
    expect(subscribeMarket).toHaveBeenCalledWith();
    expect(AppState.connection.marketSubscription.coin).toBe('BTC');
    expect(AppState.connection.marketSubscription.interval).toBe('2h');
  });

  it('keeps an explicit coin/interval override in stored intent', async () => {
    const subscribeMarket = vi.fn(() => Promise.resolve({ ok: true }));
    const { AppState } = await import('../../state/store.js');
    const { configureMarketSession, requestMarketSubscription } = await import('../market-session.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';
    configureMarketSession({
      loadMarketActions: async () => ({ subscribeMarket }),
    });

    await requestMarketSubscription({ coin: 'ETH', interval: '4h' });

    expect(subscribeMarket).toHaveBeenCalledWith();
    expect(AppState.connection.marketSubscription.coin).toBe('ETH');
    expect(AppState.connection.marketSubscription.interval).toBe('4h');
  });
});
