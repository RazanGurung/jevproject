const STORAGE_KEY = 'pez:color-palette';
const STORAGE_VERSION = 2;

export const COLOR_KEYS = Object.freeze([
  'bullish',
  'bearish',
  'bullishCandle',
  'bearishCandle',
  'liqShort',
  'liqLong',
  'sessionDaily',
  'sessionWeekly',
  'sessionMonthly',
  'avwap',
  'avwapBand',
  'rvwap',
  'rvwapBand',
  'profile',
  'projection',
  'drawing',
  'background',
  'border',
]);

export const DEFAULT_COLOR_PALETTE = Object.freeze({
  bullish: '#22cce6',
  bearish: '#ff5050',
  bullishCandle: '#c8c8c8',
  bearishCandle: '#8c8c8c',
  liqShort: '#22cce6',
  liqLong: '#ff5050',
  sessionDaily: '#22cce6',
  sessionWeekly: '#4a9eff',
  sessionMonthly: '#a78bfa',
  avwap: '#306eb5',
  avwapBand: '#306eb5',
  rvwap: '#306eb5',
  rvwapBand: '#306eb5',
  profile: '#306eb5',
  projection: '#4a9eff',
  drawing: '#d8d8d8',
  // Main dark page fill (body / panel bodies / chart). Pure black #000000.
  background: '#000000',
  // All dividers/outlines (--border / --border2) plus panel gutters.
  border: '#2a2a2a',
});

let palette = { ...DEFAULT_COLOR_PALETTE };
let loaded = false;
const listeners = new Set();

function writeStoredPalette(colors) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      version: STORAGE_VERSION,
      colors,
    }));
  } catch {}
}

export function normalizeHexColor(value) {
  const raw = String(value || '').trim();
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : null;
}

function readStoredPalette() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COLOR_PALETTE };
    const parsed = JSON.parse(raw);
    if (![1, STORAGE_VERSION].includes(parsed?.version) || !parsed.colors) {
      return { ...DEFAULT_COLOR_PALETTE };
    }
    const next = { ...DEFAULT_COLOR_PALETTE };
    for (const key of COLOR_KEYS) {
      const normalized = normalizeHexColor(parsed.colors[key]);
      if (normalized) next[key] = normalized;
    }
    if (parsed.version === 1) {
      const indicator = normalizeHexColor(parsed.colors.indicator);
      if (indicator) {
        next.avwap = indicator;
        next.rvwap = indicator;
        next.profile = indicator;
        next.projection = indicator;
      }
      writeStoredPalette(next);
    }
    return next;
  } catch {
    return { ...DEFAULT_COLOR_PALETTE };
  }
}

function persist() {
  writeStoredPalette(palette);
}

function notify(changedKey = null) {
  const snapshot = getColorPalette();
  for (const listener of listeners) {
    try { listener(snapshot, changedKey); } catch {}
  }
}

export function loadColorPalette() {
  palette = readStoredPalette();
  loaded = true;
  return getColorPalette();
}

export function getColorPalette() {
  if (!loaded) loadColorPalette();
  return { ...palette };
}

export function getPaletteColor(key) {
  if (!loaded) loadColorPalette();
  return palette[key] || DEFAULT_COLOR_PALETTE[key] || null;
}

export function setPaletteColor(key, value) {
  if (!COLOR_KEYS.includes(key)) return false;
  const normalized = normalizeHexColor(value);
  if (!normalized) return false;
  if (!loaded) loadColorPalette();
  if (palette[key] === normalized) return true;
  palette = { ...palette, [key]: normalized };
  persist();
  notify(key);
  return true;
}

/**
 * Replace the full active palette in one write/notify pass.
 * Missing or invalid keys keep their current (or default) values.
 * Returns true when at least one color changed or was applied successfully.
 */
export function setColorPalette(colors) {
  if (!colors || typeof colors !== 'object') return false;
  if (!loaded) loadColorPalette();
  const next = { ...palette };
  let changed = false;
  for (const key of COLOR_KEYS) {
    const normalized = normalizeHexColor(colors[key]);
    if (!normalized) continue;
    if (next[key] !== normalized) {
      next[key] = normalized;
      changed = true;
    }
  }
  if (!changed) return true;
  palette = next;
  persist();
  notify(null);
  return true;
}

