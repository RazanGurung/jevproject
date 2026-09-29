import { describe, expect, it } from 'vitest';

// Ingest through the real pipeline: normalizeTradeBatch (market-trades.js) is
// the single parse/dedupe pass; ingestDomTrades consumes its output.
async function ingest(marketState, coin, trades, now) {
  const { normalizeTradeBatch } = await import('../market-trades.js');
  const { ingestDomTrades } = await import('../dom-ladder-state.js');
  ingestDomTrades(marketState, coin, normalizeTradeBatch(marketState, coin, trades, now));
}

describe('dom ladder trade activity state', () => {
  it('creates per-coin activity buckets on the market slice', async () => {
    const { ensureDomBuckets } = await import('../dom-ladder-state.js');
    const marketState = {};

    ensureDomBuckets(marketState, 'BTC');

    expect(marketState.domTradeCache.get('BTC')).toBeInstanceOf(Map);
  });

  it('bumps the activity version only when ingest changes the map', async () => {
    const { getDomActivityVersion } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;
    const batch = [{ time: now, px: '3000', sz: '2', side: 'B' }];

    expect(getDomActivityVersion(marketState)).toBe(0);
    await ingest(marketState, 'ETH', batch, now);
    expect(getDomActivityVersion(marketState)).toBe(1);
    // A resent batch is fully deduped upstream: no version bump.
    await ingest(marketState, 'ETH', batch, now);
    expect(getDomActivityVersion(marketState)).toBe(1);
  });

  it('accumulates buy/sell volume per price key with last-aggressor side and price', async () => {
    const { ingestDomTrades, getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    // BTC tick is 0.5 -> 50000 and 50000.5 are distinct keys.
    await ingest(marketState, 'BTC', [
      { time: now, px: '50000', sz: '0.4', side: 'B' },
      { time: now + 1, px: '50000', sz: '0.6', side: 'A' },
      { time: now + 2, px: '50000.5', sz: '1', side: 'B' },
    ], now + 2);

    const activity = getDomTradeActivity(marketState, 'BTC');
    const level = activity.get(priceKey('50000', 'BTC'));
    expect(level.buyVol).toBeCloseTo(0.4);
    expect(level.sellVol).toBeCloseTo(0.6);
    expect(level.lastSide).toBe('sell');
    expect(level.lastTime).toBe(now + 1);
    expect(level.px).toBe(50000);
    expect(activity.get(priceKey('50000.5', 'BTC')).buyVol).toBeCloseTo(1);
  });

  it('keeps the last-print fields on the newest trade when a batch arrives out of order', async () => {
    const { ingestDomTrades, getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    await ingest(marketState, 'BTC', [
      { time: now + 5, px: '50000', sz: '1', side: 'B' },
      { time: now, px: '50000', sz: '1', side: 'A' }, // older sell in the same batch
    ], now + 5);

    const level = getDomTradeActivity(marketState, 'BTC').get(priceKey('50000', 'BTC'));
    expect(level.buyVol).toBeCloseTo(1);
    expect(level.sellVol).toBeCloseTo(1);
    expect(level.lastSide).toBe('buy');
    expect(level.lastTime).toBe(now + 5);
  });

  it('dedupes identical trades on re-ingest of the same batch', async () => {
    const { ingestDomTrades, getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;
    const batch = [{ time: now, px: '3000', sz: '2', side: 'B' }];

    await ingest(marketState, 'ETH', batch, now);
    await ingest(marketState, 'ETH', batch, now);

    const level = getDomTradeActivity(marketState, 'ETH').get(priceKey('3000', 'ETH'));
    expect(level.buyVol).toBeCloseTo(2);
  });

  it('keeps session volume past the highlight TTL (only the tint decays)', async () => {
    const { ingestDomTrades, getDomTradeActivity, HIGHLIGHT_TTL_MS, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    await ingest(marketState, 'BTC', [{ time: now, px: '50000', sz: '1', side: 'B' }], now);
    // A later ingest (well past the TTL) must not drop the earlier volume.
    await ingest(marketState, 'BTC', [
      { time: now + HIGHLIGHT_TTL_MS * 10, px: '50000.5', sz: '1', side: 'A' },
    ], now + HIGHLIGHT_TTL_MS * 10);

    const activity = getDomTradeActivity(marketState, 'BTC');
    expect(activity.get(priceKey('50000', 'BTC')).buyVol).toBeCloseTo(1);
    expect(activity.get(priceKey('50000', 'BTC')).lastTime).toBe(now);
  });

  it('keeps per-coin activity isolated', async () => {
    const { ingestDomTrades, getDomTradeActivity } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    await ingest(marketState, 'BTC', [{ time: now, px: '50000', sz: '1', side: 'B' }], now);
    await ingest(marketState, 'ETH', [{ time: now, px: '3000', sz: '1', side: 'A' }], now);

    expect(getDomTradeActivity(marketState, 'BTC').size).toBe(1);
    expect(getDomTradeActivity(marketState, 'ETH').size).toBe(1);
    expect(getDomTradeActivity(marketState, 'SOL').size).toBe(0);
  });

  it('maps float-noise prices onto one canonical key', async () => {
    const { priceKey } = await import('../dom-ladder-state.js');
    // BTC tick 0.5
    expect(priceKey(50000.0000001, 'BTC')).toBe(priceKey('50000', 'BTC'));
  });

  it('accumulates the flash meter within the highlight TTL and resets it after quiet', async () => {
    const { ingestDomTrades, getDomTradeActivity, HIGHLIGHT_TTL_MS, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    // Two $5k prints within the TTL window sum to a $10k meter...
    await ingest(marketState, 'BTC', [{ time: now, px: '50000', sz: '0.1', side: 'B' }], now);
    await ingest(marketState, 'BTC', [{ time: now + 1000, px: '50000', sz: '0.1', side: 'B' }], now + 1000);
    const key = priceKey('50000', 'BTC');
    let level = getDomTradeActivity(marketState, 'BTC').get(key);
    expect(level.flashNotional).toBeCloseTo(10000);
    expect(level.flashTime).toBe(now + 1000);

    // ...but a print landing after the TTL resets the meter to its own value.
    const later = now + 1000 + HIGHLIGHT_TTL_MS + 1;
    await ingest(marketState, 'BTC', [{ time: later, px: '50000', sz: '0.02', side: 'A' }], later);
    level = getDomTradeActivity(marketState, 'BTC').get(key);
    expect(level.flashNotional).toBeCloseTo(1000);
    expect(level.flashTime).toBe(later);
  });

  it('stamps whaleTime only for prints at or above the whale notional', async () => {
    const { ingestDomTrades, getDomTradeActivity, WHALE_NOTIONAL, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;
    const key = priceKey('50000', 'BTC');

    // $5k print: no whale stamp.
    await ingest(marketState, 'BTC', [{ time: now, px: '50000', sz: '0.1', side: 'B' }], now);
    expect(getDomTradeActivity(marketState, 'BTC').get(key).whaleTime).toBe(0);

    // $110k print (>= WHALE_NOTIONAL): stamped.
    expect(WHALE_NOTIONAL).toBe(100000);
    await ingest(marketState, 'BTC', [{ time: now + 1, px: '50000', sz: '2.2', side: 'A' }], now + 1);
    expect(getDomTradeActivity(marketState, 'BTC').get(key).whaleTime).toBe(now + 1);
  });

  it('accumulates rolling whale volume and tracks the largest print per price', async () => {
    const { ingestDomTrades, getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    await ingest(marketState, 'BTC', [
      { time: now, px: '50000', sz: '0.06', side: 'B' },     // $3k dust
      { time: now + 1, px: '50000', sz: '3', side: 'A' },   // $150k whale (largest)
      { time: now + 2, px: '50000', sz: '2.4', side: 'B' }, // $120k whale, newer but smaller
    ], now + 2);

    const level = getDomTradeActivity(marketState, 'BTC').get(priceKey('50000', 'BTC'));
    expect(level.whaleVol).toBeCloseTo(5.4); // whales only, dust excluded
    expect(level.maxPrintNotional).toBeCloseTo(150000);
    expect(level.maxPrintSz).toBeCloseTo(3);
    expect(level.maxPrintSide).toBe('sell');
    expect(level.maxPrintTime).toBe(now + 1); // largest, not newest
  });

  it('keeps flashTime and whaleTime on the newest print when a batch arrives out of order', async () => {
    const { ingestDomTrades, getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    await ingest(marketState, 'BTC', [
      { time: now + 5, px: '50000', sz: '2.2', side: 'B' }, // $110k whale, newest
      { time: now, px: '50000', sz: '0.01', side: 'A' },    // older dust in the same batch
    ], now + 5);

    const level = getDomTradeActivity(marketState, 'BTC').get(priceKey('50000', 'BTC'));
    expect(level.flashTime).toBe(now + 5);
    expect(level.whaleTime).toBe(now + 5);
    expect(level.flashNotional).toBeCloseTo(110500); // both prints inside one window
  });

  it('does not let a genuinely stale out-of-order print brighten a fresh flash', async () => {
    const { getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    await ingest(marketState, 'BTC', [
      { time: now, px: '50000', sz: '2.2', side: 'B' },
      { time: now - 60_000, px: '50000', sz: '1', side: 'A' },
    ], now);

    const level = getDomTradeActivity(marketState, 'BTC').get(priceKey('50000', 'BTC'));
    expect(level.flashTime).toBe(now);
    expect(level.flashNotional).toBeCloseTo(110000);
    expect(level.sellVol).toBeCloseTo(1);
  });

  it('keeps session volume and whale markers after many later prints elsewhere', async () => {
    const { getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    // Whale at an early price, then flood distinct prices (more than the old
    // 500-tape window). DOM state must remain — rolling 500 is top FLOW only.
    await ingest(marketState, 'BTC', [
      { time: now, px: '50000', sz: '2.2', side: 'B' }, // $110k whale
    ], now);

    const flood = [];
    for (let i = 1; i <= 520; i++) {
      flood.push({ time: now + i, px: String(50000 + i * 0.5), sz: '1', side: 'A' });
    }
    await ingest(marketState, 'BTC', flood, now + 520);

    const activity = getDomTradeActivity(marketState, 'BTC');
    const anchor = activity.get(priceKey('50000', 'BTC'));
    expect(anchor.buyVol).toBeCloseTo(2.2);
    expect(anchor.sellVol).toBeCloseTo(0);
    expect(anchor.lastTime).toBe(now);
    expect(anchor.flashTime).toBe(now);
    expect(anchor.whaleTime).toBe(now);
    expect(anchor.maxPrintNotional).toBeCloseTo(110000);
    expect(anchor.maxPrintSide).toBe('buy');
    expect(activity.size).toBe(521);
    expect(marketState.domTradeQueue).toBeUndefined();
  });

  it('does not shrink session volume when later prints land elsewhere', async () => {
    const { getDomTradeActivity, HIGHLIGHT_TTL_MS, priceKey } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    await ingest(marketState, 'BTC', [
      { time: now, px: '50000', sz: '0.4', side: 'B' },
      { time: now + 1, px: '50000', sz: '0.6', side: 'A' },
    ], now + 1);
    const key = priceKey('50000', 'BTC');
    expect(getDomTradeActivity(marketState, 'BTC').get(key).buyVol).toBeCloseTo(0.4);
    expect(getDomTradeActivity(marketState, 'BTC').get(key).sellVol).toBeCloseTo(0.6);

    await ingest(marketState, 'BTC', [
      { time: now + HIGHLIGHT_TTL_MS * 20, px: '51000', sz: '2', side: 'B' },
    ], now + HIGHLIGHT_TTL_MS * 20);

    const level = getDomTradeActivity(marketState, 'BTC').get(key);
    expect(level.buyVol).toBeCloseTo(0.4);
    expect(level.sellVol).toBeCloseTo(0.6);
  });

  it('trims farthest session prices when the unique-price cap is exceeded', async () => {
    const {
      getDomTradeActivity, MAX_SESSION_PRICES, priceKey, trimSessionPrices,
    } = await import('../dom-ladder-state.js');
    const marketState = {};
    const now = 10_000;

    // Build just over the session cap with prices spreading away from mid.
    const trades = [];
    for (let i = 0; i < MAX_SESSION_PRICES + 5; i++) {
      trades.push({ time: now + i, px: String(50000 + i * 0.5), sz: '1', side: 'B' });
    }
    await ingest(marketState, 'BTC', trades, now + MAX_SESSION_PRICES + 5);

    const activity = getDomTradeActivity(marketState, 'BTC');
    expect(activity.size).toBe(MAX_SESSION_PRICES);
    // Last trade sets mid near the high end; farthest (lowest) prices drop.
    expect(activity.has(priceKey('50000', 'BTC'))).toBe(false);
    expect(activity.has(priceKey(String(50000 + (MAX_SESSION_PRICES + 4) * 0.5), 'BTC'))).toBe(true);

    // Pure helper: keep the closest N levels to an explicit mid.
    const sample = new Map([
      ['a', { px: 100, buyVol: 1, sellVol: 0 }],
      ['b', { px: 200, buyVol: 1, sellVol: 0 }],
      ['c', { px: 300, buyVol: 1, sellVol: 0 }],
    ]);
    trimSessionPrices(sample, 200, 2);
    // b is on mid; a and c are equidistant — key order keeps 'a' over 'c'.
    expect([...sample.keys()].sort()).toEqual(['a', 'b']);
    expect(sample.has('c')).toBe(false);
  });

  it('clears session mid with pruneMarketCoinCaches', async () => {
    const { pruneMarketCoinCaches } = await import('../market-trades.js');
    const marketState = {};
    const now = 10_000;
    await ingest(marketState, 'BTC', [{ time: now, px: '50000', sz: '1', side: 'B' }], now);
    await ingest(marketState, 'ETH', [{ time: now, px: '3000', sz: '1', side: 'A' }], now);
    expect(marketState.domSessionMid.get('BTC')).toBe(50000);

    pruneMarketCoinCaches(marketState, ['ETH']);
    expect(marketState.domTradeCache.has('BTC')).toBe(false);
    expect(marketState.domSessionMid.has('BTC')).toBe(false);
    expect(marketState.domTradeCache.has('ETH')).toBe(true);
  });
});
