/**
 * Lightweight chart core - bootstrap, lifecycle, container, resize, coords,
 * visible range, theme. Owns the chart/series instance state and exposes
 * accessor + lifecycle hooks for composition modules (lines, series sync).
 */

import { applyThemeIfNeeded as applyChartThemeIfNeeded, buildThemeOptions } from './lightweight-chart-theme.js';
import { AppState } from '../state/store.js';
import { getHyperliquidPriceDecimals } from '../utils/format.js';
import {
  CandlestickSeries as ProductionCandlestickSeries,
  ColorType as ProductionColorType,
  CrosshairMode as ProductionCrosshairMode,
  HistogramSeries as ProductionHistogramSeries,
  LineSeries as ProductionLineSeries,
  LineStyle as ProductionLineStyle,
  createChart as createProductionChart,
  version as lightweightChartsVersion,
} from 'lightweight-charts';

function resolveChartPriceDecimals(coin, refPrice) {
  const decimals = getHyperliquidPriceDecimals(refPrice, coin);
  return Number.isInteger(decimals) ? decimals : 2;
}

function createLightweightChartsStubModule() {
  const createPaneStub = () => ({
    setStretchFactor() {},
    setPreserveEmptyPane() {},
  });

  return {
    CandlestickSeries: Symbol('CandlestickSeries'),
    HistogramSeries: Symbol('HistogramSeries'),
    LineSeries: Symbol('LineSeries'),
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 },
    createChart(_container, options = {}) {
      const chartRoot = typeof document !== 'undefined' ? document.createElement('div') : null;
      if (chartRoot && typeof _container?.appendChild === 'function') _container.appendChild(chartRoot);
      let visibleRange = null;
      let visibleLogicalRange = null;
      let rightPriceScaleVisibleRange = null;
      let rightPriceScaleAutoScale = true;
      const timeScaleOptions = { ...(options.timeScale || {}) };
      let rightOffset = Number(timeScaleOptions.rightOffset || 0);
      const seriesRows = new Map();
      const allTimes = () => [...new Set(
        [...seriesRows.values()]
          .flatMap((rows) => rows.map((row) => Number(row?.time || 0)))
          .filter((time) => Number.isFinite(time) && time > 0)
      )].sort((a, b) => a - b);
      const createSeriesStub = () => {
        const api = {
          setData(rows = []) { seriesRows.set(api, Array.isArray(rows) ? [...rows] : []); },
          update(row) {
            if (!row) return;
            const rows = [...(seriesRows.get(api) || [])];
            const time = Number(row.time || 0);
            const index = rows.findIndex((candidate) => Number(candidate?.time || 0) === time);
            if (index >= 0) rows[index] = row;
            else rows.push(row);
            rows.sort((a, b) => Number(a?.time || 0) - Number(b?.time || 0));
            seriesRows.set(api, rows);
          },
          barsInLogicalRange() { return null; },
          applyOptions() {},
          priceToCoordinate() { return null; },
          coordinateToPrice() { return null; },
          priceScale() {
            return {
              applyOptions() {},
              setAutoScale(on) { rightPriceScaleAutoScale = on === true; },
              getVisibleRange() { return rightPriceScaleVisibleRange; },
            };
          },
          createPriceLine() { return { applyOptions() {} }; },
          removePriceLine() {},
          attachPrimitive() {},
          detachPrimitive() {},
          getPane: createPaneStub,
        };
        seriesRows.set(api, []);
        return api;
      };
      const timeScaleStub = {
        subscribeVisibleLogicalRangeChange() {},
        unsubscribeVisibleLogicalRangeChange() {},
        setVisibleRange(range) { visibleRange = range; },
        getVisibleRange() { return visibleRange; },
        setVisibleLogicalRange(range) {
          visibleLogicalRange = range;
          const count = Number(range?.to) - Number(range?.from) + 1;
          if (count > 0) timeScaleOptions.barSpacing = 800 / count;
        },
        getVisibleLogicalRange() { return visibleLogicalRange; },
        applyOptions(nextOptions = {}) {
          Object.assign(timeScaleOptions, nextOptions);
          if (Number.isFinite(nextOptions.rightOffset)) rightOffset = nextOptions.rightOffset;
        },
        options() { return { ...timeScaleOptions, barSpacing: Number(timeScaleOptions.barSpacing || 0) }; },
        scrollPosition() { return rightOffset; },
        scrollToPosition(position) { rightOffset = position; },
        timeToIndex(time) {
          const index = allTimes().indexOf(Number(time));
          return index >= 0 ? index : null;
        },
        timeToCoordinate() { return null; },
        width() { return 800; },
        scrollToRealTime() {},
        fitContent() {},
      };
      let autoSize = options.autoSize !== false;
      const api = {
        addSeries() { return createSeriesStub(); },
        applyOptions(nextOptions = {}) {
          if (typeof nextOptions.autoSize === 'boolean') autoSize = nextOptions.autoSize;
        },
        resize(width, height, forceRepaint) {
          api._lastResize = {
            width,
            height,
            forceRepaint: forceRepaint === true,
            autoSize,
          };
        },
        removeSeries(series) { seriesRows.delete(series); },
        remove() { chartRoot?.remove?.(); },
        autoSizeActive() { return autoSize; },
        priceScale() {
          return {
            applyOptions() {},
            getVisibleRange() { return rightPriceScaleVisibleRange; },
            setVisibleRange(range) { rightPriceScaleVisibleRange = range; },
            setAutoScale(on) { rightPriceScaleAutoScale = on === true; },
            options() { return { autoScale: rightPriceScaleAutoScale }; },
          };
        },
        timeScale() { return timeScaleStub; },
        clearCrosshairPosition() {},
      };
      return api;
    },
  };
}

