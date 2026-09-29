/**
 * Chart candle fetch, cache integrity, CVD self-heal, history extend, prefetch, L2.
 * Backend remains authoritative for residency and CVD enrichment at serve time.
 * Prefer market-session for UI intent.
 */

import {
  AppState,
  candleCache,
  setCandleCacheEntry,
  setExchangeLeverage,
} from '../state/store.js';
import { completeChartSession, setChartSessionNotice } from '../state/chart-session.js';
import {
  buildNormalizedBook,
  findAssetCtx,
  isActiveMarketSelection,
  setMarketBookSnapshot,
  setMarketCandles,
  setMarketPrice,
} from '../state/market-state.js';
import { getActiveCandleRequestToken } from '../state/trading-runtime.js';
import { hlPost, fetchWithDedup, apiPost, isAbortError, isCanceledRequestError } from './api.js';
import { getAllMids, getCandles } from '../state/market-selectors.js';
import { getCurrentCoin, getCurrentTimeframe } from '../state/trading-selectors.js';
import { mergeCandleSeries, normalizeCandleSeries } from '../state/market-candles.js';
import { fetchChartCandles as requestChartCandles } from './chart-data.js';
import { getDex, isBuilderPerpCoin } from '../utils/helpers.js';
import { showToast } from '../ui/toast.js';
import {
  hasEnabledRvwap,
  scheduleActiveRvwapHydration,
} from './rvwap-source-service.js';
import {
  CVD_WEEK_LOOKBACK_MS,
  TIMEFRAME_MS,
  candleTimeMs,
  getInitialHistoryLookbackMs,
  hasEnoughCachedHistory,
} from '../chart/chart-history-requirements.js';

// Keep this module free of ui/market-ui and render/dom-ladder top-level imports
// (those pull tabs → chart-render → chart-candle and create a TDZ cycle).

async function applyCandles(candles, coin, timeframe) {
  if (!Array.isArray(candles) || !candles.length) return;
  if (!isActiveMarketSelection(coin, timeframe)) return;
  setMarketCandles(candles, { snapshot: true });
  completeChartSession({ coin, timeframe });
  const { initChart, updateChart } = await import('../chart/chart-render.js');
  const hasChartCanvas = typeof document !== 'undefined' && !!document.getElementById('chartCanvas');
  if (!hasChartCanvas) initChart();
  else updateChart();
}

function applyResolvedPrice(coin, price) {
  if (!coin || !Number.isFinite(price) || price <= 0) return;
  setMarketPrice(coin, price);
  Promise.resolve(import('../ui/topbar.js')).then((mod) => {
    mod.syncPriceConsumers?.(coin, price, { refreshTopBar: coin === AppState.trading.currentCoin });
  }).catch(() => {});
}

function applyExchangeLeverage(coin, leverage) {
  if (!Number.isFinite(leverage) || leverage <= 0) return;
  setExchangeLeverage(coin, leverage);
  Promise.resolve(import('../ui/market-display.js')).then((mod) => {
    mod.syncLeverageControls?.(leverage);
  }).catch(() => {});
  Promise.resolve(import('../ui/account-ui.js')).then((mod) => {
    mod.updateSizeSliderMax?.();
  }).catch(() => {});
}

function applyBookSnapshot(book) {
  if (!book) return;
  setMarketBookSnapshot(book);
  Promise.resolve(import('../streams/market-ws.js')).then((mod) => {
    mod.scheduleOrderbookRender?.();
  }).catch(() => {});
}

const candleFailureCooldownUntil = new Map();
const CANDLE_THROTTLE_COOLDOWN_MS = 10000;
const ACTIVE_CHART_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000];
// Pending self-heal retries for charts that throttled to a blank state, keyed by
// coin:timeframe so we never stack more than one timer per series.
const activeChartRetryTimers = new Map();

