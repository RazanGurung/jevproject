/**
 * Drawing-tools router — fans one toolbar / pointer stream out to multiple
 * per-pane drawing overlays so the user can annotate the price pane and every
 * lower (value-scale) indicator pane with the same tools.
 *
 * Why a router: each drawing overlay attaches a series primitive to one series
 * and works entirely in that series' pane-local coordinate space (its
 * priceToCoordinate / useBitmapCoordinateSpace are pane-local). Pointer events,
 * however, arrive in chartWrap-global coordinates. The router decides which
 * pane the pointer is over, translates the global Y into that pane's local Y,
 * and dispatches to the matching overlay. X is shared (one time scale) so it
 * needs no translation.
 *
 * Panes below the price pane (CVD histogram, CVD oscillator, …) are value-scaled
 * and stacked. Each gets its own overlay; the router finds the one whose band
 * the pointer falls into. Bands are computed from each pane's real on-screen
 * position, so the lookup stays correct no matter how many panes are stacked.
 *
 * One tool is armed at a time across panes: setActiveTool arms every overlay
 * (each silently ignores tools it doesn't allow), and the pane under the cursor
 * is the one that actually places. A multi-click placement (or a drag / freehand
 * stroke) locks to the overlay it started in until it commits or cancels, so a
 * shape never splits across panes.
 *
 * The lower panes are value-scaled (not price), so they only allow lines/shapes —
 * the price-specific tools (fib, measure, long/short position) stay on the
 * price pane. See CVD_TOOLS.
 */

import { createDrawingToolsOverlay, isDrawingType } from './drawing-tools.js';

// Tools that make sense on the CVD (value-scale) pane: lines, shapes, freehand
// and text. Fib levels, the measure ruler and position tools are price concepts
// and are intentionally excluded.
export const CVD_TOOLS = new Set([
  'trendline', 'curve', 'ray', 'arrow', 'extended', 'hray', 'horizontal', 'vertical', 'channel',
  'box', 'circle', 'pencil', 'zigzag', 'text', 'arrowUp', 'arrowDown',
]);

