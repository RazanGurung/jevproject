/**
 * Dedicated 4h RVWAP source hydration (history + live tail).
 * Chart candle path stays in market-service / chart-candle-service.
 */

import {
  AppState,
  rvwapSourceCache,
  rvwapSourceMetaCache,
  setRvwapSourceCacheEntry,
} from '../state/store.js';
import { getActiveCandleRequestToken } from '../state/trading-runtime.js';
import { isActiveMarketSelection } from '../state/market-state.js';
import { getCurrentCoin, getCurrentTimeframe } from '../state/trading-selectors.js';
import { mergeCandleSeries, normalizeCandleSeries } from '../state/market-candles.js';
import { fetchChartCandles as requestChartCandles } from './chart-data.js';
import { fetchWithDedup, isAbortError, isCanceledRequestError } from './api.js';
import { getDex, isBuilderPerpCoin } from '../utils/helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function candleTimeMs(candle) {
  const t = Number(candle?.t ?? candle?.T ?? candle?.time ?? 0);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t < 100_000_000_000 ? t * 1000 : t;
}

function mergeAuthoritativeCandles(cachedCandles, authoritativeCandles) {
  return mergeCandleSeries(cachedCandles, authoritativeCandles);
}

const RVWAP_SOURCE_INTERVAL = '4h';
const RVWAP_SOURCE_LOOKBACK_MS = 600 * DAY_MS;
const RVWAP_SOURCE_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000];
const rvwapSourceRetryTimers = new Map();
const rvwapSourceRetryAttempts = new Map();
let activeRvwapSourceRequest = { coin: '', generation: 0 };
let rvwapSourceGeneration = 0;
const RVWAP_WATCHLIST_HYDRATION_LIMIT = 50;
const RVWAP_SOURCE_REVALIDATE_MS = 15 * 60 * 1000;
let watchlistRvwapHydrationEnabled = false;
let acceptedWatchlistHydrationCoins = [];
let rvwapHydrationQueue = [];
const queuedRvwapHydrationCoins = new Set();
let rvwapHydrationWorker = null;
let activeRvwapHydration = null;
const rvwapHydrationIdleCancels = new Set();
function hasEnabledRvwap() {
  return Array.isArray(AppState.ui?.rvwapLookbacks) && AppState.ui.rvwapLookbacks.length > 0;
}

function rvwapSourceStatus(coin, candles, {
  status = 'ready',
  requestedAt = 0,
  loadedAt = Date.now(),
  complete = status === 'ready',
  verifiedAt = loadedAt,
  stale = false,
  refreshing = false,
  error = '',
} = {}) {
  const rows = Array.isArray(candles) ? candles : [];
  return {
    coin,
    interval: RVWAP_SOURCE_INTERVAL,
    status,
    requestedAt,
    loadedAt,
    count: rows.length,
    firstTime: rows.length > 0 ? candleTimeMs(rows[0]) : 0,
    lastTime: rows.length > 0 ? candleTimeMs(rows[rows.length - 1]) : 0,
    complete,
    verifiedAt,
    stale,
    refreshing,
    error,
  };
}

function matchesCompletedRvwapSource(candles, meta) {
  if (!meta?.complete || !Array.isArray(candles) || candles.length === 0) return false;
  const firstTime = candleTimeMs(candles[0]);
  const lastTime = candleTimeMs(candles[candles.length - 1]);
  return (
    candles.length >= Number(meta.count || 0)
    && firstTime > 0
    && firstTime <= Number(meta.firstTime || 0)
    && lastTime >= Number(meta.lastTime || 0)
  );
}

function isCurrentRvwapRequest(coin, generation) {
  return (
    activeRvwapSourceRequest.coin === coin
    && activeRvwapSourceRequest.generation === generation
    && getCurrentCoin() === coin
  );
}

