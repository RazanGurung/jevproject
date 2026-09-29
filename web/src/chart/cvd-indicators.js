import {
  CANONICAL_WEEKLY_ANCHOR,
  CVD,
  normalizeCvdAnchorTimeframe,
} from './cvd.js';
import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
import { mutateOverlaySeries } from './overlay-series-mutate.js';
import { DEFAULT_TIMEFRAME } from './chart-history-requirements.js';

const CVD_SUFFIXES = ['K', 'M', 'B', 'T', 'Q'];
function formatCvdValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const sign = num < 0 ? '-' : '';
  let abs = Math.abs(num);
  if (abs < 1000) return `${sign}${abs.toFixed(0)}`;
  let tier = -1;
  while (abs >= 1000 && tier < CVD_SUFFIXES.length - 1) {
    abs /= 1000;
    tier += 1;
  }
  return `${sign}${abs.toFixed(1)}${CVD_SUFFIXES[tier]}`;
}

const DEFAULT_ANCHOR = CANONICAL_WEEKLY_ANCHOR;
const PANE_INDEX = 1;
const SCALE_MARGIN_TOP = 0.1;
const SCALE_MARGIN_BOTTOM = 0.1;
const PANE_STRETCH = 0.6667;
const NEUTRAL_COLOR = 'rgba(120,130,140,0.30)';
const NEUTRAL_OUTLINE_COLOR = 'rgba(120,130,140,0.75)';
const RESET_MARKER_COLOR = 'rgba(170,180,190,0.90)';
const CVD_ALPHA = 0.45;
const OUTLINE_ALPHA = 0.90;
const ANCHOR_ALPHA_BOOST = 0.08;
function colorForValue(value, { isAnchor = false } = {}) {
  const v = Number(value) || 0;
  if (v === 0) return NEUTRAL_COLOR;
  const boosted = isAnchor ? Math.min(1, CVD_ALPHA + ANCHOR_ALPHA_BOOST) : CVD_ALPHA;
  return colorWithAlpha(getPaletteColor(v > 0 ? 'bullish' : 'bearish'), boosted.toFixed(3));
}

function outlineColorForValue(value) {
  const v = Number(value) || 0;
  if (v === 0) return NEUTRAL_OUTLINE_COLOR;
  return colorWithAlpha(getPaletteColor(v > 0 ? 'bullish' : 'bearish'), OUTLINE_ALPHA.toFixed(3));
}

function toHistogramPoint(row) {
  if (!row || row.whitespace || !Number.isFinite(row.value)) {
    return { time: row?.time };
  }
  const point = { time: row.time, value: row.value };
  if (row.color != null) point.color = row.color;
  return point;
}

function outlineRows(rows) {
  return rows.map((row) => {
    if (!row || row.whitespace || !Number.isFinite(row.value)) {
      return { time: row?.time };
    }
    return {
      time: row.time,
      value: row.value,
      color: outlineColorForValue(row.value),
    };
  });
}

function resetMarkerRows(rows) {
  return rows
    .filter((row) => row && !row.whitespace && row.isAnchor && Number.isFinite(row.time))
    .map((row) => ({ time: row.time, value: 0, color: RESET_MARKER_COLOR }));
}

function shouldRenderCvd(timeframe = DEFAULT_TIMEFRAME) {
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
  return [...byTime.values()].sort((a, b) =>
    normalizeTimestamp(a.t) - normalizeTimestamp(b.t));
}

function candleTimeRangeSignature(candles, coin, timeframe, anchorKey) {
  if (!Array.isArray(candles) || candles.length === 0) return `${coin}:${timeframe}:${anchorKey}:0`;
  const firstTime = normalizeTimestamp(candles[0]?.t);
  const lastTime = normalizeTimestamp(candles[candles.length - 1]?.t);
  return `${coin}:${timeframe}:${anchorKey}:${candles.length}:${firstTime}:${lastTime}`;
}

function lastCandleTime(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return 0;
  return normalizeTimestamp(candles[candles.length - 1]?.t);
}

function rowsSignature(rows, coin, timeframe, anchorKey) {
  if (!Array.isArray(rows) || rows.length === 0) return `${coin}:${timeframe}:${anchorKey}:0`;
  const parts = rows.map((row) => {
    if (!row) return 'x';
    if (row.whitespace) return `${row.time || 0}:w`;
    return `${row.time || 0}:${Number(row.value || 0)}:${row.isAnchor ? 1 : 0}`;
  });
  return `${coin}:${timeframe}:${anchorKey}:${parts.join('|')}`;
}

