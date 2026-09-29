import { AppState } from '../state/store.js';
import { syncLocalTradingVisualState } from './trading-visual-sync.js';

function removeLocalPositionByCoin(coin) {
  if (!coin || !AppState.account.state || !Array.isArray(AppState.account.state.assetPositions)) return false;
  const prevPositions = AppState.account.state.assetPositions;
  const nextPositions = prevPositions.filter((wrapper) => wrapper?.position?.coin !== coin);
  if (nextPositions.length === prevPositions.length) return false;
  AppState.account.state = {
    ...AppState.account.state,
    assetPositions: nextPositions,
  };
  return true;
}

function markPendingPositionClose(coin, ttlMs = 10000) {
  if (!coin) return 0;
  const until = Date.now() + Math.max(0, Number(ttlMs) || 0);
  if (!AppState.account.pendingHip3CloseUntilByCoin || typeof AppState.account.pendingHip3CloseUntilByCoin !== 'object') {
    AppState.account.pendingHip3CloseUntilByCoin = {};
  }
  AppState.account.pendingHip3CloseUntilByCoin[coin] = until;
  return until;
}

function applyClosePositionSuccess({ coin, fraction = 1.0 } = {}) {
  if (!coin || Number(fraction) !== 1.0) return false;
  const removedPosition = removeLocalPositionByCoin(coin);
  syncLocalTradingVisualState();
  return removedPosition;
}

export {
  applyClosePositionSuccess,
  markPendingPositionClose,
};
