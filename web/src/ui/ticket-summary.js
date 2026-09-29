export function buildTicketSummary({
  sizeInputValue,
  priceInputValue,
  currentCoin,
  currentPrice,
  allMids,
  selectedPlaybook,
}) {
  const size = parseFloat(sizeInputValue) || 0;
  let price = priceInputValue === 'Market' ? currentPrice : parseFloat(priceInputValue) || 0;

  if (!price && allMids?.[currentCoin]) {
    price = parseFloat(allMids[currentCoin]) || 0;
  }

  const coinAmount = price > 0 ? size / price : 0;
  const fee = size * 0.00045;

  return {
    size,
    price,
    coinAmount,
    fee,
    playbookLabel: selectedPlaybook,
    sizeText: size > 0 ? '$' + size.toFixed(2) : '—',
    amountText: coinAmount > 0 ? coinAmount.toFixed(6) + ' ' + currentCoin : '—',
    feeText: fee > 0 ? '$' + fee.toFixed(4) : '—',
  };
}

export function applyTicketSummary(summary, {
  sizeEl,
  amountEl,
  feeEl,
  playbookBadge,
  sizeSlider,
}) {
  if (sizeEl) sizeEl.textContent = summary.sizeText;
  if (amountEl) amountEl.textContent = summary.amountText;
  if (feeEl) feeEl.textContent = summary.feeText;
  if (playbookBadge) playbookBadge.textContent = summary.playbookLabel;
  if (sizeSlider) sizeSlider.value = summary.size;
}
