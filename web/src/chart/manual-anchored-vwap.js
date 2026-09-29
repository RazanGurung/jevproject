/**
 * User-placed, pivot-snapped anchored VWAPs.
 *
 * Anchors persist per coin as exact event timestamps. The visual marker snaps
 * to a nearby confirmed swing high/low (or the clicked candle's HLC3), while
 * the indicator itself remains conventional volume-weighted HLC3 math.
 */

import { DEFAULT_AVWAP_HEX, anchoredVwapHex, anchoredVwapBandHex } from './vwap-colors.js';
import { colorWithAlpha } from '../services/color-palette.js';
import { applyChartNavigation } from './chart-navigation.js';

const STORAGE_PREFIX = 'pez:manual-anchored-vwap:';
const STORAGE_VERSION = 1;
const SEARCH_RADIUS = 5;
const PIVOT_WING = 2;
const MARKER_DOT_RADIUS_PX = 4.5;
const SELECTED_MARKER_DOT_RADIUS_PX = 6;
const MARKER_RING_RADIUS_PX = 10;
const SELECTED_MARKER_RING_RADIUS_PX = 12;
const MARKER_HIT_PX = 13;
const DELETE_HIT_PX = 9;
const DEFAULT_COLOR = DEFAULT_AVWAP_HEX;
export const DEFAULT_MANUAL_ANCHOR_BANDS_VISIBLE = false;
export const DEFAULT_MANUAL_ANCHOR_SIGMA = 2;

export function normalizeManualAnchorSigma(value) {
  const sigma = Number(value);
  return sigma === 1 || sigma === 2 || sigma === 3 || sigma === 4 ? sigma : DEFAULT_MANUAL_ANCHOR_SIGMA;
}

export function normalizeManualAnchorBandsVisible(value) {
  return value === true || value === 'true';
}

export const normalizeManualAnchorTime = (time) => {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
};

