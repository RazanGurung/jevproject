import { AppState } from './store.js';

function getAllMids() {
  return AppState.market.allMids || {};
}

function getBookData() {
  return AppState.market.book || { bids: [], asks: [] };
}

function getCandles() {
  return Array.isArray(AppState.market.candles) ? AppState.market.candles : [];
}

function getLastPriceUpdateAt() {
  return AppState.market.lastPriceUpdateAt || {};
}

function getPriceAgeMs(coin) {
  if (!coin) return Infinity;
  const ts = Number(getLastPriceUpdateAt()?.[coin] || 0);
  if (!Number.isFinite(ts) || ts <= 0) return Infinity;
  return Date.now() - ts;
}

export {
  getAllMids,
  getBookData,
  getCandles,
  getLastPriceUpdateAt,
  getPriceAgeMs,
};
