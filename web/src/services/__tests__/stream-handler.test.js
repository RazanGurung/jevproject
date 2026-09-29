/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('stream handler immediate order pruning', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T13:30:00Z'));

    const { AppState } = await import('../../state/store.js');
    AppState.account.openOrders = [];
    AppState.account.fills = [];
    AppState.account.state = {
      assetPositions: [],
      marginSummary: {},
      crossMarginSummary: {},
      riskSummary: {},
    };
  });

  it('removes terminal order-update oids from open orders immediately', async () => {
    const { setOpenOrders, resetRecentOrderPlacementForTests } = await import('../../state/account-state.js');
    const { handleOrderUpdates } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    setOpenOrders([
      { oid: 101, coin: 'BTC', side: 'B', limitPx: '50000', sz: 0.01 },
      { oid: 202, coin: 'ETH', side: 'A', limitPx: '3000', sz: 0.5 },
    ]);

    const result = handleOrderUpdates({
      orderUpdates: [
        { oid: 101, status: 'filled' },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      type: 'orderUpdates',
      terminalOids: [101],
    }));
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 202, coin: 'ETH' }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('reports order-only webData snapshots as realtime order changes', async () => {
    const { setOpenOrders, resetRecentOrderPlacementForTests } = await import('../../state/account-state.js');
    const { handleWebData2 } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    AppState.account.lastOrderRevision = 0;
    setOpenOrders([]);

    const result = handleWebData2({
      orders: [{ oid: 111, coin: 'BTC', side: 'B', limitPx: '50000', sz: '0.01' }],
      orderRevision: 1,
    });

    expect(result).toEqual(expect.objectContaining({
      type: 'webData2',
      posChanged: false,
      ordChanged: true,
    }));
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 111, coin: 'BTC' }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('does not report stale order revisions as order changes', async () => {
    const { setOpenOrders, resetRecentOrderPlacementForTests } = await import('../../state/account-state.js');
    const { handleWebData2 } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    AppState.account.lastOrderRevision = 2;
    setOpenOrders([{ oid: 222, coin: 'ETH', side: 'A', limitPx: '3000', sz: '0.5' }]);

    const result = handleWebData2({
      orders: [{ oid: 111, coin: 'BTC', side: 'B', limitPx: '50000', sz: '0.01' }],
      orderRevision: 1,
    });

    expect(result).toEqual(expect.objectContaining({
      type: 'webData2',
      ordChanged: false,
    }));
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 222, coin: 'ETH' }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('upserts non-terminal resting order updates immediately', async () => {
    const { setOpenOrders, resetRecentOrderPlacementForTests } = await import('../../state/account-state.js');
    const { handleOrderUpdates } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    setOpenOrders([
      { oid: 202, coin: 'ETH', side: 'A', limitPx: '3000', sz: 0.5 },
    ]);

    const result = handleOrderUpdates({
      orderUpdates: [
        {
          status: 'open',
          order: { oid: 101, coin: 'BTC', side: 'B', limitPx: '50000', sz: '0.01' },
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      type: 'orderUpdates',
      terminalOids: [],
      upsertedOrders: [expect.objectContaining({ oid: 101, coin: 'BTC' })],
    }));
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 202, coin: 'ETH' }),
      expect.objectContaining({ oid: 101, coin: 'BTC', limitPx: 50000 }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('merges polled xyz positions without touching main-dex positions', async () => {
    const { handleXyzPositions } = await import('../stream-handler.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { getAccountState } = await import('../../state/account-state.js');

    setLegacy('accountState', {
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.001', entryPx: '60000', liquidationPx: '20000' } },
        { position: { coin: 'xyz:CL', szi: '0.23', entryPx: '86.7', liquidationPx: '80.1' } },
      ],
      marginSummary: {},
    });

    const result = handleXyzPositions({
      assetPositions: [
        { position: { coin: 'xyz:CL', szi: '0.23', entryPx: '86.7', liquidationPx: '79.4' } },
      ],
    });

    expect(result).toEqual(expect.objectContaining({ type: 'xyzPositions', count: 1 }));
    const positions = getAccountState().assetPositions;
    expect(positions).toEqual([
      expect.objectContaining({ position: expect.objectContaining({ coin: 'BTC', liquidationPx: '20000' }) }),
      expect.objectContaining({ position: expect.objectContaining({ coin: 'xyz:CL', liquidationPx: '79.4' }) }),
    ]);
  });

  it('removes closed xyz positions when the poll reports none', async () => {
    const { handleXyzPositions } = await import('../stream-handler.js');
    const { setLegacy } = await import('../../state/legacy-globals.js');
    const { getAccountState } = await import('../../state/account-state.js');

    setLegacy('accountState', {
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.001', entryPx: '60000', liquidationPx: '20000' } },
        { position: { coin: 'xyz:CL', szi: '0.23', entryPx: '86.7', liquidationPx: '80.1' } },
      ],
      marginSummary: {},
    });

    handleXyzPositions({ assetPositions: [] });

    const positions = getAccountState().assetPositions;
    expect(positions).toEqual([
      expect.objectContaining({ position: expect.objectContaining({ coin: 'BTC' }) }),
    ]);
  });

	it('replaces only the named generic builder-dex position slice', async () => {
		const { handleBuilderPositions } = await import('../stream-handler.js');
		const { setLegacy } = await import('../../state/legacy-globals.js');
		const { getAccountState } = await import('../../state/account-state.js');
		setLegacy('accountState', {
			assetPositions: [
				{ position: { coin: 'BTC', szi: '1' } },
				{ position: { coin: 'xyz:CL', szi: '2' } },
				{ position: { coin: 'vntl:BTC', szi: '3' } },
			],
		});

		const result = handleBuilderPositions({
			dex: 'vntl',
			assetPositions: [{ position: { coin: 'vntl:ETH', szi: '4' } }],
		});

		expect(result).toEqual({ type: 'builderPositions', dex: 'vntl', count: 1 });
		expect(getAccountState().assetPositions.map((row) => row.position.coin)).toEqual([
			'BTC', 'xyz:CL', 'vntl:ETH',
		]);
	});

  it('keeps tp/sl trigger order updates visible when limitPx is zero', async () => {
    const { resetRecentOrderPlacementForTests } = await import('../../state/account-state.js');
    const { handleOrderUpdates } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    const result = handleOrderUpdates({
      statuses: [
        {
          status: 'open',
          resting: {
            oid: 505,
            coin: 'BTC',
            side: 'A',
            limitPx: '0',
            triggerPx: '72000',
            sz: '0.01',
            tpsl: 'tp',
            reduceOnly: true,
          },
        },
      ],
    });

    expect(result.upsertedOrders).toEqual([
      expect.objectContaining({ oid: 505, coin: 'BTC', triggerPx: '72000', tpsl: 'tp' }),
    ]);
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({
        oid: 505,
        coin: 'BTC',
        limitPx: 72000,
        triggerPx: 72000,
        tpsl: 'tp',
        reduceOnly: true,
      }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('keeps open orders on user fills (partial fills are not terminal)', async () => {
    const { setOpenOrders, resetRecentOrderPlacementForTests } = await import('../../state/account-state.js');
    const { handleUserFills } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    setOpenOrders([
      { oid: 303, coin: 'BTC', side: 'B', limitPx: '51000', sz: 0.01 },
      { oid: 404, coin: 'SOL', side: 'A', limitPx: '140', sz: 5 },
    ]);

    const result = await handleUserFills([
      { oid: 303, coin: 'BTC', px: '51000', sz: '0.005', side: 'B', time: 1 },
    ]);

    expect(result).toEqual(expect.objectContaining({
      type: 'userFills',
      filledOids: [303],
    }));
    // A fill carries no terminal status: the partially-filled order must stay
    // visible (and draggable). Full fills are removed by terminal
    // orderUpdates, covered above.
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 303, coin: 'BTC' }),
      expect.objectContaining({ oid: 404, coin: 'SOL' }),
    ]);
    expect(AppState.account.fills).toEqual([
      expect.objectContaining({ oid: 303, coin: 'BTC' }),
    ]);

    resetRecentOrderPlacementForTests();
  });

  it('flags the account\'s own liquidations from the userFills liquidation tag', async () => {
    const { handleUserFills } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    AppState.account.walletAddress = '0xABCdef0000000000000000000000000000000001';
    const myFill = {
      oid: 0, coin: 'BTC', px: '50000', sz: '0.1', side: 'A', time: 10,
      dir: 'Close Long',
      liquidation: { liquidatedUser: '0xabcdef0000000000000000000000000000000001', markPx: '49900', method: 'market' },
    };

    const result = await handleUserFills([myFill]);
    expect(result.ownLiquidations).toHaveLength(1);
    expect(result.ownLiquidations[0]).toBe(myFill);
  });

  it('ignores liquidations of other users and snapshot replays', async () => {
    const { handleUserFills } = await import('../stream-handler.js');
    const { AppState } = await import('../../state/store.js');

    AppState.account.walletAddress = '0xABCdef0000000000000000000000000000000001';
    const liquidatorLeg = {
      coin: 'BTC', px: '50000', sz: '0.1', side: 'B', time: 11,
      liquidation: { liquidatedUser: '0x9999999999999999999999999999999999999999', markPx: '49900', method: 'market' },
    };
    const ownLiqFill = {
      coin: 'BTC', px: '50000', sz: '0.1', side: 'A', time: 12,
      liquidation: { liquidatedUser: '0xabcdef0000000000000000000000000000000001', markPx: '49900', method: 'market' },
    };

    // A liquidator leg in the same batch is not my liquidation.
    const live = await handleUserFills([liquidatorLeg]);
    expect(live.ownLiquidations).toHaveLength(0);

    // My own liquidation, but arriving on a snapshot replay, must not alert.
    const snap = await handleUserFills([ownLiqFill], { isSnapshot: true });
    expect(snap.ownLiquidations).toHaveLength(0);

    // A plain fill with no liquidation tag never counts.
    const plain = await handleUserFills([{ coin: 'BTC', px: '50000', sz: '0.1', side: 'A', time: 13 }]);
    expect(plain.ownLiquidations).toHaveLength(0);
  });

  it('surfaces backend TP/SL protection failures from orderUpdates payloads', async () => {
    const { handleOrderUpdates } = await import('../stream-handler.js');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = handleOrderUpdates({
      protectionError: { coin: 'xyz:GOLD', error: 'exchange unavailable' },
    });

    // A failed async TP/SL attach means a filled position is unprotected;
    // the dispatcher shows this as an error toast, so it must survive the
    // handler instead of being dropped like an unknown payload.
    expect(result.protectionError).toEqual({
      coin: 'xyz:GOLD',
      error: 'exchange unavailable',
    });
    expect(consoleError).toHaveBeenCalled();
  });

  it('reports no protection error for ordinary orderUpdates payloads', async () => {
    const { handleOrderUpdates } = await import('../stream-handler.js');

    const result = handleOrderUpdates({
      orderUpdates: [{ oid: 9, status: 'open', order: { oid: 9, coin: 'BTC' } }],
    });

    expect(result.protectionError).toBeNull();
  });
});