export function formatManualAnchorDate(time) {
  const sec = normalizeManualAnchorTime(time);
  if (!(sec > 0)) return '';
  const d = new Date(sec * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = String(Math.abs(d.getUTCFullYear()) % 100).padStart(2, '0');
  return `${day}/${month}/${year}`;
}

function normalizedCandles(candles) {
  const byTime = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const t = normalizeManualAnchorTime(candle?.t);
    const h = Number(candle?.h);
    const l = Number(candle?.l);
    const c = Number(candle?.c);
    const v = Number(candle?.v);
    if (t > 0 && [h, l, c].every(Number.isFinite) && Number.isFinite(v) && v >= 0) {
      byTime.set(t, { ...candle, t });
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export function findManualPivotCandidates(candles, clickedIndex, {
  searchRadius = SEARCH_RADIUS,
  pivotWing = PIVOT_WING,
} = {}) {
  const rows = normalizedCandles(candles);
  const center = Math.max(0, Math.min(rows.length - 1, Math.round(Number(clickedIndex) || 0)));
  const from = Math.max(pivotWing, center - searchRadius);
  const to = Math.min(rows.length - pivotWing - 1, center + searchRadius);
  const candidates = [];
  for (let i = from; i <= to; i += 1) {
    const row = rows[i];
    const high = Number(row.h);
    const low = Number(row.l);
    let swingHigh = true;
    let swingLow = true;
    for (let d = 1; d <= pivotWing; d += 1) {
      swingHigh = swingHigh && high >= Number(rows[i - d].h) && high >= Number(rows[i + d].h);
      swingLow = swingLow && low <= Number(rows[i - d].l) && low <= Number(rows[i + d].l);
    }
    if (swingHigh) candidates.push({ index: i, time: row.t, price: high, kind: 'high' });
    if (swingLow) candidates.push({ index: i, time: row.t, price: low, kind: 'low' });
  }
  return candidates;
}

export function resolveManualPivot(candles, clickedIndex, clickPoint, pointForCandidate) {
  const rows = normalizedCandles(candles);
  if (!rows.length) return null;
  const center = Math.max(0, Math.min(rows.length - 1, Math.round(Number(clickedIndex) || 0)));
  const candidates = findManualPivotCandidates(rows, center);
  let best = null;
  for (const candidate of candidates) {
    const point = typeof pointForCandidate === 'function' ? pointForCandidate(candidate) : null;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const dx = point.x - Number(clickPoint?.x || 0);
    const dy = point.y - Number(clickPoint?.y || 0);
    const distance = Math.hypot(dx, dy);
    const timeDistance = Math.abs(candidate.index - center);
    if (!best || distance < best.distance
      || (distance === best.distance && timeDistance < best.timeDistance)
      || (distance === best.distance && timeDistance === best.timeDistance && candidate.time < best.anchor.time)) {
      best = { anchor: candidate, distance, timeDistance };
    }
  }
  if (best) return best.anchor;
  const row = rows[center];
  return {
    index: center,
    time: row.t,
    price: (Number(row.h) + Number(row.l) + Number(row.c)) / 3,
    kind: 'hlc3',
  };
}

function inferredInterval(rows, index) {
  const next = rows[index + 1]?.t;
  const previous = rows[index - 1]?.t;
  if (next > rows[index].t) return next - rows[index].t;
  if (previous > 0 && rows[index].t > previous) return rows[index].t - previous;
  return 3600;
}

export function computeManualAnchoredVwap(candles, eventTime, sigma = 2) {
  const rows = normalizedCandles(candles);
  const anchorTime = normalizeManualAnchorTime(eventTime);
  // An anchor older than the loaded window cannot be computed honestly. Wait
  // for history backfill instead of presenting the first loaded candle as the
  // false beginning of the anchored calculation.
  if (!rows.length || anchorTime < rows[0].t) return [];
  const multiplier = [1, 2, 3, 4].includes(Number(sigma)) ? Number(sigma) : 2;
  let sw = 0;
  let swx = 0;
  let swxx = 0;
  const output = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const interval = Math.max(1, inferredInterval(rows, i));
    const barEnd = row.t + interval;
    if (barEnd <= anchorTime) continue;
    let weight = Number(row.v);
    if (row.t < anchorTime) {
      weight *= Math.max(0, Math.min(1, (barEnd - anchorTime) / interval));
    }
    if (!(weight > 0)) continue;
    const price = (Number(row.h) + Number(row.l) + Number(row.c)) / 3;
    sw += weight;
    swx += weight * price;
    swxx += weight * price * price;
    const vwap = swx / sw;
    const variance = Math.max(0, swxx / sw - vwap * vwap);
    const deviation = Math.sqrt(variance) * multiplier;
    const upper = vwap + deviation;
    const lower = vwap - deviation;
    output.push({
      time: row.t,
      vwap,
      upper,
      lower,
      midUpper: (vwap + upper) / 2,
      midLower: (vwap + lower) / 2,
    });
  }
  return output;
}

function validStoredAnchor(anchor) {
  return anchor && typeof anchor.id === 'string'
    && normalizeManualAnchorTime(anchor.time) > 0
    && Number.isFinite(Number(anchor.price))
    && ['high', 'low', 'hlc3'].includes(anchor.kind);
}

function publicAnchor(anchor) {
  return {
    id: anchor.id,
    time: normalizeManualAnchorTime(anchor.time),
    price: Number(anchor.price),
    kind: anchor.kind,
    color: DEFAULT_COLOR,
    bandsVisible: normalizeManualAnchorBandsVisible(anchor.bandsVisible),
    sigma: normalizeManualAnchorSigma(anchor.sigma),
  };
}

export function serializeManualAnchors(anchors) {
  return JSON.stringify({
    version: STORAGE_VERSION,
    anchors: (Array.isArray(anchors) ? anchors : []).filter(validStoredAnchor).map(publicAnchor),
  });
}

export function deserializeManualAnchors(value) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { return []; }
  if (!parsed || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.anchors)) return [];
  return parsed.anchors.filter(validStoredAnchor).map(publicAnchor);
}

function loadAnchors(coin) {
  if (typeof localStorage === 'undefined' || !coin) return [];
  try { return deserializeManualAnchors(localStorage.getItem(`${STORAGE_PREFIX}${coin}`)); } catch { return []; }
}

