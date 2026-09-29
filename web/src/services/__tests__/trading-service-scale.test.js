/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('trading-service-scale', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    document.body.innerHTML = `
      <input id="scaleTotal" value="1000" />
      <input id="scaleOrders" value="2" />
      <input id="scaleHigh" value="71000" />
      <input id="scaleLow" value="69000" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'scale';
    window.currentPrice = 70000;
  });

  it('supports the no-args preview path and synchronizes preview state', async () => {
    const apiModule = await import('../api.js');
    const walletModule = await import('../wallet-service.js');
    const toastModule = await import('../../ui/toast.js');
    const stateModule = await import('../../state/store.js');

    vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      orders: [
        { coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000, reduceOnly: false },
        { coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000, reduceOnly: false },
      ],
    });
    vi.spyOn(walletModule, 'requireKey').mockReturnValue(true);
    const toastSpy = vi.spyOn(toastModule, 'showToast').mockImplementation(() => {});

    const { AppState } = stateModule;
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 70000;

    const { placeScaleOrder } = await import('../trading-service-scale.js');
    await placeScaleOrder();

    expect(apiModule.apiPost).toHaveBeenCalledWith('/api/scale-preview', expect.objectContaining({
      coin: 'BTC',
      isBuy: true,
      totalUsd: 1000,
      numOrders: 2,
      lowPx: 69000,
      highPx: 71000,
      mainnet: true,
    }));
    expect(AppState.ui.scalePreviewOrders).toEqual([
      expect.objectContaining({ coin: 'BTC', limitPx: 69000 }),
      expect.objectContaining({ coin: 'BTC', limitPx: 71000 }),
    ]);
    expect(AppState.ui.chartPreviewLevels).toHaveLength(2);
    expect(document.getElementById('placeBtn').textContent).toBe('SEND SCALE');
    expect(toastSpy).toHaveBeenCalledWith('Preview: 2 orders. Click Place Order to send.', false);
  });

  it('refreshes chart levels and render scheduling immediately after accepted scale sends', async () => {
    document.body.innerHTML = `
      <input id="scaleTotal" value="1000" />
      <input id="scaleOrders" value="2" />
      <input id="scaleHigh" value="71000" />
      <input id="scaleLow" value="69000" />
      <input id="sizeInput" value="" />
      <input id="priceInput" value="" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    const apiModule = await import('../api.js');
    const walletModule = await import('../wallet-service.js');
    const toastModule = await import('../../ui/toast.js');
    const chartLevelsModule = await import('../../chart/chart-levels.js');
    const schedulerModule = await import('../../render/scheduler.js');
    const chartRenderModule = await import('../../chart/chart-render.js');
    const stateModule = await import('../../state/store.js');

    vi.spyOn(apiModule, 'apiPost')
      .mockResolvedValueOnce({
        orders: [
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000, reduceOnly: false },
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000, reduceOnly: false },
        ],
      })
      .mockResolvedValueOnce({
        statuses: [
          { accepted: true, oid: 1 },
          { accepted: true, oid: 2 },
        ],
      });
    vi.spyOn(walletModule, 'requireKey').mockReturnValue(true);
    vi.spyOn(toastModule, 'showToast').mockImplementation(() => {});
    const updateChartLevelsSpy = vi.spyOn(chartLevelsModule, 'updateChartLevels').mockImplementation(() => {});
    const scheduleRenderSpy = vi.spyOn(schedulerModule, 'scheduleRender').mockImplementation(() => {});
    const scheduleChartRenderSpy = vi.spyOn(chartRenderModule, 'scheduleChartRender').mockImplementation(() => {});

    const { AppState, ConnectionState } = stateModule;
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 70000;
    AppState.connection.marketState = ConnectionState.CONNECTED;
    AppState.connection.marketUpstreamConnected = true;
    AppState.connection.marketLastTickAt = Date.now();

    const { placeScaleOrder } = await import('../trading-service-scale.js');
    await placeScaleOrder({
      orderDebounceUntilRef: { value: 0 },
      orderDebounceMs: 0,
    });
    await document.getElementById('placeBtn').onclick();

    expect(updateChartLevelsSpy).toHaveBeenCalled();
    expect(scheduleRenderSpy).toHaveBeenCalled();
    expect(scheduleChartRenderSpy).toHaveBeenCalled();
  });

  it('restores delegated place-order state after clearing a scale preview', async () => {
    const apiModule = await import('../api.js');
    const walletModule = await import('../wallet-service.js');

    vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      orders: [
        { coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000, reduceOnly: false },
        { coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000, reduceOnly: false },
      ],
    });
    vi.spyOn(walletModule, 'requireKey').mockReturnValue(true);

    const { placeScaleOrder, clearScalePreview } = await import('../trading-service-scale.js');
    await placeScaleOrder();

    const placeBtn = document.getElementById('placeBtn');
    expect(typeof placeBtn.onclick).toBe('function');

    clearScalePreview();

    expect(placeBtn.onclick).toBeNull();
    expect(placeBtn.getAttribute('data-action')).toBe('placeOrder');
    expect(placeBtn.textContent).toBe('Place Order');
  });
});
