/**
 * Drawing tools — user-drawn technical-analysis markups (trend lines, rays,
 * horizontal lines, boxes, circles, parallel channels).
 *
 * Rendering uses a single lightweight-charts series primitive attached to the
 * candle series (same pattern as monthly-volume-profile.js): shapes are drawn in
 * bitmap coordinate space and track pan/zoom automatically. Each drawing is
 * anchored to { time, price } points — `time` is the value returned by
 * timeScale().coordinateToTime() and is fed back through timeScale().timeToIndex()
 * for rendering, so anchors survive reloads and history backfills (logical
 * indices shift on prepend; times do not).
 *
 * Drawings persist per coin in localStorage under `pez:drawings:<coin>` (mirrors
 * the `pez:`-prefixed keys used elsewhere, e.g. bottom-panel-resize.js).
 *
 * Interaction is driven by chart-interactions.js, which routes pointer events to
 * this overlay when a tool is active or a drawing is being edited. While a tool
 * is active the chart's native scroll/scale is disabled so clicks place points
 * cleanly; it is restored when the tool clears. Tools stay armed after each
 * completed placement (keep-drawing) until the user toggles the tool off,
 * presses Escape, or selects another tool.
 */

import { fmtPrice } from '../utils/format.js';
import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
import {
  DEFAULT_TEXT_FONT_SIZE,
  promptTextDrawing,
} from '../ui/drawing-text-dialog.js';
import {
  pointToSegmentDistance,
  pointToRayDistance,
  pointToLineDistance,
  pointToRectDistance,
  pointToEllipseDistance,
  pointToCircleDistance,
  pointToQuadraticDistance,
  quadraticControlThroughMid,
  rayExit,
} from './drawing-geometry.js';
import { applyChartNavigation } from './chart-navigation.js';
import {
  toolColor,
  renderedDrawingColor,
  requiredPoints,
  placementPoints,
  isDrawingType,
  isPositionType,
  isFreehandType,
  isPolylineType,
  isVariableLengthType,
  buildPositionPoints,
  createDrawingId,
  serializeDrawings,
  deserializeDrawings,
  loadDrawings,
  saveDrawings,
  POINT_COUNTS,
  FIB_LEVELS,
  DEFAULT_COLOR,
} from './drawing-model.js';
import {
  strokePath,
  fillArrowHead,
  fillMarkerArrow,
  drawShape as renderDrawShape,
  drawSquareHandles,
  drawDeleteControl,
  MARKER_W,
  MARKER_H,
  MARKER_STEM_W,
  MARKER_HEAD_H,
  ARROWHEAD_LEN,
  ARROWHEAD_HALF_W,
} from './drawing-render.js';
export {
  toolColor,
  renderedDrawingColor,
  requiredPoints,
  placementPoints,
  isDrawingType,
  isPositionType,
  isFreehandType,
  isPolylineType,
  buildPositionPoints,
  createDrawingId,
  serializeDrawings,
  deserializeDrawings,
  loadDrawings,
  saveDrawings,
} from './drawing-model.js';

export {
  pointToSegmentDistance,
  pointToRayDistance,
  pointToLineDistance,
  pointToRectDistance,
  pointToEllipseDistance,
  pointToCircleDistance,
  pointToQuadraticDistance,
  quadraticControlThroughMid,
  rayExit,
} from './drawing-geometry.js';

const HANDLE_HIT_PX = 8;
const LINE_HIT_PX = 6;
const DELETE_BTN_R = 9;        // delete-button radius, media px
const DELETE_BTN_OFFSET = 14;  // offset from the drawing's top-right corner
const SELECTED_COLOR = '#ffb547';
const DELETE_COLOR = '#d9534f';
const CIRCLE_MIN_RADIUS_PX = 3;

// Long/Short position-tool palette — matches the active (classic) theme.
const POS_ENTRY = '#c1c7cf';
const POS_LABEL = '#c1c7cf';

const drawingColor = () => getPaletteColor('drawing');
const bullishColor = () => getPaletteColor('bullish');
const bearishColor = () => getPaletteColor('bearish');
const riskFillColor = () => colorWithAlpha(bearishColor(), 0.10);
const rewardFillColor = () => colorWithAlpha(bullishColor(), 0.10);

// Position boxes project forward this many bars from the entry.
const POSITION_WIDTH_BARS = 30;

const FREEHAND_MIN_PX = 2;

// Position tools: 2 placement clicks expand into 5 stored levels at commit.
const PLACEMENT_POINTS = {
  longPosition: 2,
  shortPosition: 2,
};

function normalizeFontSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 8 || n > 72) return DEFAULT_TEXT_FONT_SIZE;
  return Math.round(n);
}

// ---- overlay factory ----

const FIXED_TIMEFRAME_SECONDS = Object.freeze({
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '2h': 2 * 60 * 60,
  '4h': 4 * 60 * 60,
  '8h': 8 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
});

