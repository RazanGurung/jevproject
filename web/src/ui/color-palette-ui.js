import {
  COLOR_KEYS,
  DEFAULT_COLOR_PALETTE,
  applyPaletteCssVariables,
  getColorPalette,
  loadColorPalette,
  normalizeHexColor,
  resetColorPalette,
  resetPaletteColor,
  setPaletteColor,
  subscribeColorPalette,
} from '../services/color-palette.js';
import {
  TEMPLATE_SLOT_COUNT,
  applyColorTemplate,
  clearColorTemplate,
  getColorTemplates,
  loadColorTemplates,
  saveColorTemplate,
  subscribeColorTemplates,
} from '../services/color-palette-templates.js';
import { isPopoverOpen, positionPopover, togglePopover } from './popover-controller.js';

const LABELS = Object.freeze({
  bullish: 'Bullish',
  bearish: 'Bearish',
  bullishCandle: 'Bull candle',
  bearishCandle: 'Bear candle',
  liqShort: 'Short Liq',
  liqLong: 'Long Liq',
  sessionDaily: 'Session D',
  sessionWeekly: 'Session W',
  sessionMonthly: 'Session M',
  avwap: 'AVWAP',
  avwapBand: 'AVWAP Band',
  rvwap: 'RVWAP',
  rvwapBand: 'RVWAP Band',
  profile: 'PROFILE',
  projection: 'MAP',
  drawing: 'Drawing',
  background: 'Background', // main dark page areas (body / panels / chart)
  border: 'Border',         // all dividers, control outlines, panel gutters
});

const TEMPLATE_SWATCH_KEYS = Object.freeze([
  'bullish',
  'bearish',
  'avwap',
  'bullishCandle',
]);

