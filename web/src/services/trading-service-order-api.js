import { apiPost } from './api.js';
import { sleep } from '../utils/helpers.js';

const LIMIT_RETRY_BACKOFF_MS = 1200;

export function generateCloid() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function isAmbiguousFailureText(text) {
  return /(?:^|\s)(?:http\s+)?(?:408|429|5\d\d)\b|exchange request failed|failed to read exchange|failed to decode exchange/i.test(String(text || ''));
}

export function isTransientLimitFailure(message = '', errorLike = null) {
  const status = Number(errorLike?.status || 0);
  if (status === 408 || status === 429 || status >= 500) return true;
  return isAmbiguousFailureText(message) || /rate limit/i.test(String(message || ''));
}

function createLockedOrderFromOid(oid, fallbackOrder) {
  if (!oid || !fallbackOrder?.coin) return null;
  const limitPx = parseFloat(fallbackOrder?.limitPx ?? fallbackOrder?.triggerPx);
  if (!Number.isFinite(limitPx) || limitPx <= 0) return null;
  const limitPxNum = Number(limitPx);
  const szCoin = Number(fallbackOrder?.szCoin);
  const szUsd = Number(fallbackOrder?.sz);
  const sz = Number.isFinite(szCoin) && szCoin > 0
    ? szCoin
    : (Number.isFinite(szUsd) && limitPxNum > 0 ? szUsd / limitPxNum : fallbackOrder?.sz);
  return {
    oid,
    coin: fallbackOrder.coin,
    limitPx,
    triggerPx: Number.isFinite(parseFloat(fallbackOrder?.triggerPx)) ? parseFloat(fallbackOrder.triggerPx) : undefined,
    sz,
    side: fallbackOrder?.isBuy ? 'B' : 'A',
    tpsl: fallbackOrder?.tpsl || '',
    reduceOnly: fallbackOrder?.reduceOnly === true,
  };
}

export function extractAcceptedOrderLocks(response, submittedOrders = []) {
  const locks = [];

  if (response?.accepted && response?.oid) {
    const lock = createLockedOrderFromOid(response.oid, submittedOrders[0]);
    if (lock) locks.push(lock);
  }

  if (Array.isArray(response?.statuses)) {
    response.statuses.forEach((status, idx) => {
      if (status?.accepted && status?.oid) {
        const lock = createLockedOrderFromOid(status.oid, submittedOrders[idx]);
        if (lock) locks.push(lock);
      }
    });
  }

  const seen = new Set();
  return locks.filter((lock) => {
    if (!lock?.oid || seen.has(lock.oid)) return false;
    seen.add(lock.oid);
    return true;
  });
}

export function parseOrderConfirmation(response) {
  if (response?.accepted) {
    return {
      accepted: true,
      filled: response.filled ?? null,
      cloid: response.cloid || '',
      status: response,
      error: '',
    };
  }

  const error = response?.error || 'Order was not confirmed by exchange';
  return {
    accepted: false,
    filled: null,
    cloid: response?.cloid || '',
    status: response,
    error,
    ambiguous: response?.ambiguous === true || isAmbiguousOrderError(error, false),
  };
}

// Market orders are IoC limits with a slippage cap; on a thin book the
// remainder past the cap is cancelled, so "filled" can be a fraction of the
// request. The 3% tolerance absorbs price drift between sizing and matching.
const PARTIAL_FILL_TOLERANCE = 0.97;

export function getPartialFillShortfall(filled, requestedUsd) {
  const filledSz = parseFloat(filled?.totalSz);
  const avgPx = parseFloat(filled?.avgPx);
  const filledUsd = filledSz * avgPx;
  const requested = Number(requestedUsd);
  if (!Number.isFinite(filledUsd) || !Number.isFinite(requested) || requested <= 0) return null;
  if (filledUsd >= requested * PARTIAL_FILL_TOLERANCE) return null;
  const residualUsd = Math.max(0, requested - filledUsd);
  const fillPct = (filledUsd / requested) * 100;
  return {
    filledUsd,
    requestedUsd: requested,
    residualUsd,
    fillPct,
    filledSz: Number.isFinite(filledSz) ? filledSz : null,
    avgPx: Number.isFinite(avgPx) ? avgPx : null,
  };
}

/** Format a place-order IoC shortfall for the toast surface. */
export function formatPartialFillShortfallMessage(shortfall) {
  if (!shortfall) return '';
  const filled = shortfall.filledUsd.toFixed(2);
  const requested = Number(shortfall.requestedUsd).toFixed(2);
  const residual = Number.isFinite(shortfall.residualUsd)
    ? shortfall.residualUsd.toFixed(2)
    : (shortfall.requestedUsd - shortfall.filledUsd).toFixed(2);
  const pct = Number.isFinite(shortfall.fillPct) ? ` (${shortfall.fillPct.toFixed(0)}%)` : '';
  return `Partial fill: $${filled} of $${requested}${pct} — residual ~$${residual} canceled (IoC slippage cap on thin book)`;
}

