import { describe, expect, it, vi } from 'vitest';
import { createWeekPathProjectionOverlay } from '../week-path-projection-indicator.js';

function makeSeries() {
  return {
    setData: vi.fn(),
    applyOptions: vi.fn(),
  };
}

function makeChart() {
  const series = [];
  return {
    addSeries: vi.fn(() => {
      const item = makeSeries();
      series.push(item);
      return item;
    }),
    removeSeries: vi.fn(),
    _series: series,
  };
}

const LineStyle = { Solid: 0, Dashed: 1, Dotted: 2 };
const LineSeries = {};

describe('week path projection overlay', () => {
  it('stays detached when disabled and publishes disabled status', () => {
    const chart = makeChart();
    const overlay = createWeekPathProjectionOverlay({
      getChart: () => chart,
      LineSeries,
      LineStyle,
    });
    const statuses = [];
    overlay.setOnStatusChange((status) => statuses.push(status));
    overlay.setOptions({ visible: false });
    expect(overlay.getStatus().status).toBe('disabled');
    expect(chart.addSeries).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.status).toBe('disabled');
  });

  it('attaches series when enabled', () => {
    const chart = makeChart();
    const overlay = createWeekPathProjectionOverlay({
      getChart: () => chart,
      LineSeries,
      LineStyle,
    });
    overlay.setOptions({ visible: true, envelopeVisible: true });
    // Empty candles → unavailable, but series attach on setCandles.
    overlay.setCandles([], 'BTC', '2h', 1);
    expect(chart.addSeries).toHaveBeenCalled();
    expect(chart.addSeries.mock.calls.every((call) => typeof call[1].autoscaleInfoProvider === 'function')).toBe(true);
    expect(chart.addSeries.mock.calls[0][1].autoscaleInfoProvider()).toBeNull();
    expect(overlay.getDebugState().enabled).toBe(true);
    overlay.detach();
    expect(chart.removeSeries).toHaveBeenCalled();
  });

  it('recomputes when a mid-series bar is repaired at the same length and tip', () => {
    const chart = makeChart();
    const overlay = createWeekPathProjectionOverlay({
      getChart: () => chart,
      LineSeries,
      LineStyle,
    });
    // Enough synthetic closed rows to attach and run signature logic.
    const start = Math.floor(Date.UTC(2023, 0, 2) / 1000);
    const candles = [];
    let close = 100;
    for (let i = 0; i < 200; i += 1) {
      const open = close;
      close = open * 1.0001;
      candles.push({
        t: start + i * 2 * 3600,
        o: String(open),
        h: String(Math.max(open, close) * 1.001),
        l: String(Math.min(open, close) * 0.999),
        c: String(close),
        v: String(100 + i),
      });
    }
    overlay.setOptions({ visible: true, envelopeVisible: true });
    overlay.setCandles(candles, 'BTC', '2h', 1);
    const firstCount = overlay.getDebugState().computeCount;
    expect(firstCount).toBe(1);

    const repaired = candles.map((row) => ({ ...row }));
    const mid = Math.floor((repaired.length - 1) / 2);
    repaired[mid] = {
      ...repaired[mid],
      c: String(Number(repaired[mid].c) * 1.08),
      h: String(Math.max(Number(repaired[mid].h), Number(repaired[mid].c) * 1.08)),
    };
    overlay.setCandles(repaired, 'BTC', '2h', 1);
    expect(overlay.getDebugState().computeCount).toBe(firstCount + 1);

    overlay.setCandles(repaired, 'BTC', '2h', 1);
    expect(overlay.getDebugState().computeCount).toBe(firstCount + 1);
  });
});
