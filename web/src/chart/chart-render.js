/**
 * Chart render coordinator.
 *
 * Lightweight Charts is the primary renderer. This module:
 *   - drives the Lightweight chart bootstrap and per-frame sync
 *
 * Follows the canonical lightweight-charts real-time update pattern:
 *   - series.setData() for initial load / reload (via syncLightweightChart)
 *   - series.update() for live candle ticks (via bufferLiveCandleSync)
 *   - the current mid/mark remains a separate native price line
 */

import { AppState, candleCache, evictCandleCache, setCandleCacheEntry } from '../state/store.js';
import { setMarketCandles } from '../state/market-state.js';
import { normalizeCandleSeries } from '../state/market-candles.js';
import { getChartSession } from '../state/chart-session.js';
import { createChartHistoryLoader } from './chart-history-loader.js';
import {
  buildLightweightRenderModel,
  getChartRuntime,
} from './chart-render-model.js';
import { createChartRenderScheduler } from './chart-render-scheduler.js';
import { getChartPreviewLevels } from './chart-preview-state.js';
import { drawChartLoadingState, getChartOverlayState } from './chart-loading-state.js';
import {
  initChartState,
  chartCanvas,
  chartCtx,
  getViewStart,
  getViewCount,
  setViewStart,
  setViewCount,
} from './chart-state.js';
import { updateChartLevels, getCoinLevels } from './chart-levels.js';
import { attachChartEvents as attachChartInteractionEvents } from './chart-interactions.js';
import {
  bufferLiveCandleSync,
  barsInLogicalRange,
  clearPendingVisibleRangeRequests,
  coordinateToPrice,
  getChart,
  priceToCoordinate,
  recoverChartAfterResume,
  requestVisibleLogicalRange,
  repositionLineLabels,
  setVisibleRangeListener,
  syncLightweightChart,
  syncOrderLines,
  syncPositionLines,
  syncPreviewLines,
  syncJevSignalLines,
  syncLivePriceLine,
  syncOrderLabels,
  syncPositionLabels,
} from './lightweight-chart.js';
import { fetchHistoricalCandles } from '../services/chart-candle-service.js';
import { DEFAULT_TIMEFRAME } from './chart-history-requirements.js';


const CHART_PAD = { top: 24, bottom: 36, left: 8, right: 72 };
const CHART_RENDER_THROTTLE_MS = 16;

let needsFitContent = true;
let forceNextVisibleRangeSync = false;
let chartRenderScheduler = null;
let defaultAutoFitActive = true;
let defaultAutoFitSelectionKey = '';
// Series span last successfully overview-fitted under default auto-fit.
// Used so background enrichment re-fits when history grows, without thrashing
// every same-data updateChart (which would stomp a manual scroll if interaction
// tagging were missed).
let lastDefaultAutoFitSeriesKey = '';
let fitRetryTimer = null;
let fitRetryAttempts = 0;
const MAX_FIT_RETRY_ATTEMPTS = 12;

function currentChartSelectionKey() {
  return `${AppState.trading.currentCoin || ''}:${AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME}`;
}

function seriesFitKey(candles = []) {
  const rows = Array.isArray(candles) ? candles : [];
  const first = rows[0];
  const last = rows[rows.length - 1];
  return `${rows.length}:${first?.t || ''}:${last?.t || ''}`;
}

function clearFitRetry() {
  if (fitRetryTimer != null) {
    clearTimeout(fitRetryTimer);
    fitRetryTimer = null;
  }
  fitRetryAttempts = 0;
}

function scheduleFitRetry() {
  if (fitRetryTimer != null) return;
  if (fitRetryAttempts >= MAX_FIT_RETRY_ATTEMPTS) return;
  fitRetryAttempts += 1;
  // LC can report width 0 on the first createChart frame even when the wrap
  // already has offsetWidth. Retry a few times so we never stick on the theme
  // default barSpacing (~8px → ~80–100 bars = "zoomed in").
  fitRetryTimer = setTimeout(() => {
    fitRetryTimer = null;
    if (!needsFitContent && !defaultAutoFitActive) return;
    needsFitContent = true;
    forceNextVisibleRangeSync = true;
    scheduleChartRender();
  }, 32 + fitRetryAttempts * 16);
}

