/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('legacy globals bridge', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('writes only AppState through setLegacy (Stage 3 Slice C)', async () => {
    const { AppState } = await import('../store.js');
    const { setLegacy } = await import('../legacy-globals.js');

    setLegacy('currentCoin', 'ETH');
    setLegacy('currentPrice', 3200);
    setLegacy('spotBalance', 42);
    setLegacy('openOrders', [{ oid: 1, coin: 'ETH', limitPx: '3200' }]);

    expect(AppState.trading.currentCoin).toBe('ETH');
    expect(AppState.trading.currentPrice).toBe(3200);
    expect(AppState.account.spotBalance).toBe(42);
    expect(AppState.account.openOrders).toEqual([{ oid: 1, coin: 'ETH', limitPx: '3200' }]);
    expect(window.currentCoin).toBeUndefined();
    expect(window.currentPrice).toBeUndefined();
    expect(window.spotBalance).toBeUndefined();
    expect(window.openOrders).toBeUndefined();
  });

  it('syncLegacyGlobals does not dual-write app state onto window', async () => {
    const { AppState } = await import('../store.js');
    const { syncLegacyGlobals } = await import('../legacy-globals.js');

    AppState.trading.currentCoin = 'SOL';
    AppState.trading.currentTimeframe = '1h';
    AppState.account.walletAddress = '0xabc';
    delete window.currentCoin;

    syncLegacyGlobals();

    expect(window.currentCoin).toBeUndefined();
    expect(AppState.trading.currentCoin).toBe('SOL');
  });

  it('ignores unknown legacy mirror names', async () => {
    const { setLegacy } = await import('../legacy-globals.js');

    setLegacy('doesNotExist', 'value');

    expect(window.doesNotExist).toBeUndefined();
  });

  it('keeps the managed signing marker out of the window surface', async () => {
    const { AppState } = await import('../store.js');
    const { setLegacy, syncLegacyGlobals } = await import('../legacy-globals.js');

    window.privateKey = 'stale-secret';
    setLegacy('privateKey', '__AUTO__');
    expect(AppState.account.privateKey).toBe('__AUTO__');
    expect(window.privateKey).toBeUndefined();

    window.privateKey = 'another-stale-secret';
    syncLegacyGlobals();
    expect(window.privateKey).toBeUndefined();
  });
});