// One AbortController per active-chart selection. A new foreground coin/timeframe
// switch (new requestToken) aborts the previous selection's in-flight loads —
// chart fetch + background enrichment — so rapid navigation cancels superseded
// requests instead of running them to completion (which would still spend HL's
// per-IP budget). The backend ties the upstream HL fetch to the request, so the
// abort propagates all the way through.
let activeChartController = null;
let activeChartToken = null;
function activeChartSignal(requestToken) {
  if (requestToken === undefined) return undefined;
  if (!activeChartController || requestToken !== activeChartToken) {
    if (activeChartController) activeChartController.abort();
    activeChartController = new AbortController();
    activeChartToken = requestToken;
  }
  return activeChartController.signal;
}
const timeframeMs = TIMEFRAME_MS;
// Client series whose older-history walk returned a successful empty chunk.
// Distinct from a transport failure: those stay retryable. Exhausted keys
// still serve from cache so 1m/30m (HL retention < declared window) and
// newly listed markets are not re-fetched on every switch.
const exhaustedHistoryKeys = new Set();

function markHistoryExhausted(cacheKey) {
  if (cacheKey) exhaustedHistoryKeys.add(cacheKey);
}

function clearHistoryExhausted(cacheKey) {
  if (cacheKey) exhaustedHistoryKeys.delete(cacheKey);
}

// Timeframes the server enriches with a composite cvdDelta (the candle store's
// DefaultSeries chart intervals). Candles fetched while the server's CVD
// sources were still cold/verifying — or a since-healed sleep/wake gap bucket
// whose server-side enrichment predates the healing — carry no cvdDelta. The
// client renders the honest per-bar directional fallback for those bars, and
// because CVD is a running cumulative sum (cvd.js), one orphaned nil bar
// becomes a permanent level-shift in every later bar until the next anchor
// reset — the cache fast-path below would otherwise pin that shift for the
// whole session. When any completed bar within the CVD-relevant lookback
// (CVD_WEEK_LOOKBACK_MS covers the default weekly 1W-MON00 anchor with one day
// of margin) lacks cvdDelta on an enrichable timeframe, bypass the cache
// so a refetch upgrades the series once the store has verified/healed its
// sources. The active chart drives a bounded backoff loop; ordinary calls also
// retain the CVD_REFRESH_RETRY_MS cooldown. If the server still can't enrich,
// the fallback stays honest while a later attempt checks again.
// Bars older than the window are left alone — CVD has long since anchor-reset
// past them, so healing them wouldn't change what's on screen, and retrying
// forever on a permanently-uncoverable ancient bar would be pointless cost.
const CVD_ENRICHED_TIMEFRAMES = new Set(['5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d']);
const CVD_REFRESH_RETRY_MS = 30 * 1000;
const CVD_REFRESH_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
const CVD_REFRESH_MAX_ATTEMPTS = 8;
const cvdRefreshLastAttempt = new Map();
const activeCvdRefreshTimers = new Map();
const activeCvdRefreshAttempts = new Map();

function cachedCvdMissing(candles, timeframe, now = Date.now()) {
  if (!CVD_ENRICHED_TIMEFRAMES.has(timeframe)) return false;
  if (!Array.isArray(candles) || candles.length === 0) return false;
  const intervalMs = timeframeMs[timeframe] || 0;
  if (!(intervalMs > 0)) return false;
  const cutoff = now - CVD_WEEK_LOOKBACK_MS;
  // Thin markets may not have a candle in the current bucket, so the final
  // array element is not necessarily live. Exempt rows by their actual bucket
  // close, not by position, or a completed SKHX tail can pin fallback CVD for
  // hours until another trade creates a candle.
  return candles.some((c) => {
    const openMs = candleTimeMs(c);
    return c?.cvdDelta == null
      && openMs >= cutoff
      && openMs + intervalMs <= now;
  });
}

function mergeAuthoritativeCandles(cachedCandles, authoritativeCandles) {
  const trustedDeltaByTime = new Map();
  for (const candle of Array.isArray(cachedCandles) ? cachedCandles : []) {
    if (candle?.cvdDelta == null) continue;
    const time = candleTimeMs(candle);
    if (time > 0) trustedDeltaByTime.set(time, candle.cvdDelta);
  }
  const withTrustedDeltas = (Array.isArray(authoritativeCandles) ? authoritativeCandles : []).map((candle) => {
    if (candle?.cvdDelta != null) return candle;
    const previousDelta = trustedDeltaByTime.get(candleTimeMs(candle));
    return previousDelta == null ? candle : { ...candle, cvdDelta: previousDelta };
  });
  // Authoritative OHLCV still wins every timestamp conflict. A previously
  // verified derived delta is retained only while the server temporarily
  // withholds enrichment because its source is reconnecting/verifying; the
  // next enriched snapshot replaces it normally (including a real zero).
  return mergeHistoricalCandles(cachedCandles, withTrustedDeltas);
}