function syncDefaultAutoFitSelection() {
  const key = currentChartSelectionKey();
  if (key === defaultAutoFitSelectionKey) return;
  defaultAutoFitSelectionKey = key;
  defaultAutoFitActive = true;
  lastDefaultAutoFitSeriesKey = '';
  needsFitContent = true;
  clearFitRetry();
}

function markChartViewportUserControlled() {
  // Do not call syncDefaultAutoFitSelection() here — that re-arms auto-fit on
  // selection change and would immediately undo the user-controlled flag.
  defaultAutoFitActive = false;
  needsFitContent = false;
  clearFitRetry();
}

function scheduleChartRender() {
  return chartRenderScheduler?.scheduleChartRender();
}

function syncRequestedVisibleRange(candles = [], { fitContent = false } = {}) {
  if (fitContent) {
    // The native chart resets barSpacing at render time after every overlay
    // has attached. Do not request a time range here: setVisibleRange() derives
    // a different spacing for every timeframe and destabilizes candle width.
    clearPendingVisibleRangeRequests();
    return;
  }
  requestVisibleLogicalRange({
    from: getViewStart(),
    to: getViewStart() + Math.max(1, getViewCount()) - 1,
  });
}

const chartHistoryLoader = createChartHistoryLoader({
  getCurrentCoin: () => AppState.trading.currentCoin,
  getCurrentTimeframe: () => AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME,
  getCandles: () => AppState.market.candles,
  setCandles: (candles) => {
    setMarketCandles(candles, { snapshot: true });
  },
  fetchHistoricalCandles,
  candleCache,
  evictCandleCache,
  setCandleCacheEntry,
  getViewStart,
  setViewStart,
  getViewCount,
  getVisibleLogicalRange: () => {
    try {
      return getChart()?.timeScale?.()?.getVisibleLogicalRange?.() || null;
    } catch {
      return null;
    }
  },
  requestVisibleLogicalRange,
  scheduleChartRender,
  normalizeCandles: normalizeCandleSeries,
  onClearHistoryState: () => {
    syncDefaultAutoFitSelection();
    needsFitContent = defaultAutoFitActive;
    if (defaultAutoFitActive) lastDefaultAutoFitSeriesKey = '';
  },
});

const { clearHistoryLoadState, ensureHistoricalCandles } = chartHistoryLoader;

function initChart() {
  const wrap = document.getElementById('chartWrap');
  if (!wrap || !wrap.offsetWidth) {
    setTimeout(initChart, 100);
    return;
  }

  const old = document.getElementById('chartCanvas');
  if (old) old.remove();

  const canvas = document.createElement('canvas');
  canvas.id = 'chartCanvas';
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:2;pointer-events:none;';
  wrap.appendChild(canvas);

  syncDefaultAutoFitSelection();
  needsFitContent = defaultAutoFitActive;
  initChartState();
  // Align the app-side window with full history before the first fit so any
  // non-fit forceVisibleRange path cannot fall back to the default 80 bars.
  {
    const candles = AppState.market.candles || [];
    if (needsFitContent && candles.length > 0) {
      setViewStart(0);
      setViewCount(Math.max(1, candles.length));
    }
  }
  setVisibleRangeListener((range) => {
      // setVisibleLogicalRange emits on a later chart frame, after the narrow
      // synchronous suppression guard has exited. While the default viewport
      // owns the chart, ignore those delayed programmatic notifications so an
      // earlier short snapshot cannot overwrite a later full-history fit.
      if (defaultAutoFitActive) return;
      const candles = AppState.market.candles || [];
      if (!candles.length) return;
      const rangeWithBars = {
        ...range,
        barsBefore: Number(barsInLogicalRange(range)?.barsBefore),
      };
      const from = Number.isFinite(range.from) ? Math.floor(range.from) : 0;
      const to = Number.isFinite(range.to) ? Math.ceil(range.to) : candles.length - 1;
      const nextStart = Math.max(0, Math.min(candles.length - 1, from));
      const nextCount = Math.max(1, Math.min(candles.length, to - from + 1));
      setViewStart(nextStart);
      setViewCount(nextCount);
      // Official infinite-history pattern: load more data on range change.
      // Do not schedule a full series sync on every pan/zoom — that fights
      // the library's own scroll and can snap fractional logical indexes.
      try { repositionLineLabels(); } catch {}
      ensureHistoricalCandles(rangeWithBars).catch(() => {});
  });
  attachChartInteractionEvents(undefined, {
    onViewportInteraction: markChartViewportUserControlled,
  });
  syncRequestedVisibleRange(AppState.market.candles || [], { fitContent: needsFitContent });
  forceNextVisibleRangeSync = true;
  drawChart();
}

