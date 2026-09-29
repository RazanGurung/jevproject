/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('PriceFeed', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
  });

  it('refreshes the last update timestamp on repeated same-price updates', async () => {
    vi.useFakeTimers();
    try {
      await import('../price-feed.js');
      const priceFeed = window.PriceFeed;

      vi.setSystemTime(new Date('2026-04-10T06:35:00Z'));
      priceFeed.init({ throttleMs: 1000 });
      priceFeed.update('BTC', 100000);
      const firstUpdate = priceFeed.getLastUpdate();

      vi.setSystemTime(new Date('2026-04-10T06:35:10Z'));
      priceFeed.update('BTC', 100000);

      expect(priceFeed.getLastUpdate()).toBeGreaterThan(firstUpdate);
      expect(priceFeed.isStale()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes a different coin immediately inside the throttle window', async () => {
    vi.useFakeTimers();
    try {
      await import('../price-feed.js');
      const priceFeed = window.PriceFeed;
      const subscriber = vi.fn();

      vi.setSystemTime(new Date('2026-04-10T06:35:00Z'));
      priceFeed.init({ throttleMs: 1000 }).subscribe(subscriber);
      priceFeed.update('BTC', 100000);

      vi.setSystemTime(new Date('2026-04-10T06:35:00.100Z'));
      priceFeed.update('ETH', 3200);

      expect(priceFeed.getCurrentCoin()).toBe('ETH');
      expect(priceFeed.getCurrentPrice()).toBe(3200);
      expect(priceFeed.isStale()).toBe(false);
      expect(subscriber).toHaveBeenLastCalledWith(expect.objectContaining({
        coin: 'ETH',
        price: 3200,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not label a fresh recovery tick as stale after a long gap', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await import('../price-feed.js');
      const priceFeed = window.PriceFeed;

      vi.setSystemTime(new Date('2026-04-10T06:35:00Z'));
      priceFeed.init({ throttleMs: 1000 });
      priceFeed.update('BTC', 100000);

      vi.setSystemTime(new Date('2026-04-10T06:45:00Z'));
      priceFeed.update('BTC', 100001);

      expect(priceFeed.getCurrentPrice()).toBe(100001);
      expect(priceFeed.isStale()).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
