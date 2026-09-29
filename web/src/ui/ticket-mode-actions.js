function syncLimitAutoTrackMode({
  updateLimitPriceEntryUi,
  currentOrderType,
  currentTimeframe,
  syncLimitPreviewLevels,
  requestChartRefresh = false,
  requestChartRefreshFn,
  getLimitPriceEntryMode,
  getUserEditedPrice,
  setTicketPriceEntryMode,
  getAutoLimitPriceForSide,
  priceInputValue = '',
  applyTicketPrice,
  syncUi = false,
} = {}) {
  updateLimitPriceEntryUi?.();
  if (currentOrderType !== 'limit' || currentTimeframe !== '1m') return false;

  let changed = false;

  if (syncLimitPreviewLevels?.()) {
    changed = true;
    if (requestChartRefresh) requestChartRefreshFn?.();
  }

  if (getLimitPriceEntryMode?.() === 'auto' && !getUserEditedPrice?.()) {
    setTicketPriceEntryMode?.('auto');
    const resolvedPrice = getAutoLimitPriceForSide?.() || 0;
    const currentPrice = parseFloat(priceInputValue || 0);
    const needsPriceSync = resolvedPrice > 0 && Math.abs(currentPrice - resolvedPrice) > 1e-9;

    if (needsPriceSync) {
      changed = applyTicketPrice?.(resolvedPrice, {
        userEdited: false,
        syncUi,
        clearDeployState: false,
        snapToTick: true,
      }) || changed;
    }
  }

  return changed;
}

function applyTicketSideChange({
  side,
  clearDeployedTicketState,
  setCurrentSide,
  applySideButtonStyles,
  currentOrderType,
  currentTimeframe,
  previewLevels,
  clearScalePreview,
  clearScalePreviewOrders,
  syncLimitPreviewLevels,
  requestChartRefresh,
  maybeApplyAutoLimitPrice,
  updateSummary,
} = {}) {
  clearDeployedTicketState?.({ keepPrice: true, keepTargets: true });
  setCurrentSide?.(side);
  applySideButtonStyles?.(side);

  if (currentOrderType === 'scale' && previewLevels?.length > 0) {
    clearScalePreview?.();
    clearScalePreviewOrders?.();
  } else if (currentOrderType === 'limit' && currentTimeframe === '1m') {
    const changed = syncLimitPreviewLevels?.();
    if (changed) requestChartRefresh?.();
  }

  maybeApplyAutoLimitPrice?.(side);
  updateSummary?.();
}

function applyTicketOrderTypeChange({
  type,
  previousOrderType,
  clearDeployedTicketState,
  clearScalePreview,
  clearScaleFormFields,
  setCurrentOrderType,
  applyOrderTypeTabButton,
  applyOrderTypeFormLayout,
  renderTwapStatus,
  loadBotStrategy,
  currentTimeframe,
  applyPreviewButtonVisibility,
  reconcileOrderTypePreview,
  setLimitAutoTrackForTimeframe,
  syncLimitPreviewLevels,
  requestChartRefresh,
  resetUserEditedPrice,
  priceInput,
  currentSide,
  getAutoLimitPriceForSide,
  applyTicketPrice,
  syncLimitAutoTrackState,
  updateLimitPriceEntryUi,
  updateSummary,
} = {}) {
  clearDeployedTicketState?.({ keepPrice: true, keepTargets: true });

  if (previousOrderType === 'scale' && type !== 'scale') {
    clearScalePreview?.();
    clearScaleFormFields?.();
  }

  setCurrentOrderType?.(type);
  applyOrderTypeTabButton?.();
  applyOrderTypeFormLayout?.(type);
  renderTwapStatus?.();

  if (type === 'bot') {
    loadBotStrategy?.('rvwap-short-bollinger');
  }

  applyPreviewButtonVisibility?.({ orderType: type, timeframe: currentTimeframe });

  reconcileOrderTypePreview?.({
    previousOrderType,
    nextOrderType: type,
    clearScalePreview,
    currentTimeframe,
    setLimitAutoTrackForTimeframe,
    syncLimitPreviewLevels,
    requestChartRefresh,
    resetUserEditedPrice,
    priceInput,
    currentSide,
    getAutoLimitPriceForSide,
    applyTicketPrice,
  });

  if (type === 'limit' && currentTimeframe === '1m') {
    syncLimitAutoTrackState?.({ requestChartRefresh: true, syncUi: false });
  } else {
    updateLimitPriceEntryUi?.('manual');
  }

  updateSummary?.();
}

export {
  applyTicketOrderTypeChange,
  applyTicketSideChange,
  syncLimitAutoTrackMode,
};
