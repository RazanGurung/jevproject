/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLOR_PALETTE_STORAGE_KEY,
  DEFAULT_COLOR_PALETTE,
  colorWithAlpha,
  getColorPalette,
  loadColorPalette,
  normalizeHexColor,
  resetColorPalette,
  resetPaletteColor,
  setColorPalette,
  setPaletteColor,
  subscribeColorPalette,
} from '../color-palette.js';

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

describe('color palette preference', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    localStorage.clear();
    resetColorPalette();
  });

  it('normalizes six-digit hex values and rejects invalid input', () => {
    expect(normalizeHexColor('A1b2C3')).toBe('#a1b2c3');
    expect(normalizeHexColor('#12345')).toBeNull();
    expect(normalizeHexColor('#12345678')).toBeNull();
  });

  it('persists updates, notifies subscribers, and reloads safely', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeColorPalette(listener);
    expect(setPaletteColor('bullish', '#123ABC')).toBe(true);
    expect(getColorPalette().bullish).toBe('#123abc');
    expect(JSON.parse(localStorage.getItem(COLOR_PALETTE_STORAGE_KEY))).toEqual({
      version: 2,
      colors: { ...DEFAULT_COLOR_PALETTE, bullish: '#123abc' },
    });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ bullish: '#123abc' }), 'bullish');
    unsubscribe();

    localStorage.setItem(COLOR_PALETTE_STORAGE_KEY, JSON.stringify({
      version: 2,
      colors: { bullish: '#abcdef', bearish: 'invalid' },
    }));
    expect(loadColorPalette()).toEqual({
      ...DEFAULT_COLOR_PALETTE,
      bullish: '#abcdef',
    });
  });

  it('migrates the version-1 indicator color into each split overlay color', () => {
    localStorage.setItem(COLOR_PALETTE_STORAGE_KEY, JSON.stringify({
      version: 1,
      colors: {
        bullish: '#010203',
        indicator: '#123ABC',
        drawing: '#040506',
      },
    }));

    expect(loadColorPalette()).toEqual({
      ...DEFAULT_COLOR_PALETTE,
      bullish: '#010203',
      avwap: '#123abc',
      rvwap: '#123abc',
      profile: '#123abc',
      projection: '#123abc',
      drawing: '#040506',
    });
    expect(JSON.parse(localStorage.getItem(COLOR_PALETTE_STORAGE_KEY))).toEqual({
      version: 2,
      colors: {
        ...DEFAULT_COLOR_PALETTE,
        bullish: '#010203',
        avwap: '#123abc',
        rvwap: '#123abc',
        profile: '#123abc',
        projection: '#123abc',
        drawing: '#040506',
      },
    });
  });

  it('falls back on corrupt storage and supports per-color and global reset', () => {
    localStorage.setItem(COLOR_PALETTE_STORAGE_KEY, '{bad json');
    expect(loadColorPalette()).toEqual(DEFAULT_COLOR_PALETTE);
    setPaletteColor('drawing', '#010203');
    resetPaletteColor('drawing');
    expect(getColorPalette().drawing).toBe(DEFAULT_COLOR_PALETTE.drawing);
    setPaletteColor('profile', '#040506');
    resetColorPalette();
    expect(getColorPalette()).toEqual(DEFAULT_COLOR_PALETTE);
    expect(localStorage.getItem(COLOR_PALETTE_STORAGE_KEY)).toBeNull();
  });

  it('derives alpha colors from the selected base hue', () => {
    expect(colorWithAlpha('#123456', 0.5)).toBe('rgba(18,52,86,0.5)');
  });

  it('bulk-applies a palette in one notify pass', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeColorPalette(listener);
    expect(setColorPalette({
      bullish: '#111111',
      bearish: '#222222',
      avwap: 'bad',
    })).toBe(true);
    expect(getColorPalette()).toMatchObject({
      bullish: '#111111',
      bearish: '#222222',
      avwap: DEFAULT_COLOR_PALETTE.avwap,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ bullish: '#111111' }), null);
    unsubscribe();
  });

  it('includes background (main dark fill) and border with shipped defaults', () => {
    expect(DEFAULT_COLOR_PALETTE.background).toBe('#000000');
    expect(DEFAULT_COLOR_PALETTE.border).toBe('#2a2a2a');
    expect(DEFAULT_COLOR_PALETTE.avwap).toBe('#306eb5');
    expect(DEFAULT_COLOR_PALETTE.avwapBand).toBe('#306eb5');
    expect(DEFAULT_COLOR_PALETTE.rvwap).toBe('#306eb5');
    expect(DEFAULT_COLOR_PALETTE.rvwapBand).toBe('#306eb5');
    expect(DEFAULT_COLOR_PALETTE.profile).toBe('#306eb5');
    expect(DEFAULT_COLOR_PALETTE.drawing).toBe('#d8d8d8');
    expect(setPaletteColor('background', '#101820')).toBe(true);
    expect(setPaletteColor('border', '#303840')).toBe(true);
    expect(getColorPalette()).toMatchObject({
      background: '#101820',
      border: '#303840',
    });
  });

  it('supports editable colors for Session VWAP and Liquidation Clusters', () => {
    expect(DEFAULT_COLOR_PALETTE.sessionDaily).toBe('#22cce6');
    expect(DEFAULT_COLOR_PALETTE.sessionWeekly).toBe('#4a9eff');
    expect(DEFAULT_COLOR_PALETTE.sessionMonthly).toBe('#a78bfa');
    expect(DEFAULT_COLOR_PALETTE.liqShort).toBe('#22cce6');
    expect(DEFAULT_COLOR_PALETTE.liqLong).toBe('#ff5050');

    expect(setPaletteColor('sessionDaily', '#ffaa00')).toBe(true);
    expect(setPaletteColor('sessionWeekly', '#00ffaa')).toBe(true);
    expect(setPaletteColor('sessionMonthly', '#aa00ff')).toBe(true);
    expect(setPaletteColor('liqShort', '#00e5ff')).toBe(true);
    expect(setPaletteColor('liqLong', '#ff5252')).toBe(true);

    expect(getColorPalette()).toMatchObject({
      sessionDaily: '#ffaa00',
      sessionWeekly: '#00ffaa',
      sessionMonthly: '#aa00ff',
      liqShort: '#00e5ff',
      liqLong: '#ff5252',
    });

    resetPaletteColor('sessionDaily');
    expect(getColorPalette().sessionDaily).toBe(DEFAULT_COLOR_PALETTE.sessionDaily);
  });
});
