/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket input runtime', () => {
  it('refreshes the ticket summary from DOM state through one runtime owner', async () => {
    const { createTicketInputRuntime } = await import('../ticket-input-runtime.js');
    document.body.innerHTML = `
      <input id="sizeInput" value="250" />
      <input id="priceInput" value="100" />
      <input id="sizeSlider" value="250" />
      <div id="sumValue"></div>
      <div id="sumAmount"></div>
      <div id="sumFee"></div>
      <div id="activePlaybookBadge"></div>
    `;
    const refreshTicketSummary = vi.fn();
    const debouncedOrderPreview = vi.fn();

    const runtime = createTicketInputRuntime({
      getElementById: (id) => document.getElementById(id),
      getEffectiveCurrentTimeframe: () => '1m',
      getEffectiveCurrentOrderType: () => 'limit',
      getEffectiveCurrentCoin: () => 'BTC',
      getEffectiveCurrentPrice: () => 100,
      getChartPreviewLevels: () => [{ price: 97 }],
      getAllMids: () => ({}),
      getSelectedPlaybook: () => 'Breakout',
      refreshTicketSummary,
      updateLimitPriceEntryUi: vi.fn(),
      updateTicketLayoutMode: vi.fn(),
      syncLimitAutoTrackState: vi.fn(),
      getDebouncedOrderPreview: () => debouncedOrderPreview,
      handleManualTicketEdit: vi.fn(),
      setTicketPriceEntryMode: vi.fn(),
      setUserEditedPrice: vi.fn(),
      clearDeployedTicketState: vi.fn(),
    });

    runtime.updateSummary();

    expect(refreshTicketSummary).toHaveBeenCalledWith(expect.objectContaining({
      sizeInputValue: '250',
      priceInputValue: '100',
      currentCoin: 'BTC',
      currentPrice: 100,
      selectedPlaybook: 'Breakout',
      shouldSyncLimitAutoTrack: true,
      debouncedOrderPreview,
    }));
  });

  it('syncs scale total input back into the slider and refreshes the summary', async () => {
    const { createTicketInputRuntime } = await import('../ticket-input-runtime.js');
    document.body.innerHTML = `
      <input id="scaleTotal" value="420" />
      <input id="scaleTotalSlider" value="0" />
      <input id="sizeInput" value="250" />
      <input id="priceInput" value="100" />
      <input id="sizeSlider" value="250" />
      <div id="sumValue"></div>
      <div id="sumAmount"></div>
      <div id="sumFee"></div>
      <div id="activePlaybookBadge"></div>
    `;
    const refreshTicketSummary = vi.fn();

    const runtime = createTicketInputRuntime({
      getElementById: (id) => document.getElementById(id),
      getEffectiveCurrentTimeframe: () => '5m',
      getEffectiveCurrentOrderType: () => 'limit',
      getEffectiveCurrentCoin: () => 'BTC',
      getEffectiveCurrentPrice: () => 100,
      getChartPreviewLevels: () => [],
      getAllMids: () => ({}),
      getSelectedPlaybook: () => 'Manual',
      refreshTicketSummary,
      updateLimitPriceEntryUi: vi.fn(),
      updateTicketLayoutMode: vi.fn(),
      syncLimitAutoTrackState: vi.fn(),
      getDebouncedOrderPreview: () => vi.fn(),
      handleManualTicketEdit: vi.fn(),
      setTicketPriceEntryMode: vi.fn(),
      setUserEditedPrice: vi.fn(),
      clearDeployedTicketState: vi.fn(),
    });

    runtime.updateScaleSummary();

    expect(document.getElementById('scaleTotalSlider').value).toBe('420');
    expect(refreshTicketSummary).toHaveBeenCalledTimes(1);
  });

  it('keeps manual price edits ignored while 1m limit auto mode is active', async () => {
    const { createTicketInputRuntime } = await import('../ticket-input-runtime.js');
    const handleManualTicketEdit = vi.fn();

    const runtime = createTicketInputRuntime({
      getElementById: vi.fn(),
      getEffectiveCurrentTimeframe: () => '1m',
      getEffectiveCurrentOrderType: () => 'limit',
      getLimitPriceEntryMode: () => 'auto',
      getChartPreviewLevels: () => [],
      getAllMids: () => ({}),
      getSelectedPlaybook: () => 'Manual',
      refreshTicketSummary: vi.fn(),
      updateLimitPriceEntryUi: vi.fn(),
      updateTicketLayoutMode: vi.fn(),
      syncLimitAutoTrackState: vi.fn(),
      getDebouncedOrderPreview: () => vi.fn(),
      handleManualTicketEdit,
      setTicketPriceEntryMode: vi.fn(),
      setUserEditedPrice: vi.fn(),
      clearDeployedTicketState: vi.fn(),
    });

    runtime.onManualPriceInput();

    expect(handleManualTicketEdit).toHaveBeenCalledTimes(1);
    const call = handleManualTicketEdit.mock.calls[0][0];
    expect(call.markUserEditedPrice).toBe(true);
    expect(call.shouldIgnoreEdit()).toBe(true);
    expect(typeof call.beforeManualEdit).toBe('function');
  });
});
