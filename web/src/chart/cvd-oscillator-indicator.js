import {
  CvdOscillator,
  NEUTRAL_COLOR,
} from './cvd-oscillator.js';
import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
import { mutateOverlaySeries } from './overlay-series-mutate.js';

const PANE_INDEX = 2;
const PANE_STRETCH = 0.3333;
const SCALE_MARGIN = 0.1;
const REFERENCE_LINE_COLOR = 'rgba(120,130,140,0.45)';
const LOOKBACK_DAYS = { '3D': 3, '10D': 10, '20D': 20, '30D': 30, '90D': 90 };
const DEFAULT_LOOKBACK_DAYS = 90;
const OUTLINE_ALPHA = '0.90';

function outlineColor(value) {
  if (Number(value) > 0) return colorWithAlpha(getPaletteColor('bullish'), OUTLINE_ALPHA);
  if (Number(value) < 0) return colorWithAlpha(getPaletteColor('bearish'), OUTLINE_ALPHA);
  return 'rgba(150,150,150,0.75)';
}

function paletteColor(value) {
  if (Number(value) > 0) return colorWithAlpha(getPaletteColor('bullish'), 0.50);
  if (Number(value) < 0) return colorWithAlpha(getPaletteColor('bearish'), 0.50);
  return NEUTRAL_COLOR;
}

function paletteRows(rows) {
  return rows.map((row) => {
    if (!row || !Number.isFinite(row.value)) return { time: row?.time };
    return { time: row.time, value: row.value, color: paletteColor(row.value) };
  });
}

function outlineRows(rows) {
  return rows.map((row) => {
    if (!row || !Number.isFinite(row.value)) return { time: row?.time };
    return {
      time: row.time,
      value: row.value,
      color: outlineColor(row.value),
    };
  });
}

function lookbackToDays(value) {
  if (Number.isFinite(value) && value > 0) return value;
  return LOOKBACK_DAYS[value] || DEFAULT_LOOKBACK_DAYS;
}

function shouldRenderOscillator(timeframe = '4h') {
  return timeframe !== '1w' && timeframe !== '1M';
}

function normalizeTimestamp(time) {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
}

function dedupeAndSort(candles) {
  if (!Array.isArray(candles)) return [];
  const byTime = new Map();
  for (const c of candles) {
    const t = normalizeTimestamp(c?.t);
    if (t > 0) byTime.set(t, c);
  }
  return [...byTime.values()].sort((a, b) => normalizeTimestamp(a.t) - normalizeTimestamp(b.t));
}

function candleRangeSignature(candles, coin, timeframe) {
  if (!Array.isArray(candles) || candles.length === 0) return `${coin}:${timeframe}:0`;
  const firstTime = normalizeTimestamp(candles[0]?.t);
  const lastTime = normalizeTimestamp(candles[candles.length - 1]?.t);
  return `${coin}:${timeframe}:${candles.length}:${firstTime}:${lastTime}`;
}

function lastCandleTime(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return 0;
  return normalizeTimestamp(candles[candles.length - 1]?.t);
}