export function resetPaletteColor(key) {
  if (!COLOR_KEYS.includes(key)) return false;
  return setPaletteColor(key, DEFAULT_COLOR_PALETTE[key]);
}

export function resetColorPalette() {
  palette = { ...DEFAULT_COLOR_PALETTE };
  loaded = true;
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch {}
  notify(null);
  return getColorPalette();
}

export function subscribeColorPalette(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hexToRgb(value) {
  const normalized = normalizeHexColor(value);
  if (!normalized) return null;
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

export function colorWithAlpha(value, alpha = 1) {
  const rgb = hexToRgb(value);
  if (!rgb) return value;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

export function colorRgbChannels(value) {
  const rgb = hexToRgb(value);
  return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : '0, 0, 0';
}

export function paletteSignature() {
  if (!loaded) loadColorPalette();
  return COLOR_KEYS.map((key) => palette[key]).join(':');
}

export function applyPaletteCssVariables(root = globalThis.document?.documentElement) {
  if (!root?.style) return;
  const colors = getColorPalette();
  root.style.setProperty('--palette-bullish', colors.bullish);
  root.style.setProperty('--palette-bearish', colors.bearish);
  root.style.setProperty('--palette-bullish-candle', colors.bullishCandle);
  root.style.setProperty('--palette-bearish-candle', colors.bearishCandle);
  root.style.setProperty('--palette-liq-short', colors.liqShort);
  root.style.setProperty('--palette-liq-long', colors.liqLong);
  root.style.setProperty('--palette-session-daily', colors.sessionDaily);
  root.style.setProperty('--palette-session-weekly', colors.sessionWeekly);
  root.style.setProperty('--palette-session-monthly', colors.sessionMonthly);
  root.style.setProperty('--palette-avwap', colors.avwap);
  root.style.setProperty('--palette-avwap-band', colors.avwapBand || colors.avwap);
  root.style.setProperty('--palette-rvwap', colors.rvwap);
  root.style.setProperty('--palette-rvwap-band', colors.rvwapBand || colors.rvwap);
  root.style.setProperty('--palette-profile', colors.profile);
  root.style.setProperty('--palette-projection', colors.projection);
  root.style.setProperty('--palette-drawing', colors.drawing);
  root.style.setProperty('--palette-background', colors.background);
  root.style.setProperty('--palette-border', colors.border);
  root.style.setProperty('--palette-bullish-rgb', colorRgbChannels(colors.bullish));
  root.style.setProperty('--palette-bearish-rgb', colorRgbChannels(colors.bearish));
  root.style.setProperty('--palette-liq-short-rgb', colorRgbChannels(colors.liqShort));
  root.style.setProperty('--palette-liq-long-rgb', colorRgbChannels(colors.liqLong));
  root.style.setProperty('--palette-session-daily-rgb', colorRgbChannels(colors.sessionDaily));
  root.style.setProperty('--palette-session-weekly-rgb', colorRgbChannels(colors.sessionWeekly));
  root.style.setProperty('--palette-session-monthly-rgb', colorRgbChannels(colors.sessionMonthly));
  root.style.setProperty('--palette-avwap-rgb', colorRgbChannels(colors.avwap));
  root.style.setProperty('--palette-avwap-band-rgb', colorRgbChannels(colors.avwapBand || colors.avwap));
  root.style.setProperty('--palette-rvwap-rgb', colorRgbChannels(colors.rvwap));
  root.style.setProperty('--palette-rvwap-band-rgb', colorRgbChannels(colors.rvwapBand || colors.rvwap));
  root.style.setProperty('--palette-profile-rgb', colorRgbChannels(colors.profile));
  root.style.setProperty('--palette-projection-rgb', colorRgbChannels(colors.projection));
  root.style.setProperty('--palette-background-rgb', colorRgbChannels(colors.background));
  root.style.setProperty('--palette-border-rgb', colorRgbChannels(colors.border));
  root.style.setProperty('--green', colors.bullish);
  root.style.setProperty('--green2', colors.bullish);
  root.style.setProperty('--red', colors.bearish);
  root.style.setProperty('--red2', colors.bearish);
  root.style.setProperty('--up', colors.bullish);
  root.style.setProperty('--down', colors.bearish);
}

export const COLOR_PALETTE_STORAGE_KEY = STORAGE_KEY;
