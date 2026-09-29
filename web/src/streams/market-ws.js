/**
 * Market data handlers — state updates and renders for market channel messages.
 * Receives data from the backend-owned downstream stream.
 */

import {
  AppState,
  candleCache,
  rvwapSourceCache,
  setCandleCacheEntry,
  setRvwapSourceCacheEntry,
} from '../state/store.js';
import { completeChartSession } from '../state/chart-session.js';
import { DEFAULT_TIMEFRAME } from '../chart/chart-history-requirements.js';
import { getDesiredMarketSubscription, setDesiredMarketSubscription } from '../state/market-subscription-state.js';
import {
  applyFlowSnapshot,
  ensureCoinTradeBuckets,
  ingestMarketLiquidations,
  ingestTrades,
  isFlowSnapshotEligible,
  normalizeTradeBatch,
  syncActiveTradeStateSnapshot,
} from '../state/market-trades.js';
import { scheduleLiquidationsRender } from '../render/trades.js';
import { scheduleMispricingRender } from '../render/mispricing.js';
import { noteDomBookCoin } from '../render/dom-ladder.js';
import { ingestDomTrades } from '../state/dom-ladder-state.js';
import { ingestWhaleResponses, sampleWhaleResponses } from '../state/whale-response.js';
import { incrementBookVersion } from '../state/runtime-mirrors.js';
import { currentBucketOpenSeconds, isValidExchangeCandle, mergeCandle } from '../state/market-candles.js';
import { buildNormalizedBook, setMarketBookSnapshot, setMarketCandles } from '../state/market-state.js';
import { ingestBook } from '../state/market-book.js';
import { createMarketSubscriptionController } from './market-subscription.js';
import { bufferLiveChartCandle } from '../chart/chart-render.js';
import { bufferLiveRvwapSource } from '../chart/lightweight-chart.js';
import { updateSummary } from '../ui/tabs.js';
import { resolveApiUrl } from '../services/api.js';
import { sleep } from '../services/api.js';
import { getStreamClientId } from './client-id.js';
import { postMarketSubscription } from './market-subscribe-client.js';
import {
  cancelPendingRenders,
  refreshLimitPreviewTracking,
  scheduleActiveTradePanelsRender,
  scheduleLiveDomLadderRender,
  scheduleOrderbookRender,
  scheduleWatchlistMetricsRender,
} from './market-render-runtime.js';
import {
  applyCurrentPrice,
  maybeInvalidateStaleLivePriceLine,
  updatePriceFromL2,
} from './market-price-runtime.js';
import { scheduleLegacyBotTradeUpdate } from '../services/runtime-compat.js';
import { recordApiResult, recordStreamEvent } from '../services/transport-metrics.js';
import { updateChartTitle } from '../ui/market-display.js';
import { getActiveCandleRequestToken } from '../state/trading-runtime.js';
import { noteMarketTick, setMarketUpstreamConnected } from '../state/connection-health.js';

const LIVE_PRICE_LINE_MAX_AGE_MS = 30000;
const MARKET_SUBSCRIBE_RETRY_DELAYS_MS = [250, 750];
const ACTIVE_CANDLE_REPAIR_DELAYS_MS = [1000, 2000, 5000, 10000];
// Bound once after the first dynamic import so live candles do not allocate a
// fresh Promise on every tick just to re-enter the CVD self-heal helper.
let ensureActiveCvdRefreshBound = null;
let ensureActiveCvdRefreshLoading = null;

function queueActiveCvdRefresh(coin, timeframe, candles) {
  if (typeof ensureActiveCvdRefreshBound === 'function') {
    ensureActiveCvdRefreshBound(coin, timeframe, candles);
    return;
  }
  if (!ensureActiveCvdRefreshLoading) {
    ensureActiveCvdRefreshLoading = Promise.resolve(import('../services/market-service.js'))
      .then((mod) => {
        ensureActiveCvdRefreshBound = mod.ensureActiveCvdRefresh || null;
        return ensureActiveCvdRefreshBound;
      })
      .catch(() => {
        ensureActiveCvdRefreshBound = null;
        return null;
      })
      .finally(() => {
        ensureActiveCvdRefreshLoading = null;
      });
  }
  ensureActiveCvdRefreshLoading.then((fn) => {
    if (typeof fn === 'function') fn(coin, timeframe, candles);
  });
}

