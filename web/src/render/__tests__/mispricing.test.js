/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

function mockState({ rows, mids = {} }) {
  vi.doMock('../../state/store.js', () => ({
    AppState: {
      market: { stockMispricing: rows, allMids: mids },
      ui: { hideValues: false },
    },
  }));
}

describe('close-based mispricing rendering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = '<div id="mispricingList"></div>';
  });

  it('recomputes from the live midpoint and shows close-to-current tooltip data', async () => {
    mockState({
      rows: [{
        coin: 'xyz:AVGO',
        dex: 'xyz',
        exchange: 'NASDAQ',
        sessionState: 'overnight',
        markPx: 102,
        closePx: 100,
        deviationPct: 2,
      }],
      mids: { 'xyz:AVGO': '110' },
    });

    const { renderMispricing } = await import('../mispricing.js');
    renderMispricing();
    const list = document.getElementById('mispricingList');
    const row = list.querySelector('.book-row');
    expect(list.textContent).toContain('+10.00%');
    // Hover detail is set on the stable row node (DOM-ladder style), not
    // rewritten via innerHTML, so browser title tooltips survive live mid ticks.
    expect(row.title).toContain('session close 100');
    expect(row.title).toContain('current HL 110');
    expect(row.title).not.toContain('oracle');
  });

  it('keeps the same row node across live mid updates so hover title stays attached', async () => {
    mockState({
      rows: [{ coin: 'xyz:AVGO', dex: 'xyz', exchange: 'NASDAQ', sessionState: 'overnight', markPx: 102, closePx: 100 }],
      mids: { 'xyz:AVGO': '110' },
    });
    const { AppState } = await import('../../state/store.js');
    const { renderMispricing } = await import('../mispricing.js');
    renderMispricing();
    const list = document.getElementById('mispricingList');
    const first = list.querySelector('.book-row');
    expect(first.title).toContain('current HL 110');

    AppState.market.allMids = { 'xyz:AVGO': '112' };
    renderMispricing();
    const second = list.querySelector('.book-row');
    expect(second).toBe(first);
    expect(second.title).toContain('current HL 112');
    expect(list.textContent).toContain('+12.00%');
  });

  it('falls back to the backend mark when a live midpoint is unavailable', async () => {
    mockState({
      rows: [{ coin: 'xyz:NVDA', markPx: 103, closePx: 100, deviationPct: 3 }],
    });
    const { buildMispricingRows } = await import('../mispricing.js');
    expect(buildMispricingRows([{
      coin: 'xyz:NVDA', markPx: 103, closePx: 100, deviationPct: 99,
    }], {})).toEqual([
      expect.objectContaining({ currentPx: 103, dev: 3 }),
    ]);
  });

  it('applies live one-percent threshold crossings in both directions', async () => {
    mockState({ rows: [] });
    const { buildMispricingRows } = await import('../mispricing.js');
    const snapshot = [{ coin: 'xyz:NVDA', markPx: 100.5, closePx: 100 }];

    expect(buildMispricingRows(snapshot, { 'xyz:NVDA': '101.01' })).toHaveLength(1);
    expect(buildMispricingRows(snapshot, { 'xyz:NVDA': '100.99' })).toHaveLength(0);
    expect(buildMispricingRows(snapshot, { 'xyz:NVDA': '98.99' })).toHaveLength(1);
  });

  it('sorts by the absolute live deviation', async () => {
    mockState({ rows: [] });
    const { buildMispricingRows } = await import('../mispricing.js');
    const rows = buildMispricingRows([
      { coin: 'xyz:AAPL', markPx: 100, closePx: 100 },
      { coin: 'xyz:NVDA', markPx: 100, closePx: 100 },
      { coin: 'xyz:AVGO', markPx: 100, closePx: 100 },
    ], {
      'xyz:AAPL': '102',
      'xyz:NVDA': '95',
      'xyz:AVGO': '103',
    });
    expect(rows.map((row) => row.coin)).toEqual(['xyz:NVDA', 'xyz:AVGO', 'xyz:AAPL']);
  });

  it('batches repeated live-mid rerenders into one animation frame', async () => {
    mockState({
      rows: [{ coin: 'xyz:NVDA', markPx: 102, closePx: 100 }],
      mids: { 'xyz:NVDA': '103' },
    });
    const callbacks = [];
    const requestAnimationFrame = vi.fn((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);

    const { scheduleMispricingRender } = await import('../mispricing.js');
    scheduleMispricingRender();
    scheduleMispricingRender();
    scheduleMispricingRender();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    callbacks.shift()();
    expect(document.getElementById('mispricingList').textContent).toContain('+3.00%');
    scheduleMispricingRender();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  });
});
