import { AppState } from './store.js';
import { DEFAULT_TIMEFRAME } from '../chart/chart-history-requirements.js';
import { getWatchlist } from '../services/watchlist-store.js';

// The active coin, watchlist, and last few visited coins ride along on the
// trade/book subscription. Movers are a UI ranking and do not retarget HL.
// The backend still owns admission control and reports any background coins it
// sheds when the shared upstream subscription budget is tight.
function getWatchlistTradeCoins() {
  try {
    return getWatchlist();
  } catch (_) {
    return [];
  }
}

function normalizeCoinSymbol(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '[object Object]') return '';
  return trimmed;
}

function normalizeCoins(coins = []) {
  const values = Array.isArray(coins) ? coins : Array.from(coins || []);
  const seen = new Set();
  const normalized = [];
  values.forEach((coin) => {
    const value = normalizeCoinSymbol(coin);
    if (!value || seen.has(value)) return;
    seen.add(value);
    normalized.push(value);
  });
  return normalized;
}

// Membership equality only. Trade-coin *order* encodes admission priority
// (active first), but a pure re-rank of movers must not rewrite intent or
// force a market-subscribe POST when the warm set is unchanged.
function sameCoins(left = [], right = []) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  for (let index = 0; index < left.length; index++) {
    if (!rightSet.has(left[index])) return false;
  }
  return true;
}

function getDesiredIndicatorIntervals() {
  return Array.isArray(AppState.ui.rvwapLookbacks) && AppState.ui.rvwapLookbacks.length > 0
    ? ['4h']
    : [];
}

function ensureMarketSubscriptionIntent() {
  if (!AppState.connection.marketSubscription || typeof AppState.connection.marketSubscription !== 'object') {
    AppState.connection.marketSubscription = {
      coin: '',
      interval: '',
      tradeCoins: [],
      indicatorIntervals: [],
      updatedAt: 0,
    };
  }
  return AppState.connection.marketSubscription;
}

function syncMarketSubscriptionMirrors() {
  // Stage 3 Slice C: intent lives only on AppState.connection.marketSubscription.
  ensureMarketSubscriptionIntent();
}

function readTrackedCoinsFromDom() {
  if (typeof document === 'undefined') return [];
  const buttons = Array.from(document.querySelectorAll('#coinTabs button.coin-tab[data-action="switchCoin"]'));
  const coins = normalizeCoins(buttons.map((button) => button.getAttribute('data-arg')));
  if (coins.length > 0) {
    AppState.trading.trackedCoins = coins;
  }
  return coins;
}

function getTrackedCoins({ includeActiveCoin = false } = {}) {
  const stateCoins = normalizeCoins(AppState.trading.trackedCoins);
  const trackedCoins = stateCoins.length > 0 ? stateCoins : readTrackedCoinsFromDom();
  if (!includeActiveCoin) return trackedCoins;
  return normalizeCoins([...trackedCoins, AppState.trading.currentCoin]);
}

function getDesiredTradeCoins({
  activeCoin = AppState.trading.currentCoin,
  watchlistCoins = getWatchlistTradeCoins(),
  recentCoins = Array.isArray(AppState.trading.recentCoins) ? AppState.trading.recentCoins : [],
} = {}) {
  // Movers stay a UI ranking. Warm books/trades only for the active chart,
  // the user watchlist, and the last few visited coins.
  return normalizeCoins([activeCoin, ...watchlistCoins, ...recentCoins]);
}

function resolveSubscriptionTradeCoins(tradeCoins, activeCoin) {
  if (tradeCoins === undefined) {
    return getDesiredTradeCoins({ activeCoin });
  }
  return normalizeCoins([...(Array.isArray(tradeCoins) ? tradeCoins : Array.from(tradeCoins || [])), activeCoin]);
}

function setDesiredMarketSubscription({
  coin = AppState.trading.currentCoin,
  interval = AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME,
  tradeCoins = getDesiredTradeCoins({ activeCoin: coin }),
  indicatorIntervals = getDesiredIndicatorIntervals(),
} = {}) {
  const nextCoin = normalizeCoinSymbol(coin) || normalizeCoinSymbol(AppState.trading.currentCoin);
  const nextInterval = (typeof interval === 'string' ? interval.trim() : '')
    || (AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME);
  const normalizedTradeCoins = resolveSubscriptionTradeCoins(tradeCoins, nextCoin);
  const normalizedIndicatorIntervals = normalizeCoins(indicatorIntervals);
  const current = ensureMarketSubscriptionIntent();
  AppState.connection.marketSubscription = {
    ...current,
    coin: nextCoin,
    interval: nextInterval,
    tradeCoins: normalizedTradeCoins,
    indicatorIntervals: normalizedIndicatorIntervals,
    updatedAt: Date.now(),
  };
  syncMarketSubscriptionMirrors();
  return AppState.connection.marketSubscription;
}

function getDesiredMarketSubscription(options = {}) {
  const current = ensureMarketSubscriptionIntent();
  const hasCoinOverride = Object.prototype.hasOwnProperty.call(options, 'coin');
  const hasIntervalOverride = Object.prototype.hasOwnProperty.call(options, 'interval');
  const hasTradeCoinsOverride = Object.prototype.hasOwnProperty.call(options, 'tradeCoins');
  const hasIndicatorIntervalsOverride = Object.prototype.hasOwnProperty.call(options, 'indicatorIntervals');

  if (!hasCoinOverride && !hasIntervalOverride && !hasTradeCoinsOverride && !hasIndicatorIntervalsOverride && current.coin && current.interval) {
    const desiredIndicatorIntervals = getDesiredIndicatorIntervals();
    if (sameCoins(current.indicatorIntervals || [], desiredIndicatorIntervals)) {
      syncMarketSubscriptionMirrors();
      return current;
    }
    return setDesiredMarketSubscription({
      coin: current.coin,
      interval: current.interval,
      tradeCoins: current.tradeCoins,
      indicatorIntervals: desiredIndicatorIntervals,
    });
  }

  const nextCoin = normalizeCoinSymbol(
    hasCoinOverride ? options.coin : (current.coin || AppState.trading.currentCoin),
  ) || normalizeCoinSymbol(AppState.trading.currentCoin);
  const nextInterval = (typeof (hasIntervalOverride ? options.interval : current.interval) === 'string'
    ? (hasIntervalOverride ? options.interval : current.interval).trim()
    : '') || (AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME);
  const normalizedTradeCoins = hasTradeCoinsOverride
    ? resolveSubscriptionTradeCoins(options.tradeCoins, nextCoin)
    : resolveSubscriptionTradeCoins(undefined, nextCoin);
  const normalizedIndicatorIntervals = hasIndicatorIntervalsOverride
    ? normalizeCoins(options.indicatorIntervals)
    : getDesiredIndicatorIntervals();

  if (
    current.coin === nextCoin
    && current.interval === nextInterval
    && sameCoins(current.tradeCoins || [], normalizedTradeCoins)
    && sameCoins(current.indicatorIntervals || [], normalizedIndicatorIntervals)
  ) {
    syncMarketSubscriptionMirrors();
    return current;
  }

  return setDesiredMarketSubscription({
    coin: nextCoin,
    interval: nextInterval,
    tradeCoins: normalizedTradeCoins,
    indicatorIntervals: normalizedIndicatorIntervals,
  });
}

export {
  getDesiredIndicatorIntervals,
  getDesiredMarketSubscription,
  getDesiredTradeCoins,
  getTrackedCoins,
  setDesiredMarketSubscription,
  syncMarketSubscriptionMirrors,
};
