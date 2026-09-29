/**
 * Canvas drawing for chart overlays.
 * Pure helpers + shape renderer; coordinate conversion stays in drawing-tools.
 */

import {
  quadraticControlThroughMid,
  rayExit,
} from './drawing-geometry.js';
import { FIB_LEVELS as DEFAULT_FIB_LEVELS } from './drawing-model.js';

export const MARKER_W = 14;
export const MARKER_H = 22;
export const MARKER_STEM_W = 6;
export const MARKER_HEAD_H = 11;
export const ARROWHEAD_LEN = 11;
export const ARROWHEAD_HALF_W = 4.5;

export function strokePath(ctx, pts, hpr, vpr) {
  if (!Array.isArray(pts) || pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x * hpr, pts[0].y * vpr);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x * hpr, pts[i].y * vpr);
  ctx.stroke();
}

export function fillArrowHead(ctx, tx, ty, dx, dy, scale) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tx - ux * ARROWHEAD_LEN * scale;
  const by = ty - uy * ARROWHEAD_LEN * scale;
  const wx = -uy * ARROWHEAD_HALF_W * scale;
  const wy = ux * ARROWHEAD_HALF_W * scale;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(bx + wx, by + wy);
  ctx.lineTo(bx - wx, by - wy);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

export function fillMarkerArrow(ctx, tx, ty, dir, scale) {
  const halfHead = (MARKER_W / 2) * scale;
  const halfStem = (MARKER_STEM_W / 2) * scale;
  const headY = ty - dir * MARKER_HEAD_H * scale;
  const tailY = ty - dir * MARKER_H * scale;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx + halfHead, headY);
  ctx.lineTo(tx + halfStem, headY);
  ctx.lineTo(tx + halfStem, tailY);
  ctx.lineTo(tx - halfStem, tailY);
  ctx.lineTo(tx - halfStem, headY);
  ctx.lineTo(tx - halfHead, headY);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

export function drawSquareHandles(ctx, pts, hpr, vpr, {
  handleHitPx = 8,
  fill = '#ffb547',
  stroke = '#000',
} = {}) {
  if (!Array.isArray(pts)) return;
  const sw = handleHitPx * hpr;
  const sh = handleHitPx * vpr;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, hpr);
  for (const p of pts) {
    const x = p.x * hpr;
    const y = p.y * vpr;
    ctx.fillRect(x - sw / 2, y - sh / 2, sw, sh);
    ctx.strokeRect(x - sw / 2, y - sh / 2, sw, sh);
  }
  ctx.restore();
}

/** Media-px hit target for the ✕ control. */
export function drawDeleteControl(ctx, pts, hpr, vpr, {
  radius = 9,
  offset = 14,
  fill = '#d9534f',
  maxW = null,
  maxH = null,
} = {}) {
  if (!Array.isArray(pts) || pts.length === 0) return null;
  let maxX = -Infinity;
  let minY = Infinity;
  for (const p of pts) {
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
  }
  let cx = maxX + offset;
  let cy = minY - offset;
  if (maxW != null && Number.isFinite(maxW)) {
    cx = Math.max(radius + 2, Math.min(cx, maxW - radius - 2));
  }
  if (maxH != null && Number.isFinite(maxH)) {
    cy = Math.max(radius + 2, Math.min(cy, maxH - radius - 2));
  }
  const bx = cx * hpr;
  const by = cy * vpr;
  const r = radius * Math.max(hpr, vpr);
  ctx.save();
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, 1.5 * hpr);
  const k = r * 0.45;
  ctx.beginPath();
  ctx.moveTo(bx - k, by - k);
  ctx.lineTo(bx + k, by + k);
  ctx.moveTo(bx + k, by - k);
  ctx.lineTo(bx - k, by + k);
  ctx.stroke();
  ctx.restore();
  return { cx, cy, r: radius };
}

/**
 * Draw one shape in device coordinates.
 */
