import { fmtPrice } from '../utils/format.js';

function setDisplay(elements = [], display) {
  elements.forEach((element) => {
    if (element) element.style.display = display;
  });
}

export function buildOrderPreviewRequest({
  walletAddress,
  currentCoin,
  currentSide,
  size,
  leverage,
  limitPx,
  accountValue,
  available,
}) {
  return {
    address: walletAddress,
    coin: currentCoin,
    isBuy: currentSide === 'buy',
    sizeUsd: size,
    leverage,
    limitPx,
    mainnet: true,
    accountValue,
    availableEquity: available,
  };
}

export function applyOrderPreview(preview = {}, elements = {}, options = {}) {
  const fmtVal = (n) => '$' + (n || 0).toFixed(2);
  const coin = options.coin || preview.coin || '';
  const distCol = preview.distToLiqPct < 10 ? 'var(--red2)' : preview.distToLiqPct < 20 ? 'var(--yellow)' : 'var(--text3)';
  const {
    previewMargin,
    previewLiq,
    previewDist,
    previewMarginRow,
    previewLiqRow,
    previewDistRow,
  } = elements;

  if (previewMargin) previewMargin.textContent = fmtVal(preview.initialMargin);
  if (previewLiq) previewLiq.textContent = preview.liquidationPx > 0 ? '$' + fmtPrice(preview.liquidationPx, coin) : '—';
  if (previewDist) {
    previewDist.textContent = preview.distToLiqPct > 0 ? preview.distToLiqPct.toFixed(1) + '%' : '—';
    previewDist.style.color = distCol;
  }

  setDisplay([previewMarginRow, previewLiqRow, previewDistRow], '');
}

export function hideOrderPreview(elements = {}) {
  const { previewMarginRow, previewLiqRow, previewDistRow } = elements;
  setDisplay([previewMarginRow, previewLiqRow, previewDistRow], 'none');
}
