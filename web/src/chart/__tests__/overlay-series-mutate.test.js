import { describe, expect, it, vi } from 'vitest';

import { mutateOverlaySeries } from '../overlay-series-mutate.js';

describe('mutateOverlaySeries', () => {
  it('updates in place without clearing crosshair when the series accepts the point', () => {
    const series = { update: vi.fn(), setData: vi.fn() };
    const clearCrosshairPosition = vi.fn();
    const ok = mutateOverlaySeries(series, { time: 1, value: 2 }, {
      rebuild: () => [{ time: 1, value: 2 }],
      getChart: () => ({ clearCrosshairPosition }),
    });
    expect(ok).toBe(true);
    expect(series.update).toHaveBeenCalledWith({ time: 1, value: 2 });
    expect(series.setData).not.toHaveBeenCalled();
    expect(clearCrosshairPosition).not.toHaveBeenCalled();
  });

  it('clears the crosshair and rebuilds with setData on Value is null', () => {
    const series = {
      update: vi.fn(() => { throw new Error('Value is null'); }),
      setData: vi.fn(),
    };
    const clearCrosshairPosition = vi.fn();
    const setVisibleLogicalRange = vi.fn();
    const getVisibleLogicalRange = vi.fn(() => ({ from: 1, to: 8 }));
    const ok = mutateOverlaySeries(series, { time: 2, value: 3 }, {
      rebuild: () => [{ time: 1, value: 1 }, { time: 2, value: 3 }],
      getChart: () => ({
        clearCrosshairPosition,
        timeScale: () => ({ getVisibleLogicalRange, setVisibleLogicalRange }),
      }),
    });
    expect(ok).toBe(true);
    expect(clearCrosshairPosition).toHaveBeenCalled();
    expect(series.setData).toHaveBeenCalledWith([{ time: 1, value: 1 }, { time: 2, value: 3 }]);
    expect(setVisibleLogicalRange).toHaveBeenCalledWith({ from: 1, to: 8 });
  });
});
