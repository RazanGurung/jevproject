/**
 * Top bar - market/account display updates
 */

import { AppState } from '../state/store.js';
import { getPriceFeed } from '../state/strategy-host.js';
import { updateSummary } from './tabs.js';
import { fmtPrice } from '../utils/format.js';
import { renderTopPrice, updateDocumentTitle } from './market-display.js';
import { getTicketFieldElements } from './ticket-fields.js';

// Mid/book ticks can exceed 30 Hz on liquid pairs. Live price lines update on
// every tick in market-price-runtime; the ticket summary and chrome digit only
// need human-readable cadence. ~10 Hz keeps the UI snappy without thrashing.
const TOPBAR_MIN_INTERVAL_MS = 100;

let lastTopBarFlushAt = 0;
let lastTopBarPriceKey = '';
let topBarFlushTimer = null;

function buildPriceKey(coin, price) {
  if (!(price > 0)) return `${coin || ''}:—`;
  return `${coin || ''}:${fmtPrice(price, coin) || String(price)}`;
}

function flushTopBar() {
  topBarFlushTimer = null;
  lastTopBarFlushAt = typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

  const currentCoin = AppState.trading.currentCoin;
  const currentPrice = AppState.trading.currentPrice;
  const priceKey = buildPriceKey(currentCoin, currentPrice);
  const priceChanged = priceKey !== lastTopBarPriceKey;
  lastTopBarPriceKey = priceKey;

  if (priceChanged) {
    renderTopPrice(currentPrice, currentCoin, fmtPrice);
    updateDocumentTitle(currentCoin, currentPrice, fmtPrice);

    const { priceInput } = getTicketFieldElements();
    if (priceInput) {
      priceInput.placeholder = currentPrice ? fmtPrice(currentPrice, currentCoin) : '—';
    }
    // Ticket margin/size text depends on mark; recompute only when the
    // displayed price actually moved.
    updateSummary();
  }
}

function updateTopBar({ force = false } = {}) {
  if (force) {
    if (topBarFlushTimer) {
      clearTimeout(topBarFlushTimer);
      topBarFlushTimer = null;
    }
    lastTopBarPriceKey = '';
    flushTopBar();
    return;
  }

  const now = typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
  const remaining = TOPBAR_MIN_INTERVAL_MS - (now - lastTopBarFlushAt);
  if (remaining <= 0) {
    if (topBarFlushTimer) {
      clearTimeout(topBarFlushTimer);
      topBarFlushTimer = null;
    }
    flushTopBar();
    return;
  }
  if (topBarFlushTimer) return;
  topBarFlushTimer = setTimeout(flushTopBar, remaining);
  if (typeof topBarFlushTimer?.unref === 'function') topBarFlushTimer.unref();
}

function syncPriceConsumers(coin, price, { refreshTopBar = false, forceTopBar = false } = {}) {
  if (refreshTopBar) updateTopBar({ force: forceTopBar === true });
  if (!coin || !Number.isFinite(price) || price <= 0) return;
  const priceFeed = getPriceFeed();
  if (typeof priceFeed?.update === 'function') {
    priceFeed.update(coin, price);
  }
}

export {
  updateTopBar,
  syncPriceConsumers,
};
