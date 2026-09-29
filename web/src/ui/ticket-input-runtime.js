function createTicketInputRuntime({
  getElementById = (id) => document.getElementById(id),
  getEffectiveCurrentTimeframe,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentCoin,
  getEffectiveCurrentPrice,
  getLimitPriceEntryMode,
  getChartPreviewLevels,
  getAllMids,
  getSelectedPlaybook,
  refreshTicketSummary,
  updateLimitPriceEntryUi,
  updateTicketLayoutMode,
  syncLimitAutoTrackState,
  getDebouncedOrderPreview,
  handleManualTicketEdit,
  setTicketPriceEntryMode,
  setUserEditedPrice,
  clearDeployedTicketState,
} = {}) {
  function updateSummary() {
    const sizeInput = getElementById('sizeInput');
    const priceInput = getElementById('priceInput');
    if (!sizeInput || !priceInput) return;

    const currentTimeframe = getEffectiveCurrentTimeframe?.();
    const currentOrderType = getEffectiveCurrentOrderType?.();

    refreshTicketSummary?.({
      updateLimitPriceEntryUi,
      updateTicketLayoutMode,
      sizeInputValue: sizeInput.value,
      priceInputValue: priceInput.value,
      currentCoin: getEffectiveCurrentCoin?.(),
      currentPrice: getEffectiveCurrentPrice?.(),
      allMids: getAllMids?.(),
      selectedPlaybook: getSelectedPlaybook?.(),
      elements: {
        sizeEl: getElementById('sumValue'),
        amountEl: getElementById('sumAmount'),
        feeEl: getElementById('sumFee'),
        playbookBadge: getElementById('activePlaybookBadge'),
        sizeSlider: getElementById('sizeSlider'),
      },
      shouldSyncLimitAutoTrack: currentOrderType === 'limit'
        && currentTimeframe === '1m'
        && getChartPreviewLevels?.().length > 0,
      syncLimitAutoTrackState,
      debouncedOrderPreview: getDebouncedOrderPreview?.(),
    });
  }

  function updateScaleSummary() {
    const scaleTotal = getElementById('scaleTotal');
    const scaleTotalSlider = getElementById('scaleTotalSlider');
    if (!scaleTotal || !scaleTotalSlider) return;

    const total = parseFloat(scaleTotal.value) || 0;
    scaleTotalSlider.value = total;
    updateSummary();
  }

  function makeManualInputHandler(opts = {}) {
    return () => handleManualTicketEdit?.({
      ...opts,
      shouldIgnoreEdit: opts.markUserEditedPrice
        ? () => getEffectiveCurrentOrderType?.() === 'limit'
          && getEffectiveCurrentTimeframe?.() === '1m'
          && getLimitPriceEntryMode?.() === 'auto'
        : undefined,
      beforeManualEdit: opts.markUserEditedPrice
        ? () => setTicketPriceEntryMode?.('manual')
        : undefined,
      setUserEditedPrice,
      clearDeployedTicketState,
      updateSummary,
    });
  }

  return {
    updateSummary,
    updateScaleSummary,
    onManualPriceInput: makeManualInputHandler({ markUserEditedPrice: true }),
    onManualSizeInput: makeManualInputHandler(),
    onManualTpInput: makeManualInputHandler(),
    onManualSlInput: makeManualInputHandler(),
  };
}

export {
  createTicketInputRuntime,
};
