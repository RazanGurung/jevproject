/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../state/store.js';
import {
  getMobileView,
  setMobileView,
  syncLayoutDensity,
  VALID_MOBILE_VIEWS,
} from '../layout-density.js';

describe('layout density', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="mainLayout" class="main trading-hidden" data-mobile-view="chart"></div>
      <nav class="mobile-dock">
        <button class="mobile-dock-btn active" data-arg="chart" aria-pressed="true"></button>
        <button class="mobile-dock-btn" data-arg="book" aria-pressed="false"></button>
        <button class="mobile-dock-btn" data-arg="news" aria-pressed="false"></button>
        <button class="mobile-dock-btn" data-arg="trade" aria-pressed="false"></button>
        <button class="mobile-dock-btn" data-arg="account" aria-pressed="false"></button>
      </nav>
    `;
    AppState.ui.tradingPanelVisible = false;
    AppState.ui.marketRadarVisible = true;
    AppState.ui.mobileView = 'chart';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query.includes('767') ? window.innerWidth <= 767 : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it('exposes the mobile dock view set', () => {
    expect([...VALID_MOBILE_VIEWS]).toEqual(
      expect.arrayContaining(['chart', 'book', 'news', 'trade', 'account']),
    );
  });

  it('keeps News and Trade both available (never force layout-dense)', () => {
    AppState.ui.tradingPanelVisible = true;
    AppState.ui.marketRadarVisible = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    syncLayoutDensity();
    expect(document.getElementById('mainLayout').classList.contains('layout-dense')).toBe(false);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    syncLayoutDensity();
    expect(document.getElementById('mainLayout').classList.contains('layout-dense')).toBe(false);
  });

  it('switches mobile dock views and marks the active button', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query.includes('767'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    setMobileView('book');
    expect(getMobileView()).toBe('book');
    expect(document.getElementById('mainLayout').dataset.mobileView).toBe('book');
    const active = document.querySelector('.mobile-dock-btn.active');
    expect(active?.dataset.arg).toBe('book');
  });

  it('rejects unknown mobile views', () => {
    setMobileView('not-a-view');
    expect(getMobileView()).toBe('chart');
  });
});
