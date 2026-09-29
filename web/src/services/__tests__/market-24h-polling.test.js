import { describe, expect, it, vi } from 'vitest';

import { createMarket24hPollingService } from '../market-24h-polling.js';

describe('market 24h polling service', () => {
  it('uses backend-preloaded 24h changes when available', async () => {
    const applyCoin24hChange = vi.fn(async () => {});
    const scheduleRender = vi.fn();
    const service = createMarket24hPollingService({
      apiGet: vi.fn(async () => ({ BTC: '1.23', ETH: '-0.50' })),
      hlPost: vi.fn(),
      applyCoin24hChange,
      scheduleRender,
    });

    const result = await service.fetch24hChanges();

    expect(result).toEqual({ BTC: '1.23', ETH: '-0.50' });
    expect(applyCoin24hChange).toHaveBeenCalledWith('BTC', '1.23');
    expect(applyCoin24hChange).toHaveBeenCalledWith('ETH', '-0.50');
    expect(scheduleRender).toHaveBeenCalledTimes(1);
  });

  it('forwards rich asset snapshots (vol/OI/funding) from the backend', async () => {
    const applyCoin24hChange = vi.fn(async () => {});
    const payload = {
      BTC: { change: '1.23', dayNtlVlm: 1e9, oi: 5e8, funding: 0.01, markPx: 100000 },
      ETH: { change: '-0.50', dayNtlVlm: 2e8, oi: 1e8, funding: -0.002, markPx: 3500 },
    };
    const service = createMarket24hPollingService({
      apiGet: vi.fn(async () => payload),
      hlPost: vi.fn(),
      applyCoin24hChange,
    });

    await service.fetch24hChanges();

    expect(applyCoin24hChange).toHaveBeenCalledWith('BTC', payload.BTC);
    expect(applyCoin24hChange).toHaveBeenCalledWith('ETH', payload.ETH);
  });

  it('falls back to direct candle snapshots when backend data is unavailable', async () => {
    const applyCoin24hChange = vi.fn(async () => {});
    const hlPost = vi.fn(async ({ req }) => [
      { c: '100' },
      { c: req.coin === 'BTC' ? '110' : '100' },
    ]);
    const scheduleRender = vi.fn();
    const service = createMarket24hPollingService({
      apiGet: vi.fn(async () => {
        throw new Error('unavailable');
      }),
      hlPost,
      applyCoin24hChange,
      scheduleRender,
      getNow: () => 1_000_000,
    });

    await service.fetch24hChanges();

    expect(hlPost).toHaveBeenCalled();
    const requests = hlPost.mock.calls.map(([body]) => body);
    const requestedCoins = requests.map((body) => body.req.coin);
    expect(requestedCoins).toEqual(expect.arrayContaining([
      'xyz:TSLA',
      'xyz:GOOGL',
      'xyz:AMZN',
      'xyz:AAPL',
      'xyz:META',
      'xyz:JPY',
    ]));
    expect(requestedCoins).not.toContain('xyz:NATGAS');
    for (const body of requests.filter((request) => request.req.coin.startsWith('xyz:'))) {
      expect(body.req.dex).toBe('xyz');
    }
    expect(applyCoin24hChange).toHaveBeenCalledWith('BTC', '10.00');
    expect(scheduleRender).toHaveBeenCalledTimes(1);
  });

  it('starts and stops the polling interval', () => {
    const setIntervalFn = vi.fn(() => 77);
    const clearIntervalFn = vi.fn();
    const service = createMarket24hPollingService({
      apiGet: vi.fn(async () => ({})),
      hlPost: vi.fn(),
      setIntervalFn,
      clearIntervalFn,
    });

    service.start24hPolling();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);

    service.stop24hPolling();
    expect(clearIntervalFn).toHaveBeenCalledWith(77);
  });
});
