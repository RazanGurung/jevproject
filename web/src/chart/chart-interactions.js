/**
 * Chart interactions - event wiring for hover, drag, zoom, and ticket price pick
 */

import { AppState, setChartTouchMode } from '../state/store.js';
import {
  clearPendingVisibleRangeRequests,
  coordinateToPrice,
  drawingToolsOverlay,
  fitLightweightChartToCandles,
  manualAnchoredVwapOverlay,
  getCandleSeries,
  getChart,
  recenterPriceScale,
  releaseStuckChartGestures,
  repositionLineLabels,
} from './lightweight-chart.js';
import { applyTicketPrice, setOrderType, setSide } from '../ui/tabs.js';

let chartWrapListenersAttached = false;
let chartWindowListenersAttached = false;
let chartResizeObserverAttached = false;
let chartPointerDown = null;
let chartTouchPointerDown = null;
let lastChartResizeAt = 0;
let suppressChartClickUntil = 0;
let lastTouchTap = null;
let touchGestureBlocked = false;
let touchOverlayGesture = null;
let viewportInteractionListener = null;
const activeTouchPointerIds = new Set();

// Vertical grab-pan state for the lightweight-charts body. The library natively
// pans the time axis on a pressed-mouse drag but never the price axis, so we
// shift the price scale's visible range ourselves on the same drag. Captured at
// mousedown: the start cursor Y, the price range then, and a price-per-pixel
// factor (so margins/zoom are accounted for). Persisted after release until an
// explicit re-frame (Fit / Jump-to-Live / pair-or-timeframe switch).
let lwPanStartY = null;
let lwPanBaseRange = null;
let lwPanPricePerPixel = 0;

function getPriceScale() {
  return getCandleSeries()?.priceScale?.() || getChart()?.priceScale?.('right') || null;
}

const CHART_CLICK_MOVE_TOLERANCE_PX = 6;
const CHART_CLICK_RESIZE_GUARD_MS = 600;
const CHART_CLICK_MAX_DURATION_MS = 500;
const CHART_TOUCH_TAP_MAX_DURATION_MS = 350;
const CHART_TOUCH_DOUBLE_TAP_MS = 360;
const CHART_TOUCH_DOUBLE_TAP_DISTANCE_PX = 28;
const CHART_CLICK_SUPPRESS_AFTER_TOUCH_MS = 700;

function applyPickedLimitPrice(price) {
  const nextPrice = Number(price);
  if (!Number.isFinite(nextPrice) || nextPrice <= 0) return false;
  return applyTicketPrice(nextPrice, {
    userEdited: true,
    snapToTick: true,
  });
}

function isLabelInteractionTarget(target) {
  return target instanceof Element && !!target.closest('.chart-line-labels-overlay, .avwap-anchor-editor');
}

function armChartPointerDown(event) {
  chartPointerDown = {
    x: Number(event?.clientX || 0),
    y: Number(event?.clientY || 0),
    at: Date.now(),
  };
}

