/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('scale preview state ownership', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns canonical scale preview orders from AppState', async () => {
    const { AppState } = await import('../store.js');
    const { getScalePreviewOrders, setScalePreviewOrders } = await import('../scale-preview-state.js');

    const orders = [{ coin: 'BTC', limitPx: 100 }];
    setScalePreviewOrders(orders);

    expect(getScalePreviewOrders()).toEqual(orders);
    expect(AppState.ui.scalePreviewOrders).toEqual(orders);
  });

  it('returns null when canonical state has no scale preview orders', async () => {
    const { AppState } = await import('../store.js');
    const { getScalePreviewOrders } = await import('../scale-preview-state.js');

    AppState.ui.scalePreviewOrders = null;

    expect(getScalePreviewOrders()).toBeNull();
  });
});
