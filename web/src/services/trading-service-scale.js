import { apiPost } from './api.js';
import { requireKey } from './wallet-service.js';
import { showToast } from '../ui/toast.js';
import { updateSummary } from '../ui/tabs.js';
import { scheduleChartRender } from '../chart/chart-render.js';
import { setChartPreviewLevels } from '../chart/chart-preview-state.js';
import { clearAllPreview, clearScalePreviewOrders, getScalePreviewOrders, hasScalePreviewOrders, setScalePreviewOrders } from '../state/preview-state.js';
import { getCurrentCoin, getCurrentOrderType, getCurrentSide } from '../state/trading-selectors.js';
import { markRecentOrderPlacement, registerLockedOpenOrders } from '../state/account-state.js';
import { submitBulkOrdersWithConfirmation, extractAcceptedOrderLocks } from './trading-service-order-api.js';
import { getTicketSource, isClearlyStaleHip3ScaleRange, wouldReducePosition } from './trading-service-helpers.js';
import { isHip3Coin } from '../utils/helpers.js';
import { getManagedExchangePrivateKey } from './exchange-auth.js';
import { isTradingAllowed } from '../state/connection-health.js';
import { syncLocalTradingVisualState } from './trading-visual-sync.js';
import { getTicketFieldElements, readScaleForm, resetScaleForm, resetTicketRiskFields } from '../ui/ticket-fields.js';

function setPlaceButtonMode(mode, side = 'buy') {
  const placeBtn = getTicketFieldElements().submitButton;
  if (!placeBtn) return null;

  if (mode === 'scale-send') {
    const currentAction = placeBtn.getAttribute('data-action');
    if (currentAction) {
      placeBtn.setAttribute('data-prev-action', currentAction);
      placeBtn.removeAttribute('data-action');
    }
    placeBtn.textContent = 'SEND SCALE';
    placeBtn.style.background = side === 'buy' ? 'var(--green2)' : 'var(--red2)';
    placeBtn.style.color = '#000';
    return placeBtn;
  }

  if (mode === 'default') {
    placeBtn.onclick = null;
  }

  const previousAction = placeBtn.getAttribute('data-prev-action');
  if (previousAction) {
    placeBtn.setAttribute('data-action', previousAction);
    placeBtn.removeAttribute('data-prev-action');
  } else if (!placeBtn.getAttribute('data-action')) {
    placeBtn.setAttribute('data-action', 'placeOrder');
  }

  placeBtn.textContent = 'Place Order';
  placeBtn.style.background = '';
  placeBtn.style.color = '';
  return placeBtn;
}

export function hasScalePreview() {
  return hasScalePreviewOrders();
}

export function resetScalePreview() {
  clearScalePreviewOrders();
}

export function showScalePreview(orders) {
  const nextOrders = Array.isArray(orders) ? orders : [];
  setScalePreviewOrders(nextOrders);
  setChartPreviewLevels(nextOrders.map((o) => ({
    price: o.limitPx,
    color: getPaletteColor(o.isBuy ? 'bullish' : 'bearish'),
    lineWidth: 1,
    lineDash: [2, 2],
    priority: 4,
    isBuy: o.isBuy,
    label: `${o.isBuy ? 'BUY' : 'SELL'} ${o.sz}`,
  })));
  scheduleChartRender();
}

export function clearScalePreview() {
  clearAllPreview();
  setPlaceButtonMode('default');
  scheduleChartRender();
}

export async function placeScaleOrder({ orderDebounceUntilRef, orderDebounceMs } = {}) {
  if (!requireKey('Connect wallet first')) return;

  const { total, numOrders, high, low } = readScaleForm();

  if (!total || !numOrders || !high || !low) {
    showToast('Error: Fill scale fields', true);
    return;
  }
  if (numOrders < 1 || numOrders > 20) {
    showToast('Error: Orders must be 1-20', true);
    return;
  }
  if (high <= low) {
    showToast('Error: High must be greater than Low', true);
    return;
  }

  const currentCoin = getCurrentCoin();
  const currentSide = getCurrentSide();
  if (isHip3Coin(currentCoin) && isClearlyStaleHip3ScaleRange(currentCoin, low, high)) {
    showToast(`Error: Scale range looks stale for ${currentCoin}. Reset high/low for the current market.`, true);
    return;
  }
  const reducesPosition = wouldReducePosition(currentCoin, currentSide);

  let orders;
  try {
    const preview = await apiPost('/api/scale-preview', {
      coin: currentCoin,
      isBuy: currentSide === 'buy',
      totalUsd: total,
      numOrders,
      lowPx: low,
      highPx: high,
      reduceOnly: reducesPosition,
      mainnet: true,
    });
    orders = Array.isArray(preview?.orders) ? preview.orders : [];
  } catch (e) {
    showToast(`Error: ${e?.rawMessage || e?.message || 'Failed to build scale preview'}`, true);
    return;
  }

  if (!orders.length) {
    showToast('Error: No scale preview orders generated', true);
    return;
  }

  showScalePreview(orders);
  showToast(`Preview: ${numOrders} orders. Click Place Order to send.`, false);

  const placeBtn = setPlaceButtonMode('scale-send', currentSide);
  if (!placeBtn) return;

  placeBtn.onclick = async function sendScale() {
    const now = Date.now();
    if (now < orderDebounceUntilRef.value) {
      showToast('Please wait...', false);
      return;
    }
    orderDebounceUntilRef.value = now + orderDebounceMs;

    const scalePreviewOrders = getScalePreviewOrders();
    if (!scalePreviewOrders) {
      showToast('Error: No preview', true);
      return;
    }
    if (!isTradingAllowed()) {
      showToast('Price feed stale. Wait for a live update before trading.', true);
      return;
    }

    placeBtn.disabled = true;
    placeBtn.textContent = 'Sending...';

    try {
      placeBtn.textContent = `Sending ${scalePreviewOrders.length}...`;
      const previewOrdersToSend = Array.isArray(scalePreviewOrders) ? scalePreviewOrders.slice() : [];
      const { response, confirmation } = await submitBulkOrdersWithConfirmation({
        privateKey: getManagedExchangePrivateKey(),
        orders: previewOrdersToSend.map((order) => ({
          coin: order.coin,
          isBuy: order.isBuy,
          sz: order.sz,
          limitPx: order.limitPx,
          reduceOnly: order.reduceOnly,
        })),
        mainnet: true,
      });

      const successCount = confirmation.acceptedCount || 0;
      const errorMsg = confirmation.error || '';
      if (successCount > 0) {
        markRecentOrderPlacement();
        registerLockedOpenOrders(extractAcceptedOrderLocks(response, previewOrdersToSend));
        syncLocalTradingVisualState();
        showToast(`✓ ${successCount} orders placed`, false);
        resetTicketRiskFields();
        updateSummary();
        resetScaleForm();
        if (errorMsg) {
          showToast(`Stopped after ${successCount}/${previewOrdersToSend.length}: ${errorMsg}`, true);
        }
      } else {
        showToast(`Failed: ${errorMsg || 'Order was not confirmed by exchange'}`, true);
      }
    } catch (e) {
      showToast(`Error: ${e.message}`, true);
    }

    clearScalePreview();
    placeBtn.disabled = false;
    setPlaceButtonMode('default');
  };
}

export { getScalePreviewOrders as scalePreviewOrders };
import { getPaletteColor } from './color-palette.js';
