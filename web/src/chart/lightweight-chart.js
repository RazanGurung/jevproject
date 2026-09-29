/**
 * Lightweight chart composition layer - wires together core (bootstrap/lifecycle),
 * series sync, and price line controllers, then exposes the public surface used
 * by chart-render and other consumers.
 *
 * Follows the canonical lightweight-charts real-time update pattern:
 *   - series.setData() for initial load / reload
 *   - series.update() for live candle ticks (single source of truth)
 *   - current mid/mark is rendered separately as a native price line
 */

import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  applyThemeIfNeeded,
  barsInLogicalRange,
  clearPendingVisibleRangeRequests,
  consumePendingVisibleLogicalRange,
  coordinateToPrice,
  ensureChart,
  getCandleSeries,
  getChart,
  getLastDataSignature,
  getLastSeriesMeta,
  getLightweightChartCoreDebugState,
  hasPendingVisibleLogicalRange,
  onChartInit,
  onChartResize,
  onChartTeardown,
  onSeriesRecreate,
  priceToCoordinate,
  recreateMainSeries,
  removeChart,
  repaintChartAfterResume,
  requestVisibleLogicalRange,
  setLastDataSignature,
  setLastSeriesMeta,
  setVisibleRangeListener,
  syncCandlePriceFormat,
  withSuppressedVisibleRangeEvents,
} from './lightweight-chart-core.js';
import {
  CHART_OVERVIEW_MIN_BAR_SPACING,
  DEFAULT_CHART_BAR_SPACING,
  DEFAULT_CHART_CONFLATION_THRESHOLD_FACTOR,
  DEFAULT_CHART_MIN_BAR_SPACING,
  DEFAULT_CHART_RIGHT_OFFSET,
  calculateChartConflationFactor,
} from './lightweight-chart-theme.js';
import { createPriceLineController } from './lightweight-chart-lines.js';
import { createSeriesSyncController } from './lightweight-chart-series.js';
import { createLiveCandleProjectionController } from './live-candle-projection.js';
import { createManualAnchoredVwapOverlay } from './manual-anchored-vwap.js';
import { createSessionVwapOverlay } from './session-vwap.js';
import { createRvwapOverlaySet } from './vwap-bands.js';
import { createPriceProjectionOverlay, logicalIndexForUnix } from './price-projection-indicator.js';
import { createWeekPathProjectionOverlay } from './week-path-projection-indicator.js';
import { createCvdOverlay } from './cvd-indicators.js';
import { createCvdOscillatorOverlay } from './cvd-oscillator-indicator.js';
import { createMonthlyVolumeProfileOverlay } from './monthly-volume-profile.js';
import { createLiquidationClustersOverlay } from './liquidation-clusters.js';
import { createWhaleMarkersOverlay } from './whale-markers.js';
import { createCandleOverlay } from './candle-overlay.js';
import { createDrawingToolsRouter } from './drawing-router.js';
import { applyChartNavigation } from './chart-navigation.js';
import { createLineLabels } from '../ui/chart-line-labels.js';
import { AppState, rvwapSourceCache, rvwapSourceMetaCache } from '../state/store.js';
import { candleTimeSeconds, selectClosedCandles } from '../state/market-candles.js';
import { cancelFrameWork, scheduleFrameWork } from '../utils/frame.js';
import { DEFAULT_TIMEFRAME } from './chart-history-requirements.js';

const cvdOverlay = createCvdOverlay({ getChart, HistogramSeries, LineSeries });
const cvdOscillatorOverlay = createCvdOscillatorOverlay({ getChart, HistogramSeries, LineSeries });
let lastCandleSnapshotRevision = -1;
let lastOverviewLogicalRange = null;
// Last coin:timeframe that received a successful full-history overview fit.
// Catches switch paths where recreate/fit flags race or are skipped.
let lastOverviewSelectionKey = '';
let indicatorSourceDebug = { count: 0, lastTime: 0, signature: '0', excludedOpenCount: 0 };
let rvwapIndicatorSourceDebug = { count: 0, lastTime: 0, signature: '0', excludedOpenCount: 0 };
let deferredIndicatorGeneration = 0;
let deferredIndicatorKey = '';
let deferredIndicatorPending = false;
let deferredIndicatorWork = [];
let deferredIndicatorLiveUpdate = null;
let lastCompletedIndicatorKey = '';

function rvwapSourceRowsForCoin(coin) {
  const cached = rvwapSourceCache.get(coin);
  if (!Array.isArray(cached) || cached.length === 0) return [];
  const status = AppState.market.rvwapSource || {};
  if (status.coin === coin && status.status === 'ready') return cached;
  const meta = rvwapSourceMetaCache.get(coin);
  if (meta?.complete === true) return cached;
  return [];
}

function cancelDeferredIndicatorSync() {
  deferredIndicatorGeneration += 1;
  deferredIndicatorKey = '';
  deferredIndicatorPending = false;
  deferredIndicatorLiveUpdate = null;
  lastCompletedIndicatorKey = '';
  for (const work of deferredIndicatorWork) cancelFrameWork(work);
  deferredIndicatorWork = [];
}

function scheduleDeferredIndicatorSync(key, coin, timeframe, phases, onComplete = null) {
  if (deferredIndicatorPending && deferredIndicatorKey === key) return;
  if (!deferredIndicatorPending && lastCompletedIndicatorKey === key) {
    try { onComplete?.(); } catch {}
    return;
  }
  cancelDeferredIndicatorSync();
  const generation = deferredIndicatorGeneration;
  deferredIndicatorKey = key;
  deferredIndicatorPending = true;

  const enqueue = (index) => {
    const work = scheduleFrameWork(() => {
      deferredIndicatorWork = deferredIndicatorWork.filter((candidate) => candidate !== work);
      const selectionStillCurrent = (AppState.trading.currentCoin || '') === coin
        && (AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME) === timeframe;
      if (generation !== deferredIndicatorGeneration || !selectionStillCurrent || !getChart()) {
        if (generation === deferredIndicatorGeneration) cancelDeferredIndicatorSync();
        return;
      }
      phases[index]();
      if (index + 1 < phases.length) {
        enqueue(index + 1);
      } else if (generation === deferredIndicatorGeneration) {
        deferredIndicatorPending = false;
        lastCompletedIndicatorKey = key;
        deferredIndicatorKey = '';
        const latest = deferredIndicatorLiveUpdate;
        deferredIndicatorLiveUpdate = null;
        if (latest) {
          manualAnchoredVwapOverlay.updateLast(latest.candles, latest.coin, latest.timeframe);
          sessionVwapOverlay.updateLast(latest.candles, latest.timeframe);
          if (AppState.ui.monthlyVolumeProfileVisible === true) {
            monthlyVolumeProfileOverlay.updateLast(latest.candles, latest.timeframe);
          }
          if (AppState.ui.liquidationClustersVisible === true) {
            liquidationClustersOverlay.updateLiquidations(
              AppState.market?.marketLiquidations || [],
              latest.coin,
            );
          }
          if (AppState.ui.priceProjectionVisible === true) {
            priceProjectionOverlay.updateLast(
              latest.candles,
              latest.coin,
              latest.timeframe,
              AppState.market.candleSnapshotRevision,
            );
          }
          if (AppState.ui.weekPathProjectionVisible === true) {
            weekPathProjectionOverlay.updateLast(
              latest.candles,
              latest.coin,
              latest.timeframe,
              AppState.market.candleSnapshotRevision,
            );
          }
          cvdOverlay.updateLast(latest.candles, latest.coin, latest.timeframe);
          cvdOscillatorOverlay.updateLast(latest.candles, latest.coin, latest.timeframe);
          if (AppState.ui.whaleMarkersVisible === true) {
            whaleMarkersOverlay.updateLast(latest.candles, latest.timeframe);
          }
          if (AppState.ui.candleOverlay?.mode && AppState.ui.candleOverlay.mode !== 'off') {
            candleOverlay.updateLast(
              latest.rawCandles || latest.candles,
              latest.coin,
              latest.timeframe,
              { closedCandles: latest.candles },
            );
          }
        }
        try { onComplete?.(); } catch {}
      }
    });
    deferredIndicatorWork.push(work);
  };
  enqueue(0);
}

