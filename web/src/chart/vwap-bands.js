/**
 * VWAP Bands — Kalman-smoothed rolling VWAP with adaptive inner/outer bands.
 *
 * Renders 5 LineSeries on the lightweight chart:
 *   - VWAP centerline
 *   - Inner upper / lower bands (decaying offset, faster decay)
 *   - Outer upper / lower bands (decaying offset, slower decay)
 *
 * Ported from PineScript "VWAP Bands":
 *   - Raw VWAP = rolling Σ(hlc3 * vol) / Σ(vol) over a configurable lookback
 *   - Kalman filter smooths the raw VWAP
 *   - Bands are placed at dev × mult where dev is the rolling σ of (price − vwap) / vwap
 *   - A decay-based offset pushes the band further out when price breaches it
 *     and pulls it back when price respects it.
 *
 * Self-contained overlay lifecycle:
 *   - setCandles(candles, coin, timeframe) — full reload
 *   - updateLast(candles, timeframe)       — incremental tick
 *   - detach()                             — clean up
 */

import { DEFAULT_RVWAP_RGB, rollingVwapColor, rollingVwapBandHex } from './vwap-colors.js';
import { cancelFrameWork, scheduleFrameWork } from '../utils/frame.js';
import { colorWithAlpha } from '../services/color-palette.js';
import { mutateOverlaySeries } from './overlay-series-mutate.js';

const DAY_SEC = 86400;
const REF_INTERVAL_SEC = 3600; // gain/decay defaults are calibrated at 1h bars

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function lkbSec(tf) {
  const match = /^(\d+)D$/i.exec(String(tf || ''));
  const days = match ? Number(match[1]) : 90;
  return (Number.isFinite(days) && days > 0 ? days : 90) * DAY_SEC;
}

const normalizeTimestamp = (time) => {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
};

function createRollingSum() {
  const items = [];
  let sum = 0;

  function add(value, time, windowSec) {
    items.push({ value, time });
    sum += value;
    purge(time, windowSec);
  }

  function replaceLast(value, time, windowSec) {
    if (items.length === 0) {
      add(value, time, windowSec);
      return;
    }
    const last = items[items.length - 1];
    sum -= last.value;
    last.value = value;
    last.time = time;
    sum += value;
    purge(time, windowSec);
  }

  function purge(time, windowSec) {
    while (items.length > 0 && time - items[0].time >= windowSec) {
      sum -= items.shift().value;
    }
  }

  function total() {
    return items.length >= 3 ? sum : NaN;
  }

  function reset() {
    items.length = 0;
    sum = 0;
  }

  return { add, replaceLast, total, reset };
}

const DEFAULTS = {
  sigma: 2.5,
  lookback: '30D',
  kalmanGain: 0.05,
  stdevRatio: 5.5,
  innerMult: 1.0,
  outerMult: 1.75,
  innerDecay: 0.99,
  outerDecay: 0.9975,
  vwap:     { lineWidth: 2 },
  upperInner: { lineWidth: 1 },
  lowerInner: { lineWidth: 1 },
  upperOuter: { lineWidth: 2 },
  lowerOuter: { lineWidth: 2 },
};

export const RVWAP_PRESETS = Object.freeze({
  '7D': Object.freeze({ label: '7 Days', chartLabel: '7D', color: DEFAULT_RVWAP_RGB, lineWidth: 1 }),
  '30D': Object.freeze({ label: '30 Days', chartLabel: '30D', color: DEFAULT_RVWAP_RGB, lineWidth: 2 }),
  '90D': Object.freeze({ label: '90 Days', chartLabel: '90D', color: DEFAULT_RVWAP_RGB, lineWidth: 3 }),
  // Duration-weighted rolling TWAP. Plot gate matches 90D so the line covers
  // the same 4h-source span as 90D; the window itself stays 365 days
  // (expanding until full). On 1d/1w/1M the overlay prefers display candles
  // when they start earlier than the 4h/600d source.
  '365D': Object.freeze({
    label: '365 TWAP',
    chartLabel: '365D',
    color: DEFAULT_RVWAP_RGB,
    lineWidth: 4,
    bands: false,
    timeWeighted: true,
    kalmanGain: 1,
    plotAfter: '90D',
  }),
});

function seriesStartSec(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return Infinity;
  const t = normalizeTimestamp(candles[0]?.t);
  return t > 0 ? t : Infinity;
}

/**
 * 365 TWAP follows whichever closed series starts earlier: the dedicated 4h
 * source (deep warmup on intraday charts) or the visible display candles
 * (years of 1d/1w/1M scrollback the 4h/600d source does not contain).
 */
function resolveTwapSource(lookback, source, sourceTimeframe, display = {}) {
  const sourceRows = Array.isArray(source) ? source : [];
  const displayCandles = Array.isArray(display.displayCandles) ? display.displayCandles : [];
  const displayTimeframe = display.displayTimeframe || sourceTimeframe;
  if (RVWAP_PRESETS[lookback]?.timeWeighted !== true) {
    return { candles: sourceRows, timeframe: sourceTimeframe, display };
  }
  const sourceStart = seriesStartSec(sourceRows);
  const displayStart = seriesStartSec(displayCandles);
  if (displayStart + DAY_SEC <= sourceStart) {
    return {
      candles: displayCandles,
      timeframe: displayTimeframe,
      display: { displayCandles, displayTimeframe },
    };
  }
  return { candles: sourceRows, timeframe: sourceTimeframe, display };
}