function clearActiveCvdRefresh(cacheKey, { resetAttempts = true } = {}) {
  const timer = activeCvdRefreshTimers.get(cacheKey);
  if (timer) clearTimeout(timer);
  activeCvdRefreshTimers.delete(cacheKey);
  if (resetAttempts) activeCvdRefreshAttempts.delete(cacheKey);
}

function pruneInactiveCvdRefreshes(activeCacheKey) {
  for (const key of activeCvdRefreshTimers.keys()) {
    if (key !== activeCacheKey) clearActiveCvdRefresh(key);
  }
  for (const key of activeCvdRefreshAttempts.keys()) {
    if (key !== activeCacheKey) activeCvdRefreshAttempts.delete(key);
  }
}

function syncActiveCvdRefresh(coin, timeframe, candles = candleCache.get(`${coin}:${timeframe}`)) {
  const cacheKey = `${coin}:${timeframe}`;
  if (!isActiveMarketSelection(coin, timeframe) || !cachedCvdMissing(candles, timeframe)) {
    clearActiveCvdRefresh(cacheKey);
    return false;
  }
  if (activeCvdRefreshTimers.has(cacheKey)) return true;
  const attempts = activeCvdRefreshAttempts.get(cacheKey) || 0;
  if (attempts >= CVD_REFRESH_MAX_ATTEMPTS) return false;
  const delay = CVD_REFRESH_RETRY_DELAYS_MS[Math.min(attempts, CVD_REFRESH_RETRY_DELAYS_MS.length - 1)];
  const timer = setTimeout(async () => {
    activeCvdRefreshTimers.delete(cacheKey);
    if (!isActiveMarketSelection(coin, timeframe)) {
      clearActiveCvdRefresh(cacheKey);
      return;
    }
    const latest = candleCache.get(cacheKey);
    if (!cachedCvdMissing(latest, timeframe)) {
      clearActiveCvdRefresh(cacheKey);
      return;
    }
    activeCvdRefreshAttempts.set(cacheKey, attempts + 1);
    try {
      // forceAuthoritative bypasses the span/tail cache hit so this heal can
      // actually pull composite cvdDelta once sources warm. Plain re-entry
      // would paint the same unenriched cache forever.
      await fetchCandles({
        coin,
        timeframe,
        requestToken: getActiveCandleRequestToken(),
        forceAuthoritative: true,
      });
    } catch (_e) {
      // fetchCandles owns notices/logging. Keep the bounded self-heal loop live.
    }
    if (isActiveMarketSelection(coin, timeframe)) {
      syncActiveCvdRefresh(coin, timeframe);
    } else {
      clearActiveCvdRefresh(cacheKey);
    }
  }, delay);
  if (typeof timer?.unref === 'function') timer.unref();
  activeCvdRefreshTimers.set(cacheKey, timer);
  return true;
}

// Called by the live-candle path as well as snapshot loads. A candle that was
// legitimately the open tail at load time can later become a completed,
// still-unenriched historical row when the next bucket arrives; re-evaluate at
// that boundary so it cannot wait for a manual chart fetch.
function ensureActiveCvdRefresh(coin = getCurrentCoin(), timeframe = getCurrentTimeframe(), candles = getCandles()) {
  return syncActiveCvdRefresh(coin, timeframe, candles);
}

// hasEnoughCachedHistory measures span only (Math.max(last, now) masks a stale
// tail), so a cache that stopped updating still passes it. Gap recovery and
// resume backfills rely on this tail check to actually reach REST.
function hasFreshCandleTail(candles, timeframe, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length === 0) return false;
  const last = candleTimeMs(candles[candles.length - 1]);
  if (!(last > 0)) return false;
  const intervalMs = timeframeMs[timeframe] || 0;
  const maxTailAgeMs = Math.max(2.5 * intervalMs, 90 * 1000);
  return now - last <= maxTailAgeMs;
}

