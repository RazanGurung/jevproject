/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('state selectors', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();

    const { AppState } = await import('../store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 50000;
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentTimeframe = '4h';
    AppState.trading.currentOrderType = 'limit';
    AppState.account.privateKey = '';
    AppState.account.walletAddress = '';
    AppState.account.exchangeLeverageByCoin = {};
    AppState.account.defaultLeverageAppliedByCoin = {};
    AppState.market.allMids = {};
    AppState.market.book = { bids: [], asks: [] };
    AppState.market.candles = [];
    AppState.market.lastPriceUpdateAt = {};

    window.currentCoin = 'ETH';
    window.currentPrice = 1234;
    window.privateKey = 'legacy-key';
    window.walletAddress = '0xlegacy';
    window.allMids = { ETH: '1234' };
  });

  it('reads trading values from AppState instead of legacy globals', async () => {
    const { getCurrentCoin, getCurrentPrice } = await import('../trading-selectors.js');

    expect(getCurrentCoin()).toBe('BTC');
    expect(getCurrentPrice()).toBe(50000);
  });

  it('falls back to the 2h landing timeframe', async () => {
    const { AppState } = await import('../store.js');
    const { getCurrentTimeframe } = await import('../trading-selectors.js');
    AppState.trading.currentTimeframe = '';
    expect(getCurrentTimeframe()).toBe('2h');
  });

  it('reads account values from AppState instead of legacy globals', async () => {
    const { AppState } = await import('../store.js');
    AppState.account.privateKey = 'canonical-key';
    AppState.account.walletAddress = '0xabc';
    AppState.account.exchangeLeverageByCoin = { BTC: 12 };
    AppState.account.defaultLeverageAppliedByCoin = { BTC: 12 };

    const { getApiKey, getWalletAddress, getExchangeLeverage, getDefaultLeverageApplied } = await import('../account-selectors.js');

    expect(getApiKey()).toBe('canonical-key');
    expect(getWalletAddress()).toBe('0xabc');
    expect(getExchangeLeverage('BTC')).toBe(12);
    expect(getDefaultLeverageApplied('BTC')).toBe(12);
  });

  it('computes market price age from AppState timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T20:10:00Z'));

    const { AppState } = await import('../store.js');
    AppState.market.lastPriceUpdateAt = { BTC: Date.now() - 2000 };

    const { getPriceAgeMs } = await import('../market-selectors.js');

    expect(getPriceAgeMs('BTC')).toBe(2000);
  });
});