export function createDrawingToolsRouter({
  getChart,
  getMainSeries,
  getCvdSeries,
  getOscillatorSeries,
  getTimeframe = null,
  getBarTimes = null,
} = {}) {
  if (typeof getChart !== 'function' || typeof getMainSeries !== 'function') {
    throw new Error('createDrawingToolsRouter requires getChart and getMainSeries');
  }
  const asGetter = (fn) => (typeof fn === 'function' ? fn : () => null);
  const overlayOptions = {
    getTimeframe: typeof getTimeframe === 'function' ? getTimeframe : null,
    getBarTimes: typeof getBarTimes === 'function' ? getBarTimes : null,
  };

  const main = createDrawingToolsOverlay({
    getChart,
    getCandleSeries: getMainSeries,
    ...overlayOptions,
  });

  // Lower (value-scale) panes, top-to-bottom: CVD histogram, then CVD oscillator.
  // Each gets its own overlay + storage key; all share the value-scale tool set.
  const lowers = [
    { getSeries: asGetter(getCvdSeries), storageSuffix: ':cvd' },
    { getSeries: asGetter(getOscillatorSeries), storageSuffix: ':osc' },
  ].map((spec) => ({
    getSeries: spec.getSeries,
    overlay: createDrawingToolsOverlay({
      getChart,
      getCandleSeries: spec.getSeries,
      allowedTools: CVD_TOOLS,
      storageSuffix: spec.storageSuffix,
      ...overlayOptions,
    }),
  }));

  // Named handles kept for the debug accessor / readability.
  const cvd = lowers[0].overlay;
  const oscillator = lowers[1].overlay;

  // Every overlay, price pane first.
  const allOverlays = [main, ...lowers.map((l) => l.overlay)];

  let activeTool = null;
  let placementOverlay = null; // locks a multi-click placement to one pane
  let dragOverlay = null;      // locks a drag / freehand stroke to one pane
  let arming = false;          // suppress child callbacks during setActiveTool
  let externalToolChange = null;

  // Vertical band of a lower pane in chartElement-local px. Uses the pane's real
  // on-screen position so stacked panes (and their separators) resolve exactly.
  // Returns null when the pane is absent (indicator hidden / not yet attached).
  function paneBandFor(series) {
    const chart = getChart();
    const pane = series && typeof series.getPane === 'function' ? series.getPane() : null;
    if (!chart || !pane) return null;
    try {
      const height = pane.getHeight();
      if (!(height > 0)) return null;
      const chartEl = typeof chart.chartElement === 'function' ? chart.chartElement() : null;
      // Preferred: exact top from the pane's DOM element relative to the chart.
      const paneEl = typeof pane.getHTMLElement === 'function' ? pane.getHTMLElement() : null;
      if (paneEl && chartEl && typeof paneEl.getBoundingClientRect === 'function'
        && typeof chartEl.getBoundingClientRect === 'function') {
        const top = paneEl.getBoundingClientRect().top - chartEl.getBoundingClientRect().top;
        return { top, height };
      }
      // Fallback (single bottom pane, e.g. test stub): chartHeight − axis − height.
      const total = chartEl ? chartEl.clientHeight : 0;
      const axis = chart.timeScale().height();
      if (!(total > 0)) return null;
      return { top: total - axis - height, height };
    } catch {
      return null;
    }
  }

  // The lower overlay whose band contains y, with its band — or null.
  function lowerAt(y) {
    for (const lower of lowers) {
      const band = paneBandFor(lower.getSeries());
      if (band && y >= band.top && y <= band.top + band.height) {
        return { overlay: lower.overlay, band };
      }
    }
    return null;
  }

  // Map a global Y to { overlay, localY }. When the chart exposes real pane
  // bands, axis/separator space is deliberately not treated as price-pane
  // drawing space. The fallback keeps older chart/test adapters working.
  function resolve(y) {
    const hit = lowerAt(y);
    if (hit) return { overlay: hit.overlay, localY: y - hit.band.top };
    const mainBand = paneBandFor(getMainSeries());
    if (mainBand && y >= mainBand.top && y <= mainBand.top + mainBand.height) {
      return { overlay: main, localY: y - mainBand.top };
    }
    const lowerBands = lowers.map((lower) => paneBandFor(lower.getSeries())).filter(Boolean);
    // Older lightweight-charts adapters do not expose the main pane element;
    // its plot still occupies the space above the first known lower pane.
    if (!mainBand && lowerBands.length) {
      const firstLowerTop = Math.min(...lowerBands.map((band) => band.top));
      if (y >= 0 && y < firstLowerTop) return { overlay: main, localY: y };
    }
    const hasKnownPane = mainBand || lowerBands.length > 0;
    if (hasKnownPane) return null;
    return { overlay: main, localY: y };
  }

  function toLocalY(overlay, y) {
    if (overlay === main) return y;
    const lower = lowers.find((l) => l.overlay === overlay);
    if (!lower) return y;
    const band = paneBandFor(lower.getSeries());
    return band ? y - band.top : y;
  }

  function notifyTool(tool) {
    if (typeof externalToolChange === 'function') {
      try { externalToolChange(tool); } catch {}
    }
  }

  // A child overlay cleared its tool to null — i.e. it committed or cancelled a
  // placement/stroke. Disarm the siblings and surface a single tool change.
  function onChildToolChange(t) {
    if (arming) return;
    if (t == null && activeTool != null) {
      activeTool = null;
      placementOverlay = null;
      arming = true;
      allOverlays.forEach((o) => o.setActiveTool(null));
      arming = false;
      notifyTool(null);
    }
  }

  allOverlays.forEach((o) => o.setOnActiveToolChange(onChildToolChange));

  // ---- tool control ----

  function setActiveTool(tool) {
    activeTool = isDrawingType(tool) ? tool : null;
    placementOverlay = null;
    arming = true;
    // Lower overlays ignore tools outside CVD_TOOLS.
    allOverlays.forEach((o) => o.setActiveTool(activeTool));
    arming = false;
    notifyTool(activeTool);
  }

  function setOnActiveToolChange(cb) {
    externalToolChange = typeof cb === 'function' ? cb : null;
  }

  function isToolActive() {
    return activeTool != null;
  }

  function hasSelection() {
    return allOverlays.some((o) => o.hasSelection());
  }

  function isDragging() {
    return dragOverlay != null || allOverlays.some((o) => o.isDragging());
  }

  // Clear any selection on every overlay except `keep`.
  function deselectOthers(keep) {
    allOverlays.forEach((o) => {
      if (o !== keep && o.hasSelection()) o.cancel();
    });
  }

  // ---- pointer ----

  // True while a multi-click (or in-progress) placement has anchors already.
  // Keep-drawing leaves the tool armed with an empty pending between shapes,
  // so an empty pending means the next click may start on any pane.
  function isPlacementPending(overlay) {
    try {
      const pending = overlay.getState?.()?.pending;
      return Array.isArray(pending?.points) && pending.points.length > 0;
    } catch {
      return false;
    }
  }

  function onClick(x, y) {
    // Keep a multi-click placement on the pane it began in.
    if (activeTool && placementOverlay) {
      const target = placementOverlay;
      const handled = target.onClick(x, toLocalY(target, y));
      if (!target.isToolActive() || !isPlacementPending(target)) placementOverlay = null;
      return handled;
    }
    const resolved = resolve(y);
    if (!resolved) return false;
    const { overlay, localY } = resolved;
    if (activeTool) {
      const handled = overlay.onClick(x, localY);
      placementOverlay = (overlay.isToolActive() && isPlacementPending(overlay)) ? overlay : null;
      return handled;
    }
    // No tool: selection. Make selection exclusive across panes.
    const hadSelection = hasSelection();
    const handled = overlay.onClick(x, localY);
    if (overlay.hasSelection()) {
      deselectOthers(overlay);
    } else if (hadSelection) {
      // An empty click in any pane clears the prior pane's selection and owns
      // the click, preventing a simultaneous ticket-price edit.
      allOverlays.forEach((candidate) => {
        if (candidate.hasSelection()) candidate.cancel();
      });
      return true;
    }
    return handled;
  }

  // Double-click finishes a polyline placement; it stays on the pane the
  // placement is locked to. After commit (keep-drawing), pending is empty so
  // the lock releases for the next shape.
  function onDblClick(x, y) {
    const resolved = placementOverlay ? null : resolve(y);
    const target = placementOverlay || resolved?.overlay;
    if (!target) return false;
    const handled = target.onDblClick(x, toLocalY(target, y));
    if (!target.isToolActive() || !isPlacementPending(target)) placementOverlay = null;
    return handled;
  }

  function onToolPointerDown(x, y) {
    if (!activeTool) return false;
    const resolved = resolve(y);
    if (!resolved) return false;
    const { overlay, localY } = resolved;
    const started = overlay.onToolPointerDown(x, localY);
    if (started) dragOverlay = overlay;
    return started;
  }

  function onPointerDown(x, y) {
    const resolved = resolve(y);
    if (!resolved) return false;
    const { overlay, localY } = resolved;
    const started = overlay.onPointerDown(x, localY);
    if (started) {
      dragOverlay = overlay;
      // Selecting via drag should deselect every other pane.
      deselectOthers(overlay);
    }
    return started;
  }

  function onPointerMove(x, y) {
    if (dragOverlay) {
      dragOverlay.onPointerMove(x, toLocalY(dragOverlay, y));
      return;
    }
    const target = placementOverlay || resolve(y)?.overlay;
    if (!target) return;
    target.onPointerMove(x, toLocalY(target, y));
  }

  function onPointerUp() {
    if (dragOverlay) {
      dragOverlay.onPointerUp();
      dragOverlay = null;
      return;
    }
    allOverlays.forEach((o) => o.onPointerUp());
  }

  function deleteAt(x, y) {
    const resolved = resolve(y);
    if (!resolved) return false;
    const { overlay, localY } = resolved;
    return overlay.deleteAt(x, localY);
  }

  function removeSelected() {
    const owner = allOverlays.find((o) => o.hasSelection());
    return owner ? owner.removeSelected() : false;
  }

  function cancel() {
    const had = activeTool;
    allOverlays.forEach((o) => o.cancel());
    placementOverlay = null;
    return had || null;
  }

  // ---- lifecycle ----

  function clearAll() {
    allOverlays.forEach((o) => o.clearAll());
  }

  function setCoin(coin) {
    allOverlays.forEach((o) => o.setCoin(coin));
  }

  function redraw() {
    allOverlays.forEach((o) => o.redraw());
  }

  function detach() {
    allOverlays.forEach((o) => o.detach());
    dragOverlay = null;
    placementOverlay = null;
  }

  // Transport recycle / tab resume can drop pointerup and leave LC pan disabled.
  // Clear cross-pane drag locks and ask each overlay to restore navigation when
  // no tool is intentionally armed.
  function releaseStuckGestures() {
    dragOverlay = null;
    if (!activeTool) placementOverlay = null;
    let restored = false;
    allOverlays.forEach((o) => {
      if (typeof o.releaseStuckGestures === 'function' && o.releaseStuckGestures()) {
        restored = true;
      }
    });
    return restored;
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
    // test/debug accessors
    _overlays: { main, cvd, oscillator },
  };
}
