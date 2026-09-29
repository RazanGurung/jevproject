import { apiPost } from './api.js';
import { suppressOrderOid } from '../state/store.js';
import { removeOpenOrdersByOids } from '../state/account-state.js';
import { syncLocalTradingVisualState } from './trading-visual-sync.js';

function normalizeCancels(cancels = []) {
  return cancels
    .map((cancel) => ({
      coin: cancel?.coin,
      oid: Number(cancel?.oid),
    }))
    .filter((cancel) => cancel.coin && Number.isFinite(cancel.oid) && cancel.oid > 0);
}

function buildCancelsFromOrders(orders = []) {
  return normalizeCancels(orders.map((order) => ({
    coin: order?.coin,
    oid: order?.oid,
  })));
}

async function requestBulkCancel({ privateKey, cancels, mainnet = true }) {
  return await apiPost('/api/bulk-cancel', {
    privateKey,
    cancels: normalizeCancels(cancels),
    mainnet,
  });
}

function applyBulkCancelSuccess(cancels) {
  const normalized = normalizeCancels(cancels);
  if (!normalized.length) return normalized;

  normalized.forEach(({ oid, coin }) => {
    suppressOrderOid(oid);
  });

  removeOpenOrdersByOids(normalized.map(({ oid }) => oid));
  syncLocalTradingVisualState();
  return normalized;
}

// Only confirmed oids are optimistically removed: the backend reports
// "partial" with cancelledOids when one venue batch fails, and suppressing
// un-cancelled orders makes their lines vanish and then reappear.
function confirmedCancels(normalized, response) {
  if (response?.status === 'ok' && !Array.isArray(response?.cancelledOids)) return normalized;
  const confirmed = new Set((response?.cancelledOids || []).map(Number));
  return normalized.filter(({ oid }) => confirmed.has(oid));
}

async function bulkCancelOrders({
  privateKey,
  cancels,
  mainnet = true,
} = {}) {
  const normalized = normalizeCancels(cancels);
  if (!normalized.length) {
    return { status: 'ok', cancelled: 0 };
  }

  const response = await requestBulkCancel({ privateKey, cancels: normalized, mainnet });
  if (response?.status === 'ok' || response?.status === 'partial') {
    applyBulkCancelSuccess(confirmedCancels(normalized, response));
  }
  return response;
}

export {
  applyBulkCancelSuccess,
  buildCancelsFromOrders,
  bulkCancelOrders,
  normalizeCancels,
  requestBulkCancel,
};