const TIMEFRAME_SECONDS = {
  '1m': 60,
  '3m': 3 * 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '2h': 2 * 60 * 60,
  '4h': 4 * 60 * 60,
  '8h': 8 * 60 * 60,
  '12h': 12 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1M': 30 * 24 * 60 * 60,
};

// bookVersion is owned solely by runtime-mirrors (single source of truth).
let marketSubscriptionGeneration = 0;
let subscribeAbort = null;
const activeCandleRepairs = new Map();
const marketSubscriptionController = createMarketSubscriptionController();

function abortInFlightSubscribe() {
  try { subscribeAbort?.abort?.(); } catch {}
  subscribeAbort = null;
}

function normalizeCandleTime(time) {
  const numeric = Number(time || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric >= 100000000000) {
    return Math.floor(numeric / 1000);
  }
  return Math.floor(numeric);
}

function getExpectedIntervalSeconds(timeframe = DEFAULT_TIMEFRAME) {
  return TIMEFRAME_SECONDS[timeframe] || TIMEFRAME_SECONDS[DEFAULT_TIMEFRAME] || TIMEFRAME_SECONDS['4h'];
}

function shouldRecoverActiveCandleGap({ candle, timeframe, existingCandles } = {}) {
  if (!candle || !Array.isArray(existingCandles) || existingCandles.length === 0) return false;
  const incomingTime = normalizeCandleTime(candle.t);
  const previousTime = normalizeCandleTime(existingCandles[existingCandles.length - 1]?.t);
  if (!(incomingTime > 0) || !(previousTime > 0) || incomingTime <= previousTime) return false;
  const expectedInterval = getExpectedIntervalSeconds(timeframe);
  // Use a more generous threshold for 1m to tolerate network jitter and
  // reconnection delays. Lightweight Charts can display sparse time series,
  // but a large jump still means our exchange history may be incomplete, so
  // repair it through the authoritative candle snapshot path.
  const gapThreshold = expectedInterval <= 60 ? 2.5 : 1.5;
  return expectedInterval > 0 && (incomingTime - previousTime) > expectedInterval * gapThreshold;
}

// Resume/reconnect path: the gap check in handleCandle only runs when the next
// WS candle arrives, which on slow timeframes can be minutes away. This probes
// the cached tail directly so a reconnect backfills the chart immediately.
function recoverActiveCandlesIfStale(now = Date.now(), { forceAuthoritative = false } = {}) {
  const coin = AppState.trading.currentCoin;
  const timeframe = AppState.trading.currentTimeframe;
  if (!coin || !timeframe) return false;
  const candles = Array.isArray(AppState.market.candles) ? AppState.market.candles : [];
  if (candles.length === 0) return false;
  const lastTime = normalizeCandleTime(candles[candles.length - 1]?.t);
  if (!(lastTime > 0)) return false;
  const expectedInterval = getExpectedIntervalSeconds(timeframe);
  const gapThreshold = expectedInterval <= 60 ? 2.5 : 1.5;
  if (!forceAuthoritative && (now / 1000 - lastTime) <= expectedInterval * gapThreshold) return false;
  recordStreamEvent('candleResumeBackfills');
  requestActiveCandleRecovery(coin, timeframe, lastTime);
  return true;
}

// A newly-opened downstream socket has just rebuilt its subscription state.
// Do not wait 1.5 timeframes to repair an active 2h/4h/8h chart: if its last
// candle predates the current bucket, fetch immediately. A current in-progress
// bucket is still fresh even though it may have received no tick yet.
function recoverActiveCandlesAfterReconnect(now = Date.now()) {
  const coin = AppState.trading.currentCoin;
  const timeframe = AppState.trading.currentTimeframe;
  if (!coin || !timeframe) return false;
  const candles = Array.isArray(AppState.market.candles) ? AppState.market.candles : [];
  const lastTime = normalizeCandleTime(candles[candles.length - 1]?.t);
  const currentBucket = currentBucketOpenSeconds(timeframe, now);
  if (!(currentBucket > 0)) return false;
  if (lastTime >= currentBucket) return false;
  recordStreamEvent('candleReconnectBackfills');
  requestActiveCandleRecovery(coin, timeframe, lastTime);
  return true;
}

