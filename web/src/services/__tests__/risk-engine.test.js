/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('risk engine', () => {
  beforeEach(async () => {
    vi.resetModules();
    const coinMetaModule = await import('../../state/coin-meta.js');
    window.getMaxLeverage = vi.spyOn(coinMetaModule, 'getMaxLeverage').mockImplementation((coin) => coin === 'BTC' ? 50 : 25);
    window.localStorage.clear();
    const { AppState } = await import('../../state/store.js');
    AppState.account.state = {
      riskSummary: {
        accountValue: '10000',
        availableMargin: '6000',
        withdrawable: '6000',
      },
      assetPositions: [],
    };
    window.accountState = AppState.account.state;
    document.body.innerHTML = '';
  });

  it('caps entries at remaining leveraged buying power for the ticker', async () => {
    const { evaluateOrderRisk } = await import('../risk-engine.js');

    const result = evaluateOrderRisk({
      coin: 'BTC',
      side: 'buy',
      sizeUsd: 400000,
      playbook: 'Pullback',
    });

    expect(result.allowed).toBe(true);
    expect(result.cappedSizeUsd).toBe(300000);
  });

  it('does not double-subtract current exposure from leveraged buying power', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.state.assetPositions = [{
      position: {
        coin: 'ETH',
        szi: '1',
        positionValue: '50000',
      },
    }];
    window.accountState = AppState.account.state;
    const { evaluateOrderRisk } = await import('../risk-engine.js');

    const result = evaluateOrderRisk({
      coin: 'BTC',
      side: 'buy',
      sizeUsd: 300000,
      playbook: 'Pullback',
    });

    expect(result.allowed).toBe(true);
    expect(result.cappedSizeUsd).toBe(300000);
  });

  it('blocks new entries when utilization is locked', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.state.riskSummary.availableMargin = '500';
    AppState.account.state.riskSummary.withdrawable = '500';
    window.accountState = AppState.account.state;

    const { evaluateOrderRisk } = await import('../risk-engine.js');

    const result = evaluateOrderRisk({
      coin: 'BTC',
      side: 'buy',
      sizeUsd: 250,
      playbook: 'Pullback',
    });

    expect(result.allowed).toBe(false);
    expect(result.mode).toBe('locked');
  });

  it('includes configured sizing context in caution messages', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.account.state.riskSummary.availableMargin = '2000';
    AppState.account.state.riskSummary.withdrawable = '2000';
    window.accountState = AppState.account.state;

    const { evaluateOrderRisk } = await import('../risk-engine.js');

    const result = evaluateOrderRisk({
      coin: 'BTC',
      side: 'buy',
      sizeUsd: 1000,
      playbook: 'Breakout',
    });

    expect(result.allowed).toBe(true);
    expect(result.message).toContain('%');
  });
});
