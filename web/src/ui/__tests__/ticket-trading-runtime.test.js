/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket trading runtime', () => {
  it('submits ticket input through the trading service with shared callbacks', async () => {
    const { createTicketTradingRuntime } = await import('../ticket-trading-runtime.js');
    const placeOrder = vi.fn();
    const loadTradingActions = vi.fn().mockResolvedValue({ placeOrder });
    const updateSummary = vi.fn();
    const updateTicketLayoutMode = vi.fn();
    const readOrderTicketInput = vi.fn(() => ({ sizeUsd: 680 }));

    const runtime = createTicketTradingRuntime({
      loadTradingActions,
      readOrderTicketInput,
      updateSummary,
      updateTicketLayoutMode,
    });

    await runtime.submitOrderFromTicket();

    expect(readOrderTicketInput).toHaveBeenCalledWith({
      onSizeUsdChange: updateSummary,
    });
    expect(placeOrder).toHaveBeenCalledWith(
      { sizeUsd: 680 },
      {
        onAccepted: updateTicketLayoutMode,
        onSizeAdjusted: updateSummary,
      }
    );
  });

  it('uses side-specific auto price when compact 1m limit submit runs in auto mode', async () => {
    const { createTicketTradingRuntime } = await import('../ticket-trading-runtime.js');
    const placeOrder = vi.fn();
    const setSide = vi.fn();
    const readOrderTicketInput = vi.fn(() => ({ sizeUsd: 680 }));

    const runtime = createTicketTradingRuntime({
      loadTradingActions: vi.fn().mockResolvedValue({ placeOrder }),
      getEffectiveCurrentOrderType: () => 'limit',
      getEffectiveCurrentTimeframe: () => '1m',
      getLimitPriceEntryMode: () => 'auto',
      getUserEditedPrice: () => false,
      getAutoLimitPriceForSide: (side) => (side === 'sell' ? 103 : 97),
      setSide,
      readOrderTicketInput,
      updateSummary: vi.fn(),
      updateTicketLayoutMode: vi.fn(),
    });

    await runtime.placeOrderWithSide('sell', 'compact-btn');

    expect(setSide).toHaveBeenCalledWith('sell');
    expect(readOrderTicketInput).toHaveBeenCalledWith(expect.objectContaining({
      submitButtonEl: 'compact-btn',
      rawLimitPrice: 103,
    }));
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('routes limit preview requests through the shared chart preview helper', async () => {
    const { createTicketTradingRuntime } = await import('../ticket-trading-runtime.js');
    document.body.innerHTML = `
      <input id="sizeInput" value="250" />
      <input id="priceInput" value="123.45" />
    `;
    const previewLimitOrderOnChart = vi.fn();

    const runtime = createTicketTradingRuntime({
      requireKey: vi.fn(() => true),
      getElementById: (id) => document.getElementById(id),
      getEffectiveCurrentOrderType: () => 'limit',
      getEffectiveCurrentTimeframe: () => '4h',
      getEffectiveCurrentSide: () => 'buy',
      previewLimitOrderOnChart,
      setChartPreviewLevels: vi.fn(),
      requestChartRefresh: vi.fn(),
      showToast: vi.fn(),
    });

    await runtime.previewOrder();

    expect(previewLimitOrderOnChart).toHaveBeenCalledWith(expect.objectContaining({
      currentTimeframe: '4h',
      sizeUsd: 250,
      limitPx: 123.45,
      currentSide: 'buy',
    }));
  });
});