function normalizedCandleTime(candle) {
  const raw = Number(candle?.t || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
}

function closedSourceDebug(allCandles, closedCandles) {
  const all = Array.isArray(allCandles) ? allCandles : [];
  const closed = Array.isArray(closedCandles) ? closedCandles : [];
  const last = closed[closed.length - 1];
  return {
    count: closed.length,
    lastTime: normalizedCandleTime(last),
    signature: closed.length === 0
      ? '0'
      : [
        closed.length,
        normalizedCandleTime(closed[0]),
        normalizedCandleTime(last),
        last?.o ?? '',
        last?.h ?? '',
        last?.l ?? '',
        last?.c ?? '',
        last?.v ?? '',
        last?.cvdDelta ?? '',
      ].join(':'),
    excludedOpenCount: Math.max(0, all.length - closed.length),
  };
}

const priceLineController = createPriceLineController(getCandleSeries, LineStyle);
const {
  clearAllPriceLines,
  resetPriceLines,
  syncOrderLines,
  syncPositionLines,
  syncPreviewLines,
  syncLivePriceLine,
  syncJevSignalLines,
  invalidateLivePriceLine,
  getLivePriceLineAgeMs,
  getDebugState: getPriceLineDebugState,
} = priceLineController;

onChartInit(() => resetPriceLines());
onChartTeardown(() => {
  cancelDeferredIndicatorSync();
  clearAllPriceLines();
  cvdOverlay.detach();
  cvdOscillatorOverlay.detach();
  lastCandleSnapshotRevision = -1;
  lastOverviewLogicalRange = null;
  lastOverviewSelectionKey = '';
  indicatorSourceDebug = { count: 0, lastTime: 0, signature: '0', excludedOpenCount: 0 };
  rvwapIndicatorSourceDebug = { count: 0, lastTime: 0, signature: '0', excludedOpenCount: 0 };
});

const manualAnchoredVwapOverlay = createManualAnchoredVwapOverlay({
  getChart,
  getCandleSeries,
  LineSeries,
  LineStyle,
});
onChartTeardown(() => manualAnchoredVwapOverlay.detach());

const sessionVwapOverlay = createSessionVwapOverlay({ getChart, getCandleSeries });
onChartTeardown(() => sessionVwapOverlay.detach());

const rvwapOverlays = createRvwapOverlaySet({ getChart, getCandleSeries, LineSeries, LineStyle });
onChartTeardown(() => rvwapOverlays.detach());

function barSecondsFromMeta(meta) {
  const length = Number(meta?.length || 0);
  const first = Number(meta?.firstTime || 0);
  const last = Number(meta?.lastTime || 0);
  if (length > 1 && last > first) return (last - first) / (length - 1);
  return 0;
}

function ensureProjectionLiveEdgeVisible(anchorTime, projectionTime) {
  const chart = getChart();
  const timeScale = chart?.timeScale?.();
  const range = timeScale?.getVisibleLogicalRange?.();
  if (!range) return;
  const meta = getLastSeriesMeta();
  const lastBarTime = Number(meta?.lastTime || 0);
  const barSeconds = barSecondsFromMeta(meta);
  const anchorIndex = Number(logicalIndexForUnix(timeScale, anchorTime, lastBarTime, barSeconds));
  const projectionIndex = Number(logicalIndexForUnix(timeScale, projectionTime, lastBarTime, barSeconds));
  if (!Number.isFinite(anchorIndex) || !Number.isFinite(projectionIndex)) return;
  const from = Number(range.from);
  const to = Number(range.to);
  const span = to - from;
  if (!(span > 0)) return;
  const anchorVisible = anchorIndex >= from - 0.5 && anchorIndex <= to + 0.5;
  if (!anchorVisible || to < anchorIndex - 0.5 || projectionIndex <= to) return;
  // Do not change bar spacing. A month-span path can be hundreds of bars;
  // yanking `to` out to the terminal would zoom the user out. Overview fit
  // already includes the full path. Zoomed-in live edge only reveals a little
  // of the fan; the rest is reachable by scrolling right.
  const slack = Math.max(DEFAULT_CHART_RIGHT_OFFSET + 2, span * 0.15);
  const nextTo = to + Math.min(projectionIndex - to, slack);
  if (!(nextTo > to + 1e-6)) return;
  withSuppressedVisibleRangeEvents(() => {
    timeScale.setVisibleLogicalRange({ from, to: nextTo });
  });
}

const priceProjectionOverlay = createPriceProjectionOverlay({
  getChart,
  getCandleSeries,
  ensureVisible: ensureProjectionLiveEdgeVisible,
});
onChartTeardown(() => priceProjectionOverlay.detach());

const weekPathProjectionOverlay = createWeekPathProjectionOverlay({
  getChart,
  LineSeries,
  LineStyle,
  ensureVisible: ensureProjectionLiveEdgeVisible,
});
onChartTeardown(() => weekPathProjectionOverlay.detach());

const monthlyVolumeProfileOverlay = createMonthlyVolumeProfileOverlay({ getChart, getCandleSeries });
onChartTeardown(() => monthlyVolumeProfileOverlay.detach());

const liquidationClustersOverlay = createLiquidationClustersOverlay({ getChart, getCandleSeries });
onChartTeardown(() => liquidationClustersOverlay.detach());

const whaleMarkersOverlay = createWhaleMarkersOverlay({ getChart, getCandleSeries });
onChartTeardown(() => whaleMarkersOverlay.detach());

const candleOverlay = createCandleOverlay({ getChart, getCandleSeries });
onChartTeardown(() => candleOverlay.detach());

// One router drives a price-pane overlay plus one per lower indicator pane (CVD
// histogram, CVD oscillator) so the same drawing tools work on any of them (the
// value-scale lower panes allow lines/shapes only).
const drawingToolsOverlay = createDrawingToolsRouter({
  getChart,
  getMainSeries: getCandleSeries,
  getCvdSeries: () => cvdOverlay.getSeries(),
  getOscillatorSeries: () => cvdOscillatorOverlay.getSeries(),
  getTimeframe: () => AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME,
  getBarTimes: () => {
    const candles = AppState.market.candles;
    if (!Array.isArray(candles) || candles.length < 2) return null;
    const last = candleTimeSeconds(candles[candles.length - 1]);
    const prev = candleTimeSeconds(candles[candles.length - 2]);
    if (!(last > 0 && prev > 0 && last > prev)) return null;
    return { last, prev };
  },
});
onChartTeardown(() => drawingToolsOverlay.detach());

const lineLabels = createLineLabels({
  getContainer: () => document.getElementById('chartWrap'),
  priceToCoordinate,
  coordinateToPrice,
});
const {
  syncOrderLabels,
  syncPositionLabels,
  repositionAll: repositionLineLabels,
  clearAll: clearLineLabels,
  teardown: teardownLineLabels,
} = lineLabels;

onChartTeardown(() => teardownLineLabels());
onSeriesRecreate(() => clearLineLabels());

let lineLabelResizeObserver = null;
onChartResize(() => {
  repositionLineLabels();
  refitOverviewIfUserHasNotPanned();
});
onChartInit(() => {
  if (typeof ResizeObserver !== 'function') return;
  const wrap = document.getElementById('chartWrap');
  if (!wrap) return;
  try {
    lineLabelResizeObserver = new ResizeObserver(() => {
      repositionLineLabels();
      refitOverviewIfUserHasNotPanned();
    });
    lineLabelResizeObserver.observe(wrap);
  } catch {}
});
onChartTeardown(() => {
  if (lineLabelResizeObserver) {
    try { lineLabelResizeObserver.disconnect(); } catch {}
    lineLabelResizeObserver = null;
  }
});

// When the main series is recreated (pair or timeframe change) the chart itself
// persists, so the regular teardown path doesn't run. Fan out the same
// per-pair cleanups here so no subsystem keeps references to the retired
// series or stale pair data.
onSeriesRecreate(() => {
  cancelDeferredIndicatorSync();
  resetPriceLines();
  manualAnchoredVwapOverlay.detach();
  rvwapOverlays.detach();
  priceProjectionOverlay.detach();
  weekPathProjectionOverlay.detach();
  cvdOverlay.detach();
  cvdOscillatorOverlay.detach();
  monthlyVolumeProfileOverlay.detach();
  drawingToolsOverlay.detach();
  lastOverviewLogicalRange = null;
});

const seriesSyncController = createSeriesSyncController({
  getCandleSeries,
  getLastSeriesMeta,
  setLastSeriesMeta,
  getLastDataSignature,
  setLastDataSignature,
  applyThemeIfNeeded,
  getTimeScale: () => getChart()?.timeScale?.() || null,
  clearCrosshair: () => {
    try { getChart()?.clearCrosshairPosition?.(); } catch {}
  },
});
const {
  updateSeries,
  syncSeries,
  resetLiveCursor,
  getDebugState: getSeriesSyncDebugState,
} = seriesSyncController;
const liveCandleProjection = createLiveCandleProjectionController();

function recordChartPhase(name, startedAt, detail = {}) {
  if (globalThis.__PEZ_PERF_ENABLED__ !== true) return;
  const endedAt = globalThis.performance?.now?.() ?? startedAt;
  const samples = globalThis.__PEZ_CHART_PHASES__ ||= [];
  samples.push({
    name,
    durationMs: Math.max(0, endedAt - startedAt),
    ...detail,
  });
  if (samples.length > 500) samples.splice(0, samples.length - 500);
}

onChartTeardown(() => liveCandleProjection.reset());
onSeriesRecreate(() => {
  liveCandleProjection.reset();
  resetLiveCursor();
});

function fitActiveCandleViewport(timeScale) {
  const meta = getLastSeriesMeta();
  const seriesLength = Math.max(0, Number(meta?.length || 0));
  const firstCandleTime = Number(meta?.firstTime || 0);
  const lastCandleTime = Number(meta?.lastTime || 0);
  const resolvedFirstIndex = firstCandleTime > 0
    ? timeScale?.timeToIndex?.(firstCandleTime, true)
    : null;
  const resolvedLastIndex = lastCandleTime > 0
    ? timeScale?.timeToIndex?.(lastCandleTime, true)
    : null;
  let firstCandleIndex = resolvedFirstIndex == null ? NaN : Number(resolvedFirstIndex);
  let lastCandleIndex = resolvedLastIndex == null ? NaN : Number(resolvedLastIndex);
  // If the library has not yet mapped times to logical indexes, fall back to
  // the series length so we still open fully zoomed out (index 0..N-1) instead
  // of the default barSpacing≈8 "zoomed in" viewport.
  if (
    seriesLength > 0
    && !(Number.isFinite(firstCandleIndex) && Number.isFinite(lastCandleIndex) && lastCandleIndex >= firstCandleIndex)
  ) {
    firstCandleIndex = 0;
    lastCandleIndex = seriesLength - 1;
  }
  // Only extend the overview for a ready, enabled projection. Disabled/pending
  // state must not leave a stale future logical end on the next timeframe fit.
  const projectionDebug = priceProjectionOverlay?.getDebugState?.() || {};
  const projectionEndTime = projectionDebug.enabled === true && projectionDebug.status === 'ready'
    ? Number(projectionDebug.lastProjectionTime || 0)
    : 0;
  const weekPathDebug = weekPathProjectionOverlay?.getDebugState?.() || {};
  const weekPathEndTime = weekPathDebug.enabled === true && weekPathDebug.status === 'ready'
    ? Number(weekPathDebug.lastProjectionTime || 0)
    : 0;
  const extraEndTime = Math.max(projectionEndTime, weekPathEndTime);
  const resolvedProjectionIndex = extraEndTime > 0
    ? logicalIndexForUnix(
      timeScale,
      extraEndTime,
      lastCandleTime,
      barSecondsFromMeta({
        length: seriesLength,
        firstTime: firstCandleTime,
        lastTime: lastCandleTime,
      }),
    )
    : null;
  const projectionEndIndex = resolvedProjectionIndex == null ? NaN : Number(resolvedProjectionIndex);
  const width = Number(timeScale?.width?.());

  if (
    Number.isFinite(firstCandleIndex)
    && Number.isFinite(lastCandleIndex)
    && lastCandleIndex >= firstCandleIndex
    && width > 0
  ) {
    // Leave enough zoom-out headroom for the same range to survive a later
    // narrow responsive resize. Official conflation keeps sub-pixel rendering
    // efficient; the canonical OHLC rows remain untouched.
    timeScale.applyOptions({
      minBarSpacing: CHART_OVERVIEW_MIN_BAR_SPACING,
      rightOffset: DEFAULT_CHART_RIGHT_OFFSET,
    });
    const overviewEndIndex = Number.isFinite(projectionEndIndex)
      ? Math.max(lastCandleIndex, projectionEndIndex)
      : lastCandleIndex;
    const overviewRange = {
      from: firstCandleIndex,
      to: overviewEndIndex + DEFAULT_CHART_RIGHT_OFFSET,
    };
    timeScale.setVisibleLogicalRange(overviewRange);
    lastOverviewLogicalRange = overviewRange;
    return true;
  }

  // Defensive fallback only when the chart has no measurable width yet (layout
  // not ready). Do not force barSpacing=8 — that paints a zoomed-in strip.
  // Callers keep needsFitContent true so the next frame retries overview fit.
  timeScale?.applyOptions?.({
    minBarSpacing: CHART_OVERVIEW_MIN_BAR_SPACING,
    rightOffset: DEFAULT_CHART_RIGHT_OFFSET,
  });
  timeScale?.fitContent?.();
  lastOverviewLogicalRange = null;
  return false;
}

function stillShowingOverview(timeScale = getChart()?.timeScale?.()) {
  const visible = timeScale?.getVisibleLogicalRange?.();
  const overview = lastOverviewLogicalRange;
  if (!visible || !overview) return false;
  return Number(visible.from) <= Number(overview.from) + 0.5
    && Number(visible.to) >= Number(overview.to) - 0.5;
}
function isPriceScaleCustomRange(priceScale = getCandleSeries()?.priceScale?.()) {
  const opts = priceScale?.options?.();
  return opts && opts.autoScale === false;
}

function recenterPriceScale(targetPriceScale) {
  const activeChart = getChart();
  const ps = targetPriceScale || getCandleSeries()?.priceScale?.() || activeChart?.priceScale?.('right');
  if (!ps) return false;

  try { ps.applyOptions?.({ autoScale: true }); } catch {}
  try { ps.setAutoScale?.(true); } catch {}

  try {
    const model = activeChart?._private__chartWidget?._internal_model?.();
    const internalPs = ps?._private__priceScale?.();
    const pane = model?._private__panes?.[0];
    if (model && internalPs && pane && typeof model._internal_resetPriceScale === 'function') {
      model._internal_resetPriceScale(pane, internalPs);
    } else if (internalPs && typeof internalPs._internal_setCustomPriceRange === 'function') {
      internalPs._internal_setCustomPriceRange(null);
      const visibleStrictRange = model?._private__timeScale?._internal_visibleStrictRange?.();
      if (visibleStrictRange && typeof internalPs._internal_recalculatePriceRange === 'function') {
        internalPs._internal_recalculatePriceRange(visibleStrictRange);
      }
    }
  } catch {}

  try { repositionLineLabels(); } catch {}
  return true;
}

function refitOverviewIfUserHasNotPanned() {
  const timeScale = getChart()?.timeScale?.();
  if (!timeScale || !stillShowingOverview(timeScale)) return false;
  if (isPriceScaleCustomRange()) return false;
  return fitLightweightChartToCandles();
}

function fitLightweightChartToCandles() {
  const activeChart = getChart();
  const timeScale = activeChart?.timeScale?.();
  if (!timeScale || !getLastSeriesMeta()?.length) return false;
  clearPendingVisibleRangeRequests();
  recenterPriceScale();
  return withSuppressedVisibleRangeEvents(() => fitActiveCandleViewport(timeScale));
}

function activeOverviewState(timeScale) {
  const visible = timeScale?.getVisibleLogicalRange?.();
  const overview = lastOverviewLogicalRange;
  if (
    !visible
    || !overview
    || Number(visible.from) > Number(overview.from) + 0.01
    || Number(visible.to) < Number(overview.to) - 0.01
  ) {
    return null;
  }
  return { ...overview };
}

function preserveOverviewAfterAppend(timeScale, candle, previousLastTime, overview) {
  if (!overview) return;
  const rawTime = Number(candle?.t || 0);
  const candleTime = rawTime >= 100_000_000_000 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
  if (!(candleTime > Number(previousLastTime || 0))) return;

  const resolvedIndex = Number(timeScale?.timeToIndex?.(candleTime, true));
  const nextTo = Number.isFinite(resolvedIndex)
    ? Math.max(Number(overview.to) + 1, resolvedIndex + DEFAULT_CHART_RIGHT_OFFSET)
    : Number(overview.to) + 1;
  const nextOverview = { from: Number(overview.from), to: nextTo };
  withSuppressedVisibleRangeEvents(() => {
    timeScale?.setVisibleLogicalRange?.(nextOverview);
  });
  lastOverviewLogicalRange = nextOverview;
}

function syncLightweightChart({ candles = [], candleSnapshotRevision = 0, coin = '', timeframe = DEFAULT_TIMEFRAME, viewStart = 0, viewCount = 80, forceVisibleRange = false, fitContent = false } = {}) {
  const totalStartedAt = globalThis.performance?.now?.() ?? 0;
  const nextCandles = Array.isArray(candles) ? candles : [];
  const indicatorCandles = selectClosedCandles(nextCandles, timeframe);
  indicatorSourceDebug = closedSourceDebug(nextCandles, indicatorCandles);
  const lastSeriesMeta = getLastSeriesMeta();
  const previousChart = getChart();
  const selectionKey = `${coin || ''}:${timeframe || ''}`;
  const selectionChanged = selectionKey !== lastOverviewSelectionKey;
  const shouldRecreateMainSeries = Boolean(
    previousChart
    && lastSeriesMeta
    && (
      lastSeriesMeta.coin !== coin
      || lastSeriesMeta.timeframe !== timeframe
      || (lastSeriesMeta.length > 0 && nextCandles.length === 0)
    )
  );
  // Always re-fit on pair/TF change or explicit fitContent. selectionChanged
  // covers the first paint after a recreate that nulled lastSeriesMeta, and
  // switch paths that only schedule a draw without re-arming fitContent.
  const shouldResetDefaultTimeScale = fitContent || shouldRecreateMainSeries || selectionChanged;
  let fitSucceeded = !shouldResetDefaultTimeScale;

  const activeChart = ensureChart();
  if (!activeChart || !getCandleSeries()) {
    return { ok: false, fitSucceeded: false };
  }
  if (shouldRecreateMainSeries && activeChart === previousChart) {
    recreateMainSeries();
  }
  if (!getCandleSeries()) {
    return { ok: false, fitSucceeded: false };
  }

  const paletteThemeChanged = applyThemeIfNeeded();
  if (paletteThemeChanged) {
    try { releaseStuckChartGestures(); } catch {}
  }
  syncCandlePriceFormat();

  cvdOverlay.preparePane(coin, timeframe);
  cvdOscillatorOverlay.preparePane(coin, timeframe);
  const snapshotRevisionChanged = candleSnapshotRevision !== lastCandleSnapshotRevision;
  if (snapshotRevisionChanged || shouldRecreateMainSeries || nextCandles.length === 0) {
    liveCandleProjection.reset();
  }
  let phaseStartedAt = globalThis.performance?.now?.() ?? 0;
  syncSeries({ candles: nextCandles, timeframe, coin, force: snapshotRevisionChanged });
  recordChartPhase('main-series', phaseStartedAt, { coin, timeframe, count: nextCandles.length });

  const candleOverlayOpts = AppState.ui.candleOverlay || {};
  const candleOverlayActive = candleOverlayOpts.mode && candleOverlayOpts.mode !== 'off';
  candleOverlay.setOptions({
    mode: candleOverlayOpts.mode || 'off',
    baseCandles: candleOverlayOpts.baseCandles || 'dimmed',
    contrast: typeof candleOverlayOpts.contrast === 'number' ? candleOverlayOpts.contrast : 0.5,
    heikinAshi: candleOverlayOpts.heikinAshi,
    renko: candleOverlayOpts.renko,
  });
  const syncCandleOverlay = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    if (candleOverlayActive) {
      candleOverlay.setCandles(nextCandles, coin, timeframe, { closedCandles: indicatorCandles });
      if (paletteThemeChanged) candleOverlay.applyTheme();
    } else {
      candleOverlay.detach();
    }
    recordChartPhase('candle-overlay', startedAt, { coin, timeframe, count: nextCandles.length });
  };
  syncCandleOverlay();

  manualAnchoredVwapOverlay.setOptions({
    visible: AppState.ui.manualAnchoredVwapVisible === true,
  });
  const syncManualAnchoredVwap = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    manualAnchoredVwapOverlay.setCandles(indicatorCandles, coin, timeframe, candleSnapshotRevision);
    if (paletteThemeChanged) manualAnchoredVwapOverlay.applyTheme();
    recordChartPhase('manual-avwap', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };

  sessionVwapOverlay.setOptions({
    daily: AppState.ui.sessionVwap?.daily === true,
    weekly: AppState.ui.sessionVwap?.weekly === true,
    monthly: AppState.ui.sessionVwap?.monthly === true,
  });
  const syncSessionVwap = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    sessionVwapOverlay.setCandles(indicatorCandles, coin, timeframe, candleSnapshotRevision);
    if (paletteThemeChanged) sessionVwapOverlay.applyTheme();
    recordChartPhase('session-vwap', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };

  rvwapOverlays.setEnabledLookbacks(AppState.ui.rvwapLookbacks);
  rvwapOverlays.setBandsEnabledLookbacks(AppState.ui.rvwapBandLookbacks);
  const rvwapStatus = AppState.market.rvwapSource || {};
  const rvwapSource = rvwapSourceRowsForCoin(coin);
  const closedRvwapSource = selectClosedCandles(rvwapSource, '4h');
  rvwapIndicatorSourceDebug = closedSourceDebug(rvwapSource, closedRvwapSource);
  const syncRvwap = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    rvwapOverlays.setCandles(
      closedRvwapSource,
      coin,
      '4h',
      Number(rvwapStatus.loadedAt || 0),
      { displayCandles: indicatorCandles, displayTimeframe: timeframe },
    );
    if (paletteThemeChanged) rvwapOverlays.applyTheme();
    recordChartPhase('rvwap', startedAt, { coin, timeframe, count: closedRvwapSource.length });
  };

  const monthlyVolumeProfileVisible = AppState.ui.monthlyVolumeProfileVisible === true;
  const syncMonthlyVolumeProfile = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    if (monthlyVolumeProfileVisible) {
      monthlyVolumeProfileOverlay.setPeriod?.(AppState.ui.volumeProfilePeriod || 'visible');
      monthlyVolumeProfileOverlay.setLvnVisible?.(AppState.ui.volumeProfileLvnVisible !== false);
      monthlyVolumeProfileOverlay.setCandles(indicatorCandles, coin, timeframe, candleSnapshotRevision);
      if (paletteThemeChanged) monthlyVolumeProfileOverlay.applyTheme();
    } else {
      monthlyVolumeProfileOverlay.detach();
    }
    recordChartPhase('monthly-profile', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };

  const liquidationClustersVisible = AppState.ui.liquidationClustersVisible === true;
  liquidationClustersOverlay.setOptions({
    visible: liquidationClustersVisible,
  });
  const syncLiquidationClusters = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    if (liquidationClustersVisible) {
      liquidationClustersOverlay.updateLiquidations(AppState.market?.marketLiquidations || [], coin);
      if (paletteThemeChanged) liquidationClustersOverlay.applyTheme();
    } else {
      liquidationClustersOverlay.detach();
    }
    recordChartPhase('liquidation-clusters', startedAt, { coin, count: (AppState.market?.marketLiquidations || []).length });
  };

  const whaleMarkersVisible = AppState.ui.whaleMarkersVisible === true;
  whaleMarkersOverlay.setOptions({
    visible: whaleMarkersVisible,
    minNotional: AppState.ui.whaleMarkerMinNotional || 100000,
  });
  const syncWhaleMarkers = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    if (whaleMarkersVisible) {
      whaleMarkersOverlay.setCandles(indicatorCandles, coin, timeframe);
      if (paletteThemeChanged) whaleMarkersOverlay.applyTheme();
    } else {
      whaleMarkersOverlay.detach();
    }
    recordChartPhase('whale-markers', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };

  const priceProjectionVisible = AppState.ui.priceProjectionVisible === true;
  priceProjectionOverlay.setOptions({
    visible: priceProjectionVisible,
  });
  const syncPriceProjection = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    if (priceProjectionVisible) {
      priceProjectionOverlay.setCandles(
        indicatorCandles,
        coin,
        timeframe,
        candleSnapshotRevision,
      );
      if (paletteThemeChanged) priceProjectionOverlay.applyTheme();
    }
    recordChartPhase('price-projection', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };

  const weekPathProjectionVisible = AppState.ui.weekPathProjectionVisible === true;
  weekPathProjectionOverlay.setOptions({
    visible: weekPathProjectionVisible,
    envelopeVisible: AppState.ui.weekPathEnvelopeVisible !== false,
  });
  const syncWeekPathProjection = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    if (weekPathProjectionVisible) {
      weekPathProjectionOverlay.setCandles(
        indicatorCandles,
        coin,
        timeframe,
        candleSnapshotRevision,
      );
      if (paletteThemeChanged) weekPathProjectionOverlay.applyTheme();
    }
    recordChartPhase('week-path-projection', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };

  cvdOscillatorOverlay.setLookback(AppState.ui.cvdOscillatorLookback || '90D');
  const syncCvd = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    cvdOverlay.setCandles(indicatorCandles, coin, timeframe, candleSnapshotRevision);
    if (paletteThemeChanged) cvdOverlay.applyTheme();
    recordChartPhase('cvd', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };
  const syncCvdOscillator = () => {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    cvdOscillatorOverlay.setCandles(indicatorCandles, coin, timeframe, candleSnapshotRevision);
    if (paletteThemeChanged) cvdOscillatorOverlay.applyTheme();
    recordChartPhase('cvd-oscillator', startedAt, { coin, timeframe, count: indicatorCandles.length });
  };
  const overlayPhases = [
    syncRvwap,
    syncManualAnchoredVwap,
    syncSessionVwap,
    syncMonthlyVolumeProfile,
    syncLiquidationClusters,
    syncWhaleMarkers,
    syncPriceProjection,
    syncWeekPathProjection,
    syncCvd,
    syncCvdOscillator,
  ];
  // Always frame-slice overlay work after the candle `setData`. A 1M/1w
  // history is short enough to miss a 1,500-bar gate but still expensive
  // with RVWAP + CVD + profile in the same switch frame. The unit-test stub
  // has no real rAF turn, so it runs phases inline.
  if (indicatorCandles.length > 0 && !globalThis.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__) {
    const lastIndicator = indicatorCandles[indicatorCandles.length - 1];
    const deferredKey = [
      coin,
      timeframe,
      candleSnapshotRevision,
      indicatorCandles.length,
      normalizedCandleTime(lastIndicator),
      AppState.ui.cvdOscillatorLookback || '90D',
      AppState.ui.manualAnchoredVwapVisible === true ? 1 : 0,
      AppState.ui.sessionVwap?.daily === true ? 1 : 0,
      AppState.ui.sessionVwap?.weekly === true ? 1 : 0,
      AppState.ui.sessionVwap?.monthly === true ? 1 : 0,
      monthlyVolumeProfileVisible ? 1 : 0,
      liquidationClustersVisible ? 1 : 0,
      whaleMarkersVisible ? 1 : 0,
      AppState.ui.whaleMarkerMinNotional || 100000,
      priceProjectionVisible ? 1 : 0,
      weekPathProjectionVisible ? 1 : 0,
      AppState.ui.weekPathEnvelopeVisible !== false ? 1 : 0,
      candleOverlayActive
        ? `${candleOverlayOpts.mode}:${candleOverlayOpts.baseCandles}:${candleOverlayOpts.contrast}:${candleOverlayOpts.heikinAshi?.showWicks}:${candleOverlayOpts.heikinAshi?.dimmed}:${candleOverlayOpts.heikinAshi?.opacity}:${candleOverlayOpts.renko?.brickMode}:${candleOverlayOpts.renko?.fixedSize}:${candleOverlayOpts.renko?.percent}:${candleOverlayOpts.renko?.atrPeriod}:${candleOverlayOpts.renko?.showWicks}:${candleOverlayOpts.renko?.dimmed}:${candleOverlayOpts.renko?.opacity}`
        : 'off',
      (AppState.ui.rvwapLookbacks || []).join(','),
      (AppState.ui.rvwapBandLookbacks || []).join(','),
      Number(rvwapStatus.loadedAt || 0),
      closedRvwapSource.length,
      paletteThemeChanged ? 1 : 0,
    ].join(':');
    scheduleDeferredIndicatorSync(
      deferredKey,
      coin,
      timeframe,
      overlayPhases,
      // Overlay attach can add logical indexes after the first candle fit.
      // Re-fit the requested overview once phases finish if user has not panned or dragged.
      shouldResetDefaultTimeScale ? () => refitOverviewIfUserHasNotPanned() : null,
    );
  } else {
    cancelDeferredIndicatorSync();
    for (const phase of overlayPhases) phase();
  }
  lastCandleSnapshotRevision = candleSnapshotRevision;

  // User drawings persist per coin and are anchored by time, so they survive a
  // timeframe change; setCoin only reloads when the coin actually changes.
  drawingToolsOverlay.setCoin(coin);

  const ts = activeChart.timeScale();

  // A pair/timeframe switch (or explicit Fit) should frame to the new data, so
  // clear any manual vertical pan by re-enabling price auto-fit. History
  // prepend only requests a shifted logical range (no autoScale reset) so
  // backfill scroll preserves the user's manual vertical offset.
  if (shouldResetDefaultTimeScale) {
    getCandleSeries()?.priceScale?.()?.setAutoScale?.(true);
  }

  if (nextCandles.length > 0 && (
    shouldResetDefaultTimeScale
    || forceVisibleRange
    || hasPendingVisibleLogicalRange()
  )) {
    const pendingLogical = consumePendingVisibleLogicalRange();
    if (shouldResetDefaultTimeScale) {
      // Fit the complete active candle history using official chart-wide
      // logical indexes. This keeps overlays from expanding the default view;
      // dense sub-pixel bars are handled by Lightweight Charts conflation and
      // progressively resolve to original candles as the user zooms in.
      withSuppressedVisibleRangeEvents(() => {
        fitSucceeded = fitActiveCandleViewport(ts) === true;
      });
      if (fitSucceeded) lastOverviewSelectionKey = selectionKey;
    } else if (pendingLogical) {
      withSuppressedVisibleRangeEvents(() => {
        ts.setVisibleLogicalRange(pendingLogical);
      });
      fitSucceeded = true;
    } else {
      const from = Math.max(0, viewStart);
      const to = Math.max(from + 1, Math.min(nextCandles.length, from + Math.max(1, viewCount)));
      withSuppressedVisibleRangeEvents(() => {
        ts.setVisibleLogicalRange({ from, to: to - 1 });
      });
      fitSucceeded = true;
    }
  }

  recordChartPhase('total', totalStartedAt, { coin, timeframe, count: nextCandles.length });

  return { ok: true, fitSucceeded };
}

