export function maybeApplyAutoLimitPrice({
  currentOrderType,
  side,
  priceInput,
  bookData,
  getAutoLimitPriceForSide,
  applyTicketPrice,
}) {
  if (currentOrderType !== 'limit' || !priceInput || priceInput.value) return false;

  const autoPrice = getAutoLimitPriceForSide(side);
  if (autoPrice > 0) {
    return applyTicketPrice(autoPrice, {
      userEdited: false,
      syncUi: false,
      clearDeployState: false,
      snapToTick: true,
    });
  }

  if (side === 'buy' && bookData?.bids?.[4]) {
    return applyTicketPrice(parseFloat(bookData.bids[4].px), {
      userEdited: false,
      syncUi: false,
      clearDeployState: false,
      snapToTick: true,
    });
  }

  if (side === 'sell' && bookData?.asks?.[4]) {
    return applyTicketPrice(parseFloat(bookData.asks[4].px), {
      userEdited: false,
      syncUi: false,
      clearDeployState: false,
      snapToTick: true,
    });
  }

  return false;
}

export function reconcileOrderTypePreview({
  previousOrderType,
  nextOrderType,
  previewLevels,
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
}) {
  if (previousOrderType === 'scale' && nextOrderType !== 'scale') {
    clearScalePreview();
  } else if (nextOrderType !== 'scale' && previousOrderType !== 'scale' && previewLevels.length > 0) {
    clearScalePreview();
  } else if (nextOrderType === 'scale' && previewLevels.length > 0) {
    clearScalePreview();
  }

  const is1mChart = currentTimeframe === '1m';
  setLimitAutoTrackForTimeframe(currentTimeframe);

  if (nextOrderType === 'limit' && is1mChart) {
    const changed = syncLimitPreviewLevels();
    if (changed) requestChartRefresh();
  }

  if (nextOrderType === 'limit') {
    resetUserEditedPrice();
    if (priceInput && !priceInput.value) {
      const autoPrice = getAutoLimitPriceForSide(currentSide);
      if (autoPrice > 0) {
        applyTicketPrice(autoPrice, {
          userEdited: false,
          syncUi: false,
          clearDeployState: false,
          snapToTick: true,
        });
      }
    }
    return;
  }

  resetUserEditedPrice();
}

export function reconcileTimeframePreview({
  currentOrderType,
  timeframe,
  setLimitAutoTrackForTimeframe,
  resetUserEditedPrice,
  setActiveCandleRequestToken,
  syncLimitPreviewLevels,
  clearAllPreviewSync,
  clearScalePreview,
  getChartPreviewLevels,
}) {
  const is1mChart = timeframe === '1m';
  setLimitAutoTrackForTimeframe(timeframe);
  if (is1mChart && currentOrderType === 'limit') {
    resetUserEditedPrice();
  }

  const requestToken = Date.now() + Math.random();
  setActiveCandleRequestToken(requestToken);

  if (currentOrderType === 'scale') {
    clearScalePreview();
  } else if (currentOrderType === 'limit' && is1mChart) {
    syncLimitPreviewLevels();
  } else if (currentOrderType === 'limit' && !is1mChart) {
    if (getChartPreviewLevels().length > 0) {
      clearAllPreviewSync?.();
    }
  } else if (getChartPreviewLevels().length > 0) {
    clearAllPreviewSync?.();
  }

  return requestToken;
}
