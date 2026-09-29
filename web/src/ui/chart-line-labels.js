/**
 * Interactive DOM labels for order protection and position price lines.
 * Sits on top of the lightweight-chart container. Each label anchors to its
 * line's y-coordinate via priceToCoordinate(). Order labels support drag to
 * modify price (release → order-modify service); the × button cancels the
 * order / closes the position. This is a UI adapter layered on top of the
 * chart, not part of chart-state ownership.
 */

import { AppState } from '../state/store.js';
import { getOpenOrders } from '../state/account-state.js';
import { modifyLimitPrice, modifyTriggerPrice } from '../services/order-modify.js';
import { cancelOid, closePosition } from '../services/trading-service.js';
import { fmtPrice } from '../utils/format.js';
import { roundPriceToTick } from '../services/trading-service-helpers.js';
import { showToast } from './toast.js';
import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';

const OVERLAY_CLASS = 'chart-line-labels-overlay';
const LABEL_HEIGHT = 18;
const MIN_DRAG_DISTANCE_PX = 4;

function createOverlayElement() {
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'z-index:5',
    'overflow:hidden',
  ].join(';');
  return overlay;
}

function makeLabelEl({ color, draggable, kindLabel = '', horizontalPosition = 'left' }) {
  const centerAligned = horizontalPosition === 'center';
  const el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    centerAligned ? 'left:50%' : 'left:2px',
    `height:${LABEL_HEIGHT}px`,
    'display:none',
    'align-items:center',
    'gap:4px',
    'padding:0 4px 0 6px',
    'border-radius:3px',
    'background:rgba(12,16,22,0.78)',
    `border:1px solid ${color}`,
    `color:${color}`,
    'font:10px/1 IBM Plex Mono, ui-monospace, monospace',
    'pointer-events:auto',
    'user-select:none',
    'white-space:nowrap',
    centerAligned ? 'transform:translate(-50%, -50%)' : 'transform:translateY(-50%)',
    draggable ? 'cursor:ns-resize' : 'cursor:default',
    'box-shadow:0 1px 4px rgba(0,0,0,0.35)',
  ].join(';');

  const kindSpan = document.createElement('span');
  kindSpan.dataset.role = 'kind';
  kindSpan.textContent = kindLabel;
  kindSpan.style.cssText = [
    'padding:0 4px',
    'border-radius:2px',
    'background:rgba(255,255,255,0.08)',
    `color:${color}`,
    'font-weight:700',
  ].join(';');

  const priceSpan = document.createElement('span');
  priceSpan.dataset.role = 'price';

  const xBtn = document.createElement('button');
  xBtn.type = 'button';
  xBtn.textContent = '×';
  xBtn.title = 'Cancel';
  xBtn.style.cssText = [
    'all:unset',
    'cursor:pointer',
    'padding:0 4px',
    'margin-left:2px',
    'border-radius:2px',
    `color:${color}`,
    'font:12px/1 IBM Plex Mono, ui-monospace, monospace',
    'opacity:0.85',
  ].join(';');
  xBtn.addEventListener('mouseenter', () => {
    xBtn.style.background = 'rgba(255,80,80,0.25)';
    xBtn.style.opacity = '1';
  });
  xBtn.addEventListener('mouseleave', () => {
    xBtn.style.background = 'transparent';
    xBtn.style.opacity = '0.85';
  });

  el.appendChild(kindSpan);
  el.appendChild(priceSpan);
  el.appendChild(xBtn);
  return { el, kindSpan, priceSpan, xBtn };
}

function sideColor(side) {
  return colorWithAlpha(getPaletteColor(
    side === 'long' || side === 'B' || side === 'buy' ? 'bullish' : 'bearish'
  ), 0.9);
}

function orderColor(order = {}) {
  if (order.tpsl === 'tp') return colorWithAlpha(getPaletteColor('bullish'), 0.92);
  if (order.tpsl === 'sl') return colorWithAlpha(getPaletteColor('bearish'), 0.92);
  return sideColor(order.side);
}

