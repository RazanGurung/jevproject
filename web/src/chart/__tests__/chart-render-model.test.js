import { describe, expect, it, vi } from 'vitest';

import {
  buildLightweightRenderModel,
  computeFallbackPriceRange,
  getChartRuntime,
} from '../chart-render-model.js';

describe('chart render model', () => {
  it('builds a runtime snapshot from app state', () => {
    const runtime = getChartRuntime({
      appState: {
        trading: {
          currentCoin: 'BTC',
          currentTimeframe: '1m',
          currentPrice: 101,
        },
        ui: {},
        market: {
          candles: [{ t: 1 }],
          allMids: { BTC: 101 },
        },
      },
      scalePreviewLevels: [{ id: 'preview-1' }],
      chartLayers: { layers: true },
    });

    expect(runtime).toEqual(
      expect.objectContaining({
        currentCoin: 'BTC',
        currentTimeframe: '1m',
        currentPrice: 101,
        scalePreviewLevels: [{ id: 'preview-1' }],
        chartLayers: { layers: true },
      })
    );
  });

  it('falls back to level and reference prices when visible candles are absent', () => {
    const range = computeFallbackPriceRange([], [95, 105], 100);

    expect(range.yMax).toBeGreaterThan(105);
    expect(range.yMin).toBeLessThan(95);
    expect(range.yRange).toBeGreaterThan(0);
  });

  it('builds a lightweight render model and returns the next render flags', () => {
    const syncOrderLines = vi.fn();
    const syncPositionLines = vi.fn();
    const syncPreviewLines = vi.fn();
    const syncOrderLabels = vi.fn();
    const syncPositionLabels = vi.fn();
    const syncLivePriceLine = vi.fn();

    const result = buildLightweightRenderModel({
      ctx: { clearRect: vi.fn() },
      width: 800,
      height: 400,
      runtime: {
        currentCoin: 'BTC',
        currentTimeframe: '1m',
        currentPrice: 105,
        candles: [
          { t: 1, o: '99', h: '101', l: '98', c: '100' },
          { t: 2, o: '100', h: '103', l: '99', c: '102' },
        ],
        allMids: { BTC: 105 },
        scalePreviewLevels: [{ id: 'preview-1' }],
      },
      candles: [
        { t: 1, o: '99', h: '101', l: '98', c: '100' },
        { t: 2, o: '100', h: '105', l: '99', c: '105' },
      ],
      chartSession: { id: 'session-1' },
      overlayState: { shouldShowOverlay: false },
      levels: {
        positions: [{ price: 101 }],
        orders: [{ price: 100 }],
        liquidations: [{ price: 95 }],
        levels: [{ price: 104 }],
      },
      chartPad: { top: 10, right: 10, bottom: 10, left: 10 },
      viewStart: 1,
      viewCount: 1,
      needsFitContent: true,
      forceVisibleRangeSync: true,
      syncOrderLines,
      syncPositionLines,
      syncPreviewLines,
      syncOrderLabels,
      syncPositionLabels,
      syncLivePriceLine,
      priceToCoordinate: () => null,
    });

    // syncLightweightChart is the caller's responsibility (buildRenderModel
    // in chart-render.js), not buildLightweightRenderModel's. The price-line
    // / overlay-line sync calls remain owned by this function.
    expect(syncOrderLines).toHaveBeenCalledWith([{ price: 100 }]);
    expect(syncPositionLines).toHaveBeenCalledWith([{ price: 101 }], [{ price: 95 }]);
    expect(syncPreviewLines).toHaveBeenCalledWith([{ id: 'preview-1' }]);
    expect(syncOrderLabels).toHaveBeenCalledWith([{ price: 100 }], 'BTC');
    expect(syncPositionLabels).toHaveBeenCalledWith([{ price: 101 }], 'BTC');
    expect(syncLivePriceLine).toHaveBeenCalledWith(105, 100);
    expect(result.nextNeedsFitContent).toBe(false);
    expect(result.nextForceVisibleRangeSync).toBe(false);
    expect(result.model).toEqual(
      expect.objectContaining({
        W: 800,
        H: 400,
        currentTimeframe: '1m',
        loading: false,
        visible: [{ t: 2, o: '100', h: '105', l: '99', c: '105' }],
      })
    );
  });

});
