/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncLocalTradingVisualState = vi.fn();

vi.mock('../trading-visual-sync.js', () => ({
  syncLocalTradingVisualState,
}));

describe('position close helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('marks pending position closes on canonical account state', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.pendingHip3CloseUntilByCoin = {};

    const { markPendingPositionClose } = await import('../position-close.js');
    const until = markPendingPositionClose('xyz:SP500', 5000);

    expect(until).toBeGreaterThan(Date.now());
    expect(AppState.account.pendingHip3CloseUntilByCoin['xyz:SP500']).toBe(until);
  });

  it('applies shared optimistic full-close cleanup for a coin without removing same-coin orders', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', side: 'B', limitPx: 99500, sz: 0.01 },
      { oid: 2, coin: 'ETH', side: 'A', limitPx: 3100, sz: 0.5 },
    ];
    AppState.account.state = {
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.5', entryPx: '100000', unrealizedPnl: '0' } },
        { position: { coin: 'ETH', szi: '1', entryPx: '3000', unrealizedPnl: '0' } },
      ],
    };

    const { applyClosePositionSuccess } = await import('../position-close.js');
    applyClosePositionSuccess({ coin: 'BTC', fraction: 1.0 });

    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 1, coin: 'BTC' }),
      expect.objectContaining({ oid: 2, coin: 'ETH' }),
    ]);
    expect(AppState.account.state.assetPositions).toEqual([
      expect.objectContaining({
        position: expect.objectContaining({ coin: 'ETH' }),
      }),
    ]);
    expect(syncLocalTradingVisualState).toHaveBeenCalled();
  });
});
