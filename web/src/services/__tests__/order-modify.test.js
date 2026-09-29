/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiPost = vi.fn();
const notifySuccess = vi.fn();
const showToast = vi.fn();
const registerLockedOpenOrder = vi.fn();
const removeOpenOrdersByOids = vi.fn();
const suppressOrderOid = vi.fn();
const syncLocalTradingVisualState = vi.fn();

const AppState = {
  trading: {
    currentCoin: 'BTC',
    currentPrice: 0,
  },
  market: {
    allMids: {},
  },
};

vi.mock('../api.js', () => ({
  apiPost,
}));

vi.mock('../action-feedback.js', () => ({
  notifySuccess,
}));

vi.mock('../wallet-service.js', () => ({
  requireKey: vi.fn(() => true),
}));

vi.mock('../exchange-auth.js', () => ({
  getManagedExchangePrivateKey: vi.fn(() => '__AUTO__'),
}));

vi.mock('../../state/account-state.js', () => ({
  registerLockedOpenOrder,
  removeOpenOrdersByOids,
}));

vi.mock('../../ui/toast.js', () => ({
  showToast,
}));

vi.mock('../../state/store.js', () => ({
  AppState,
  suppressOrderOid,
}));

vi.mock('../../state/coin-meta.js', () => ({
  getTickSize: vi.fn(() => 0.5),
}));

vi.mock('../trading-visual-sync.js', () => ({
  syncLocalTradingVisualState,
}));