function presetSupportsBands(lookback) {
  return RVWAP_PRESETS[lookback]?.bands !== false;
}

function vwapPalette(centerOpacity = 0.85, fixedPrecision = false) {
  const innerOpacity = fixedPrecision ? '0.30' : 0.30;
  const outerOpacity = fixedPrecision ? '0.62' : 0.62;
  return {
    vwap:       rollingVwapColor(centerOpacity),
    upperInner: rollingVwapColor(innerOpacity),
    lowerInner: rollingVwapColor(innerOpacity),
    upperOuter: rollingVwapColor(outerOpacity),
    lowerOuter: rollingVwapColor(outerOpacity),
  };
}

function freshState() {
  return {
    rsHlc3v: createRollingSum(),
    rsVol:   createRollingSum(),
    rsOne:   createRollingSum(),
    rsDh:    createRollingSum(),
    rsDh2:   createRollingSum(),
    rsDl:    createRollingSum(),
    rsDl2:   createRollingSum(),
    k: NaN,
    uOff: [0, 0],
    lOff: [0, 0],
    prevUOff: [0, 0],
    prevLOff: [0, 0],
    firstBarTime: -1,
    lastBarTime: -1,
  };
}

function tfScale(intervalSec) {
  // Decay is applied per bar; normalize it to the reference interval so the
  // effective decay-per-elapsed-time is the same across chart timeframes.
  return clamp(Math.max(intervalSec || REF_INTERVAL_SEC, 1) / REF_INTERVAL_SEC, 0.05, 48);
}

