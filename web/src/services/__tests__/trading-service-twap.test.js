/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiPost = vi.fn();
const notifySuccess = vi.fn();
const showToast = vi.fn();
const setLastTwapId = vi.fn();
const upsertPendingTwapState = vi.fn();
const removeTwapState = vi.fn();
const getLastTwapId = vi.fn(() => null);
let twapStatesSnapshot = [];
let currentCoin = 'BTC';
let currentSide = 'buy';
let currentOrderType = 'twap';

vi.mock('../api.js', () => ({
  apiPost,
}));

vi.mock('../wallet-service.js', () => ({
  requireKey: vi.fn(() => true),
}));

vi.mock('../action-feedback.js', () => ({
  notifySuccess,
}));

vi.mock('../../state/account-selectors.js', () => ({
  getWalletAddress: vi.fn(() => '0xabc'),
}));

vi.mock('../../state/trading-selectors.js', () => ({
  getCurrentCoin: () => currentCoin,
  getCurrentOrderType: () => currentOrderType,
  getCurrentSide: () => currentSide,
}));

vi.mock('../../state/account-state.js', () => ({
  getTwapStatesSnapshot: () => twapStatesSnapshot,
  getLastTwapId,
  removeTwapState,
  setLastTwapId,
  upsertPendingTwapState,
}));

vi.mock('../../ui/toast.js', () => ({
  showToast,
}));

vi.mock('../exchange-auth.js', () => ({
  getManagedExchangePrivateKey: vi.fn(() => '__AUTO__'),
}));

describe('trading service twap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    twapStatesSnapshot = [];
    currentCoin = 'BTC';
    currentSide = 'buy';
    currentOrderType = 'twap';
    document.body.innerHTML = '';
  });

  it('uses safe defaults when TWAP controls are absent instead of throwing', async () => {
    apiPost.mockResolvedValue({
      status: 'ok',
      response: { data: { status: { running: { twapId: 77 } } } },
    });

    const { placeTwapOrder } = await import('../trading-service-twap.js');
    await expect(placeTwapOrder(250)).resolves.toBe(true);

    expect(apiPost).toHaveBeenCalledWith('/api/twap-order', expect.objectContaining({
      coin: 'BTC',
      isBuy: true,
      sz: 250,
      minutes: 10,
      randomize: false,
    }));
  });

  it('captures coin and side at submit time before async response resolves', async () => {
    document.body.innerHTML = `
      <select id="twapMinutes"><option value="15" selected>15</option></select>
      <select id="twapRandomize"><option value="true" selected>true</option></select>
      <input id="reduceOnlyCheck" type="checkbox" checked />
      <button id="placeBtn">Place Order</button>
    `;

    let resolveRequest;
    apiPost.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    const { placeTwapOrder } = await import('../trading-service-twap.js');
    const request = placeTwapOrder(500);

    currentCoin = 'ETH';
    currentSide = 'sell';
    resolveRequest({
      status: 'ok',
      response: { data: { status: { running: { twapId: 88 } } } },
    });
    await request;

    expect(apiPost).toHaveBeenCalledWith('/api/twap-order', expect.objectContaining({
      coin: 'BTC',
      isBuy: true,
      minutes: 15,
      randomize: true,
    }));
    expect(upsertPendingTwapState).toHaveBeenCalledWith(88, expect.objectContaining({
      coin: 'BTC',
      side: 'buy',
      pending: true,
    }));
  });

  it('uses stored TWAP state coin when cancelling by explicit id', async () => {
    document.body.innerHTML = '<button id="cancelTwapBtn">Cancel TWAP</button>';
    currentCoin = 'ETH';
    twapStatesSnapshot = [[123, { coin: 'BTC', side: 'buy' }]];
    apiPost.mockResolvedValue({
      status: 'ok',
      response: { data: { status: {} } },
    });

    const { cancelActiveTwap } = await import('../trading-service-twap.js');
    await cancelActiveTwap(123);

    expect(apiPost).toHaveBeenCalledWith('/api/twap-cancel', expect.objectContaining({
      coin: 'BTC',
      twapId: 123,
      mainnet: true,
    }));
    expect(removeTwapState).toHaveBeenCalledWith(123);
  });
});