/**
 * Apply a single live candle update to the series via series.update().
 * This is the canonical lightweight-charts real-time update pattern.
 *
 * Called from bufferLiveChartCandle() in chart-render.js when a WebSocket
 * candle arrives. The library handles:
 *   - Same time as last bar → replaces the last bar (update HLC)
 *   - New time              → appends a new bar
 */
function bufferLiveCandleSync({ candle, candles = [], timeframe = DEFAULT_TIMEFRAME, coin = '' } = {}) {
  const activeChart = ensureChart();
  if (!activeChart || !getCandleSeries()) return false;
  const timeScale = activeChart.timeScale();
  const previousLastTime = getLastSeriesMeta()?.lastTime;
  const overview = activeOverviewState(timeScale);

  // The library's shiftVisibleRangeOnNewBar (default true) handles live-edge
  // stickiness: if the user is at the live edge, the visible range follows
  // new bars; if they have scrolled into history, their view is preserved.
  // No explicit scrollToRealTime() — that would force-animate users back to
  // the live edge every new bucket, hijacking history inspection.
  const ok = updateSeries({ candle, candles, timeframe, coin });
  if (ok) {
    const indicatorCandles = selectClosedCandles(candles, timeframe);
    const nextIndicatorSourceDebug = closedSourceDebug(candles, indicatorCandles);
    const indicatorSourceChanged = nextIndicatorSourceDebug.signature !== indicatorSourceDebug.signature;
    indicatorSourceDebug = nextIndicatorSourceDebug;
    preserveOverviewAfterAppend(timeScale, candle, previousLastTime, overview);
    const rvwapStatus = AppState.market.rvwapSource || {};
    const rvwapSource = rvwapSourceRowsForCoin(coin);
    if (indicatorSourceChanged) {
      if (
        deferredIndicatorPending
        && (AppState.trading.currentCoin || '') === coin
        && (AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME) === timeframe
      ) {
        // A closed candle can arrive during the four-frame cold rebuild. Keep
        // only the newest update and apply it after every overlay owns its full
        // history, avoiding a transient one-row CVD state.
        deferredIndicatorLiveUpdate = {
          candles: indicatorCandles,
          rawCandles: candles,
          coin,
          timeframe,
        };
      } else {
        manualAnchoredVwapOverlay.updateLast(indicatorCandles, coin, timeframe);
        sessionVwapOverlay.updateLast(indicatorCandles, timeframe);
        if (AppState.ui.monthlyVolumeProfileVisible === true) monthlyVolumeProfileOverlay.updateLast(indicatorCandles, timeframe);
        if (AppState.ui.liquidationClustersVisible === true) {
          liquidationClustersOverlay.updateLiquidations(AppState.market?.marketLiquidations || [], coin);
        }
        if (AppState.ui.whaleMarkersVisible === true) {
          whaleMarkersOverlay.updateLast(indicatorCandles, timeframe);
        }
        if (AppState.ui.priceProjectionVisible === true) {
          priceProjectionOverlay.updateLast(
            indicatorCandles,
            coin,
            timeframe,
            AppState.market.candleSnapshotRevision,
          );
        }
        if (AppState.ui.weekPathProjectionVisible === true) {
          weekPathProjectionOverlay.updateLast(
            indicatorCandles,
            coin,
            timeframe,
            AppState.market.candleSnapshotRevision,
          );
        }
        cvdOverlay.updateLast(indicatorCandles, coin, timeframe);
        cvdOscillatorOverlay.updateLast(indicatorCandles, coin, timeframe);
        if (AppState.ui.candleOverlay?.mode && AppState.ui.candleOverlay.mode !== 'off') {
          candleOverlay.updateLast(candles, coin, timeframe, { closedCandles: indicatorCandles });
        }
      }
    }
    if (indicatorSourceChanged && Array.isArray(rvwapSource) && rvwapSource.length > 0) {
      const closedRvwapSource = selectClosedCandles(rvwapSource, '4h');
      const nextRvwapSourceDebug = closedSourceDebug(rvwapSource, closedRvwapSource);
      const rvwapSourceChanged = nextRvwapSourceDebug.signature !== rvwapIndicatorSourceDebug.signature;
      rvwapIndicatorSourceDebug = nextRvwapSourceDebug;
      const display = { displayCandles: indicatorCandles, displayTimeframe: timeframe };
      if (rvwapSourceChanged) {
        rvwapOverlays.updateLast(closedRvwapSource, '4h', display);
      }
      // Unchanged 4h source + a closed display bar: clip set is unchanged
      // unless the new time is itself a 4h open, in which case the source
      // also moved and took the updateLast path. Do not full-rebuild RVWAP.
    }
  }
  return ok;
}

