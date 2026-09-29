/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../deploy-plan.js', () => ({
  deployTradePlan: vi.fn(),
}));

describe('fill actions', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'SOL';
    AppState.trading.currentPrice = 150;
    AppState.market.allMids = { SOL: '150' };
  });

  it('builds replay deployment in the original side', async () => {
    const { deployTradePlan } = await import('../deploy-plan.js');
    const { deployFillAction } = await import('../fill-actions.js');

    const payload = encodeURIComponent(JSON.stringify({
      coin: 'SOL',
      side: 'B',
      px: 150,
      sz: 2,
    }));

    deployFillAction(payload, 'replay');

    expect(deployTradePlan).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'SOL',
      side: 'buy',
      playbook: 'Pullback',
    }));
  });

  it('builds hedge deployment in the opposite side', async () => {
    const { deployTradePlan } = await import('../deploy-plan.js');
    const { deployFillAction } = await import('../fill-actions.js');

    const payload = encodeURIComponent(JSON.stringify({
      coin: 'SOL',
      side: 'S',
      px: 150,
      sz: 2,
    }));

    deployFillAction(payload, 'hedge');

    expect(deployTradePlan).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'SOL',
      side: 'buy',
      playbook: 'Hedge',
    }));
  });
});