function orderKindLabel(order = {}) {
  if (order.tpsl === 'tp') return 'TP';
  if (order.tpsl === 'sl') return 'SL';
  return order.side === 'B' || order.side === 'buy' ? 'BUY' : 'SELL';
}

function positionKindLabel(position = {}) {
  const side = position.side === 'long' ? 'LONG' : 'SHORT';
  const liq = Number(position.liqPrice);
  // Always surface the exchange liq price: the liq line itself is often far
  // outside the visible range for small cross-margin positions.
  if (Number.isFinite(liq) && liq > 0) {
    return `${side} · LIQ ${fmtPrice(liq, position.coin)}`;
  }
  return side;
}

function applyLabelPalette(entry, color) {
  if (!entry?.el || !color) return;
  entry.el.style.borderColor = color;
  entry.el.style.color = color;
  if (entry.kindSpan) entry.kindSpan.style.color = color;
  if (entry.xBtn) entry.xBtn.style.color = color;
}

function createDragPreviewElement(color) {
  const line = document.createElement('div');
  line.style.cssText = [
    'position:absolute',
    'left:0',
    'right:0',
    'height:0',
    `border-top:1px dashed ${color}`,
    'pointer-events:none',
    'display:none',
    'opacity:0.9',
  ].join(';');
  return line;
}

