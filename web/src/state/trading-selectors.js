import { AppState } from './store.js';
import { DEFAULT_TIMEFRAME } from '../chart/chart-history-requirements.js';

function getCurrentCoin() {
  return AppState.trading.currentCoin || 'BTC';
}

function getCurrentPrice() {
  const price = Number(AppState.trading.currentPrice || 0);
  return Number.isFinite(price) ? price : 0;
}

function getCurrentSide() {
  return AppState.trading.currentSide || 'buy';
}

function getCurrentTimeframe() {
  return AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME;
}

function getCurrentOrderType() {
  return AppState.trading.currentOrderType || 'limit';
}

function getLastDeployedPlan() {
  return AppState.trading.lastDeployedPlan || null;
}

export {
  getCurrentCoin,
  getCurrentPrice,
  getCurrentSide,
  getCurrentTimeframe,
  getCurrentOrderType,
  getLastDeployedPlan,
};