function clearRvwapSourceRetry(coin, { resetAttempts = true } = {}) {
  const timer = rvwapSourceRetryTimers.get(coin);
  if (timer) clearTimeout(timer);
  rvwapSourceRetryTimers.delete(coin);
  if (resetAttempts) rvwapSourceRetryAttempts.delete(coin);
}

function clearInactiveRvwapSourceRetries(activeCoin = '') {
  for (const coin of rvwapSourceRetryTimers.keys()) {
    if (coin !== activeCoin) clearRvwapSourceRetry(coin);
  }
}

function cancelRvwapSourceRetries() {
  for (const coin of [...rvwapSourceRetryTimers.keys()]) clearRvwapSourceRetry(coin);
  activeRvwapSourceRequest = { coin: '', generation: ++rvwapSourceGeneration };
}

function scheduleRvwapSourceRender(coin) {
  if (coin !== getCurrentCoin() || !hasEnabledRvwap()) return;
  Promise.resolve(import('../chart/chart-render.js'))
    .then(({ scheduleChartRender }) => scheduleChartRender?.())
    .catch(() => {});
}

function scheduleRvwapSourceRetry(coin) {
  if (coin !== getCurrentCoin() || !hasEnabledRvwap() || rvwapSourceRetryTimers.has(coin)) return;
  const attempt = rvwapSourceRetryAttempts.get(coin) || 0;
  if (attempt >= RVWAP_SOURCE_RETRY_DELAYS_MS.length) return;
  rvwapSourceRetryAttempts.set(coin, attempt + 1);
  const timer = setTimeout(() => {
    rvwapSourceRetryTimers.delete(coin);
    if (coin !== getCurrentCoin() || !hasEnabledRvwap()) {
      clearRvwapSourceRetry(coin);
      return;
    }
    hydrateRvwapSource({ coin, updateActive: true }).then((result) => {
      if (!result) scheduleRvwapSourceRetry(coin);
    }).catch(() => scheduleRvwapSourceRetry(coin));
  }, RVWAP_SOURCE_RETRY_DELAYS_MS[attempt]);
  if (typeof timer?.unref === 'function') timer.unref();
  rvwapSourceRetryTimers.set(coin, timer);
}

function commitRvwapSource(targetCoin, data, {
  requestedAt = Date.now(),
  updateActive = true,
} = {}) {
  const normalized = normalizeCandleSeries(data);
  if (!normalized.length) return null;
  const sourceStartTime = requestedAt - RVWAP_SOURCE_LOOKBACK_MS;
  // Live 4h messages can land while the history response is in flight. The
  // staged cache wins timestamp conflicts so the completed source never moves
  // backwards to an older revision from the REST snapshot.
  const concurrentRows = (rvwapSourceCache.get(targetCoin) || [])
    .filter((candle) => candleTimeMs(candle) >= sourceStartTime);
  const merged = mergeAuthoritativeCandles(normalized, concurrentRows);
  const readyStatus = rvwapSourceStatus(targetCoin, merged, {
    status: 'ready',
    requestedAt,
    loadedAt: Date.now(),
    complete: true,
    verifiedAt: Date.now(),
    stale: false,
    refreshing: false,
  });
  setRvwapSourceCacheEntry(targetCoin, merged, readyStatus);
  if (updateActive && targetCoin === getCurrentCoin()) {
    AppState.market.rvwapSource = readyStatus;
    clearRvwapSourceRetry(targetCoin);
    scheduleRvwapSourceRender(targetCoin);
  }
  return merged;
}