describe('order modify service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 0;
    AppState.market.allMids = {};
  });

  it('optimistically syncs single-order modify success into locked order state', async () => {
    apiPost.mockResolvedValue({ status: 'ok' });

    const { modifyLimitPrice } = await import('../order-modify.js');
    await modifyLimitPrice({
      oid: 123,
      coin: 'BTC',
      isBuy: true,
      sz: 0.015,
      limitPx: 50100,
    });

    expect(apiPost).toHaveBeenCalledWith('/api/modify-order', expect.objectContaining({
      privateKey: '__AUTO__',
      oid: 123,
      coin: 'BTC',
      isBuy: true,
      sz: 0.015,
      limitPx: 50100,
    }));
    expect(registerLockedOpenOrder).toHaveBeenCalledWith(expect.objectContaining({
      oid: 123,
      coin: 'BTC',
      side: 'B',
      sz: 0.015,
      limitPx: 50100,
    }));
    expect(syncLocalTradingVisualState).toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalledWith('✓ BTC order modified', expect.objectContaining({
      refreshAccount: true,
      refreshChart: true,
    }));
  });

  it('preserves reduceOnly on modify so reduce-only orders stay reduce-only', async () => {
    apiPost.mockResolvedValue({ status: 'ok' });

    const { modifyLimitPrice } = await import('../order-modify.js');
    await modifyLimitPrice({
      oid: 77,
      coin: 'BTC',
      isBuy: false,
      sz: 0.01,
      limitPx: 51000,
      reduceOnly: true,
    });

    expect(apiPost).toHaveBeenCalledWith('/api/modify-order', expect.objectContaining({
      oid: 77,
      reduceOnly: true,
    }));
    expect(registerLockedOpenOrder).toHaveBeenCalledWith(expect.objectContaining({
      oid: 77,
      reduceOnly: true,
    }));
  });

  it('rejects a below-minimum opening drag before cancel-replace reaches the exchange', async () => {
    const { modifyLimitPrice } = await import('../order-modify.js');
    const ok = await modifyLimitPrice({
      oid: 77,
      coin: 'BTC',
      isBuy: true,
      sz: 0.00018,
      limitPx: 55000,
      reduceOnly: false,
    });

    expect(ok).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('$10.00 exchange minimum'), true);
  });

  it('moves tp/sl triggers atomically through the native modify endpoint', async () => {
    apiPost.mockResolvedValue({ status: 'ok' });
    AppState.trading.currentPrice = 100000;

    const { modifyTriggerPrice } = await import('../order-modify.js');
    const ok = await modifyTriggerPrice({
      oid: 321,
      coin: 'BTC',
      isBuy: false,
      sz: 0.01,
      triggerPx: 99000,
      tpsl: 'sl',
    });

    expect(ok).toBe(true);
    // One atomic call: no cancel-then-place, no protection-loss window, and
    // sz is passed through in coin units (no USD notional round-trip drift).
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/modify-order', expect.objectContaining({
      privateKey: '__AUTO__',
      oid: 321,
      coin: 'BTC',
      isBuy: false,
      sz: 0.01,
      triggerPx: 99000,
      isMarket: true,
      tpsl: 'sl',
      reduceOnly: true,
      mainnet: true,
    }));
    expect(registerLockedOpenOrder).toHaveBeenCalledWith(expect.objectContaining({
      oid: 321,
      coin: 'BTC',
      triggerPx: 99000,
      tpsl: 'sl',
      reduceOnly: true,
    }));
    expect(notifySuccess).toHaveBeenCalledWith('✓ BTC SL trigger moved', expect.objectContaining({
      refreshAccount: true,
      refreshChart: true,
    }));
  });

  it('re-keys optimistic state to the exchange-assigned replacement oid', async () => {
    // HL modify = cancel+replace: the backend returns the new oid. The old
    // oid must be suppressed/removed or it lingers as a ghost chart box on
    // HIP-3 dexes where the user stream is slow to reconcile.
    apiPost.mockResolvedValue({ status: 'ok', oid: 9001 });

    const { modifyLimitPrice } = await import('../order-modify.js');
    await modifyLimitPrice({
      oid: 123,
      coin: 'xyz:CL',
      isBuy: true,
      sz: 0.23,
      limitPx: 88.1,
    });

    expect(suppressOrderOid).toHaveBeenCalledWith(123);
    expect(removeOpenOrdersByOids).toHaveBeenCalledWith([123]);
    expect(registerLockedOpenOrder).toHaveBeenCalledWith(expect.objectContaining({
      oid: 9001,
      coin: 'xyz:CL',
      limitPx: 88.1,
    }));
  });

  it('keeps the original oid when the backend does not return a replacement', async () => {
    apiPost.mockResolvedValue({ status: 'ok', oid: 0 });

    const { modifyLimitPrice } = await import('../order-modify.js');
    await modifyLimitPrice({
      oid: 123,
      coin: 'BTC',
      isBuy: true,
      sz: 0.015,
      limitPx: 50100,
    });

    expect(suppressOrderOid).not.toHaveBeenCalled();
    expect(removeOpenOrdersByOids).not.toHaveBeenCalled();
    expect(registerLockedOpenOrder).toHaveBeenCalledWith(expect.objectContaining({ oid: 123 }));
  });

  it('keeps the existing trigger untouched when the modify call fails', async () => {
    apiPost.mockResolvedValue({ status: 'error', error: 'exchange unavailable' });
    AppState.trading.currentPrice = 100000;

    const { modifyTriggerPrice } = await import('../order-modify.js');
    const ok = await modifyTriggerPrice({
      oid: 321,
      coin: 'BTC',
      isBuy: false,
      sz: 0.01,
      triggerPx: 99000,
      tpsl: 'sl',
    });

    expect(ok).toBe(false);
    expect(registerLockedOpenOrder).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Modify failed: exchange unavailable', true);
  });

  it('rejects unsafe tp/sl trigger prices that would fire immediately', async () => {
    AppState.trading.currentPrice = 100000;

    const { modifyTriggerPrice } = await import('../order-modify.js');
    const ok = await modifyTriggerPrice({
      oid: 654,
      coin: 'BTC',
      isBuy: false,
      sz: 0.01,
      triggerPx: 100100,
      tpsl: 'sl',
    });

    expect(ok).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      'Rejected: SL would trigger immediately at the current market price',
      true,
    );
  });
});