function clearActiveCandleRepair(cacheKey, state) {
  if (state?.timer) clearTimeout(state.timer);
  if (activeCandleRepairs.get(cacheKey) === state) activeCandleRepairs.delete(cacheKey);
  if (AppState.market.candleIntegrity.activeRepair?.key === cacheKey) {
    AppState.market.candleIntegrity.activeRepair = null;
  }
}

function scheduleActiveCandleRepair(cacheKey, state) {
  if (activeCandleRepairs.get(cacheKey) !== state || state.timer || state.inFlight) return;
  const delayIndex = Math.min(state.attempts, ACTIVE_CANDLE_REPAIR_DELAYS_MS.length - 1);
  const baseDelay = ACTIVE_CANDLE_REPAIR_DELAYS_MS[delayIndex];
  const delay = Math.max(250, Math.round(baseDelay * (0.9 + Math.random() * 0.2)));
  state.timer = setTimeout(() => {
    state.timer = null;
    runActiveCandleRepair(cacheKey, state);
  }, delay);
  if (typeof state.timer?.unref === 'function') state.timer.unref();
}

async function runActiveCandleRepair(cacheKey, state) {
  if (activeCandleRepairs.get(cacheKey) !== state || state.inFlight) return;
  if (AppState.trading.currentCoin !== state.coin || AppState.trading.currentTimeframe !== state.timeframe) {
    clearActiveCandleRepair(cacheKey, state);
    return;
  }
  state.inFlight = true;
  state.attempts += 1;
  const generationAtStart = state.generation;
  AppState.market.candleIntegrity.repairAttempts += 1;
  AppState.market.candleIntegrity.activeRepair = {
    key: cacheKey,
    fromTime: state.repairFromTime,
    attempts: state.attempts,
    startedAt: state.startedAt,
  };
  let repaired = null;
  try {
    const { fetchCandles } = await import('../services/market-service.js');
    repaired = await fetchCandles?.({
      coin: state.coin,
      timeframe: state.timeframe,
      requestToken: getActiveCandleRequestToken(),
      forceAuthoritative: true,
      repairFromTime: state.repairFromTime,
    });
  } catch (error) {
    console.warn('[market] active candle recovery failed:', error);
  } finally {
    state.inFlight = false;
  }

  if (activeCandleRepairs.get(cacheKey) !== state) return;
  if (AppState.trading.currentCoin !== state.coin || AppState.trading.currentTimeframe !== state.timeframe) {
    clearActiveCandleRepair(cacheKey, state);
    return;
  }
  if (Array.isArray(repaired) && repaired.length > 0 && generationAtStart === state.generation) {
    AppState.market.candleIntegrity.repairSuccesses += 1;
    clearActiveCandleRepair(cacheKey, state);
    return;
  }
  // A second jump may land while the first snapshot is in flight. Retry that
  // newer generation immediately; ordinary failures use bounded backoff.
  if (generationAtStart !== state.generation) {
    runActiveCandleRepair(cacheKey, state);
  } else {
    scheduleActiveCandleRepair(cacheKey, state);
  }
}

function requestActiveCandleRecovery(coin, timeframe, repairFromTime = 0) {
  const cacheKey = `${coin}:${timeframe}`;
  let state = activeCandleRepairs.get(cacheKey);
  if (state) {
    state.repairFromTime = state.repairFromTime > 0
      ? Math.min(state.repairFromTime, repairFromTime || state.repairFromTime)
      : repairFromTime;
    state.generation += 1;
    return;
  }
  state = {
    coin,
    timeframe,
    repairFromTime,
    attempts: 0,
    generation: 1,
    inFlight: false,
    timer: null,
    startedAt: Date.now(),
  };
  activeCandleRepairs.set(cacheKey, state);
  AppState.market.candleIntegrity.detectedGaps += 1;
  runActiveCandleRepair(cacheKey, state);
}

