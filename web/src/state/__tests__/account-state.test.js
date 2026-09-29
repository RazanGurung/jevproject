/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('account state getOpenOrderViewModels', () => {
  beforeEach(async () => {
    vi.resetModules();
    global.AppState = {
      account: {
        openOrders: [],
        walletAddress: '0x123',
      },
      trading: {
        currentCoin: 'BTC',
      },
      ui: {
        hideValues: false,
      },
      market: {
        allMids: { BTC: '71000' },
      },
    };
    global.window = { openOrders: [] };
  });

  it('calculates sizeUsd correctly: sz (coin amount) * limitPx = USD', async () => {
    const { getOpenOrderViewModels } = await import('../account-state.js');
    
    const orders = [
      { coin: 'BTC', side: 'B', sz: '0.00015', limitPx: '71000', oid: 1, timestamp: 123 },
    ];
    
    const viewModels = getOpenOrderViewModels(orders);
    
    expect(viewModels).toHaveLength(1);
    expect(viewModels[0].sizeUsd).toBe(10.65);
    expect(viewModels[0].price).toBe(71000);
    expect(viewModels[0].isBuy).toBe(true);
    expect(viewModels[0].sideLabel).toBe('Buy');
  });

  it('handles sell orders correctly', async () => {
    const { getOpenOrderViewModels } = await import('../account-state.js');
    
    const orders = [
      { coin: 'BTC', side: 'A', sz: '0.00015', limitPx: '71000', oid: 1, timestamp: 123 },
    ];
    
    const viewModels = getOpenOrderViewModels(orders);
    
    expect(viewModels[0].isBuy).toBe(false);
    expect(viewModels[0].sideLabel).toBe('Sell');
  });

  it('handles string "buy" and "sell" sides', async () => {
    const { getOpenOrderViewModels } = await import('../account-state.js');
    
    const orders = [
      { coin: 'BTC', side: 'buy', sz: '0.00015', limitPx: '71000', oid: 1, timestamp: 123 },
      { coin: 'BTC', side: 'sell', sz: '0.00015', limitPx: '71000', oid: 2, timestamp: 123 },
    ];
    
    const viewModels = getOpenOrderViewModels(orders);
    
    expect(viewModels[0].isBuy).toBe(true);
    expect(viewModels[0].sideLabel).toBe('Buy');
    expect(viewModels[1].isBuy).toBe(false);
    expect(viewModels[1].sideLabel).toBe('Sell');
  });

  it('normalizes trigger-only tp/sl orders into view models with fallback price and type', async () => {
    const { getOpenOrderViewModels } = await import('../account-state.js');

    const orders = [
      { coin: 'BTC', side: 'A', sz: '0.00015', triggerPx: '72000', oid: 3, tpsl: 'tp', timestamp: 123 },
      { coin: 'BTC', side: 'B', sz: '0.00020', triggerPx: '70000', oid: 4, tpsl: 'sl', timestamp: 124 },
    ];

    const viewModels = getOpenOrderViewModels(orders);

    expect(viewModels).toEqual([
      expect.objectContaining({ price: 70000, type: 'SL', isBuy: true }),
      expect.objectContaining({ price: 72000, type: 'TP', isBuy: false }),
    ]);
  });

  it('prefers triggerPx for tp/sl orders even when backend includes limitPx zero', async () => {
    const { getOpenOrderViewModels } = await import('../account-state.js');

    const orders = [
      { coin: 'BTC', side: 'A', sz: '0.00015', limitPx: '0', triggerPx: '72000', oid: 3, tpsl: 'tp' },
      { coin: 'BTC', side: 'B', sz: '0.00020', limitPx: '0.0', triggerPx: '70000', oid: 4, tpsl: 'sl' },
    ];

    const viewModels = getOpenOrderViewModels(orders);

    expect(viewModels).toEqual([
      expect.objectContaining({ price: 70000, type: 'SL', isBuy: true }),
      expect.objectContaining({ price: 72000, type: 'TP', isBuy: false }),
    ]);
  });

  it('infers tp/sl view models from Hyperliquid trigger orderType fields', async () => {
    const { getOpenOrderViewModels } = await import('../account-state.js');

    const orders = [
      {
        coin: 'xyz:CL',
        side: 'A',
        sz: '2',
        limitPx: '0',
        triggerPx: '118.25',
        orderType: 'Take Profit Market',
        oid: 30,
      },
      {
        coin: 'xyz:CL',
        side: 'A',
        sz: '2',
        limitPx: '0',
        orderType: { trigger: { triggerPx: '109.75', tpsl: 'sl' } },
        oid: 31,
      },
    ];

    const viewModels = getOpenOrderViewModels(orders);

    expect(viewModels).toEqual([
      expect.objectContaining({ price: 118.25, type: 'TP', isBuy: false }),
      expect.objectContaining({ price: 109.75, type: 'SL', isBuy: false }),
    ]);
  });

  it('carries xyz positions across main-dex-only webData2 snapshots', async () => {
    const { normalizeStreamAccountState } = await import('../account-state.js');

    const previousState = {
      assetPositions: [
        { position: { coin: 'xyz:CL', szi: '0.23', entryPx: '86.7', liquidationPx: '80.1' } },
      ],
    };
    // webData2 clearinghouseState is main-dex only — xyz positions are
    // carried forward; their exchange fields refresh via the xyzPositions
    // poll channel.
    const next = normalizeStreamAccountState(
      { clearinghouseState: { assetPositions: [], marginSummary: {} } },
      previousState,
    );

    expect(next.assetPositions).toEqual([
      expect.objectContaining({ position: expect.objectContaining({ coin: 'xyz:CL', liquidationPx: '80.1' }) }),
    ]);
  });

  it('emits liquidation chart levels only from the exchange-provided liquidationPx', async () => {
    const { getChartPositionLevels } = await import('../account-state.js');

    const accountState = {
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.001', entryPx: '60000', markPx: '60500', liquidationPx: '52000', positionValue: '60.5' } },
        { position: { coin: 'ETH', szi: '0.05', entryPx: '3000', markPx: '3010', liquidationPx: null, positionValue: '150' } },
      ],
      positionRisk: [],
    };

    const levels = getChartPositionLevels(accountState, {});
    const liqLevels = levels.filter((level) => level.kind === 'liquidation');
    expect(liqLevels).toEqual([
      expect.objectContaining({ coin: 'BTC', price: 52000 }),
    ]);
  });

  it('classifies HL "Stop Market" trigger orders as SL so chart drag boxes render', async () => {
    const { getOpenOrderViewModels, getChartOrderLevels } = await import('../account-state.js');

    // Real frontendOpenOrders shape: HL stop-loss orderType is "Stop Market"
    // ("stop loss" never appears in the payload).
    const orders = [
      {
        coin: 'BTC',
        side: 'A',
        sz: '0.00019',
        limitPx: '0',
        triggerPx: '58000',
        orderType: 'Stop Market',
        reduceOnly: true,
        isTrigger: true,
        oid: 40,
      },
      {
        coin: 'BTC',
        side: 'A',
        sz: '0.00019',
        limitPx: '0',
        triggerPx: '66000',
        orderType: 'Take Profit Market',
        reduceOnly: true,
        isTrigger: true,
        oid: 41,
      },
    ];

    const viewModels = getOpenOrderViewModels(orders);
    expect(viewModels).toEqual([
      expect.objectContaining({ price: 66000, type: 'TP' }),
      expect.objectContaining({ price: 58000, type: 'SL' }),
    ]);

    // Unclassified triggers are filtered from the chart label overlay, so an
    // empty tpsl here means no draggable box for the stop loss.
    const levels = getChartOrderLevels('BTC', orders);
    expect(levels).toEqual([
      expect.objectContaining({ oid: 40, tpsl: 'sl', triggerPx: 58000, reduceOnly: true }),
      expect.objectContaining({ oid: 41, tpsl: 'tp', triggerPx: 66000, reduceOnly: true }),
    ]);
  });
});