export function createCvdOverlay({ getChart, HistogramSeries, LineSeries, anchorTimeframe = DEFAULT_ANCHOR, anchorStartTime = 0 } = {}) {
  if (typeof getChart !== 'function' || !HistogramSeries || !LineSeries) {
    throw new Error('createCvdOverlay requires getChart, HistogramSeries, and LineSeries');
  }

  let attachedChart = null;
  let series = null;
  let outlineSeries = null;
  let resetMarkerSeries = null;
  let activeAnchorTimeframe = normalizeCvdAnchorTimeframe(anchorTimeframe || DEFAULT_ANCHOR);
  let activeAnchorStartTime = normalizeTimestamp(anchorStartTime);
  let runner = CVD.createState({
    anchorTimeframe: activeAnchorTimeframe,
    anchorStartTime: activeAnchorStartTime,
  });
  let lastSig = '';
  let lastCandleRangeSig = '';
  let lastAcceptedCandleTime = 0;
  let lastCoin = '';
  let lastTimeframe = '';
  let lastCandles = null;
  let lastRows = [];
  let lastResetRows = [];
  let lastSnapshotRevision = -1;
  const initializedCharts = new WeakSet();

  function anchorKey() {
    return `${activeAnchorTimeframe || DEFAULT_ANCHOR}:${activeAnchorStartTime || 0}`;
  }

  function createRunner() {
    return CVD.createState({
      anchorTimeframe: activeAnchorTimeframe || DEFAULT_ANCHOR,
      anchorStartTime: activeAnchorStartTime,
    });
  }

  function detach() {
    if (attachedChart) {
      if (resetMarkerSeries) {
        try { attachedChart.removeSeries(resetMarkerSeries); } catch {}
      }
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
    resetMarkerSeries = null;
    runner = createRunner();
    lastSig = '';
    lastCandleRangeSig = '';
    lastAcceptedCandleTime = 0;
    lastRows = [];
    lastResetRows = [];
    lastSnapshotRevision = -1;
  }

  function getOwnPane() {
    if (!series || typeof series.getPane !== 'function') return null;
    try { return series.getPane(); } catch { return null; }
  }

  function preservePane() {
    const pane = getOwnPane();
    if (!pane) return;
    try {
      if (typeof pane.setPreserveEmptyPane === 'function') {
        pane.setPreserveEmptyPane(true);
      }
    } catch {}
  }

  function lockInitialStretch() {
    const pane = getOwnPane();
    if (!pane) return;
    try {
      if (typeof pane.setStretchFactor === 'function') {
        pane.setStretchFactor(PANE_STRETCH);
      }
    } catch {}
    preservePane();
  }

  function attachIfNeeded() {
    const chart = getChart();
    if (!chart) return false;
    if (attachedChart === chart && series && outlineSeries && resetMarkerSeries) {
      preservePane();
      return true;
    }
    detach();
    try {
      attachedChart = chart;
      series = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'custom', formatter: formatCvdValue, minMove: 1 },
        priceScaleId: 'cvd',
        priceLineVisible: false,
        lastValueVisible: true,
        autoscaleInfoProvider: (baseImplementation) => {
          const res = baseImplementation();
          if (!res || !res.priceRange) return res;
          const m = Math.max(
            Math.abs(res.priceRange.minValue),
            Math.abs(res.priceRange.maxValue),
          ) || 1;
          return { priceRange: { minValue: -m, maxValue: m }, margins: res.margins };
        },
      }, PANE_INDEX);
      outlineSeries = chart.addSeries(LineSeries, {
        color: NEUTRAL_OUTLINE_COLOR,
        lineWidth: 1,
        priceScaleId: 'cvd',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      }, PANE_INDEX);
      resetMarkerSeries = chart.addSeries(LineSeries, {
        color: RESET_MARKER_COLOR,
        lineVisible: false,
        pointMarkersVisible: false,
        pointMarkersRadius: 3,
        priceScaleId: 'cvd',
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      }, PANE_INDEX);
      try {
        series.priceScale().applyOptions({
          scaleMargins: { top: SCALE_MARGIN_TOP, bottom: SCALE_MARGIN_BOTTOM },
        });
      } catch {}
      if (initializedCharts.has(chart)) {
        preservePane();
      } else {
        lockInitialStretch();
        initializedCharts.add(chart);
      }
      return true;
    } catch (err) {
      console.warn('[cvd] attach failed:', err);
      if (attachedChart && resetMarkerSeries) {
        try { attachedChart.removeSeries(resetMarkerSeries); } catch {}
      }
      if (attachedChart && outlineSeries) {
        try { attachedChart.removeSeries(outlineSeries); } catch {}
      }
      if (attachedChart && series) {
        try { attachedChart.removeSeries(series); } catch {}
      }
      attachedChart = null;
      series = null;
      outlineSeries = null;
      resetMarkerSeries = null;
      return false;
    }
  }

  function buildRows(candles) {
    runner = createRunner();
    const sorted = dedupeAndSort(candles);
    const rows = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const row = runner.ingest(sorted[i]);
      if (row) rows.push(row);
    }
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i]?.whitespace) continue;
      rows[i] = { ...rows[i], color: colorForValue(rows[i].value, rows[i]) };
    }
    return rows;
  }

  function setCandles(candles, coin = '', timeframe = '4h', snapshotRevision = 0) {
    const inputCandles = candles;
    if (!shouldRenderCvd(timeframe)) {
      detach();
      lastCoin = coin;
      lastTimeframe = timeframe;
      lastCandles = Array.isArray(inputCandles) ? inputCandles : null;
      return;
    }
    if (coin !== lastCoin || timeframe !== lastTimeframe) {
      detach();
    }
    if (!attachIfNeeded()) return;
    lastCandles = Array.isArray(inputCandles) ? inputCandles : null;
    lastCoin = coin;
    lastTimeframe = timeframe;
    const candleRangeSig = candleTimeRangeSignature(inputCandles, coin, timeframe, anchorKey());
    const snapshotChanged = snapshotRevision !== lastSnapshotRevision;
    if (!snapshotChanged && candleRangeSig === lastCandleRangeSig && lastSig) return;
    const rows = buildRows(inputCandles);
    // A new snapshot revision already requires setData, so avoid allocating a
    // multi-megabyte full-row signature on deep histories. The detailed
    // signature remains available for the rare same-revision rebuild path.
    const sig = snapshotChanged
      ? `${candleRangeSig}:snapshot:${snapshotRevision}`
      : rowsSignature(rows, coin, timeframe, anchorKey());
    lastCandleRangeSig = candleRangeSig;
    lastAcceptedCandleTime = lastCandleTime(inputCandles);
    lastSnapshotRevision = snapshotRevision;
    if (sig === lastSig && !snapshotChanged) return;
    lastRows = rows;
    lastResetRows = resetMarkerRows(rows);
    try {
      try { attachedChart?.clearCrosshairPosition?.(); } catch {}
      series.setData(rows.map(toHistogramPoint));
      outlineSeries.setData(outlineRows(rows));
      resetMarkerSeries.setData(lastResetRows);
    } catch (err) {
      console.warn('[cvd] setData failed:', err);
    }
    lastSig = sig;
  }

  function updateLatestRow(candles, coin = '', timeframe = '4h') {
    const inputCandles = candles;
    const candleRangeSig = candleTimeRangeSignature(inputCandles, coin, timeframe, anchorKey());
    const latestCandle = inputCandles[inputCandles.length - 1];
    const ingestedRow = runner.ingest(latestCandle);
    const latestRow = ingestedRow?.whitespace
      ? ingestedRow
      : (ingestedRow ? { ...ingestedRow, color: colorForValue(ingestedRow.value, ingestedRow) } : null);
    if (!latestRow) return;
    const previousLatest = lastRows[lastRows.length - 1];
    lastCandles = inputCandles;
    lastCandleRangeSig = candleRangeSig;
    lastAcceptedCandleTime = lastCandleTime(inputCandles);
    const unchanged = (
      previousLatest
      && previousLatest.time === latestRow.time
      && previousLatest.value === latestRow.value
      && previousLatest.whitespace === latestRow.whitespace
    );

    if (latestRow.isAnchor && !latestRow.whitespace) {
      const marker = { time: latestRow.time, value: 0, color: RESET_MARKER_COLOR };
      const previousMarker = lastResetRows[lastResetRows.length - 1];
      if (previousMarker?.time === marker.time) lastResetRows[lastResetRows.length - 1] = marker;
      else lastResetRows.push(marker);
      mutateOverlaySeries(resetMarkerSeries, marker, {
        getChart,
        rebuild: () => lastResetRows,
      });
    }
    if (unchanged) return;

    if (previousLatest?.time === latestRow.time) {
      lastRows[lastRows.length - 1] = latestRow;
    } else {
      lastRows.push(latestRow);
    }
    // setCandles first compares the O(1) candle range signature, so this only
    // needs to remain truthy after the native incremental update. Full row
    // signatures are reserved for snapshot rebuilds.
    lastSig = `${coin}:${timeframe}:${anchorKey()}:${latestRow.time}:${latestRow.value ?? 'w'}`;

    mutateOverlaySeries(series, toHistogramPoint(latestRow), {
      getChart,
      rebuild: () => lastRows.map((row) => toHistogramPoint(row)),
    });
    mutateOverlaySeries(outlineSeries, outlineRows([latestRow])[0], {
      getChart,
      rebuild: () => outlineRows(lastRows),
    });
  }

  function preparePane(coin = '', timeframe = '4h') {
    if (!shouldRenderCvd(timeframe)) {
      detach();
      lastCoin = coin;
      lastTimeframe = timeframe;
      return false;
    }
    if (coin !== lastCoin || timeframe !== lastTimeframe) {
      detach();
    }
    if (!attachIfNeeded()) return false;
    lastCoin = coin;
    lastTimeframe = timeframe;
    return true;
  }

  function updateLast(candles, coin = '', timeframe = '4h') {
    if (!shouldRenderCvd(timeframe)) {
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
    if (!(nextLastTime >= lastAcceptedCandleTime)) return;
    updateLatestRow(candles, coin, timeframe);
  }

  function setAnchor(next = {}) {
    const nextTimeframe = normalizeCvdAnchorTimeframe(
      next.anchorTimeframe || activeAnchorTimeframe || DEFAULT_ANCHOR,
    );
    const nextStartTime = normalizeTimestamp(next.anchorStartTime);
    const changed = nextTimeframe !== activeAnchorTimeframe || nextStartTime !== activeAnchorStartTime;
    if (!changed) return;
    activeAnchorTimeframe = nextTimeframe;
    activeAnchorStartTime = nextStartTime;
    runner = createRunner();
    lastSig = '';
    lastCandleRangeSig = '';
    lastAcceptedCandleTime = 0;
    lastRows = [];
    lastResetRows = [];
    if (lastCandles) setCandles(lastCandles, lastCoin, lastTimeframe || DEFAULT_TIMEFRAME);
  }

  function applyTheme() {
    if (!series || !outlineSeries || !lastRows.length) return;
    const recolored = lastRows.map((row) => row?.whitespace
      ? row
      : { ...row, color: colorForValue(row.value, row) });
    lastRows = recolored;
    try {
      try { attachedChart?.clearCrosshairPosition?.(); } catch {}
      series.setData(lastRows);
      outlineSeries.setData(outlineRows(lastRows));
    } catch {}
  }

  function getSeries() {
    return series;
  }

  const getDebugState = () => {
    const lastRow = lastRows[lastRows.length - 1];
    const lastReset = lastResetRows[lastResetRows.length - 1];
    return {
      attached: Boolean(attachedChart && series && outlineSeries && resetMarkerSeries),
      rowCount: lastRows.length,
      lastTime: Number(lastRow?.time || 0),
      lastValue: Number.isFinite(lastRow?.value) ? lastRow.value : null,
      lastIsAnchor: Boolean(lastRow?.isAnchor),
      resetCount: lastResetRows.length,
      lastResetTime: Number(lastReset?.time || 0),
      baselineVisible: Boolean(resetMarkerSeries && lastResetRows.length > 0),
      anchorTimeframe: activeAnchorTimeframe || DEFAULT_ANCHOR,
      anchorStartTime: activeAnchorStartTime || 0,
    };
  };
  return { setCandles, updateLast, applyTheme, detach, setAnchor, preparePane, getSeries, getDebugState };
}

export default { createCvdOverlay };
