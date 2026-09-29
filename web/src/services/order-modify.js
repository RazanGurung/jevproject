import { apiPost } from './api.js';
import { notifySuccess } from './action-feedback.js';
import { requireKey } from './wallet-service.js';
import { getManagedExchangePrivateKey } from './exchange-auth.js';
import { registerLockedOpenOrder, removeOpenOrdersByOids } from '../state/account-state.js';
import { AppState, suppressOrderOid } from '../state/store.js';
import { getTickSize } from '../state/coin-meta.js';
import { showToast } from '../ui/toast.js';
import { syncLocalTradingVisualState } from './trading-visual-sync.js';

const MODIFY_SUCCESS_FEEDBACK = {
  refreshAccount: true,
  refreshChart: true,
};
const MIN_OPEN_NOTIONAL_USD = 10;

// Order modification is a service concern: UI adapters collect user intent,
// then this module owns validation, optimistic state, and API interaction.
function toLockedOpenOrder(order) {
  const locked = {
    oid: order.oid,
    coin: order.coin,
    side: order.isBuy ? 'B' : 'A',
    sz: order.sz,
    limitPx: order.limitPx,
    reduceOnly: order.reduceOnly === true,
  };
  if (Number.isFinite(order.triggerPx) && order.triggerPx > 0) locked.triggerPx = order.triggerPx;
  if (order.tpsl === 'tp' || order.tpsl === 'sl') locked.tpsl = order.tpsl;
  return locked;
}

function registerModifiedOrder(order) {
  registerLockedOpenOrder(toLockedOpenOrder(order));
}

function getErrorMessage(error) {
  return error?.rawMessage || error?.message || 'Unknown error';
}

// A Hyperliquid modify is cancel+replace: the resting order comes back under
// a new oid (returned by the backend). Re-keying immediately — instead of
// waiting for the next account snapshot — is what keeps chart boxes stable on
// HIP-3 dexes, where user-stream coverage lags behind standard perps.
function resolveReplacementOid(oldOid, responseOid) {
  const next = Number(responseOid);
  if (!Number.isFinite(next) || next <= 0) return oldOid;
  if (next !== oldOid) {
    suppressOrderOid(oldOid);
    removeOpenOrdersByOids([oldOid]);
  }
  return next;
}

async function submitOrderModification({ oid, coin, isBuy, sz, limitPx, reduceOnly = false }) {
  const d = await apiPost('/api/modify-order', {
    privateKey: getManagedExchangePrivateKey(),
    coin,
    oid,
    isBuy,
    sz,
    limitPx,
    reduceOnly,
    mainnet: true,
  });
  if (d.status === 'ok') {
    const nextOid = resolveReplacementOid(oid, d.oid);
    registerModifiedOrder({ oid: nextOid, coin, isBuy, sz, limitPx, reduceOnly });
    syncLocalTradingVisualState();
    notifySuccess(`✓ ${coin} order modified`, MODIFY_SUCCESS_FEEDBACK);
    return true;
  }
  showToast('Modify failed: ' + (d.error || 'Unknown error'), true);
  return false;
}

// Trigger moves use the native modify action (single atomic exchange call):
// the previous cancel-then-place flow left the position unprotected when the
// place step failed after the cancel succeeded.
async function submitTriggerOrderModification({ oid, coin, isBuy, sz, triggerPx, tpsl }) {
  const d = await apiPost('/api/modify-order', {
    privateKey: getManagedExchangePrivateKey(),
    coin,
    oid,
    isBuy,
    sz,
    limitPx: triggerPx,
    triggerPx,
    isMarket: true,
    tpsl,
    reduceOnly: true,
    mainnet: true,
  });
  if (d.status === 'ok') {
    const nextOid = resolveReplacementOid(oid, d.oid);
    registerModifiedOrder({ oid: nextOid, coin, isBuy, sz, limitPx: triggerPx, triggerPx, tpsl, reduceOnly: true });
    syncLocalTradingVisualState();
    notifySuccess(`✓ ${coin} ${String(tpsl).toUpperCase()} trigger moved`, MODIFY_SUCCESS_FEEDBACK);
    return true;
  }
  showToast('Modify failed: ' + (d.error || 'Unknown error'), true);
  return false;
}

function normalizePositiveNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function normalizeOrderBase(order = {}) {
  const oid = normalizePositiveNumber(order.oid);
  const coin = typeof order.coin === 'string' ? order.coin : '';
  const sz = normalizePositiveNumber(order.sz);
  if (!oid || !coin || !sz) return null;
  return {
    oid,
    coin,
    isBuy: order.isBuy === true,
    sz,
  };
}

function normalizeModifyOrder(order = {}) {
  const base = normalizeOrderBase(order);
  const limitPx = normalizePositiveNumber(order.limitPx);
  if (!base || !limitPx) return null;
  return {
    ...base,
    limitPx,
    reduceOnly: order.reduceOnly === true,
  };
}

function openingModifyBelowMinimum(order) {
  return order?.reduceOnly !== true
    && Number(order?.sz) * Number(order?.limitPx) + 1e-9 < MIN_OPEN_NOTIONAL_USD;
}

function normalizeTriggerModifyOrder(order = {}) {
  const base = normalizeOrderBase(order);
  const triggerPx = normalizePositiveNumber(order.triggerPx);
  const tpsl = order.tpsl === 'tp' || order.tpsl === 'sl' ? order.tpsl : '';
  if (!base || !triggerPx || !tpsl) return null;
  return {
    ...base,
    triggerPx,
    tpsl,
  };
}

function getCurrentMarketPrice(coin) {
  if (!coin) return 0;
  if (AppState.trading.currentCoin === coin) {
    const current = Number(AppState.trading.currentPrice || 0);
    if (Number.isFinite(current) && current > 0) return current;
  }
  const fromMids = Number(AppState.market.allMids?.[coin] || 0);
  return Number.isFinite(fromMids) && fromMids > 0 ? fromMids : 0;
}

function wouldTriggerImmediately({ coin, isBuy, triggerPx, tpsl }) {
  const currentPrice = getCurrentMarketPrice(coin);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  const tickSize = Number(getTickSize(coin) || 0);
  const minGap = tickSize > 0 ? tickSize : 0;
  const closesLong = isBuy !== true;

  if (tpsl === 'tp') {
    return closesLong
      ? triggerPx <= currentPrice + minGap
      : triggerPx >= currentPrice - minGap;
  }
  if (tpsl === 'sl') {
    return closesLong
      ? triggerPx >= currentPrice - minGap
      : triggerPx <= currentPrice + minGap;
  }
  return false;
}

async function modifyLimitPrice({ oid, coin, isBuy, sz, limitPx, reduceOnly = false }) {
  if (!requireKey()) return false;
  const nextOrder = normalizeModifyOrder({ oid, coin, isBuy, sz, limitPx, reduceOnly });
  if (!nextOrder) {
    showToast('Invalid order modification', true);
    return false;
  }
  if (openingModifyBelowMinimum(nextOrder)) {
    showToast(`Rejected: modified order would be below the $${MIN_OPEN_NOTIONAL_USD.toFixed(2)} exchange minimum`, true);
    return false;
  }
  try {
    return await submitOrderModification(nextOrder);
  } catch (e) {
    showToast('Error: ' + getErrorMessage(e), true);
    return false;
  }
}

async function modifyTriggerPrice({ oid, coin, isBuy, sz, triggerPx, tpsl }) {
  if (!requireKey()) return false;
  const nextOrder = normalizeTriggerModifyOrder({ oid, coin, isBuy, sz, triggerPx, tpsl });
  if (!nextOrder) {
    showToast('Invalid trigger modification', true);
    return false;
  }
  if (wouldTriggerImmediately(nextOrder)) {
    showToast(`Rejected: ${String(nextOrder.tpsl).toUpperCase()} would trigger immediately at the current market price`, true);
    return false;
  }
  try {
    return await submitTriggerOrderModification(nextOrder);
  } catch (e) {
    showToast('Error: ' + getErrorMessage(e), true);
    return false;
  }
}

export {
  modifyLimitPrice,
  modifyTriggerPrice,
  submitOrderModification,
};
