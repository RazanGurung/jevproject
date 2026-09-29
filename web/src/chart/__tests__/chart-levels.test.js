/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('chart level cache clearing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('removes stale per-coin order lines after filled or deleted orders disappear', async () => {
    const { AppState, chartLevelCache, chartLevelHashes } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevels, getCoinLevels } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'BTC';
    setLegacy('accountState', {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });

    setLegacy('openOrders', [
      { oid: 1, coin: 'BTC', side: 'B', limitPx: 100000, sz: 0.01 },
      { oid: 2, coin: 'ETH', side: 'A', limitPx: 3000, sz: 0.5 },
    ]);

    updateChartLevels();

    expect(getCoinLevels('BTC').orders).toHaveLength(1);
    expect(getCoinLevels('ETH').orders).toHaveLength(1);
    expect(chartLevelCache.has('ETH')).toBe(true);

    setLegacy('openOrders', [
      { oid: 1, coin: 'BTC', side: 'B', limitPx: 100000, sz: 0.01 },
    ]);

    updateChartLevels();

    expect(getCoinLevels('ETH').orders).toHaveLength(0);
    expect(chartLevelCache.has('ETH')).toBe(false);
    expect(chartLevelHashes.has('ETH')).toBe(false);
  });

  it('emits the exchange-provided liquidation level for the current coin', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevels, getCoinLevels } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'BTC';
    setLegacy('accountState', {
      assetPositions: [
        {
          position: {
            coin: 'BTC',
            szi: '0.5',
            entryPx: '100000',
            markPx: '101000',
            liquidationPx: '85000',
            positionValue: '50500',
          },
        },
      ],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });
    setLegacy('openOrders', []);

    updateChartLevels();

    expect(getCoinLevels('BTC').liquidations).toHaveLength(1);
    expect(getCoinLevels('BTC').liquidations[0]?.price).toBe(85000);
  });

  it('keeps both bid and ask limit orders as chart lines for the active coin', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevels, getCoinLevels } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'BTC';
    setLegacy('accountState', {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });
    setLegacy('openOrders', [
      { oid: 1, coin: 'BTC', side: 'B', limitPx: 99500, sz: 0.01 },
      { oid: 2, coin: 'BTC', side: 'A', limitPx: 100500, sz: 0.02 },
      { oid: 3, coin: 'ETH', side: 'B', limitPx: 3000, sz: 0.5 },
    ]);

    updateChartLevels();

    expect(getCoinLevels('BTC').orders).toEqual([
      expect.objectContaining({ coin: 'BTC', price: 99500, side: 'B' }),
      expect.objectContaining({ coin: 'BTC', price: 100500, side: 'A' }),
    ]);
  });

  it('includes trigger-based tp/sl orders in chart line levels when limitPx is absent', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevels, getCoinLevels } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'BTC';
    setLegacy('accountState', {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });
    setLegacy('openOrders', [
      { oid: 10, coin: 'BTC', side: 'A', triggerPx: 101500, tpsl: 'tp', reduceOnly: true },
      { oid: 11, coin: 'BTC', side: 'B', triggerPx: 98500, tpsl: 'sl', reduceOnly: true },
    ]);

    updateChartLevels();

    expect(getCoinLevels('BTC').orders).toEqual([
      expect.objectContaining({ price: 101500, side: 'A', tpsl: 'tp', reduceOnly: true }),
      expect.objectContaining({ price: 98500, side: 'B', tpsl: 'sl', reduceOnly: true }),
    ]);
  });

  it('uses triggerPx for tp/sl chart levels when backend sends limitPx zero', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevels, getCoinLevels } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'BTC';
    setLegacy('accountState', {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });
    setLegacy('openOrders', [
      { oid: 10, coin: 'BTC', side: 'A', limitPx: '0', triggerPx: '101500', tpsl: 'tp', reduceOnly: true },
      { oid: 11, coin: 'BTC', side: 'B', limitPx: '0.0', triggerPx: '98500', tpsl: 'sl', reduceOnly: true },
    ]);

    updateChartLevels();

    expect(getCoinLevels('BTC').orders).toEqual([
      expect.objectContaining({ price: 101500, triggerPx: 101500, side: 'A', tpsl: 'tp' }),
      expect.objectContaining({ price: 98500, triggerPx: 98500, side: 'B', tpsl: 'sl' }),
    ]);
  });

  it('renders xyz tp/sl chart lines when Hyperliquid encodes protection through orderType text', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevels, getCoinLevels } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'xyz:CL';
    setLegacy('accountState', {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });
    setLegacy('openOrders', [
      {
        oid: 20,
        coin: 'xyz:CL',
        side: 'A',
        limitPx: '0',
        triggerPx: '118.25',
        orderType: 'Take Profit Market',
        reduceOnly: true,
      },
      {
        oid: 21,
        coin: 'xyz:CL',
        side: 'A',
        limitPx: '0',
        triggerPx: '109.75',
        orderType: 'Stop Market',
        triggerCondition: 'Stop Loss',
        reduceOnly: true,
      },
    ]);

    updateChartLevels();

    expect(getCoinLevels('xyz:CL').orders).toEqual([
      expect.objectContaining({ price: 118.25, triggerPx: 118.25, side: 'A', tpsl: 'tp' }),
      expect.objectContaining({ price: 109.75, triggerPx: 109.75, side: 'A', tpsl: 'sl' }),
    ]);
  });

  it('renders xyz tp/sl chart lines when trigger metadata is nested under orderType', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevels, getCoinLevels } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'xyz:CL';
    setLegacy('accountState', {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });
    setLegacy('openOrders', [
      {
        oid: 22,
        coin: 'xyz:CL',
        side: 'A',
        limitPx: '0',
        orderType: { trigger: { triggerPx: '119.5', tpsl: 'tp' } },
        reduceOnly: true,
      },
      {
        oid: 23,
        coin: 'xyz:CL',
        side: 'A',
        limitPx: '0',
        orderType: { trigger: { triggerPx: '108.5', tpsl: 'sl' } },
        reduceOnly: true,
      },
    ]);

    updateChartLevels();

    expect(getCoinLevels('xyz:CL').orders).toEqual([
      expect.objectContaining({ price: 119.5, triggerPx: 119.5, side: 'A', tpsl: 'tp' }),
      expect.objectContaining({ price: 108.5, triggerPx: 108.5, side: 'A', tpsl: 'sl' }),
    ]);
  });

  it('treats tp/sl style changes at the same price as chart-level changes', async () => {
    const { AppState, chartLevelHashes } = await import('../../state/store.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { updateChartLevelsWithTracking } = await import('../chart-levels.js');

    AppState.trading.currentCoin = 'BTC';
    chartLevelHashes.clear();
    setLegacy('accountState', {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    });
    setLegacy('openOrders', [
      { oid: 10, coin: 'BTC', side: 'A', limitPx: '101500', sz: '0.01' },
    ]);

    expect(updateChartLevelsWithTracking()).toBe(true);
    expect(updateChartLevelsWithTracking()).toBe(false);

    setLegacy('openOrders', [
      { oid: 10, coin: 'BTC', side: 'A', limitPx: '0', triggerPx: '101500', tpsl: 'tp', reduceOnly: true, sz: '0.01' },
    ]);

    expect(updateChartLevelsWithTracking()).toBe(true);
  });
});
