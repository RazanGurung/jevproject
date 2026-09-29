/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    apiPost: vi.fn(),
  };
});

describe('ticket order preview runtime', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="previewMarginRow"></div>
      <div id="previewLiqRow"></div>
      <div id="previewDistRow"></div>
      <div id="previewMargin"></div>
      <div id="previewLiq"></div>
      <div id="previewDist"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.account.walletAddress = '0xabc';
    AppState.account.exchangeLeverageByCoin = { BTC: 7 };
    AppState.account.state = {
      riskSummary: {
        accountValue: '1000',
        withdrawable: '800',
        availableMargin: '800',
      },
    };
  });

  it('requests preview data from explicit ticket input without reading the form', async () => {
    const { apiPost } = await import('../../services/api.js');
    apiPost.mockResolvedValue({ liquidationPx: 80, initialMargin: 35, distToLiqPct: 20 });

    const { fetchOrderPreview } = await import('../ticket-order-preview-runtime.js');
    await fetchOrderPreview({
      sizeUsd: 250,
      rawLimitPrice: 100,
    });

    expect(apiPost).toHaveBeenCalledWith('/api/order-preview', expect.objectContaining({
      coin: 'BTC',
      isBuy: true,
      sizeUsd: 250,
      leverage: 7,
      limitPx: 100,
      accountValue: 1000,
      availableEquity: 800,
    }));
  });
});