function bufferLiveRvwapSource({ coin = '', candles = [] } = {}) {
  const status = AppState.market.rvwapSource || {};
  if (status.coin !== coin || status.status !== 'ready' || !Array.isArray(candles) || candles.length === 0) {
    return false;
  }
  const closedRvwapSource = selectClosedCandles(candles, '4h');
  const displayCandles = AppState.market.candles || [];
  const displayTimeframe = AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME;
  const closedDisplayCandles = selectClosedCandles(displayCandles, displayTimeframe);
  const nextRvwapSourceDebug = closedSourceDebug(candles, closedRvwapSource);
  const rvwapSourceChanged = nextRvwapSourceDebug.signature !== rvwapIndicatorSourceDebug.signature;
  rvwapIndicatorSourceDebug = nextRvwapSourceDebug;
  indicatorSourceDebug = closedSourceDebug(displayCandles, closedDisplayCandles);
  if (!rvwapSourceChanged) return true;
  rvwapOverlays.updateLast(
    closedRvwapSource,
    '4h',
    {
      displayCandles: closedDisplayCandles,
      displayTimeframe,
    },
  );
  return true;
}

/**
 * Project only the forming native candle from the same price that drives the
 * live price line. Canonical exchange state and derived indicators are not
 * mutated or recalculated here.
 */
