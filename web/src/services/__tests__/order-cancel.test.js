/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const removeOpenOrdersByOids = vi.fn();
const updateChartLevels = vi.fn();
const scheduleChartRender = vi.fn();
const scheduleRender = vi.fn();
const suppressOrderOid = vi.fn();
const apiPost = vi.fn();

vi.mock('../../state/account-state.js', () => ({
  removeOpenOrdersByOids,
}));

vi.mock('../api.js', () => ({
  apiPost,
}));

vi.mock('../../chart/chart-levels.js', () => ({
  updateChartLevels,
}));

vi.mock('../../chart/chart-render.js', () => ({
  scheduleChartRender,
}));

vi.mock('../../render/scheduler.js', () => ({
  scheduleRender,
}));

vi.mock('../../state/store.js', () => ({
  suppressOrderOid,
}));

describe('order-cancel optimistic cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    window.StrategyManager = null;
  });

  it('refreshes chart caches immediately after optimistic bulk cancel removal', async () => {
    const { applyBulkCancelSuccess } = await import('../order-cancel.js');

    applyBulkCancelSuccess([
      { coin: 'BTC', oid: 101 },
      { coin: 'ETH', oid: 202 },
    ]);

    expect(removeOpenOrdersByOids).toHaveBeenCalledWith([101, 202]);
    expect(suppressOrderOid).toHaveBeenCalledTimes(2);
    expect(updateChartLevels).toHaveBeenCalled();
    expect(scheduleRender).toHaveBeenCalled();
    expect(scheduleChartRender).toHaveBeenCalled();
  });

  it('suppresses only confirmed oids when the backend reports a partial cancel', async () => {
    apiPost.mockResolvedValue({ status: 'partial', cancelled: 1, cancelledOids: [101] });

    const { bulkCancelOrders } = await import('../order-cancel.js');
    await bulkCancelOrders({
      privateKey: 'pk',
      cancels: [
        { coin: 'BTC', oid: 101 },
        { coin: 'xyz:SOL', oid: 202 },
      ],
    });

    expect(suppressOrderOid).toHaveBeenCalledTimes(1);
    expect(suppressOrderOid).toHaveBeenCalledWith(101);
    expect(removeOpenOrdersByOids).toHaveBeenCalledWith([101]);
  });

  it('suppresses every requested oid on a full-success cancel', async () => {
    apiPost.mockResolvedValue({ status: 'ok', cancelled: 2, cancelledOids: [101, 202] });

    const { bulkCancelOrders } = await import('../order-cancel.js');
    await bulkCancelOrders({
      privateKey: 'pk',
      cancels: [
        { coin: 'BTC', oid: 101 },
        { coin: 'ETH', oid: 202 },
      ],
    });

    expect(removeOpenOrdersByOids).toHaveBeenCalledWith([101, 202]);
  });
});
