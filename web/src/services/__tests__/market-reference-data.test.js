import { describe, expect, it, vi } from 'vitest';

import { createMarketReferenceDataService } from '../market-reference-data.js';

describe('market reference data service', () => {
  it('reuses exchange info results inside the dedup window', async () => {
    let now = Date.parse('2026-04-18T14:00:05.000Z');
    const updateExchangeHtml = vi.fn();
    const fetchWithDedup = vi.fn((_key, factory) => factory());
    const hlPost = vi.fn()
      .mockResolvedValueOnce([{ universe: [{ name: 'BTC' }] }])
      .mockResolvedValueOnce([{ fundingRate: '0.0001' }]);

    const service = createMarketReferenceDataService({
      getCurrentCoin: () => 'BTC',
      getWalletAddress: () => '',
      getDex: () => '',
      hlPost,
      fetchWithDedup,
      apiPost: vi.fn(),
      updateExchangeHtml,
      getNow: () => now,
    });

    await service.refreshExchangeInfo('BTC', { includeActiveAssetData: false });
    now = Date.parse('2026-04-18T14:00:10.000Z');
    await service.refreshExchangeInfo('BTC', { includeActiveAssetData: false });

    expect(hlPost).toHaveBeenCalledTimes(2);
    // Progressive paint: meta-first + funding-complete on the first call, then
    // one cache-hit paint on the second call inside the dedup window.
    expect(updateExchangeHtml).toHaveBeenCalledTimes(3);
  });

  it('paints mark/OI chrome before a slow fundingHistory response settles', async () => {
    let resolveFunding;
    const fundingDeferred = new Promise((resolve) => { resolveFunding = resolve; });
    const updateExchangeHtml = vi.fn();
    const fetchWithDedup = vi.fn((_key, factory) => factory());
    const hlPost = vi.fn((body) => {
      if (body?.type === 'fundingHistory') return fundingDeferred;
      return Promise.resolve([{ universe: [{ name: 'BTC' }], markPx: '100' }]);
    });

    const service = createMarketReferenceDataService({
      getCurrentCoin: () => 'BTC',
      getWalletAddress: () => '',
      getDex: () => '',
      hlPost,
      fetchWithDedup,
      apiPost: vi.fn(),
      updateExchangeHtml,
      getNow: () => Date.parse('2026-04-18T14:00:05.000Z'),
    });

    const pending = service.refreshExchangeInfo('BTC', { includeActiveAssetData: false });
    await vi.waitFor(() => {
      expect(updateExchangeHtml).toHaveBeenCalled();
    });
    // First paint must not wait for funding.
    expect(updateExchangeHtml.mock.calls[0][2]).toBeNull();

    resolveFunding([{ fundingRate: '0.0001' }]);
    await pending;

    expect(updateExchangeHtml).toHaveBeenCalledTimes(2);
    expect(updateExchangeHtml.mock.calls[1][2]).toEqual([{ fundingRate: '0.0001' }]);
  });

  it('reuses cached vwap results inside the cache ttl', async () => {
    let now = Date.parse('2026-04-18T14:00:05.000Z');
    const applyVwapResult = vi.fn();
    const hlPost = vi.fn().mockResolvedValue([
      { t: now - 60_000, h: '101', l: '99', c: '100', v: '10' },
      { t: now, h: '102', l: '100', c: '101', v: '12' },
    ]);

    const service = createMarketReferenceDataService({
      getCurrentCoin: () => 'BTC',
      getWalletAddress: () => '',
      getDex: () => '',
      hlPost,
      fetchWithDedup: vi.fn((_key, factory) => factory()),
      apiPost: vi.fn(),
      applyVwapResult,
      getNow: () => now,
    });

    const first = await service.fetchVWAP('BTC', '15m');
    now += 10_000;
    const second = await service.fetchVWAP('BTC', '15m');

    expect(first).toEqual(second);
    expect(hlPost).toHaveBeenCalledTimes(1);
    expect(applyVwapResult).toHaveBeenCalledTimes(2);
  });

  it('builds aggregate funding-rate snapshots from the latest funding entries', async () => {
    const now = Date.parse('2026-04-18T14:00:05.000Z');
    const hlPost = vi.fn().mockImplementation(({ coin }) => Promise.resolve([
      { fundingRate: coin === 'BTC' ? '0.0002' : '0.0001' },
    ]));

    const service = createMarketReferenceDataService({
      getCurrentCoin: () => 'BTC',
      getWalletAddress: () => '',
      getDex: () => '',
      hlPost,
      fetchWithDedup: vi.fn((_key, factory) => factory()),
      apiPost: vi.fn(),
      getNow: () => now,
    });

    const fundingRates = await service.fetchFunding();

    expect(fundingRates).toEqual(expect.objectContaining({
      BTC: 0.02,
      ETH: 0.01,
    }));
    expect(Object.keys(fundingRates)).toHaveLength(8);
  });
});
