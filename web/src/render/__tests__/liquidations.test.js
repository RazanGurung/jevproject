/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('renderLiquidations merged exchange feed', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="liquidationsList"></div>';
  });

  it('shows the merged market-wide feed, tagging own liquidations and backstop', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderLiquidations } = await import('../trades.js');

    AppState.account.walletAddress = '0xMe';
    AppState.market.marketLiquidations = [
      { coin: 'BTC', side: 'A', px: '50000', sz: '0.1', value: 5000, time: 1, user: '0xother', method: 'market' },
      { coin: 'ETH', side: 'B', px: '3000', sz: '1', value: 3000, time: 2, user: '0xMe', method: 'backstop' },
    ];

    renderLiquidations();
    const list = document.getElementById('liquidationsList');
    const text = list.textContent;
    expect(text).toContain('BTC');
    expect(text).toContain('ETH');
    expect(text).toContain('BACK'); // backstop label
    expect(text).toContain('•');    // own-liquidation marker (0xMe === wallet)
    expect(text).not.toContain('LIQ');
    // Match MISPRICE: ticker + badge only (no dedicated time cell).
    const rows = list.querySelectorAll('.book-row');
    expect(rows.length).toBe(2);
    rows.forEach((row) => {
      expect(row.children).toHaveLength(2);
      expect(row.children[1].style.width).toBe('52px');
      expect(row.title).toBeTruthy();
    });
    // Time/detail are hover-only (multi-line title), not a visible third cell.
    expect(rows[0].title).toContain('BTC');
    expect(rows[0].title).toContain('longs liquidated');
    expect(rows[1].title).toContain('ETH');
    expect(rows[1].title).toContain('shorts liquidated');
    expect(rows[1].title).toContain('backstop');
  });

  it('keeps existing row nodes when the list grows so hover title stays attached', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderLiquidations } = await import('../trades.js');

    AppState.market.marketLiquidations = [
      { coin: 'BTC', side: 'A', px: '50000', sz: '0.1', value: 5000, time: 1, method: 'market' },
    ];
    renderLiquidations();
    const list = document.getElementById('liquidationsList');
    const first = list.querySelector('.book-row');
    expect(first.title).toContain('BTC');

    AppState.market.marketLiquidations = [
      { coin: 'ETH', side: 'B', px: '3000', sz: '1', value: 3000, time: 2, method: 'market' },
      { coin: 'BTC', side: 'A', px: '50000', sz: '0.1', value: 5000, time: 1, method: 'market' },
    ];
    renderLiquidations();
    const rows = list.querySelectorAll('.book-row');
    expect(rows).toHaveLength(2);
    // Original node is preserved (still in the pool) while a new sibling is added.
    expect(rows[0]).toBe(first);
    expect(rows[0].title).toContain('ETH');
    expect(rows[1].title).toContain('BTC');
  });

  it('shows xyz tickers with MISPRICE-style display names (no xyz: prefix)', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderLiquidations } = await import('../trades.js');

    AppState.market.marketLiquidations = [
      { coin: 'xyz:SP500', side: 'A', px: '6000', sz: '1', value: 6000, time: 1, method: 'market' },
      { coin: 'xyz:CL', side: 'B', px: '80', sz: '10', value: 800, time: 2, method: 'market' },
      { coin: 'xyz:GOLD', side: 'A', px: '2400', sz: '1', value: 2400, time: 3, method: 'market' },
    ];

    renderLiquidations();
    const list = document.getElementById('liquidationsList');
    const text = list.textContent;
    expect(text).toContain('SPX');
    expect(text).toContain('WTI');
    expect(text).toContain('GOLD');
    expect(text).not.toContain('xyz:');

    const rows = list.querySelectorAll('.book-row');
    expect(rows[0].title).toContain('SPX');
    expect(rows[0].title).not.toContain('xyz:');
    expect(rows[1].title).toContain('WTI');
    expect(rows[1].title).not.toContain('xyz:');
    expect(rows[2].title).toContain('GOLD');
    expect(rows[2].title).not.toContain('xyz:');
  });

  it('shows empty state when there are no liquidations', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderLiquidations } = await import('../trades.js');

    AppState.market.marketLiquidations = [];
    renderLiquidations();
    expect(document.getElementById('liquidationsList').innerHTML).toContain('No liquidations');
  });

  it('coalesces liquidation panel paints to one frame', async () => {
    const callbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      callbacks.push(cb);
      return callbacks.length;
    });

    const { AppState } = await import('../../state/store.js');
    const { scheduleLiquidationsRender } = await import('../trades.js');

    AppState.market.marketLiquidations = [
      { coin: 'BTC', side: 'A', px: '50000', sz: '0.1', value: 5000, time: 1 },
    ];

    scheduleLiquidationsRender();
    scheduleLiquidationsRender();
    expect(document.getElementById('liquidationsList').innerHTML).toBe('');

    callbacks.forEach((cb) => cb?.());
    expect(document.getElementById('liquidationsList').innerHTML).toContain('BTC');
    expect(callbacks).toHaveLength(1);
  });
});