function syncActiveTradeState(coin = AppState.trading.currentCoin, { requireCurrentEpoch = false } = {}) {
  ensureCoinTradeBuckets(AppState.market, coin);
  const useCachedFlow = !requireCurrentEpoch || isFlowSnapshotEligible(AppState.market, coin, {
    acceptedTradeCoins: AppState.connection.acceptedTradeCoins,
    marketEpoch: AppState.connection.marketEpoch,
    marketState: AppState.connection.marketState,
  });
  syncActiveTradeStateSnapshot(AppState.market, coin, { useCachedFlow });
}


function extractTradeCoin(message, data) {
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (first?.coin) return first.coin;
    if (first?.s) return first.s;
  }
  if (message?.coin) return message.coin;
  if (message?.data?.coin) return message.data.coin;
  if (message?.subscription?.coin) return message.subscription.coin;
  return '';
}

function applyBookSnapshot(book) {
  setMarketBookSnapshot(book);
}

function handleBook(data) {
  if (!data || !data.levels) return;
  const messageCoin = data.coin || '';
  const nextBook = buildNormalizedBook(data.levels, { limit: 50 });
  if (!nextBook) return;

  // Cache for every subscribed coin (active or background) so switching back
  // to a coin restores its book instantly instead of showing "Waiting for
  // book..." until the next live tick (mirrors ingestTrades).
  ingestBook(AppState.market, messageCoin || AppState.trading.currentCoin, nextBook);

  if (messageCoin && messageCoin !== AppState.trading.currentCoin) return;

  const coinSnapshot = AppState.trading.currentCoin;

  incrementBookVersion();
  applyBookSnapshot(nextBook);

  const bestBid = AppState.market.book.bids[0]?.px || 0;
  const bestAsk = AppState.market.book.asks[0]?.px || 0;
  if (coinSnapshot === AppState.trading.currentCoin && bestBid > 0 && bestAsk > 0) {
    const mid = (bestBid + bestAsk) / 2;
    // Watchdog: book is ticking (preview lines are re-syncing) so the live line
    // should be moving too. If the entry is stale, drop it first so applyCurrentPrice
    // below recreates it on the current series instead of applying to an orphan.
    maybeInvalidateStaleLivePriceLine(LIVE_PRICE_LINE_MAX_AGE_MS);
    applyCurrentPrice(coinSnapshot, mid);
  }

  updatePriceFromL2();
  
  if (coinSnapshot !== AppState.trading.currentCoin) return;
  scheduleOrderbookRender();

  noteDomBookCoin(coinSnapshot);
  scheduleLiveDomLadderRender();

  refreshLimitPreviewTracking();

}

function handleTrades(data, messageCoin = '', annotations = {}) {
  try {
    if (!data || !Array.isArray(data)) return;
    const tradeCoin = messageCoin || extractTradeCoin(null, data) || AppState.trading.currentCoin;
    if (!tradeCoin) return;
    // Apply protocol metadata before normalization so this batch's dot/major
    // classification uses the same backend thresholds that produced _flow.
    const appliedFlow = applyFlowSnapshot(AppState.market, tradeCoin, annotations.flow, {
      marketEpoch: AppState.connection.marketEpoch,
    });
    // One parse + one dedupe for the whole batch; every cache consumes the
    // normalized entries (a resent batch normalizes to []).
    const normalized = normalizeTradeBatch(AppState.market, tradeCoin, data);
    ingestTrades(AppState.market, tradeCoin, normalized);
    ingestDomTrades(AppState.market, tradeCoin, normalized);
    ingestWhaleResponses(AppState.market, tradeCoin, normalized);
    // Backend flow is cached per coin (every streamed coin feeds the scanner).

    if (tradeCoin === AppState.trading.currentCoin) {
      // A just-applied `_flow` is current-socket state. A missing or rejected
      // annotation must not copy an ineligible leftover cache onto the HUD.
      if (appliedFlow) {
        syncActiveTradeStateSnapshot(AppState.market, tradeCoin, { useCachedFlow: true });
      } else {
        syncActiveTradeState(tradeCoin, { requireCurrentEpoch: true });
      }

      const lastTrade = normalized[normalized.length - 1];
      if (lastTrade && Number.isFinite(lastTrade.px)) {
        const book = AppState.market.book;
        const bestBid = book?.bids?.[0]?.px || 0;
        const bestAsk = book?.asks?.[0]?.px || 0;
        if (bestBid > 0 && bestAsk > 0 && (lastTrade.px > bestAsk || lastTrade.px < bestBid)) {
          applyCurrentPrice(tradeCoin, lastTrade.px);
        }
      }
    }

    scheduleLegacyBotTradeUpdate(normalized);

    scheduleActiveTradePanelsRender(tradeCoin);
    // Watchlist Flow column tracks per-coin buy share from the same stream.
    scheduleWatchlistMetricsRender();
    // Market News is news-stream/poll owned (news-service). Do not re-render
    // the news panel from trade ticks — it only burns main-thread for ages.
  } catch(e) {
    console.error('Handle trades error:', e);
  }
}

