/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('render scheduler', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<button class="bottom-tab active" data-tab="trades"></button>';
  });

  it('re-renders the active trades tab during batched flushes', async () => {
    const renderTrades = vi.fn();

    vi.doMock('../trades.js', () => ({
      renderTrades,
    }));
    vi.doMock('../positions.js', () => ({
      renderPositions: vi.fn(),
      renderPositionsIncremental: vi.fn(),
    }));
    vi.doMock('../orders.js', () => ({
      renderOpenOrders: vi.fn(),
      renderOpenOrdersIncremental: vi.fn(),
    }));
    vi.doMock('../fills.js', () => ({
      renderFills: vi.fn(),
    }));
    vi.doMock('../funding.js', () => ({
      renderFundingTable: vi.fn(),
    }));
    vi.doMock('../ui-state.js', () => ({
      updateTabCounts: vi.fn(),
    }));
    const scheduleSignalRadarRender = vi.fn();
    vi.doMock('../../ui/signal-radar.js', () => ({
      scheduleSignalRadarRender,
    }));
    vi.doMock('../../chart/chart-render.js', () => ({
      scheduleChartRender: vi.fn(),
    }));
    vi.doMock('../../chart/chart-levels.js', () => ({
      updateChartLevelsWithTracking: vi.fn(() => false),
    }));
    vi.doMock('../../state/store.js', () => ({
      AppState: {},
    }));

    const { flushRenderBatch, scheduleRender } = await import('../scheduler.js');
    scheduleRender();
    flushRenderBatch();

    expect(renderTrades).toHaveBeenCalledOnce();
    expect(scheduleSignalRadarRender).toHaveBeenCalledOnce();
  });

  it('coalesces repeated scheduleRender calls into a single animation-frame flush', async () => {
    const requestAnimationFrameSpy = vi.fn((cb) => {
      return setTimeout(cb, 0);
    });
    globalThis.requestAnimationFrame = requestAnimationFrameSpy;

    vi.doMock('../trades.js', () => ({
      renderTrades: vi.fn(),
    }));
    vi.doMock('../positions.js', () => ({
      renderPositions: vi.fn(),
      renderPositionsIncremental: vi.fn(),
    }));
    vi.doMock('../orders.js', () => ({
      renderOpenOrders: vi.fn(),
      renderOpenOrdersIncremental: vi.fn(),
    }));
    vi.doMock('../fills.js', () => ({
      renderFills: vi.fn(),
    }));
    vi.doMock('../funding.js', () => ({
      renderFundingTable: vi.fn(),
    }));
    vi.doMock('../ui-state.js', () => ({
      updateTabCounts: vi.fn(),
    }));
    vi.doMock('../../ui/signal-radar.js', () => ({
      scheduleSignalRadarRender: vi.fn(),
    }));
    vi.doMock('../../chart/chart-render.js', () => ({
      scheduleChartRender: vi.fn(),
    }));
    vi.doMock('../../chart/chart-levels.js', () => ({
      updateChartLevelsWithTracking: vi.fn(() => false),
    }));
    vi.doMock('../../state/store.js', () => ({
      AppState: {},
    }));

    const { scheduleRender } = await import('../scheduler.js');
    scheduleRender();
    scheduleRender();
    scheduleRender();

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
  });
});
