/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('runtime mirrors', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('syncMarketRuntimeMirrors is a no-op (Stage 3 Slice C)', async () => {
    const { AppState } = await import('../store.js');
    const { syncMarketRuntimeMirrors } = await import('../runtime-mirrors.js');

    AppState.market.candles = [{ t: 1, c: 100 }];
    AppState.market.book = { bids: [{ px: '99' }], asks: [{ px: '101' }] };
    delete window.candles;
    delete window.bookData;

    syncMarketRuntimeMirrors();

    expect(window.candles).toBeUndefined();
    expect(window.bookData).toBeUndefined();
    expect(AppState.market.candles).toEqual([{ t: 1, c: 100 }]);
  });

  it('resets canonical market data without window dual-writes', async () => {
    const { AppState } = await import('../store.js');
    const { resetMarketRuntimeState } = await import('../runtime-mirrors.js');

    AppState.market.candles = [{ t: 1, c: 100 }];
    AppState.market.book = { bids: [{ px: '99' }], asks: [{ px: '101' }] };

    resetMarketRuntimeState();

    expect(AppState.market.candles).toEqual([]);
    expect(AppState.market.book).toEqual({ asks: [], bids: [] });
  });

  it('keeps book version in module state only', async () => {
    const { getBookVersionValue, incrementBookVersion, setBookVersion } = await import('../runtime-mirrors.js');

    setBookVersion(3);
    expect(getBookVersionValue()).toBe(3);
    expect(window.bookVersion).toBeUndefined();

    expect(incrementBookVersion()).toBe(4);
    expect(getBookVersionValue()).toBe(4);
  });
});
