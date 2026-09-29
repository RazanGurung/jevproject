/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('tab resume request budget', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T14:00:00.000Z'));
    document.body.innerHTML = `
      <div id="equityDisplay"></div>
      <div id="spotDisplay"></div>
    `;
    global.fetch = vi.fn((url, options = {}) => {
      const resolvedUrl = String(url);
      const body = options.body ? JSON.parse(options.body) : null;

      if (resolvedUrl.endsWith('/api/account')) {
        return Promise.resolve({
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
      }

      if (resolvedUrl.endsWith('/api/hl') && body?.type === 'metaAndAssetCtxs') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify([
            { universe: [{ name: 'BTC' }] },
            [{ markPx: '100', dayNtlVlm: '1000', openInterest: '10' }],
          ]),
        });
      }

      if (resolvedUrl.endsWith('/api/hl') && body?.type === 'fundingHistory') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify([
            { fundingRate: '0.0001' },
          ]),
        });
      }

      throw new Error(`Unhandled fetch: ${resolvedUrl}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps account and exchange info requests bounded during a 60s focus churn window', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0x123';
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;

    const { fetchAccount } = await import('../account-service.js');
    const { refreshExchangeInfo } = await import('../market-service.js');
    const { createTabResumeRecoverer, TAB_RESUME_MIN_INTERVAL_MS } = await import('../tab-resume.js');

    const baseNow = new Date('2026-04-18T14:00:00.000Z').getTime();
    let now = baseNow + TAB_RESUME_MIN_INTERVAL_MS;
    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => now,
      getWalletAddress: () => AppState.account.walletAddress,
      getAccountStreamSocket: () => ({ readyState: 1 }),
      getSocketClosedState: () => 2,
      getAccountStreamMessageAgeMs: () => 1000,
      fetchAccount,
      refreshExchangeInfo,
      ensureRadarNewsCoverage: () => Promise.resolve(),
      startNewsPolling: vi.fn(),
      requestFrame: (cb) => cb?.(),
      scheduleTimeout: (cb) => {
        cb?.();
        return 1;
      },
    });

    for (; now <= baseNow + 60_000; now += 500) {
      vi.setSystemTime(now);
      recoverAfterTabResume('focus');
      await flushAsyncWork();
    }

    const accountRequests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/account'));
    const hlRequests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/hl'));

    expect(accountRequests).toHaveLength(12);
    expect(hlRequests).toHaveLength(10);
  });
});
