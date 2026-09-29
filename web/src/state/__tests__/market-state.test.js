/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('market state helpers', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T16:20:00Z'));

    const { AppState } = await import('../store.js');
    AppState.market.book = { bids: [], asks: [] };
    AppState.market.candles = [];
    AppState.market.candleSnapshotRevision = 0;
    AppState.market.vwapData = null;
    AppState.market.activeAssetCtx = {};
    AppState.market.assetSnapshots = {};
  });

  it('stores asset snapshots from rich 24h payloads and plain change strings', async () => {
    const { AppState, coin24hChanges } = await import('../store.js');
    const { setAssetSnapshot, getAssetSnapshot, getCoin24hChange } = await import('../market-state.js');
    Object.keys(coin24hChanges).forEach((k) => delete coin24hChanges[k]);

    setAssetSnapshot('BTC', {
      change: '2.50',
      dayNtlVlm: 1e9,
      oi: 5e8,
      funding: 0.01,
      markPx: 100000,
    });
    expect(getAssetSnapshot('BTC')).toEqual({
      change: '2.50',
      dayNtlVlm: 1e9,
      oi: 5e8,
      funding: 0.01,
      markPx: 100000,
    });
    expect(getCoin24hChange('BTC')).toBe('2.50');

    // Legacy plain-string form keeps change and leaves other fields alone.
    setAssetSnapshot('ETH', '-1.25');
    expect(getAssetSnapshot('ETH')).toEqual(expect.objectContaining({ change: '-1.25' }));
    expect(AppState.market.assetSnapshots.ETH.change).toBe('-1.25');
  });

  it('writes canonical book snapshots', async () => {
    const { AppState } = await import('../store.js');
    const { setMarketBookSnapshot } = await import('../market-state.js');

    setMarketBookSnapshot({
      bids: [{ px: 100 }, { px: 99 }],
      asks: [{ px: 101 }, { px: 102 }],
    });

    expect(AppState.market.book.bids).toEqual([{ px: 100 }, { px: 99 }]);
    expect(AppState.market.book.asks).toEqual([{ px: 101 }, { px: 102 }]);
  });

  it('stores candles, vwap data, and active asset context through canonical helpers', async () => {
    const { AppState } = await import('../store.js');
    const {
      setActiveAssetCtx,
      setMarketCandles,
      setMarketVwapData,
    } = await import('../market-state.js');

    const candles = [{ t: 1, c: '100' }];
    const vwapData = { vwap: 100, stdDev: 2 };
    const ctx = { markPx: '100.5' };

    setMarketCandles(candles);
    setMarketVwapData(vwapData);
    setActiveAssetCtx('BTC', ctx);

    expect(AppState.market.candles).toBe(candles);
    expect(AppState.market.vwapData).toBe(vwapData);
    expect(AppState.market.activeAssetCtx.BTC).toBe(ctx);
  });

  it('marks authoritative snapshots without treating live candle writes as full reloads', async () => {
    const { AppState } = await import('../store.js');
    const { setMarketCandles } = await import('../market-state.js');

    setMarketCandles([{ t: 1 }]);
    expect(AppState.market.candleSnapshotRevision).toBe(0);

    setMarketCandles([{ t: 1, cvdDelta: 3 }], { snapshot: true });
    expect(AppState.market.candleSnapshotRevision).toBe(1);
  });

  it('resolves active selections, asset contexts, and normalized book snapshots through shared helpers', async () => {
    const { AppState } = await import('../store.js');
    const {
      buildNormalizedBook,
      findAssetCtx,
      isActiveMarketSelection,
    } = await import('../market-state.js');

    AppState.trading.currentCoin = 'xyz:CL';
    AppState.trading.currentTimeframe = '1m';

    expect(isActiveMarketSelection('xyz:CL', '1m')).toBe(true);
    expect(isActiveMarketSelection('BTC', '1m')).toBe(false);

    expect(findAssetCtx([
      { universe: [{ name: 'CL' }, { name: 'BTC' }] },
      [{ markPx: '80.5' }, { markPx: '100000' }],
    ], 'xyz:CL')).toEqual({ markPx: '80.5' });

    expect(buildNormalizedBook([
      [{ px: '100.0', sz: '2.0' }, { px: '99.5', sz: '3.0' }],
      [{ px: '100.5', sz: '1.5' }, { px: '101.0', sz: '4.0' }],
    ], { limit: 1 })).toEqual({
      bids: [{ px: 100, sz: 2, price: 100, size: 2 }],
      asks: [{ px: 100.5, sz: 1.5, price: 100.5, size: 1.5 }],
    });
  });
});