export function drawShape(ctx, type, pts, ratios, {
  full = true,
  levels = null,
  text = '',
  geometry = '',
  fontSize = 0,
  coin = '',
  fmtPrice = (p) => String(p),
  colors = {},
  positionBoxX = null,
  logicalIndexForTime = null,
  defaultTextFontSize = 12,
  fibLevels = DEFAULT_FIB_LEVELS,
  radius = 0,
  selected = false,
} = {}) {
  const { hpr, vpr, w, h } = ratios;
  if (!Array.isArray(pts) || pts.length === 0) return;

  const riskFill = colors.riskFill || 'rgba(255,80,80,0.1)';
  const rewardFill = colors.rewardFill || 'rgba(34,204,230,0.1)';
  const bullish = colors.bullish || '#22cce6';
  const bearish = colors.bearish || '#ff5050';
  const entry = colors.entry || '#c1c7cf';
  const labelColor = colors.label || '#c1c7cf';

  if (type === 'longPosition' || type === 'shortPosition') {
    if (pts.length < 5) return;
    const xb = typeof positionBoxX === 'function' ? positionBoxX(levels) : null;
    if (!xb) return;
    const x0 = xb.x0 * hpr;
    const x1 = xb.x1 * hpr;
    const yEntry = pts[0].y * vpr;
    const yStop = pts[1].y * vpr;
    const yTp3 = pts[4].y * vpr;

    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = riskFill;
    ctx.fillRect(x0, Math.min(yEntry, yStop), x1 - x0, Math.abs(yStop - yEntry));
    ctx.fillStyle = rewardFill;
    ctx.fillRect(x0, Math.min(yEntry, yTp3), x1 - x0, Math.abs(yTp3 - yEntry));

    ctx.lineWidth = 1.5 * Math.max(hpr, vpr);
    const level = (py, color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x0, py);
      ctx.lineTo(x1, py);
      ctx.stroke();
    };
    level(yEntry, entry);
    level(yStop, bearish);
    level(pts[2].y * vpr, bullish);
    level(pts[3].y * vpr, bullish);
    level(yTp3, bullish);

    if (levels && levels.length >= 5) {
      const prices = levels.map((p) => Number(p.price));
      ctx.font = `${Math.round(11 * Math.max(hpr, vpr))}px sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const lx = Math.min(x1 + 6 * hpr, w - 2 * hpr);
      const label = (py, labelText, color) => { ctx.fillStyle = color; ctx.fillText(labelText, lx, py); };
      label(yEntry, `${fmtPrice(prices[0], coin)}`, entry);
      label(yStop, `${fmtPrice(prices[1], coin)}`, bearish);
      label(pts[2].y * vpr, `${fmtPrice(prices[2], coin)}`, bullish);
      label(pts[3].y * vpr, `${fmtPrice(prices[3], coin)}`, bullish);
      label(yTp3, `${fmtPrice(prices[4], coin)}`, bullish);
    }
    ctx.restore();
    return;
  }

  if (type === 'horizontal') {
    const y = pts[0].y * vpr;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    return;
  }
  if (type === 'vertical') {
    const x = pts[0].x * hpr;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    return;
  }
  if (type === 'pencil' || type === 'zigzag') {
    if (pts.length < 2) return;
    strokePath(ctx, pts, hpr, vpr);
    return;
  }
  if (type === 'arrowUp' || type === 'arrowDown') {
    const dir = type === 'arrowDown' ? 1 : -1;
    ctx.save();
    fillMarkerArrow(ctx, pts[0].x * hpr, pts[0].y * vpr, dir, Math.max(hpr, vpr));
    ctx.restore();
    return;
  }
  if (type === 'text') {
    const x = pts[0].x * hpr;
    const y = pts[0].y * vpr;
    const size = fontSize > 0 ? fontSize : defaultTextFontSize;
    ctx.save();
    ctx.font = `${Math.round(size * Math.max(hpr, vpr))}px "IBM Plex Sans", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(text || '', x, y);
    ctx.restore();
    return;
  }
  if (type === 'fib') {
    if (pts.length < 2) return;
    const fx0 = Math.min(pts[0].x, pts[1].x) * hpr;
    const fx1 = Math.max(pts[0].x, pts[1].x) * hpr;
    const fy0 = pts[0].y;
    const fy1 = pts[1].y;
    const p0 = levels && levels[0] ? Number(levels[0].price) : null;
    const p1 = levels && levels[1] ? Number(levels[1].price) : null;
    ctx.save();
    ctx.font = `${Math.round(11 * Math.max(hpr, vpr))}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const lx = Math.min(fx1 + 6 * hpr, w - 2 * hpr);
    for (const ratio of fibLevels) {
      const y = (fy0 + (fy1 - fy0) * ratio) * vpr;
      ctx.beginPath();
      ctx.moveTo(fx0, y);
      ctx.lineTo(fx1, y);
      ctx.stroke();
      if (p0 != null && p1 != null) {
        const price = p0 + (p1 - p0) * ratio;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(`${ratio.toFixed(3)}  ${fmtPrice(price, coin)}`, lx, y);
      }
    }
    ctx.restore();
    return;
  }
  if (type === 'measure') {
    if (pts.length < 2) return;
    const mx0 = Math.min(pts[0].x, pts[1].x) * hpr;
    const mx1 = Math.max(pts[0].x, pts[1].x) * hpr;
    const my0 = pts[0].y * vpr;
    const my1 = pts[1].y * vpr;
    const p0 = levels && levels[0] ? Number(levels[0].price) : null;
    const p1 = levels && levels[1] ? Number(levels[1].price) : null;
    const rising = p0 != null && p1 != null ? p1 >= p0 : true;
    ctx.save();
    ctx.fillStyle = rising ? rewardFill : riskFill;
    ctx.fillRect(mx0, Math.min(my0, my1), mx1 - mx0, Math.abs(my1 - my0));
    ctx.strokeStyle = selected ? (colors.selected || '#ffb547') : (rising ? bullish : bearish);
    ctx.strokeRect(mx0, Math.min(my0, my1), mx1 - mx0, Math.abs(my1 - my0));
    if (p0 != null && p1 != null) {
      const delta = p1 - p0;
      const pct = p0 !== 0 ? (delta / p0) * 100 : 0;
      let bars = 0;
      if (typeof logicalIndexForTime === 'function' && levels?.[0] && levels?.[1]) {
        const i0 = logicalIndexForTime(levels[0].time);
        const i1 = logicalIndexForTime(levels[1].time);
        if (i0 != null && i1 != null) bars = Math.abs(Math.round(i1 - i0));
      }
      const sign = delta >= 0 ? '+' : '−';
      const label = `${sign}${fmtPrice(Math.abs(delta), coin)}  ${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%  ${bars} bars`;
      ctx.font = `${Math.round(11 * Math.max(hpr, vpr))}px sans-serif`;
      const topY = Math.min(my0, my1);
      const labelY = topY >= 18 * vpr ? topY - 4 * vpr : topY + 14 * vpr;
      ctx.textBaseline = topY >= 18 * vpr ? 'bottom' : 'top';
      ctx.textAlign = 'center';
      ctx.fillStyle = selected ? (colors.selected || '#ffb547') : labelColor;
      const labelX = Math.max(40 * hpr, Math.min((mx0 + mx1) / 2, w - 40 * hpr));
      ctx.fillText(label, labelX, labelY);
    }
    ctx.restore();
    return;
  }
  if (type === 'trendline') {
    if (pts.length < 2) return;
    strokePath(ctx, pts, hpr, vpr);
    return;
  }
  if (type === 'curve') {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * hpr, pts[0].y * vpr);
    if (pts.length < 3) {
      ctx.lineTo(pts[1].x * hpr, pts[1].y * vpr);
    } else {
      const control = quadraticControlThroughMid(pts[0], pts[1], pts[2]);
      ctx.quadraticCurveTo(
        control.x * hpr,
        control.y * vpr,
        pts[1].x * hpr,
        pts[1].y * vpr,
      );
    }
    ctx.stroke();
    return;
  }
  if (type === 'ray') {
    if (pts.length < 2) return;
    const a = { x: pts[0].x * hpr, y: pts[0].y * vpr };
    const b = { x: pts[1].x * hpr, y: pts[1].y * vpr };
    const exit = rayExit(a.x, a.y, b.x, b.y, w, h);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(exit.x, exit.y);
    ctx.stroke();
    return;
  }
  if (type === 'arrow') {
    if (pts.length < 2) return;
    const scale = Math.max(hpr, vpr);
    const ax = pts[0].x * hpr;
    const ay = pts[0].y * vpr;
    const bx = pts[1].x * hpr;
    const by = pts[1].y * vpr;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const inset = Math.min(ARROWHEAD_LEN * scale * 0.8, len);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx - (len > 1e-6 ? (dx / len) * inset : 0), by - (len > 1e-6 ? (dy / len) * inset : 0));
    ctx.stroke();
    ctx.save();
    fillArrowHead(ctx, bx, by, dx, dy, scale);
    ctx.restore();
    return;
  }
  if (type === 'extended') {
    if (pts.length < 2) return;
    const a = { x: pts[0].x * hpr, y: pts[0].y * vpr };
    const b = { x: pts[1].x * hpr, y: pts[1].y * vpr };
    const fwd = rayExit(a.x, a.y, b.x, b.y, w, h);
    const back = rayExit(b.x, b.y, a.x, a.y, w, h);
    ctx.beginPath();
    ctx.moveTo(back.x, back.y);
    ctx.lineTo(fwd.x, fwd.y);
    ctx.stroke();
    return;
  }
  if (type === 'hray') {
    const x = pts[0].x * hpr;
    const y = pts[0].y * vpr;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    return;
  }
  if (type === 'box') {
    if (pts.length < 2) return;
    const x0 = Math.min(pts[0].x, pts[1].x) * hpr;
    const y0 = Math.min(pts[0].y, pts[1].y) * vpr;
    const bw = Math.abs(pts[1].x - pts[0].x) * hpr;
    const bh = Math.abs(pts[1].y - pts[0].y) * vpr;
    ctx.strokeRect(x0, y0, bw, bh);
    return;
  }
  if (type === 'circle') {
    if (pts.length < 2) return;
    if (geometry === 'centerRadius') {
      const dy = Math.abs(pts[1].y - pts[0].y);
      const dx = Math.abs(pts[1].x - pts[0].x);
      const r = Math.max(1, dy > 0 ? dy : dx);
      ctx.beginPath();
      ctx.ellipse(
        pts[0].x * hpr,
        pts[0].y * vpr,
        r * hpr,
        r * vpr,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      return;
    }
    const cx = (pts[0].x + pts[1].x) / 2 * hpr;
    const cy = (pts[0].y + pts[1].y) / 2 * vpr;
    const rx = Math.max(1, Math.abs(pts[1].x - pts[0].x) / 2 * hpr);
    const ry = Math.max(1, Math.abs(pts[1].y - pts[0].y) / 2 * vpr);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (type === 'channel') {
    if (pts.length < 2) return;
    strokePath(ctx, [pts[0], pts[1]], hpr, vpr);
    if (pts.length < 3 || !full) return;
    const ax = pts[0].x; const ay = pts[0].y;
    const bx = pts[1].x; const by = pts[1].y;
    const cyp = pts[2].y; const cxp = pts[2].x;
    if (Math.abs(bx - ax) < 1e-6) {
      const xOffset = cxp - ax;
      strokePath(ctx, [
        { x: ax + xOffset, y: ay },
        { x: bx + xOffset, y: by },
      ], hpr, vpr);
    } else {
      const slope = (by - ay) / (bx - ax);
      const lineYAtCx = ay + slope * (cxp - ax);
      const offset = cyp - lineYAtCx;
      strokePath(ctx, [
        { x: ax, y: ay + offset },
        { x: bx, y: by + offset },
      ], hpr, vpr);
    }
  }
}
