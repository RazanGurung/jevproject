/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('chart preview state', () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = true;
    window.__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__ = true;
    delete window.chartPreviewLevels;
    delete window.scalePreviewLevels;
  });

  it('writes preview levels to the dedicated canonical state', async () => {
    const { setChartPreviewLevels, getChartPreviewLevels } = await import('../chart-preview-state.js');

    const levels = [{ price: 100, isBuy: true, label: 'BUY $100' }];
    setChartPreviewLevels(levels);

    expect(getChartPreviewLevels()).toBe(levels);
  });

  it('keeps canonical preview state authoritative when the dedicated state is absent', async () => {
    const { AppState } = await import('../../state/store.js');
    const { getChartPreviewLevels } = await import('../chart-preview-state.js');

    AppState.ui.chartPreviewLevels = undefined;
    window.scalePreviewLevels = [{ price: 101, isBuy: false, label: 'SELL $100' }];

    expect(getChartPreviewLevels()).toEqual([]);
  });

  it('keeps canonical empty preview state authoritative over stale window mirrors', async () => {
    const { AppState } = await import('../../state/store.js');
    const { getChartPreviewLevels } = await import('../chart-preview-state.js');

    AppState.ui.chartPreviewLevels = [];
    window.chartPreviewLevels = [{ price: 111, isBuy: true, label: 'STALE' }];
    window.scalePreviewLevels = [{ price: 112, isBuy: false, label: 'STALE2' }];

    expect(getChartPreviewLevels()).toEqual([]);
  });

  it('syncs preview lines directly into lightweight charts', async () => {
    document.body.innerHTML = '<div id="uplot-chart"></div>';

    const chartModule = await import('../lightweight-chart.js');
    chartModule.syncLightweightChart({
      candles: [
        { t: 1000, o: '99', h: '101', l: '98', c: '100', v: '10' },
      ],
      timeframe: '1m',
      width: 600,
      height: 300,
      viewStart: 0,
      viewCount: 1,
      forceVisibleRange: true,
    });

    const { setChartPreviewLevels } = await import('../chart-preview-state.js');
    setChartPreviewLevels([{ price: 99, isBuy: true, label: 'BUY $100' }]);

    expect(chartModule.getLightweightChartDebugState()).toEqual(
      expect.objectContaining({
        previewLineCount: 1,
      })
    );
  });
});