async function hydrateRvwapSource({ coin = getCurrentCoin(), signal, updateActive = false } = {}) {
  const targetCoin = String(coin || '').trim();
  if (!targetCoin) return null;
  const requestedAt = Date.now();
  const cached = rvwapSourceCache.get(targetCoin);
  const cachedMeta = rvwapSourceMetaCache.get(targetCoin);
  if (updateActive && targetCoin === getCurrentCoin() && matchesCompletedRvwapSource(cached, cachedMeta)) {
    AppState.market.rvwapSource = rvwapSourceStatus(targetCoin, cached, {
      ...cachedMeta,
      status: 'ready',
      stale: true,
      refreshing: true,
    });
    scheduleRvwapSourceRender(targetCoin);
  }
  try {
    const data = await fetchWithDedup(`rvwap-source:hydrate:${targetCoin}`, () => requestChartCandles({
      coin: targetCoin,
      interval: RVWAP_SOURCE_INTERVAL,
      startTime: requestedAt - RVWAP_SOURCE_LOOKBACK_MS,
      endTime: requestedAt,
      dex: isBuilderPerpCoin(targetCoin) ? getDex(targetCoin) : '',
      urgency: 'hydrate',
      background: true,
      signal,
    }));
    // A 202 hydrate response is parsed as {status:'warming'}; only an array is
    // a completed store hit. The scheduler owns the bounded retry cadence.
    if (!Array.isArray(data) || data.length === 0) return null;
    return commitRvwapSource(targetCoin, data, { requestedAt, updateActive });
  } catch (error) {
    if (isCanceledRequestError(error, signal) || isAbortError(error, signal)) return null;
    return null;
  }
}

function hydrationCoinDesired(coin) {
  if (coin === getCurrentCoin()) return true;
  return watchlistRvwapHydrationEnabled && acceptedWatchlistHydrationCoins.includes(coin);
}

function startRvwapHydrationWorker() {
  if (rvwapHydrationWorker) return rvwapHydrationWorker;
  rvwapHydrationWorker = (async () => {
    while (rvwapHydrationQueue.length > 0) {
      const task = rvwapHydrationQueue.shift();
      queuedRvwapHydrationCoins.delete(task.coin);
      if (!hydrationCoinDesired(task.coin)) continue;
      const cached = rvwapSourceCache.get(task.coin);
      const meta = rvwapSourceMetaCache.get(task.coin);
      if (!task.force && matchesCompletedRvwapSource(cached, meta)) {
        if (task.coin === getCurrentCoin()) adoptCachedRvwapSource(task.coin);
        continue;
      }

      const controller = new AbortController();
      activeRvwapHydration = { ...task, controller };
      // One cheap store probe is enough to start (or join) the backend's
      // budget-paced warm. Move on immediately when it answers 202 so every
      // accepted watchlist coin gets registered instead of the first cold coin
      // holding this single-file queue through a client-side retry ladder. The
      // two-minute preload-hint keepalive naturally probes unfinished entries
      // again; a visible indicator has its own short retry path.
      const hydrated = await hydrateRvwapSource({
        coin: task.coin,
        signal: controller.signal,
        updateActive: task.coin === getCurrentCoin(),
      });
      if (!hydrated && task.coin === getCurrentCoin() && hasEnabledRvwap()) {
        scheduleRvwapSourceRetry(task.coin);
      }
      activeRvwapHydration = null;
    }
  })().finally(() => {
    rvwapHydrationWorker = null;
    if (rvwapHydrationQueue.length > 0) startRvwapHydrationWorker();
  });
  return rvwapHydrationWorker;
}

function queueRvwapHydration(coin, { priority = false, force = false } = {}) {
  const targetCoin = String(coin || '').trim();
  if (!targetCoin) return;
  const existing = rvwapHydrationQueue.find((task) => task.coin === targetCoin);
  if (existing) {
    existing.force ||= force;
    if (priority) {
      rvwapHydrationQueue = [existing, ...rvwapHydrationQueue.filter((task) => task !== existing)];
    }
    return;
  }
  if (activeRvwapHydration?.coin === targetCoin) return;
  const task = { coin: targetCoin, priority, force };
  if (priority) rvwapHydrationQueue.unshift(task);
  else rvwapHydrationQueue.push(task);
  queuedRvwapHydrationCoins.add(targetCoin);
  if (priority && activeRvwapHydration && !activeRvwapHydration.priority) {
    const interrupted = activeRvwapHydration;
    interrupted.controller.abort();
    if (hydrationCoinDesired(interrupted.coin) && !queuedRvwapHydrationCoins.has(interrupted.coin)) {
      rvwapHydrationQueue.push({ coin: interrupted.coin, priority: false, force: interrupted.force });
      queuedRvwapHydrationCoins.add(interrupted.coin);
    }
  }
  startRvwapHydrationWorker();
}