function createLineLabels({
  getContainer,
  priceToCoordinate,
  coordinateToPrice,
}) {
  let overlay = null;
  let dragPreviewLine = null;
  const orderLabels = new Map();    // oid -> { el, priceSpan, xBtn, order, dragging, dragPrice }
  const positionLabels = new Map(); // sideKey -> { el, priceSpan, xBtn, position }

  function ensureOverlay() {
    const container = getContainer();
    if (!container) return null;
    if (!overlay || overlay.parentElement !== container) {
      if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
      overlay = createOverlayElement();
      container.appendChild(overlay);
      dragPreviewLine = null;
    }
    if (!dragPreviewLine) {
      dragPreviewLine = createDragPreviewElement('rgba(255,255,255,0.7)');
      overlay.appendChild(dragPreviewLine);
    }
    return overlay;
  }

  function showDragPreview(y, color) {
    if (!dragPreviewLine || !Number.isFinite(y)) return;
    dragPreviewLine.style.borderTopColor = color;
    dragPreviewLine.style.top = `${Math.round(y)}px`;
    dragPreviewLine.style.display = 'block';
  }

  function hideDragPreview() {
    if (!dragPreviewLine) return;
    dragPreviewLine.style.display = 'none';
  }

  function setLabelY(el, y) {
    if (!Number.isFinite(y)) {
      el.style.display = 'none';
      return;
    }
    el.style.top = `${Math.round(y)}px`;
    el.style.display = 'flex';
  }

  function positionEntryFromPrice(entry, price) {
    const y = priceToCoordinate(price);
    setLabelY(entry.el, y);
  }

  function containerY(clientY) {
    const container = getContainer();
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return clientY - rect.top;
  }

  function attachOrderLabelHandlers(entry) {
    const { el, xBtn } = entry;

    xBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const liveOrder = (getOpenOrders() || []).find((order) => String(order?.oid) === String(entry.order?.oid));
      const oid = liveOrder?.oid ?? entry.order?.oid;
      const coin = liveOrder?.coin || entry.order?.coin;
      if (!coin || oid == null) return;
      xBtn.disabled = true;
      try { await cancelOid(coin, oid); } finally { xBtn.disabled = false; }
    });

    function resetDragVisuals() {
      el.style.opacity = '';
      el.style.pointerEvents = '';
      hideDragPreview();
    }

    function snapLabelBack() {
      positionEntryFromPrice(entry, entry.order.price);
      entry.priceSpan.textContent = fmtPrice(entry.order.price, entry.order.coin);
    }

    function cleanupPointerSession() {
      entry.pendingDrag = false;
      entry.pointerStartClientY = null;
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowCancel);
    }

    async function finishDrag() {
      if (!entry.dragging) return;
      entry.dragging = false;
      cleanupPointerSession();
      resetDragVisuals();

      const startPrice = entry.order.price;
      const rawPrice = entry.dragPrice;
      const nextPrice = Number.isFinite(rawPrice)
        ? roundPriceToTick(rawPrice, entry.order.coin)
        : NaN;
      if (!Number.isFinite(nextPrice) || nextPrice <= 0 || nextPrice === startPrice) {
        snapLabelBack();
        return;
      }
      const liveOrder = (getOpenOrders() || []).find((o) => String(o.oid) === String(entry.order.oid));
      const sz = liveOrder ? parseFloat(liveOrder.sz) : NaN;
      if (!Number.isFinite(sz) || sz <= 0) {
        showToast(`${entry.order.coin} order is no longer open — drag cancelled`, true);
        snapLabelBack();
        return;
      }
      el.style.pointerEvents = 'none';
      try {
        const ok = entry.order.tpsl
          ? await modifyTriggerPrice({
            oid: entry.order.oid,
            coin: entry.order.coin,
            isBuy: entry.order.side === 'B',
            sz,
            triggerPx: nextPrice,
            tpsl: entry.order.tpsl,
          })
          : await modifyLimitPrice({
            oid: entry.order.oid,
            coin: entry.order.coin,
            isBuy: entry.order.side === 'B',
            sz,
            limitPx: nextPrice,
            reduceOnly: entry.order.reduceOnly === true,
          });
        if (!ok) snapLabelBack();
      } catch {
        snapLabelBack();
      } finally {
        el.style.pointerEvents = '';
      }
    }

    function onWindowMove(e) {
      const y = containerY(e.clientY);
      const price = y == null ? null : coordinateToPrice(y);
      if (!Number.isFinite(price) || price <= 0) return;
      if (!entry.dragging) {
        if (!entry.pendingDrag) return;
        if (Math.abs(e.clientY - entry.pointerStartClientY) < MIN_DRAG_DISTANCE_PX) return;
        entry.dragging = true;
        entry.pendingDrag = false;
        el.style.opacity = '0.85';
        const startY = priceToCoordinate(entry.order.price);
        if (Number.isFinite(startY)) showDragPreview(startY, orderColor(entry.order));
      }
      entry.dragPrice = price;
      setLabelY(el, y);
      entry.priceSpan.textContent = fmtPrice(price, entry.order.coin);
      showDragPreview(y, orderColor(entry.order));
    }

    function onWindowUp() {
      if (!entry.dragging) {
        cleanupPointerSession();
        resetDragVisuals();
        return;
      }
      finishDrag();
    }

    function onWindowCancel() {
      if (!entry.dragging && !entry.pendingDrag) return;
      entry.dragging = false;
      cleanupPointerSession();
      resetDragVisuals();
      snapLabelBack();
    }

    el.addEventListener('pointerdown', (e) => {
      if (e.target === xBtn || xBtn.contains(e.target)) return;
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      entry.pendingDrag = true;
      entry.pointerStartClientY = e.clientY;
      entry.dragPrice = entry.order.price;
      window.addEventListener('pointermove', onWindowMove);
      window.addEventListener('pointerup', onWindowUp);
      window.addEventListener('pointercancel', onWindowCancel);
    });
  }

  function attachPositionLabelHandlers(entry) {
    const { xBtn } = entry;
    xBtn.title = 'Close Position';
    xBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const { coin } = entry.position;
      if (!coin) return;
      xBtn.disabled = true;
      try { await closePosition(coin, 1.0); } finally { xBtn.disabled = false; }
    });
  }

  function buildOrderLabel(order) {
    const color = orderColor(order);
    const parts = makeLabelEl({ color, draggable: true, kindLabel: orderKindLabel(order) });
    const entry = {
      ...parts,
      order,
      dragging: false,
      pendingDrag: false,
      dragPrice: null,
      pointerStartClientY: null,
    };
    entry.xBtn.title = order.tpsl ? `Cancel ${String(order.tpsl).toUpperCase()} Trigger` : 'Cancel Order';
    attachOrderLabelHandlers(entry);
    entry.priceSpan.textContent = fmtPrice(order.price, order.coin);
    return entry;
  }

  function buildPositionLabel(position) {
    const color = sideColor(position.side);
    const parts = makeLabelEl({
      color,
      draggable: false,
      kindLabel: positionKindLabel(position),
      horizontalPosition: 'center',
    });
    parts.el.style.cursor = 'default';
    const entry = { ...parts, position };
    attachPositionLabelHandlers(entry);
    entry.priceSpan.textContent = fmtPrice(position.price, position.coin);
    return entry;
  }

  function syncOrderLabels(orders = [], coin = AppState.trading.currentCoin) {
    try {
      const root = ensureOverlay();
      if (!root) return;

      const visibleOrders = (Array.isArray(orders) ? orders : []).filter((o) => {
        if (o?.oid == null) return false;
        const hasTriggerOnly = Number.isFinite(Number(o?.triggerPx)) && !o?.tpsl;
        return !hasTriggerOnly;
      });
      const seen = new Set();

      for (const order of visibleOrders) {
        const key = String(order.oid);
        seen.add(key);
        const enriched = { ...order, coin: order.coin || coin };
        let entry = orderLabels.get(key);
        if (!entry) {
          entry = buildOrderLabel(enriched);
          orderLabels.set(key, entry);
          root.appendChild(entry.el);
        } else {
          entry.order = enriched;
          entry.kindSpan.textContent = orderKindLabel(enriched);
          applyLabelPalette(entry, orderColor(enriched));
          entry.xBtn.title = enriched.tpsl ? `Cancel ${String(enriched.tpsl).toUpperCase()} Trigger` : 'Cancel Order';
        }
        if (!entry.dragging) {
          entry.priceSpan.textContent = fmtPrice(enriched.price, coin);
          positionEntryFromPrice(entry, enriched.price);
        }
      }

      for (const [key, entry] of orderLabels) {
        if (!seen.has(key)) {
          entry.el.remove();
          orderLabels.delete(key);
        }
      }
    } catch (err) {
      console.error('[chart-line-labels] syncOrderLabels failed', err);
    }
  }

  function syncPositionLabels(positions = [], coin = AppState.trading.currentCoin) {
    try {
      const root = ensureOverlay();
      if (!root) return;

      const list = (Array.isArray(positions) ? positions : [])
        .filter((p) => Number.isFinite(Number(p?.price)) && Number(p.price) > 0);
      const seen = new Set();

      for (const position of list) {
        const positionCoin = position.coin || coin;
        const key = `${positionCoin}:${position.side || ''}:${Number(position.price).toFixed(8)}`;
        seen.add(key);
        const enriched = { ...position, coin: positionCoin };
        let entry = positionLabels.get(key);
        if (!entry) {
          entry = buildPositionLabel(enriched);
          positionLabels.set(key, entry);
          root.appendChild(entry.el);
        } else {
          entry.position = enriched;
          entry.kindSpan.textContent = positionKindLabel(enriched);
          applyLabelPalette(entry, sideColor(enriched.side));
        }
        entry.priceSpan.textContent = fmtPrice(enriched.price, enriched.coin);
        positionEntryFromPrice(entry, enriched.price);
      }

      for (const [key, entry] of positionLabels) {
        if (!seen.has(key)) {
          entry.el.remove();
          positionLabels.delete(key);
        }
      }
    } catch (err) {
      console.error('[chart-line-labels] syncPositionLabels failed', err);
    }
  }

  function repositionAll() {
    for (const entry of orderLabels.values()) {
      if (entry.dragging) continue;
      positionEntryFromPrice(entry, entry.order.price);
    }
    for (const entry of positionLabels.values()) {
      positionEntryFromPrice(entry, entry.position.price);
    }
  }

  function clearAll() {
    for (const entry of orderLabels.values()) entry.el.remove();
    for (const entry of positionLabels.values()) entry.el.remove();
    orderLabels.clear();
    positionLabels.clear();
  }

  function teardown() {
    clearAll();
    hideDragPreview();
    if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
    overlay = null;
    dragPreviewLine = null;
  }

  return {
    syncOrderLabels,
    syncPositionLabels,
    repositionAll,
    clearAll,
    teardown,
  };
}

export { createLineLabels };