const useTestStub = globalThis.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ === true
  || (typeof window !== 'undefined' && window.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ === true);

const lightweightChartsModule = useTestStub
  ? createLightweightChartsStubModule()
  : {
      CandlestickSeries: ProductionCandlestickSeries,
      ColorType: ProductionColorType,
      CrosshairMode: ProductionCrosshairMode,
      HistogramSeries: ProductionHistogramSeries,
      LineSeries: ProductionLineSeries,
      LineStyle: ProductionLineStyle,
      createChart: createProductionChart,
    };

const {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
} = lightweightChartsModule;

let chart = null;
let candleSeries = null;
let containerEl = null;
let lastThemeKey = '';
let lastPriceFormatKey = '';
let suppressVisibleRangeEvent = false;
let visibleRangeListener = null;
let visibleLogicalRangeChangeHandler = null;
let pendingVisibleLogicalRange = null;
let lastSeriesMeta = null;
let lastDataSignature = '';
let lastInitError = '';
let lastInitLayoutKey = '';
let chartCreateCount = 0;
let layoutObserver = null;
let layoutRepaintQueued = false;
let chartRemoveCount = 0;
let seriesRecreateCount = 0;

const initListeners = new Set();
const teardownListeners = new Set();
const seriesRecreateListeners = new Set();
const resizeListeners = new Set();

function notifyResize(width, height) {
  for (const fn of resizeListeners) {
    try { fn(width, height); } catch {}
  }
}
function getThemeOptions() {
  return buildThemeOptions({
    colorType: ColorType,
    crosshairMode: CrosshairMode,
  });
}

function applyThemeIfNeeded() {
  const { changed, themeKey } = applyChartThemeIfNeeded({
    chart,
    candleSeries,
    lastThemeKey,
    buildTheme: getThemeOptions,
  });
  lastThemeKey = themeKey;
  return changed;
}

function containerHasLayout(container) {
  if (!container) return false;
  const width = Number(container.clientWidth) || Number(container.offsetWidth) || 0;
  const height = Number(container.clientHeight) || Number(container.offsetHeight) || 0;
  return width > 0 && height > 0;
}

function hasHealthyChartDom(container) {
  if (!container || !container.isConnected) return false;
  if (!chart || containerEl !== container) return false;
  return container.childElementCount > 0;
}

function containerLayoutKey(container) {
  if (!container) return '';
  const width = Number(container.clientWidth) || Number(container.offsetWidth) || 0;
  const height = Number(container.clientHeight) || Number(container.offsetHeight) || 0;
  return `${width}x${height}:${container.isConnected ? 1 : 0}`;
}

function canvasContextLost(canvas) {
  if (!canvas) return false;
  try {
    const ctx = canvas.getContext?.('2d');
    return typeof ctx?.isContextLost === 'function' && ctx.isContextLost() === true;
  } catch {
    return false;
  }
}

