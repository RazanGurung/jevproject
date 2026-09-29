/**
 * Drawing model — types, serialization, and per-coin localStorage persistence.
 * Canvas render + pointer interaction stay in drawing-tools.js.
 */

import { getPaletteColor } from '../services/color-palette.js';

const STORAGE_PREFIX = 'pez:drawings:';
const DEFAULT_COLOR = '#d8d8d8';

const POINT_COUNTS = {
  horizontal: 1,
  vertical: 1,
  trendline: 2,
  ray: 2,
  arrow: 2,
  extended: 2,
  hray: 1,
  box: 2,
  circle: 2,
  curve: 3,
  channel: 3,
  fib: 2,
  measure: 2,
  text: 1,
  pencil: 0,
  zigzag: 0,
  arrowUp: 1,
  arrowDown: 1,
  longPosition: 5,
  shortPosition: 5,
};

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

const drawingColor = () => getPaletteColor('drawing');
const bullishColor = () => getPaletteColor('bullish');
const bearishColor = () => getPaletteColor('bearish');

export function toolColor(type) {
  if (type === 'arrowUp' || type === 'longPosition') return bullishColor() || DEFAULT_COLOR;
  if (type === 'arrowDown' || type === 'shortPosition') return bearishColor() || DEFAULT_COLOR;
  return drawingColor() || DEFAULT_COLOR;
}

export function renderedDrawingColor(drawing) {
  if (drawing?.color) return drawing.color;
  return toolColor(drawing?.type);
}

export function requiredPoints(type) {
  return POINT_COUNTS[type] ?? 0;
}

// Position tools: 2 clicks expand into 5 stored levels at commit.
const PLACEMENT_POINTS = {
  longPosition: 2,
  shortPosition: 2,
};

export function placementPoints(type) {
  // Polylines never auto-commit on Nth click — only double-click commits.
  if (type === 'zigzag') return Infinity;
  return PLACEMENT_POINTS[type] ?? requiredPoints(type);
}

export function isDrawingType(type) {
  return Object.prototype.hasOwnProperty.call(POINT_COUNTS, type);
}

export function isPositionType(type) {
  return type === 'longPosition' || type === 'shortPosition';
}

export function isFreehandType(type) {
  return type === 'pencil';
}

export function isPolylineType(type) {
  return type === 'zigzag';
}

export function isVariableLengthType(type) {
  return isFreehandType(type) || isPolylineType(type);
}

export function buildPositionPoints(type, entryPt, stopPt) {
  const entry = Number(entryPt.price);
  const stop = Number(stopPt.price);
  const risk = Math.abs(entry - stop) || Math.abs(entry) * 0.01 || 1;
  const dir = type === 'shortPosition' ? -1 : 1;
  const time = entryPt.time;
  return [
    { time, price: entry },
    { time, price: stop },
    { time, price: entry + dir * risk },
    { time, price: entry + dir * risk * 2 },
    { time, price: entry + dir * risk * 3 },
  ];
}

export function createDrawingId() {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function serializeDrawings(list) {
  if (!Array.isArray(list)) return '[]';
  const out = list.filter(Boolean).map((d) => ({
    id: d.id,
    type: d.type,
    points: d.points,
    color: d.color,
    text: d.text,
    geometry: d.geometry,
    fontSize: d.fontSize,
    ...(d.radius != null ? { radius: d.radius } : {}),
  }));
  return JSON.stringify(out);
}

function isCompleteDrawing(d) {
  if (!d || !isDrawingType(d.type) || !Array.isArray(d.points)) return false;
  if (isFreehandType(d.type) || isPolylineType(d.type)) {
    return d.points.length >= 2;
  }
  const need = requiredPoints(d.type);
  return need > 0 ? d.points.length >= need : d.points.length > 0;
}

export function deserializeDrawings(json) {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isCompleteDrawing);
  } catch {
    return [];
  }
}

function storageKey(coin, suffix = '') {
  return `${STORAGE_PREFIX}${coin || ''}${suffix || ''}`;
}

export function loadDrawings(coin, suffix = '') {
  try {
    return deserializeDrawings(localStorage.getItem(storageKey(coin, suffix)));
  } catch {
    return [];
  }
}

export function saveDrawings(coin, list, suffix = '') {
  try {
    const json = serializeDrawings(list);
    if (json === '[]') localStorage.removeItem(storageKey(coin, suffix));
    else localStorage.setItem(storageKey(coin, suffix), json);
  } catch {}
}

export {
  POINT_COUNTS,
  FIB_LEVELS,
  DEFAULT_COLOR,
  STORAGE_PREFIX,
};
