/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket size actions', () => {
  it('calculates preset size from canonical account metrics and leverage', async () => {
    const { resolvePresetSizeUsd } = await import('../ticket-size-actions.js');

    const size = resolvePresetSizeUsd('50%', {
      walletAddress: '0xabc',
      accountState: {},
      spotBalance: 100,
      currentCoin: 'BTC',
      getAccountMetrics: () => ({ available: 400 }),
      getActiveLeverage: () => 5,
    });

    expect(size).toBe(1250);
  });

  it('syncs size input and slider values together', async () => {
    const { applyTicketSizeValue } = await import('../ticket-size-actions.js');
    const sizeInput = { value: '' };
    const sizeSlider = { value: '' };
    const onChange = vi.fn();

    applyTicketSizeValue('680', {
      sizeInput,
      sizeSlider,
      onChange,
    });

    expect(sizeInput.value).toBe('680');
    expect(sizeSlider.value).toBe('680');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