describe('account risk continuity', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('preserves last fresh collateral only for an explicitly incomplete snapshot', async () => {
    const { normalizeRestAccountState } = await import('../account-state.js');
    const previous = {
      riskSummaryFresh: true,
      riskSummary: { accountValue: '13.4', availableMargin: '13.4', withdrawable: '13.4', totalAvailable: '13.4' },
    };
    const next = normalizeRestAccountState({
      riskSummaryFresh: false,
      riskSummary: { accountValue: '13.4', availableMargin: '0', withdrawable: '0', totalAvailable: '0' },
    }, previous);
    expect(next.riskSummary).toEqual(expect.objectContaining({
      availableMargin: '13.4', withdrawable: '13.4', totalAvailable: '13.4',
    }));
  });

  it('applies an authoritative fresh zero immediately', async () => {
    const { normalizeRestAccountState } = await import('../account-state.js');
    const previous = {
      riskSummaryFresh: true,
      riskSummary: { availableMargin: '13.4', withdrawable: '13.4', totalAvailable: '13.4' },
    };
    const next = normalizeRestAccountState({
      riskSummaryFresh: true,
      riskSummary: { availableMargin: '0', withdrawable: '0', totalAvailable: '0' },
    }, previous);
    expect(next.riskSummary).toEqual(expect.objectContaining({
      availableMargin: '0', withdrawable: '0', totalAvailable: '0',
    }));
  });
});

