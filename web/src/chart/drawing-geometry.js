export function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pointToRayDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lenSq);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pointToLineDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pointToRectDistance(px, py, ax, ay, bx, by) {
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  return Math.min(
    pointToSegmentDistance(px, py, x0, y0, x1, y0),
    pointToSegmentDistance(px, py, x1, y0, x1, y1),
    pointToSegmentDistance(px, py, x1, y1, x0, y1),
    pointToSegmentDistance(px, py, x0, y1, x0, y0),
  );
}

export function pointToEllipseDistance(px, py, ax, ay, bx, by) {
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const rx = Math.max(1, Math.abs(bx - ax) / 2);
  const ry = Math.max(1, Math.abs(by - ay) / 2);
  const r = Math.hypot((px - cx) / rx, (py - cy) / ry);
  return Math.abs(r - 1) * Math.min(rx, ry);
}

export function pointToCircleDistance(px, py, cx, cy, ex, ey) {
  const dy = Math.abs(ey - cy);
  const dx = Math.abs(ex - cx);
  const radius = Math.max(1, dy > 0 ? dy : dx);
  return Math.abs(Math.hypot(px - cx, py - cy) - radius);
}

// Derive the quadratic Bézier control whose t=.5 point is exactly `mid`.
// This lets the UI expose three intuitive on-curve anchors: start, end, mid.
export function quadraticControlThroughMid(start, end, mid) {
  return {
    x: 2 * mid.x - (start.x + end.x) / 2,
    y: 2 * mid.y - (start.y + end.y) / 2,
  };
}

// Approximate hit distance to a quadratic Bézier by sampling short segments.
// Drawing hit tolerances are media-pixel based, so 32 segments is smooth well
// beyond the 6px selection threshold without requiring a cubic solver.
export function pointToQuadraticDistance(px, py, start, end, control, segments = 32) {
  let distance = Infinity;
  let prevX = start.x;
  let prevY = start.y;
  for (let i = 1; i <= segments; i += 1) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x;
    const y = mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y;
    distance = Math.min(distance, pointToSegmentDistance(px, py, prevX, prevY, x, y));
    prevX = x;
    prevY = y;
  }
  return distance;
}

export function rayExit(ax, ay, bx, by, w, h) {
  const dx = bx - ax;
  const dy = by - ay;
  let tMax = Infinity;
  if (dx > 0) tMax = Math.min(tMax, (w - ax) / dx);
  else if (dx < 0) tMax = Math.min(tMax, (0 - ax) / dx);
  if (dy > 0) tMax = Math.min(tMax, (h - ay) / dy);
  else if (dy < 0) tMax = Math.min(tMax, (0 - ay) / dy);
  if (!Number.isFinite(tMax) || tMax < 1) tMax = 1;
  return { x: ax + dx * tMax, y: ay + dy * tMax };
}