function adoptCachedRvwapSource(coin) {
  if (!hasEnabledRvwap() || coin !== getCurrentCoin()) return false;
  const cached = rvwapSourceCache.get(coin);
  const meta = rvwapSourceMetaCache.get(coin);
  if (!matchesCompletedRvwapSource(cached, meta)) return false;
  const current = AppState.market.rvwapSource || {};
  if (current.coin === coin && current.status === 'ready' && current.complete === true) {
    return true;
  }
  AppState.market.rvwapSource = rvwapSourceStatus(coin, cached, meta);
  clearRvwapSourceRetry(coin);
  scheduleRvwapSourceRender(coin);
  return true;
}

function scheduleActiveRvwapHydration(coin = getCurrentCoin(), { force = false } = {}) {
  if (!hasEnabledRvwap()) return;
  const targetCoin = String(coin || '').trim();
  if (!targetCoin || targetCoin !== getCurrentCoin()) return;

  const adopted = adoptCachedRvwapSource(targetCoin);
  const meta = rvwapSourceMetaCache.get(targetCoin);
  const needsRevalidation = Number(meta?.verifiedAt || 0) > 0
    && Date.now() - Number(meta.verifiedAt) >= RVWAP_SOURCE_REVALIDATE_MS;
  if (adopted && !force && !needsRevalidation) return;

  if (adopted) {
    queueRvwapHydration(targetCoin, { priority: true, force: true });
    return;
  }

  const current = AppState.market.rvwapSource || {};
  if (current.coin === targetCoin && (current.status === 'loading' || current.refreshing === true)) {
    return;
  }
  if (current.coin !== targetCoin) {
    AppState.market.rvwapSource = rvwapSourceStatus(targetCoin, [], {
      status: 'loading', requestedAt: Date.now(), loadedAt: 0, complete: false, verifiedAt: 0,
    });
    scheduleRvwapSourceRender(targetCoin);
  }
  void ensureRvwapSource({ coin: targetCoin, force });
}

function setWatchlistRvwapHydration(coins = []) {
  watchlistRvwapHydrationEnabled = true;
  acceptedWatchlistHydrationCoins = [...new Set(coins.map((coin) => String(coin || '').trim()).filter(Boolean))]
    .slice(0, RVWAP_WATCHLIST_HYDRATION_LIMIT);
  rvwapHydrationQueue = rvwapHydrationQueue.filter((task) => {
    const keep = task.coin === getCurrentCoin() || acceptedWatchlistHydrationCoins.includes(task.coin);
    if (!keep) queuedRvwapHydrationCoins.delete(task.coin);
    return keep;
  });
  queueRvwapHydration(getCurrentCoin(), { priority: true });
  for (const coin of acceptedWatchlistHydrationCoins) queueRvwapHydration(coin);
}

function stopWatchlistRvwapHydration() {
  watchlistRvwapHydrationEnabled = false;
  acceptedWatchlistHydrationCoins = [];
  rvwapHydrationQueue = rvwapHydrationQueue.filter((task) => task.coin === getCurrentCoin());
  queuedRvwapHydrationCoins.clear();
  for (const task of rvwapHydrationQueue) queuedRvwapHydrationCoins.add(task.coin);
  if (activeRvwapHydration && activeRvwapHydration.coin !== getCurrentCoin()) {
    activeRvwapHydration.controller.abort();
  }
}

