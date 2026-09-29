/**
 * Trading Service - Order placement, scale orders, smart signals, wall detection
 */

import { apiPost } from './api.js';
import { notifySuccess } from './action-feedback.js';
import { applyBulkCancelSuccess, buildCancelsFromOrders, bulkCancelOrders } from './order-cancel.js';
import { applyClosePositionSuccess, markPendingPositionClose } from './position-close.js';
import { requireKey } from './wallet-service.js';
import { evaluateOrderRisk } from './risk-engine.js';
import { AppState, suppressPositionCoin, clearCoinSuppressions, getOrderPending, setOrderPending, getOrderDebounceUntil, setOrderDebounceUntil, ORDER_DEBOUNCE_MS } from '../state/store.js';
import {
  getAccountState as getCanonicalAccountState,
  getOpenOrders as getCanonicalOpenOrders,
  markRecentOrderPlacement,
  registerLockedOpenOrder,
} from '../state/account-state.js';
import { getWalletAddress } from '../state/account-selectors.js';
import { getAllMids, getBookData, getPriceAgeMs } from '../state/market-selectors.js';
import { getCurrentCoin, getCurrentOrderType, getCurrentPrice, getCurrentSide } from '../state/trading-selectors.js';
import { showToast } from '../ui/toast.js';
import { asyncPrompt, confirmAction } from '../ui/async-prompt.js';
import { fmtPrice } from '../utils/format.js';
import {
  submitBulkOrdersWithConfirmation,
  submitOrderWithRetry,
  extractAcceptedOrderLocks,
  parseOrderConfirmation,
  formatApiError,
  getPartialFillShortfall,
  formatPartialFillShortfallMessage,
  getClosePositionResidual,
  formatClosePositionResidualMessage,
  isTransientLimitFailure,
} from './trading-service-order-api.js';
import { getTicketSource } from './trading-service-helpers.js';
import { roundPriceToTick } from './trading-service-helpers.js';
import { isBuilderPerpCoin } from '../utils/helpers.js';
import { isTradingAllowed } from '../state/connection-health.js';
import { cancelActiveTwap, placeTwapOrder, renderTwapStatus } from './trading-service-twap.js';
import { clearScalePreview, hasScalePreview, placeScaleOrder as placeScaleOrderImpl, resetScalePreview, scalePreviewOrders, showScalePreview } from './trading-service-scale.js';
import { setLimitPreviewAutoTrack } from '../state/trading-runtime.js';
import { getManagedExchangePrivateKey } from './exchange-auth.js';
import { syncLocalTradingVisualState } from './trading-visual-sync.js';

const getAccountState = () => getCanonicalAccountState();
const getOpenOrders = () => getCanonicalOpenOrders();
const $ = (id) => document.getElementById(id);

const MARKET_PRICE_STALE_MS = 15000;

export function positionTriggerSizing(sizeCoin, triggerPx) {
  const exactSize = Number(sizeCoin);
  const price = Number(triggerPx);
  return {
    sz: exactSize * price,
    szCoin: exactSize,
  };
}

function getCoinPriceAgeMs(coin) {
  return getPriceAgeMs(coin);
}

function resolveOrderTicketInput(input = {}) {
  return {
    sizeUsd: Number.isFinite(Number(input.sizeUsd)) ? Number(input.sizeUsd) : 0,
    rawLimitPrice: Number.isFinite(Number(input.rawLimitPrice)) ? Number(input.rawLimitPrice) : 0,
    tpPct: input.tpPct === null
      ? null
      : (Number.isFinite(Number(input.tpPct)) ? Number(input.tpPct) : null),
    slPct: input.slPct === null
      ? null
      : (Number.isFinite(Number(input.slPct)) ? Number(input.slPct) : null),
    selectedPlaybook: typeof input.selectedPlaybook === 'string' && input.selectedPlaybook
      ? input.selectedPlaybook
      : 'Manual',
    submitButtonEl: input.submitButtonEl ?? null,
    syncSizeUsd: typeof input.syncSizeUsd === 'function' ? input.syncSizeUsd : null,
  };
}

async function submitClosePositionRequest({ coin, fraction, positionSzi }) {
  return apiPost('/api/close-position', {
    privateKey: getManagedExchangePrivateKey(),
    address: getWalletAddress(),
    coin,
    fraction,
    positionSize: Math.abs(positionSzi),
    positionSzi,
    mainnet: true,
  });
}

export async function placeScaleOrder() {
  return placeScaleOrderImpl({
    orderDebounceUntilRef: {
      get value() {
        return getOrderDebounceUntil();
      },
      set value(next) {
        setOrderDebounceUntil(next);
      },
    },
    orderDebounceMs: ORDER_DEBOUNCE_MS,
  });
}