function mergeHistoricalCandles(olderCandles, currentCandles) {
  return mergeCandleSeries(olderCandles, currentCandles);
}

async function extendCandlesToLookback({ coin, timeframe, candles, requiredLookbackMs, now, background = false, signal, cacheKey }) {
  let merged = Array.isArray(candles) ? candles : [];
  const key = cacheKey || `${coin}:${timeframe}`;
  let guard = 0;
  while (
    merged.length > 0
    && !hasEnoughCachedHistory(merged, requiredLookbackMs, now)
    && guard < 8
  ) {
    const oldestTime = candleTimeMs(merged[0]);
    if (!(oldestTime > 0)) break;
    const olderCandles = await fetchHistoricalCandles({
      coin,
      timeframe,
      endTime: oldestTime - 1,
      limit: 1500,
      background, // a scanner's deep-history backfill stays gated; foreground active-chart backfill does not
      signal,
    });
    if (!Array.isArray(olderCandles)) break;
    const uniqueOlder = olderCandles.filter((candle) => {
      const t = candleTimeMs(candle);
      return t > 0 && t < oldestTime;
    });
    if (!uniqueOlder.length) {
      markHistoryExhausted(key);
      break;
    }
    clearHistoryExhausted(key);
    merged = mergeHistoricalCandles(uniqueOlder, merged);
    guard += 1;
  }
  if (hasEnoughCachedHistory(merged, requiredLookbackMs, now)) {
    clearHistoryExhausted(key);
  }
  return merged;
}

// enrichActiveChart fills the active chart's CVD-source candles and deep-history
// backfill in the BACKGROUND (concurrency-gated, non-blocking) AFTER the chart
// has already painted from the initial fetch. This keeps each foreground
// coin/timeframe switch to a single upstream request, so rapid navigation can't
// burst Hyperliquid's per-IP limit. It drops out if the user switched away.
async function enrichActiveChart({ coin, timeframe, base, requiredLookbackMs, now, isHip3, requestToken, cacheKey, signal }) {
  const stale = () => (requestToken !== undefined && getActiveCandleRequestToken() !== requestToken) || signal?.aborted;
  if (stale()) return; // user already switched away — don't spend requests enriching it
  let extended = base;
  try {
    extended = await extendCandlesToLookback({
      coin,
      timeframe,
      candles: base,
      requiredLookbackMs,
      now,
      background: true,
      signal,
      cacheKey,
    });
  } catch (_e) {
    return;
  }
  if (stale()) return;
  if (Array.isArray(extended) && extended.length > base.length) {
    setCandleCacheEntry(cacheKey, extended);
    await applyCandles(extended, coin, timeframe);
  }
}

function isUpstreamThrottleError(error) {
  const message = String(error?.rawMessage || error?.message || '');
  const status = Number(error?.status || 0);
  // Include 504 / deadline-exceeded: cold builder-dex passthroughs can time
  // out under load; the active-chart retry loop should self-heal those too.
  return status === 429 || status === 502 || status === 504
    || /429|502|504|upstream http 429|deadline exceeded|timeout|bad gateway|rate limit|failed to fetch|network_io_suspended|networkerror|load failed/i.test(message);
}

