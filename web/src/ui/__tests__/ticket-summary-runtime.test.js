/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket summary runtime', () => {
  it('applies summary values and schedules preview refresh through one helper', async () => {
    const { refreshTicketSummary } = await import('../ticket-summary-runtime.js');
    const updateLimitPriceEntryUi = vi.fn();
    const updateTicketLayoutMode = vi.fn();
    const syncLimitAutoTrackState = vi.fn();
    const debouncedOrderPreview = vi.fn();
    const elements = {
      sizeEl: { textContent: '' },
      amountEl: { textContent: '' },
      feeEl: { textContent: '' },
      playbookBadge: { textContent: '' },
      sizeSlider: { value: '' },
    };

    const summary = refreshTicketSummary({
      updateLimitPriceEntryUi,
      updateTicketLayoutMode,
      sizeInputValue: '250',
      priceInputValue: '100',
      currentCoin: 'BTC',
      currentPrice: 100,
      allMids: {},
      selectedPlaybook: 'Breakout',
      elements,
      shouldSyncLimitAutoTrack: true,
      syncLimitAutoTrackState,
      debouncedOrderPreview,
    });

    expect(summary.size).toBe(250);
    expect(elements.sizeEl.textContent).toBe('$250.00');
    expect(elements.amountEl.textContent).toBe('2.500000 BTC');
    expect(elements.feeEl.textContent).toBe('$0.1125');
    expect(elements.playbookBadge.textContent).toBe('Breakout');
    expect(elements.sizeSlider.value).toBe(250);
    expect(updateLimitPriceEntryUi).toHaveBeenCalledTimes(1);
    expect(updateTicketLayoutMode).toHaveBeenCalledTimes(1);
    expect(syncLimitAutoTrackState).toHaveBeenCalledWith({ requestChartRefresh: true, syncUi: false });
    expect(debouncedOrderPreview).toHaveBeenCalledTimes(1);
  });
});