/**
 * Close-position residual from POST /api/close-position.
 * Backend already applies the 3% tolerance and sets partial=true.
 */
export function getClosePositionResidual(response) {
  if (!response || response.status !== 'ok' || !response.partial) return null;
  const requested = Number(response.requestedSzCoin);
  const filled = Number(response.filledSzCoin);
  const residual = Number(response.residualSzCoin);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  return {
    requestedSzCoin: requested,
    filledSzCoin: Number.isFinite(filled) ? filled : 0,
    residualSzCoin: Number.isFinite(residual) ? residual : Math.max(0, requested - (Number.isFinite(filled) ? filled : 0)),
    avgPx: Number.isFinite(Number(response.avgPx)) ? Number(response.avgPx) : null,
    cloid: response.cloid || '',
  };
}

export function formatClosePositionResidualMessage(coin, residual) {
  if (!residual) return '';
  const filled = residual.filledSzCoin;
  const requested = residual.requestedSzCoin;
  const left = residual.residualSzCoin;
  const fillLabel = Number.isFinite(filled) ? filled : 0;
  return `Partial close ${coin}: ${fillLabel} of ${requested} filled — residual ${left} canceled (IoC slippage cap)`;
}

function isAmbiguousOrderError(error, flagged) {
  if (flagged === true) return true;
  return isAmbiguousFailureText(error);
}

function parseBulkOrderConfirmation(response) {
  const statuses = Array.isArray(response?.statuses) ? response.statuses : [];
  const topError = response?.error || '';
  let ambiguous = isAmbiguousOrderError(topError, response?.ambiguous);
  if (statuses.length === 0) {
    return {
      acceptedCount: 0,
      totalCount: 0,
      error: topError || 'Order was not confirmed by exchange',
      ambiguous,
    };
  }

  let acceptedCount = 0;
  let firstError = '';
  for (const status of statuses) {
    if (status?.accepted) {
      acceptedCount++;
    } else if (!firstError) {
      firstError = status?.error || 'Order was not confirmed by exchange';
    }
    if (isAmbiguousOrderError(status?.error, status?.ambiguous)) ambiguous = true;
  }

  return {
    acceptedCount,
    totalCount: statuses.length,
    error: acceptedCount > 0 ? '' : (firstError || topError || ''),
    ambiguous,
  };
}

async function submitWithRetry({
  submitRequest,
  parseConfirmation,
  maxAttempts = 1,
  shouldRetryResponse = () => false,
} = {}) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await submitRequest();
      const confirmation = parseConfirmation(response);
      if (attempt < maxAttempts && shouldRetryResponse({ response, confirmation })) {
        await sleep(LIMIT_RETRY_BACKOFF_MS);
        continue;
      }
      return { response, confirmation };
    } catch (error) {
      // A failed HTTP round trip does not prove the exchange rejected the
      // action. Never replay an ambiguous mutation; only explicit rejection
      // responses above are eligible for a retry.
      throw error;
    }
  }

  return { response: null, confirmation: null };
}

export async function submitBulkOrdersWithConfirmation(orderData) {
  const payload = { ...orderData };
  if (Array.isArray(payload.orders)) {
    payload.orders = payload.orders.map((order) => (
      order?.cloid ? order : { ...order, cloid: generateCloid() }
    ));
  }
  return submitWithRetry({
    submitRequest: () => apiPost('/api/bulk-orders', payload),
    parseConfirmation: parseBulkOrderConfirmation,
    maxAttempts: 2,
    shouldRetryResponse: ({ response, confirmation }) => (
      confirmation.acceptedCount === 0
      && confirmation.ambiguous !== true
      && response?.ambiguous !== true
      && isTransientLimitFailure(confirmation.error || response?.error || '')
    ),
  });
}

async function submitOrder(orderData) {
  return apiPost('/api/order', orderData);
}

export async function submitOrderWithRetry(orderData, { allowRetry = false } = {}) {
  const payload = { ...orderData };
  if (!payload.cloid) payload.cloid = generateCloid();
  return submitWithRetry({
    submitRequest: () => submitOrder(payload),
    parseConfirmation: parseOrderConfirmation,
    maxAttempts: allowRetry ? 2 : 1,
    shouldRetryResponse: ({ response, confirmation }) => (
      allowRetry
      && !confirmation.accepted
      && confirmation.ambiguous !== true
      && isTransientLimitFailure(confirmation.error || response?.error || '')
    ),
  });
}

export function formatApiError(prefix, error) {
  const url = error?.url ? `${error.url} ` : '';
  const status = error?.status ? `${error.status} ` : '';
  const message = error?.rawMessage || error?.message || 'Unknown error';
  return `${prefix}: ${url}${status}${message}`.trim();
}
