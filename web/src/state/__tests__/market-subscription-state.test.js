/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('market subscription state', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
  });

  it('does not attach mover rankings to the book/trade warm set', async () => {
    const { AppState } = await import('../store.js');
    const { getDesiredTradeCoins } = await import('../market-subscription-state.js');

    AppState.trading.trackedCoins = ['BTC', 'ETH', 'SOL'];
    AppState.trading.currentCoin = 'ETH';
    AppState.trading.recentCoins = ['SOL'];

    expect(getDesiredTradeCoins({ watchlistCoins: [] })).toEqual(['ETH', 'SOL']);
    AppState.ui.marketRadarConnected = true;
    expect(getDesiredTradeCoins({ watchlistCoins: [] })).toEqual(['ETH', 'SOL']);
  });

  it('streams watchlist coins alongside the active coin', async () => {
    const { AppState } = await import('../store.js');
    const { getDesiredTradeCoins } = await import('../market-subscription-state.js');

    AppState.trading.trackedCoins = [];
    AppState.trading.currentCoin = 'ETH'; // also watchlisted -> deduped
    expect(getDesiredTradeCoins({ watchlistCoins: ['BTC', 'SOL', 'ETH'] }))
      .toEqual(['ETH', 'BTC', 'SOL']);
  });

  it('streams the full watchlist ride-along and accepts injected watchlist coins', async () => {
    const { AppState } = await import('../store.js');
    const { getDesiredTradeCoins } = await import('../market-subscription-state.js');

    AppState.trading.currentCoin = 'ZEC';
    AppState.trading.trackedCoins = [];
    const bigWatchlist = Array.from({ length: 15 }, (_, i) => `COIN${i}`);
    expect(getDesiredTradeCoins({ watchlistCoins: bigWatchlist }))
      .toEqual(['ZEC', ...bigWatchlist]);

    // Param injection (test seam used across this module) bypasses the store.
    expect(getDesiredTradeCoins({ activeCoin: 'ZEC', watchlistCoins: ['BTC'] }))
      .toEqual(['ZEC', 'BTC']);
  });

  it('ignores object coins instead of stringifying them to [object Object]', async () => {
    const { AppState } = await import('../store.js');
    const { setDesiredMarketSubscription, getDesiredTradeCoins } = await import('../market-subscription-state.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';
    setDesiredMarketSubscription({ coin: { ticker: 'ETH' }, interval: '2h', tradeCoins: ['BTC'] });

    expect(AppState.connection.marketSubscription.coin).toBe('BTC');
    expect(getDesiredTradeCoins({ activeCoin: { ticker: 'ETH' }, watchlistCoins: ['SOL'] }))
      .toEqual(['SOL']);
  });

  it('stores desired subscription intent canonically and syncs mirrors', async () => {
    const { AppState } = await import('../store.js');
    const { setDesiredMarketSubscription } = await import('../market-subscription-state.js');

    setDesiredMarketSubscription({
      coin: 'BTC',
      interval: '5m',
      tradeCoins: ['BTC', 'ETH'],
    });

    expect(AppState.connection.marketSubscription).toEqual(expect.objectContaining({
      coin: 'BTC',
      interval: '5m',
      tradeCoins: ['BTC', 'ETH'],
    }));
  });

  it('starts with 4h indicator interval for default RVWAPs and clears when disabled', async () => {
    const { AppState, setRvwapLookbackVisible } = await import('../store.js');
    const { getDesiredMarketSubscription, setDesiredMarketSubscription } = await import('../market-subscription-state.js');

    setDesiredMarketSubscription({ coin: 'BTC', interval: '2h', tradeCoins: ['BTC'] });
    expect(AppState.ui.rvwapLookbacks).toEqual(['30D']);
    expect(getDesiredMarketSubscription().indicatorIntervals).toEqual(['4h']);

    setRvwapLookbackVisible('7D', false);
    setRvwapLookbackVisible('30D', false);
    setRvwapLookbackVisible('90D', false);
    setRvwapLookbackVisible('365D', false);
    expect(AppState.ui.rvwapLookbacks).toEqual([]);
    expect(getDesiredMarketSubscription().indicatorIntervals).toEqual([]);

    setRvwapLookbackVisible('90D', true);
    expect(getDesiredMarketSubscription().indicatorIntervals).toEqual(['4h']);
  });

  it('treats trade-coin reorders as unchanged intent', async () => {
    const { AppState } = await import('../store.js');
    const { getDesiredMarketSubscription, setDesiredMarketSubscription } = await import('../market-subscription-state.js');

    setDesiredMarketSubscription({
      coin: 'BTC',
      interval: '2h',
      tradeCoins: ['BTC', 'ETH', 'SOL'],
    });
    const first = AppState.connection.marketSubscription;
    const second = getDesiredMarketSubscription({
      coin: 'BTC',
      interval: '2h',
      tradeCoins: ['SOL', 'ETH', 'BTC'],
    });
    expect(second).toBe(first);
    expect(second.tradeCoins).toEqual(['BTC', 'ETH', 'SOL']);
  });
});
