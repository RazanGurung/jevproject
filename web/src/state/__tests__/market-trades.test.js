import { describe, expect, it } from 'vitest';

describe('market trade state helpers', () => {
  it('creates and reuses per-coin trade buckets on the market slice', async () => {
    const { ensureCoinTradeBuckets } = await import('../market-trades.js');
    const marketState = {};

    ensureCoinTradeBuckets(marketState, 'BTC');

    expect(marketState.tradeCache.get('BTC')).toEqual([]);
    expect(marketState.largeTradeCache.get('BTC')).toEqual([]);
    expect(marketState.flowCache.get('BTC')).toEqual({
      buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500,
    });
    expect(marketState.whaleFlowCache.get('BTC')).toEqual({
      buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500,
    });
  });

  it('normalizes a batch once: parses, dedupes within and across batches', async () => {
    const { normalizeTradeBatch } = await import('../market-trades.js');
    const marketState = {};

    const first = normalizeTradeBatch(marketState, 'ETH', [
      { tid: 1, time: 1, px: '100', sz: '20', side: 'B' },
      { tid: 2, time: 2, px: '110', sz: '3000', side: 'A' },
      { tid: 1, time: 1, px: '100', sz: '20', side: 'B' }, // in-batch replay
    ]);

    expect(first).toHaveLength(2);
    expect(first[0]).toEqual(expect.objectContaining({
      px: 100, sz: 20, time: 1, isBuy: true, notional: 2000,
    }));
    expect(first[1]).toEqual(expect.objectContaining({
      px: 110, sz: 3000, isBuy: false, notional: 330000,
    }));

    // A resent batch (relay reconnects) normalizes to empty.
    const resent = normalizeTradeBatch(marketState, 'ETH', [
      { tid: 1, time: 1, px: '100', sz: '20', side: 'B' },
      { tid: 2, time: 2, px: '110', sz: '3000', side: 'A' },
    ]);
    expect(resent).toEqual([]);
  });

  it('retains identities across the Hyperliquid replay window so a late resent print cannot re-enter', async () => {
    const { normalizeTradeBatch, IDENTITY_REPLAY_WINDOW } = await import('../market-trades.js');
    const marketState = {};
    const first = { tid: 1, time: 1, px: '100', sz: '1', side: 'B' };
    expect(normalizeTradeBatch(marketState, 'BTC', [first])).toHaveLength(1);

    const extras = Array.from({ length: IDENTITY_REPLAY_WINDOW }, (_, index) => ({
      tid: index + 2, time: index + 2, px: '100', sz: '1', side: 'A',
    }));
    expect(normalizeTradeBatch(marketState, 'BTC', extras)).toHaveLength(IDENTITY_REPLAY_WINDOW);
    expect(normalizeTradeBatch(marketState, 'BTC', [first])).toEqual([]);
  });

  it('evicts the oldest identity once the per-coin seen set reaches its cap', async () => {
    const { normalizeTradeBatch, MAX_SEEN_KEYS } = await import('../market-trades.js');
    const marketState = {};
    const first = { tid: 1, time: 1, px: '100', sz: '1', side: 'B' };
    expect(normalizeTradeBatch(marketState, 'BTC', [first])).toHaveLength(1);

    const extras = Array.from({ length: MAX_SEEN_KEYS }, (_, index) => ({
      tid: index + 2, time: index + 2, px: '100', sz: '1', side: 'A',
    }));
    expect(normalizeTradeBatch(marketState, 'BTC', extras)).toHaveLength(MAX_SEEN_KEYS);
    expect(normalizeTradeBatch(marketState, 'BTC', [first])).toHaveLength(1);
    expect(marketState.tradeSeenKeys.get('BTC').size).toBe(MAX_SEEN_KEYS);
  });

  it('keeps distinct tids even when every visible trade field is identical', async () => {
    const { normalizeTradeBatch } = await import('../market-trades.js');
    const normalized = normalizeTradeBatch({}, 'BTC', [
      { tid: 11, time: 1, px: '100', sz: '1000', side: 'B' },
      { tid: 12, time: 1, px: '100', sz: '1000', side: 'B' },
    ]);
    expect(normalized).toHaveLength(2);
    expect(normalized.every((trade) => trade.isWhale)).toBe(true);
    expect(new Set(normalized.map((trade) => trade.tradeId)).size).toBe(2);
  });

  it('buffers normalized trades into the canonical and large-trade caches', async () => {
    const { ensureCoinTradeBuckets, ingestTrades, normalizeTradeBatch } = await import('../market-trades.js');
    const marketState = {};
    ensureCoinTradeBuckets(marketState, 'ETH');

    ingestTrades(marketState, 'ETH', normalizeTradeBatch(marketState, 'ETH', [
      { tid: 1, time: 1, px: '100', sz: '20', side: 'B' }, // $2k -> not large
      { tid: 2, time: 2, px: '110', sz: '3000', side: 'A' }, // $330k -> large
      { tid: 1, time: 1, px: '100', sz: '20', side: 'B' }, // replay
    ]));

    expect(marketState.tradeCache.get('ETH')).toHaveLength(2);
    expect(marketState.tradeCache.get('ETH')[0]).toEqual(expect.objectContaining({ coin: 'ETH', time: 2 }));
    expect(marketState.largeTradeCache.get('ETH')).toHaveLength(1);
    expect(marketState.largeTradeCache.get('ETH')[0]).toEqual(expect.objectContaining({ value: 330000, coin: 'ETH' }));
  });

  it('retains exactly the latest 500 recent trades', async () => {
    const { ingestTrades, normalizeTradeBatch } = await import('../market-trades.js');
    const marketState = {};
    const raw = Array.from({ length: 501 }, (_, index) => ({
      tid: index + 1, time: index + 1, px: '100', sz: '1', side: 'B',
    }));

    ingestTrades(marketState, 'BTC', normalizeTradeBatch(marketState, 'BTC', raw));

    const cached = marketState.tradeCache.get('BTC');
    expect(cached).toHaveLength(500);
    expect(cached[0].tid).toBe(501);
    expect(cached.at(-1).tid).toBe(2);
  });

  it('prunes per-coin caches for coins outside the keep set', async () => {
    const {
      ensureCoinTradeBuckets, ingestTrades, normalizeTradeBatch, pruneMarketCoinCaches,
    } = await import('../market-trades.js');
    const marketState = {};
    ['BTC', 'ETH', 'SOL'].forEach((coin) => {
      ensureCoinTradeBuckets(marketState, coin);
      ingestTrades(marketState, coin, normalizeTradeBatch(marketState, coin, [
        { time: 1, px: '100', sz: '1', side: 'B' },
      ]));
    });
    marketState.domTradeCache = new Map([['BTC', new Map()], ['SOL', new Map()]]);
    marketState.bookCache = new Map([
      ['BTC', { bids: [], asks: [] }],
      ['SOL', { bids: [], asks: [] }],
    ]);
    marketState.whaleEventCache = new Map([['BTC', []], ['SOL', []]]);
    marketState.whaleResponseCache = new Map([['BTC', []], ['SOL', []]]);

    pruneMarketCoinCaches(marketState, ['BTC', 'ETH']);

    expect([...marketState.tradeCache.keys()]).toEqual(['BTC', 'ETH']);
    expect([...marketState.largeTradeCache.keys()]).toEqual(['BTC', 'ETH']);
    expect([...marketState.flowCache.keys()]).toEqual(['BTC', 'ETH']);
    expect([...marketState.whaleFlowCache.keys()]).toEqual(['BTC', 'ETH']);
    expect([...marketState.tradeSeenKeys.keys()]).toEqual(['BTC', 'ETH']);
    expect([...marketState.domTradeCache.keys()]).toEqual(['BTC']);
    expect([...marketState.bookCache.keys()]).toEqual(['BTC']);
    expect([...marketState.whaleEventCache.keys()]).toEqual(['BTC']);
    expect([...marketState.whaleResponseCache.keys()]).toEqual(['BTC']);
  });

  it('caches backend per-coin flow via applyFlowSnapshot (no client-side math)', async () => {
    const { applyFlowSnapshot } = await import('../market-trades.js');
    const marketState = {};

    applyFlowSnapshot(marketState, 'BTC', {
      buyVol: 1000, sellVol: 500, whaleBuyVol: 400, whaleSellVol: 200,
      sampleCount: 12, sampleCapacity: 500, oldestTimeMs: 100, newestTimeMs: 200,
      whaleSampleCount: 4, whaleSampleCapacity: 500,
      whaleOldestTimeMs: 50, whaleNewestTimeMs: 190,
    });

    expect(marketState.flowCache.get('BTC')).toEqual({
      buyVol: 1000, sellVol: 500, sampleCount: 12, sampleCapacity: 500,
      oldestTimeMs: 100, newestTimeMs: 200,
    });
    expect(marketState.whaleFlowCache.get('BTC')).toEqual({
      buyVol: 400, sellVol: 200, sampleCount: 4, sampleCapacity: 500,
      oldestTimeMs: 50, newestTimeMs: 190,
    });
  });

  it('falls back to shared coverage metadata from older flow snapshots', async () => {
    const { applyFlowSnapshot } = await import('../market-trades.js');
    const marketState = {};

    applyFlowSnapshot(marketState, 'BTC', {
      buyVol: 1000, sellVol: 500, whaleBuyVol: 400, whaleSellVol: 200,
      sampleCount: 12, sampleCapacity: 500, oldestTimeMs: 100, newestTimeMs: 200,
    });

    expect(marketState.whaleFlowCache.get('BTC')).toEqual({
      buyVol: 400, sellVol: 200, sampleCount: 12, sampleCapacity: 500,
      oldestTimeMs: 100, newestTimeMs: 200,
    });
  });

  it('rejects older same-epoch revisions but accepts a lower revision from a newer epoch', async () => {
    const { applyFlowSnapshot } = await import('../market-trades.js');
    const marketState = {};

    expect(applyFlowSnapshot(marketState, 'BTC', {
      revision: 8, buyVol: 800, sellVol: 80, sampleCount: 8,
    }, { marketEpoch: 4 })).toBe(true);
    expect(applyFlowSnapshot(marketState, 'BTC', {
      revision: 7, buyVol: 700, sellVol: 70, sampleCount: 7,
    }, { marketEpoch: 4 })).toBe(false);
    expect(marketState.flowCache.get('BTC').buyVol).toBe(800);

    expect(applyFlowSnapshot(marketState, 'BTC', {
      revision: 1, buyVol: 100, sellVol: 10, sampleCount: 1,
    }, { marketEpoch: 5 })).toBe(true);
    expect(marketState.flowCache.get('BTC').buyVol).toBe(100);
    expect(marketState.flowFreshnessCache.get('BTC')).toEqual({ marketEpoch: 5, revision: 1 });
  });

  it('only treats connected, accepted, current-epoch Flow caches as switch-safe', async () => {
    const { applyFlowSnapshot, isFlowSnapshotEligible } = await import('../market-trades.js');
    const marketState = {};
    applyFlowSnapshot(marketState, 'SOL', {
      revision: 3, buyVol: 300, sellVol: 30, sampleCount: 3,
    }, { marketEpoch: 9 });

    const eligible = {
      acceptedTradeCoins: ['BTC', 'SOL'], marketEpoch: 9, marketState: 'connected',
    };
    expect(isFlowSnapshotEligible(marketState, 'SOL', eligible)).toBe(true);
    expect(isFlowSnapshotEligible(marketState, 'SOL', { ...eligible, marketState: 'reconnecting' })).toBe(false);
    expect(isFlowSnapshotEligible(marketState, 'SOL', { ...eligible, acceptedTradeCoins: ['BTC'] })).toBe(false);
    expect(isFlowSnapshotEligible(marketState, 'SOL', { ...eligible, marketEpoch: 10 })).toBe(false);
  });

  it('replaces active Flow with WARM without destroying an ineligible cache', async () => {
    const { applyFlowSnapshot, syncActiveTradeStateSnapshot } = await import('../market-trades.js');
    const marketState = {};
    applyFlowSnapshot(marketState, 'ETH', {
      revision: 2, buyVol: 2000, sellVol: 1000, whaleBuyVol: 500,
      sampleCount: 20, sampleCapacity: 500,
    }, { marketEpoch: 2 });

    syncActiveTradeStateSnapshot(marketState, 'ETH', { useCachedFlow: false });

    expect(marketState.orderFlow).toEqual({
      buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500,
    });
    expect(marketState.flowCache.get('ETH').buyVol).toBe(2000);
  });

  it('uses one simple $100k whale threshold across flow and DOM metadata', async () => {
    const { applyFlowSnapshot } = await import('../market-trades.js');
    const marketState = {};

    applyFlowSnapshot(marketState, 'BTC', {
      whaleThresholdUsd: 100000,
      whaleFlowThresholdUsd: 100000,
      halfLifeMs: 90000,
    });
    applyFlowSnapshot(marketState, 'ETH', { whaleHaloHalfLifeMs: 120000, halfLifeMs: 1 });

    expect(marketState.flowMetaCache.get('BTC').whaleHaloHalfLifeMs).toBe(90000);
    expect(marketState.flowMetaCache.get('BTC').whaleThresholdUsd).toBe(100000);
    expect(marketState.flowMetaCache.get('BTC').whaleFlowThresholdUsd).toBe(100000);
    expect(marketState.flowMetaCache.get('ETH').whaleHaloHalfLifeMs).toBe(120000);
    expect(marketState.flowMetaCache.get('ETH').whaleThresholdUsd).toBe(100000);
    expect(marketState.flowMetaCache.get('ETH').whaleFlowThresholdUsd).toBe(100000);
  });

  it('classifies whale behavior at the same $100k boundary', async () => {
    const { applyFlowSnapshot, normalizeTradeBatch } = await import('../market-trades.js');
    const marketState = {};
    applyFlowSnapshot(marketState, 'BTC', {
      whaleThresholdUsd: 100000,
      whaleFlowThresholdUsd: 100000,
    });

    const [below, whale] = normalizeTradeBatch(marketState, 'BTC', [
      { tid: 1, time: 1, px: '1', sz: '99999', side: 'B' },
      { tid: 2, time: 2, px: '1', sz: '100000', side: 'B' },
    ]);

    expect(below.isWhale).toBe(false);
    expect(whale.isWhale).toBe(true);
    expect(whale.isMajorWhale).toBe(false);
  });

  it('hydrates the active trade snapshot from the per-coin buffers', async () => {
    const {
      ensureCoinTradeBuckets, ingestTrades, normalizeTradeBatch, applyFlowSnapshot, syncActiveTradeStateSnapshot,
    } = await import('../market-trades.js');
    const marketState = {};
    ensureCoinTradeBuckets(marketState, 'BTC');

    ingestTrades(marketState, 'BTC', normalizeTradeBatch(marketState, 'BTC', [
      { time: 5, px: '100', sz: '80', side: 'B' }, // $8k large
    ]));
    applyFlowSnapshot(marketState, 'BTC', {
      buyVol: 1000, sellVol: 500, whaleBuyVol: 400, whaleSellVol: 200,
      sampleCount: 3, sampleCapacity: 500,
    });

    syncActiveTradeStateSnapshot(marketState, 'BTC');

    expect(marketState.trades).toHaveLength(1);
    expect(marketState.largeTrades).toHaveLength(1);
    expect(marketState.orderFlow).toEqual(expect.objectContaining({ buyVol: 1000, sellVol: 500, sampleCount: 3 }));
    expect(marketState.largeTradeFlow).toEqual(expect.objectContaining({ buyVol: 400, sellVol: 200, sampleCount: 3 }));
  });

  it('buffers market-wide liquidations with dedup (newest first, capped)', async () => {
    const { ingestMarketLiquidations } = await import('../market-trades.js');
    const marketState = {};

    ingestMarketLiquidations(marketState, [
      { coin: 'BTC', side: 'A', px: '50000', sz: '0.1', value: 5000, time: 1, user: '0xa', method: 'market' },
      { coin: 'ETH', side: 'B', px: '3000', sz: '1', value: 3000, time: 2, user: '0xb', method: 'backstop' },
      { coin: 'BTC', side: 'A', px: '50000', sz: '0.1', value: 5000, time: 1, user: '0xa', method: 'market' }, // dup
    ]);

    expect(marketState.marketLiquidations).toHaveLength(2);
    // unshift order: newest ingested first.
    expect(marketState.marketLiquidations[0]).toEqual(expect.objectContaining({ coin: 'ETH', time: 2 }));
    expect(marketState.marketLiquidations[1]).toEqual(expect.objectContaining({ coin: 'BTC', time: 1 }));
  });

  it('renders zero flow for a coin with no backend flow yet', async () => {
    const { ensureCoinTradeBuckets, syncActiveTradeStateSnapshot } = await import('../market-trades.js');
    const marketState = {};
    ensureCoinTradeBuckets(marketState, 'DOGE');

    syncActiveTradeStateSnapshot(marketState, 'DOGE');

    expect(marketState.orderFlow).toEqual({ buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500 });
    expect(marketState.largeTradeFlow).toEqual({ buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500 });
  });
});

