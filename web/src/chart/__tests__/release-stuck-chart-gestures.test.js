/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('releaseStuckChartGestures', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="chartWrap"></div>';
  });

  it('unlocks navigation after orphaned drag state and re-locks when a tool is armed', async () => {
    const applyOptions = vi.fn();
    const chart = {
      applyOptions,
      timeScale: () => ({
        coordinateToTime: () => 1,
        timeToCoordinate: () => 1,
        timeToIndex: () => 0,
        logicalToCoordinate: () => 1,
        options: () => ({ barSpacing: 6 }),
        height: () => 20,
      }),
      paneSize: () => ({ height: 200 }),
      priceScale: () => ({ width: () => 40 }),
    };
    const series = {
      attachPrimitive: vi.fn((p) => { p.attached?.({ requestUpdate: vi.fn() }); }),
      detachPrimitive: vi.fn(),
      priceToCoordinate: (p) => Number(p),
      coordinateToPrice: (y) => Number(y),
      applyOptions: vi.fn(),
      setData: vi.fn(),
      update: vi.fn(),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      priceScale: () => ({ setAutoScale: vi.fn(), applyOptions: vi.fn() }),
    };

    vi.doMock('../lightweight-chart-core.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        getChart: () => chart,
        getCandleSeries: () => series,
        ensureChart: () => chart,
        onChartInit: () => {},
        onChartTeardown: () => {},
        onSeriesRecreate: () => {},
      };
    });

    const {
      drawingToolsOverlay,
      manualAnchoredVwapOverlay,
      releaseStuckChartGestures,
    } = await import('../lightweight-chart.js');

    drawingToolsOverlay.setCoin('BTC');
    drawingToolsOverlay.setActiveTool('trendline');
    drawingToolsOverlay.onToolPointerDown(10, 10);
    // Orphaned drag + armed tool: keep locked.
    applyOptions.mockClear();
    expect(releaseStuckChartGestures()).toBe(false);
    expect(applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ handleScroll: false }),
    );

    drawingToolsOverlay.setActiveTool(null);
    applyOptions.mockClear();
    expect(releaseStuckChartGestures()).toBe(true);
    expect(applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        handleScroll: expect.objectContaining({ pressedMouseMove: true }),
      }),
    );

    // AVWAP placement also keeps lock.
    manualAnchoredVwapOverlay.setOptions({ visible: true });
    manualAnchoredVwapOverlay.setPlacementActive(true);
    applyOptions.mockClear();
    expect(releaseStuckChartGestures()).toBe(false);
    expect(applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ handleScroll: false }),
    );
    manualAnchoredVwapOverlay.setPlacementActive(false);
  });
});
