import { getAccountState } from '../state/account-state.js';
import { getExchangeLeverage } from '../state/account-selectors.js';
import { getMaxLeverage } from '../state/coin-meta.js';
import { getEffectiveCurrentCoin, getEffectiveCurrentSide, getEffectiveWalletAddress } from '../state/effective-trading.js';
import { getAccountMetrics } from '../services/account-metrics.js';
import { apiPost } from '../services/api.js';
import { applyOrderPreview, buildOrderPreviewRequest, hideOrderPreview } from './ticket-order-preview.js';
import { readOrderTicketInput } from './ticket-submit-state.js';

const $ = (id) => document.getElementById(id);

let orderPreviewTimer = null;

export function getActiveLeverage(coin) {
  return getExchangeLeverage(coin) || getMaxLeverage(coin) || 20;
}

export function showPreview(p) {
  applyOrderPreview(p, {
    previewMargin: $('previewMargin'),
    previewLiq: $('previewLiq'),
    previewDist: $('previewDist'),
    previewMarginRow: $('previewMarginRow'),
    previewLiqRow: $('previewLiqRow'),
    previewDistRow: $('previewDistRow'),
  }, {
    coin: getEffectiveCurrentCoin(),
  });
}

export function hidePreviewRows() {
  hideOrderPreview({
    previewMarginRow: $('previewMarginRow'),
    previewLiqRow: $('previewLiqRow'),
    previewDistRow: $('previewDistRow'),
  });
}

function resolveOrderPreviewInput(input = {}) {
  const fallback = readOrderTicketInput();
  return {
    sizeUsd: Number.isFinite(Number(input.sizeUsd)) ? Number(input.sizeUsd) : fallback.sizeUsd,
    rawLimitPrice: Number.isFinite(Number(input.rawLimitPrice)) ? Number(input.rawLimitPrice) : fallback.rawLimitPrice,
  };
}

export async function fetchOrderPreview(orderTicketInput = {}) {
  const { sizeUsd, rawLimitPrice } = resolveOrderPreviewInput(orderTicketInput);
  const currentCoin = getEffectiveCurrentCoin();
  const currentSide = getEffectiveCurrentSide();
  const walletAddress = getEffectiveWalletAddress();
  const leverage = getActiveLeverage(currentCoin);
  if (!currentCoin || sizeUsd <= 0 || !walletAddress) {
    hidePreviewRows();
    return;
  }

  const { accountValue, available } = getAccountMetrics(getAccountState());

  try {
    const d = await apiPost('/api/order-preview', buildOrderPreviewRequest({
      walletAddress,
      currentCoin,
      currentSide,
      size: sizeUsd,
      leverage,
      limitPx: rawLimitPrice || 0,
      accountValue,
      available,
    }));
    if (d.liquidationPx !== undefined || d.initialMargin !== undefined) {
      showPreview(d);
    } else {
      hidePreviewRows();
    }
  } catch (e) {
    hidePreviewRows();
  }
}

export function debouncedOrderPreview(orderTicketInputOrFactory = null) {
  if (orderPreviewTimer) clearTimeout(orderPreviewTimer);
  orderPreviewTimer = setTimeout(() => {
    const nextInput = typeof orderTicketInputOrFactory === 'function'
      ? orderTicketInputOrFactory()
      : orderTicketInputOrFactory;
    fetchOrderPreview(nextInput || {});
  }, 200);
}
