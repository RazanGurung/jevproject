import { AppState } from './store.js';

function getApiKey() {
  return AppState.account.privateKey || '';
}

function getWalletAddress() {
  return AppState.account.walletAddress || '';
}

function getExchangeLeverage(coin) {
  if (!coin) return null;
  const leverage = parseInt(AppState.account.exchangeLeverageByCoin?.[coin], 10);
  return Number.isFinite(leverage) && leverage > 0 ? leverage : null;
}

function getDefaultLeverageApplied(coin) {
  if (!coin) return null;
  const leverage = parseInt(AppState.account.defaultLeverageAppliedByCoin?.[coin], 10);
  return Number.isFinite(leverage) && leverage > 0 ? leverage : null;
}

export {
  getApiKey,
  getWalletAddress,
  getExchangeLeverage,
  getDefaultLeverageApplied,
};
