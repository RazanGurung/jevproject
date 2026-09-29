/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR_PALETTE, getColorPalette, resetColorPalette, setPaletteColor } from '../color-palette.js';
import {
  TEMPLATE_SLOT_COUNT,
  applyColorTemplate,
  clearColorTemplate,
  getColorTemplates,
  loadColorTemplates,
  resetColorTemplatesForTests,
  saveColorTemplate,
} from '../color-palette-templates.js';

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

function emptyDoc() {
  return {
    version: 1,
    slots: Array.from({ length: TEMPLATE_SLOT_COUNT }, (_, index) => ({
      index,
      colors: null,
    })),
  };
}

describe('color palette templates', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    localStorage.clear();
    resetColorPalette();
    resetColorTemplatesForTests();
    vi.restoreAllMocks();
  });

  it('loads four empty slots when the server returns empties', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => emptyDoc(),
    }));
    const slots = await loadColorTemplates({ force: true });
    expect(slots).toHaveLength(4);
    expect(slots.every((s) => s.colors === null)).toBe(true);
  });

  it('saves the active palette into a slot and applies it back', async () => {
    let stored = emptyDoc();
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => stored,
        };
      }
      if (method === 'PUT') {
        stored = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(stored),
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    await loadColorTemplates({ force: true });
    setPaletteColor('bullish', '#aabbcc');
    setPaletteColor('bearish', '#112233');

    expect(await saveColorTemplate(2)).toBe(true);
    const slots = getColorTemplates();
    expect(slots[2].colors.bullish).toBe('#aabbcc');
    expect(slots[2].colors.bearish).toBe('#112233');

    resetColorPalette();
    expect(getColorPalette().bullish).toBe(DEFAULT_COLOR_PALETTE.bullish);
    expect(await applyColorTemplate(2)).toBe(true);
    expect(getColorPalette().bullish).toBe('#aabbcc');
    expect(getColorPalette().bearish).toBe('#112233');
  });

  it('clears a filled slot and rejects invalid indices', async () => {
    let stored = emptyDoc();
    stored.slots[0].colors = { ...DEFAULT_COLOR_PALETTE, bullish: '#010203' };
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return { ok: true, status: 200, json: async () => stored };
      }
      stored = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(stored) };
    });

    await loadColorTemplates({ force: true });
    expect(await clearColorTemplate(0)).toBe(true);
    expect(getColorTemplates()[0].colors).toBeNull();
    expect(await saveColorTemplate(-1)).toBe(false);
    expect(await applyColorTemplate(99)).toBe(false);
  });

  it('keeps empty slots usable when GET fails', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const slots = await loadColorTemplates({ force: true });
    expect(slots).toHaveLength(4);
    expect(await applyColorTemplate(0)).toBe(false);
  });
});
