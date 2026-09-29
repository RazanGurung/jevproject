import { describe, expect, it, vi } from 'vitest';
import { applyChartNavigation, chartNavigationOptions } from '../chart-navigation.js';

describe('chart navigation options', () => {
  it('disables with boolean flags and restores full theme-shaped enable objects', () => {
    expect(chartNavigationOptions(false)).toEqual({
      handleScroll: false,
      handleScale: false,
    });
    const enabled = chartNavigationOptions(true);
    expect(enabled.handleScroll).toEqual({
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true,
    });
    expect(enabled.handleScale).toEqual({
      axisPressedMouseMove: true,
      axisDoubleClickReset: true,
      mouseWheel: true,
      pinch: true,
    });
  });

  it('applies options through the chart API', () => {
    const chart = { applyOptions: vi.fn() };
    expect(applyChartNavigation(chart, true)).toBe(true);
    expect(chart.applyOptions).toHaveBeenCalledWith(chartNavigationOptions(true));
    expect(applyChartNavigation(null, true)).toBe(false);
  });
});