function syncProjectedLiveCandle({ price, candles = [], timeframe = DEFAULT_TIMEFRAME, coin = '', now = Date.now() } = {}) {
  const activeChart = getChart() || ensureChart();
  const lastMeta = getLastSeriesMeta();
  if (!activeChart || !getCandleSeries() || !lastMeta || lastMeta.coin !== coin || lastMeta.timeframe !== timeframe || lastMeta.length === 0) {
    return false;
  }
  const candle = liveCandleProjection.project({ candles, timeframe, coin, price, now });
  if (!candle) return false;
  const timeScale = activeChart.timeScale();
  const overview = activeOverviewState(timeScale);
  const updated = updateSeries({
    candle,
    candles,
    timeframe,
    coin,
    updateKind: 'projection',
    preserveCanonicalMeta: true,
  });
  if (updated) preserveOverviewAfterAppend(timeScale, candle, lastMeta.lastTime, overview);
  return updated;
}

function removeLightweightChart() {
  removeChart();
}

function getLightweightChartDebugState(options = {}) {
  const exchangeCandles = AppState.market.candles || [];
  const closedExchangeCandles = selectClosedCandles(
    exchangeCandles,
    AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME,
  );
  let canonicalInvalidCount = 0;
  let canonicalDuplicateCount = 0;
  let canonicalOutOfOrderCount = 0;
  const seenTimes = new Set();
  let previousTime = 0;
  for (const candle of exchangeCandles) {
    const rawTime = Number(candle?.t || 0);
    const time = rawTime >= 100_000_000_000 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
    const open = Number(candle?.o);
    const high = Number(candle?.h);
    const low = Number(candle?.l);
    const close = Number(candle?.c);
    const volume = Number(candle?.v);
    if (!(time > 0) || ![open, high, low, close, volume].every(Number.isFinite)
      || volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      canonicalInvalidCount += 1;
    }
    if (seenTimes.has(time)) canonicalDuplicateCount += 1;
    if (previousTime > 0 && time <= previousTime) canonicalOutOfOrderCount += 1;
    seenTimes.add(time);
    previousTime = time;
  }
  const drawingState = Object.fromEntries(
    Object.entries(drawingToolsOverlay._overlays).map(([pane, overlay]) => {
      const state = overlay.getState();
      return [pane, {
        coin: state.coin,
        drawingCount: state.drawings.length,
        activeTool: state.activeTool,
        selectedId: state.selectedId,
        pendingPointCount: state.pending?.points?.length || 0,
      }];
    })
  );
  const coreDebug = getLightweightChartCoreDebugState();
  const conflationFactor = coreDebug.timeScaleConflationEnabled
    ? calculateChartConflationFactor(
      coreDebug.timeScaleBarSpacing,
      globalThis?.devicePixelRatio || 1,
      coreDebug.timeScaleConflationThresholdFactor
        ?? DEFAULT_CHART_CONFLATION_THRESHOLD_FACTOR,
    )
    : 1;
  const visibleLogicalRange = coreDebug.visibleLogicalRange;
  const overviewLogicalRange = lastOverviewLogicalRange
    ? { ...lastOverviewLogicalRange }
    : null;
  const overviewCoversLoadedCandles = Boolean(
    visibleLogicalRange
    && overviewLogicalRange
    && Number(visibleLogicalRange.from) <= Number(overviewLogicalRange.from) + 0.01
    && Number(visibleLogicalRange.to) >= Number(overviewLogicalRange.to) - 0.01
  );
  return {
    ...coreDebug,
    ...getPriceLineDebugState(),
    ...getSeriesSyncDebugState(),
    ...liveCandleProjection.getDebugState(),
    candleOverlay: candleOverlay.getDebugState(),
    indicators: {
      manualAnchoredVwap: manualAnchoredVwapOverlay.getDebugState(),
      sessionVwap: sessionVwapOverlay.getDebugState(),
      vwapBands: rvwapOverlays.getDebugState(),
      priceProjection: priceProjectionOverlay.getDebugState(),
      weekPathProjection: weekPathProjectionOverlay.getDebugState(),
      monthlyVolumeProfile: monthlyVolumeProfileOverlay.getDebugState(),
      volumeProfile: monthlyVolumeProfileOverlay.getDebugState(),
      liquidationClusters: liquidationClustersOverlay.getDebugState(),
      whaleMarkers: whaleMarkersOverlay.getDebugState(),
      candleOverlay: candleOverlay.getDebugState(),
      cvd: cvdOverlay.getDebugState(),
      cvdOscillator: cvdOscillatorOverlay.getDebugState(),
    },
    drawings: drawingState,
    candleIntegrity: { ...(AppState.market.candleIntegrity || {}) },
    candleSnapshotRevision: AppState.market.candleSnapshotRevision || 0,
    rvwapSource: { ...(AppState.market.rvwapSource || {}) },
    indicatorSource: { ...indicatorSourceDebug },
    rvwapIndicatorSource: { ...rvwapIndicatorSourceDebug },
    canonicalInvalidCount,
    canonicalDuplicateCount,
    canonicalOutOfOrderCount,
    exchangeCandleCount: exchangeCandles.length,
    selection: {
      coin: AppState.trading.currentCoin || '',
      timeframe: AppState.trading.currentTimeframe || '',
      chartSession: AppState.ui.chartSession ? {
        status: AppState.ui.chartSession.status || '',
        coin: AppState.ui.chartSession.coin || '',
        timeframe: AppState.ui.chartSession.timeframe || '',
      } : null,
    },
    overviewLogicalRange,
    overviewCoversLoadedCandles,
    visibleLogicalSlotCount: visibleLogicalRange
      ? Math.max(0, Number(visibleLogicalRange.to) - Number(visibleLogicalRange.from) + 1)
      : 0,
    conflation: {
      enabled: coreDebug.timeScaleConflationEnabled,
      active: conflationFactor > 1,
      factor: conflationFactor,
      thresholdFactor: coreDebug.timeScaleConflationThresholdFactor
        ?? DEFAULT_CHART_CONFLATION_THRESHOLD_FACTOR,
      devicePixelRatio: Math.max(1, Number(globalThis?.devicePixelRatio) || 1),
      effectiveBarSpacing: Number.isFinite(coreDebug.timeScaleBarSpacing)
        ? coreDebug.timeScaleBarSpacing * conflationFactor
        : null,
    },
    firstExchangeCandle: exchangeCandles[0] ? { ...exchangeCandles[0] } : null,
    lastExchangeCandle: exchangeCandles.length ? { ...exchangeCandles[exchangeCandles.length - 1] } : null,
    lastClosedExchangeCandle: closedExchangeCandles.length
      ? { ...closedExchangeCandles[closedExchangeCandles.length - 1] }
      : null,
    ...(options?.includeCanonicalCandles === true ? {
      canonicalCandles: exchangeCandles.map((candle) => ({
        t: candle.t,
        o: candle.o,
        h: candle.h,
        l: candle.l,
        c: candle.c,
        v: candle.v,
        cvdDelta: candle.cvdDelta,
      })),
    } : {}),
  };
}

