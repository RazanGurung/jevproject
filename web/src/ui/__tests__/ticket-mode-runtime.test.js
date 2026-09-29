/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket mode runtime', () => {
  it('routes side changes through the shared mode runtime and syncs the mobile action bar', async () => {
    const { createTicketModeRuntime } = await import('../ticket-mode-runtime.js');
    const clearScalePreview = vi.fn();
    const loadTradingActions = vi.fn(async () => ({
      clearScalePreview,
    }));
    const syncMobileChartActionBar = vi.fn();
    const clearDeployedTicketState = vi.fn();
    const setCurrentSide = vi.fn();
    const applySideButtonStyles = vi.fn();
    const clearScalePreviewOrders = vi.fn();
    const maybeApplyAutoLimitPrice = vi.fn();
    const updateSummary = vi.fn();

    const runtime = createTicketModeRuntime({
      clearDeployedTicketState,
      setCurrentSide,
      applySideButtonStyles,
      getEffectiveCurrentOrderType: () => 'scale',
      getEffectiveCurrentTimeframe: () => '1m',
      getChartPreviewLevels: () => [{ price: 100 }],
      loadTradingActions,
      clearScalePreviewOrders,
      syncLimitPreviewLevels: vi.fn(),
      requestChartRefresh: vi.fn(),
      maybeApplyAutoLimitPrice,
      updateSummary,
      syncMobileChartActionBar,
    });

    runtime.setSide('sell');
    await Promise.resolve();

    expect(clearDeployedTicketState).toHaveBeenCalledWith({ keepPrice: true, keepTargets: true });
    expect(setCurrentSide).toHaveBeenCalledWith('sell');
    expect(applySideButtonStyles).toHaveBeenCalledWith('sell');
    expect(loadTradingActions).toHaveBeenCalledTimes(1);
    expect(clearScalePreview).toHaveBeenCalledTimes(1);
    expect(clearScalePreviewOrders).toHaveBeenCalledTimes(1);
    expect(maybeApplyAutoLimitPrice).toHaveBeenCalledWith('sell');
    expect(updateSummary).toHaveBeenCalledTimes(1);
    expect(syncMobileChartActionBar).toHaveBeenCalledTimes(1);
  });

  it('routes order-type changes through the shared mode runtime and lazy trading actions', async () => {
    const { createTicketModeRuntime } = await import('../ticket-mode-runtime.js');
    const clearScalePreview = vi.fn();
    const renderTwapStatus = vi.fn();
    const loadTradingActions = vi.fn(async () => ({
      clearScalePreview,
      renderTwapStatus,
    }));
    const syncMobileChartActionBar = vi.fn();
    const clearDeployedTicketState = vi.fn();
    const clearScaleFormFields = vi.fn();
    const setCurrentOrderType = vi.fn();
    const applyOrderTypeTabButton = vi.fn();
    const applyOrderTypeFormLayout = vi.fn();
    const applyPreviewButtonVisibility = vi.fn();
    const reconcileOrderTypePreview = vi.fn();
    const updateLimitPriceEntryUi = vi.fn();
    const updateSummary = vi.fn();

    const runtime = createTicketModeRuntime({
      clearDeployedTicketState,
      setCurrentSide: vi.fn(),
      applySideButtonStyles: vi.fn(),
      getEffectiveCurrentOrderType: () => 'scale',
      getEffectiveCurrentTimeframe: () => '4h',
      getChartPreviewLevels: () => [{ price: 100 }],
      loadTradingActions,
      clearScalePreviewOrders: vi.fn(),
      syncLimitPreviewLevels: vi.fn(),
      requestChartRefresh: vi.fn(),
      maybeApplyAutoLimitPrice: vi.fn(),
      updateSummary,
      syncMobileChartActionBar,
      setCurrentOrderType,
      clearScaleFormFields,
      applyOrderTypeTabButton,
      applyOrderTypeFormLayout,
      getBotStrategyLoader: () => vi.fn(),
      applyPreviewButtonVisibility,
      reconcileOrderTypePreview,
      setLimitAutoTrackForTimeframe: vi.fn(),
      resetUserEditedPrice: vi.fn(),
      getPriceInput: () => ({ value: '' }),
      getEffectiveCurrentSide: () => 'buy',
      getAutoLimitPriceForSide: vi.fn(),
      applyTicketPrice: vi.fn(),
      syncLimitAutoTrackState: vi.fn(),
      updateLimitPriceEntryUi,
    });

    runtime.setOrderType('twap', { id: 'type-twap' });
    await Promise.resolve();

    expect(clearDeployedTicketState).toHaveBeenCalledWith({ keepPrice: true, keepTargets: true });
    expect(loadTradingActions).toHaveBeenCalledTimes(2);
    expect(clearScalePreview).toHaveBeenCalledTimes(1);
    expect(clearScaleFormFields).toHaveBeenCalledTimes(1);
    expect(setCurrentOrderType).toHaveBeenCalledWith('twap');
    expect(applyOrderTypeTabButton).toHaveBeenCalledTimes(1);
    expect(applyOrderTypeFormLayout).toHaveBeenCalledWith('twap');
    expect(renderTwapStatus).toHaveBeenCalledTimes(1);
    expect(applyPreviewButtonVisibility).toHaveBeenCalledWith({ orderType: 'twap', timeframe: '4h' });
    expect(reconcileOrderTypePreview).toHaveBeenCalledTimes(1);
    expect(updateLimitPriceEntryUi).toHaveBeenCalledWith('manual');
    expect(updateSummary).toHaveBeenCalledTimes(1);
    expect(syncMobileChartActionBar).toHaveBeenCalledTimes(1);
  });
});
