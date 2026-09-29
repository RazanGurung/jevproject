/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  computeLiquidationClusters,
  createLiquidationClustersOverlay,
  formatNotionalCompact,
} from '../liquidation-clusters.js';

describe('formatNotionalCompact', () => {
  it('formats USD values into compact string labels', () => {
    expect(formatNotionalCompact(0)).toBe('$0');
    expect(formatNotionalCompact(500)).toBe('$500');
    expect(formatNotionalCompact(1500)).toBe('$2k');
    expect(formatNotionalCompact(50000)).toBe('$50k');
    expect(formatNotionalCompact(1200000)).toBe('$1.2M');
  });
});

describe('computeLiquidationClusters', () => {
  it('filters liquidations by coin and clusters nearby prices', () => {
    const liquidations = [
      // BTC long liquidations (forced sells) near 90000
      { coin: 'BTC', side: 'A', px: '90000', sz: '1', time: 1700000000 },
      { coin: 'BTC', side: 'A', px: '90050', sz: '2', time: 1700000100 },
      // BTC short liquidation (forced buy) near 91000
      { coin: 'BTC', side: 'B', px: '91000', sz: '1.5', time: 1700000200 },
      // ETH liquidation (should be ignored when coin is BTC)
      { coin: 'ETH', side: 'A', px: '3000', sz: '10', time: 1700000300 },
    ];

    const clusters = computeLiquidationClusters(liquidations, 'BTC', { clusterThresholdPct: 0.002 });
    expect(clusters).toHaveLength(2);

    const longCluster = clusters.find((c) => c.side === 'long');
    expect(longCluster).toBeTruthy();
    expect(longCluster.count).toBe(2);
    // Total notional: 90000*1 + 90050*2 = 270100
    expect(longCluster.notional).toBe(270100);
    expect(longCluster.price).toBeCloseTo(90033.33, 1);

    const shortCluster = clusters.find((c) => c.side === 'short');
    expect(shortCluster).toBeTruthy();
    expect(shortCluster.count).toBe(1);
    expect(shortCluster.notional).toBe(136500);
  });
});

describe('createLiquidationClustersOverlay', () => {
  it('attaches primitive when visible and draws badges', () => {
    let attachedPrimitive = null;
    const seriesMock = {
      attachPrimitive: vi.fn((p) => { attachedPrimitive = p; }),
      detachPrimitive: vi.fn((p) => { if (attachedPrimitive === p) attachedPrimitive = null; }),
      priceToCoordinate: vi.fn((price) => price),
    };
    const chartMock = {
      timeScale: () => ({
        getVisibleLogicalRange: () => ({ from: 0, to: 100 }),
        logicalToCoordinate: vi.fn((idx) => idx * 10),
      }),
    };

    const overlay = createLiquidationClustersOverlay({
      getChart: () => chartMock,
      getCandleSeries: () => seriesMock,
    });

    const liquidations = [
      { coin: 'BTC', side: 'A', px: '90000', sz: '1', time: 1700000000 },
    ];

    overlay.setOptions({ visible: true });
    overlay.updateLiquidations(liquidations, 'BTC');
    expect(seriesMock.attachPrimitive).toHaveBeenCalledTimes(1);

    const debug = overlay.getDebugState();
    expect(debug.visible).toBe(true);
    expect(debug.clusterCount).toBe(1);

    // Call draw
    const paneView = attachedPrimitive.paneViews()[0];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 60 })),
    };
    const target = {
      useBitmapCoordinateSpace: vi.fn((fn) => fn({ context: ctx, horizontalPixelRatio: 1, verticalPixelRatio: 1 })),
    };
    paneView.renderer().draw(target);
    expect(target.useBitmapCoordinateSpace).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();

    overlay.detach();
    expect(seriesMock.detachPrimitive).toHaveBeenCalled();
  });

  it('reads dynamic colors from color palette and updates on applyTheme', async () => {
    const { getLiquidationColors } = await import('../liquidation-clusters.js');
    const { resetColorPalette, setPaletteColor } = await import('../../services/color-palette.js');

    resetColorPalette();
    expect(getLiquidationColors().short).toBe('#22cce6');
    expect(getLiquidationColors().long).toBe('#ff5050');

    setPaletteColor('liqShort', '#00e5ff');
    setPaletteColor('liqLong', '#ff1744');

    expect(getLiquidationColors().short).toBe('#00e5ff');
    expect(getLiquidationColors().long).toBe('#ff1744');

    resetColorPalette();
  });
});