function recoverChartAfterResume() {
  const result = repaintChartAfterResume();
  try { releaseStuckChartGestures(); } catch {}
  return result;
}

/**
 * After market-stream reconnect, tab resume, series recreate, or a lost
 * pointerup, Draw/AVWAP can leave handleScroll=false. Clear stuck drags and
 * restore the theme navigation surface unless a tool/placement is still armed.
 *
 * Intentionally does NOT treat "isDragging" as keep-locked: after a transport
 * recycle the drag is orphaned (no pointerup will arrive). Overlays clear their
 * drag state first; only deliberate armed placement keeps navigation locked.
 */
function releaseStuckChartGestures() {
  try { drawingToolsOverlay.releaseStuckGestures?.(); } catch {}
  try { manualAnchoredVwapOverlay.releaseStuckGestures?.(); } catch {}
  const chart = getChart();
  if (!chart) return false;
  const keepLocked = drawingToolsOverlay.isToolActive?.() === true
    || manualAnchoredVwapOverlay.isPlacementActive?.() === true;
  if (keepLocked) {
    applyChartNavigation(chart, false);
    return false;
  }
  return applyChartNavigation(chart, true);
}

// Series recreation rebuilds primitives and can drop LC option state. Re-assert
// the intended navigation lock after the new series is live.
onSeriesRecreate(() => {
  lastOverviewSelectionKey = '';
  try { releaseStuckChartGestures(); } catch {}
});