function saveAnchors(coin, anchors) {
  if (typeof localStorage === 'undefined' || !coin) return;
  try {
    if (!anchors.length) localStorage.removeItem(`${STORAGE_PREFIX}${coin}`);
    else localStorage.setItem(`${STORAGE_PREFIX}${coin}`, serializeManualAnchors(anchors));
  } catch {}
}

let anchorId = 0;
function nextId() {
  anchorId += 1;
  return `avwap_${Date.now().toString(36)}_${anchorId.toString(36)}`;
}

export function createManualAnchoredVwapOverlay({ getChart, getCandleSeries, LineSeries, LineStyle } = {}) {
  if (typeof getChart !== 'function' || typeof getCandleSeries !== 'function' || !LineSeries || !LineStyle) {
    throw new Error('createManualAnchoredVwapOverlay requires getChart, getCandleSeries, LineSeries, LineStyle');
  }
  let coin = '';
  let candles = [];
  let anchors = [];
  let visible = false;
  let placementActive = false;
  let selectedId = null;
  let draggingId = null;
  let dragPoint = null;
  let attachedSeries = null;
  let attachedChart = null;
  let requestUpdate = null;
  let seriesById = new Map();
  let deleteHit = null;
  let onPlacementChange = null;
  let onAnchorsChange = null;
  let onSelectionChange = null;
  let onViewChange = null;
  let lastSnapshotRevision = -1;
  let lastRenderSignature = '';
  let dataSetCount = 0;
  let latestValuesByAnchor = {};

  const style = (color, opacity = 1, width = 2, dotted = false, { title = '', lastValueVisible = false } = {}) => ({
    color: opacity === 1 ? color : `${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`,
    lineWidth: width,
    lineStyle: dotted ? LineStyle.Dotted : LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: Boolean(lastValueVisible),
    title: title || '',
    crosshairMarkerVisible: false,
    // AVWAP is denominated in the same price units as candles. Keeping these
    // lines on the visible right scale lets Lightweight Charts' native
    // autoscaler fit candles and every visible AVWAP/band together.
    priceScaleId: 'right',
  });

  function candleSourceSignature() {
    if (candles.length === 0) return `0:${lastSnapshotRevision}`;
    const first = candles[0];
    const last = candles[candles.length - 1];
    return [
      candles.length,
      first?.t || 0,
      last?.t || 0,
      last?.o || '',
      last?.h || '',
      last?.l || '',
      last?.c || '',
      last?.v || '',
      lastSnapshotRevision,
    ].join(':');
  }

  function snapshotAnchors() {
    return anchors.map(publicAnchor);
  }

  function notifyAnchorsChange() {
    try { onAnchorsChange?.(snapshotAnchors()); } catch {}
  }

  function getSelectedAnchor() {
    if (!visible || !selectedId) return null;
    const anchor = anchors.find((item) => item.id === selectedId);
    return anchor ? publicAnchor(anchor) : null;
  }

  function getSelectedPoint() {
    if (!visible || !selectedId) return null;
    const anchor = anchors.find((item) => item.id === selectedId);
    if (!anchor) return null;
    if (draggingId === selectedId && dragPoint) return { x: dragPoint.x, y: dragPoint.y };
    return pointToPx(anchor);
  }

  function notifySelectionChange() {
    try { onSelectionChange?.(getSelectedAnchor()); } catch {}
  }

  function renderSignature() {
    return JSON.stringify({
      coin,
      source: candleSourceSignature(),
      visible,
      anchors: snapshotAnchors().map((anchor) => [
        anchor.id,
        anchor.time,
        anchor.price,
        anchor.kind,
        anchor.bandsVisible,
        anchor.sigma,
      ]),
    });
  }

  function redraw() {
    try { requestUpdate?.(); } catch {}
    try { onViewChange?.(); } catch {}
  }

  function pointToPx(anchor) {
    const chart = getChart();
    const candleSeries = getCandleSeries();
    if (!chart || !candleSeries || !anchor) return null;
    const ts = chart.timeScale();
    const logical = ts.timeToIndex(anchor.time, true);
    const x = logical == null ? null : ts.logicalToCoordinate(logical);
    const y = candleSeries.priceToCoordinate(anchor.price);
    return x == null || y == null ? null : { x, y };
  }

  function drawMarkers(target) {
    if (!visible) return;
    target.useBitmapCoordinateSpace((scope) => {
      const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
      deleteHit = null;
      for (const anchor of anchors) {
        const point = draggingId === anchor.id && dragPoint ? dragPoint : pointToPx(anchor);
        if (!point) continue;
        const selected = selectedId === anchor.id;
        const x = point.x * hpr;
        const y = point.y * vpr;
        const pixelRatio = Math.max(hpr, vpr);
        const markerColor = selected ? '#ffb547' : anchoredVwapHex();
        const ringRadius = (selected ? SELECTED_MARKER_RING_RADIUS_PX : MARKER_RING_RADIUS_PX) * pixelRatio;
        const dotRadius = (selected ? SELECTED_MARKER_DOT_RADIUS_PX : MARKER_DOT_RADIUS_PX) * pixelRatio;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = markerColor;
        ctx.lineWidth = Math.max(1, 2 * pixelRatio);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = markerColor;
        ctx.fill();
        ctx.strokeStyle = '#111820';
        ctx.lineWidth = Math.max(1, 1.5 * hpr);
        ctx.stroke();
        if (selected) {
          const dx = point.x + 15;
          const dy = point.y - 15;
          deleteHit = { x: dx, y: dy };
          ctx.beginPath();
          ctx.arc(dx * hpr, dy * vpr, DELETE_HIT_PX * Math.max(hpr, vpr), 0, Math.PI * 2);
          ctx.fillStyle = '#d9534f';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = Math.max(1, hpr);
          const k = 3.5 * hpr;
          ctx.beginPath();
          ctx.moveTo(dx * hpr - k, dy * vpr - k);
          ctx.lineTo(dx * hpr + k, dy * vpr + k);
          ctx.moveTo(dx * hpr + k, dy * vpr - k);
          ctx.lineTo(dx * hpr - k, dy * vpr + k);
          ctx.stroke();
        }
        ctx.restore();
      }
    });
  }
  const anchorRows = new Map();

  function drawBandFills(target) {
    if (!visible) return;
    target.useBitmapCoordinateSpace((scope) => {
      const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
      const chart = getChart();
      const candleSeries = getCandleSeries();
      if (!chart || !candleSeries) return;
      const ts = chart.timeScale();
      const bandColor = anchoredVwapBandHex();

      for (const anchor of anchors) {
        const cached = anchorRows.get(anchor.id);
        if (!cached || !cached.bandsVisible || !Array.isArray(cached.rows) || cached.rows.length < 2) continue;
        const rows = cached.rows;

        const pts = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const logical = ts.timeToIndex(row.time, true);
          if (logical == null) continue;
          const xMedia = ts.logicalToCoordinate(logical);
          if (xMedia == null) continue;
          const yUpperMedia = candleSeries.priceToCoordinate(row.upper);
          const yLowerMedia = candleSeries.priceToCoordinate(row.lower);
          const yMidUpperMedia = candleSeries.priceToCoordinate(row.midUpper);
          const yMidLowerMedia = candleSeries.priceToCoordinate(row.midLower);
          if (yUpperMedia == null || yLowerMedia == null) continue;

          pts.push({
            x: xMedia * hpr,
            yUpper: yUpperMedia * vpr,
            yLower: yLowerMedia * vpr,
            yMidUpper: yMidUpperMedia != null ? yMidUpperMedia * vpr : null,
            yMidLower: yMidLowerMedia != null ? yMidLowerMedia * vpr : null,
          });
        }

        if (pts.length < 2) continue;

        ctx.save();
        const hasInner = pts.every((p) => p.yMidUpper != null && p.yMidLower != null);

        if (hasInner) {
          // 1. Upper outer band strip (upper to midUpper): less transparent (higher opacity)
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].yUpper);
            else ctx.lineTo(pts[i].x, pts[i].yUpper);
          }
          for (let i = pts.length - 1; i >= 0; i--) {
            ctx.lineTo(pts[i].x, pts[i].yMidUpper);
          }
          ctx.closePath();
          ctx.fillStyle = colorWithAlpha(bandColor, 0.12);
          ctx.fill();

          // 2. Lower outer band strip (midLower to lower): less transparent (higher opacity)
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].yMidLower);
            else ctx.lineTo(pts[i].x, pts[i].yMidLower);
          }
          for (let i = pts.length - 1; i >= 0; i--) {
            ctx.lineTo(pts[i].x, pts[i].yLower);
          }
          ctx.closePath();
          ctx.fillStyle = colorWithAlpha(bandColor, 0.12);
          ctx.fill();
          // 3. Inner band core (midUpper to midLower): more transparent (lower opacity)
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].yMidUpper);
            else ctx.lineTo(pts[i].x, pts[i].yMidUpper);
          }
          for (let i = pts.length - 1; i >= 0; i--) {
            ctx.lineTo(pts[i].x, pts[i].yMidLower);
          }
          ctx.closePath();
          ctx.fillStyle = colorWithAlpha(bandColor, 0.04);
          ctx.fill();
        } else {
          // Single outer envelope
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].yUpper);
            else ctx.lineTo(pts[i].x, pts[i].yUpper);
          }
          for (let i = pts.length - 1; i >= 0; i--) {
            ctx.lineTo(pts[i].x, pts[i].yLower);
          }
          ctx.closePath();
          ctx.fillStyle = colorWithAlpha(bandColor, 0.12);
          ctx.fill();
        }
        ctx.restore();
      }
    });
  }

  const primitive = {
    attached(params) { requestUpdate = params?.requestUpdate || null; },
    detached() { requestUpdate = null; },
    updateAllViews() {},
    autoscaleInfo() { return null; },
    paneViews: () => [
      { zOrder: () => 'top', renderer: () => ({ draw: drawMarkers }) },
      { zOrder: () => 'bottom', renderer: () => ({ draw: drawBandFills }) },
    ],
  };

  function attachPrimitive() {
    const series = getCandleSeries();
    if (!visible || !series || typeof series.attachPrimitive !== 'function') return false;
    if (attachedSeries === series) return true;
    if (attachedSeries?.detachPrimitive) { try { attachedSeries.detachPrimitive(primitive); } catch {} }
    attachedSeries = series;
    try { series.attachPrimitive(primitive); return true; } catch { attachedSeries = null; return false; }
  }

  function removeLineSeries() {
    const chart = attachedChart || getChart();
    if (chart) {
      for (const entry of seriesById.values()) {
        for (const line of [entry.vwap, entry.upper, entry.lower, entry.midUpper, entry.midLower]) {
          try { chart.removeSeries(line); } catch {}
        }
      }
    }
    seriesById = new Map();
    anchorRows.clear();
    attachedChart = null;
    lastRenderSignature = '';
    latestValuesByAnchor = {};
  }

  function syncLines() {
    const chart = getChart();
    if (!visible || !chart) { removeLineSeries(); redraw(); return; }
    attachPrimitive();
    if (attachedChart && attachedChart !== chart) removeLineSeries();
    attachedChart = chart;
    const wanted = new Set(anchors.map((anchor) => anchor.id));
    for (const [id, entry] of seriesById.entries()) {
      if (wanted.has(id)) continue;
      for (const line of [entry.vwap, entry.upper, entry.lower, entry.midUpper, entry.midLower]) {
        try { chart.removeSeries(line); } catch {}
      }
      seriesById.delete(id);
      anchorRows.delete(id);
    }
    for (const anchor of anchors) {
      const activeColor = anchoredVwapHex();
      const chartLabel = formatManualAnchorDate(anchor.time);
      let entry = seriesById.get(anchor.id);
      if (!entry) {
        entry = {
          chartLabel,
          vwap: chart.addSeries(LineSeries, style(activeColor, 1, 2, false, { title: chartLabel, lastValueVisible: true })),
          upper: chart.addSeries(LineSeries, style(activeColor, 0.62, 1)),
          lower: chart.addSeries(LineSeries, style(activeColor, 0.62, 1)),
          midUpper: chart.addSeries(LineSeries, style(activeColor, 0.30, 1, true)),
          midLower: chart.addSeries(LineSeries, style(activeColor, 0.30, 1, true)),
        };
        seriesById.set(anchor.id, entry);
      }
      entry.chartLabel = chartLabel;
      entry.vwap.applyOptions?.(style(activeColor, 1, 2, false, { title: chartLabel, lastValueVisible: true }));
      entry.upper.applyOptions?.(style(activeColor, 0.62, 1));
      entry.lower.applyOptions?.(style(activeColor, 0.62, 1));
      entry.midUpper.applyOptions?.(style(activeColor, 0.30, 1, true));
      entry.midLower.applyOptions?.(style(activeColor, 0.30, 1, true));
    }
    const nextRenderSignature = renderSignature();
    if (nextRenderSignature === lastRenderSignature) {
      redraw();
      return;
    }
    const applyAnchorSeriesData = (seriesInstance, data) => {
      try {
        seriesInstance.setData(data);
      } catch {
        try { chart?.clearCrosshairPosition?.(); } catch {}
        try { seriesInstance.setData(data); } catch {}
      }
    };
    const nextLatestValues = {};
    for (const anchor of anchors) {
      const entry = seriesById.get(anchor.id);
      if (!entry) continue;
      const settings = publicAnchor(anchor);
      const rows = computeManualAnchoredVwap(candles, settings.time, settings.sigma);
      const showBands = settings.bandsVisible;
      anchorRows.set(anchor.id, { rows, bandsVisible: showBands });
      applyAnchorSeriesData(entry.vwap, rows.map((row) => ({ time: row.time, value: row.vwap })));
      applyAnchorSeriesData(entry.upper, showBands ? rows.map((row) => ({ time: row.time, value: row.upper })) : []);
      applyAnchorSeriesData(entry.lower, showBands ? rows.map((row) => ({ time: row.time, value: row.lower })) : []);
      applyAnchorSeriesData(entry.midUpper, showBands ? rows.map((row) => ({ time: row.time, value: row.midUpper })) : []);
      applyAnchorSeriesData(entry.midLower, showBands ? rows.map((row) => ({ time: row.time, value: row.midLower })) : []);
      dataSetCount += 5;
      const latest = rows.at(-1);
      nextLatestValues[anchor.id] = latest ? {
        time: Number(latest.time || 0),
        chartLabel: formatManualAnchorDate(anchor.time),
        vwap: Number.isFinite(latest.vwap) ? latest.vwap : null,
        upper: Number.isFinite(latest.upper) ? latest.upper : null,
        lower: Number.isFinite(latest.lower) ? latest.lower : null,
        midUpper: Number.isFinite(latest.midUpper) ? latest.midUpper : null,
        midLower: Number.isFinite(latest.midLower) ? latest.midLower : null,
      } : null;
    }
    latestValuesByAnchor = nextLatestValues;
    lastRenderSignature = nextRenderSignature;
    redraw();
  }

  function setScrollEnabled(enabled) {
    applyChartNavigation(getChart(), enabled);
  }

  // Reconnect/tab-resume can drop pointerup while an anchor is mid-drag and
  // leave handleScroll false forever. Clear the drag and restore navigation
  // unless placement is intentionally armed. Always re-apply so a desynced
  // LC surface cannot stay frozen.
  function releaseStuckGestures() {
    const hadDrag = draggingId != null;
    draggingId = null;
    dragPoint = null;
    if (placementActive) {
      setScrollEnabled(false);
      return false;
    }
    if (hadDrag) redraw();
    setScrollEnabled(true);
    return true;
  }

  function notifyPlacement() { try { onPlacementChange?.(placementActive); } catch {} }

  function setPlacementActive(active) {
    placementActive = active === true;
    if (placementActive) {
      selectedId = null;
      visible = true;
      attachPrimitive();
      setScrollEnabled(false);
      notifySelectionChange();
    } else if (!draggingId) {
      setScrollEnabled(true);
    }
    notifyPlacement();
    redraw();
  }

  function nearestCandleIndex(time) {
    if (!candles.length) return -1;
    let best = 0;
    let distance = Infinity;
    candles.forEach((row, index) => {
      const d = Math.abs(normalizeManualAnchorTime(row.t) - time);
      if (d < distance) { distance = d; best = index; }
    });
    return best;
  }

  function resolveAt(x, y) {
    const chart = getChart();
    const candleSeries = getCandleSeries();
    if (!chart || !candleSeries || !candles.length) return null;
    const ts = chart.timeScale();
    let time = normalizeManualAnchorTime(ts.coordinateToTime(x));
    if (!(time > 0)) {
      const logical = ts.coordinateToLogical(x);
      const index = logical == null ? null : Math.round(logical);
      time = index == null ? 0 : normalizeManualAnchorTime(candles[Math.max(0, Math.min(candles.length - 1, index))]?.t);
    }
    if (!(time > 0)) return null;
    const clickedIndex = nearestCandleIndex(time);
    return resolveManualPivot(candles, clickedIndex, { x, y }, (candidate) => {
      const logical = ts.timeToIndex(candidate.time, true);
      const cx = logical == null ? null : ts.logicalToCoordinate(logical);
      const cy = candleSeries.priceToCoordinate(candidate.price);
      return cx == null || cy == null ? null : { x: cx, y: cy };
    });
  }

  function hitAnchor(x, y) {
    let best = null;
    for (const anchor of anchors) {
      const point = pointToPx(anchor);
      if (!point) continue;
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= MARKER_HIT_PX && (!best || distance < best.distance)) best = { anchor, distance };
    }
    return best?.anchor || null;
  }

  function removeSelected() {
    if (!selectedId) return false;
    const before = anchors.length;
    anchors = anchors.filter((anchor) => anchor.id !== selectedId);
    selectedId = null;
    if (anchors.length === before) return false;
    saveAnchors(coin, anchors);
    notifyAnchorsChange();
    notifySelectionChange();
    syncLines();
    return true;
  }

  function onClick(x, y) {
    if (!visible && !placementActive) return false;
    if (selectedId && deleteHit && Math.hypot(deleteHit.x - x, deleteHit.y - y) <= DELETE_HIT_PX + 2) {
      return removeSelected();
    }
    if (placementActive) {
      const pivot = resolveAt(x, y);
      if (!pivot) return true;
      const created = publicAnchor({
        id: nextId(),
        time: pivot.time,
        price: pivot.price,
        kind: pivot.kind,
        color: DEFAULT_COLOR,
        bandsVisible: DEFAULT_MANUAL_ANCHOR_BANDS_VISIBLE,
        sigma: DEFAULT_MANUAL_ANCHOR_SIGMA,
      });
      anchors.push(created);
      selectedId = created.id;
      saveAnchors(coin, anchors);
      notifyAnchorsChange();
      setPlacementActive(false);
      notifySelectionChange();
      syncLines();
      return true;
    }
    const hit = hitAnchor(x, y);
    if (!hit) {
      if (selectedId) {
        selectedId = null;
        notifySelectionChange();
        redraw();
        // Deselecting an anchor must not also edit the limit-order price.
        return true;
      }
      return false;
    }
    selectedId = hit.id;
    notifySelectionChange();
    redraw();
    return true;
  }

  function onPointerDown(x, y) {
    if (!visible || placementActive) return false;
    const hit = hitAnchor(x, y);
    if (!hit) return false;
    selectedId = hit.id;
    draggingId = hit.id;
    dragPoint = { x, y };
    setScrollEnabled(false);
    notifySelectionChange();
    redraw();
    return true;
  }

  function onPointerMove(x, y) {
    if (!draggingId) return false;
    dragPoint = { x, y };
    redraw();
    return true;
  }

  function onPointerUp() {
    if (!draggingId) return false;
    const id = draggingId;
    const point = dragPoint;
    draggingId = null;
    dragPoint = null;
    const pivot = point ? resolveAt(point.x, point.y) : null;
    if (pivot) {
      anchors = anchors.map((anchor) => anchor.id === id ? publicAnchor({
        ...anchor, time: pivot.time, price: pivot.price, kind: pivot.kind,
      }) : anchor);
      saveAnchors(coin, anchors);
      notifyAnchorsChange();
      syncLines();
    }
    setScrollEnabled(true);
    notifySelectionChange();
    redraw();
    return true;
  }

  function cancel() {
    if (placementActive) { setPlacementActive(false); return true; }
    if (selectedId) {
      selectedId = null;
      notifySelectionChange();
      redraw();
      return true;
    }
    return false;
  }

  function deleteAt(x, y) {
    const hit = hitAnchor(x, y);
    if (!hit) return false;
    selectedId = hit.id;
    return removeSelected();
  }

  function setCandles(nextCandles, nextCoin = '', _timeframe = '', snapshotRevision) {
    const changedCoin = nextCoin !== coin;
    candles = normalizedCandles(nextCandles);
    if (Number.isFinite(Number(snapshotRevision))) {
      lastSnapshotRevision = Number(snapshotRevision);
    }
    if (changedCoin) {
      coin = nextCoin || '';
      anchors = loadAnchors(coin);
      selectedId = null;
      draggingId = null;
      setPlacementActive(false);
      removeLineSeries();
      notifyAnchorsChange();
      notifySelectionChange();
    }
    syncLines();
  }

  function updateLast(nextCandles, nextCoin = '', timeframe = '') {
    setCandles(nextCandles, nextCoin, timeframe);
  }

  function setOptions(options = {}) {
    visible = options.visible === true;
    if (!visible) {
      selectedId = null;
      setPlacementActive(false);
      removeLineSeries();
      if (attachedSeries?.detachPrimitive) { try { attachedSeries.detachPrimitive(primitive); } catch {} }
      attachedSeries = null;
      notifySelectionChange();
    } else {
      syncLines();
    }
  }

  function setAnchorOptions(id, options = {}) {
    const targetId = String(id || '');
    if (!targetId) return false;
    let changed = false;
    anchors = anchors.map((anchor) => {
      if (anchor.id !== targetId) return anchor;
      const next = publicAnchor({
        ...anchor,
        bandsVisible: 'bandsVisible' in options ? options.bandsVisible : anchor.bandsVisible,
        sigma: 'sigma' in options ? options.sigma : anchor.sigma,
      });
      if (
        next.bandsVisible === normalizeManualAnchorBandsVisible(anchor.bandsVisible)
        && next.sigma === normalizeManualAnchorSigma(anchor.sigma)
      ) {
        return publicAnchor(anchor);
      }
      changed = true;
      return next;
    });
    if (!changed) return false;
    saveAnchors(coin, anchors);
    notifyAnchorsChange();
    notifySelectionChange();
    syncLines();
    return true;
  }

  function detach() {
    removeLineSeries();
    if (attachedSeries?.detachPrimitive) { try { attachedSeries.detachPrimitive(primitive); } catch {} }
    attachedSeries = null;
    requestUpdate = null;
    draggingId = null;
    setScrollEnabled(true);
  }

  function applyTheme() { syncLines(); }
  function setOnPlacementChange(callback) { onPlacementChange = typeof callback === 'function' ? callback : null; }
  function setOnAnchorsChange(callback) { onAnchorsChange = typeof callback === 'function' ? callback : null; }
  function setOnSelectionChange(callback) { onSelectionChange = typeof callback === 'function' ? callback : null; }
  function setOnViewChange(callback) { onViewChange = typeof callback === 'function' ? callback : null; }
  const getDebugState = () => ({
    attached: visible && Boolean(attachedSeries),
    visible,
    coin,
    candleCount: candles.length,
    lastCandleTime: normalizeManualAnchorTime(candles[candles.length - 1]?.t),
    anchorCount: anchors.length,
    renderedAnchorCount: seriesById.size,
    placementActive,
    selectedId,
    dragging: Boolean(draggingId),
    dataSetCount,
    lastRenderSignature,
    latestValuesByAnchor: { ...latestValuesByAnchor },
    anchors: snapshotAnchors(),
  });

  return {
    setCandles,
    updateLast,
    setOptions,
    setAnchorOptions,
    getAnchors: snapshotAnchors,
    setPlacementActive,
    setOnPlacementChange,
    setOnAnchorsChange,
    setOnSelectionChange,
    setOnViewChange,
    getSelectedAnchor,
    getSelectedPoint,
    isPlacementActive: () => placementActive,
    hasSelection: () => selectedId != null,
    isDragging: () => draggingId != null,
    onClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    cancel,
    removeSelected,
    deleteAt,
    releaseStuckGestures,
    applyTheme,
    detach,
    getDebugState,
  };
}