function ingestBar(state, bar, intervalSec, config) {
  const t = normalizeTimestamp(bar?.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  const o = +bar.o, h = +bar.h, l = +bar.l, c = +bar.c;
  const v = Number.isFinite(+bar.v) ? +bar.v : 0;
  if (![o, h, l, c].every(Number.isFinite)) return null;

  const hlc3 = (h + l + c) / 3;

  const isReplace = t === state.lastBarTime;
  if (state.firstBarTime < 0) state.firstBarTime = t;

  if (isReplace) {
    state.uOff = [...state.prevUOff];
    state.lOff = [...state.prevLOff];
  } else if (t < state.lastBarTime) {
    return null;
  } else {
    state.prevUOff = [...state.uOff];
    state.prevLOff = [...state.lOff];
  }

  const tMs = lkbSec(config.lookback);
  const plotAfterSec = lkbSec(config.plotAfter || config.lookback);
  const resolvedIntervalSec = Math.max(1, intervalSec || 3600);
  const weight = config.timeWeighted ? resolvedIntervalSec : v;

  if (isReplace) {
    state.rsHlc3v.replaceLast(hlc3 * weight, t, tMs);
    state.rsVol.replaceLast(weight, t, tMs);
  } else {
    state.rsHlc3v.add(hlc3 * weight, t, tMs);
    state.rsVol.add(weight, t, tMs);
  }

  const rawNum = state.rsHlc3v.total();
  const rawDen = state.rsVol.total();
  const raw = (Number.isFinite(rawNum) && Number.isFinite(rawDen) && rawDen > 0)
    ? rawNum / rawDen
    : hlc3;

  if (!Number.isFinite(state.k) || !(config.kalmanGain < 1)) {
    state.k = raw;
  } else {
    // Per-bar gain normalized to the reference interval so the smoothing
    // time-constant is wall-clock invariant across chart timeframes.
    const gEff = 1 - Math.pow(1 - config.kalmanGain, resolvedIntervalSec / REF_INTERVAL_SEC);
    state.k += gEff * (raw - state.k);
  }
  const vwap = state.k;

  const elapsed = Math.max(0, t - state.firstBarTime);
  const bands = { time: t };
  if (elapsed >= plotAfterSec) bands.vwap = vwap;

  if (config.bandsSupported) {
    const sdMs = Math.max(tMs * config.stdevRatio, 1);
    const dh = vwap !== 0 ? (h - vwap) / vwap : 0;
    const dl = vwap !== 0 ? (l - vwap) / vwap : 0;

    if (isReplace) {
      state.rsOne.replaceLast(1, t, sdMs);
      state.rsDh.replaceLast(dh, t, sdMs);
      state.rsDh2.replaceLast(dh * dh, t, sdMs);
      state.rsDl.replaceLast(dl, t, sdMs);
      state.rsDl2.replaceLast(dl * dl, t, sdMs);
    } else {
      state.rsOne.add(1, t, sdMs);
      state.rsDh.add(dh, t, sdMs);
      state.rsDh2.add(dh * dh, t, sdMs);
      state.rsDl.add(dl, t, sdMs);
      state.rsDl2.add(dl * dl, t, sdMs);
    }

    const n = state.rsOne.total();
    const sxH = state.rsDh.total();
    const sx2H = state.rsDh2.total();
    const sxL = state.rsDl.total();
    const sx2L = state.rsDl2.total();

    let devH, devL;
    if (Number.isFinite(n) && n > 0) {
      devH = clamp(Math.sqrt(Math.max(0, sx2H / n - Math.pow(sxH / n, 2))), 0.001, 0.1);
      devL = clamp(Math.sqrt(Math.max(0, sx2L / n - Math.pow(sxL / n, 2))), 0.001, 0.1);
    } else {
      devH = NaN;
      devL = NaN;
    }

    const scale = tfScale(resolvedIntervalSec);

    // Start bands with the centerline. σ still uses the lookback × stdevRatio
    // window; waiting for that full window to fill left 90D bands far shorter
    // than the centerline on the 600-day source.
    if (elapsed >= tMs && Number.isFinite(devH) && devH > 0 && Number.isFinite(devL) && devL > 0) {
      for (let i = 0; i < 2; i++) {
        const mult  = i === 0 ? config.innerMult : config.outerMult;
        const decay = Math.pow(i === 0 ? config.innerDecay : config.outerDecay, scale);

        let uo = state.uOff[i];
        let lo = state.lOff[i];

        const ub = vwap * (1 + devH * mult);
        const lb = vwap * (1 - devL * mult);

        if (h > ub) uo = Math.max(uo, h - ub);
        if (l < lb) lo = Math.max(lo, lb - l);

        uo = uo > 0 ? Math.max(uo * decay, 0) : 0;
        lo = lo > 0 ? Math.max(lo * decay, 0) : 0;

        state.uOff[i] = uo;
        state.lOff[i] = lo;

        if (i === 0) {
          bands.upperInner = ub + uo;
          bands.lowerInner = lb - lo;
        } else {
          bands.upperOuter = ub + uo;
          bands.lowerOuter = lb - lo;
        }
      }
    }
  }

  state.lastBarTime = t;
  return bands;
}

function dedupeAndSort(candles) {
  const byTime = new Map();
  for (const c of candles) {
    const t = normalizeTimestamp(c?.t);
    if (Number.isFinite(t) && t > 0) byTime.set(t, c);
  }
  return [...byTime.values()].sort((a, b) =>
    normalizeTimestamp(a.t) - normalizeTimestamp(b.t));
}

function buildSeriesData(rows) {
  const v = [], ui = [], li = [], uo = [], lo = [];
  for (const r of rows) {
    if (Number.isFinite(r.vwap))       v.push({  time: r.time, value: r.vwap });
    if (Number.isFinite(r.upperInner)) ui.push({ time: r.time, value: r.upperInner });
    if (Number.isFinite(r.lowerInner)) li.push({ time: r.time, value: r.lowerInner });
    if (Number.isFinite(r.upperOuter)) uo.push({ time: r.time, value: r.upperOuter });
    if (Number.isFinite(r.lowerOuter)) lo.push({ time: r.time, value: r.lowerOuter });
  }
  return { v, ui, li, uo, lo };
}

const COARSE_DISPLAY_TIMEFRAMES = new Set(['8h', '1d', '1w', '1M']);

/**
 * Keep RVWAP calculations at source resolution while constraining rendered
 * points to timestamps owned by the active candle series. Extra 4h times
 * that are not already on the candle series become extra logical indexes:
 * they compress weekly/monthly bodies and make history-prepend range shifts
 * (counted in candle bars) miss the inspected window. Do not emit source
 * times outside the loaded display series.
 */
function projectRowsToDisplayAxis(rows = [], displayCandles, displayTimeframe = '4h') {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(displayCandles)) return sourceRows;
  const display = dedupeAndSort(displayCandles);
  if (display.length === 0) {
    // Explicit empty display axis: do not inject source times as extra
    // logical indexes (600d of 4h on a 1M chart blows the overview).
    return [];
  }

  const displayTimes = display
    .map((candle) => normalizeTimestamp(candle?.t))
    .filter((time) => time > 0);
  if (displayTimes.length === 0) return [];

  if (!COARSE_DISPLAY_TIMEFRAMES.has(displayTimeframe)) {
    const activeTimes = new Set(displayTimes);
    return sourceRows.filter((row) => activeTimes.has(Number(row?.time || 0)));
  }

  const projected = [];
  let rowIndex = 0;
  while (rowIndex < sourceRows.length && Number(sourceRows[rowIndex]?.time || 0) < displayTimes[0]) {
    rowIndex += 1;
  }

  for (let candleIndex = 0; candleIndex < displayTimes.length; candleIndex += 1) {
    const bucketStart = displayTimes[candleIndex];
    const bucketEnd = displayTimes[candleIndex + 1] ?? Infinity;
    let latest = null;
    while (rowIndex < sourceRows.length) {
      const rowTime = Number(sourceRows[rowIndex]?.time || 0);
      if (!(rowTime < bucketEnd)) break;
      if (rowTime >= bucketStart) latest = sourceRows[rowIndex];
      rowIndex += 1;
    }
    if (latest) projected.push({ ...latest, time: bucketStart });
  }
  return projected;
}

function mergeOpts(o) {
  const lookback = (o || {}).lookback || DEFAULTS.lookback;
  const preset = RVWAP_PRESETS[lookback] || {};
  const fromPreset = {};
  if (preset.timeWeighted === true) fromPreset.timeWeighted = true;
  if (Number.isFinite(preset.kalmanGain)) fromPreset.kalmanGain = preset.kalmanGain;
  if (preset.plotAfter) fromPreset.plotAfter = preset.plotAfter;
  const merged = { ...DEFAULTS, ...fromPreset, ...(o || {}) };
  for (const k of ['vwap', 'upperInner', 'lowerInner', 'upperOuter', 'lowerOuter']) {
    merged[k] = { ...DEFAULTS[k], ...((o || {})[k] || {}) };
  }
  const defaultChartLabel = preset.chartLabel || (lookback === '365D' ? '365D' : lookback);
  if (!merged.chartLabel) merged.chartLabel = defaultChartLabel;
  if (merged.vwap.title === undefined) {
    merged.vwap.title = merged.chartLabel;
  }
  if (merged.vwap.lastValueVisible === undefined) {
    merged.vwap.lastValueVisible = true;
  }
  return merged;
}

