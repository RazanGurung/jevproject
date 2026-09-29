import { AppState } from './store.js';

let bookVersionState = 0;

/** No-op: market slices live on AppState only (Stage 3 Slice C). */
export function syncMarketRuntimeMirrors() {}

/** No-op: account stream socket is module-owned (Stage 3 Slice C). */
export function syncConnectionRuntimeMirrors(_opts) {}

export function setBookVersion(value) {
  bookVersionState = Number(value) || 0;
  return bookVersionState;
}

export function incrementBookVersion() {
  bookVersionState += 1;
  return bookVersionState;
}

export function getBookVersionValue() {
  return bookVersionState;
}

export function resetMarketRuntimeState() {
  AppState.market.book = { asks: [], bids: [] };
  AppState.market.candles = [];
}