chartRenderScheduler = createChartRenderScheduler({
  throttleMs: CHART_RENDER_THROTTLE_MS,
  onDraw: () => drawChart(),
});

function ensureCanvasSize(width, height) {
  if (!chartCanvas) return false;
  if (chartCanvas.width !== width || chartCanvas.height !== height) {
    chartCanvas.width = width;
    chartCanvas.height = height;
    return true;
  }
  return false;
}

function updateChart() {
  const candles = AppState.market.candles || [];
  // Coin/TF changes re-arm defaultAutoFitActive. While that mode owns the
  // viewport, re-fit when the series span changes (initial load, cache hydrate,
  // background enrichment). Same-span updateChart leaves a manual window alone.
  // Clearing needsFitContent after the first paint used to leave a short-history
  // zoom when enrichActiveChart later applied a longer series via updateChart().
  syncDefaultAutoFitSelection();
  const nextSeriesKey = seriesFitKey(candles);
  const seriesSpanChanged = nextSeriesKey !== lastDefaultAutoFitSeriesKey;
  if (needsFitContent || (defaultAutoFitActive && seriesSpanChanged)) {
    needsFitContent = true;
    setViewStart(0);
    setViewCount(Math.max(1, candles.length));
    syncRequestedVisibleRange(candles, { fitContent: true });
    forceNextVisibleRangeSync = true;
  } else {
    const nextCount = Math.max(1, Math.min(getViewCount(), Math.max(1, candles.length)));
    const maxStart = Math.max(0, candles.length - nextCount);
    setViewCount(nextCount);
    setViewStart(Math.max(0, Math.min(getViewStart(), maxStart)));
    // Do NOT force a visible-range reset here. Anchored-VWAP overlay injects
    // synthetic time slots between candles, so the unified logical axis has
    // more slots than candles.length; re-applying a logical range derived from
    // candle indices shifts bars off the right edge. The chart's own
    // rightBarStaysOnScroll keeps the live edge pinned as new data arrives.
  }
  scheduleChartRender();
}