// handleMarketLiquidations ingests the backend market-wide liquidation feed
// (channel `liquidations`, global across coins). The backend streams Bybit
// (+ QuickNode when configured) and broadcasts the normalized result here —
// buffer it and repaint the LIQS panel.
function handleMarketLiquidations(data) {
  try {
    if (!Array.isArray(data) || !data.length) return;
    ingestMarketLiquidations(AppState.market, data);
    scheduleLiquidationsRender();
  } catch (e) {
    console.error('Handle market liquidations error:', e);
  }
}

function handleCandle(data) {
  if (!data) return;

  const c = Array.isArray(data) ? data[0] : (data.candle || data);
  if (!c) return;

  const messageCoin = c.s || data.coin;
  const messageInterval = c.i || data.interval;
  if (messageCoin && messageCoin !== AppState.trading.currentCoin) return;

  if (!isValidExchangeCandle(c)) {
    AppState.market.candleIntegrity.validationFailures += 1;
    const existing = Array.isArray(AppState.market.candles) ? AppState.market.candles : [];
    requestActiveCandleRecovery(
      AppState.trading.currentCoin,
      messageInterval || AppState.trading.currentTimeframe,
      normalizeCandleTime(existing[existing.length - 1]?.t),
    );
    return;
  }

  if (messageInterval) {
    const cacheKey = `${AppState.trading.currentCoin}:${messageInterval}`;
    const cached = candleCache.get(cacheKey);
    if (Array.isArray(cached)) {
      const merged = mergeCandle({ existing: cached, incoming: c });
      setCandleCacheEntry(cacheKey, merged);
    }
    const rvwapStatus = AppState.market.rvwapSource || {};
    if (
      messageInterval === '4h'
      && rvwapStatus.coin === AppState.trading.currentCoin
      && (rvwapStatus.status === 'loading' || rvwapStatus.status === 'ready')
    ) {
      const sourceMerged = mergeCandle({
        existing: rvwapSourceCache.get(AppState.trading.currentCoin) || [],
        incoming: c,
      });
      if (rvwapStatus.status === 'ready') {
        const nextStatus = {
          ...rvwapStatus,
          count: sourceMerged.length,
          firstTime: normalizeCandleTime(sourceMerged[0]?.t) * 1000,
          lastTime: normalizeCandleTime(sourceMerged[sourceMerged.length - 1]?.t) * 1000,
        };
        setRvwapSourceCacheEntry(AppState.trading.currentCoin, sourceMerged, nextStatus);
        AppState.market.rvwapSource = nextStatus;
        bufferLiveRvwapSource({ coin: AppState.trading.currentCoin, candles: sourceMerged });
      } else {
        // Stage the tick while the deep snapshot is in flight. commitRvwapSource
        // merges these rows after REST resolves so a late snapshot cannot roll
        // the current 4h bucket backward or discard a newly opened bucket.
        setRvwapSourceCacheEntry(AppState.trading.currentCoin, sourceMerged);
      }
    }
  }

  if (messageInterval && messageInterval !== AppState.trading.currentTimeframe) return;

  const existingCandles = Array.isArray(AppState.market.candles) ? AppState.market.candles : [];
  if (shouldRecoverActiveCandleGap({
    candle: c,
    timeframe: AppState.trading.currentTimeframe,
    existingCandles,
  })) {
    requestActiveCandleRecovery(
      AppState.trading.currentCoin,
      AppState.trading.currentTimeframe,
      normalizeCandleTime(existingCandles[existingCandles.length - 1]?.t),
    );
  }

  const nextCandles = mergeCandle({ existing: existingCandles, incoming: c });
  setMarketCandles(nextCandles);
  // Re-evaluate completed fallback rows on every bucket transition. The
  // service import stays dynamic (and bound once) to avoid a market-service ↔
  // market-ws module cycle; subsequent candles reuse the bound helper.
  queueActiveCvdRefresh(
    AppState.trading.currentCoin,
    AppState.trading.currentTimeframe,
    nextCandles,
  );
  if (nextCandles.length > 0) {
    completeChartSession({
      coin: AppState.trading.currentCoin,
      timeframe: AppState.trading.currentTimeframe,
    });
  }

  // Drive the chart with the canonical merged exchange payload. Mid/mark is a
  // separate live price line and never mutates Hyperliquid OHLC.
  const mergedCandle = nextCandles.length > 0 ? nextCandles[nextCandles.length - 1] : c;
  bufferLiveChartCandle({
    candle: mergedCandle,
    candles: nextCandles,
    timeframe: AppState.trading.currentTimeframe,
  });
  // Re-apply the same price to both the native live line and the display-only
  // forming candle after the authoritative update has reconciled the series.
  const lastClose = parseFloat(c.c);
  if (lastClose) {
    applyCurrentPrice(AppState.trading.currentCoin, lastClose);
  }

  refreshLimitPreviewTracking();
  // Candle ticks do not change Market News content; skip radar schedule.
}