// A chart that throttled to blank retries on the visible lane after 1s, then
// backs off to 2s/5s/10s. One timer per series; a success or selection change
// cancels the loop.
function scheduleActiveChartRetry(coin, timeframe) {
  const cacheKey = coin + ':' + timeframe;
  if (activeChartRetryTimers.has(cacheKey)) return;
  const state = { attempts: 0, timer: null };
  activeChartRetryTimers.set(cacheKey, state);
  const run = async () => {
    state.timer = null;
    if (!isActiveMarketSelection(coin, timeframe) || (getCandles() || []).length > 0) {
      activeChartRetryTimers.delete(cacheKey);
      return;
    }
    state.attempts += 1;
    const result = await fetchCandles({
      coin,
      timeframe,
      requestToken: getActiveCandleRequestToken(),
      forceAuthoritative: true,
    }).catch(() => null);
    if (!isActiveMarketSelection(coin, timeframe) || (Array.isArray(result) && result.length > 0)) {
      activeChartRetryTimers.delete(cacheKey);
      return;
    }
    const delayIndex = Math.min(state.attempts, ACTIVE_CHART_RETRY_DELAYS_MS.length - 1);
    state.timer = setTimeout(run, ACTIVE_CHART_RETRY_DELAYS_MS[delayIndex]);
    if (typeof state.timer?.unref === 'function') state.timer.unref();
  };
  state.timer = setTimeout(run, ACTIVE_CHART_RETRY_DELAYS_MS[0]);
  if (typeof state.timer?.unref === 'function') state.timer.unref();
}

function fetchChartCandles(body, { background = false, signal } = {}) {
  const req = body?.req || {};
  return requestChartCandles({
    coin: req.coin,
    interval: req.interval,
    startTime: req.startTime,
    endTime: req.endTime,
    dex: req.dex || '',
    urgency: background ? 'prefetch' : 'visible',
    background,
    signal,
  });
}

