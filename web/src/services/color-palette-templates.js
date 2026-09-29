/**
 * Durable color palette templates — four slots stored on the server disk
 * so they survive browser cache / site-data clears. The active working palette
 * remains in localStorage via color-palette.js.
 */

import { apiGet, apiPut } from './api.js';
import {
  COLOR_KEYS,
  DEFAULT_COLOR_PALETTE,
  getColorPalette,
  normalizeHexColor,
  setColorPalette,
} from './color-palette.js';

export const TEMPLATE_SLOT_COUNT = 4;
export const COLOR_TEMPLATES_API = '/api/color-palette-templates';

const listeners = new Set();

function emptySlots() {
  return Array.from({ length: TEMPLATE_SLOT_COUNT }, (_, index) => ({
    index,
    colors: null,
  }));
}

let slots = emptySlots();
let loaded = false;
let loadPromise = null;

function snapshotSlots() {
  return slots.map((slot) => ({
    index: slot.index,
    colors: slot.colors ? { ...slot.colors } : null,
  }));
}

function notify() {
  const snap = snapshotSlots();
  for (const listener of listeners) {
    try { listener(snap); } catch {}
  }
}

function normalizeSlotColors(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const next = { ...DEFAULT_COLOR_PALETTE };
  let hasValid = false;
  for (const key of COLOR_KEYS) {
    const normalized = normalizeHexColor(raw[key]);
    if (normalized) {
      next[key] = normalized;
      hasValid = true;
    }
  }
  return hasValid ? next : null;
}

function parseDocument(data) {
  const next = emptySlots();
  const list = Array.isArray(data?.slots) ? data.slots : [];
  for (let i = 0; i < list.length && i < TEMPLATE_SLOT_COUNT; i += 1) {
    const entry = list[i] || {};
    let index = Number(entry.index);
    if (!Number.isInteger(index) || index < 0 || index >= TEMPLATE_SLOT_COUNT) {
      index = i;
    }
    next[index] = {
      index,
      colors: normalizeSlotColors(entry.colors),
    };
  }
  return next;
}

function toDocument() {
  return {
    version: 1,
    slots: snapshotSlots(),
  };
}

async function persistToServer() {
  const saved = await apiPut(COLOR_TEMPLATES_API, toDocument());
  slots = parseDocument(saved);
  loaded = true;
  notify();
  return snapshotSlots();
}

export function getColorTemplates() {
  return snapshotSlots();
}

export function subscribeColorTemplates(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadColorTemplates({ force = false } = {}) {
  if (loadPromise && !force) return loadPromise;
  loadPromise = (async () => {
    try {
      const data = await apiGet(COLOR_TEMPLATES_API);
      slots = parseDocument(data);
      loaded = true;
      notify();
      return snapshotSlots();
    } catch {
      // Keep last known (or empty) so the UI still works offline.
      if (!loaded) {
        slots = emptySlots();
        loaded = true;
        notify();
      }
      return snapshotSlots();
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export async function saveColorTemplate(index) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= TEMPLATE_SLOT_COUNT) {
    return false;
  }
  if (!loaded) await loadColorTemplates();
  const colors = getColorPalette();
  slots = snapshotSlots();
  slots[idx] = { index: idx, colors: { ...colors } };
  try {
    await persistToServer();
    return true;
  } catch {
    return false;
  }
}

export async function applyColorTemplate(index) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= TEMPLATE_SLOT_COUNT) {
    return false;
  }
  if (!loaded) await loadColorTemplates();
  const slot = slots[idx];
  if (!slot?.colors) return false;
  return setColorPalette(slot.colors);
}

export async function clearColorTemplate(index) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= TEMPLATE_SLOT_COUNT) {
    return false;
  }
  if (!loaded) await loadColorTemplates();
  slots = snapshotSlots();
  slots[idx] = { index: idx, colors: null };
  try {
    await persistToServer();
    return true;
  } catch {
    return false;
  }
}

/** Test helper — reset in-memory template state without touching the server. */
export function resetColorTemplatesForTests() {
  slots = emptySlots();
  loaded = false;
  loadPromise = null;
}
