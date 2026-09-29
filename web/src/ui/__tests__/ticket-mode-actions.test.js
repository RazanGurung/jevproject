/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket mode actions', () => {
  it('syncs 1m auto-track preview and ticket price through one helper', async () => {
    const { syncLimitAutoTrackMode } = await import('../ticket-mode-actions.js');
    const updateLimitPriceEntryUi = vi.fn();
    const syncLimitPreviewLevels = vi.fn(() => true);
    const requestChartRefreshFn = vi.fn();
    const setTicketPriceEntryMode = vi.fn();
    const applyTicketPrice = vi.fn(() => true);

    const changed = syncLimitAutoTrackMode({
      updateLimitPriceEntryUi,
      currentOrderType: 'limit',
      currentTimeframe: '1m',
      syncLimitPreviewLevels,
      requestChartRefresh: true,
      requestChartRefreshFn,
      getLimitPriceEntryMode: () => 'auto',
      getUserEditedPrice: () => false,
      setTicketPriceEntryMode,
      getAutoLimitPriceForSide: () => 97,
      priceInputValue: '100',
      applyTicketPrice,
      syncUi: true,
    });

    expect(changed).toBe(true);
    expect(updateLimitPriceEntryUi).toHaveBeenCalledTimes(1);
    expect(syncLimitPreviewLevels).toHaveBeenCalledTimes(1);
    expect(requestChartRefreshFn).toHaveBeenCalledTimes(1);
    expect(setTicketPriceEntryMode).toHaveBeenCalledWith('auto');
    expect(applyTicketPrice).toHaveBeenCalledWith(97, expect.objectContaining({
      userEdited: false,
      syncUi: true,
      clearDeployState: false,
      snapToTick: true,
    }));
  });

  it('applies side-change orchestration through one helper', async () => {
    const { applyTicketSideChange } = await import('../ticket-mode-actions.js');
    const clearDeployedTicketState = vi.fn();
    const setCurrentSide = vi.fn();
    const applySideButtonStyles = vi.fn();
    const clearScalePreview = vi.fn();
    const clearScalePreviewOrders = vi.fn();
    const maybeApplyAutoLimitPrice = vi.fn();
    const updateSummary = vi.fn();

    applyTicketSideChange({
      side: 'sell',
      clearDeployedTicketState,
      setCurrentSide,
      applySideButtonStyles,
      currentOrderType: 'scale',
      currentTimeframe: '1m',
      previewLevels: [{ price: 100 }],
      clearScalePreview,
      clearScalePreviewOrders,
      syncLimitPreviewLevels: vi.fn(),
      requestChartRefresh: vi.fn(),
      maybeApplyAutoLimitPrice,
      updateSummary,
    });

    expect(clearDeployedTicketState).toHaveBeenCalledWith({ keepPrice: true, keepTargets: true });
    expect(setCurrentSide).toHaveBeenCalledWith('sell');
    expect(applySideButtonStyles).toHaveBeenCalledWith('sell');
    expect(clearScalePreview).toHaveBeenCalledTimes(1);
    expect(clearScalePreviewOrders).toHaveBeenCalledTimes(1);
    expect(maybeApplyAutoLimitPrice).toHaveBeenCalledWith('sell');
    expect(updateSummary).toHaveBeenCalledTimes(1);
  });

  it('applies order-type orchestration through one helper', async () => {
    const { applyTicketOrderTypeChange } = await import('../ticket-mode-actions.js');
    const clearDeployedTicketState = vi.fn();
    const clearScalePreview = vi.fn();
    const clearScaleFormFields = vi.fn();
    const setCurrentOrderType = vi.fn();
    const applyOrderTypeTabButton = vi.fn();
    const applyOrderTypeFormLayout = vi.fn();
    const renderTwapStatus = vi.fn();
    const loadBotStrategy = vi.fn();
    const applyPreviewButtonVisibility = vi.fn();
    const reconcileOrderTypePreview = vi.fn();
    const syncLimitAutoTrackState = vi.fn();
    const updateLimitPriceEntryUi = vi.fn();
    const updateSummary = vi.fn();

    applyTicketOrderTypeChange({
      type: 'twap',
      previousOrderType: 'scale',
      clearDeployedTicketState,
      clearScalePreview,
      clearScaleFormFields,
      setCurrentOrderType,
      applyOrderTypeTabButton,
      applyOrderTypeFormLayout,
      renderTwapStatus,
      loadBotStrategy,
      currentTimeframe: '4h',
      applyPreviewButtonVisibility,
      reconcileOrderTypePreview,
      setLimitAutoTrackForTimeframe: vi.fn(),
      syncLimitPreviewLevels: vi.fn(),
      requestChartRefresh: vi.fn(),
      resetUserEditedPrice: vi.fn(),
      priceInput: { value: '' },
      currentSide: 'buy',
      getAutoLimitPriceForSide: vi.fn(),
      applyTicketPrice: vi.fn(),
      syncLimitAutoTrackState,
      updateLimitPriceEntryUi,
      updateSummary,
    });

    expect(clearDeployedTicketState).toHaveBeenCalledWith({ keepPrice: true, keepTargets: true });
    expect(clearScalePreview).toHaveBeenCalledTimes(1);
    expect(clearScaleFormFields).toHaveBeenCalledTimes(1);
    expect(setCurrentOrderType).toHaveBeenCalledWith('twap');
    expect(applyOrderTypeTabButton).toHaveBeenCalledTimes(1);
    expect(applyOrderTypeFormLayout).toHaveBeenCalledWith('twap');
    expect(renderTwapStatus).toHaveBeenCalledTimes(1);
    expect(applyPreviewButtonVisibility).toHaveBeenCalledWith({ orderType: 'twap', timeframe: '4h' });
    expect(reconcileOrderTypePreview).toHaveBeenCalledTimes(1);
    expect(syncLimitAutoTrackState).not.toHaveBeenCalled();
    expect(updateLimitPriceEntryUi).toHaveBeenCalledWith('manual');
    expect(updateSummary).toHaveBeenCalledTimes(1);
    expect(loadBotStrategy).not.toHaveBeenCalled();
  });
});
