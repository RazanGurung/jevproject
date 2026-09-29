/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('trading runtime ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    window.userEditedPrice = undefined;
    window.limitPriceEntryMode = undefined;
    window.limitPriceAutoTrack = undefined;
    window.limitPreviewAutoTrack = undefined;
    window.activeCandleRequestToken = undefined;
  });

  it('prefers canonical user-edited state over stale window mirrors', async () => {
    const { AppState } = await import('../store.js');
    const { getUserEditedPrice } = await import('../trading-runtime.js');

    AppState.ui.userEditedPrice = false;
    window.userEditedPrice = true;

    expect(getUserEditedPrice()).toBe(false);
  });

  it('prefers canonical auto-track flags over stale window mirrors', async () => {
    const { AppState } = await import('../store.js');
    const { isLimitPriceAutoTrackEnabled, isLimitPreviewAutoTrackEnabled } = await import('../trading-runtime.js');

    AppState.ui.limitPriceAutoTrack = true;
    AppState.ui.limitPreviewAutoTrack = true;
    window.limitPriceAutoTrack = false;
    window.limitPreviewAutoTrack = false;

    expect(isLimitPriceAutoTrackEnabled()).toBe(true);
    expect(isLimitPreviewAutoTrackEnabled()).toBe(true);
  });

  it('prefers canonical limit price entry mode over stale window mirrors', async () => {
    const { AppState } = await import('../store.js');
    const { getLimitPriceEntryMode } = await import('../trading-runtime.js');

    AppState.ui.limitPriceEntryMode = 'auto';
    window.limitPriceEntryMode = 'manual';

    expect(getLimitPriceEntryMode()).toBe('auto');
  });

  it('prefers canonical candle request tokens over stale window mirrors', async () => {
    const { AppState } = await import('../store.js');
    const { getActiveCandleRequestToken } = await import('../trading-runtime.js');

    AppState.ui.activeCandleRequestToken = 'canonical-token';
    window.activeCandleRequestToken = 'stale-token';

    expect(getActiveCandleRequestToken()).toBe('canonical-token');
  });
});