function handleMids(data) {
  if (!data || !data.mids) return;

  const snapshot = data.snapshot === true;
  if (!snapshot) {
    noteMarketTick();
    setMarketUpstreamConnected(true);
  }
  Object.assign(AppState.market.allMids, data.mids);
  if (!AppState.market.lastPriceUpdateAt) AppState.market.lastPriceUpdateAt = {};
  const now = Date.now();
  if (!snapshot) {
    Object.keys(data.mids).forEach((coin) => {
      const mid = parseFloat(data.mids[coin]);
      if (Number.isFinite(mid) && mid > 0) {
        AppState.market.lastPriceUpdateAt[coin] = now;
      }
    });
  }
  sampleWhaleResponses(AppState.market, AppState.market.allMids, AppState.market.lastPriceUpdateAt, now);
  if (AppState.market.stockMispricing?.length) {
    scheduleMispricingRender();
  }
  // Keep open-watchlist price cells live with the mid stream.
  scheduleWatchlistMetricsRender();

  const currentCoin = AppState.trading.currentCoin;
  if (data.mids[currentCoin]) {
    const price = parseFloat(data.mids[currentCoin]);
    applyCurrentPrice(currentCoin, price);
    refreshLimitPreviewTracking();
    scheduleLiveDomLadderRender();
  } else {
    // If current coin doesn't have a mid price, use L2 book (matches backup)
    updatePriceFromL2({
      onSummaryUpdate: updateSummary,
      onRefreshLimitPreviewTracking: refreshLimitPreviewTracking,
    });
  }

  updateChartTitle(currentCoin);
  // Mids are high-frequency. Market News only needs news/poll/coin-switch
  // updates — not a re-collect of the tape on every mid batch.
}

function resetMarketSubscriptions() {
  abortInFlightSubscribe();
  marketSubscriptionGeneration++;
  marketSubscriptionController.reset();
}

// Starts a new downstream market-socket epoch. Per-coin cache values are kept
// for efficient rehydration, but none can be displayed as proven current until
// this epoch accepts and snapshots the coin.
function beginMarketStreamEpoch() {
  AppState.connection.marketEpoch = Math.max(0, Number(AppState.connection.marketEpoch) || 0) + 1;
  AppState.connection.acceptedTradeCoins = [];
  AppState.connection.droppedTradeCoins = [];
  resetMarketSubscriptions();
  cancelPendingRenders();
  const activeCoin = AppState.trading.currentCoin;
  if (activeCoin) {
    syncActiveTradeState(activeCoin, { requireCurrentEpoch: true });
    scheduleActiveTradePanelsRender(activeCoin);
  }
  return AppState.connection.marketEpoch;
}

