/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const modifyLimitPrice = vi.fn();
const showToast = vi.fn();
const apiPost = vi.fn();
const notifySuccess = vi.fn();
const bulkCancelOrders = vi.fn();

vi.mock('../../services/order-modify.js', () => ({
  modifyLimitPrice,
}));

vi.mock('../toast.js', () => ({
  showToast,
}));

vi.mock('../../services/api.js', () => ({
  apiPost,
}));

vi.mock('../../services/action-feedback.js', () => ({
  notifySuccess,
}));

vi.mock('../../services/order-cancel.js', () => ({
  buildCancelsFromOrders: vi.fn(() => []),
  bulkCancelOrders,
}));

vi.mock('../../state/account-state.js', () => ({
  getAccountState: vi.fn(() => ({ assetPositions: [] })),
  getOpenOrders: vi.fn(() => []),
}));

vi.mock('../../state/account-selectors.js', () => ({
  getWalletAddress: vi.fn(() => '0x123'),
}));

vi.mock('../../services/wallet-service.js', () => ({
  requireKey: vi.fn(() => true),
}));

vi.mock('../../state/store.js', () => ({
  suppressPositionCoin: vi.fn(),
}));

describe('order ui modify flows', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('collects prompt values and delegates single-order modification to the service layer', async () => {
    modifyLimitPrice.mockResolvedValue(true);
    vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('50100')
      .mockReturnValueOnce('0.015');

    const { showModifyModal } = await import('../order-ui.js');
    await showModifyModal(123, 'BTC', true, '0.01', '50000');

    expect(modifyLimitPrice).toHaveBeenCalledWith({
      oid: 123,
      coin: 'BTC',
      isBuy: true,
      sz: 0.015,
      limitPx: 50100,
      reduceOnly: false,
    });
  });

  it('passes reduceOnly through so reduce-only orders stay reduce-only after modify', async () => {
    modifyLimitPrice.mockResolvedValue(true);
    vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('50100')
      .mockReturnValueOnce('0.015');

    const { showModifyModal } = await import('../order-ui.js');
    await showModifyModal(123, 'BTC', true, '0.01', '50000', true);

    expect(modifyLimitPrice).toHaveBeenCalledWith(expect.objectContaining({
      oid: 123,
      reduceOnly: true,
    }));
  });

  it('submits keyed schedule-cancel requests through the shared API helper', async () => {
    apiPost.mockResolvedValue({ status: 'ok' });
    vi.spyOn(window, 'prompt').mockReturnValueOnce('60000');

    const { scheduleCancelUI } = await import('../order-ui.js');
    await scheduleCancelUI();

    expect(apiPost).toHaveBeenCalledWith('/api/schedule-cancel', expect.objectContaining({
      privateKey: expect.anything(),
      time: expect.any(Number),
      mainnet: true,
    }));
  });

  it('resets the bulk-cancel button after the shared error path runs', async () => {
    document.body.innerHTML = `
      <button id="bulkCancelBtn">Cancel Selected</button>
      <input class="order-select" type="checkbox" checked data-oid="1" data-coin="BTC" />
    `;
    const button = document.getElementById('bulkCancelBtn');
    bulkCancelOrders.mockRejectedValue(new Error('boom'));

    const { bulkCancelSelected } = await import('../order-ui.js');
    await bulkCancelSelected(button);

    expect(showToast).toHaveBeenCalledWith('Error: boom', true);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Cancel Selected');
  });

  it('hides the confirm modal without depending on ambient window callback state', async () => {
    document.body.innerHTML = '<div id="confirmModal" class="confirm-modal show"></div>';
    window.confirmCallback = vi.fn();

    const { hideConfirmModal } = await import('../order-ui.js');
    hideConfirmModal(true);

    expect(document.getElementById('confirmModal')?.classList.contains('show')).toBe(false);
    expect(window.confirmCallback).not.toHaveBeenCalled();
  });
});