async function fetchCandles(options = {}) {
  const currentCoin = options.coin || getCurrentCoin();
  const currentTimeframe = options.timeframe || getCurrentTimeframe();
  const requestToken = options.requestToken;
  const background = options.background === true;
  const forceAuthoritative = options.forceAuthoritative === true;
  const repairFromTime = Number(options.repairFromTime || 0);
  const cacheKey = currentCoin + ':' + currentTimeframe;
  const now = Date.now();
  const isStaleRequest = () => requestToken !== undefined && getActiveCandleRequestToken() !== requestToken;
  const isActiveRequest = !background && isActiveMarketSelection(currentCoin, currentTimeframe);
  if (isActiveRequest) {
    pruneInactiveCvdRefreshes(cacheKey);
    // RVWAP owns a separate 4h/600-day dependency. Start it alongside the
    // visible chart request so a coin switch does not serialize two histories.
    if (hasEnabledRvwap()) scheduleActiveRvwapHydration(currentCoin);
  }
  // Cancellation signal for the active selection: a newer switch aborts this one.
  const signal = isActiveRequest ? activeChartSignal(requestToken) : undefined;
  const throttleCooldownUntil = candleFailureCooldownUntil.get(cacheKey) || 0;
  const setActiveChartNotice = (message) => {
    if (!isActiveRequest || isStaleRequest()) return;
    if ((getCandles() || []).length > 0) return;
    setChartSessionNotice(message, {
      coin: currentCoin,
      timeframe: currentTimeframe,
      requestToken,
    });
  };

  const requiredLookbackMs = getInitialHistoryLookbackMs(currentTimeframe);
  const cachedCandles = candleCache.get(cacheKey);
  const cacheSpanFresh = (
    hasEnoughCachedHistory(cachedCandles, requiredLookbackMs, now)
    || exhaustedHistoryKeys.has(cacheKey)
  )
    && hasFreshCandleTail(cachedCandles, currentTimeframe, now);
  const wantsCvdRefresh = cachedCvdMissing(cachedCandles, currentTimeframe, now)
    && now - (cvdRefreshLastAttempt.get(cacheKey) || 0) >= CVD_REFRESH_RETRY_MS;
  // Active charts always paint a span+tail-fresh cache immediately. Missing
  // cvdDelta used to force a foreground REST bypass on every re-switch, which
  // made coin/timeframe flips feel cold even after the series was already
  // loaded. CVD upgrades stay on the background self-heal path.
  if (!forceAuthoritative && cacheSpanFresh && isActiveRequest) {
    if (isStaleRequest()) return null;
    // Pair/TF switching installs this exact cache array before transport work.
    // Reapplying it as a new snapshot increments every overlay revision.
    if (getCandles() !== cachedCandles) {
      await applyCandles(cachedCandles, currentCoin, currentTimeframe);
    }
    if (wantsCvdRefresh) cvdRefreshLastAttempt.set(cacheKey, now);
    syncActiveCvdRefresh(currentCoin, currentTimeframe, cachedCandles);

    if (!getAllMids()[currentCoin] && cachedCandles.length > 0) {
      const lastClose = parseFloat(cachedCandles[cachedCandles.length - 1].c);
      if (lastClose) {
        if (currentCoin === getCurrentCoin()) {
          applyResolvedPrice(currentCoin, lastClose);
        } else {
          AppState.market.allMids[currentCoin] = lastClose.toString();
        }
      }
    }
    scheduleActiveRvwapHydration(currentCoin);
    return cachedCandles;
  }
  // Background/prefetch: keep the old CVD-upgrade bypass so idle neighbours
  // still heal enrichment without a user re-click.
  if (
    !forceAuthoritative
    && cacheSpanFresh
    && !wantsCvdRefresh
  ) {
    if (isStaleRequest()) return null;
    if (!getAllMids()[currentCoin] && cachedCandles.length > 0) {
      const lastClose = parseFloat(cachedCandles[cachedCandles.length - 1].c);
      if (lastClose) {
        AppState.market.allMids[currentCoin] = lastClose.toString();
      }
    }
    return cachedCandles;
  }
  if (wantsCvdRefresh) {
    cvdRefreshLastAttempt.set(cacheKey, now);
  }

  if (!forceAuthoritative && throttleCooldownUntil > Date.now()) {
    if (isActiveRequest && Array.isArray(getCandles()) && getCandles().length > 0) {
      syncActiveCvdRefresh(currentCoin, currentTimeframe, getCandles());
      return getCandles();
    }
    setActiveChartNotice('Chart temporarily unavailable');
    return null;
  }

  // Any well-formed <dex>:<symbol> builder perp needs the dex field on candle
  // reads (not only the legacy xyz: HIP-3 prefix).
  const isBuilder = isBuilderPerpCoin(currentCoin);
  const isHip3 = isBuilder; // retained name for enrichActiveChart callers

  if (isBuilder && !getAllMids()[currentCoin]) {
    try {
      const dex = getDex(currentCoin);
      const dedupKey = `builderMeta:${dex}`;
      const meta = await fetchWithDedup(dedupKey, () => hlPost({ type: 'metaAndAssetCtxs', dex: dex }));
      const ctx = findAssetCtx(meta, currentCoin);
      const markPx = parseFloat(ctx?.markPx || 0);
      if (markPx) {
        applyResolvedPrice(currentCoin, markPx);
      }
    } catch(e) {
      console.error('builder meta fetch failed:', e);
    }
  }

  const startTime = now - requiredLookbackMs;
  const body = {
    type: 'candleSnapshot',
    req: { coin: currentCoin, interval: currentTimeframe, startTime, endTime: now }
  };
  if (isBuilder) {
    body.req.dex = getDex(currentCoin);
  }

  try {
    // Separate dedup lanes for foreground vs background: a foreground chart load
    // must never dedup onto an in-flight *background* request (e.g. a neighbour-
    // timeframe prefetch), or it would inherit that request's concurrency-gate
    // wait and the chart would stall on the old timeframe.
    const fetchDedupKey = forceAuthoritative
      ? `candles:repair:${cacheKey}:${repairFromTime}:${requestToken ?? ''}`
      : (background ? `candles:bg:${cacheKey}` : `candles:${cacheKey}:${requestToken ?? ''}`);
    const data = await fetchWithDedup(fetchDedupKey, () => fetchChartCandles(body, { background, signal }), { signal });
    if (data && data.length > 0) {
      if (isStaleRequest()) return null;
      candleFailureCooldownUntil.delete(cacheKey);
      const normalized = normalizeCandleSeries(data);
      const droppedRows = data.length - normalized.length;
      if (droppedRows > 0) {
        AppState.market.candleIntegrity.validationFailures += droppedRows;
      }
      if (!normalized.length) {
        setActiveChartNotice('Chart data invalid');
        return null;
      }
      // Keep already-loaded scrollback while authoritative snapshot rows win
      // timestamp conflicts and fill repaired interior buckets.
      const mergedSnapshot = mergeAuthoritativeCandles(cachedCandles, normalized);
      setCandleCacheEntry(cacheKey, mergedSnapshot);
      AppState.market.candleIntegrity.lastVerifiedSnapshotAt = Date.now();

      if (isActiveRequest) {
        // Paint immediately from the initial fetch (a single upstream request),
        // then enrich (CVD source + deep-history backfill) in the background so a
        // rapid switch can't fan out several foreground requests per click.
        await applyCandles(mergedSnapshot, currentCoin, currentTimeframe);
        syncActiveCvdRefresh(currentCoin, currentTimeframe, mergedSnapshot);
        completeChartSession({
          coin: currentCoin,
          timeframe: currentTimeframe,
          requestToken,
        });
        enrichActiveChart({
          coin: currentCoin,
          timeframe: currentTimeframe,
          base: mergedSnapshot,
          requiredLookbackMs,
          now,
          isHip3,
          requestToken,
          cacheKey,
          signal,
        });
        scheduleActiveRvwapHydration(currentCoin);
      } else {
        // Background/prefetch: extend inline so the cached entry is complete for
        // the eventual foreground view.
        const extended = await extendCandlesToLookback({
          coin: currentCoin,
          timeframe: currentTimeframe,
          candles: mergedSnapshot,
          requiredLookbackMs,
          now,
          background: true,
          cacheKey,
        });
        setCandleCacheEntry(cacheKey, extended);
      }

      const series = candleCache.get(cacheKey) || mergedSnapshot;
      const lastClose = parseFloat(series[series.length - 1].c);
      if (lastClose) {
        if (currentCoin === getCurrentCoin()) {
          applyResolvedPrice(currentCoin, lastClose);
        } else {
          AppState.market.allMids[currentCoin] = lastClose.toString();
        }
      }
      return series;
    }
    setActiveChartNotice('No chart data');
  } catch(e) {
    // A superseded switch was aborted — not a failure; leave no cooldown/notice.
    if (isCanceledRequestError(e, signal) || isAbortError(e, signal)) return null;
    if (isUpstreamThrottleError(e)) {
      candleFailureCooldownUntil.set(cacheKey, Date.now() + CANDLE_THROTTLE_COOLDOWN_MS);
      // Self-heal a blank active chart: retry after the cooldown without needing
      // a user re-click (the backend is warming the series in the meantime).
      if (isActiveRequest && !isStaleRequest() && (getCandles() || []).length === 0) {
        scheduleActiveChartRetry(currentCoin, currentTimeframe);
      }
    }
    setActiveChartNotice(isUpstreamThrottleError(e) ? 'Chart temporarily unavailable' : 'Chart unavailable');
    // Transient cold-chart failures self-heal via retry; don't spam the console
    // on every rapid coin flip. Permanent failures still log.
    if (!background && !isUpstreamThrottleError(e)) {
      console.error('Fetch candles error:', e);
    }
  }
  return null;
}