export function createDrawingToolsOverlay({
  getChart,
  getCandleSeries,
  allowedTools = null,    // Set of permitted tool types, or null for all
  storageSuffix = '',     // appended to the per-coin localStorage key
  // Optional async ({ defaultFontSize }) => { text, fontSize } | null
  promptTextLabel = promptTextDrawing,
  getTimeframe = null,
  getBarTimes = null,
} = {}) {
  if (typeof getChart !== 'function' || typeof getCandleSeries !== 'function') {
    throw new Error('createDrawingToolsOverlay requires getChart, getCandleSeries');
  }
  const toolAllowed = (type) => isDrawingType(type) && (!allowedTools || allowedTools.has(type));
  const askTextLabel = typeof promptTextLabel === 'function' ? promptTextLabel : promptTextDrawing;

  let attachedChart = null;
  let attachedSeries = null;
  let requestUpdate = null;

  let coin = '';
  let drawings = [];
  let activeTool = null;
  let pending = null;            // { type, points: [...] } while placing
  let previewPoint = null;       // current cursor as { time, price }
  let selectedId = null;
  let textDialogOpen = false;    // suppress re-entry while label dialog is open
  let selectedDeleteBtn = null;  // { cx, cy, r } in media px for the ✕ hit-test
  let drag = null;               // { id, pointIndex } (-1 = whole drawing)
  let scrollDisabled = false;
  let onActiveToolChange = null; // notified whenever activeTool changes (incl. null)

  function fireToolChange() {
    if (typeof onActiveToolChange === 'function') {
      try { onActiveToolChange(activeTool); } catch {}
    }
  }

  // ---- coordinate conversion ----
  // Resolve a click/drag to an anchor. Over data the time scale maps directly;
  // in the right-edge whitespace there is no bar, so extrapolate a future time
  // from the live edge's bar interval — letting any drawing be placed/dragged
  // past the last candle. Left-edge whitespace (barsFromEnd <= 0) stays off-data.
  function pxToPoint(x, y) {
    const chart = getChart();
    const series = getCandleSeries();
    if (!chart || !series) return null;
    const price = series.coordinateToPrice(y);
    if (!Number.isFinite(price)) return null;
    const ts = chart.timeScale();
    const time = ts.coordinateToTime(x);
    if (time != null) return { time, price };
    // Future whitespace: derive the whole-bar offset from the live edge.
    const lb = lastTwoBars();
    const iv = barInterval();
    const logical = ts.coordinateToLogical(x);
    if (!lb || iv == null || logical == null) return null;
    const lastIdx = ts.timeToIndex(lb.last.time, true);
    if (lastIdx == null) return null;
    const barsFromEnd = Math.round(logical - lastIdx);
    if (barsFromEnd <= 0) return null; // left/other off-data, not the future
    return { time: Number(lb.last.time) + barsFromEnd * iv, price };
  }

  // Convert an anchor { time, price } to media (CSS) pixels, or null off-data.
  // Times past the live edge extrapolate a logical index (via logicalIndexForTime)
  // so any drawing — not just positions — renders in the future whitespace.
  function pointToPx(point) {
    const chart = getChart();
    const series = getCandleSeries();
    if (!chart || !series || !point) return null;
    const ts = chart.timeScale();
    const idx = logicalIndexForTime(point.time);
    if (idx == null) return null;
    const x = ts.logicalToCoordinate(idx);
    const yv = series.priceToCoordinate(point.price);
    if (x == null || yv == null) return null;
    return { x, y: yv };
  }

  function drawingPx(drawing) {
    if (!drawing) return null;
    const pts = [];
    for (const p of drawing.points) {
      const px = pointToPx(p);
      if (!px) return null;
      pts.push(px);
    }
    return pts;
  }

  // The series' last two bars — used to extrapolate bar interval/index past the
  // live edge so a position can be anchored in the future whitespace.
  function lastTwoBars() {
    // Production supplies canonical last/prev unix seconds so pointer moves
    // never call series.data() (LC 5.2 maps the entire series on each call).
    if (typeof getBarTimes === 'function') {
      const times = getBarTimes();
      const last = Number(times?.last || 0);
      const prev = Number(times?.prev || 0);
      if (last > 0 && prev > 0 && last > prev) {
        return { last: { time: last }, prev: { time: prev } };
      }
    }
    const series = getCandleSeries();
    const data = series && typeof series.data === 'function' ? series.data() : null;
    if (!Array.isArray(data) || data.length < 2) return null;
    return { last: data[data.length - 1], prev: data[data.length - 2] };
  }

  function barInterval() {
    const timeframe = typeof getTimeframe === 'function' ? getTimeframe() : '';
    if (timeframe === '1M') {
      const lb = lastTwoBars();
      if (lb) {
        const iv = Number(lb.last.time) - Number(lb.prev.time);
        if (iv > 0) return iv;
      }
      return 30 * 24 * 60 * 60;
    }
    const fixed = FIXED_TIMEFRAME_SECONDS[timeframe];
    if (fixed > 0) return fixed;
    const lb = lastTwoBars();
    if (!lb) return null;
    const iv = Number(lb.last.time) - Number(lb.prev.time);
    return iv > 0 ? iv : null;
  }

  // The logical index for a (possibly future) time. For times at/before the live
  // edge, the time scale maps directly; past it there is no bar, so we extend the
  // last index by the whole-bar offset implied by the bar interval.
  function logicalIndexForTime(time) {
    const chart = getChart();
    if (!chart) return null;
    const ts = chart.timeScale();
    const lb = lastTwoBars();
    if (lb) {
      const lastTime = Number(lb.last.time);
      // Same interval as pxToPoint: selected timeframe (or last-two-bar gap for 1M /
      // unknown TFs). A sparse last candle must not stretch or compress future
      // drawings on render, hit-test, or drag.
      const iv = barInterval();
      const lastIdx = ts.timeToIndex(lb.last.time, true);
      if (time > lastTime && iv > 0 && lastIdx != null) {
        return lastIdx + Math.round((time - lastTime) / iv);
      }
    }
    return ts.timeToIndex(time, true);
  }

  // Resolve an entry anchor from a click: a real bar when the click is over data,
  // otherwise an extrapolated future time so the entry can sit in the whitespace
  // to the right of the last candle.
  function positionEntryAt(x, y) {
    return pxToPoint(x, y);
  }

  // Horizontal media-px bounds of a position box: from the entry (which may be in
  // the future) projected POSITION_WIDTH_BARS further right via logical
  // coordinates, so the box extends into the chart's whitespace.
  function positionBoxX(levels) {
    const chart = getChart();
    if (!chart || !Array.isArray(levels) || !levels.length) return null;
    const ts = chart.timeScale();
    const idx = logicalIndexForTime(levels[0].time);
    if (idx == null) return null;
    const x0 = ts.logicalToCoordinate(idx);
    const x1 = ts.logicalToCoordinate(idx + POSITION_WIDTH_BARS);
    if (x0 == null || x1 == null) return null;
    return { x0: Math.min(x0, x1), x1: Math.max(x0, x1) };
  }

  // ---- rendering ----
  function shapeOpts(extra = {}) {
    return {
      coin,
      fmtPrice,
      colors: {
        riskFill: riskFillColor(),
        rewardFill: rewardFillColor(),
        bullish: bullishColor(),
        bearish: bearishColor(),
        entry: POS_ENTRY,
        label: POS_LABEL,
        selected: SELECTED_COLOR,
      },
      positionBoxX,
      logicalIndexForTime,
      defaultTextFontSize: DEFAULT_TEXT_FONT_SIZE,
      fibLevels: FIB_LEVELS,
      ...extra,
    };
  }

  function drawShape(ctx, type, pts, ratios, full = true, levels = null, text = '', geometry = '', fontSize = 0, radius = 0, selected = false) {
    renderDrawShape(ctx, type, pts, ratios, shapeOpts({
      full, levels, text, geometry, fontSize, radius, selected,
    }));
  }

  function drawHandles(ctx, pts, hpr, vpr) {
    drawSquareHandles(ctx, pts, hpr, vpr, {
      handleHitPx: HANDLE_HIT_PX,
      fill: SELECTED_COLOR,
      stroke: '#000',
    });
  }

  function drawDeleteButton(ctx, pts, hpr, vpr, drawing = null, bounds = null) {
    let boundsPts = pts;
    if (drawing?.type === 'circle' && drawing?.geometry === 'centerRadius' && pts.length >= 2) {
      const dy = Math.abs(pts[1].y - pts[0].y);
      const dx = Math.abs(pts[1].x - pts[0].x);
      const r = Math.max(1, dy > 0 ? dy : dx);
      boundsPts = [
        { x: pts[0].x + r, y: pts[0].y - r },
      ];
    }
    selectedDeleteBtn = drawDeleteControl(ctx, boundsPts, hpr, vpr, {
      radius: DELETE_BTN_R,
      offset: DELETE_BTN_OFFSET,
      fill: DELETE_COLOR,
      maxW: bounds?.w != null ? bounds.w / hpr : null,
      maxH: bounds?.h != null ? bounds.h / vpr : null,
    });
  }

  function draw(target) {
    if (!attachedChart || !attachedSeries) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio;
      const vpr = scope.verticalPixelRatio;
      const w = scope.bitmapSize.width;
      const h = scope.bitmapSize.height;
      const ratios = { hpr, vpr, w, h };

      selectedDeleteBtn = null;
      const lineWidthPx = 1.5 * Math.max(hpr, vpr);
      ctx.lineWidth = lineWidthPx;
      for (const d of drawings) {
        const pts = drawingPx(d);
        if (!pts) continue;
        const selected = d.id === selectedId;
        ctx.strokeStyle = selected ? SELECTED_COLOR : renderedDrawingColor(d);
        ctx.setLineDash([]);
        drawShape(ctx, d.type, pts, ratios, true, d.points, d.text, d.geometry, d.fontSize || 0, d.radius || 0, selected);
        if (selected) {
          // Freehand paths have too many points for per-point handles; whole-move only.
          if (!isFreehandType(d.type)) {
            if (d.type === 'circle' && d.geometry === 'centerRadius' && pts.length >= 2) {
              const dy = Math.abs(pts[1].y - pts[0].y);
              const dx = Math.abs(pts[1].x - pts[0].x);
              const r = Math.max(1, dy > 0 ? dy : dx);
              const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
              const h1 = {
                x: pts[0].x + r * (Number.isFinite(angle) ? Math.cos(angle) : 0),
                y: pts[0].y + r * (Number.isFinite(angle) ? Math.sin(angle) : -1),
              };
              drawHandles(ctx, [pts[0], h1], hpr, vpr);
            } else {
              drawHandles(ctx, pts, hpr, vpr);
            }
          }
          drawDeleteButton(ctx, pts, hpr, vpr, d, { w, h });
          ctx.lineWidth = lineWidthPx;
        }
      }

      // In-progress placement preview (committed points + cursor), dashed.
      if (pending && pending.points.length > 0) {
        let previewLevels;
        if (isPositionType(pending.type)) {
          // Build the provisional 5 levels so they form live as the stop is set.
          const entryPt = pending.points[0];
          const stopPt = previewPoint || pending.points[1] || pending.points[0];
          previewLevels = buildPositionPoints(pending.type, entryPt, stopPt);
        } else if (isVariableLengthType(pending.type)) {
          // Variable-length paths preview every vertex placed so far.
          previewLevels = previewPoint ? [...pending.points, previewPoint] : pending.points;
        } else {
          previewLevels = previewPoint
            ? [...pending.points, previewPoint].slice(0, requiredPoints(pending.type))
            : pending.points;
        }
        const pts = previewLevels.map(pointToPx);
        if (pts.every(Boolean)) {
          ctx.strokeStyle = toolColor(pending.type);
          ctx.setLineDash([5 * hpr, 4 * hpr]);
          drawShape(ctx, pending.type, pts, ratios, true, previewLevels, '', pending.geometry, 0, drag?.radius || pending.radius || 0);
          ctx.setLineDash([]);
        }
      }
    });
  }

  const paneView = {
    zOrder: () => 'top',
    renderer: () => ({ draw }),
  };

  const primitive = {
    attached(params) {
      requestUpdate = params?.requestUpdate || null;
    },
    detached() {
      requestUpdate = null;
    },
    updateAllViews() {},
    paneViews: () => [paneView],
  };

  function redraw() {
    if (typeof requestUpdate === 'function') {
      try { requestUpdate(); } catch {}
    }
  }

  function attachIfNeeded() {
    const chart = getChart();
    const series = getCandleSeries();
    if (!chart || !series) return false;
    if (attachedChart === chart && attachedSeries === series) return true;
    rawDetach();
    if (typeof series.attachPrimitive !== 'function') return false;
    try {
      series.attachPrimitive(primitive);
      attachedChart = chart;
      attachedSeries = series;
      // Series recreation can reset LC options; re-assert the intended lock.
      // Prefer the armed-tool state, otherwise honor our last known flag.
      if (activeTool || scrollDisabled) {
        setScrollEnabled(false);
      } else {
        setScrollEnabled(true);
      }
      return true;
    } catch (err) {
      console.warn('[drawing-tools] attach failed:', err);
      attachedChart = null;
      attachedSeries = null;
      return false;
    }
  }

  function rawDetach() {
    if (attachedSeries && typeof attachedSeries.detachPrimitive === 'function') {
      try { attachedSeries.detachPrimitive(primitive); } catch {}
    }
    attachedChart = null;
    attachedSeries = null;
    requestUpdate = null;
  }

  function setScrollEnabled(enabled) {
    // Flag first so a null chart during teardown/recreate still remembers intent.
    scrollDisabled = !enabled;
    const chart = getChart();
    if (!chart || typeof chart.applyOptions !== 'function') return;
    // Always apply: another overlay (AVWAP) may have flipped handleScroll
    // without updating our flag, and reconnect can drop pointerup mid-drag.
    applyChartNavigation(chart, enabled);
  }

  // Drop stuck drag/placement locks after reconnect/tab-resume when no tool is
  // intentionally armed. Keep scroll disabled while a draw tool remains on.
  // Always re-apply navigation so a desynced LC surface cannot stay frozen.
  function releaseStuckGestures() {
    const hadDrag = drag != null;
    drag = null;
    if (activeTool) {
      if (hadDrag) {
        rearmActiveTool();
      } else {
        setScrollEnabled(false);
      }
      return false;
    }
    // Incomplete multi-click placement without an armed tool is inconsistent;
    // drop it so a dead pending cannot block the next idle restore.
    pending = null;
    previewPoint = null;
    if (hadDrag) redraw();
    setScrollEnabled(true);
    return true;
  }

  // ---- public interaction surface ----

  function setActiveTool(tool) {
    activeTool = toolAllowed(tool) ? tool : null;
    pending = activeTool ? { type: activeTool, points: [] } : null;
    previewPoint = null;
    drag = null;
    if (activeTool) {
      selectedId = null;
      attachIfNeeded();
      setScrollEnabled(false);
    } else {
      setScrollEnabled(true);
    }
    fireToolChange();
    redraw();
  }

  // Keep-drawing: after a successful (or discarded) placement, leave the tool
  // armed with a fresh pending so the next object can be placed immediately.
  function rearmActiveTool() {
    if (!activeTool) return;
    pending = { type: activeTool, points: [] };
    previewPoint = null;
    drag = null;
    setScrollEnabled(false);
  }

  function isToolActive() {
    return activeTool != null;
  }

  function hasSelection() {
    return selectedId != null;
  }

  function isDragging() {
    return drag != null;
  }

  function persist() {
    saveDrawings(coin, drawings, storageSuffix);
  }

  // Click while a tool is active places a point; completing a shape commits it.
  // Click with no tool selects/deselects. Returns true when handled (so the
  // caller suppresses price-picking).
  function onClick(x, y) {
    if (activeTool) {
      // Circle placement is press-drag (center → radius), not click-click. The
      // click synthesized after mouseup is swallowed by the chart's drag guard;
      // a standalone click here should not create a partial circle.
      if (activeTool === 'circle') return true;
      let point;
      if (isPositionType(activeTool) && pending.points.length === 0) {
        // Entry click: accept a real bar OR the future whitespace to the right of
        // the last candle (extrapolated time), so a setup can be planned forward.
        point = positionEntryAt(x, y);
        if (!point) return true;
      } else if (isPositionType(activeTool)) {
        // Stop click: only the price matters (the box projects forward from the
        // entry), so accept a click anywhere, including the future whitespace.
        const series = getCandleSeries();
        const price = series ? series.coordinateToPrice(y) : null;
        if (price == null || !Number.isFinite(price)) return true;
        point = { time: pending.points[0].time, price };
      } else {
        point = pxToPoint(x, y);
        if (!point) return true; // swallow clicks off the data area while drawing
      }
      attachIfNeeded();
      pending.points.push(point);
      if (pending.points.length >= placementPoints(activeTool)) {
        const type = activeTool;
        // Text opens a label+size dialog; placement commits when the user OK's.
        if (type === 'text') {
          if (textDialogOpen) {
            pending = { type, points: [] };
            previewPoint = null;
            redraw();
            return true;
          }
          const points = pending.points.slice();
          rearmActiveTool();
          redraw();
          textDialogOpen = true;
          Promise.resolve(askTextLabel({ defaultFontSize: DEFAULT_TEXT_FONT_SIZE }))
            .then((result) => {
              textDialogOpen = false;
              const text = typeof result?.text === 'string' ? result.text.trim() : '';
              if (!text) {
                redraw();
                return;
              }
              drawings.push({
                id: createDrawingId(),
                type: 'text',
                points,
                color: toolColor('text'),
                text,
                fontSize: normalizeFontSize(result?.fontSize || DEFAULT_TEXT_FONT_SIZE),
              });
              persist();
              redraw();
            })
            .catch(() => {
              textDialogOpen = false;
              redraw();
            });
          return true;
        }
        const points = isPositionType(type)
          ? buildPositionPoints(type, pending.points[0], pending.points[1])
          : pending.points;
        const drawing = {
          id: createDrawingId(),
          type,
          points,
          color: toolColor(type),
          text: '',
        };
        drawings.push(drawing);
        persist();
        rearmActiveTool();
      }
      redraw();
      return true;
    }

    // The ✕ button on the selected drawing deletes it.
    if (selectedId != null && hitDeleteButton(x, y)) {
      removeSelected();
      return true;
    }

    const hit = hitTest(x, y);
    if (hit) {
      selectedId = hit.id;
      redraw();
      return true;
    }
    if (selectedId != null) {
      selectedId = null;
      redraw();
      // This click was an intentional deselect. Consume it so it cannot also
      // change the order ticket's limit price.
      return true;
    }
    return false;
  }

  function hitDeleteButton(x, y) {
    if (!selectedDeleteBtn) return false;
    return Math.hypot(x - selectedDeleteBtn.cx, y - selectedDeleteBtn.cy) <= selectedDeleteBtn.r + 2;
  }

  // Double-click commits an in-progress polyline (zigzag). The two click events
  // that precede a dblclick each placed a vertex, so trailing vertices that sit
  // on top of their predecessor are dropped before committing.
  function onDblClick(x, y) {
    if (activeTool && isPolylineType(activeTool) && pending) {
      const points = [...pending.points];
      while (points.length >= 2) {
        const a = pointToPx(points[points.length - 2]);
        const b = pointToPx(points[points.length - 1]);
        if (a && b && Math.hypot(b.x - a.x, b.y - a.y) <= 3) points.pop();
        else break;
      }
      if (points.length >= 2) {
        drawings.push({
          id: createDrawingId(),
          type: pending.type,
          points,
          color: toolColor(pending.type),
          text: '',
        });
        persist();
      }
      rearmActiveTool();
      redraw();
      return true;
    }
    if (!activeTool) {
      const hit = hitTest(x, y);
      if (hit && hit.drawing.type === 'text') {
        const d = hit.drawing;
        if (textDialogOpen) return true;
        textDialogOpen = true;
        Promise.resolve(askTextLabel({
          defaultText: d.text || '',
          defaultFontSize: d.fontSize || DEFAULT_TEXT_FONT_SIZE,
        }))
          .then((result) => {
            textDialogOpen = false;
            const text = typeof result?.text === 'string' ? result.text.trim() : '';
            if (text) {
              d.text = text;
              d.fontSize = normalizeFontSize(result?.fontSize || DEFAULT_TEXT_FONT_SIZE);
              persist();
              redraw();
            }
          })
          .catch(() => {
            textDialogOpen = false;
          });
        return true;
      }
    }
    return false;
  }

  // Right-click delete: remove whichever drawing is under the pointer.
  function deleteAt(x, y) {
    if (selectedId != null && hitDeleteButton(x, y)) {
      removeSelected();
      return true;
    }
    const hit = hitTest(x, y);
    if (!hit) return false;
    drawings = drawings.filter((d) => d.id !== hit.id);
    if (selectedId === hit.id) selectedId = null;
    persist();
    redraw();
    return true;
  }

  function hitTest(x, y) {
    // Topmost first so recently drawn shapes win.
    for (let i = drawings.length - 1; i >= 0; i -= 1) {
      const d = drawings[i];
      const pts = drawingPx(d);
      if (!pts) continue;
      let dist = Infinity;
      if (d.type === 'horizontal') dist = Math.abs(y - pts[0].y);
      else if (d.type === 'vertical') dist = Math.abs(x - pts[0].x);
      else if (d.type === 'hray') dist = x >= pts[0].x ? Math.abs(y - pts[0].y) : Math.hypot(x - pts[0].x, y - pts[0].y);
      else if (d.type === 'pencil' || d.type === 'zigzag') {
        for (let k = 1; k < pts.length; k += 1) {
          dist = Math.min(dist, pointToSegmentDistance(x, y, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y));
        }
      }
      else if (d.type === 'arrowUp' || d.type === 'arrowDown') {
        // The glyph's bounding box: MARKER_W wide centered on the tip, MARKER_H
        // above (down arrow) or below (up arrow) the anchor.
        const yTop = d.type === 'arrowDown' ? pts[0].y - MARKER_H : pts[0].y;
        const yBot = d.type === 'arrowDown' ? pts[0].y : pts[0].y + MARKER_H;
        if (x >= pts[0].x - MARKER_W / 2 - 2 && x <= pts[0].x + MARKER_W / 2 + 2
          && y >= yTop - 2 && y <= yBot + 2) dist = 0;
      }
      else if (d.type === 'text') {
        // Approximate the label's bounding box (no ctx here) from font size.
        const size = normalizeFontSize(d.fontSize || DEFAULT_TEXT_FONT_SIZE);
        const tw = (d.text ? d.text.length : 0) * size * 0.6;
        const th = size * 1.25;
        if (x >= pts[0].x - 2 && x <= pts[0].x + tw + 2 && y >= pts[0].y - 2 && y <= pts[0].y + th + 2) dist = 0;
      }
      else if (d.type === 'fib') {
        const xa = Math.min(pts[0].x, pts[1].x);
        const xb = Math.max(pts[0].x, pts[1].x);
        for (const ratio of FIB_LEVELS) {
          const y2 = pts[0].y + (pts[1].y - pts[0].y) * ratio;
          dist = Math.min(dist, pointToSegmentDistance(x, y, xa, y2, xb, y2));
        }
      }
      else if (d.type === 'measure') {
        dist = pointToRectDistance(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
        const xa = Math.min(pts[0].x, pts[1].x);
        const xb = Math.max(pts[0].x, pts[1].x);
        const ya = Math.min(pts[0].y, pts[1].y);
        const yb = Math.max(pts[0].y, pts[1].y);
        if (x >= xa && x <= xb && y >= ya && y <= yb) dist = 0;
      }
      else if (d.type === 'trendline' || d.type === 'arrow') dist = pointToSegmentDistance(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      else if (d.type === 'curve') {
        const control = quadraticControlThroughMid(pts[0], pts[1], pts[2]);
        dist = pointToQuadraticDistance(x, y, pts[0], pts[1], control);
      }
      else if (d.type === 'ray') dist = pointToRayDistance(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      else if (d.type === 'extended') dist = pointToLineDistance(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      else if (d.type === 'box') dist = pointToRectDistance(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
      else if (d.type === 'circle') {
        if (d.geometry === 'centerRadius') {
          const dy = Math.abs(pts[1].y - pts[0].y);
          const dx = Math.abs(pts[1].x - pts[0].x);
          const r = Math.max(1, dy > 0 ? dy : dx);
          const centerDist = Math.hypot(x - pts[0].x, y - pts[0].y);
          if (centerDist <= r + LINE_HIT_PX) dist = 0;
          else dist = centerDist - r;
        } else {
          dist = pointToEllipseDistance(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
        }
      }
      else if (d.type === 'channel') {
        dist = pointToSegmentDistance(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
        if (pts[2]) {
          if (Math.abs(pts[1].x - pts[0].x) < 1e-6) {
            const xOffset = pts[2].x - pts[0].x;
            dist = Math.min(dist, pointToSegmentDistance(x, y, pts[0].x + xOffset, pts[0].y, pts[1].x + xOffset, pts[1].y));
          } else {
            const slope = (pts[1].y - pts[0].y) / (pts[1].x - pts[0].x);
            const offset = pts[2].y - (pts[0].y + slope * (pts[2].x - pts[0].x));
            dist = Math.min(dist, pointToSegmentDistance(x, y, pts[0].x, pts[0].y + offset, pts[1].x, pts[1].y + offset));
          }
        }
      }
      else if (d.type === 'longPosition' || d.type === 'shortPosition') {
        const xb = positionBoxX(d.points);
        if (!xb) continue;
        for (const p of pts) {
          dist = Math.min(dist, pointToSegmentDistance(x, y, xb.x0, p.y, xb.x1, p.y));
        }
        // The box body is grabbable to move the whole position.
        const yTop = Math.min(pts[1].y, pts[4].y);
        const yBot = Math.max(pts[1].y, pts[4].y);
        if (x >= xb.x0 && x <= xb.x1 && y >= yTop && y <= yBot) dist = 0;
      }
      if (dist <= LINE_HIT_PX) return { id: d.id, drawing: d };
    }
    return null;
  }

  function handleIndexAt(drawing, x, y) {
    const pts = drawingPx(drawing);
    if (!pts) return -1;
    if (drawing?.type === 'circle' && drawing?.geometry === 'centerRadius' && pts.length >= 2) {
      if (Math.hypot(x - pts[0].x, y - pts[0].y) <= HANDLE_HIT_PX) return 0;
      const dy = Math.abs(pts[1].y - pts[0].y);
      const dx = Math.abs(pts[1].x - pts[0].x);
      const r = Math.max(1, dy > 0 ? dy : dx);
      const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      const h1x = pts[0].x + r * (Number.isFinite(angle) ? Math.cos(angle) : 0);
      const h1y = pts[0].y + r * (Number.isFinite(angle) ? Math.sin(angle) : -1);
      if (Math.hypot(x - h1x, y - h1y) <= HANDLE_HIT_PX) return 1;
      return -1;
    }
    for (let i = 0; i < pts.length; i += 1) {
      if (Math.hypot(x - pts[i].x, y - pts[i].y) <= HANDLE_HIT_PX) return i;
    }
    return -1;
  }

  // Pointer down while a gesture tool is armed: begin a pencil path or anchor
  // a circle center. Zigzag is click-to-vertex (committed on double-click),
  // not a press-drag stroke — treating it as freehand would reset pending on
  // every mousedown and wipe the previous vertices.
  // A drag sentinel makes isDragging() true so the existing
  // window mousemove/mouseup plumbing feeds onPointerMove/onPointerUp.
  function onToolPointerDown(x, y) {
    if (!activeTool || (!isFreehandType(activeTool) && activeTool !== 'circle')) return false;
    const point = pxToPoint(x, y);
    if (!point) return true; // swallow press off the data area
    attachIfNeeded();
    pending = activeTool === 'circle'
      ? { type: activeTool, points: [point, point], geometry: 'centerRadius', radius: 0 }
      : { type: activeTool, points: [point] };
    previewPoint = null;
    drag = activeTool === 'circle'
      ? { circle: true, centerX: x, centerY: y, radius: 0, lastX: x, lastY: y }
      : { freehand: true, lastX: x, lastY: y };
    setScrollEnabled(false);
    redraw();
    return true;
  }

  // Pointer down with no active tool: begin dragging a drawing (endpoint or
  // whole). Returns true when a drag started (caller skips chart panning).
  function onPointerDown(x, y) {
    if (activeTool) return false;
    // Pressing the ✕ should not start a drag; let the click delete it.
    if (selectedId != null && hitDeleteButton(x, y)) return true;
    // Prefer a handle on the already-selected drawing.
    if (selectedId != null) {
      const sel = drawings.find((d) => d.id === selectedId);
      if (sel && !isFreehandType(sel.type)) {
        const hi = handleIndexAt(sel, x, y);
        if (hi >= 0) {
          const pts = drawingPx(sel);
          drag = {
            id: sel.id,
            pointIndex: hi,
            startX: x,
            startY: y,
            lastX: x,
            lastY: y,
            originPts: pts ? pts.map((p) => ({ ...p })) : null,
            originPoints: sel.points.map((p) => ({ ...p })),
            originRadius: sel.radius,
          };
          setScrollEnabled(false);
          return true;
        }
      }
    }
    const hit = hitTest(x, y);
    if (hit) {
      selectedId = hit.id;
      const pts = drawingPx(hit.drawing);
      drag = {
        id: hit.id,
        pointIndex: -1,
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        originPts: pts ? pts.map((p) => ({ ...p })) : null,
        originPoints: hit.drawing.points.map((p) => ({ ...p })),
        originRadius: hit.drawing.radius,
      };
      setScrollEnabled(false);
      redraw();
      return true;
    }
    return false;
  }

  function onPointerMove(x, y) {
    if (drag && drag.circle) {
      if (!pending) return;
      const radius = Math.hypot(x - drag.centerX, y - drag.centerY);
      const series = getCandleSeries();
      const centerPrice = pending.points[0]?.price;
      const centerTime = pending.points[0]?.time;
      const topPrice = series ? series.coordinateToPrice(drag.centerY - radius) : null;
      const deltaPrice = (topPrice != null && Number.isFinite(topPrice) && centerPrice != null && Number.isFinite(centerPrice))
        ? Math.abs(topPrice - centerPrice)
        : 0;
      pending.points[1] = {
        time: centerTime,
        price: centerPrice + (deltaPrice || 1),
      };
      drag.radius = radius;
      drag.lastX = x;
      drag.lastY = y;
      redraw();
      return;
    }
    if (drag && drag.freehand) {
      if (!pending) return;
      if (Math.hypot(x - drag.lastX, y - drag.lastY) < FREEHAND_MIN_PX) return;
      const point = pxToPoint(x, y);
      if (point) {
        pending.points.push(point);
        drag.lastX = x;
        drag.lastY = y;
        redraw();
      }
      return;
    }
    if (drag) {
      const d = drawings.find((dr) => dr.id === drag.id);
      if (!d) return;
      if (drag.pointIndex >= 0) {
        if (isPositionType(d.type)) {
          // Position levels are horizontal: dragging a handle moves price only
          // (from the cursor Y, so it works in the future whitespace too),
          // keeping its time so the level stays aligned to the box.
          const series = getCandleSeries();
          const price = series ? series.coordinateToPrice(y) : null;
          if (price != null && Number.isFinite(price)) {
            d.points[drag.pointIndex] = { time: d.points[drag.pointIndex].time, price };
          }
        } else if (d.type === 'circle' && d.geometry === 'centerRadius') {
          // Circle center/radius editing:
          // Handle 0 is center: moving center shifts both anchors so price and time circumference is preserved.
          // Handle 1 is radius: moving edge handle updates radius in price and time.
          const series = getCandleSeries();
          if (drag.pointIndex === 0) {
            const totalDx = x - drag.startX;
            const totalDy = y - drag.startY;
            const startCenterPx = drag.originPts ? drag.originPts[0] : pointToPx(drag.originPoints[0]);
            if (startCenterPx) {
              const targetX = startCenterPx.x + totalDx;
              const targetY = startCenterPx.y + totalDy;
              const newCenter = pxToPoint(targetX, targetY);
              if (newCenter) {
                const deltaPrice = Math.abs(drag.originPoints[1].price - drag.originPoints[0].price);
                d.points[0] = newCenter;
                d.points[1] = { time: newCenter.time, price: newCenter.price + deltaPrice };
              }
            }
          } else {
            const centerPx = pointToPx(d.points[0]);
            if (centerPx && series) {
              const newRadius = Math.max(CIRCLE_MIN_RADIUS_PX, Math.hypot(x - centerPx.x, y - centerPx.y));
              const topPrice = series.coordinateToPrice(centerPx.y - newRadius);
              const deltaPrice = (topPrice != null && Number.isFinite(topPrice)) ? Math.abs(topPrice - d.points[0].price) : 0;
              d.points[1] = {
                time: d.points[0].time,
                price: d.points[0].price + (deltaPrice || 1),
              };
            }
          }
        } else {
          const point = pxToPoint(x, y);
          if (point) d.points[drag.pointIndex] = point;
        }
      } else if (isPositionType(d.type)) {
        // Whole-position move: a position's x is logical (it can sit in the
        // future), so shift it by whole-bar logical steps and by the price delta
        // rather than a clamped pixel re-map.
        const chart = getChart();
        const series = getCandleSeries();
        const ts = chart && chart.timeScale();
        const pNow = series ? series.coordinateToPrice(y) : null;
        const pPrev = series ? series.coordinateToPrice(drag.lastY) : null;
        const dPrice = (Number.isFinite(pNow) && Number.isFinite(pPrev)) ? pNow - pPrev : 0;
        const lNow = ts ? ts.coordinateToLogical(x) : null;
        const lPrev = ts ? ts.coordinateToLogical(drag.lastX) : null;
        const iv = barInterval();
        const dBars = (lNow != null && lPrev != null) ? Math.round(lNow - lPrev) : 0;
        const dTime = (iv && dBars) ? dBars * iv : 0;
        if (dPrice !== 0 || dTime !== 0) {
          d.points = d.points.map((p) => ({ time: p.time + dTime, price: p.price + dPrice }));
        }
        if (dBars !== 0) drag.lastX = x; // only consume X once a whole bar is crossed
        drag.lastY = y;
      } else if (d.type === 'circle' && d.geometry === 'centerRadius') {
        const totalDx = x - drag.startX;
        const totalDy = y - drag.startY;
        const startCenterPx = drag.originPts ? drag.originPts[0] : pointToPx(drag.originPoints[0]);
        if (startCenterPx) {
          const targetX = startCenterPx.x + totalDx;
          const targetY = startCenterPx.y + totalDy;
          const newCenter = pxToPoint(targetX, targetY);
          if (newCenter) {
            const deltaPrice = Math.abs(drag.originPoints[1].price - drag.originPoints[0].price);
            d.points[0] = newCenter;
            d.points[1] = { time: newCenter.time, price: newCenter.price + deltaPrice };
          }
        }
        drag.lastX = x;
        drag.lastY = y;
      } else {
        // Whole-drawing move: shift every anchor by the pixel delta from drag start.
        const totalDx = x - drag.startX;
        const totalDy = y - drag.startY;
        if (drag.originPts && drag.originPts.length === d.points.length) {
          const moved = [];
          for (let i = 0; i < drag.originPts.length; i += 1) {
            const np = pxToPoint(drag.originPts[i].x + totalDx, drag.originPts[i].y + totalDy);
            if (!np) return; // bail if any anchor would leave the data area
            moved.push(np);
          }
          d.points = moved;
        } else {
          const dx = x - drag.lastX;
          const dy = y - drag.lastY;
          const pts = drawingPx(d);
          if (pts) {
            const moved = [];
            for (let i = 0; i < pts.length; i += 1) {
              const np = pxToPoint(pts[i].x + dx, pts[i].y + dy);
              if (!np) return;
              moved.push(np);
            }
            d.points = moved;
          }
        }
        drag.lastX = x;
        drag.lastY = y;
      }
      redraw();
      return;
    }
    if (activeTool && pending && pending.points.length > 0) {
      if (isPositionType(activeTool)) {
        // Preview the stop by price (works in future whitespace); anchor to entry.
        const series = getCandleSeries();
        const price = series ? series.coordinateToPrice(y) : null;
        if (price != null && Number.isFinite(price)) {
          previewPoint = { time: pending.points[0].time, price };
        }
      } else {
        previewPoint = pxToPoint(x, y);
      }
      redraw();
    }
  }

  function onPointerUp() {
    if (drag && drag.circle) {
      if (pending && drag.radius >= CIRCLE_MIN_RADIUS_PX) {
        drawings.push({
          id: createDrawingId(),
          type: 'circle',
          points: pending.points,
          radius: drag.radius,
          color: drawingColor(),
          text: '',
          geometry: 'centerRadius',
        });
        persist();
      }
      rearmActiveTool();
      redraw();
      return;
    }
    if (drag && drag.freehand) {
      const pts = pending ? pending.points : [];
      const strokeType = pending?.type || activeTool;
      if (pts.length >= 2) {
        drawings.push({
          id: createDrawingId(),
          type: strokeType,
          points: pts,
          color: toolColor(strokeType),
          text: '',
        });
        persist();
      }
      rearmActiveTool();
      redraw();
      return;
    }
    if (drag) {
      drag = null;
      persist();
      setScrollEnabled(true);
      redraw();
    }
  }

  function removeSelected() {
    if (selectedId == null) return false;
    const before = drawings.length;
    drawings = drawings.filter((d) => d.id !== selectedId);
    selectedId = null;
    if (drawings.length !== before) {
      persist();
      redraw();
      return true;
    }
    return false;
  }

  function clearAll() {
    if (drawings.length === 0 && pending == null) return;
    drawings = [];
    selectedId = null;
    pending = activeTool ? { type: activeTool, points: [] } : null;
    persist();
    redraw();
  }

  // Escape: cancel an in-progress placement, else clear selection. Returns the
  // tool that was cancelled (so the UI can clear its active state), or null.
  function cancel() {
    if (activeTool) {
      const cancelled = activeTool;
      activeTool = null;
      pending = null;
      previewPoint = null;
      drag = null;
      setScrollEnabled(true);
      fireToolChange();
      redraw();
      return cancelled;
    }
    if (selectedId != null) {
      selectedId = null;
      redraw();
    }
    return null;
  }

  function setCoin(nextCoin) {
    attachIfNeeded();
    if (nextCoin === coin) {
      redraw();
      return;
    }
    coin = nextCoin || '';
    drawings = loadDrawings(coin, storageSuffix);
    selectedId = null;
    pending = activeTool ? { type: activeTool, points: [] } : null;
    previewPoint = null;
    redraw();
  }

  function setOnActiveToolChange(cb) {
    onActiveToolChange = typeof cb === 'function' ? cb : null;
  }

  function detach() {
    rawDetach();
    setScrollEnabled(true);
    drag = null;
  }

  // Test/debug accessor.
  function getState() {
    return { coin, drawings, activeTool, selectedId, pending };
  }

  return {
    // lifecycle
    setCoin,
    detach,
    redraw,
    // tool control
    setActiveTool,
    isToolActive,
    hasSelection,
    isDragging,
    setOnActiveToolChange,
    cancel,
    clearAll,
    removeSelected,
    deleteAt,
    releaseStuckGestures,
    // pointer
    onClick,
    onDblClick,
    onToolPointerDown,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    // introspection
    getState,
  };
}
