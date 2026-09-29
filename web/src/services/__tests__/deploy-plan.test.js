/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const setOrderType = vi.fn();
const setSide = vi.fn();
const updateSummary = vi.fn();
const updateTicketLayoutMode = vi.fn();
const applyPlaybook = vi.fn();
const setLastDeployedPlan = vi.fn();
const showToast = vi.fn();
const getOrderPreviewFetcher = vi.fn();
const getCoinSwitcher = vi.fn();

let currentCoin = 'BTC';
let currentPrice = 100;
let mids = { BTC: '100' };

vi.mock('../../ui/tabs.js', () => ({
  setOrderType,
  setSide,
  updateSummary,
  updateTicketLayoutMode,
}));

vi.mock('../playbooks.js', () => ({
  applyPlaybook,
}));

vi.mock('../../state/store.js', () => ({
  AppState: {},
  setLastDeployedPlan,
}));

vi.mock('../../state/market-selectors.js', () => ({
  getAllMids: () => mids,
}));

vi.mock('../../state/trading-selectors.js', () => ({
  getCurrentCoin: () => currentCoin,
  getCurrentPrice: () => currentPrice,
}));

vi.mock('../../ui/toast.js', () => ({
  showToast,
}));

vi.mock('../../state/app-host.js', () => ({
  getOrderPreviewFetcher,
  getCoinSwitcher,
}));

describe('deploy plan', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    currentCoin = 'BTC';
    currentPrice = 100;
    mids = { BTC: '100' };
    document.body.innerHTML = `
      <button class="type-tab" data-arg="limit"></button>
      <input id="priceInput" />
      <input id="sizeInput" />
      <input id="sizeSlider" />
      <input id="tpPctInput" />
      <input id="slPctInput" />
    `;
  });

  it('refreshes the order preview through the compat accessor after deploying a ready plan', async () => {
    const fetchOrderPreview = vi.fn();
    getOrderPreviewFetcher.mockReturnValue(fetchOrderPreview);

    const { deployTradePlan } = await import('../deploy-plan.js');
    deployTradePlan({
      coin: 'BTC',
      side: 'buy',
      orderType: 'limit',
      playbook: 'Momentum',
      limitPx: 101.25,
      sizeUsd: 250,
      takeProfitPct: 6,
      stopLossPct: 2,
      toastMessage: 'Plan deployed',
    });

    expect(setOrderType).toHaveBeenCalledTimes(1);
    expect(setSide).toHaveBeenCalledWith('buy');
    expect(document.getElementById('priceInput').value).toBe('101.25');
    expect(document.getElementById('sizeInput').value).toBe('250');
    expect(fetchOrderPreview).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Plan deployed', false);
  });

  it('switches coin through the compat accessor before retrying plan deployment', async () => {
    const switchCoin = vi.fn((coin) => {
      currentCoin = coin;
      mids[coin] = '105';
    });
    const fetchOrderPreview = vi.fn();
    getCoinSwitcher.mockReturnValue(switchCoin);
    getOrderPreviewFetcher.mockReturnValue(fetchOrderPreview);

    const rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    const { deployTradePlan } = await import('../deploy-plan.js');
    deployTradePlan({
      coin: 'ETH',
      side: 'sell',
      orderType: 'limit',
      playbook: 'Manual',
      limitPx: 104.5,
      sizeUsd: 150,
    });

    expect(switchCoin).toHaveBeenCalledWith('ETH');
    expect(fetchOrderPreview).not.toHaveBeenCalled();

    rafQueue[0]?.();

    expect(setSide).toHaveBeenCalledWith('sell');
    expect(fetchOrderPreview).toHaveBeenCalledTimes(1);
  });
});