async function fetchHistoricalCandles(options = {}) {
  const coin = options.coin || getCurrentCoin();
  const timeframe = options.timeframe || getCurrentTimeframe();
  const endTime = Number(options.endTime || Date.now());
  const limit = Math.max(50, Math.min(1500, Number(options.limit || 1000)));
  const background = options.background === true;
  const signal = options.signal;
  const intervalMs = timeframeMs[timeframe] || (60 * 60 * 1000);
  const startTime = Math.max(0, endTime - (intervalMs * limit));
  const body = {
    type: 'candleSnapshot',
    req: { coin, interval: timeframe, startTime, endTime }
  };

  if (isBuilderPerpCoin(coin)) {
    body.req.dex = getDex(coin);
  }

  try {
    const lane = background ? 'bg:' : '';
    const dedupKey = `candles:history:${lane}${coin}:${timeframe}:${startTime}:${endTime}:${limit}`;
    const data = await fetchWithDedup(dedupKey, () => fetchChartCandles(body, { background, signal }), { signal });
    if (!Array.isArray(data)) return [];
    const normalized = normalizeCandleSeries(data);
    const droppedRows = data.length - normalized.length;
    if (droppedRows > 0) AppState.market.candleIntegrity.validationFailures += droppedRows;
    return normalized;
  } catch(e) {
    if (isAbortError(e, signal) || isCanceledRequestError(e, signal)) return null;
    console.error('Fetch historical candles error:', e);
    // Preserve the distinction between "the exchange has no older candles"
    // (a successful []) and a transport failure. The history loader marks an
    // empty result terminal, so flattening failures to [] can permanently
    // truncate scrollback after one transient 429/network error.
    return null;
  }
}


