/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('account service', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="equityDisplay"></div>
      <div id="spotDisplay"></div>
    `;
    global.fetch = vi.fn();
  });

  it('retries transient account failures and eventually returns account data', async () => {
    const first = {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'clearinghouseState http 429: null' }),
    };
    const second = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          spotUSDC: '50',
          riskSummary: {
            accountValue: '1000',
            withdrawable: '800',
            availableMargin: '800',
          },
          marginSummary: {
            accountValue: '1000',
            totalMarginUsed: '200',
          },
        },
        orders: [],
      }),
    };

    global.fetch
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';
    AppState.account.state = null;

    const { fetchAccount } = await import('../account-service.js');
    const result = await fetchAccount(true);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      address: '0x123',
      mainnet: true,
      force: true,
    }));
    expect(result?.state?.riskSummary?.accountValue).toBe('1000');
  });

  it('marks background account enrichment requests as non-forced', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          spotUSDC: '50',
          riskSummary: {
            accountValue: '1000',
            withdrawable: '800',
            availableMargin: '800',
          },
          marginSummary: {
            accountValue: '1000',
            totalMarginUsed: '200',
          },
        },
        orders: [],
      }),
    });

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';

    const { fetchAccount } = await import('../account-service.js');
    await fetchAccount(false);

    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      address: '0x123',
      mainnet: true,
      force: false,
    }));
  });

  it('suppresses repeated non-forced account refreshes inside the success cooldown window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T14:00:00.000Z'));

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          spotUSDC: '50',
          riskSummary: {
            accountValue: '1000',
            withdrawable: '800',
            availableMargin: '800',
          },
          marginSummary: {
            accountValue: '1000',
            totalMarginUsed: '200',
          },
        },
        orders: [],
      }),
    });

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';

    const { fetchAccount, ACCOUNT_FETCH_SUCCESS_COOLDOWN_MS } = await import('../account-service.js');
    await fetchAccount(false);
    await fetchAccount(false);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ACCOUNT_FETCH_SUCCESS_COOLDOWN_MS + 1);
    await fetchAccount(false);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('falls back to available balance when account value is temporarily missing', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.state = {
      riskSummary: {
        withdrawable: '97.08',
        totalAvailable: '97.08',
      },
    };

    const { updateBalanceDisplay } = await import('../account-service.js');
    updateBalanceDisplay();

    expect(document.getElementById('equityDisplay')?.textContent).toContain('$97.08');
    expect(document.getElementById('spotDisplay')?.textContent).toContain('$97.08');
  });

  it('renders an authoritative zero available balance instead of resurrecting the last value', async () => {
    const { AppState } = await import('../../state/store.js');

    // First call: populate the last-known cache with a fresh balance
    AppState.account.state = {
      riskSummary: {
        accountValue: '100',
        withdrawable: '97.08',
        totalAvailable: '97.08',
      },
    };

    const { updateBalanceDisplay } = await import('../account-service.js');
    updateBalanceDisplay();

    // Second call: zero is a valid post-trade exchange value.
    AppState.account.state = {
      riskSummary: {
        accountValue: '97.08',
        withdrawable: '0',
        totalAvailable: '0',
      },
    };

    updateBalanceDisplay();

    expect(document.getElementById('equityDisplay')?.textContent).toContain('$97.08');
    expect(document.getElementById('spotDisplay')?.textContent).toContain('$0.00');
  });

  it('does not apply an older REST account snapshot over a newer stream snapshot', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          accountSnapshotAt: 100,
          withdrawable: '80',
          riskSummary: { accountValue: '100', withdrawable: '80', availableMargin: '80' },
        },
        orders: [],
      }),
    });

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';
    AppState.account.state = {
      accountSnapshotAt: 200,
      withdrawable: '0',
      riskSummary: { accountValue: '20', withdrawable: '0', availableMargin: '0' },
    };

    const { fetchAccount } = await import('../account-service.js');
    await fetchAccount(true);

    expect(AppState.account.state.accountSnapshotAt).toBe(200);
    expect(AppState.account.state.riskSummary.availableMargin).toBe('0');
  });

  it('does not clear open orders on a transient empty refresh right after placement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T20:10:00Z'));

    const response = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          spotUSDC: '50',
          riskSummary: {
            accountValue: '1000',
            withdrawable: '800',
            availableMargin: '800',
          },
          marginSummary: {
            accountValue: '1000',
            totalMarginUsed: '200',
          },
        },
        orders: [],
      }),
    };

    global.fetch.mockResolvedValueOnce(response);

    const { AppState } = await import('../../state/store.js');
    const { setOpenOrders, markRecentOrderPlacement, resetRecentOrderPlacementForTests } = await import('../../state/account-state.js');
    AppState.account.walletAddress = '0x123';
    setOpenOrders([{ oid: 777, coin: 'BTC', limitPx: '50000' }]);
    AppState.account.state = null;
    markRecentOrderPlacement();

    const { fetchAccount } = await import('../account-service.js');
    await fetchAccount(true);

    expect(AppState.account.openOrders).toEqual([{ oid: 777, coin: 'BTC', limitPx: '50000' }]);
    resetRecentOrderPlacementForTests();
    vi.useRealTimers();
  });

  it('treats stale order snapshots as stale for canonical order reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T20:10:00Z'));

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          spotUSDC: '50',
          riskSummary: {
            accountValue: '1000',
            withdrawable: '800',
            availableMargin: '800',
          },
          marginSummary: {
            accountValue: '1000',
            totalMarginUsed: '200',
          },
        },
        orders: [],
        ordersStale: true,
      }),
    });

    const { AppState } = await import('../../state/store.js');
    const { setOpenOrders } = await import('../../state/account-state.js');
    AppState.account.walletAddress = '0x123';
    setOpenOrders([{ oid: 808, coin: 'BTC', limitPx: '50000' }]);
    AppState.account.state = null;

    const { fetchAccount } = await import('../account-service.js');
    await fetchAccount(true);

    expect(AppState.account.openOrders).toEqual([{ oid: 808, coin: 'BTC', limitPx: '50000' }]);
    vi.useRealTimers();
  });

  it('writes each ticker to its official max leverage on first sync', async () => {
    const { AppState } = await import('../../state/store.js');
    const posts = [];
    global.fetch.mockImplementation(async (url, opts = {}) => {
      const path = String(url);
      if (path.includes('/api/active-asset-data')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ leverage: 5 }) };
      }
      if (path.includes('/api/set-leverage')) {
        posts.push(JSON.parse(opts.body || '{}'));
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) };
      }
      throw new Error(`unexpected ${path}`);
    });

    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'BTC';
    AppState.account.exchangeLeverageByCoin = {};
    AppState.account.defaultLeverageAppliedByCoin = {};

    const { ensureMaxLeverageDefault } = await import('../account-service.js');
    const leverage = await ensureMaxLeverageDefault('BTC');

    expect(leverage).toBe(40);
    expect(AppState.account.exchangeLeverageByCoin.BTC).toBe(40);
    expect(AppState.account.defaultLeverageAppliedByCoin.BTC).toBe(40);
    expect(posts).toEqual([expect.objectContaining({
      coin: 'BTC',
      leverage: 40,
      isCross: true,
      mainnet: true,
    })]);
  });

  it('does not rewrite leverage once the session default is already max', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'BTC';
    AppState.account.exchangeLeverageByCoin = { BTC: 40 };
    AppState.account.defaultLeverageAppliedByCoin = { BTC: 40 };

    const { ensureMaxLeverageDefault } = await import('../account-service.js');
    const leverage = await ensureMaxLeverageDefault('BTC');

    expect(leverage).toBe(40);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips the write when the exchange is already at max', async () => {
    const { AppState } = await import('../../state/store.js');
    global.fetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/api/active-asset-data')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ leverage: 40 }) };
      }
      throw new Error(`unexpected ${path}`);
    });

    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'BTC';
    AppState.account.exchangeLeverageByCoin = {};
    AppState.account.defaultLeverageAppliedByCoin = {};

    const { ensureMaxLeverageDefault } = await import('../account-service.js');
    const leverage = await ensureMaxLeverageDefault('BTC', true);

    expect(leverage).toBe(40);
    expect(global.fetch.mock.calls.map((call) => String(call[0]))).toEqual(['/api/active-asset-data']);
  });

  it('does not auto-raise leverage under an open position', async () => {
    const { AppState } = await import('../../state/store.js');
    global.fetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('/api/active-asset-data')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ leverage: 5 }) };
      }
      throw new Error(`unexpected ${path}`);
    });

    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'BTC';
    AppState.account.exchangeLeverageByCoin = {};
    AppState.account.defaultLeverageAppliedByCoin = {};
    AppState.account.state = {
      assetPositions: [{ position: { coin: 'BTC', szi: '0.01' } }],
    };

    const { ensureMaxLeverageDefault } = await import('../account-service.js');
    const leverage = await ensureMaxLeverageDefault('BTC');

    expect(leverage).toBe(5);
    expect(AppState.account.exchangeLeverageByCoin.BTC).toBe(5);
    expect(global.fetch.mock.calls.map((call) => String(call[0]))).toEqual(['/api/active-asset-data']);
  });

  it('writes isolated max for HIP-3 coins', async () => {
    const { AppState } = await import('../../state/store.js');
    const posts = [];
    global.fetch.mockImplementation(async (url, opts = {}) => {
      const path = String(url);
      if (path.includes('/api/active-asset-data')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ leverage: 5 }) };
      }
      if (path.includes('/api/set-leverage')) {
        posts.push(JSON.parse(opts.body || '{}'));
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) };
      }
      throw new Error(`unexpected ${path}`);
    });

    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'xyz:GOLD';
    AppState.account.exchangeLeverageByCoin = {};
    AppState.account.defaultLeverageAppliedByCoin = {};

    const { ensureMaxLeverageDefault } = await import('../account-service.js');
    const leverage = await ensureMaxLeverageDefault('xyz:GOLD');

    expect(leverage).toBe(20);
    expect(posts).toEqual([expect.objectContaining({
      coin: 'xyz:GOLD',
      leverage: 20,
      isCross: false,
      mainnet: true,
    })]);
  });

  it('applies backend position snapshots directly into canonical account state', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          spotUSDC: '50',
          assetPositions: [
            {
              position: {
                coin: 'BTC',
                szi: '0.5',
                entryPx: '100000',
                markPx: '101000',
                unrealizedPnl: '500',
                liquidationPx: '85000',
                positionValue: '50500',
              },
            },
          ],
          riskSummary: {
            accountValue: '1000',
            withdrawable: '800',
            availableMargin: '800',
          },
          marginSummary: {
            accountValue: '1000',
            totalMarginUsed: '200',
          },
        },
        orders: [],
      }),
    });

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';
    AppState.account.state = null;

    const { fetchAccount } = await import('../account-service.js');
    const result = await fetchAccount(true);

    expect(result?.state?.assetPositions).toEqual([
      expect.objectContaining({
        position: expect.objectContaining({
          coin: 'BTC',
          szi: '0.5',
          entryPx: '100000',
          markPx: '101000',
        }),
      }),
    ]);
  });

  it('applies backend risk and margin snapshots directly into canonical account state', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        state: {
          spotUSDC: '50',
          withdrawable: '700',
          riskSummary: {
            accountValue: 1000,
            availableMargin: 700,
          },
          marginSummary: {
            accountValue: 1000,
            totalMarginUsed: 300,
          },
          crossMarginSummary: {
            accountValue: 1000,
            totalMarginUsed: 250,
          },
        },
        orders: [],
      }),
    });

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';
    AppState.account.state = null;

    const { fetchAccount } = await import('../account-service.js');
    const result = await fetchAccount(true);

    expect(result?.state?.riskSummary).toEqual(expect.objectContaining({
      accountValue: '1000',
      availableMargin: '700',
      withdrawable: '700',
    }));
    expect(result?.state?.marginSummary).toEqual(expect.objectContaining({
      accountValue: '1000',
      totalMarginUsed: '300',
      availableMargin: '700.00000000',
    }));
    expect(result?.state?.crossMarginSummary).toEqual(expect.objectContaining({
      accountValue: '1000',
      totalMarginUsed: '250',
      availableMargin: '750.00000000',
    }));
  });
});
