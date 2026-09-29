/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('deploy config', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    document.body.innerHTML = `
      <input id="deployFractionBreakout" />
      <input id="deployFractionPullback" />
      <input id="deployFractionFade" />
      <input id="deployFractionHedge" />
      <input id="deployRiskNormal" />
      <input id="deployRiskCaution" />
    `;
  });

  it('updates only the independent ticket sizing controls', async () => {
    const { updateDeploySizingSetting } = await import('../deploy-config.js');

    const settings = updateDeploySizingSetting('playbook', 'Breakout', '40');

    expect(settings.playbooks.Breakout).toBe(0.4);
    expect(document.getElementById('deployFractionBreakout')?.value).toBe('40');
  });

  it('falls back to defaults after reset when storage remove throws', async () => {
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    const { resetDeploySizingSettings } = await import('../deploy-config.js');
    const settings = resetDeploySizingSettings();

    expect(settings.playbooks.Breakout).toBe(0.35);
    expect(settings.riskMultipliers.caution).toBe(0.65);
    expect(document.getElementById('deployFractionBreakout')?.value).toBe('35');
    removeItem.mockRestore();
  });
});