export function createCvdOscillatorOverlay({ getChart, HistogramSeries, LineSeries, lookback = DEFAULT_LOOKBACK_DAYS } = {}) {
  if (typeof getChart !== 'function' || !HistogramSeries || !LineSeries) {
    throw new Error('createCvdOscillatorOverlay requires getChart, HistogramSeries, and LineSeries');
  }

  let lookbackDays = lookbackToDays(lookback);
  let attachedChart = null;
  let series = null;
  let outlineSeries = null;
  let lastSig = '';
  let lastCandleRangeSig = '';
  let lastAcceptedCandleTime = 0;
  let lastCoin = '';
  let lastTimeframe = '';
  let lastCandles = null;
  let lastSnapshotRevision = -1;
  let lastRowCount = 0;
  let lastRows = [];
  const initializedCharts = new WeakSet();

  function getOwnPane() {
    if (!series || typeof series.getPane !== 'function') return null;
    try { return series.getPane(); } catch { return null; }
  }

  function preservePane() {
    const pane = getOwnPane();
    if (!pane) return;
    try {
      if (typeof pane.setPreserveEmptyPane === 'function') pane.setPreserveEmptyPane(true);
    } catch {}
  }

  function lockInitialStretch() {
    const pane = getOwnPane();
    if (pane) {
      try {
        if (typeof pane.setStretchFactor === 'function') pane.setStretchFactor(PANE_STRETCH);
      } catch {}
    }
    preservePane();
  }

  function addReferenceLines() {
    if (!series || typeof series.createPriceLine !== 'function') return;
    const lines = [
      { price: 1, color: REFERENCE_LINE_COLOR },
      { price: -1, color: REFERENCE_LINE_COLOR },
    ];
    for (const line of lines) {
      try {
        series.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: 1,
          axisLabelVisible: true,
          title: '',
        });
      } catch {}
    }
  }

  function detach() {
    if (attachedChart) {
      if (outlineSeries) {
        try { attachedChart.removeSeries(outlineSeries); } catch {}
      }
      if (series) {
        try { attachedChart.removeSeries(series); } catch {}
      }
    }
    attachedChart = null;
    series = null;
    outlineSeries = null;
    lastSig = '';
    lastCandleRangeSig = '';
    lastAcceptedCandleTime = 0;
    lastSnapshotRevision = -1;
    lastRowCount = 0;
    lastRows = [];
  }

  function attachIfNeeded() {
    const chart = getChart();
    if (!chart) return false;
    if (attachedChart === chart && series && outlineSeries) {
      preservePane();
      return true;
    }
    detach();
    try {
      attachedChart = chart;
      series = chart.addSeries(HistogramSeries, {
        priceScaleId: 'cvdOsc',
        priceLineVisible: false,
        lastValueVisible: true,
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: -1, maxValue: 1 },
        }),
      }, PANE_INDEX);
      outlineSeries = chart.addSeries(LineSeries, {
        color: 'rgba(150,150,150,0.75)',
        lineWidth: 1,
        priceScaleId: 'cvdOsc',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      }, PANE_INDEX);
      try {
        series.priceScale().applyOptions({
          scaleMargins: { top: SCALE_MARGIN, bottom: SCALE_MARGIN },
        });
      } catch {}
      addReferenceLines();
      if (initializedCharts.has(chart)) {
        preservePane();
      } else {
        lockInitialStretch();
        initializedCharts.add(chart);
      }
      return true;
    } catch (err) {
      console.warn('[cvd-osc] attach failed:', err);
      if (attachedChart && outlineSeries) {
        try { attachedChart.removeSeries(outlineSeries); } catch {}
      }
      if (attachedChart && series) {
        try { attachedChart.removeSeries(series); } catch {}
      }
      attachedChart = null;
      series = null;
      outlineSeries = null;
      return false;
    }
  }

  function buildRows(candles, timeframe = '4h') {
    const sorted = dedupeAndSort(candles);
    return CvdOscillator.calculate(sorted, { timeframe, lookbackDays });
  }

  function rowsSignature(rows, coin, timeframe) {
    if (!Array.isArray(rows) || rows.length === 0) return `${coin}:${timeframe}:0`;
    const last = rows[rows.length - 1];
    const lastVal = last && Number.isFinite(last.value) ? last.value : 'w';
    return `${coin}:${timeframe}:${rows.length}:${last?.time || 0}:${lastVal}`;
  }

  function preparePane(coin = '', timeframe = '4h') {
    if (!shouldRenderOscillator(timeframe)) {
      detach();
      lastCoin = coin;
      lastTimeframe = timeframe;
      return false;
    }
    if (coin !== lastCoin || timeframe !== lastTimeframe) detach();
    if (!attachIfNeeded()) return false;
    lastCoin = coin;
    lastTimeframe = timeframe;
    return true;
  }

  function setCandles(candles, coin = '', timeframe = '4h', snapshotRevision = 0) {
    if (!shouldRenderOscillator(timeframe)) {
      detach();
      lastCoin = coin;
      lastTimeframe = timeframe;
      lastCandles = Array.isArray(candles) ? candles : null;
      return;
    }
    if (coin !== lastCoin || timeframe !== lastTimeframe) detach();
    if (!attachIfNeeded()) return;
    lastCandles = Array.isArray(candles) ? candles : null;
    lastCoin = coin;
    lastTimeframe = timeframe;
    const rangeSig = candleRangeSignature(candles, coin, timeframe);
    const snapshotChanged = snapshotRevision !== lastSnapshotRevision;
    if (!snapshotChanged && rangeSig === lastCandleRangeSig && lastSig) return;
    const rows = paletteRows(buildRows(candles, timeframe));
    lastRowCount = rows.length;
    const sig = rowsSignature(rows, coin, timeframe);
    lastCandleRangeSig = rangeSig;
    lastAcceptedCandleTime = lastCandleTime(candles);
    lastSnapshotRevision = snapshotRevision;
    // rowsSignature intentionally stays cheap for ordinary renders. A
    // recovered snapshot can nevertheless revise an interior point while
    // leaving the last oscillator value unchanged, so it must win over that
    // fast-path.
    if (!snapshotChanged && sig === lastSig) return;
    lastRows = rows;
    try {
      try { attachedChart?.clearCrosshairPosition?.(); } catch {}
      series.setData(rows);
      outlineSeries.setData(outlineRows(rows));
    } catch (err) {
      console.warn('[cvd-osc] setData failed:', err);
    }
    lastSig = sig;
  }

  function updateLast(candles, coin = '', timeframe = '4h') {
    if (!shouldRenderOscillator(timeframe)) {
      detach();
      return;
    }
    if (coin !== lastCoin || timeframe !== lastTimeframe) {
      setCandles(candles, coin, timeframe);
      return;
    }
    if (!attachIfNeeded()) return;
    if (!Array.isArray(candles) || candles.length === 0) return;
    const nextLastTime = lastCandleTime(candles);
    // The latest oscillator row is based on the previous completed candle
    // (see CvdOscillator rawDist). Same-bucket OHLC/CVD changes therefore
    // cannot change it; defer the O(n) calculation until a new bucket opens.
    if (!(nextLastTime > lastAcceptedCandleTime)) return;

    const rows = paletteRows(buildRows(candles, timeframe));
    lastRowCount = rows.length;
    const latestRow = rows[rows.length - 1];
    const nextSig = rowsSignature(rows, coin, timeframe);
    if (nextSig === lastSig) return;
    lastCandles = candles;
    lastCandleRangeSig = candleRangeSignature(candles, coin, timeframe);
    lastAcceptedCandleTime = nextLastTime;
    lastSig = nextSig;
    lastRows = rows;
    if (!latestRow) return;
    mutateOverlaySeries(series, latestRow, {
      getChart,
      rebuild: () => lastRows,
    });
    mutateOverlaySeries(outlineSeries, outlineRows([latestRow])[0], {
      getChart,
      rebuild: () => outlineRows(lastRows),
    });
  }

  function setLookback(next) {
    const days = lookbackToDays(next);
    if (days === lookbackDays) return;
    lookbackDays = days;
    lastSig = '';
    lastCandleRangeSig = '';
    lastAcceptedCandleTime = 0;
  }

  function getSeries() {
    return series;
  }

  function applyTheme() {
    if (!series || !outlineSeries || !lastRows.length) return;
    lastRows = paletteRows(lastRows);
    try {
      try { attachedChart?.clearCrosshairPosition?.(); } catch {}
      series.setData(lastRows);
      outlineSeries.setData(outlineRows(lastRows));
    } catch {}
  }

  const getDebugState = () => {
    const last = lastRows[lastRows.length - 1];
    return {
      attached: Boolean(attachedChart && series),
      lookbackDays,
      rowCount: lastRowCount,
      lastTime: Number(last?.time || 0),
      lastValue: Number.isFinite(last?.value) ? last.value : null,
    };
  };
  return { setCandles, updateLast, preparePane, detach, setLookback, applyTheme, getSeries, getDebugState };
}

export default { createCvdOscillatorOverlay };