/**
 * Place a single order
 */
export async function placeOrder(orderTicketInput = {}, {
  onAccepted = null,
  onSizeAdjusted = null,
} = {}) {
  if (getCurrentOrderType() === 'scale') {
    return placeScaleOrder();
  }

  // Safety check - clear scale preview if not in scale mode
  if (getCurrentOrderType() !== 'scale' && hasScalePreview()) {
    clearScalePreview();
    resetScalePreview();
  }

  // Debounce
  const now = Date.now();
  if (now < getOrderDebounceUntil()) {
    showToast('Please wait...', false);
    return;
  }
  
  if (getOrderPending()) {
    showToast('Order pending...', false);
    return;
  }
  
  setOrderDebounceUntil(now + ORDER_DEBOUNCE_MS);
  setOrderPending(true);

  if (!requireKey()) {
    setOrderPending(false);
    return;
  }

  const {
    sizeUsd,
    rawLimitPrice,
    tpPct,
    slPct,
    selectedPlaybook,
    submitButtonEl,
    syncSizeUsd,
  } = resolveOrderTicketInput(orderTicketInput);
  
  if (!sizeUsd || sizeUsd <= 0) {
    showToast('Error: Enter order size', true);
    setOrderPending(false);
    return;
  }

  const currentCoin = getCurrentCoin();
  const currentSide = getCurrentSide();
  const currentOrderType = getCurrentOrderType();
  const isBuilder = isBuilderPerpCoin(currentCoin);
  const priceAgeMs = getCoinPriceAgeMs(currentCoin);

  if (!isTradingAllowed() || (currentOrderType === 'market' && priceAgeMs > MARKET_PRICE_STALE_MS)) {
    showToast(`Price feed stale for ${currentCoin}. Wait for a live update before trading.`, true);
    setOrderPending(false);
    return;
  }

  if (isBuilder && !getCurrentPrice() && !getAllMids()[currentCoin]) {
    showToast('Waiting for price feed...', true);
    setOrderPending(false);
    return;
  }

  // Handle TWAP orders
  if (currentOrderType === 'twap') {
    await placeTwapOrder(sizeUsd);
    setOrderPending(false);
    return;
  }

  if (isBuilder && currentOrderType === 'market' && !getCurrentPrice()) {
    showToast('Using cached price...', false);
  }

  // Get and validate price
  let limitPx = null;
  if (currentOrderType !== 'market') {
    if (rawLimitPrice && rawLimitPrice > 0) {
      limitPx = roundPriceToTick(rawLimitPrice, currentCoin);
      if (limitPx <= 0 || !isFinite(limitPx)) {
        showToast('Error: Invalid price after rounding', true);
        setOrderPending(false);
        return;
      }
    }
  }

  const px = limitPx || getCurrentPrice();
  const orderSource = getTicketSource({
    coin: currentCoin,
    side: currentSide,
    orderType: currentOrderType,
    playbook: selectedPlaybook,
    sizeUsd,
    limitPx: limitPx || 0,
    tpPct,
    slPct,
  });
  const currentPlaybook = orderSource === 'signal' ? selectedPlaybook : 'Manual';
  
  if (!px) {
    showToast('Error: No price available', true);
    setOrderPending(false);
    return;
  }

  let effectiveSizeUsd = sizeUsd;
  {
    const riskDecision = evaluateOrderRisk({
      coin: currentCoin,
      side: currentSide,
      sizeUsd,
      playbook: currentPlaybook,
      source: orderSource,
    });

    if (!riskDecision.allowed) {
      showToast(riskDecision.message, true);
      setOrderPending(false);
      return;
    }

    if (riskDecision.cappedSizeUsd > 0 && riskDecision.cappedSizeUsd < sizeUsd) {
      effectiveSizeUsd = riskDecision.cappedSizeUsd;
      syncSizeUsd?.(effectiveSizeUsd, { onChange: onSizeAdjusted });
      showToast(riskDecision.message, false);
    }
  }
  
  if (tpPct && (tpPct <= 0 || tpPct > 1000)) {
    showToast('Error: TP must be 0-1000%', true);
    setOrderPending(false);
    return;
  }
  
  if (slPct && (slPct <= 0 || slPct > 100)) {
    showToast('Error: SL must be 0-100%', true);
    setOrderPending(false);
    return;
  }

  const sz = effectiveSizeUsd;

  const btn = submitButtonEl || null;
  const origText = btn?.textContent || 'Place Order';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sending...';
  }
  const t0 = performance.now();

  try {
    const orderData = {
      privateKey: getManagedExchangePrivateKey(),
      coin: currentCoin,
      isBuy: currentSide === 'buy',
      sz: sz,
      szCoin: limitPx > 0 ? sz / limitPx : 0,
      limitPx: limitPx || 0,
      reduceOnly: false,
      mainnet: true,
      tpPct: tpPct || 0,
      slPct: slPct || 0,
    };

      const { response, confirmation } = await submitOrderWithRetry(orderData, {
        allowRetry: currentOrderType === 'limit',
      });
      const ms = Math.round(performance.now() - t0);

    if (confirmation.accepted) {
      markRecentOrderPlacement();
      clearCoinSuppressions(currentCoin);
      if (currentOrderType === 'limit') {
        const [lockedOrder] = extractAcceptedOrderLocks(response, [orderData]);
        if (lockedOrder) {
          registerLockedOpenOrder(lockedOrder);
          syncLocalTradingVisualState();
        }
      }
      const filled = confirmation.accepted ? confirmation.filled : null;
      if (filled) {
        const szVal = filled.totalSz || '?';
        const pxVal = filled.avgPx || '?';
        notifySuccess(`✓ ${currentSide.toUpperCase()} ${currentCoin} ${szVal} @ $${pxVal} — ${ms}ms`, { refreshAccount: true });
        // A limit order's unfilled remainder rests on the book; a market
        // order's is cancelled (IoC), so only market shortfalls need a flag.
        const shortfall = currentOrderType === 'market' ? getPartialFillShortfall(filled, sz) : null;
        if (shortfall) {
          showToast(formatPartialFillShortfallMessage(shortfall), true);
        }
      } else {
        notifySuccess(`✓ Order placed — ${ms}ms`, { refreshAccount: true });
      }
      if (!filled && (tpPct || slPct)) {
        showToast('Protection queued on backend and will attach after fill.', false);
      }
      setLimitPreviewAutoTrack(true);
      if (AppState.trading) {
        AppState.trading.lastDeployedPlan = null;
      }
      onAccepted?.({
        coin: currentCoin,
        side: currentSide,
        orderType: currentOrderType,
        response,
        confirmation,
      });
    } else {
      const errMsg = confirmation.error || 'Order failed';
      showToast('Order failed: ' + errMsg, true);
    }
  } catch(e) {
    console.error('[OrderSubmit] failed', {
      coin: currentCoin,
      side: currentSide,
      orderType: currentOrderType,
      playbook: currentPlaybook,
      error: e,
      status: e?.status,
      url: e?.url,
      body: e?.body,
    });
    showToast(formatApiError('Order submit failed', e), true);
  } finally {
    setOrderPending(false);
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

/**
 * Cancel order by OID
 */
export async function cancelOid(coin, oid) {
  if (!requireKey()) return;
  if (!oid) {
    showToast('Error: Order ID required', true);
    return;
  }
  
  try {
    const d = await apiPost('/api/cancel-order', { privateKey: getManagedExchangePrivateKey(), coin, oid, mainnet: true });
    if (d.status === 'ok') {
      applyBulkCancelSuccess([{ coin, oid }]);
      showToast(`✓ ${coin} order cancelled`, false);
    } else {
      showToast('Cancel failed: ' + (d.error || 'Unknown error'), true);
    }
  } catch(e) {
    console.error('[cancelOid] failed', JSON.stringify({
      coin, oid,
      status: e?.status,
      rawMessage: e?.rawMessage,
      body: e?.body,
      message: e?.message,
    }));
    showToast('Error: Cancel failed', true);
  }
}

/**
 * Cancel all orders
 */
export async function cancelAllOrders(btnEl = null) {
  if (!requireKey()) return;
  if (!confirmAction('Cancel all open orders?')) return;

  const btn = btnEl || document.activeElement;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Canceling...';
  }

  const openOrders = getOpenOrders();
  if (!openOrders || !openOrders.length) {
    showToast('No open orders to cancel', false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'CANCEL';
    }
    return;
  }

  const cancels = buildCancelsFromOrders(openOrders);

  try {
    const d = await bulkCancelOrders({
      privateKey: getManagedExchangePrivateKey(),
      cancels,
      mainnet: true,
    });
    
    if (d.status === 'ok') {
      notifySuccess(`✓ ${d.cancelled || cancels.length} orders cancelled`, { refreshAccount: true });
    } else if (d.status === 'partial') {
      showToast(`Partial cancel: ${d.cancelled}/${cancels.length} cancelled — ${d.error || 'some orders were not cancelled'}`, true);
    } else {
      showToast('Cancel failed: ' + (d.error || 'Unknown'), true);
    }
  } catch(e) {
    showToast('Error: ' + e.message, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'CANCEL';
    }
  }
}