describe('account state order reconciliation', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T20:10:00Z'));

    const { setLegacy } = await import('../legacy-globals.js');
    setLegacy('openOrders', []);
  });

  it('preserves existing orders during the short post-placement empty snapshot window', async () => {
    const { setLegacy } = await import('../legacy-globals.js');
    const {
      markRecentOrderPlacement,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    setLegacy('openOrders', [{ oid: 101, coin: 'BTC', limitPx: '50000' }]);
    markRecentOrderPlacement();

    expect(reconcileIncomingOpenOrders([])).toEqual([{ oid: 101, coin: 'BTC', limitPx: '50000' }]);

    resetRecentOrderPlacementForTests();
  });

  it('accepts an empty snapshot after the placement grace window expires', async () => {
    const { setLegacy } = await import('../legacy-globals.js');
    const { setConnectionState, ConnectionState } = await import('../store.js');
    const {
      markRecentOrderPlacement,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    setLegacy('openOrders', [{ oid: 101, coin: 'BTC', limitPx: '50000' }]);
    setConnectionState(ConnectionState.CONNECTED);
    markRecentOrderPlacement();
    vi.advanceTimersByTime(4500);

    expect(reconcileIncomingOpenOrders([])).toEqual([]);

    resetRecentOrderPlacementForTests();
  });

  it('preserves existing orders while the account stream is not connected', async () => {
    const { setLegacy } = await import('../legacy-globals.js');
    const { setConnectionState, ConnectionState } = await import('../store.js');
    const {
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    setLegacy('openOrders', [{ oid: 202, coin: 'BTC', limitPx: '51000' }]);
    setConnectionState(ConnectionState.RECONNECTING);

    expect(reconcileIncomingOpenOrders([])).toEqual([{ oid: 202, coin: 'BTC', limitPx: '51000' }]);

    setConnectionState(ConnectionState.CONNECTED);
    resetRecentOrderPlacementForTests();
  });

  it('preserves a transient empty snapshot immediately after a non-empty order snapshot', async () => {
    const { setLegacy } = await import('../legacy-globals.js');
    const { setConnectionState, ConnectionState } = await import('../store.js');
    const {
      reconcileIncomingOpenOrders,
      setOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    setConnectionState(ConnectionState.CONNECTED);
    setLegacy('openOrders', [{ oid: 303, coin: 'BTC', limitPx: '52000' }]);
    setOpenOrders([{ oid: 303, coin: 'BTC', limitPx: '52000' }]);

    expect(reconcileIncomingOpenOrders([])).toEqual([{ oid: 303, coin: 'BTC', limitPx: '52000' }]);

    vi.advanceTimersByTime(2500);

    expect(reconcileIncomingOpenOrders([])).toEqual([]);

    resetRecentOrderPlacementForTests();
  });

  it('keeps a locked resting order visible after the placement grace window expires', async () => {
    const { setConnectionState, ConnectionState } = await import('../store.js');
    const {
      markRecentOrderPlacement,
      registerLockedOpenOrder,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    setConnectionState(ConnectionState.CONNECTED);
    markRecentOrderPlacement();
    registerLockedOpenOrder({ oid: 404, coin: 'BTC', side: 'B', limitPx: '53000', sz: 0.01 });

    vi.advanceTimersByTime(4500);

    expect(reconcileIncomingOpenOrders([])).toEqual([
      expect.objectContaining({ oid: 404, coin: 'BTC', limitPx: 53000, side: 'B' }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('keeps a locked trigger-only order visible after registration', async () => {
    const {
      registerLockedOpenOrder,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    registerLockedOpenOrder({ oid: 444, coin: 'BTC', side: 'A', triggerPx: '59000', sz: 0.01, tpsl: 'tp' });

    expect(reconcileIncomingOpenOrders([])).toEqual([
      expect.objectContaining({ oid: 444, coin: 'BTC', limitPx: 59000, triggerPx: 59000, tpsl: 'tp' }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('removes a locked resting order once its oid is explicitly cleared', async () => {
    const {
      registerLockedOpenOrder,
      removeOpenOrdersByOids,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    registerLockedOpenOrder({ oid: 505, coin: 'BTC', side: 'A', limitPx: '54000', sz: 0.01 });
    removeOpenOrdersByOids([505]);

    expect(reconcileIncomingOpenOrders([])).toEqual([]);

    resetRecentOrderPlacementForTests();
  });

  it('does not resurrect a recently removed order from a stale backend snapshot', async () => {
    const {
      setOpenOrders,
      removeOpenOrdersByOids,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    setOpenOrders([{ oid: 606, coin: 'BTC', side: 'B', limitPx: '55000', sz: 0.01 }]);
    removeOpenOrdersByOids([606]);

    expect(reconcileIncomingOpenOrders([
      { oid: 606, coin: 'BTC', side: 'B', limitPx: '55000', sz: 0.01 },
    ], [], { stale: true })).toEqual([]);

    resetRecentOrderPlacementForTests();
  });

  it('does not preserve a recently removed order on an immediate empty snapshot', async () => {
    const { setConnectionState, ConnectionState } = await import('../store.js');
    const {
      setOpenOrders,
      removeOpenOrdersByOids,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    const previousOrders = [{ oid: 909, coin: 'BTC', side: 'B', limitPx: '57000', sz: 0.01 }];
    setConnectionState(ConnectionState.CONNECTED);
    setOpenOrders(previousOrders);
    removeOpenOrdersByOids([909]);

    expect(reconcileIncomingOpenOrders([], previousOrders)).toEqual([]);

    resetRecentOrderPlacementForTests();
  });

  it('allows a removed order oid to disappear from protection after the removal grace window', async () => {
    const {
      setOpenOrders,
      removeOpenOrdersByOids,
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    setOpenOrders([{ oid: 707, coin: 'BTC', side: 'B', limitPx: '56000', sz: 0.01 }]);
    removeOpenOrdersByOids([707]);
    vi.advanceTimersByTime(16000);

    expect(reconcileIncomingOpenOrders([
      { oid: 707, coin: 'BTC', side: 'B', limitPx: '56000', sz: 0.01 },
    ])).toEqual([
      expect.objectContaining({ oid: 707, coin: 'BTC', limitPx: 56000 }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('keeps trigger-only backend orders through reconciliation', async () => {
    const {
      reconcileIncomingOpenOrders,
      resetRecentOrderPlacementForTests,
    } = await import('../account-state.js');

    expect(reconcileIncomingOpenOrders([
      { oid: 808, coin: 'BTC', side: 'A', triggerPx: '57500', sz: 0.01, tpsl: 'tp' },
    ])).toEqual([
      expect.objectContaining({ oid: 808, coin: 'BTC', limitPx: 57500, triggerPx: 57500, tpsl: 'tp' }),
    ]);

    resetRecentOrderPlacementForTests();
  });
});

describe('account state liquidation marker', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('threads the liquidation marker onto fill view models', async () => {
    const { AppState } = await import('../store.js');
    const { setRecentFills, getRecentFillViewModels } = await import('../account-state.js');

    AppState.account.walletAddress = '0xWALLET';
    setRecentFills([
      { coin: 'BTC', px: '50000', sz: '0.1', side: 'A', time: 3, dir: 'Close Long',
        liquidation: { liquidatedUser: '0xwallet', markPx: '49900', method: 'market' } },
      { coin: 'SOL', px: '140', sz: '5', side: 'A', time: 1 },
    ]);

    // normalizeFill threads the liquidation marker onto the fills view model
    // (the Fills panel renders a LIQ badge from it).
    const vms = getRecentFillViewModels();
    expect(vms.find((f) => f.coin === 'BTC')).toEqual(expect.objectContaining({ liq: true, liqMethod: 'market' }));
    expect(vms.find((f) => f.coin === 'SOL')).toEqual(expect.objectContaining({ liq: false }));
  });
});