function buildRenderModel() {
  const canvas = chartCanvas;
  const ctx = chartCtx;
  if (!canvas || !ctx) return null;
  const runtime = getChartRuntime({
    appState: AppState,
    scalePreviewLevels: getChartPreviewLevels(),
    chartLayers: null,
  });

  const wrap = document.getElementById('chartWrap');
  if (!wrap) return null;
  const W = wrap.offsetWidth;
  const H = wrap.offsetHeight;
  if (!W || !H) return null;

  ensureCanvasSize(W, H);

  const candles = runtime.candles;
  {
    // Sync the lightweight-charts series with the raw candle data.
    // syncSeries() → setData() is deduped by signature, so this is a no-op
    // when the candle array is unchanged. Live ticks within a bucket arrive
    // via WS → bufferLiveCandleSync → series.update(), independent of this
    // render path. Mid/mark updates never mutate the exchange candle series.
    const syncResult = syncLightweightChart({
      candles,
      candleSnapshotRevision: AppState.market.candleSnapshotRevision,
      coin: runtime.currentCoin,
      timeframe: runtime.currentTimeframe,
      viewStart: getViewStart(),
      viewCount: getViewCount(),
      forceVisibleRange: forceNextVisibleRangeSync,
      fitContent: needsFitContent,
    });
    // Object return is the current contract; tolerate legacy boolean truthiness.
    const fitSucceeded = syncResult && typeof syncResult === 'object'
      ? syncResult.fitSucceeded !== false
      : true;

    const chartSession = getChartSession();
    const levels = getCoinLevels(runtime.currentCoin || 'BTC');
    const hasChartLevels = levels.positions.length > 0 || levels.orders.length > 0 || levels.levels.length > 0;
    const overlayState = getChartOverlayState({
      candles,
      chartSession,
      legacyLoadingFlag: AppState.ui.isLoadingChart === true,
      hasChartLevels,
      fallbackNotice: AppState.ui.chartNotice || '',
    });
    const lightweightModel = buildLightweightRenderModel({
      ctx,
      width: W,
      height: H,
      runtime,
      candles,
      chartSession,
      overlayState,
      levels,
      chartPad: CHART_PAD,
      viewStart: getViewStart(),
      viewCount: getViewCount(),
      needsFitContent,
      fitSucceeded,
      forceVisibleRangeSync: forceNextVisibleRangeSync,
      syncOrderLines,
      syncPositionLines,
      syncPreviewLines,
      syncJevSignalLines,
      syncOrderLabels,
      syncPositionLabels,
      syncLivePriceLine,
      priceToCoordinate,
    });
    needsFitContent = lightweightModel.nextNeedsFitContent;
    forceNextVisibleRangeSync = lightweightModel.nextForceVisibleRangeSync;
    // Record the series span only after a successful overview fit so a failed
    // first paint (width 0) still retries, and so enrichment expansions differ.
    if (!needsFitContent && defaultAutoFitActive && candles.length > 0 && fitSucceeded) {
      lastDefaultAutoFitSeriesKey = seriesFitKey(candles);
      setViewStart(0);
      setViewCount(Math.max(1, candles.length));
      clearFitRetry();
    } else if (needsFitContent && candles.length > 0) {
      scheduleFitRetry();
    }
    return lightweightModel.model;
  }

}

function drawChart() {
  const model = buildRenderModel();
  if (!model) return;
  if (model.loading) {
      drawChartLoadingState(model.ctx, model.W, model.H, {
      overlayOnly: true,
      text: model.overlayText || 'Loading...',
    });
    return;
  }

  model.ctx.clearRect(0, 0, model.W, model.H);
}

function updateChartWithCandles(candles) {
  setMarketCandles(candles, { snapshot: true });
  // Route through updateChart so default auto-fit re-applies on snapshot
  // replacements (account-stream candle batches, etc.).
  updateChart();
}

function overlayCanvasContextLost() {
  if (!chartCanvas) return true;
  try {
    return typeof chartCtx?.isContextLost === 'function' && chartCtx.isContextLost() === true;
  } catch {
    return false;
  }
}

function resetOverlayCanvasBackingStore() {
  if (!chartCanvas || !overlayCanvasContextLost()) return false;
  try {
    chartCanvas.width = chartCanvas.width;
    initChartState();
    return true;
  } catch {
    return false;
  }
}

function recoverChartSurfaceAfterResume() {
  const wrap = document.getElementById('chartWrap');
  const wrapReady = Boolean(wrap?.offsetWidth && wrap?.offsetHeight);
  if (wrapReady && !chartCanvas) {
    initChart();
  } else {
    resetOverlayCanvasBackingStore();
    try {
      const recovered = recoverChartAfterResume();
      if (recovered?.recreated === true) {
        needsFitContent = true;
        forceNextVisibleRangeSync = true;
        lastDefaultAutoFitSeriesKey = '';
      }
    } catch {}
  }
  if (chartRenderScheduler?.flushChartRender) chartRenderScheduler.flushChartRender();
  else drawChart();
}

function bufferLiveChartCandle({ candle, candles, timeframe } = {}) {
  const ok = bufferLiveCandleSync({
    candle,
    candles,
    timeframe,
    coin: AppState.trading.currentCoin,
  });
  if (!ok) scheduleChartRender();
}

const attachChartEvents = () => attachChartInteractionEvents();

export {
  initChart,
  attachChartEvents,
  scheduleChartRender,
  recoverChartSurfaceAfterResume,
  ensureCanvasSize,
  updateChart,
  drawChart,
  updateChartWithCandles,
  bufferLiveChartCandle,
  updateChartLevels,
  clearHistoryLoadState,
  coordinateToPrice,
  drawChartLoadingState,
  getChartOverlayState,
};
