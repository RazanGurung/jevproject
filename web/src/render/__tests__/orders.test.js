/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('render open orders', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="bottomContent"></div>';
    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0xabc';
    AppState.ui.hideValues = false;
    AppState.account.openOrders = [];
  });

  it('renders trigger tp/sl orders with fallback price and without modify actions', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderOpenOrders } = await import('../orders.js');

    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', side: 'A', sz: '0.01', triggerPx: '101500', tpsl: 'tp' },
      { oid: 2, coin: 'BTC', side: 'B', sz: '0.02', triggerPx: '98500', tpsl: 'sl' },
    ];

    renderOpenOrders();

    const html = document.getElementById('bottomContent')?.innerHTML || '';
    expect(html).toContain('TP');
    expect(html).toContain('SL');
    expect(html).not.toContain('showModifyModal');
    expect(html).toContain('101500');
    expect(html).toContain('98500');
  });

  it('re-renders when an order changes price without changing the row count', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderOpenOrders, renderOpenOrdersIncremental } = await import('../orders.js');

    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', side: 'B', sz: '0.01', limitPx: '100000' },
      { oid: 2, coin: 'BTC', side: 'A', sz: '0.02', limitPx: '101000' },
    ];

    renderOpenOrders();

    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', side: 'B', sz: '0.01', limitPx: '99500' },
      { oid: 2, coin: 'BTC', side: 'A', sz: '0.02', limitPx: '101000' },
    ];

    renderOpenOrdersIncremental();

    const html = document.getElementById('bottomContent')?.innerHTML || '';
    expect(html).toContain('99500');
    expect(html).not.toContain('100000.00');
    const checkbox = document.querySelector('.order-select');
    expect(checkbox?.getAttribute('data-px')).toBe('99500');
  });
});
