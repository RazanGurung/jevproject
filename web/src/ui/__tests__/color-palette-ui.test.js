/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLOR_KEYS, getColorPalette, resetColorPalette } from '../../services/color-palette.js';
import { resetColorTemplatesForTests } from '../../services/color-palette-templates.js';
import { resetPopoverControllerForTests } from '../popover-controller.js';
import {
  hexToHsv,
  hsvToHex,
  initColorPaletteUI,
  toggleColorPalette,
  toggleSettings,
} from '../color-palette-ui.js';

function installMemoryLocalStorage() {
  const store = new Map();
  const memoryStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage,
  });
}

function fixture() {
  document.body.innerHTML = `
    <button id="settingsToggleBtn" aria-expanded="false"></button>
    <div id="settingsPanel" style="display:none">
      <div class="settings-menu">
        <button id="colorPaletteToggleBtn" aria-expanded="false"></button>
      </div>
      <div id="colorPalettePanel" style="display:none">
        <button id="colorPaletteResetAll"></button>
        <div class="color-templates" id="colorTemplates">
          <div class="color-template-slots" id="colorTemplateSlots"></div>
          <button type="button" id="colorTemplateSave">Save</button>
          <button type="button" id="colorTemplateLoad">Load</button>
          <button type="button" id="colorTemplateClear">Clear</button>
          <div id="colorTemplateStatus"></div>
        </div>
        <div id="colorPaletteRows"></div>
        <div class="color-base-prism" id="colorBasePrism" tabindex="0"><span id="colorBasePrismCursor"></span></div>
        <div id="colorSpectrumMap" tabindex="0"><span id="colorSpectrumCursor"></span></div>
        <span id="colorCurrentPreview"></span>
        <input id="colorHexInput">
        <button id="colorPaletteResetOne"></button>
        <div id="colorHexError"></div>
      </div>
    </div>`;
}

describe('visual color palette UI', () => {
  let cleanup;

  beforeEach(() => {
    installMemoryLocalStorage();
    localStorage.clear();
    resetColorPalette();
    resetColorTemplatesForTests();
    resetPopoverControllerForTests();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        slots: [0, 1, 2, 3].map((index) => ({ index, colors: null })),
      }),
      text: async () => JSON.stringify({
        version: 1,
        slots: [0, 1, 2, 3].map((index) => ({ index, colors: null })),
      }),
    }));
    fixture();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    resetPopoverControllerForTests();
    resetColorPalette();
    resetColorTemplatesForTests();
  });

  it('round-trips HSV and hex colors', () => {
    expect(hsvToHex(0, 1, 1)).toBe('#FF0000');
    expect(hsvToHex(120, 1, 1)).toBe('#00FF00');
    expect(hexToHsv('#0000ff')).toEqual({ h: 240, s: 1, v: 1 });
  });

  it('nests Colors inside the Settings dropdown and renders all configurable colors', () => {
    cleanup = initColorPaletteUI();
    toggleSettings(document.getElementById('settingsToggleBtn'));
    expect(document.getElementById('settingsPanel').style.display).toBe('flex');
    expect(document.getElementById('settingsToggleBtn').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('colorPalettePanel').style.display).toBe('none');

    toggleColorPalette(document.getElementById('colorPaletteToggleBtn'));
    expect(document.getElementById('colorPalettePanel').style.display).toBe('flex');
    expect(document.getElementById('colorPaletteToggleBtn').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('settingsPanel').classList.contains('settings-colors-open')).toBe(true);
    expect(document.querySelectorAll('.color-palette-row')).toHaveLength(COLOR_KEYS.length);
    expect([...document.querySelectorAll('.color-palette-row-label')].map((row) => row.textContent))
      .toEqual(expect.arrayContaining([
        'AVWAP', 'RVWAP', 'PROFILE', 'MAP',
        'Session D', 'Session W', 'Session M',
        'Short Liq', 'Long Liq',
      ]));
    expect(document.querySelectorAll('.color-base-prism')).toHaveLength(1);
    expect(document.getElementById('colorHexInput').value).toBe('#22CCE6');
    expect(document.querySelectorAll('.color-template-slot')).toHaveLength(4);
    expect(document.getElementById('colorTemplateSave')).toBeTruthy();
    expect(document.getElementById('colorTemplateLoad').disabled).toBe(true);
  });

  it('saves the current palette into a selected template slot', async () => {
    let stored = {
      version: 1,
      slots: [0, 1, 2, 3].map((index) => ({ index, colors: null })),
    };
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return { ok: true, status: 200, json: async () => stored };
      }
      stored = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(stored) };
    });

    cleanup = initColorPaletteUI();
    const input = document.getElementById('colorHexInput');
    input.value = '#99AA11';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    document.querySelector('[data-template-slot="1"]').click();
    document.getElementById('colorTemplateSave').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-template-slot="1"]').classList.contains('filled')).toBe(true);
    });
    expect(document.getElementById('colorTemplateStatus').textContent).toMatch(/Saved to slot 2/);
    expect(document.getElementById('colorTemplateLoad').disabled).toBe(false);
  });

  it('edits AVWAP, RVWAP, PROFILE, and MAP independently', () => {
    cleanup = initColorPaletteUI();
    const input = document.getElementById('colorHexInput');
    const edit = (key, color) => {
      document.querySelector(`[data-palette-key="${key}"]`).click();
      input.value = color;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    edit('avwap', '#112233');
    edit('avwapBand', '#112244');
    edit('rvwap', '#445566');
    edit('rvwapBand', '#445577');
    edit('profile', '#778899');
    edit('projection', '#aabbcc');

    expect(getColorPalette()).toMatchObject({
      avwap: '#112233',
      avwapBand: '#112244',
      rvwap: '#445566',
      rvwapBand: '#445577',
      profile: '#778899',
      projection: '#aabbcc',
    });
  });

  it('sets an exact pure hex from the continuous base prism', () => {
    cleanup = initColorPaletteUI();
    const prism = document.getElementById('colorBasePrism');
    prism.getBoundingClientRect = () => ({ left: 0, top: 0, width: 359, height: 34 });
    prism.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 120,
      clientY: 10,
      buttons: 1,
    }));
    expect(getColorPalette().bullish).toBe('#00ff00');
    expect(document.getElementById('colorHexInput').value).toBe('#00FF00');
    expect(parseFloat(document.getElementById('colorBasePrismCursor').style.left))
      .toBeCloseTo((120 / 359) * 100, 5);
  });

  it('synchronizes valid hex edits, rejects invalid text, and resets a row', () => {
    const onChange = vi.fn();
    cleanup = initColorPaletteUI({ onChange });
    const input = document.getElementById('colorHexInput');
    input.value = '#123ABC';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(getColorPalette().bullish).toBe('#123abc');
    expect(onChange).toHaveBeenCalled();

    input.value = '#123';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(getColorPalette().bullish).toBe('#123abc');

    document.getElementById('colorPaletteResetOne').click();
    expect(getColorPalette().bullish).toBe('#22cce6');
  });

  it('updates from the visual spectrum and supports reset all', () => {
    cleanup = initColorPaletteUI();
    const map = document.getElementById('colorSpectrumMap');
    map.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    map.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      clientX: 50,
      clientY: 25,
      buttons: 1,
    }));
    expect(getColorPalette().bullish).not.toBe('#22cce6');
    expect(document.getElementById('colorHexInput').value).toMatch(/^#[0-9A-F]{6}$/);
    document.getElementById('colorPaletteResetAll').click();
    expect(getColorPalette().bullish).toBe('#22cce6');
  });
});
