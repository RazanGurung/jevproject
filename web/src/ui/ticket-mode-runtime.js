import {
  applyTicketOrderTypeChange,
  applyTicketSideChange,
} from './ticket-mode-actions.js';

function createTicketModeRuntime({
  clearDeployedTicketState,
  setCurrentSide,
  applySideButtonStyles,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentTimeframe,
  getChartPreviewLevels,
  loadTradingActions,
  clearScalePreviewOrders,
  syncLimitPreviewLevels,
  requestChartRefresh,
  maybeApplyAutoLimitPrice,
  updateSummary,
  syncMobileChartActionBar,
  setCurrentOrderType,
  clearScaleFormFields,
  applyOrderTypeTabButton,
  applyOrderTypeFormLayout,
  getBotStrategyLoader,
  applyPreviewButtonVisibility,
  reconcileOrderTypePreview,
  setLimitAutoTrackForTimeframe,
  resetUserEditedPrice,
  getPriceInput,
  getEffectiveCurrentSide,
  getAutoLimitPriceForSide,
  applyTicketPrice,
  syncLimitAutoTrackState,
  updateLimitPriceEntryUi,
} = {}) {
  function clearScalePreview() {
    return loadTradingActions?.().then(({ clearScalePreview: clearScalePreviewImpl }) => clearScalePreviewImpl?.());
  }

  function renderTwapStatus() {
    return loadTradingActions?.().then(({ renderTwapStatus: renderTwapStatusImpl }) => renderTwapStatusImpl?.());
  }

  function setSide(side) {
    applyTicketSideChange({
      side,
      clearDeployedTicketState,
      setCurrentSide,
      applySideButtonStyles,
      currentOrderType: getEffectiveCurrentOrderType?.(),
      currentTimeframe: getEffectiveCurrentTimeframe?.(),
      previewLevels: getChartPreviewLevels?.(),
      clearScalePreview,
      clearScalePreviewOrders,
      syncLimitPreviewLevels,
      requestChartRefresh,
      maybeApplyAutoLimitPrice,
      updateSummary,
    });
    syncMobileChartActionBar?.();
  }

  function setOrderType(type, element) {
    applyTicketOrderTypeChange({
      type,
      previousOrderType: getEffectiveCurrentOrderType?.(),
      clearDeployedTicketState,
      clearScalePreview,
      clearScaleFormFields,
      setCurrentOrderType,
      applyOrderTypeTabButton: () => applyOrderTypeTabButton?.(element),
      applyOrderTypeFormLayout,
      renderTwapStatus,
      loadBotStrategy: getBotStrategyLoader?.(),
      currentTimeframe: getEffectiveCurrentTimeframe?.(),
      applyPreviewButtonVisibility,
      reconcileOrderTypePreview: (args) => reconcileOrderTypePreview?.({
        ...args,
        previewLevels: getChartPreviewLevels?.(),
      }),
      setLimitAutoTrackForTimeframe,
      syncLimitPreviewLevels,
      requestChartRefresh,
      resetUserEditedPrice,
      priceInput: getPriceInput?.(),
      currentSide: getEffectiveCurrentSide?.(),
      getAutoLimitPriceForSide,
      applyTicketPrice,
      syncLimitAutoTrackState,
      updateLimitPriceEntryUi,
      updateSummary,
    });
    syncMobileChartActionBar?.();
  }

  return {
    setOrderType,
    setSide,
  };
}

export {
  createTicketModeRuntime,
};
