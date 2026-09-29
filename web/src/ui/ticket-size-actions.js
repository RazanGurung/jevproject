function applyTicketSizeValue(value, {
  sizeInput,
  sizeSlider,
  onChange,
} = {}) {
  if (sizeInput) sizeInput.value = value;
  if (sizeSlider) sizeSlider.value = value;
  if (typeof onChange === 'function') onChange();
}

function resolvePresetSizeUsd(pct, {
  walletAddress,
  accountState,
  spotBalance = 0,
  currentCoin,
  getAccountMetrics,
  getActiveLeverage,
} = {}) {
  if (!walletAddress) return 0;

  let { available } = getAccountMetrics(accountState);
  available += Number(spotBalance || 0);

  const maxLev = getActiveLeverage(currentCoin);
  const maxSize = available * maxLev;
  const presets = {
    '25%': 0.25,
    '50%': 0.50,
    '75%': 0.75,
    '100%': 1.00,
  };
  const pctVal = presets[pct];
  if (pctVal === undefined) return 0;
  return Math.round(maxSize * pctVal);
}

export {
  applyTicketSizeValue,
  resolvePresetSizeUsd,
};