function chartHasLostContext(container) {
  if (!container) return false;
  const canvases = container.querySelectorAll?.('canvas');
  if (!canvases || canvases.length === 0) return false;
  for (const canvas of canvases) {
    if (canvasContextLost(canvas)) return true;
  }
  return false;
}

function notifyInit() {
  for (const fn of initListeners) {
    try { fn(); } catch {}
  }
}

function notifyTeardown() {
  for (const fn of teardownListeners) {
    try { fn(); } catch {}
  }
}

function notifySeriesRecreate() {
  for (const fn of seriesRecreateListeners) {
    try { fn(); } catch {}
  }
}

function ensureChart() {
  const container = document.getElementById('uplot-chart');
  if (!container) return null;
  if (hasHealthyChartDom(container) && !chartHasLostContext(container)) return chart;
  // A failed initialization is not retried on every render — that floods
  // logs. Retry only when the container layout actually changed (typically
  // a zero-size first paint that later received width/height).
  if (!chart && containerEl === container && lastInitError) {
    const nextLayout = containerLayoutKey(container);
    if (!containerHasLayout(container) || nextLayout === lastInitLayoutKey) {
      return null;
    }
    lastInitError = '';
    containerEl = null;
  }
  // Official LC can throw "Value is null" on a 0×0 container. Wait for layout
  // instead of logging an init failure. Tests keep the stub path so jsdom's
  // zero clientWidth still creates a chart.
  if (!useTestStub && !containerHasLayout(container)) {
    containerEl = container;
    lastInitError = 'zero-size container';
    lastInitLayoutKey = containerLayoutKey(container);
    return null;
  }
  if (chart) removeChart();

  containerEl = container;
  container.innerHTML = '';
  fillChartHost(container);

  const theme = getThemeOptions();
  // No chart-wide localization.priceFormatter: a global formatter overrides
  // every price scale (the library always prefers it over a series' own
  // priceFormat), which would force the CVD pane to use price decimals and
  // render huge cumulative values as 15+ raw digits. Each series formats its
  // own scale instead — the candle series via syncCandlePriceFormat's per-coin
  // precision, the CVD series via its custom trades-style formatter.
  try {
    chart = createChart(container, theme.chart);
    chartCreateCount += 1;
    lastInitError = '';
    lastInitLayoutKey = '';
    container.removeAttribute('data-chart-error');
    bindChartLayoutObserver(container);
  } catch (error) {
    lastInitError = String(error?.message || error || 'unknown chart initialization error');
    lastInitLayoutKey = containerLayoutKey(container);
    container.dataset.chartError = lastInitError;
    console.error(`[chart] Lightweight Charts ${lightweightChartsVersion()} initialization failed:`, error);
    const errorElement = document.createElement('div');
    errorElement.className = 'chart-library-error';
    errorElement.setAttribute('role', 'alert');
    errorElement.textContent = 'Chart unavailable';
    container.replaceChildren(errorElement);
    chart = null;
    candleSeries = null;
    return null;
  }
  createMainSeries(theme);

  lastThemeKey = theme.key;
  lastDataSignature = '';

  const ts = chart.timeScale();
  visibleLogicalRangeChangeHandler = (range) => {
    if (suppressVisibleRangeEvent || !range || typeof visibleRangeListener !== 'function') return;
    visibleRangeListener(range);
  };
  ts.subscribeVisibleLogicalRangeChange(visibleLogicalRangeChangeHandler);
  notifyInit();

  return chart;
}

// Pane layout: candles in pane 0 (stretch 2 — the lightweight-charts default
// for the first pane), filling 2/3 of chart height. The lower third is split
// between CVD (pane 1, stretch 0.6667 ≈ 2/9) and the CVD-distance oscillator
// (pane 2, stretch 0.3333 ≈ 1/9), a 2:1 split.
//
// Stretch is only set on the *first* candle-pane creation per chart instance.
// After that, recreateMainSeries (coin/timeframe change) and the CVD overlay's
// detach/reattach cycles must NOT reset stretch — otherwise any user resize
// of the pane separator would snap back on the next sync. preserveEmptyPane
// keeps the pane alive across removeSeries so its user-set stretch persists.
const CANDLE_PANE_STRETCH = 2;
let candlePaneInitialized = false;