// Full lifecycle/test teardown. Primary-tab ownership changes use the narrower
// stopWatchlistRvwapHydration above so another tab does not cancel this tab's
// active-coin preparation.
function cancelRvwapHydrationWork() {
  for (const cancel of [...rvwapHydrationIdleCancels]) cancel();
  rvwapHydrationQueue = [];
  queuedRvwapHydrationCoins.clear();
  watchlistRvwapHydrationEnabled = false;
  acceptedWatchlistHydrationCoins = [];
  activeRvwapHydration?.controller.abort();
}

async function ensureRvwapSource({ coin = getCurrentCoin(), force = false } = {}) {
  const targetCoin = String(coin || '').trim();
  if (!targetCoin) return null;
  const cached = rvwapSourceCache.get(targetCoin);
  const cachedMeta = rvwapSourceMetaCache.get(targetCoin);
  const hasCompletedCache = matchesCompletedRvwapSource(cached, cachedMeta);
  const isActiveTarget = targetCoin === getCurrentCoin();
  const generation = isActiveTarget ? ++rvwapSourceGeneration : 0;
  if (isActiveTarget) {
    activeRvwapSourceRequest = { coin: targetCoin, generation };
    clearInactiveRvwapSourceRetries(targetCoin);
  }
  if (!force && hasCompletedCache) {
    if (isCurrentRvwapRequest(targetCoin, generation)) {
      AppState.market.rvwapSource = rvwapSourceStatus(targetCoin, cached, cachedMeta);
      clearRvwapSourceRetry(targetCoin);
      scheduleRvwapSourceRender(targetCoin);
    }
    scheduleActiveRvwapHydration(targetCoin);
    return cached;
  }

  const now = Date.now();
  if (isCurrentRvwapRequest(targetCoin, generation) && !hasCompletedCache) {
    AppState.market.rvwapSource = rvwapSourceStatus(targetCoin, [], {
      status: 'loading', requestedAt: now, loadedAt: 0, complete: false, verifiedAt: 0,
    });
  }
  try {
    // User-triggered RVWAP work owns the visible lane and a distinct dedup key;
    // it can never inherit a speculative watchlist request's queue wait.
    const data = await fetchWithDedup(`rvwap-source:interactive:${targetCoin}`, () => requestChartCandles({
      coin: targetCoin,
      interval: RVWAP_SOURCE_INTERVAL,
      startTime: now - RVWAP_SOURCE_LOOKBACK_MS,
      endTime: now,
      dex: isBuilderPerpCoin(targetCoin) ? getDex(targetCoin) : '',
      urgency: 'visible',
      background: false,
    }));
    if (!Array.isArray(data) || data.length === 0) throw new Error('RVWAP source unavailable');
    const merged = commitRvwapSource(targetCoin, data, { requestedAt: now, updateActive: false });
    if (isCurrentRvwapRequest(targetCoin, generation)) {
      AppState.market.rvwapSource = rvwapSourceMetaCache.get(targetCoin);
      clearRvwapSourceRetry(targetCoin);
      scheduleRvwapSourceRender(targetCoin);
    }
    return merged;
  } catch (error) {
    if (isCurrentRvwapRequest(targetCoin, generation)) {
      const errorMessage = String(error?.message || error);
      AppState.market.rvwapSource = hasCompletedCache
        ? rvwapSourceStatus(targetCoin, cached, {
          ...cachedMeta, status: 'ready', stale: true, refreshing: true, error: errorMessage,
        })
        : rvwapSourceStatus(targetCoin, [], {
          status: 'error', requestedAt: now, loadedAt: 0, complete: false, verifiedAt: 0, error: errorMessage,
        });
      scheduleRvwapSourceRetry(targetCoin);
    }
    return null;
  }
}


export {
  RVWAP_SOURCE_INTERVAL,
  RVWAP_SOURCE_LOOKBACK_MS,
  hasEnabledRvwap,
  ensureRvwapSource,
  hydrateRvwapSource,
  scheduleActiveRvwapHydration,
  setWatchlistRvwapHydration,
  stopWatchlistRvwapHydration,
  cancelRvwapHydrationWork,
  cancelRvwapSourceRetries,
};