/**
 * Close position
 */
export async function closePosition(coin, fraction = 1.0, evtOrPositionSize, maybePositionSize = 0) {
  if (!requireKey()) return;

  let btn = null;
  let positionSize = 0;
  if (typeof evtOrPositionSize === 'number') {
    positionSize = evtOrPositionSize;
    btn = maybePositionSize?.target || (maybePositionSize?.tagName ? maybePositionSize : null);
  } else {
    btn = evtOrPositionSize?.target || (evtOrPositionSize?.tagName ? evtOrPositionSize : null);
    positionSize = typeof maybePositionSize === 'number' ? maybePositionSize : 0;
  }
  const origText = btn?.textContent || (fraction === 1.0 ? 'Close' : (fraction*100) + '%');
  if (btn) {
    btn.disabled = true;
    btn.textContent = fraction === 1.0 ? 'Closing...' : (fraction*100) + '%...';
  }

  // positionSize passed directly from button render (sz in coin units)
  // Fall back to accountState lookup if not provided
  if (!positionSize) {
    const accountState = getAccountState();
    const positions = accountState?.assetPositions || [];
    const pos = positions.find(p => p.position.coin === coin);
    positionSize = pos ? parseFloat(pos.position.szi) : 0;
  }

  try {
    if (fraction === 1.0) {
      suppressPositionCoin(coin);
      markPendingPositionClose(coin);
    }

    const d = await submitClosePositionRequest({
      coin,
      fraction,
      positionSzi: positionSize,
    });
    if (d.status === 'ok') {
      if (fraction === 1.0) {
        applyClosePositionSuccess({ coin, fraction });
      }
      const residual = getClosePositionResidual(d);
      if (residual) {
        // Full-close optimistic clear is still correct: the position is smaller
        // (or flat after repair). Surface the residual so the operator knows a
        // dust remainder may still be open until the next account snapshot.
        showToast(formatClosePositionResidualMessage(coin, residual), true);
        notifySuccess('', { refreshAccount: true, refreshChart: true });
      } else {
        notifySuccess(`✓ ${coin} ${fraction * 100}% closed`, { refreshAccount: true, refreshChart: true });
      }
    } else {
      showToast('Close failed: ' + (d.error || 'Unknown error'), true);
      notifySuccess('', { refreshAccount: true, refreshChart: true });
      if (btn) {
        btn.disabled = false;
        btn.textContent = origText;
      }
    }
  } catch(e) {
    showToast('Error: ' + e.message, true);
    notifySuccess('', { refreshAccount: true, refreshChart: true });
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

export async function closeAllPositions(btnEl = null) {
  if (!requireKey()) return;
  if (!confirmAction('Close all open positions at market?')) return;

  const accountState = getAccountState();
  const positions = (accountState?.assetPositions || [])
    .filter((wrapper) => Math.abs(parseFloat(wrapper?.position?.szi)) > 0);

  if (!positions.length) {
    showToast('Error: No open positions', true);
    return;
  }

  const btn = btnEl || document.activeElement;
  const origText = btn?.textContent || 'CLOSE';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Closing...';
  }

  try {
    const results = await Promise.all(positions.map(async (wrapper) => {
      const coin = wrapper?.position?.coin;
      const positionSzi = parseFloat(wrapper?.position?.szi);
      if (!coin || !(Math.abs(positionSzi) > 0)) return { success: false, coin: coin || '' };

      suppressPositionCoin(coin);
      markPendingPositionClose(coin);

      try {
        const response = await submitClosePositionRequest({
          coin,
          fraction: 1.0,
          positionSzi,
        });
        if (response?.status === 'ok') {
          applyClosePositionSuccess({ coin, fraction: 1.0 });
          const residual = getClosePositionResidual(response);
          return { success: true, coin, partial: Boolean(residual), residual };
        }
        return { success: false, coin };
      } catch {
        return { success: false, coin };
      }
    }));

    const closed = results.filter((result) => result.success).length;
    const failedCoins = results
      .filter((result) => !result.success && result.coin)
      .map((result) => result.coin);
    const partialCoins = results
      .filter((result) => result.success && result.partial && result.coin)
      .map((result) => result.coin);

    if (failedCoins.length > 0) {
      showToast(`Closed ${closed}/${positions.length}, failed: ${failedCoins.join(', ')}`, true);
      notifySuccess('', { refreshAccount: true, refreshChart: true });
      return;
    }

    if (partialCoins.length > 0) {
      showToast(
        `Closed ${closed} positions; partial IoC residual on ${partialCoins.join(', ')}`,
        true,
      );
      notifySuccess('', { refreshAccount: true, refreshChart: true });
      return;
    }

    notifySuccess(`✓ Closed ${closed} positions`, { refreshAccount: true, refreshChart: true });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

/**
 * Set take profit
 */
export async function setTP(coin, isBuy, sz, entry) {
  if (!requireKey()) return;

  // The prompt must name its target: these buttons carry per-row position
  // args, and a stale/mistaken row otherwise fires protection at the wrong
  // coin with no visible clue (observed live: TP meant for BTC landed on
  // xyz:CL using the oil entry price).
  const tpPct = await asyncPrompt(`Take Profit % for ${coin} (entry $${fmtPrice(entry, coin)}):`, '2');
  if (!tpPct || isNaN(parseFloat(tpPct))) return;

  const chartCoin = AppState.trading.currentCoin;
  if (chartCoin && chartCoin !== coin) {
    const proceed = confirmAction(`Chart is on ${chartCoin} but this TP targets ${coin}. Place TP on ${coin}?`);
    if (!proceed) return;
  }

  const tpPx = isBuy ? entry * (1 + parseFloat(tpPct)/100) : entry * (1 - parseFloat(tpPct)/100);
  const triggerSizing = positionTriggerSizing(sz, tpPx);

  try {
    const d = await apiPost('/api/trigger-order', {
      privateKey: getManagedExchangePrivateKey(),
      coin: coin,
      isBuy: !isBuy,
      ...triggerSizing,
      triggerPx: tpPx,
      isMarket: true,
      tpsl: 'tp',
      mainnet: true
    });
    if (d.status === 'ok') {
      const [lockedOrder] = extractAcceptedOrderLocks(d, [{
        coin,
        isBuy: !isBuy,
        sz,
        triggerPx: tpPx,
        reduceOnly: true,
        tpsl: 'tp',
      }]);
      if (lockedOrder) {
        registerLockedOpenOrder(lockedOrder);
        syncLocalTradingVisualState();
      }
      notifySuccess(`✓ ${coin} TP trigger set at $${fmtPrice(tpPx, coin)}`, { refreshAccount: true, refreshChart: true });
    } else {
      showToast('TP failed: ' + (d.error || 'Unknown error'), true);
    }
  } catch(e) {
    showToast('Error: ' + e.message, true);
  }
}

/**
 * Set stop loss
 */
export async function setSL(coin, isBuy, sz, entry) {
  if (!requireKey()) return;

  // See setTP: the prompt names its target and cross-coin placements require
  // explicit confirmation.
  const slPct = await asyncPrompt(`Stop Loss % for ${coin} (entry $${fmtPrice(entry, coin)}):`, '1');
  if (!slPct || isNaN(parseFloat(slPct))) return;

  const chartCoin = AppState.trading.currentCoin;
  if (chartCoin && chartCoin !== coin) {
    const proceed = confirmAction(`Chart is on ${chartCoin} but this SL targets ${coin}. Place SL on ${coin}?`);
    if (!proceed) return;
  }

  const slPx = isBuy ? entry * (1 - parseFloat(slPct)/100) : entry * (1 + parseFloat(slPct)/100);
  const triggerSizing = positionTriggerSizing(sz, slPx);

  try {
    const d = await apiPost('/api/trigger-order', {
      privateKey: getManagedExchangePrivateKey(),
      coin: coin,
      isBuy: !isBuy,
      ...triggerSizing,
      triggerPx: slPx,
      isMarket: true,
      tpsl: 'sl',
      mainnet: true
    });
    if (d.status === 'ok') {
      const [lockedOrder] = extractAcceptedOrderLocks(d, [{
        coin,
        isBuy: !isBuy,
        sz,
        triggerPx: slPx,
        reduceOnly: true,
        tpsl: 'sl',
      }]);
      if (lockedOrder) {
        registerLockedOpenOrder(lockedOrder);
        syncLocalTradingVisualState();
      }
      notifySuccess(`✓ ${coin} SL set at $${fmtPrice(slPx, coin)}`, { refreshAccount: true, refreshChart: true });
    } else {
      showToast('SL failed: ' + (d.error || 'Unknown error'), true);
    }
  } catch(e) {
    showToast('Error: ' + e.message, true);
  }
}

export {
  scalePreviewOrders,
  parseOrderConfirmation,
  formatApiError,
  isTransientLimitFailure,
};
