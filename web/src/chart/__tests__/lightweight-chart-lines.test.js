import { describe, expect, it, vi } from 'vitest';

import { createPriceLineController } from '../lightweight-chart-lines.js';

function createFakeSeries(name) {
  let lineId = 0;
  return {
    name,
    createPriceLine: vi.fn(() => ({ id: `${name}-line-${++lineId}` })),
    removePriceLine: vi.fn(),
  };
}

const lineStyle = {
  Solid: 0,
  Dotted: 1,
  Dashed: 2,
};

describe('lightweight chart line series ownership', () => {
  it('removes stale order lines from the series that created them after a pair switch', () => {
    const firstSeries = createFakeSeries('first');
    const secondSeries = createFakeSeries('second');
    let currentSeries = firstSeries;
    const controller = createPriceLineController(() => currentSeries, lineStyle);

    controller.syncOrderLines([{ oid: 1, price: 100, side: 'B' }]);

    const firstLine = firstSeries.createPriceLine.mock.results[0]?.value;
    currentSeries = secondSeries;
    controller.syncOrderLines([]);

    expect(firstSeries.removePriceLine).toHaveBeenCalledWith(firstLine);
    expect(secondSeries.removePriceLine).not.toHaveBeenCalled();
    expect(controller.getDebugState()).toEqual(
      expect.objectContaining({ orderLineCount: 0 })
    );
  });

  it('replaces stale position lines through the original series before recreating them on the next series', () => {
    const firstSeries = createFakeSeries('first');
    const secondSeries = createFakeSeries('second');
    let currentSeries = firstSeries;
    const controller = createPriceLineController(() => currentSeries, lineStyle);

    controller.syncPositionLines([{ side: 'long', price: 100 }], []);

    const firstLine = firstSeries.createPriceLine.mock.results[0]?.value;
    currentSeries = secondSeries;
    controller.syncPositionLines([{ side: 'long', price: 200 }], []);

    expect(firstSeries.removePriceLine).toHaveBeenCalledWith(firstLine);
    expect(secondSeries.createPriceLine).toHaveBeenCalledTimes(1);
    expect(controller.getDebugState()).toEqual(
      expect.objectContaining({ positionLineCount: 1 })
    );
  });

  it('keeps duplicate fallback-key order lines instead of collapsing them', () => {
    const series = createFakeSeries('orders');
    const controller = createPriceLineController(() => series, lineStyle);

    controller.syncOrderLines([
      { price: 100, side: 'B' },
      { price: 100, side: 'B' },
    ]);

    expect(series.createPriceLine).toHaveBeenCalledTimes(2);
    expect(controller.getDebugState()).toEqual(
      expect.objectContaining({ orderLineCount: 2 })
    );

    controller.syncOrderLines([
      { price: 100, side: 'B' },
    ]);

    expect(series.removePriceLine).toHaveBeenCalledTimes(1);
    expect(controller.getDebugState()).toEqual(
      expect.objectContaining({ orderLineCount: 1 })
    );
  });

  it('keeps multiple same-side position and liquidation lines instead of merging them by side', () => {
    const series = createFakeSeries('positions');
    const controller = createPriceLineController(() => series, lineStyle);

    controller.syncPositionLines(
      [
        { side: 'long', price: 100 },
        { side: 'long', price: 101 },
      ],
      [
        { side: 'short', price: 90 },
        { side: 'short', price: 90 },
      ]
    );

    expect(series.createPriceLine).toHaveBeenCalledTimes(4);
    expect(controller.getDebugState()).toEqual(
      expect.objectContaining({
        positionLineCount: 2,
        liquidationLineCount: 2,
      })
    );
  });

  it('renders tp/sl order lines with trigger styling and labels', () => {
    const series = createFakeSeries('tpsl');
    const controller = createPriceLineController(() => series, lineStyle);

    controller.syncOrderLines([
      { oid: 1, price: 101500, side: 'A', tpsl: 'tp', reduceOnly: true },
      { oid: 2, price: 98500, side: 'B', tpsl: 'sl', reduceOnly: true },
    ]);

    expect(series.createPriceLine).toHaveBeenCalledTimes(2);
    expect(series.createPriceLine).toHaveBeenNthCalledWith(1, expect.objectContaining({
      price: 101500,
      lineWidth: 2,
      lineStyle: lineStyle.Dotted,
      axisLabelVisible: true,
      title: 'TP',
    }));
    expect(series.createPriceLine).toHaveBeenNthCalledWith(2, expect.objectContaining({
      price: 98500,
      lineWidth: 2,
      lineStyle: lineStyle.Dotted,
      axisLabelVisible: true,
      title: 'SL',
    }));
  });

  it('renders jev signal entry, tp, and sl lines and clears them on HOLD', () => {
    const series = createFakeSeries('jev');
    const controller = createPriceLineController(() => series, lineStyle);

    controller.syncJevSignalLines({
      action: 'BUY',
      entryPrice: 86500,
      takeProfitPrice: 88200,
      stopLossPrice: 85600,
      takeProfitPct: 2.0,
      stopLossPct: 1.0,
    });

    expect(series.createPriceLine).toHaveBeenCalledTimes(3);
    expect(controller.getDebugState().jevLineCount).toBe(3);

    // Clear on HOLD
    controller.syncJevSignalLines({ action: 'HOLD' });
    expect(series.removePriceLine).toHaveBeenCalledTimes(3);
    expect(controller.getDebugState().jevLineCount).toBe(0);
  });
});
