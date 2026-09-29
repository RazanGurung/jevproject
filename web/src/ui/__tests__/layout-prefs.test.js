/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import { AppState } from '../../state/store.js';
import {
  getColWidths,
  initLayoutPrefs,
  setColWidth,
  setMoversCollapsed,
} from '../layout-prefs.js';

describe('layout prefs', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = 'classic-theme pez-v2 pez-ultimate density-pro focus-mode';
    document.body.innerHTML = `
      <button id="moversToggleBtn"></button>
    `;
    AppState.ui.moversCollapsed = false;
    AppState.ui.colWidths = null;
  });

  it('clears legacy density/focus residue on init', () => {
    localStorage.setItem('pez:density', 'pro');
    localStorage.setItem('pez:focusMode', '1');
    initLayoutPrefs();
    expect(document.body.classList.contains('density-pro')).toBe(false);
    expect(document.body.classList.contains('focus-mode')).toBe(false);
    expect(localStorage.getItem('pez:density')).toBe(null);
    expect(localStorage.getItem('pez:focusMode')).toBe(null);
  });

  it('clamps column widths and persists them', () => {
    const widths = setColWidth('news', 9999);
    expect(widths.news).toBeLessThanOrEqual(360);
    expect(getColWidths().news).toBe(widths.news);
    const raw = JSON.parse(localStorage.getItem('pez:colWidths'));
    expect(raw.news).toBe(widths.news);
  });

  it('does not treat the DOM/book column as an editable width', () => {
    localStorage.setItem('pez:colWidths', JSON.stringify({ news: 200, book: 160, order: 300 }));
    document.documentElement.style.setProperty('--col-book', '160px');
    initLayoutPrefs();
    const widths = getColWidths();
    expect(widths).not.toHaveProperty('book');
    expect(widths.news).toBe(200);
    expect(widths.order).toBe(300);
    // Legacy inline book width is cleared so styles.css owns --col-book.
    expect(document.documentElement.style.getPropertyValue('--col-book')).toBe('');
    expect(setColWidth('book', 300)).not.toHaveProperty('book');
  });

  it('toggles movers collapsed chrome', () => {
    setMoversCollapsed(true);
    expect(document.body.classList.contains('movers-collapsed')).toBe(true);
    setMoversCollapsed(false);
    expect(document.body.classList.contains('movers-collapsed')).toBe(false);
  });
});