export function createVwapBandsOverlay({ getChart, getCandleSeries, LineSeries, LineStyle, options } = {}) {
  if (typeof getChart !== 'function' || !LineSeries || !LineStyle) {
    throw new Error('createVwapBandsOverlay requires getChart, LineSeries, LineStyle');
  }
  const opts = mergeOpts(options);
  const lookback = opts.lookback || '30D';
  const bandsSupported = opts.bandsSupported ?? presetSupportsBands(lookback);
  const chartLabel = opts.chartLabel || RVWAP_PRESETS[lookback]?.chartLabel || (lookback === '365D' ? '365D' : lookback);
  const config = {
    lookback,
    chartLabel,
    bandsSupported,
    timeWeighted: opts.timeWeighted === true,
    plotAfter: opts.plotAfter || lookback,
    kalmanGain: opts.kalmanGain ?? 0.05,
    stdevRatio: opts.stdevRatio ?? 5.5,
    innerMult: opts.innerMult ?? 1.0,
    outerMult: opts.outerMult ?? 1.75,
    innerDecay: opts.innerDecay ?? 0.99,
    outerDecay: opts.outerDecay ?? 0.9975,
  };
  let attachedChart = null;
  let series = null;
  let state = freshState();
  let lastSig = '';
  let lastCoin = '';
  let lastSnapshotRevision = -1;
  let lastRowCount = 0;
  let lastCenterCount = 0;
  let lastBandCount = 0;
  let lastRenderedRowCount = 0;
  let lastCenterTime = 0;
  let lastCenterValue = null;
  let lastValues = {
    vwap: null,
    upperInner: null,
    lowerInner: null,
    upperOuter: null,
    lowerOuter: null,
  };
  let lastSeriesData = { v: [], ui: [], li: [], uo: [], lo: [] };
  let dataSetCount = 0;
  let pointUpdateCount = 0;
  let lastInputBarSignature = '';
  let bandsVisible = bandsSupported && opts.bandsVisible !== false;
  let lastRenderedRows = [];
  let attachedPrimitiveSeries = null;
  let requestUpdate = null;

  function drawBandFills(target) {
    if (!bandsVisible || !Array.isArray(lastRenderedRows) || lastRenderedRows.length < 2) return;
    target.useBitmapCoordinateSpace((scope) => {
      const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
      const chart = getChart();
      const seriesForCoords = (typeof getCandleSeries === 'function' ? getCandleSeries() : null) || series?.vwap;
      if (!chart || !seriesForCoords) return;
      const ts = chart.timeScale();
      const bandColor = rollingVwapBandHex();

      const pts = [];
      for (let i = 0; i < lastRenderedRows.length; i++) {
        const row = lastRenderedRows[i];
        if (row == null || row.upperOuter == null || row.lowerOuter == null) continue;
        const logical = ts.timeToIndex(row.time, true);
        if (logical == null) continue;
        const xMedia = ts.logicalToCoordinate(logical);
        if (xMedia == null) continue;
        const yUoMedia = seriesForCoords.priceToCoordinate(row.upperOuter);
        const yLoMedia = seriesForCoords.priceToCoordinate(row.lowerOuter);
        const yUiMedia = row.upperInner != null ? seriesForCoords.priceToCoordinate(row.upperInner) : null;
        const yLiMedia = row.lowerInner != null ? seriesForCoords.priceToCoordinate(row.lowerInner) : null;
        if (yUoMedia == null || yLoMedia == null) continue;

        pts.push({
          x: xMedia * hpr,
          yUo: yUoMedia * vpr,
          yLo: yLoMedia * vpr,
          yUi: yUiMedia != null ? yUiMedia * vpr : null,
          yLi: yLiMedia != null ? yLiMedia * vpr : null,
        });
      }

      if (pts.length < 2) return;

      ctx.save();

      const hasInner = pts.every((p) => p.yUi != null && p.yLi != null);

      if (hasInner) {
        // 1. Upper outer band strip (upperOuter to upperInner): less transparent (higher opacity)
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].yUo);
          else ctx.lineTo(pts[i].x, pts[i].yUo);
        }
        for (let i = pts.length - 1; i >= 0; i--) {
          ctx.lineTo(pts[i].x, pts[i].yUi);
        }
        ctx.closePath();
        ctx.fillStyle = colorWithAlpha(bandColor, 0.12);
        ctx.fill();
        // 2. Lower outer band strip (lowerInner to lowerOuter): less transparent (higher opacity)
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].yLi);
          else ctx.lineTo(pts[i].x, pts[i].yLi);
        }
        for (let i = pts.length - 1; i >= 0; i--) {
          ctx.lineTo(pts[i].x, pts[i].yLo);
        }
        ctx.closePath();
        ctx.fillStyle = colorWithAlpha(bandColor, 0.12);
        ctx.fill();
        // 3. Inner band core (upperInner to lowerInner): more transparent (lower opacity)
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].yUi);
          else ctx.lineTo(pts[i].x, pts[i].yUi);
        }
        for (let i = pts.length - 1; i >= 0; i--) {
          ctx.lineTo(pts[i].x, pts[i].yLi);
        }
        ctx.closePath();
        ctx.fillStyle = colorWithAlpha(bandColor, 0.04);
        ctx.fill();
      } else {
        // Fallback for single envelope
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].yUo);
          else ctx.lineTo(pts[i].x, pts[i].yUo);
        }
        for (let i = pts.length - 1; i >= 0; i--) {
          ctx.lineTo(pts[i].x, pts[i].yLo);
        }
        ctx.closePath();
        ctx.fillStyle = colorWithAlpha(bandColor, 0.12);
        ctx.fill();
      }
      ctx.restore();
    });
  }

  const primitive = {
    attached(params) { requestUpdate = params?.requestUpdate || null; },
    detached() { requestUpdate = null; },
    updateAllViews() {},
    autoscaleInfo() { return null; },
    paneViews: () => [{ zOrder: () => 'bottom', renderer: () => ({ draw: drawBandFills }) }],
  };
  function candlesSignature(candles, coin, displayCandles = [], displayTimeframe = '') {
    if (!Array.isArray(candles) || candles.length === 0) return '0';
    const first = candles[0];
    const last = candles[candles.length - 1];
    const displayFirst = displayCandles[0];
    const displayLast = displayCandles[displayCandles.length - 1];
    return [
      coin,
      candles.length,
      first?.t || 0,
      last?.t || 0,
      last?.c || 0,
      last?.v || 0,
      displayTimeframe,
      displayCandles.length,
      displayFirst?.t || 0,
      displayLast?.t || 0,
    ].join(':');
  }

  function styleOf(o, fallbackColor) {
    const lineStyle = o.dashed ? LineStyle.Dashed
      : o.dotted ? LineStyle.Dotted
      : LineStyle.Solid;
    return {
      color: o.color || fallbackColor,
      lineWidth: o.lineWidth,
      lineStyle,
      priceLineVisible: Boolean(o.priceLineVisible),
      lastValueVisible: Boolean(o.lastValueVisible),
      title: o.title || '',
      crosshairMarkerVisible: false,
      // RVWAP is a price-derived overlay, so keep it on the same visible scale
      // as the candle series. Native autoscaling must include every visible
      // center/band value; returning null from autoscaleInfoProvider excludes
      // the series and lets zooming clip or visually displace the overlay.
      priceScaleId: 'right',
    };
  }

  function detach() {
    if (attachedPrimitiveSeries && typeof attachedPrimitiveSeries.detachPrimitive === 'function') {
      try { attachedPrimitiveSeries.detachPrimitive(primitive); } catch {}
    }
    attachedPrimitiveSeries = null;
    if (attachedChart && series) {
      for (const s of Object.values(series)) {
        try { attachedChart.removeSeries(s); } catch {}
      }
    }
    attachedChart = null;
    series = null;
    state = freshState();
    lastSig = '';
    lastSnapshotRevision = -1;
    lastRowCount = 0;
    lastCenterCount = 0;
    lastBandCount = 0;
    lastRenderedRowCount = 0;
    lastCenterTime = 0;
    lastCenterValue = null;
    lastValues = {
      vwap: null,
      upperInner: null,
      lowerInner: null,
      upperOuter: null,
      lowerOuter: null,
    };
    lastSeriesData = { v: [], ui: [], li: [], uo: [], lo: [] };
    lastRenderedRows = [];
    dataSetCount = 0;
    pointUpdateCount = 0;
    lastInputBarSignature = '';
  }

  function attachPrimitiveIfNeeded() {
    const candleSeries = typeof getCandleSeries === 'function' ? getCandleSeries() : null;
    const targetSeries = candleSeries || series?.vwap;
    if (!targetSeries || typeof targetSeries.attachPrimitive !== 'function') return;
    if (attachedPrimitiveSeries === targetSeries) return;
    if (attachedPrimitiveSeries?.detachPrimitive) {
      try { attachedPrimitiveSeries.detachPrimitive(primitive); } catch {}
    }
    attachedPrimitiveSeries = targetSeries;
    try {
      targetSeries.attachPrimitive(primitive);
    } catch {
      attachedPrimitiveSeries = null;
    }
  }
  function attachIfNeeded() {
    const chart = getChart();
    if (!chart) return false;
    if (attachedChart === chart && series) return true;
    detach();
    try {
      attachedChart = chart;
      const managedOpacity = opts.paletteCenterOpacity;
      const palette = vwapPalette(managedOpacity || 0.85, Boolean(managedOpacity));
      series = {
        vwap:  chart.addSeries(LineSeries, styleOf(opts.vwap,       palette.vwap)),
        upperInner: chart.addSeries(LineSeries, styleOf(opts.upperInner, palette.upperInner)),
        lowerInner: chart.addSeries(LineSeries, styleOf(opts.lowerInner, palette.lowerInner)),
        upperOuter: chart.addSeries(LineSeries, styleOf(opts.upperOuter, palette.upperOuter)),
        lowerOuter: chart.addSeries(LineSeries, styleOf(opts.lowerOuter, palette.lowerOuter)),
      };
      attachPrimitiveIfNeeded();
      return true;
    } catch (err) {
      console.warn('[vwap-bands] attach failed:', err);
      attachedChart = null;
      series = null;
      return false;
    }
  }

  function setCandles(
    candles,
    coin = '',
    timeframe = '4h',
    snapshotRevision = 0,
    { displayCandles, displayTimeframe = timeframe } = {},
  ) {
    if (coin !== lastCoin) {
      detach();
    }
    if (!attachIfNeeded()) return;
    const sig = candlesSignature(candles, coin, displayCandles, displayTimeframe);
    if (snapshotRevision === lastSnapshotRevision && sig === lastSig && coin === lastCoin) return;
    lastCoin = coin;
    state = freshState();
    const sorted = dedupeAndSort(Array.isArray(candles) ? candles : []);
    const rows = [];
    const fallbackIntervalSec = sorted.length > 1
      ? Math.max(1, normalizeTimestamp(sorted[sorted.length - 1]?.t) - normalizeTimestamp(sorted[sorted.length - 2]?.t))
      : 3600;
    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i];
      const next = sorted[i + 1];
      const currentTime = normalizeTimestamp(current?.t);
      const nextTime = normalizeTimestamp(next?.t);
      const intervalSec = nextTime > currentTime
        ? nextTime - currentTime
        : fallbackIntervalSec;
      const r = ingestBar(state, current, intervalSec, config);
      if (r) rows.push(r);
    }
    const renderedRows = projectRowsToDisplayAxis(rows, displayCandles, displayTimeframe);
    lastRenderedRows = renderedRows;
    const d = buildSeriesData(renderedRows);
    lastRowCount = rows.length;
    lastRenderedRowCount = renderedRows.length;
    lastCenterCount = d.v.length;
    lastBandCount = d.ui.length;
    const lastCenter = d.v[d.v.length - 1];
    lastCenterTime = Number(lastCenter?.time || 0);
    lastCenterValue = Number.isFinite(lastCenter?.value) ? lastCenter.value : null;
    lastValues = {
      vwap: Number.isFinite(d.v.at(-1)?.value) ? d.v.at(-1).value : null,
      upperInner: Number.isFinite(d.ui.at(-1)?.value) ? d.ui.at(-1).value : null,
      lowerInner: Number.isFinite(d.li.at(-1)?.value) ? d.li.at(-1).value : null,
      upperOuter: Number.isFinite(d.uo.at(-1)?.value) ? d.uo.at(-1).value : null,
      lowerOuter: Number.isFinite(d.lo.at(-1)?.value) ? d.lo.at(-1).value : null,
    };
    const lastInput = sorted[sorted.length - 1];
    lastInputBarSignature = lastInput
      ? [lastInput.t, lastInput.o, lastInput.h, lastInput.l, lastInput.c, lastInput.v].join(':')
      : '';
    lastSeriesData = {
      v: d.v,
      ui: bandsVisible ? d.ui : [],
      li: bandsVisible ? d.li : [],
      uo: bandsVisible ? d.uo : [],
      lo: bandsVisible ? d.lo : [],
    };
    try { attachedChart?.clearCrosshairPosition?.(); } catch {}
    series.vwap.setData(d.v);
    series.upperInner.setData(lastSeriesData.ui);
    series.lowerInner.setData(lastSeriesData.li);
    series.upperOuter.setData(lastSeriesData.uo);
    series.lowerOuter.setData(lastSeriesData.lo);
    dataSetCount += 5;
    lastSig = sig;
    lastSnapshotRevision = snapshotRevision;
    try { requestUpdate?.(); } catch {}
  }

  function updateLast(
    candles,
    timeframe = '4h',
    { displayCandles, displayTimeframe = timeframe } = {},
  ) {
    if (!attachIfNeeded()) return;
    if (!Array.isArray(candles) || candles.length === 0) return;
    const lastBar = candles[candles.length - 1];
    const inputBarSignature = [
      lastBar?.t, lastBar?.o, lastBar?.h, lastBar?.l, lastBar?.c, lastBar?.v,
    ].join(':');
    if (inputBarSignature === lastInputBarSignature) return;
    const previousBar = candles[candles.length - 2];
    const lastTime = normalizeTimestamp(lastBar?.t);
    const previousTime = normalizeTimestamp(previousBar?.t);
    const intervalSec = lastTime > previousTime
      ? lastTime - previousTime
      : 3600;
    const r = ingestBar(state, lastBar, intervalSec, config);
    if (!r) return;
    lastInputBarSignature = inputBarSignature;
    lastRowCount = candles.length;
    const [rendered] = projectRowsToDisplayAxis([r], displayCandles, displayTimeframe);
    if (!rendered) return;
    const appendsRenderedPoint = Number(rendered.time || 0) > lastCenterTime;
    if (appendsRenderedPoint) {
      lastRenderedRows.push(rendered);
      lastRenderedRowCount += 1;
    } else if (lastRenderedRows.length > 0) {
      lastRenderedRows[lastRenderedRows.length - 1] = rendered;
    } else {
      lastRenderedRows = [rendered];
    }
    try { requestUpdate?.(); } catch {}
    const appendPoint = (key, point) => {
      const current = Array.isArray(lastSeriesData[key]) ? lastSeriesData[key] : [];
      const last = current[current.length - 1];
      if (last && Number(last.time) === Number(point.time)) {
        lastSeriesData[key] = current.slice(0, -1).concat(point);
      } else {
        lastSeriesData[key] = current.concat(point);
      }
    };
    const applyPoint = (seriesKey, dataKey, value, onApplied) => {
      if (!Number.isFinite(value)) return;
      const point = { time: rendered.time, value };
      appendPoint(dataKey, point);
      if (mutateOverlaySeries(series[seriesKey], point, {
        getChart,
        rebuild: () => lastSeriesData[dataKey],
      })) {
        pointUpdateCount += 1;
        onApplied?.();
      }
    };
    applyPoint('vwap', 'v', rendered.vwap, () => {
      if (appendsRenderedPoint) lastCenterCount += 1;
      lastCenterTime = Number(rendered.time || 0);
      lastCenterValue = rendered.vwap;
      lastValues.vwap = rendered.vwap;
    });
    if (bandsVisible) {
      applyPoint('upperInner', 'ui', rendered.upperInner, () => {
        if (appendsRenderedPoint) lastBandCount += 1;
        lastValues.upperInner = rendered.upperInner;
      });
      applyPoint('lowerInner', 'li', rendered.lowerInner, () => {
        lastValues.lowerInner = rendered.lowerInner;
      });
      applyPoint('upperOuter', 'uo', rendered.upperOuter, () => {
        lastValues.upperOuter = rendered.upperOuter;
      });
      applyPoint('lowerOuter', 'lo', rendered.lowerOuter, () => {
        lastValues.lowerOuter = rendered.lowerOuter;
      });
    }
  }

  function applyTheme() {
    if (!series) return;
    const managedOpacity = opts.paletteCenterOpacity;
    const palette = vwapPalette(managedOpacity || 0.85, Boolean(managedOpacity));
    const map = { vwap: 'vwap', upperInner: 'upperInner', lowerInner: 'lowerInner', upperOuter: 'upperOuter', lowerOuter: 'lowerOuter' };
    for (const [seriesKey, optsKey] of Object.entries(map)) {
      const color = opts[optsKey].color || palette[optsKey];
      try { series[seriesKey].applyOptions({ color }); } catch {}
    }
  }

  function setBandsVisible(visible) {
    if (!config.bandsSupported) return;
    const next = visible === true || visible === 'true';
    if (next === bandsVisible) return;
    bandsVisible = next;
    if (!bandsVisible && series) {
      for (const key of ['upperInner', 'lowerInner', 'upperOuter', 'lowerOuter']) {
        try { series[key].setData([]); } catch {}
      }
    }
    // Re-enabling must rebuild the band history even when the candle signature
    // has not changed since the bands were hidden.
    if (bandsVisible) lastSig = '';
    try { requestUpdate?.(); } catch {}
  }

  const getDebugState = () => ({
    lookback,
    chartLabel: config.chartLabel,
    lineWidth: opts.vwap?.lineWidth || 2,
    attached: Boolean(attachedChart && series),
    rowCount: lastRowCount,
    renderedRowCount: lastRenderedRowCount,
    centerCount: lastCenterCount,
    bandCount: lastBandCount,
    insufficientHistory: lastCenterCount === 0 || (bandsVisible && lastBandCount === 0),
    bandsVisible,
    lastBarTime: Number(state.lastBarTime || 0),
    lastCenterTime,
    lastCenterValue,
    lastValues: { ...lastValues },
    dataSetCount,
    pointUpdateCount,
  });
  return { setCandles, updateLast, setBandsVisible, applyTheme, detach, getDebugState };
}

