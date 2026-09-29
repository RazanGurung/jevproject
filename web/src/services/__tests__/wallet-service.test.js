/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiPost = vi.fn();
let clearAllPreviewAppState = null;
const clearAllPreview = vi.fn(() => {
  if (clearAllPreviewAppState) {
    clearAllPreviewAppState.ui.chartPreviewLevels = [];
    clearAllPreviewAppState.ui.scalePreviewOrders = null;
  }
});

vi.mock('../api.js', () => ({
  apiGet,
  apiPost,
}));

vi.mock('../fills-service.js', () => ({
  fetchRecentFills: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../streams/account-stream.js', () => ({
  connectAccountStream: vi.fn(),
  disconnectAccountStream: vi.fn(),
  disablePollingFallback: vi.fn(),
  getAccountStreamSocket: vi.fn(() => ({})),
}));

vi.mock('../account-service.js', () => ({
  fetchAccount: vi.fn(() => Promise.resolve()),
  ensureMaxLeverageDefault: vi.fn(),
  fetchExchangeLeverage: vi.fn(),
}));

vi.mock('../market-service.js', () => ({
  refreshExchangeInfo: vi.fn(),
}));

vi.mock('../../render/scheduler.js', () => ({
  scheduleRender: vi.fn(),
}));

vi.mock('../../render/positions.js', () => ({
  renderPositions: vi.fn(),
}));

vi.mock('../../render/orders.js', () => ({
  renderOpenOrders: vi.fn(),
}));

vi.mock('../../ui/toast.js', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../state/preview-state.js', () => ({
  clearAllPreview,
}));

describe('wallet service clearKey', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    apiPost.mockResolvedValue({});
    apiGet.mockResolvedValue({});
    document.body.innerHTML = `
      <div id="walletDisconnected" style="display:none"></div>
      <div id="walletConnected" style="display:flex"></div>
      <div id="equityDisplay"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'secret';
    AppState.account.signerAddress = '0xsigner';
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { ok: true };
    AppState.account.openOrders = [{ oid: 1, coin: 'BTC', limitPx: '50000' }];
    AppState.ui.userEditedPrice = true;
    AppState.ui.scalePreviewOrders = [{ coin: 'BTC', limitPx: 100 }];
    AppState.ui.chartPreviewLevels = [{ price: 100, isBuy: true, label: 'BUY $100' }];
    clearAllPreviewAppState = AppState;
    // userEditedPrice is AppState-only
  });

  it('clears preview and user-edited chart state on logout', async () => {
    const { clearKey } = await import('../wallet-service.js');
    const { AppState } = await import('../../state/store.js');

    clearKey();

    expect(clearAllPreview).toHaveBeenCalled();
    expect(AppState.ui.chartPreviewLevels).toEqual([]);
    expect(AppState.ui.scalePreviewOrders).toBeNull();
    expect(AppState.ui.userEditedPrice).toBe(false);
    // cleared via AppState in clearKey path
    expect(AppState.account.openOrders).toEqual([]);
    expect(AppState.account.walletAddress).toBe('');
  });

  it('reopens the connect modal through the compat opener after disconnect confirmation', async () => {
    document.body.innerHTML = `
      <button id="walletAddrBtn">0x123</button>
      <div id="walletDisconnected" style="display:none"></div>
      <div id="walletConnected" style="display:flex"></div>
      <div id="leverageSliderContainer" style="display:flex"></div>
      <div id="equityDisplay"></div>
    `;
    const showConnectModal = vi.fn();
    window.showConnectModal = showConnectModal;

    const { handleWalletBtnClick } = await import('../wallet-service.js');

    handleWalletBtnClick();
    handleWalletBtnClick();

    expect(showConnectModal).toHaveBeenCalledTimes(1);
  });

  it('discards the raw key after the backend accepts it', async () => {
    const rawKey = 'a'.repeat(64);
    apiPost.mockImplementation(async (path) => {
      if (path === '/api/key-address') return { address: '0x1111111111111111111111111111111111111111' };
      return {};
    });

    const { deriveAndSaveAddress } = await import('../wallet-service.js');
    const { AppState } = await import('../../state/store.js');

    await expect(deriveAndSaveAddress(rawKey)).resolves.toBe(true);
    expect(AppState.account.privateKey).toBe('__AUTO__');
    expect(window.privateKey).toBeUndefined();
  });
});
