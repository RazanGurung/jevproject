function createTicketSizingRuntime({
  getElementById = (id) => document.getElementById(id),
  clearDeployedTicketState,
  getEffectiveWalletAddress,
  getAccountState,
  getSpotBalance,
  getEffectiveCurrentCoin,
  getEffectiveCurrentSide,
  getAccountMetrics,
  getActiveLeverage,
  resolvePresetSizeUsd,
  applyTicketSizeValue,
  updateSummary,
  updateScaleSummary,
  applyPlaybook,
} = {}) {
  function setPreset(pct) {
    clearDeployedTicketState?.({ keepPrice: true, keepTargets: true });
    const walletAddress = getEffectiveWalletAddress?.();
    const sizeVal = resolvePresetSizeUsd?.(pct, {
      walletAddress,
      accountState: getAccountState?.(),
      spotBalance: getSpotBalance?.() || 0,
      currentCoin: getEffectiveCurrentCoin?.(),
      getAccountMetrics,
      getActiveLeverage,
    });
    if (!(sizeVal > 0)) return;

    applyTicketSizeValue?.(String(sizeVal), {
      sizeInput: getElementById('sizeInput'),
      sizeSlider: getElementById('sizeSlider'),
      onChange: updateSummary,
    });
  }

  function setSize(val) {
    clearDeployedTicketState?.({ keepPrice: true, keepTargets: true });
    applyTicketSizeValue?.(val, {
      sizeInput: getElementById('sizeInput'),
      sizeSlider: getElementById('sizeSlider'),
      onChange: updateSummary,
    });
  }

  function setScaleTotal(val) {
    const scaleTotal = getElementById('scaleTotal');
    const scaleTotalSlider = getElementById('scaleTotalSlider');
    if (scaleTotal) scaleTotal.value = val;
    if (scaleTotalSlider) scaleTotalSlider.value = val;
    updateScaleSummary?.();
  }

  function setPlaybook(playbookName, elOrValue) {
    clearDeployedTicketState?.({ skipManualReset: true });
    const selected = typeof elOrValue === 'string' ? elOrValue : playbookName;
    applyPlaybook?.(selected, {
      side: getEffectiveCurrentSide?.(),
    });
  }

  return {
    setPlaybook,
    setPreset,
    setScaleTotal,
    setSize,
  };
}

export {
  createTicketSizingRuntime,
};