function getPaneFor(series) {
  if (!series || typeof series.getPane !== 'function') return null;
  try { return series.getPane(); } catch { return null; }
}

function preservePane(pane) {
  if (!pane) return;
  try {
    if (typeof pane.setPreserveEmptyPane === 'function') {
      pane.setPreserveEmptyPane(true);
    }
  } catch {}
}

function lockInitialStretch(pane, stretch) {
  if (!pane) return;
  try {
    if (typeof pane.setStretchFactor === 'function') {
      pane.setStretchFactor(stretch);
    }
  } catch {}
  preservePane(pane);
}

function preserveCandlePane() {
  preservePane(getPaneFor(candleSeries));
}

function createMainSeries(theme = getThemeOptions()) {
  if (!chart) return false;
  candleSeries = chart.addSeries(CandlestickSeries, theme.candles);
  if (!candlePaneInitialized) {
    lockInitialStretch(getPaneFor(candleSeries), CANDLE_PANE_STRETCH);
    candlePaneInitialized = true;
  } else {
    // Re-add after coin/timeframe change. Pane already exists with whatever
    // stretch the user (or initial setup) left it at — just keep it preserved.
    preserveCandlePane();
  }
  return true;
}

function recreateMainSeries() {
  if (!chart) return false;
  seriesRecreateCount += 1;
  const theme = getThemeOptions();
  if (typeof chart.removeSeries === 'function') {
    if (candleSeries) {
      try { chart.removeSeries(candleSeries); } catch {}
    }
  }
  notifySeriesRecreate();
  createMainSeries(theme);
  // Price scales are chart-level and persist across series swaps. Any drag on
  // the axis flips the scale out of autoScale and locks the range — without
  // this reset, the next pair/timeframe renders against the old price range
  // and the chart appears blank off-screen.
  try { chart.priceScale('right').applyOptions({ autoScale: true }); } catch {}
  try { chart.priceScale('left').applyOptions({ autoScale: true }); } catch {}
  try { chart.clearCrosshairPosition?.(); } catch {}
  lastThemeKey = theme.key;
  lastDataSignature = '';
  lastSeriesMeta = null;
  lastPriceFormatKey = '';
  return true;
}

function onSeriesRecreate(listener) {
  if (typeof listener === 'function') seriesRecreateListeners.add(listener);
  return () => seriesRecreateListeners.delete(listener);
}

function syncCandlePriceFormat() {
  if (!candleSeries) return;
  const coin = AppState.trading.currentCoin;
  const refPrice = Number(AppState.trading.currentPrice) || 0;
  if (!coin || refPrice <= 0) return;
  const decimals = resolveChartPriceDecimals(coin, refPrice);
  const key = `${coin}:${decimals}`;
  if (key === lastPriceFormatKey) return;
  lastPriceFormatKey = key;
  try {
    candleSeries.applyOptions({
      priceFormat: {
        type: 'price',
        precision: decimals,
        minMove: Math.pow(10, -decimals),
      },
    });
  } catch {}
}

function removeChart() {
  unbindChartLayoutObserver();
  const hadChart = Boolean(chart);
  notifyTeardown();
  if (chart && visibleLogicalRangeChangeHandler) {
    try {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(visibleLogicalRangeChangeHandler);
    } catch {}
  }
  visibleLogicalRangeChangeHandler = null;
  if (chart) {
    try { chart.remove(); } catch {}
  }
  if (hadChart) chartRemoveCount += 1;
  chart = null;
  candleSeries = null;
  containerEl = null;
  candlePaneInitialized = false;
  lastDataSignature = '';
  lastSeriesMeta = null;
  lastPriceFormatKey = '';
  lastInitError = '';
  lastInitLayoutKey = '';
  pendingVisibleLogicalRange = null;
  suppressVisibleRangeEvent = false;
}

function setVisibleRangeListener(listener) {
  visibleRangeListener = listener;
}

function requestVisibleLogicalRange(range) {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
  pendingVisibleLogicalRange = range;
}

function consumePendingVisibleLogicalRange() {
  const range = pendingVisibleLogicalRange;
  pendingVisibleLogicalRange = null;
  return range;
}

function hasPendingVisibleLogicalRange() {
  return Boolean(pendingVisibleLogicalRange);
}