export {
  bufferLiveCandleSync,
  bufferLiveRvwapSource,
  barsInLogicalRange,
  clearAllPriceLines,
  clearPendingVisibleRangeRequests,
  coordinateToPrice,
  drawingToolsOverlay,
  manualAnchoredVwapOverlay,
  sessionVwapOverlay,
  monthlyVolumeProfileOverlay,
  monthlyVolumeProfileOverlay as volumeProfileOverlay,
  liquidationClustersOverlay,
  whaleMarkersOverlay,
  candleOverlay,
  priceProjectionOverlay,
  weekPathProjectionOverlay,
  getCandleSeries,
  getChart,
  getLightweightChartDebugState,
  getLivePriceLineAgeMs,
  invalidateLivePriceLine,
  fitLightweightChartToCandles,
  recenterPriceScale,
  repositionLineLabels,
  priceToCoordinate,
  recoverChartAfterResume,
  releaseStuckChartGestures,
  removeLightweightChart,
  requestVisibleLogicalRange,
  setVisibleRangeListener,
  syncLightweightChart,
  syncLivePriceLine,
  syncProjectedLiveCandle,
  syncOrderLabels,
  syncOrderLines,
  syncPositionLabels,
  syncPositionLines,
  syncPreviewLines,
  syncJevSignalLines,
};
