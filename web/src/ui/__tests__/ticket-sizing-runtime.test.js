/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket sizing runtime', () => {
  it('computes preset size and syncs the ticket inputs through one runtime owner', async () => {
    const { createTicketSizingRuntime } = await import('../ticket-sizing-runtime.js');
    document.body.innerHTML = `
      <input id="sizeInput" value="0" />
      <input id="sizeSlider" value="0" />
    `;
    const clearDeployedTicketState = vi.fn();
    const resolvePresetSizeUsd = vi.fn(() => 1250);
    const applyTicketSizeValue = vi.fn();
    const updateSummary = vi.fn();

    const runtime = createTicketSizingRuntime({
      getElementById: (id) => document.getElementById(id),
      clearDeployedTicketState,
      getEffectiveWalletAddress: () => '0xabc',
      getAccountState: () => ({ riskSummary: {} }),
      getSpotBalance: () => 100,
      getEffectiveCurrentCoin: () => 'BTC',
      getAccountMetrics: vi.fn(),
      getActiveLeverage: vi.fn(),
      resolvePresetSizeUsd,
      applyTicketSizeValue,
      updateSummary,
    });

    runtime.setPreset('50%');

    expect(clearDeployedTicketState).toHaveBeenCalledWith({ keepPrice: true, keepTargets: true });
    expect(resolvePresetSizeUsd).toHaveBeenCalledWith('50%', expect.objectContaining({
      walletAddress: '0xabc',
      spotBalance: 100,
      currentCoin: 'BTC',
    }));
    expect(applyTicketSizeValue).toHaveBeenCalledWith('1250', expect.objectContaining({
      sizeInput: document.getElementById('sizeInput'),
      sizeSlider: document.getElementById('sizeSlider'),
      onChange: updateSummary,
    }));
  });

  it('updates scale-total controls and delegates to the shared scale-summary refresh', async () => {
    const { createTicketSizingRuntime } = await import('../ticket-sizing-runtime.js');
    document.body.innerHTML = `
      <input id="scaleTotal" value="0" />
      <input id="scaleTotalSlider" value="0" />
    `;
    const updateScaleSummary = vi.fn();

    const runtime = createTicketSizingRuntime({
      getElementById: (id) => document.getElementById(id),
      updateScaleSummary,
    });

    runtime.setScaleTotal('420');

    expect(document.getElementById('scaleTotal').value).toBe('420');
    expect(document.getElementById('scaleTotalSlider').value).toBe('420');
    expect(updateScaleSummary).toHaveBeenCalledTimes(1);
  });

  it('clears deployed state before applying an explicit playbook choice', async () => {
    const { createTicketSizingRuntime } = await import('../ticket-sizing-runtime.js');
    const clearDeployedTicketState = vi.fn();
    const applyPlaybook = vi.fn();

    const runtime = createTicketSizingRuntime({
      clearDeployedTicketState,
      applyPlaybook,
      getEffectiveCurrentSide: () => 'buy',
    });

    runtime.setPlaybook('Momentum', 'Breakout');

    expect(clearDeployedTicketState).toHaveBeenCalledWith({ skipManualReset: true });
    expect(applyPlaybook).toHaveBeenCalledWith('Breakout', {
      side: 'buy',
    });
  });
});