let selectedKey = 'bullish';
let selectedTemplateSlot = 0;
let hue = 0;
let saturation = 1;
let brightness = 1;
let unsubscribe = null;
let unsubscribeTemplates = null;
let onPaletteChange = null;
let templateBusy = false;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function rgbToHsv(r, g, b) {
  const rr = clamp(Number(r) || 0, 0, 255) / 255;
  const gg = clamp(Number(g) || 0, 0, 255) / 255;
  const bb = clamp(Number(b) || 0, 0, 255) / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rr) h = 60 * (((gg - bb) / delta) % 6);
    else if (max === gg) h = 60 * (((bb - rr) / delta) + 2);
    else h = 60 * (((rr - gg) / delta) + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb(h, s, v) {
  const normalizedHue = ((Number(h) || 0) % 360 + 360) % 360;
  const sat = clamp(Number(s) || 0, 0, 1);
  const val = clamp(Number(v) || 0, 0, 1);
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const m = val - chroma;
  let parts = [0, 0, 0];
  if (normalizedHue < 60) parts = [chroma, x, 0];
  else if (normalizedHue < 120) parts = [x, chroma, 0];
  else if (normalizedHue < 180) parts = [0, chroma, x];
  else if (normalizedHue < 240) parts = [0, x, chroma];
  else if (normalizedHue < 300) parts = [x, 0, chroma];
  else parts = [chroma, 0, x];
  return {
    r: Math.round((parts[0] + m) * 255),
    g: Math.round((parts[1] + m) * 255),
    b: Math.round((parts[2] + m) * 255),
  };
}

function byteHex(value) {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0').toUpperCase();
}

export function hsvToHex(h, s, v) {
  const rgb = hsvToRgb(h, s, v);
  return `#${byteHex(rgb.r)}${byteHex(rgb.g)}${byteHex(rgb.b)}`;
}

export function hexToHsv(hex) {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return rgbToHsv(
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  );
}

function hueHex(value) {
  return hsvToHex(value, 1, 1);
}

function isColorsExpanded() {
  const panel = document.getElementById('colorPalettePanel');
  if (!panel) return false;
  return panel.style.display !== 'none' && panel.dataset.open !== 'false';
}

function syncSettingsToggleButton() {
  const button = document.getElementById('settingsToggleBtn');
  if (!button) return;
  const open = isPopoverOpen('settings');
  button.classList.toggle('active', open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function syncColorToggleButton() {
  const button = document.getElementById('colorPaletteToggleBtn');
  if (!button) return;
  const open = isColorsExpanded();
  button.classList.toggle('active', open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setColorsExpanded(expanded) {
  const panel = document.getElementById('colorPalettePanel');
  const settings = document.getElementById('settingsPanel');
  if (!panel) return;
  panel.style.display = expanded ? 'flex' : 'none';
  panel.dataset.open = expanded ? 'true' : 'false';
  settings?.classList.toggle('settings-colors-open', expanded);
  if (expanded) syncEditor();
  syncColorToggleButton();
  if (isPopoverOpen('settings')) positionSettingsPanel();
}

function renderRows(colors) {
  const container = document.getElementById('colorPaletteRows');
  if (!container) return;
  if (!container.childElementCount) {
    const fragment = document.createDocumentFragment();
    for (const key of COLOR_KEYS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'color-palette-row';
      button.dataset.paletteKey = key;
      button.setAttribute('aria-pressed', 'false');
      const swatch = document.createElement('span');
      swatch.className = 'color-palette-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'color-palette-row-label';
      label.textContent = LABELS[key];
      button.append(swatch, label);
      fragment.append(button);
    }
    container.append(fragment);
  }
  for (const row of container.querySelectorAll('.color-palette-row')) {
    const active = row.dataset.paletteKey === selectedKey;
    row.classList.toggle('active', active);
    row.setAttribute('aria-pressed', active ? 'true' : 'false');
    const swatch = row.querySelector('.color-palette-swatch');
    if (swatch) swatch.style.backgroundColor = colors[row.dataset.paletteKey];
  }
}

function syncEditor(colors = getColorPalette()) {
  const color = colors[selectedKey];
  const hsv = hexToHsv(color);
  if (!hsv) return;
  hue = hsv.h;
  saturation = hsv.s;
  brightness = hsv.v;
  const map = document.getElementById('colorSpectrumMap');
  const cursor = document.getElementById('colorSpectrumCursor');
  const prism = document.getElementById('colorBasePrism');
  const prismCursor = document.getElementById('colorBasePrismCursor');
  const input = document.getElementById('colorHexInput');
  const preview = document.getElementById('colorCurrentPreview');
  const error = document.getElementById('colorHexError');
  if (map) {
    map.style.setProperty('--palette-editor-hue', hueHex(hue));
    map.setAttribute('aria-valuetext', `${Math.round(saturation * 100)}% saturation, ${Math.round(brightness * 100)}% brightness`);
  }
  if (cursor) {
    cursor.style.left = `${saturation * 100}%`;
    cursor.style.top = `${(1 - brightness) * 100}%`;
  }
  if (prism) {
    prism.setAttribute('aria-valuenow', String(Math.round(hue)));
    prism.setAttribute('aria-valuetext', `${Math.round(hue)} degrees, ${hueHex(hue)}`);
  }
  if (prismCursor) prismCursor.style.left = `${(hue / 359) * 100}%`;
  if (input) {
    input.value = color.toUpperCase();
    input.classList.remove('invalid');
    input.setAttribute('aria-invalid', 'false');
    input.setAttribute('aria-label', `${LABELS[selectedKey]} hex color`);
  }
  if (preview) preview.style.backgroundColor = color;
  if (error) error.textContent = '';
  renderRows(colors);
}

function commitHsv() {
  setPaletteColor(selectedKey, hsvToHex(hue, saturation, brightness));
}

function updateMapFromPointer(event) {
  const map = document.getElementById('colorSpectrumMap');
  if (!map) return;
  const rect = map.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return;
  saturation = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  brightness = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
  commitHsv();
}

function updatePrismFromPointer(event) {
  const prism = document.getElementById('colorBasePrism');
  if (!prism) return;
  const rect = prism.getBoundingClientRect();
  if (!(rect.width > 0)) return;
  hue = clamp(((event.clientX - rect.left) / rect.width) * 359, 0, 359);
  saturation = 1;
  brightness = 1;
  commitHsv();
}

function positionSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  const button = document.getElementById('settingsToggleBtn');
  if (!panel || !button) return;
  const minWidth = isColorsExpanded() ? 322 : 148;
  positionPopover(panel, button, { minWidth, scrollable: true });
}

export function toggleSettings(triggerEl) {
  const panel = document.getElementById('settingsPanel');
  const button = triggerEl || document.getElementById('settingsToggleBtn');
  if (!panel || !button) return;
  togglePopover({
    id: 'settings',
    panel,
    trigger: button,
    openClass: 'active',
    position: positionSettingsPanel,
    onOpen: () => {
      syncSettingsToggleButton();
    },
    onClose: () => {
      setColorsExpanded(false);
      syncSettingsToggleButton();
    },
  });
  syncSettingsToggleButton();
}

/** Expand/collapse the Colors section nested inside the Settings dropdown. */
export function toggleColorPalette(triggerEl) {
  const panel = document.getElementById('colorPalettePanel');
  const button = triggerEl || document.getElementById('colorPaletteToggleBtn');
  if (!panel || !button) return;

  // Colors lives inside Settings; open Settings first if needed.
  if (!isPopoverOpen('settings')) {
    toggleSettings(document.getElementById('settingsToggleBtn'));
    if (isPopoverOpen('settings')) setColorsExpanded(true);
    return;
  }

  setColorsExpanded(!isColorsExpanded());
}

function setTemplateStatus(message = '', isError = false) {
  const el = document.getElementById('colorTemplateStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('error', Boolean(isError && message));
}

function renderTemplateSlots(templates = getColorTemplates()) {
  const container = document.getElementById('colorTemplateSlots');
  if (!container) return;
  if (!container.childElementCount) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < TEMPLATE_SLOT_COUNT; i += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'color-template-slot empty';
      button.dataset.templateSlot = String(i);
      button.setAttribute('aria-pressed', 'false');
      const swatches = document.createElement('span');
      swatches.className = 'color-template-slot-swatches';
      swatches.setAttribute('aria-hidden', 'true');
      for (let s = 0; s < TEMPLATE_SWATCH_KEYS.length; s += 1) {
        swatches.append(document.createElement('span'));
      }
      const label = document.createElement('span');
      label.className = 'color-template-slot-label';
      label.textContent = String(i + 1);
      button.append(swatches, label);
      fragment.append(button);
    }
    container.append(fragment);
  }
  for (const button of container.querySelectorAll('.color-template-slot')) {
    const index = Number(button.dataset.templateSlot);
    const slot = templates[index] || { colors: null };
    const filled = Boolean(slot.colors);
    const active = index === selectedTemplateSlot;
    button.classList.toggle('filled', filled);
    button.classList.toggle('empty', !filled);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      filled ? `Template ${index + 1}, saved` : `Template ${index + 1}, empty`,
    );
    const swatchEls = button.querySelectorAll('.color-template-slot-swatches span');
    TEMPLATE_SWATCH_KEYS.forEach((key, i) => {
      const el = swatchEls[i];
      if (!el) return;
      el.style.backgroundColor = filled ? slot.colors[key] : 'transparent';
    });
  }
  const loadBtn = document.getElementById('colorTemplateLoad');
  const clearBtn = document.getElementById('colorTemplateClear');
  const saveBtn = document.getElementById('colorTemplateSave');
  const selected = templates[selectedTemplateSlot];
  const hasSelected = Boolean(selected?.colors);
  if (loadBtn) loadBtn.disabled = templateBusy || !hasSelected;
  if (clearBtn) clearBtn.disabled = templateBusy || !hasSelected;
  if (saveBtn) saveBtn.disabled = templateBusy;
}

async function runTemplateAction(action) {
  if (templateBusy) return;
  templateBusy = true;
  renderTemplateSlots();
  setTemplateStatus('');
  try {
    const ok = await action();
    if (!ok) setTemplateStatus('Template action failed', true);
  } catch {
    setTemplateStatus('Template action failed', true);
  } finally {
    templateBusy = false;
    renderTemplateSlots();
  }
}

function installEditorHandlers() {
  const rows = document.getElementById('colorPaletteRows');
  const prism = document.getElementById('colorBasePrism');
  const map = document.getElementById('colorSpectrumMap');
  const input = document.getElementById('colorHexInput');
  const resetOne = document.getElementById('colorPaletteResetOne');
  const resetAll = document.getElementById('colorPaletteResetAll');
  const slots = document.getElementById('colorTemplateSlots');
  const saveBtn = document.getElementById('colorTemplateSave');
  const loadBtn = document.getElementById('colorTemplateLoad');
  const clearBtn = document.getElementById('colorTemplateClear');
  rows?.addEventListener('click', (event) => {
    const row = event.target.closest('.color-palette-row');
    if (!row || !COLOR_KEYS.includes(row.dataset.paletteKey)) return;
    selectedKey = row.dataset.paletteKey;
    syncEditor();
  });
  slots?.addEventListener('click', (event) => {
    const button = event.target.closest('.color-template-slot');
    if (!button) return;
    const index = Number(button.dataset.templateSlot);
    if (!Number.isInteger(index) || index < 0 || index >= TEMPLATE_SLOT_COUNT) return;
    selectedTemplateSlot = index;
    renderTemplateSlots();
    setTemplateStatus('');
  });
  saveBtn?.addEventListener('click', () => {
    runTemplateAction(async () => {
      const ok = await saveColorTemplate(selectedTemplateSlot);
      if (ok) setTemplateStatus(`Saved to slot ${selectedTemplateSlot + 1}`);
      return ok;
    });
  });
  loadBtn?.addEventListener('click', () => {
    runTemplateAction(async () => {
      const ok = await applyColorTemplate(selectedTemplateSlot);
      if (ok) setTemplateStatus(`Loaded slot ${selectedTemplateSlot + 1}`);
      return ok;
    });
  });
  clearBtn?.addEventListener('click', () => {
    runTemplateAction(async () => {
      const ok = await clearColorTemplate(selectedTemplateSlot);
      if (ok) setTemplateStatus(`Cleared slot ${selectedTemplateSlot + 1}`);
      return ok;
    });
  });
  prism?.addEventListener('pointerdown', (event) => {
    prism.setPointerCapture?.(event.pointerId);
    updatePrismFromPointer(event);
  });
  prism?.addEventListener('pointermove', (event) => {
    if (event.buttons === 0 && !prism.hasPointerCapture?.(event.pointerId)) return;
    updatePrismFromPointer(event);
  });
  prism?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 15 : 1;
    if (event.key === 'ArrowLeft') hue = clamp(hue - step, 0, 359);
    if (event.key === 'ArrowRight') hue = clamp(hue + step, 0, 359);
    if (event.key === 'Home') hue = 0;
    if (event.key === 'End') hue = 359;
    saturation = 1;
    brightness = 1;
    commitHsv();
  });
  map?.addEventListener('pointerdown', (event) => {
    map.setPointerCapture?.(event.pointerId);
    updateMapFromPointer(event);
  });
  map?.addEventListener('pointermove', (event) => {
    if (event.buttons === 0 && !map.hasPointerCapture?.(event.pointerId)) return;
    updateMapFromPointer(event);
  });
  map?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === 'ArrowLeft') saturation = clamp(saturation - step, 0, 1);
    if (event.key === 'ArrowRight') saturation = clamp(saturation + step, 0, 1);
    if (event.key === 'ArrowUp') brightness = clamp(brightness + step, 0, 1);
    if (event.key === 'ArrowDown') brightness = clamp(brightness - step, 0, 1);
    commitHsv();
  });
  input?.addEventListener('input', () => {
    const normalized = normalizeHexColor(input.value);
    const error = document.getElementById('colorHexError');
    input.classList.toggle('invalid', !normalized);
    input.setAttribute('aria-invalid', normalized ? 'false' : 'true');
    if (error) error.textContent = normalized ? '' : 'Enter a 6-digit hex color';
    if (normalized) setPaletteColor(selectedKey, normalized);
  });
  resetOne?.addEventListener('click', () => resetPaletteColor(selectedKey));
  resetAll?.addEventListener('click', () => resetColorPalette());
}

export function initColorPaletteUI({ onChange } = {}) {
  selectedKey = 'bullish';
  selectedTemplateSlot = 0;
  loadColorPalette();
  applyPaletteCssVariables();
  onPaletteChange = typeof onChange === 'function' ? onChange : null;
  renderRows(getColorPalette());
  renderTemplateSlots();
  syncEditor();
  installEditorHandlers();
  unsubscribe?.();
  unsubscribe = subscribeColorPalette((colors, key) => {
    applyPaletteCssVariables();
    syncEditor(colors);
    onPaletteChange?.(colors, key);
  });
  unsubscribeTemplates?.();
  unsubscribeTemplates = subscribeColorTemplates((templates) => {
    renderTemplateSlots(templates);
  });
  // Server-backed templates hydrate after local palette so chart theme is not blocked.
  loadColorTemplates().catch(() => {});
  setColorsExpanded(false);
  syncSettingsToggleButton();
  return () => {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeTemplates?.();
    unsubscribeTemplates = null;
    onPaletteChange = null;
  };
}

export { DEFAULT_COLOR_PALETTE };
