/**
 * Layout preferences — movers collapse and persisted column widths.
 * Visual density is hardwired in styles.css (single best terminal look).
 */

import { AppState } from '../state/store.js';

const COLS_KEY = 'pez:colWidths';
const MOVERS_KEY = 'pez:moversCollapsed';

// Book/DOM column width is hard-set in styles.css (--col-book) and is not
// user-editable — the largest whale marker needs a fixed spine clearance.
const COL_DEFAULTS = {
  news: 220,
  order: 280,
};

const COL_LIMITS = {
  news: { min: 160, max: 360 },
  order: { min: 240, max: 380 },
};

const COL_CSS = {
  news: '--col-news',
  order: '--col-order',
};

let prefsBound = false;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

function getMoversCollapsed() {
  if (typeof AppState.ui.moversCollapsed === 'boolean') return AppState.ui.moversCollapsed;
  return localStorage.getItem(MOVERS_KEY) === '1';
}

function getColWidths() {
  const saved = readJson(COLS_KEY, {});
  const next = { ...COL_DEFAULTS };
  for (const key of Object.keys(COL_DEFAULTS)) {
    const n = Number(saved?.[key]);
    if (Number.isFinite(n)) {
      const { min, max } = COL_LIMITS[key];
      next[key] = Math.min(max, Math.max(min, Math.round(n)));
    }
  }
  return next;
}

function applyColWidths(widths) {
  const root = document.documentElement;
  // Drop any legacy inline book width so styles.css owns --col-book.
  root.style.removeProperty('--col-book');
  for (const [key, cssVar] of Object.entries(COL_CSS)) {
    const px = widths[key] ?? COL_DEFAULTS[key];
    root.style.setProperty(cssVar, `${px}px`);
  }
  AppState.ui.colWidths = { ...widths };
  window.colWidths = { ...widths };
}

function applyMoversCollapsed(on) {
  const next = on === true;
  AppState.ui.moversCollapsed = next;
  window.moversCollapsed = next;
  document.body.classList.toggle('movers-collapsed', next);
  const btn = document.getElementById('moversToggleBtn');
  if (btn) {
    btn.classList.toggle('active', next);
    btn.setAttribute('aria-pressed', next ? 'true' : 'false');
    btn.title = next ? 'Show market movers' : 'Collapse market movers';
    btn.textContent = 'Movers';
  }
}

function clearLegacyLayoutPrefs() {
  // Drop classes/keys from removed density + focus experiments.
  document.body.classList.remove(
    'density-comfortable',
    'density-compact',
    'density-pro',
    'focus-mode',
  );
  try {
    localStorage.removeItem('pez:density');
    localStorage.removeItem('pez:focusMode');
  } catch {
    /* ignore */
  }
}

function setMoversCollapsed(on) {
  applyMoversCollapsed(on === true);
  try { localStorage.setItem(MOVERS_KEY, getMoversCollapsed() ? '1' : '0'); } catch { /* ignore */ }
  return getMoversCollapsed();
}

function toggleMoversCollapsed() {
  return setMoversCollapsed(!getMoversCollapsed());
}

function setColWidth(key, px) {
  if (!COL_LIMITS[key]) return getColWidths();
  const { min, max } = COL_LIMITS[key];
  const widths = getColWidths();
  widths[key] = Math.min(max, Math.max(min, Math.round(px)));
  applyColWidths(widths);
  writeJson(COLS_KEY, widths);
  return widths;
}

function resetColWidths() {
  applyColWidths({ ...COL_DEFAULTS });
  writeJson(COLS_KEY, { ...COL_DEFAULTS });
  return { ...COL_DEFAULTS };
}

function syncLayoutPrefsChrome() {
  clearLegacyLayoutPrefs();
  applyMoversCollapsed(getMoversCollapsed());
  applyColWidths(getColWidths());
}

function initLayoutPrefs() {
  syncLayoutPrefsChrome();
  prefsBound = true;
}

export {
  initLayoutPrefs,
  syncLayoutPrefsChrome,
  getMoversCollapsed,
  setMoversCollapsed,
  toggleMoversCollapsed,
  getColWidths,
  setColWidth,
  resetColWidths,
  COL_DEFAULTS,
  COL_LIMITS,
};
