/**
 * Market session controller — single owner of chart market intent.
 *
 * Backend remains authoritative for candle residency, weight budgeting, and
 * subscription admission. This module only:
 *   - applies AppState trading coin/timeframe intent
 *   - asks streams/services to refresh from backend endpoints
 *
 * UI modules should call these helpers instead of importing market-ws or
 * market-service fetch paths directly.
 */

import { setDesiredMarketSubscription } from '../state/market-subscription-state.js';
import {
  getEffectiveCurrentCoin,
  getEffectiveCurrentTimeframe,
} from '../state/effective-trading.js';

let marketActionsLoader = null;
let candleFetcher = null;
let rvwapEnsure = null;

/**
 * Wire stream/service loaders once from bootstrap. Keeps UI free of dynamic
 * import graphs into market-ws / market-service.
 */
export function configureMarketSession({
  loadMarketActions,
  fetchCandles,
  ensureRvwapSource,
} = {}) {
  if (typeof loadMarketActions === 'function') marketActionsLoader = loadMarketActions;
  if (typeof fetchCandles === 'function') candleFetcher = fetchCandles;
  if (typeof ensureRvwapSource === 'function') rvwapEnsure = ensureRvwapSource;
}

async function loadMarketActions() {
  if (typeof marketActionsLoader === 'function') {
    return marketActionsLoader();
  }
  return import('../streams/market-ws.js');
}

async function loadCandleFetcher() {
  if (typeof candleFetcher === 'function') return candleFetcher;
  const mod = await import('./chart-candle-service.js');
  candleFetcher = mod.fetchCandles;
  return candleFetcher;
}

/** Intent: active chart subscription should match coin/interval (backend admits). */
export async function requestMarketSubscription(overrides = {}) {
  const coin = overrides.coin || getEffectiveCurrentCoin();
  const interval = overrides.interval || getEffectiveCurrentTimeframe();
  const tradeCoins = overrides.tradeCoins;
  const indicatorIntervals = overrides.indicatorIntervals;
  setDesiredMarketSubscription({
    coin,
    interval,
    ...(Array.isArray(tradeCoins) ? { tradeCoins } : {}),
    ...(Array.isArray(indicatorIntervals) ? { indicatorIntervals } : {}),
  });
  const actions = await loadMarketActions();
  if (typeof actions.subscribeMarket === 'function') {
    // Positional subscribeMarket(coin, interval, tradeCoins). Do not pass the
    // overrides object — that subscribed coin="[object Object]".
    return actions.subscribeMarket();
  }
  return null;
}

/** Intent: cancel scheduled market renders (timeframe/coin switch). */
export async function cancelPendingMarketRenders() {
  const actions = await loadMarketActions();
  actions.cancelPendingRenders?.();
}

/** Intent: load candles for active chart from backend chart path. */
export async function requestChartCandles(coin, timeframe, options = {}) {
  const fetchCandles = await loadCandleFetcher();
  return fetchCandles(coin, timeframe, options);
}

/** Intent: ensure RVWAP source series (backend candle path + local cache). */
export async function requestRvwapSource(coin, options = {}) {
  if (typeof rvwapEnsure === 'function') {
    return rvwapEnsure(coin, options);
  }
  const mod = await import('./rvwap-source-service.js');
  rvwapEnsure = mod.ensureRvwapSource;
  return rvwapEnsure?.(coin, options);
}

export function getMarketSessionLoaders() {
  return {
    loadMarketActions,
    fetchCandles: (...args) => requestChartCandles(...args),
    ensureRvwapSource: (...args) => requestRvwapSource(...args),
  };
}
