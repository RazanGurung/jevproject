import { describe, expect, it, vi } from 'vitest';

import { loadActiveChartSession } from '../chart-load-session.js';

describe('loadActiveChartSession', () => {
  it('does not block cached chart readiness on a before-fetch subscription', async () => {
    const requestToken = 'active-request';
    let resolveSubscription;
    const subscribeMarket = vi.fn(() => new Promise((resolve) => {
      resolveSubscription = resolve;
    }));
    const completeChartSession = vi.fn();

    const result = await loadActiveChartSession({
      coin: 'BTC',
      timeframe: '2h',
      requestToken,
      getActiveCandleRequestToken: () => requestToken,
      fetchCandles: vi.fn().mockResolvedValue([{ t: 1 }]),
      fetchOptions: { cacheAlreadyApplied: true },
      subscribeMarket,
      subscribeMode: 'beforeFetch',
      completeChartSession,
      requestChartRefresh: vi.fn(),
    });

    expect(result).toBe(true);
    expect(completeChartSession).toHaveBeenCalledWith({ coin: 'BTC', timeframe: '2h', requestToken });
    expect(subscribeMarket).toHaveBeenCalledOnce();
    resolveSubscription();
  });

  it('retains after-fetch subscription ordering when explicitly requested', async () => {
    const order = [];
    await loadActiveChartSession({
      coin: 'ETH',
      timeframe: '1h',
      requestToken: 'request',
      getActiveCandleRequestToken: () => 'request',
      fetchCandles: async () => { order.push('candles'); },
      subscribeMarket: async () => { order.push('subscription'); },
      completeChartSession: () => { order.push('ready'); },
    });

    expect(order).toEqual(['candles', 'subscription', 'ready']);
  });
});
