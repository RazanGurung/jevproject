// Legacy facade: AppState writers used by coin-switch / wallet / stream paths.
// Stage 3 Slice C: no longer dual-writes app state onto window.* (strategies
// and bot already read AppState / modules). privateKey is never exposed.

import { AppState } from './store.js';

const LEGACY_MIRRORS = {
  currentCoin: {
    write: (value) => { AppState.trading.currentCoin = value; },
  },
  currentPrice: {
    write: (value) => { AppState.trading.currentPrice = value; },
  },
  currentSide: {
    write: (value) => { AppState.trading.currentSide = value; },
  },
  currentOrderType: {
    write: (value) => { AppState.trading.currentOrderType = value; },
  },
  currentTimeframe: {
    write: (value) => { AppState.trading.currentTimeframe = value; },
  },
  candles: {
    write: (value) => { AppState.market.candles = value; },
  },
  privateKey: {
    write: (value) => { AppState.account.privateKey = value; },
    expose: false,
  },
  signerAddress: {
    write: (value) => { AppState.account.signerAddress = value; },
  },
  accountState: {
    write: (value) => { AppState.account.state = value; },
  },
  openOrders: {
    write: (value) => { AppState.account.openOrders = value; },
  },
  lastOrderRevision: {
    write: (value) => { AppState.account.lastOrderRevision = value; },
  },
  walletAddress: {
    write: (value) => { AppState.account.walletAddress = value; },
  },
  accountFills: {
    write: (value) => { AppState.account.fills = value; },
  },
  twapStates: {
    write: (value) => { AppState.account.twapStates = value; },
  },
  lastTwapId: {
    write: (value) => { AppState.account.lastTwapId = value; },
  },
  spotBalance: {
    write: (value) => { AppState.account.spotBalance = value; },
  },
};

/** No-op: app-state mirrors no longer live on window (Stage 3 Slice C). */
function syncLegacyGlobals() {
  if (typeof window !== 'undefined') {
    delete window.privateKey;
  }
}

function attachLegacyFacade() {
  syncLegacyGlobals();
}

function setLegacy(name, value) {
  const mirror = LEGACY_MIRRORS[name];
  if (!mirror) return;
  mirror.write(value);
  if (mirror.expose === false && typeof window !== 'undefined') {
    delete window[name];
  }
}

export {
  attachLegacyFacade,
  syncLegacyGlobals,
  setLegacy,
};