// Tab order users flip through; prefetch reaches the immediate neighbours so a
// timeframe switch lands on already-cached candles instead of a REST round trip.
const PREFETCH_TIMEFRAME_ORDER = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d'];

function adjacentTimeframes(timeframe, span = 1) {
  const idx = PREFETCH_TIMEFRAME_ORDER.indexOf(timeframe);
  if (idx < 0) return [];
  const out = [];
  for (let d = 1; d <= span; d += 1) {
    if (idx - d >= 0) out.push(PREFETCH_TIMEFRAME_ORDER[idx - d]);
    if (idx + d < PREFETCH_TIMEFRAME_ORDER.length) out.push(PREFETCH_TIMEFRAME_ORDER[idx + d]);
  }
  return out;
}

function scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 250);
  }
}

// prefetchAdjacentTimeframes warms the candle cache for the timeframes next to
// the one in view (same coin) on idle, so flipping timeframes is instant. It's
// a no-op when the neighbour is already cached fresh, bails if the coin changed
// before idle, and rides the existing dedup + failure-cooldown in fetchCandles
// so it can't spam upstream. background:true keeps it off the active chart.
function prefetchAdjacentTimeframes({ coin, timeframe } = {}) {
  const targetCoin = coin || getCurrentCoin();
  const targetTimeframe = timeframe || getCurrentTimeframe();
  if (!targetCoin || !targetTimeframe) return;
  // Display-candle neighbours are idle work. The 4h RVWAP source is a
  // separate series: start it immediately so a switch frame can adopt cache
  // instead of painting empty bands.
  if (hasEnabledRvwap()) scheduleActiveRvwapHydration(targetCoin);
  for (const tf of adjacentTimeframes(targetTimeframe, 1)) {
    scheduleIdle(() => {
      if (getCurrentCoin() !== targetCoin) return; // a newer switch superseded us
      const cacheKey = `${targetCoin}:${tf}`;
      const now = Date.now();
      const cached = candleCache.get(cacheKey);
      if (
        (
          hasEnoughCachedHistory(cached, getInitialHistoryLookbackMs(tf), now)
          || exhaustedHistoryKeys.has(cacheKey)
        )
        && hasFreshCandleTail(cached, tf, now)
      ) {
        return;
      }
      Promise.resolve(fetchCandles({ coin: targetCoin, timeframe: tf, background: true })).catch(() => {});
    });
  }
}

async function fetchL2Snapshot(coin, { shouldApply = () => true } = {}) {
  try {
    const data = await apiPost('/api/l2-snapshot', { coin: coin, testnet: false });
    const book = buildNormalizedBook(data?.levels, { limit: 50 });
    if (book && shouldApply()) {
      applyBookSnapshot(book);
      // Dynamic import avoids chart-candle → dom-ladder → tabs → chart-render cycle.
      Promise.resolve(import('../render/dom-ladder.js')).then((dom) => {
        dom.noteDomBookCoin?.(coin);
        dom.scheduleDomLadderRender?.();
      }).catch(() => {});

      if (book.bids[0] && book.asks[0]) {
        const bestBid = parseFloat(book.bids[0].px);
        const bestAsk = parseFloat(book.asks[0].px);
        if (bestBid && bestAsk) {
          const mid = (bestBid + bestAsk) / 2;
          applyResolvedPrice(coin, mid);
        }
      }
    }
    return data;
  } catch(e) {
    console.error('Fetch L2 error:', e);
    return null;
  }
}


export {
  fetchCandles,
  ensureActiveCvdRefresh,
  prefetchAdjacentTimeframes,
  fetchHistoricalCandles,
  fetchL2Snapshot,
};