function clearPendingVisibleRangeRequests() {
  pendingVisibleLogicalRange = null;
}

function withSuppressedVisibleRangeEvents(fn) {
  suppressVisibleRangeEvent = true;
  try {
    return fn();
  } finally {
    suppressVisibleRangeEvent = false;
  }
}

function priceToCoordinate(price) {
  if (!candleSeries || !Number.isFinite(price)) return null;
  const y = candleSeries.priceToCoordinate(price);
  return Number.isFinite(y) ? y : null;
}

function coordinateToPrice(y) {
  if (!candleSeries || !Number.isFinite(y)) return null;
  const price = candleSeries.coordinateToPrice(y);
  return Number.isFinite(price) ? price : null;
}

function barsInLogicalRange(range) {
  if (!candleSeries || !range || typeof candleSeries.barsInLogicalRange !== 'function') return null;
  try {
    return candleSeries.barsInLogicalRange(range) || null;
  } catch {
    return null;
  }
}

function getChart() { return chart; }
function getCandleSeries() { return candleSeries; }
function getLastSeriesMeta() { return lastSeriesMeta; }
function setLastSeriesMeta(value) { lastSeriesMeta = value; }
function getLastDataSignature() { return lastDataSignature; }
function setLastDataSignature(value) { lastDataSignature = value; }

function onChartInit(listener) {
  if (typeof listener === 'function') initListeners.add(listener);
  return () => initListeners.delete(listener);
}

function onChartTeardown(listener) {
  if (typeof listener === 'function') teardownListeners.add(listener);
  return () => teardownListeners.delete(listener);
}
function onChartResize(listener) {
  if (typeof listener === 'function') resizeListeners.add(listener);
  return () => resizeListeners.delete(listener);
}


function containerSize(container) {
  if (!container) return { width: 0, height: 0 };
  return {
    width: Number(container.clientWidth) || Number(container.offsetWidth) || 0,
    height: Number(container.clientHeight) || Number(container.offsetHeight) || 0,
  };
}

function chartLayoutHost(container) {
  const wrap = container?.parentElement;
  if (wrap && wrap.id === 'chartWrap') return wrap;
  return container;
}

function fillChartHost(container) {
  if (!container?.style) return;
  container.style.position = 'absolute';
  container.style.inset = '0';
  container.style.width = '100%';
  container.style.height = '100%';
}

function unbindChartLayoutObserver() {
  if (!layoutObserver) return;
  try { layoutObserver.disconnect(); } catch {}
  layoutObserver = null;
  layoutRepaintQueued = false;
}

function bindChartLayoutObserver(container) {
  unbindChartLayoutObserver();
  if (!container || typeof ResizeObserver === 'undefined') return;
  const host = chartLayoutHost(container);
  layoutObserver = new ResizeObserver(() => {
    if (layoutRepaintQueued) return;
    layoutRepaintQueued = true;
    const raf = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    raf(() => {
      layoutRepaintQueued = false;
      forceChartRepaint();
    });
  });
  try { layoutObserver.observe(host); } catch {}
}

function forceChartRepaint() {
  if (!chart || !containerEl) return false;
  fillChartHost(containerEl);
  const { width, height } = containerSize(chartLayoutHost(containerEl));
  if (!(width > 0 && height > 0)) return false;
  try {
    // IChartApi.resize() returns immediately when autoSize is on, so a GPU
    // reset after sleep would never paint. Drop autoSize for one forced
    // resize, then restore it so ResizeObserver stays the layout owner.
    const autoSizeOn = typeof chart.autoSizeActive === 'function' && chart.autoSizeActive() === true;
    if (autoSizeOn) chart.applyOptions({ autoSize: false });
    chart.resize(width, height, true);
    if (autoSizeOn) chart.applyOptions({ autoSize: true });
    // resize() can stamp pixel width/height on the host node. Put 100% back
    // so later window/column/panel resizes still flow through flex layout.
    fillChartHost(containerEl);
    notifyResize(width, height);
    return true;
  } catch {
    fillChartHost(containerEl);
    return false;
  }
}

