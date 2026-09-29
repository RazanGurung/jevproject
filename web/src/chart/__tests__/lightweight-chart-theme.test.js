/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('lightweight chart theme', () => {
  it('enables stable time-scale edge behavior for lightweight charts', async () => {
    document.body.className = '';
    const {
      buildThemeOptions,
      calculateChartConflationFactor,
    } = await import('../lightweight-chart-theme.js');

    const theme = buildThemeOptions({
      colorType: { Solid: 'solid' },
      crosshairMode: { Normal: 0 },
    });

    expect(theme.chart.autoSize).toBe(true);
    expect(theme.chart.layout.attributionLogo).toBe(false);
    expect(theme.chart.timeScale).toEqual(
      expect.objectContaining({
        rightOffset: 5,
        // fixLeftEdge stays off so panning back streams in history smoothly
        // instead of hitting a wall at the oldest loaded bar.
        fixLeftEdge: false,
        fixRightEdge: false,
        rightBarStaysOnScroll: true,
        lockVisibleTimeRangeOnResize: true,
        minBarSpacing: 0.5,
        barSpacing: 8,
        maxBarSpacing: 25,
        enableConflation: true,
        conflationThresholdFactor: 1,
        precomputeConflationOnInit: false,
      })
    );
    expect(theme.chart.handleScroll).toEqual(
      expect.objectContaining({
        horzTouchDrag: true,
        vertTouchDrag: true,
      })
    );
    expect(theme.chart.handleScale).toEqual(
      expect.objectContaining({
        pinch: true,
      })
    );
    expect(calculateChartConflationFactor(1, 1)).toBe(1);
    expect(calculateChartConflationFactor(0.4, 1)).toBe(2);
    expect(calculateChartConflationFactor(0.1, 1)).toBe(8);
    expect(calculateChartConflationFactor(0.1, 2)).toBe(4);
  });

  it('does not reapply navigation options during a palette refresh', async () => {
    document.body.className = '';
    const applyOptions = vi.fn();
    const candleApply = vi.fn();
    const { applyThemeIfNeeded, buildThemeOptions } = await import('../lightweight-chart-theme.js');
    const buildTheme = () => buildThemeOptions({
      colorType: { Solid: 'solid' },
      crosshairMode: { Normal: 0 },
    });

    const result = applyThemeIfNeeded({
      chart: { applyOptions },
      candleSeries: { applyOptions: candleApply },
      lastThemeKey: 'stale-key',
      buildTheme,
    });

    expect(result.changed).toBe(true);
    expect(applyOptions).toHaveBeenCalledTimes(1);
    const applied = applyOptions.mock.calls[0][0];
    expect(applied).not.toHaveProperty('timeScale');
    expect(applied).not.toHaveProperty('handleScroll');
    expect(applied).not.toHaveProperty('handleScale');
    expect(applied.layout).toEqual(expect.objectContaining({ attributionLogo: false }));
    expect(candleApply).toHaveBeenCalledTimes(1);
  });
});
