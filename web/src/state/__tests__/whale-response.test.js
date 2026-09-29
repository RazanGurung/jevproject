import { describe, expect, it } from 'vitest';

describe('whale response state', () => {
  it('decays recent whale events with a true three-minute half-life', async () => {
    const { ingestWhaleResponses, getDecayedWhaleEvents } = await import('../whale-response.js');
    const marketState = {};
    ingestWhaleResponses(marketState, 'BTC', [{
      tradeId: 'BTC:1', px: 50000, notional: 20000, time: 1000, isBuy: true, isWhale: true,
    }]);

    const [event] = getDecayedWhaleEvents(marketState, 'BTC', 181000, 180000);
    expect(event.weightedNotional).toBeCloseTo(10000, 5);
  });

  it('merges nearby same-side prints and folds the completed response into each price', async () => {
    const { ingestDomTrades, getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const { ingestWhaleResponses, sampleWhaleResponses } = await import('../whale-response.js');
    const marketState = {};
    const trades = [
      { tradeId: 'BTC:1', px: 50000, sz: 0.4, notional: 20000, time: 1000, isBuy: true, isWhale: true },
      { tradeId: 'BTC:2', px: 50010, sz: 0.4, notional: 20004, time: 3000, isBuy: true, isWhale: true },
    ];
    ingestDomTrades(marketState, 'BTC', trades);
    ingestWhaleResponses(marketState, 'BTC', trades);

    expect(marketState.whaleResponseCache.get('BTC')).toHaveLength(1);
    sampleWhaleResponses(marketState, { BTC: '50030' }, { BTC: 61000 }, 61000);

    const first = getDomTradeActivity(marketState, 'BTC').get(priceKey(50000, 'BTC'));
    const second = getDomTradeActivity(marketState, 'BTC').get(priceKey(50010, 'BTC'));
    expect(first.latestResponse.status).toBe('follow');
    expect(second.latestResponse.status).toBe('follow');
  });

  it('marks a missed response horizon unknown instead of using a late price', async () => {
    const { ingestDomTrades, getDomTradeActivity, priceKey } = await import('../dom-ladder-state.js');
    const { ingestWhaleResponses, sampleWhaleResponses } = await import('../whale-response.js');
    const marketState = {};
    const trades = [{
      tradeId: 'BTC:1', px: 50000, sz: 0.4, notional: 20000, time: 1000, isBuy: false, isWhale: true,
    }];
    ingestDomTrades(marketState, 'BTC', trades);
    ingestWhaleResponses(marketState, 'BTC', trades);

    sampleWhaleResponses(marketState, { BTC: '49000' }, { BTC: 70000 }, 70000);
    const activity = getDomTradeActivity(marketState, 'BTC').get(priceKey(50000, 'BTC'));
    expect(activity.latestResponse.status).toBe('unknown');
  });

  it('does not extend one response cohort beyond five seconds from its start', async () => {
    const { ingestWhaleResponses } = await import('../whale-response.js');
    const marketState = {};
    ingestWhaleResponses(marketState, 'BTC', [
      { tradeId: 'BTC:1', px: 50000, notional: 15000, time: 1000, isBuy: true, isWhale: true },
      { tradeId: 'BTC:2', px: 50001, notional: 15000, time: 5000, isBuy: true, isWhale: true },
      { tradeId: 'BTC:3', px: 50002, notional: 15000, time: 9000, isBuy: true, isWhale: true },
    ]);
    const cohorts = marketState.whaleResponseCache.get('BTC');
    expect(cohorts).toHaveLength(2);
    expect(cohorts[0].tradeIds).toEqual(['BTC:1', 'BTC:2']);
    expect(cohorts[1].tradeIds).toEqual(['BTC:3']);
  });

  it('merges same-side whales when opposite-side prints interleave', async () => {
    const { ingestWhaleResponses } = await import('../whale-response.js');
    const marketState = {};
    ingestWhaleResponses(marketState, 'BTC', [
      { tradeId: 'BTC:b1', px: 50000, notional: 15000, time: 1000, isBuy: true, isWhale: true },
      { tradeId: 'BTC:s1', px: 49999, notional: 15000, time: 2000, isBuy: false, isWhale: true },
      { tradeId: 'BTC:b2', px: 50001, notional: 15000, time: 3000, isBuy: true, isWhale: true },
    ]);

    const cohorts = marketState.whaleResponseCache.get('BTC');
    expect(cohorts).toHaveLength(2);
    expect(cohorts[0].tradeIds).toEqual(['BTC:b1', 'BTC:b2']);
    expect(cohorts[1].tradeIds).toEqual(['BTC:s1']);
  });
});