function repaintChartAfterResume() {
  const container = document.getElementById('uplot-chart') || containerEl;
  if (!container) return { ok: false, recreated: false };
  const lost = chartHasLostContext(container);
  const healthy = hasHealthyChartDom(container);
  if (!healthy || lost) {
    if (chart) removeChart();
    const next = ensureChart();
    return { ok: Boolean(next), recreated: Boolean(next) };
  }
  return { ok: forceChartRepaint(), recreated: false };
}

function getLightweightChartCoreDebugState() {
  let visibleLogicalRange = null;
  let visibleTimeRange = null;
  let timeScaleRightOffset = null;
  let timeScaleBarSpacing = null;
  let timeScaleMinBarSpacing = null;
  let timeScaleConflationEnabled = false;
  let timeScaleConflationThresholdFactor = null;
  let rightPriceScaleVisibleRange = null;
  let rightPriceScaleAutoScale = null;
  let barsInfo = null;
  let paneCount = 0;
  let paneHeights = [];
  try {
    visibleLogicalRange = chart?.timeScale?.().getVisibleLogicalRange?.() || null;
    visibleTimeRange = chart?.timeScale?.().getVisibleRange?.() || null;
    const currentRightOffset = chart?.timeScale?.().scrollPosition?.();
    timeScaleRightOffset = Number.isFinite(currentRightOffset) ? currentRightOffset : null;
    const timeScaleOptions = chart?.timeScale?.().options?.() || {};
    const currentBarSpacing = timeScaleOptions.barSpacing;
    timeScaleBarSpacing = Number.isFinite(currentBarSpacing) ? currentBarSpacing : null;
    const currentMinBarSpacing = timeScaleOptions.minBarSpacing;
    timeScaleMinBarSpacing = Number.isFinite(currentMinBarSpacing) ? currentMinBarSpacing : null;
    timeScaleConflationEnabled = timeScaleOptions.enableConflation === true;
    const currentConflationThresholdFactor = timeScaleOptions.conflationThresholdFactor;
    timeScaleConflationThresholdFactor = Number.isFinite(currentConflationThresholdFactor)
      ? currentConflationThresholdFactor
      : null;
    const rightPriceScale = chart?.priceScale?.('right');
    rightPriceScaleVisibleRange = rightPriceScale?.getVisibleRange?.() || null;
    const rightPriceScaleOptions = rightPriceScale?.options?.() || {};
    rightPriceScaleAutoScale = typeof rightPriceScaleOptions.autoScale === 'boolean'
      ? rightPriceScaleOptions.autoScale
      : null;
    barsInfo = visibleLogicalRange ? barsInLogicalRange(visibleLogicalRange) : null;
    const panes = chart?.panes?.() || [];
    paneCount = panes.length;
    paneHeights = panes.map((pane) => pane.getHeight?.() || 0);
  } catch {}
  return {
    hasChart: Boolean(chart),
    hasCandleSeries: Boolean(candleSeries),
    lastDataSignature,
    libraryVersion: lightweightChartsVersion(),
    lastInitError,
    chartCreateCount,
    chartRemoveCount,
    seriesRecreateCount,
    paneCount,
    paneHeights,
    visibleLogicalRange,
    visibleTimeRange,
    timeScaleRightOffset,
    timeScaleBarSpacing,
    timeScaleMinBarSpacing,
    timeScaleConflationEnabled,
    timeScaleConflationThresholdFactor,
    rightPriceScaleVisibleRange,
    rightPriceScaleAutoScale,
    barsInfo,
    lastSeriesMeta,
  };
}

export {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  preserveCandlePane,
  ensureChart,
  recreateMainSeries,
  removeChart,
  applyThemeIfNeeded,
  syncCandlePriceFormat,
  setVisibleRangeListener,
  requestVisibleLogicalRange,
  consumePendingVisibleLogicalRange,
  hasPendingVisibleLogicalRange,
  clearPendingVisibleRangeRequests,
  withSuppressedVisibleRangeEvents,
  priceToCoordinate,
  coordinateToPrice,
  barsInLogicalRange,
  getChart,
  getCandleSeries,
  getLastSeriesMeta,
  setLastSeriesMeta,
  getLastDataSignature,
  setLastDataSignature,
  onChartInit,
  onChartTeardown,
  onSeriesRecreate,
  onChartResize,
  containerHasLayout,
  forceChartRepaint,
  repaintChartAfterResume,
  getLightweightChartCoreDebugState,
};