// Lightweight Charts installs its mouse handlers inside chartWrap, so a
// bubbling mousedown reaches the library before it reaches our wrapper. Claim
// overlay-owned presses during capture instead: this is early enough to stop a
// drawing/anchor drag from also arming the chart's native pan gesture.
function claimMouseOverlayGesture(event, wrap) {
  if (event.button !== 0 || isLabelInteractionTarget(event.target)) return false;

  armChartPointerDown(event);
  const rect = wrap.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const claimed = manualAnchoredVwapOverlay.isPlacementActive()
    || manualAnchoredVwapOverlay.onPointerDown(x, y)
    || drawingToolsOverlay.onToolPointerDown(x, y)
    || drawingToolsOverlay.isToolActive()
    || drawingToolsOverlay.onPointerDown(x, y);

  if (!claimed) return false;

  lwPanStartY = null;
  lwPanBaseRange = null;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

function shouldIgnoreChartClick(event, { allowDuringResize = false } = {}) {
  if (!allowDuringResize && Date.now() - lastChartResizeAt < CHART_CLICK_RESIZE_GUARD_MS) {
    return true;
  }
  if (!chartPointerDown) return false;

  const dx = Math.abs(Number(event?.clientX || 0) - chartPointerDown.x);
  const dy = Math.abs(Number(event?.clientY || 0) - chartPointerDown.y);
  const movedTooFar = dx > CHART_CLICK_MOVE_TOLERANCE_PX || dy > CHART_CLICK_MOVE_TOLERANCE_PX;
  const heldTooLong = Date.now() - chartPointerDown.at > CHART_CLICK_MAX_DURATION_MS;
  return movedTooFar || heldTooLong;
}

function armChartTouchPointerDown(event) {
  chartTouchPointerDown = {
    id: event?.pointerId,
    x: Number(event?.clientX || 0),
    y: Number(event?.clientY || 0),
    at: Date.now(),
  };
}

function shouldIgnoreTouchTap(event) {
  if (Date.now() - lastChartResizeAt < CHART_CLICK_RESIZE_GUARD_MS) {
    return true;
  }
  if (!chartTouchPointerDown) return true;

  const dx = Math.abs(Number(event?.clientX || 0) - chartTouchPointerDown.x);
  const dy = Math.abs(Number(event?.clientY || 0) - chartTouchPointerDown.y);
  const movedTooFar = dx > CHART_CLICK_MOVE_TOLERANCE_PX || dy > CHART_CLICK_MOVE_TOLERANCE_PX;
  const heldTooLong = Date.now() - chartTouchPointerDown.at > CHART_TOUCH_TAP_MAX_DURATION_MS;
  return movedTooFar || heldTooLong;
}

function pickChartPriceAtPoint({ wrap, x, y }) {
  const candles = AppState.market.candles || [];
  if (!candles.length) return false;

  const paneHeight = Number(getChart()?.paneSize?.(0)?.height || 0);
  // coordinateToPrice is pane-local. Never interpret clicks in the CVD or
  // oscillator panes as order prices on the candle scale.
  if (paneHeight > 0 && (y < 0 || y > paneHeight)) return false;
  const price = coordinateToPrice(y);
  if (!Number.isFinite(price) || price <= 0) return false;
  return applyPickedLimitPrice(price);
}

function syncMobileChartActionBar() {
  const toolbar = document.getElementById('chartTouchToolbar');
  if (!toolbar) return;

  let mode = AppState.ui.chartTouchMode || 'inspect';
  const orderType = AppState.trading.currentOrderType || 'limit';
  const buyBtn = document.getElementById('chartTouchBuyBtn');
  const sellBtn = document.getElementById('chartTouchSellBtn');
  const hint = document.getElementById('chartTouchHint');

  if (orderType !== 'limit' && mode !== 'inspect') {
    setChartTouchMode('inspect');
    mode = 'inspect';
  }

  if (buyBtn) {
    const active = mode === 'buy';
    buyBtn.classList.toggle('active', active);
    buyBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (sellBtn) {
    const active = mode === 'sell';
    sellBtn.classList.toggle('active', active);
    sellBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (hint) {
    if (mode === 'buy') {
      hint.textContent = 'Tap chart once to load a buy limit price.';
    } else if (mode === 'sell') {
      hint.textContent = 'Tap chart once to load a sell limit price.';
    } else if (orderType === 'limit') {
      hint.textContent = 'Double tap chart to load limit price.';
    } else {
      hint.textContent = 'Switch to limit to use chart price actions.';
    }
  }
}

function setTouchMode(mode) {
  setChartTouchMode(mode);
  syncMobileChartActionBar();
}

function armChartPricePick(mode = 'inspect') {
  const requestedMode = mode === 'buy' || mode === 'sell' ? mode : 'inspect';
  if (requestedMode !== 'inspect' && AppState.trading.currentOrderType !== 'limit') {
    setOrderType('limit');
  }
  const currentMode = AppState.ui.chartTouchMode || 'inspect';
  const nextMode = currentMode === requestedMode ? 'inspect' : requestedMode;
  setTouchMode(nextMode);
}
function fitChartView() {
  recenterPriceScale();
  fitLightweightChartToCandles();
}

function jumpChartToLive() {
  try { releaseStuckChartGestures(); } catch {}
  // Background history prepend queues a shifted logical range so the inspected
  // window stays put. That pending range must not win over an explicit jump.
  clearPendingVisibleRangeRequests();
  recenterPriceScale();
  const timeScale = getChart()?.timeScale?.();
  if (!timeScale) return;
  const rightOffset = Number(timeScale.options?.()?.rightOffset);
  // Immediate scroll: animated scrollToRealTime() loses to the next prepend
  // apply and to a stuck pressed-mouse scroll from a just-finished pan.
  if (typeof timeScale.scrollToPosition === 'function' && Number.isFinite(rightOffset)) {
    timeScale.scrollToPosition(rightOffset, false);
    return;
  }
  timeScale.scrollToRealTime?.();
}

function handleChartTouchTap(event, wrap) {
  const mode = AppState.ui.chartTouchMode || 'inspect';
  const rect = wrap.getBoundingClientRect();
  const x = Number(event?.clientX || 0) - rect.left;
  const y = Number(event?.clientY || 0) - rect.top;
  const now = Date.now();
  let picked = false;

  if (manualAnchoredVwapOverlay.isPlacementActive()) {
    manualAnchoredVwapOverlay.onClick(x, y);
    suppressChartClickUntil = Date.now() + CHART_CLICK_SUPPRESS_AFTER_TOUCH_MS;
    lastTouchTap = null;
    return;
  }
  if (drawingToolsOverlay.onClick(x, y)) {
    suppressChartClickUntil = Date.now() + CHART_CLICK_SUPPRESS_AFTER_TOUCH_MS;
    lastTouchTap = null;
    return;
  }
  const isDoubleTap = !!lastTouchTap
    && now - lastTouchTap.at <= CHART_TOUCH_DOUBLE_TAP_MS
    && Math.abs(lastTouchTap.x - x) <= CHART_TOUCH_DOUBLE_TAP_DISTANCE_PX
    && Math.abs(lastTouchTap.y - y) <= CHART_TOUCH_DOUBLE_TAP_DISTANCE_PX;

  if (isDoubleTap) {
    const priceScale = getPriceScale();
    const priceAxisWidth = priceScale?.width?.() || 0;
    const timeAxisHeight = getChart()?.timeScale?.()?.height?.() || 0;
    if (x >= rect.width - priceAxisWidth) {
      recenterPriceScale();
      lastTouchTap = null;
      return;
    }
    if (y >= rect.height - timeAxisHeight) {
      fitChartView();
      lastTouchTap = null;
      return;
    }
  }

  if (AppState.trading.currentOrderType !== 'limit') {
    lastTouchTap = isDoubleTap ? null : { x, y, at: now };
    return;
  }

  if (mode === 'buy' || mode === 'sell') {
    setSide(mode);
    picked = pickChartPriceAtPoint({ wrap, x, y });
    setTouchMode('inspect');
    lastTouchTap = null;
  } else {
    if (isDoubleTap) {
      picked = pickChartPriceAtPoint({ wrap, x, y });
      lastTouchTap = null;
    } else {
      lastTouchTap = { x, y, at: now };
    }
  }

  if (picked) {
    suppressChartClickUntil = Date.now() + CHART_CLICK_SUPPRESS_AFTER_TOUCH_MS;
  }
}

function notifyViewportInteraction() {
  try { viewportInteractionListener?.(); } catch {}
}

function attachChartEvents(_scheduleChartRender, { onViewportInteraction } = {}) {
  const wrap = document.getElementById('chartWrap');
  if (!wrap) return;
  if (typeof onViewportInteraction === 'function') {
    viewportInteractionListener = onViewportInteraction;
  }

  wrap.style.cursor = 'crosshair';
  syncMobileChartActionBar();

  if (!chartResizeObserverAttached && typeof ResizeObserver === 'function') {
    try {
      const observer = new ResizeObserver(() => {
        lastChartResizeAt = Date.now();
      });
      observer.observe(wrap);
      chartResizeObserverAttached = true;
    } catch {}
  }

  if (!chartWrapListenersAttached) {
    wrap.addEventListener('mousedown', (e) => {
      claimMouseOverlayGesture(e, wrap);
    }, true);

    wrap.addEventListener('mousemove', (e) => {
      const rect = wrap.getBoundingClientRect();
      // Rubber-band preview of an in-progress drawing follows the cursor.
      if (drawingToolsOverlay.isToolActive()) {
        drawingToolsOverlay.onPointerMove(e.clientX - rect.left, e.clientY - rect.top);
      }
      // While the primary button is held and the pointer moves, show a grabbing
      // cursor so panning feels tactile. A plain click (no movement) keeps the
      // crosshair, so price-picking never flashes the grab affordance. Reset on
      // re-entry when the button is no longer held (release may happen off-canvas).
      if (e.buttons === 1) {
        if (
          chartPointerDown
          && !manualAnchoredVwapOverlay.isDragging()
          && !drawingToolsOverlay.isDragging()
          && (
            Math.abs(e.clientX - chartPointerDown.x) > CHART_CLICK_MOVE_TOLERANCE_PX
            || Math.abs(e.clientY - chartPointerDown.y) > CHART_CLICK_MOVE_TOLERANCE_PX
          )
        ) {
          notifyViewportInteraction();
        }
        if (wrap.style.cursor !== 'grabbing') wrap.style.cursor = 'grabbing';
      } else if (wrap.style.cursor === 'grabbing') {
        wrap.style.cursor = 'crosshair';
      }
    });

    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (isLabelInteractionTarget(e.target)) return;
      armChartPointerDown(e);
      lwPanStartY = null;
      lwPanBaseRange = null;
      const priceScale = getPriceScale();
      const rect = wrap.getBoundingClientRect();
      const xRel = e.clientX - rect.left;
      const yRel = e.clientY - rect.top;
      const priceAxisWidth = priceScale?.width?.() || 0;
      const timeAxisHeight = getChart()?.timeScale?.()?.height?.() || 0;
      const overPriceAxis = xRel >= rect.width - priceAxisWidth;
      const overTimeAxis = yRel >= rect.height - timeAxisHeight;
      if (overPriceAxis || overTimeAxis) return;
      const mainPaneHeight = Number(getChart()?.paneSize?.(0)?.height || 0);
      // Lower indicator panes own their own vertical gestures. Never convert a
      // drag there through the candle price scale and shift the main pane.
      if (mainPaneHeight > 0 && (yRel < 0 || yRel > mainPaneHeight)) return;
      const baseRange = priceScale?.getVisibleRange?.() || null;
      const paneHeight = Math.max(1, mainPaneHeight > 0 ? mainPaneHeight : rect.height - timeAxisHeight);
      let ppp = 0;
      const priceA = coordinateToPrice(yRel);
      const sampleY = yRel + 50 <= paneHeight ? yRel + 50 : yRel - 50;
      const priceB = coordinateToPrice(sampleY);
      if (Number.isFinite(priceA) && Number.isFinite(priceB) && sampleY !== yRel) {
        ppp = Math.abs(priceA - priceB) / Math.abs(sampleY - yRel);
      } else if (baseRange && Number.isFinite(baseRange.from) && Number.isFinite(baseRange.to)) {
        ppp = Math.abs(baseRange.to - baseRange.from) / paneHeight;
      }
      if (baseRange && Number.isFinite(ppp) && ppp > 0) {
        lwPanStartY = e.clientY;
        lwPanBaseRange = baseRange;
        lwPanPricePerPixel = ppp;
      }
      return;
    });

    wrap.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      if (isLabelInteractionTarget(e.target)) return;
      activeTouchPointerIds.add(e.pointerId);
      if (activeTouchPointerIds.size > 1) {
        touchGestureBlocked = true;
      }
      armChartTouchPointerDown(e);
      if (touchGestureBlocked) return;

      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let owner = null;
      if (!manualAnchoredVwapOverlay.isPlacementActive()
        && manualAnchoredVwapOverlay.onPointerDown(x, y)) {
        owner = manualAnchoredVwapOverlay;
      } else if (drawingToolsOverlay.onToolPointerDown(x, y)
        || (!drawingToolsOverlay.isToolActive() && drawingToolsOverlay.onPointerDown(x, y))) {
        owner = drawingToolsOverlay;
      }
      if (owner) {
        touchOverlayGesture = { pointerId: e.pointerId, owner };
        e.preventDefault();
      } else if (activeTouchPointerIds.size === 1) {
        const priceScale = getPriceScale();
        const priceAxisWidth = priceScale?.width?.() || 0;
        const timeAxisHeight = getChart()?.timeScale?.()?.height?.() || 0;
        const overPriceAxis = x >= rect.width - priceAxisWidth;
        const overTimeAxis = y >= rect.height - timeAxisHeight;
        const mainPaneHeight = Number(getChart()?.paneSize?.(0)?.height || 0);
        if (!overPriceAxis && !overTimeAxis && (mainPaneHeight <= 0 || y <= mainPaneHeight)) {
          const baseRange = priceScale?.getVisibleRange?.() || null;
          const paneHeight = Math.max(1, mainPaneHeight > 0 ? mainPaneHeight : rect.height - timeAxisHeight);
          let ppp = 0;
          const priceA = coordinateToPrice(y);
          const sampleY = y + 50 <= paneHeight ? y + 50 : y - 50;
          const priceB = coordinateToPrice(sampleY);
          if (Number.isFinite(priceA) && Number.isFinite(priceB) && sampleY !== y) {
            ppp = Math.abs(priceA - priceB) / Math.abs(sampleY - y);
          } else if (baseRange && Number.isFinite(baseRange.from) && Number.isFinite(baseRange.to)) {
            ppp = Math.abs(baseRange.to - baseRange.from) / paneHeight;
          }
          if (baseRange && Number.isFinite(ppp) && ppp > 0) {
            lwPanStartY = e.clientY;
            lwPanBaseRange = baseRange;
            lwPanPricePerPixel = ppp;
          }
        }
      }
    });

    wrap.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') return;
      if (!touchOverlayGesture && chartTouchPointerDown && (
        Math.abs(e.clientX - chartTouchPointerDown.x) > CHART_CLICK_MOVE_TOLERANCE_PX
        || Math.abs(e.clientY - chartTouchPointerDown.y) > CHART_CLICK_MOVE_TOLERANCE_PX
      )) {
        notifyViewportInteraction();
        if (activeTouchPointerIds.size === 1 && lwPanStartY !== null && lwPanBaseRange !== null) {
          const priceScale = getPriceScale();
          if (priceScale) {
            const dy = e.clientY - lwPanStartY;
            const shift = lwPanPricePerPixel * dy;
            priceScale.setAutoScale(false);
            priceScale.setVisibleRange({
              from: lwPanBaseRange.from + shift,
              to: lwPanBaseRange.to + shift,
            });
            try { repositionLineLabels(); } catch {}
          }
        }
      }
      if (touchOverlayGesture?.pointerId !== e.pointerId) return;
      const rect = wrap.getBoundingClientRect();
      touchOverlayGesture.owner.onPointerMove(e.clientX - rect.left, e.clientY - rect.top);
      e.preventDefault();
    });

    wrap.addEventListener('wheel', () => {
      notifyViewportInteraction();
    }, { passive: true });

    wrap.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return;
      const pointerId = e.pointerId;
      const hadPointer = activeTouchPointerIds.has(pointerId);
      activeTouchPointerIds.delete(pointerId);
      if (!hadPointer) return;
      if (touchOverlayGesture?.pointerId === pointerId) {
        touchOverlayGesture.owner.onPointerUp();
        touchOverlayGesture = null;
        suppressChartClickUntil = Date.now() + CHART_CLICK_SUPPRESS_AFTER_TOUCH_MS;
        lastTouchTap = null;
        if (activeTouchPointerIds.size === 0) {
          touchGestureBlocked = false;
          lwPanStartY = null;
          lwPanBaseRange = null;
        }
        chartTouchPointerDown = null;
        e.preventDefault();
        return;
      }
      if (isLabelInteractionTarget(e.target)) {
        if (activeTouchPointerIds.size === 0) {
          touchGestureBlocked = false;
          lwPanStartY = null;
          lwPanBaseRange = null;
        }
        chartTouchPointerDown = null;
        return;
      }
      if (touchGestureBlocked || shouldIgnoreTouchTap(e)) {
        if (activeTouchPointerIds.size === 0) {
          touchGestureBlocked = false;
          lwPanStartY = null;
          lwPanBaseRange = null;
        }
        chartTouchPointerDown = null;
        return;
      }
      handleChartTouchTap(e, wrap);
      if (activeTouchPointerIds.size === 0) {
        touchGestureBlocked = false;
        lwPanStartY = null;
        lwPanBaseRange = null;
      }
      chartTouchPointerDown = null;
    });

    wrap.addEventListener('pointercancel', (e) => {
      if (e.pointerType !== 'touch') return;
      activeTouchPointerIds.delete(e.pointerId);
      if (touchOverlayGesture?.pointerId === e.pointerId) {
        touchOverlayGesture.owner.onPointerUp();
        touchOverlayGesture = null;
      }
      if (activeTouchPointerIds.size === 0) {
        touchGestureBlocked = false;
        lwPanStartY = null;
        lwPanBaseRange = null;
      }
      chartTouchPointerDown = null;
    });

    wrap.addEventListener('click', (e) => {
      if (Date.now() < suppressChartClickUntil) {
        chartPointerDown = null;
        return;
      }
      if (isLabelInteractionTarget(e.target)) {
        chartPointerDown = null;
        return;
      }
      // An armed one-shot anchor owns the next intentional click. A delayed
      // ResizeObserver callback must not silently discard it, but the normal
      // movement/long-press protections still apply.
      const manualPlacementActive = manualAnchoredVwapOverlay.isPlacementActive();
      if (shouldIgnoreChartClick(e, { allowDuringResize: manualPlacementActive })) {
        chartPointerDown = null;
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Manual anchor and drawing placement/selection consume the click before
      // ticket price-picking.
      if (manualAnchoredVwapOverlay.onClick(x, y)) {
        chartPointerDown = null;
        return;
      }
      if (drawingToolsOverlay.onClick(x, y)) {
        chartPointerDown = null;
        return;
      }

      if (AppState.trading.currentOrderType !== 'limit') return;
      const is1mLimitAutoTrack = AppState.trading.currentOrderType === 'limit'
        && AppState.trading.currentTimeframe === '1m';
      if (is1mLimitAutoTrack && e.altKey !== true) {
        chartPointerDown = null;
        return;
      }
      pickChartPriceAtPoint({ wrap, x, y });
      chartPointerDown = null;
    });

    wrap.addEventListener('dblclick', (e) => {
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const priceScale = getPriceScale();
      const priceAxisWidth = priceScale?.width?.() || 0;
      const timeAxisHeight = getChart()?.timeScale?.()?.height?.() || 0;
      const overPriceAxis = x >= rect.width - priceAxisWidth;
      const overTimeAxis = y >= rect.height - timeAxisHeight;

      if (overPriceAxis) {
        recenterPriceScale();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (overTimeAxis) {
        fitChartView();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Double-click commits an in-progress polyline (zigzag) placement.
      if (drawingToolsOverlay.onDblClick(x, y)) {
        e.preventDefault();
      }
    });

    wrap.addEventListener('contextmenu', (e) => {
      // Right-click a drawing to delete it (no menu, immediate).
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (manualAnchoredVwapOverlay.deleteAt(x, y) || drawingToolsOverlay.deleteAt(x, y)) {
        e.preventDefault();
      }
    });

    chartWrapListenersAttached = true;
  }

  if (!chartWindowListenersAttached) {
    window.addEventListener('mousemove', (e) => {
      if (manualAnchoredVwapOverlay.isDragging()) {
        const rect = wrap.getBoundingClientRect();
        manualAnchoredVwapOverlay.onPointerMove(e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      // Dragging a drawing (or one of its endpoints) overrides chart panning.
      if (drawingToolsOverlay.isDragging()) {
        const rect = wrap.getBoundingClientRect();
        drawingToolsOverlay.onPointerMove(e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      // Shift the price axis to match the drag while the library pans time.
      if (lwPanStartY === null || lwPanBaseRange === null) return;
      if (e.buttons !== 1) return;
      notifyViewportInteraction();
      const priceScale = getPriceScale();
      if (!priceScale) return;
      const dy = e.clientY - lwPanStartY;
      const shift = lwPanPricePerPixel * dy;
      priceScale.setAutoScale(false);
      priceScale.setVisibleRange({
        from: lwPanBaseRange.from + shift,
        to: lwPanBaseRange.to + shift,
      });
      try { repositionLineLabels(); } catch {}
      return;
    });

    function endPointerGestureUi() {
      manualAnchoredVwapOverlay.onPointerUp();
      drawingToolsOverlay.onPointerUp();
      chartPointerDown = null;
      // End vertical price-pan tracking. Leave auto-scale off so the manual
      // vertical offset persists; it is restored only by an explicit re-frame
      // (Fit / Jump-to-Live / pair-or-timeframe switch).
      lwPanStartY = null;
      lwPanBaseRange = null;
      // Restore the resting crosshair after a pan ends.
      if (wrap.style.cursor === 'grabbing') wrap.style.cursor = 'crosshair';
    }

    window.addEventListener('mouseup', endPointerGestureUi);
    // pointercancel covers OS gesture steal / sleep paths that never fire mouseup.
    window.addEventListener('pointercancel', () => {
      endPointerGestureUi();
      try { releaseStuckChartGestures(); } catch {}
    });

    // Lost pointer capture (sleep, OS gesture steal, browser tab freeze) can
    // leave handleScroll=false without a mouseup. Unlock when the document
    // becomes interactive again; armed Draw/AVWAP placement stays locked.
    const releaseIfIdle = () => {
      lwPanStartY = null;
      lwPanBaseRange = null;
      chartPointerDown = null;
      if (wrap.style.cursor === 'grabbing') wrap.style.cursor = 'crosshair';
      try { releaseStuckChartGestures(); } catch {}
    };
    window.addEventListener('blur', releaseIfIdle);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') releaseIfIdle();
    });
    // Safari/macOS lid-wake sometimes fires pageshow without a useful
    // visibilitychange; treat it the same as a visible resume.
    window.addEventListener('pageshow', releaseIfIdle);
    document.addEventListener('resume', releaseIfIdle);
    window.addEventListener('online', releaseIfIdle);

    window.addEventListener('keydown', (e) => {
      // Don't hijack typing in form fields.
      const t = e.target;
      if (t instanceof Element && (t.closest('input, textarea, select') || t.isContentEditable)) return;
      if (e.key === 'Escape') {
        // Cancels an in-progress tool (overlay fires its change callback so the
        // toolbar clears) or deselects the current drawing.
        if (manualAnchoredVwapOverlay.isPlacementActive() || manualAnchoredVwapOverlay.hasSelection()) {
          manualAnchoredVwapOverlay.cancel();
        } else if (drawingToolsOverlay.isToolActive() || drawingToolsOverlay.hasSelection()) {
          drawingToolsOverlay.cancel();
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && manualAnchoredVwapOverlay.hasSelection()) {
        e.preventDefault();
        manualAnchoredVwapOverlay.removeSelected();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && drawingToolsOverlay.hasSelection()) {
        e.preventDefault();
        drawingToolsOverlay.removeSelected();
      }
    });

    chartWindowListenersAttached = true;
  }
}

export { attachChartEvents };
export { armChartPricePick, fitChartView, jumpChartToLive, recenterPriceScale, syncMobileChartActionBar };
