/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initializeWindowState, installRuntimeGlobals } from '../window-state.js';

describe('window state bootstrap', () => {
  beforeEach(() => {
    window.switchCoin = undefined;
    window.syncMobileChartActionBar = undefined;
    window.updateTicketLayoutMode = undefined;
    window.candleCache = undefined;
    delete window.candleData;
    delete window.bboData;
    window.chartCanvas = undefined;
    window.chartCtx = undefined;
  });

  it('installs host-facing function globals only (Stage 3 Slice C)', () => {
    const switchCoin = vi.fn();
    const syncMobileChartActionBar = vi.fn();
    const updateTicketLayoutMode = vi.fn();
    const cache = new Map([['BTC', []]]);

    installRuntimeGlobals({
      candleCache: cache,
      switchCoin,
      updateTicketLayoutMode,
      syncMobileChartActionBar,
    });

    expect(window.switchCoin).toBe(switchCoin);
    expect(window.syncMobileChartActionBar).toBe(syncMobileChartActionBar);
    // App-state and unused function mirrors are no longer installed.
    expect(window.candleCache).toBeUndefined();
    expect(window.updateTicketLayoutMode).toBeUndefined();
  });

  it('seeds only chart canvas placeholders — not AppState dual-writes', () => {
    window.AppState = 'stale-global';
    const book = { asks: [{ px: 101 }], bids: [{ px: 100 }] };

    initializeWindowState({
      market: {
        book,
        allMids: { BTC: '100' },
        trades: [],
        largeTrades: [],
        orderFlow: {},
        largeTradeFlow: {},
      },
      account: { spotBalance: 12 },
      ui: {
        hideValues: true,
        userEditedPrice: true,
        chartSession: { status: 'notice', message: 'Offline' },
        chartTouchMode: 'trade',
      },
      connection: {
        marketSubscription: { coin: 'BTC', interval: '1m', tradeCoins: [] },
      },
    });

    expect(window.chartCanvas).toBeNull();
    expect(window.chartCtx).toBeNull();
    expect(window.AppState).toBe('stale-global');
    // Dual-write app mirrors removed.
    expect(window.bookData).toBeUndefined();
    expect(window.hideValues).toBeUndefined();
    expect(window.userEditedPrice).toBeUndefined();
    expect(window.chartNotice).toBeUndefined();
    expect(window.marketSubscriptionIntent).toBeUndefined();
    expect(window.candleData).toBeUndefined();
  });
});
