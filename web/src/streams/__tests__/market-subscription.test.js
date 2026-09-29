import { describe, expect, it } from 'vitest';
import { buildSubscriptionKey, createMarketSubscriptionController } from '../market-subscription.js';

describe('market subscription controller', () => {
  it('treats trade-coin reorder as the same subscription key', () => {
    const a = buildSubscriptionKey({
      clientId: 'c1',
      coin: 'BTC',
      interval: '2h',
      tradeCoins: ['BTC', 'ETH', 'SOL'],
      indicatorIntervals: ['4h'],
    });
    const b = buildSubscriptionKey({
      clientId: 'c1',
      coin: 'BTC',
      interval: '2h',
      tradeCoins: ['SOL', 'BTC', 'ETH'],
      indicatorIntervals: ['4h'],
    });
    expect(a).toBe(b);

    const controller = createMarketSubscriptionController();
    controller.commit(a);
    expect(controller.shouldSubscribe(b)).toBe(false);
  });

  it('still distinguishes real membership changes', () => {
    const a = buildSubscriptionKey({
      clientId: 'c1',
      coin: 'BTC',
      interval: '2h',
      tradeCoins: ['BTC', 'ETH'],
    });
    const b = buildSubscriptionKey({
      clientId: 'c1',
      coin: 'BTC',
      interval: '2h',
      tradeCoins: ['BTC', 'SOL'],
    });
    expect(a).not.toBe(b);
  });
});