function presetOptions(lookback) {
  const preset = RVWAP_PRESETS[lookback] || {};
  const chartLabel = preset.chartLabel || (lookback === '365D' ? '365D' : lookback);
  const lineWidth = Number(preset.lineWidth) > 0 ? Number(preset.lineWidth) : 2;
  return {
    lookback,
    chartLabel,
    timeWeighted: preset.timeWeighted === true,
    kalmanGain: preset.kalmanGain,
    plotAfter: preset.plotAfter,
    paletteCenterOpacity: '0.95',
    vwap: {
      lineWidth,
      title: chartLabel,
      lastValueVisible: true,
    },
    upperInner: { lineWidth: 1 },
    lowerInner: { lineWidth: 1 },
    upperOuter: { lineWidth: 1 },
    lowerOuter: { lineWidth: 1 },
  };
}

/** Coordinates one independent five-line overlay for every enabled RVWAP preset. */
export function createRvwapOverlaySet({ getChart, getCandleSeries, LineSeries, LineStyle } = {}) {
  if (typeof getChart !== 'function' || !LineSeries || !LineStyle) {
    throw new Error('createRvwapOverlaySet requires getChart, LineSeries, LineStyle');
  }
  const overlays = new Map();
  let enabledLookbacks = [];
  let bandsEnabledLookbacks = Object.keys(RVWAP_PRESETS).filter(presetSupportsBands);
  let workGeneration = 0;
  let pendingSignature = '';
  let pendingWork = [];
  let pendingLiveUpdate = null;
  let completedSignature = '';

  function cancelPendingWork() {
    workGeneration += 1;
    pendingSignature = '';
    pendingLiveUpdate = null;
    for (const work of pendingWork) cancelFrameWork(work);
    pendingWork = [];
  }

  function sameLookbacks(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function normalizeLookbacks(lookbacks) {
    const requested = new Set(Array.isArray(lookbacks) ? lookbacks : []);
    return Object.keys(RVWAP_PRESETS).filter((lookback) => requested.has(lookback));
  }

  function normalizeBandLookbacks(lookbacks) {
    return normalizeLookbacks(lookbacks).filter(presetSupportsBands);
  }

  function overlayFor(lookback) {
    let overlay = overlays.get(lookback);
    if (!overlay) {
      overlay = createVwapBandsOverlay({
        getChart,
        getCandleSeries,
        LineSeries,
        LineStyle,
        options: {
          ...presetOptions(lookback),
          bandsSupported: presetSupportsBands(lookback),
          bandsVisible: presetSupportsBands(lookback) && bandsEnabledLookbacks.includes(lookback),
        },
      });
      overlays.set(lookback, overlay);
    }
    return overlay;
  }

  function setEnabledLookbacks(lookbacks) {
    const next = normalizeLookbacks(lookbacks);
    if (sameLookbacks(next, enabledLookbacks)) return;
    cancelPendingWork();
    completedSignature = '';
    const nextSet = new Set(next);
    for (const [lookback, overlay] of overlays) {
      if (!nextSet.has(lookback)) overlay.detach();
    }
    enabledLookbacks = next;
  }

  function setBandsEnabledLookbacks(lookbacks) {
    const next = normalizeBandLookbacks(lookbacks);
    if (sameLookbacks(next, bandsEnabledLookbacks)) return;
    cancelPendingWork();
    completedSignature = '';
    bandsEnabledLookbacks = next;
    const enabledSet = new Set(bandsEnabledLookbacks);
    for (const [lookback, overlay] of overlays) {
      overlay.setBandsVisible(enabledSet.has(lookback));
    }
  }

  function feedOverlay(lookback, candles, coin, timeframe, snapshotRevision, display) {
    const resolved = resolveTwapSource(lookback, candles, timeframe, display);
    overlayFor(lookback).setCandles(
      resolved.candles,
      coin,
      resolved.timeframe,
      snapshotRevision,
      resolved.display,
    );
  }

  function feedOverlayLast(lookback, candles, timeframe, display) {
    const resolved = resolveTwapSource(lookback, candles, timeframe, display);
    overlayFor(lookback).updateLast(resolved.candles, resolved.timeframe, resolved.display);
  }

  function setCandles(candles, coin = '', timeframe = '4h', snapshotRevision = 0, display = {}) {
    const source = Array.isArray(candles) ? candles : [];
    if (enabledLookbacks.length > 1 && source.length >= 2_000) {
      const displayCandles = Array.isArray(display?.displayCandles) ? display.displayCandles : [];
      const signature = [
        coin,
        timeframe,
        snapshotRevision,
        source.length,
        source[0]?.t || 0,
        source.at(-1)?.t || 0,
        source.at(-1)?.c || 0,
        display?.displayTimeframe || timeframe,
        displayCandles.length,
        displayCandles[0]?.t || 0,
        displayCandles.at(-1)?.t || 0,
        enabledLookbacks.join(','),
        bandsEnabledLookbacks.join(','),
      ].join(':');
      if (pendingSignature === signature || completedSignature === signature) return;
      cancelPendingWork();
      pendingSignature = signature;
      const generation = workGeneration;
      const lookbacks = [...enabledLookbacks];
      const enqueue = (index) => {
        const work = scheduleFrameWork(() => {
          pendingWork = pendingWork.filter((candidate) => candidate !== work);
          if (generation !== workGeneration) return;
          feedOverlay(lookbacks[index], source, coin, timeframe, snapshotRevision, display);
          if (index + 1 < lookbacks.length) {
            enqueue(index + 1);
          } else if (generation === workGeneration) {
            pendingSignature = '';
            completedSignature = signature;
            const latest = pendingLiveUpdate;
            pendingLiveUpdate = null;
            if (latest) {
              completedSignature = '';
              for (const lookback of enabledLookbacks) {
                feedOverlayLast(lookback, latest.candles, latest.timeframe, latest.display);
              }
            }
          }
        });
        pendingWork.push(work);
      };
      enqueue(0);
      return;
    }
    cancelPendingWork();
    completedSignature = '';
    for (const lookback of enabledLookbacks) {
      feedOverlay(lookback, source, coin, timeframe, snapshotRevision, display);
    }
  }

  function updateLast(candles, timeframe = '4h', display = {}) {
    // Preserve a live update that arrives during the short, frame-sliced full
    // rebuild. Applying it after the last preset prevents a partially attached
    // overlay from ingesting only the newest bar without its history.
    if (pendingSignature) {
      pendingLiveUpdate = { candles, timeframe, display };
      return;
    }
    completedSignature = '';
    for (const lookback of enabledLookbacks) {
      feedOverlayLast(lookback, candles, timeframe, display);
    }
  }

  function applyTheme() {
    for (const overlay of overlays.values()) overlay.applyTheme();
  }

  function detach() {
    cancelPendingWork();
    completedSignature = '';
    for (const overlay of overlays.values()) overlay.detach();
  }

  function getDebugState() {
    const instances = {};
    for (const lookback of Object.keys(RVWAP_PRESETS)) {
      instances[lookback] = overlays.get(lookback)?.getDebugState() || {
        lookback,
        chartLabel: RVWAP_PRESETS[lookback]?.chartLabel || (lookback === '365D' ? '365D' : lookback),
        lineWidth: RVWAP_PRESETS[lookback]?.lineWidth || 2,
        attached: false,
        rowCount: 0,
        bandsVisible: presetSupportsBands(lookback) && bandsEnabledLookbacks.includes(lookback),
      };
    }
    const activeStates = enabledLookbacks.map((lookback) => instances[lookback]);
    return {
      attached: activeStates.some((state) => state.attached),
      rowCount: Math.max(0, ...activeStates.map((state) => state.rowCount || 0)),
      enabledLookbacks: [...enabledLookbacks],
      bandsEnabledLookbacks: [...bandsEnabledLookbacks],
      instances,
      hasPendingWork: Boolean(pendingSignature || pendingWork.length > 0),
    };
  }

  return {
    setEnabledLookbacks,
    setBandsEnabledLookbacks,
    setCandles,
    updateLast,
    applyTheme,
    detach,
    getDebugState,
  };
}