async function subscribeMarket(coin, interval, tradeCoins) {
  // When coin is omitted, reuse stored intent (reconnect / background refresh).
  // When coin is provided without tradeCoins, rebuild the warm set from
  // active+watchlist+recent — never treat a missing list as "active only".
  // (Defaulting tradeCoins to [] was a footgun that collapsed background books.)
  // Non-string first args (e.g. an overrides object) must not stringify to
  // "[object Object]" and replace the active coin.
  const desiredSubscription = typeof coin !== 'string'
    ? getDesiredMarketSubscription()
    : setDesiredMarketSubscription(
      tradeCoins === undefined
        ? { coin, interval }
        : { coin, interval, tradeCoins },
    );
  const clientId = getStreamClientId();
  const normalizedTradeCoins = Array.from(desiredSubscription.tradeCoins || []).filter(Boolean);
  const normalizedIndicatorIntervals = Array.from(desiredSubscription.indicatorIntervals || []).filter(Boolean);
  const activeCoin = desiredSubscription.coin || '';
  const activeInterval = desiredSubscription.interval || '';

  if (!activeCoin || !activeInterval) return false;

  const subscriptionKey = marketSubscriptionController.buildSubscriptionKey({
    clientId,
    coin: activeCoin,
    interval: activeInterval,
    tradeCoins: normalizedTradeCoins,
    indicatorIntervals: normalizedIndicatorIntervals,
  });

  if (!marketSubscriptionController.shouldSubscribe(subscriptionKey)) return;
  abortInFlightSubscribe();
  marketSubscriptionController.begin(subscriptionKey);
  const requestGeneration = ++marketSubscriptionGeneration;
  const requestEpoch = Math.max(0, Number(AppState.connection.marketEpoch) || 0);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  subscribeAbort = controller;

  try {
    const result = await postMarketSubscription({
      payload: {
        clientId,
        coin: activeCoin,
        interval: activeInterval,
        tradeCoins: normalizedTradeCoins,
        indicatorIntervals: normalizedIndicatorIntervals,
      },
      retryDelaysMs: MARKET_SUBSCRIBE_RETRY_DELAYS_MS,
      resolveApiUrl,
      recordApiResult,
      sleep,
      signal: controller?.signal,
    });
    if (requestGeneration !== marketSubscriptionGeneration
      || requestEpoch !== Math.max(0, Number(AppState.connection.marketEpoch) || 0)) {
      return false;
    }
    const accepted = Array.isArray(result?.acceptedTradeCoins)
      ? result.acceptedTradeCoins.filter(Boolean)
      : normalizedTradeCoins;
    const dropped = Array.isArray(result?.droppedTradeCoins)
      ? result.droppedTradeCoins.filter(Boolean)
      : [];
    AppState.connection.acceptedTradeCoins = accepted;
    AppState.connection.droppedTradeCoins = dropped;
    Object.entries(result?.flowSnapshots || {}).forEach(([snapshotCoin, flow]) => {
      if (snapshotCoin && flow) applyFlowSnapshot(AppState.market, snapshotCoin, flow, {
        marketEpoch: requestEpoch,
      });
    });
    if (activeCoin === AppState.trading.currentCoin) {
      syncActiveTradeState(activeCoin, { requireCurrentEpoch: true });
      scheduleActiveTradePanelsRender(activeCoin);
    }
    marketSubscriptionController.commit(subscriptionKey);
    if (subscribeAbort === controller) subscribeAbort = null;
    return result;
  } catch (e) {
    if (subscribeAbort === controller) subscribeAbort = null;
    if (requestGeneration !== marketSubscriptionGeneration || e?.name === 'AbortError') return false;
    marketSubscriptionController.fail(subscriptionKey);
    console.warn('[market] subscribeMarket error:', e);
    return false;
  }
}

export {
  cancelPendingRenders,
  scheduleOrderbookRender,
  syncActiveTradeState,
  handleBook,
  handleTrades,
  handleMarketLiquidations,
  handleCandle,
  handleMids,
  updatePriceFromL2,
  subscribeMarket,
  resetMarketSubscriptions,
  beginMarketStreamEpoch,
  recoverActiveCandlesIfStale,
  recoverActiveCandlesAfterReconnect,
};
