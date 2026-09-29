/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('playbooks', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <select id="playbookSelect">
        <option value="Manual">Manual</option>
        <option value="Breakout">Breakout</option>
        <option value="Pullback" selected>Pullback</option>
        <option value="Fade">Fade</option>
        <option value="Hedge">Hedge</option>
      </select>
      <input id="tpPctInput" />
      <input id="slPctInput" />
      <input id="priceInput" />
      <div id="playbookHint"></div>
    `;
    window.updateSummary = vi.fn();
    window.fetchOrderPreview = vi.fn();
  });

  it('applies breakout defaults into the ticket', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentPrice = 100;
    AppState.market.allMids = { BTC: '100' };

    const { applyPlaybook } = await import('../playbooks.js');
    applyPlaybook('Breakout', { side: 'buy' });

    expect(document.getElementById('playbookSelect').value).toBe('Breakout');
    expect(document.getElementById('tpPctInput').value).toBe('2.8');
    expect(document.getElementById('slPctInput').value).toBe('1.2');
    expect(document.getElementById('priceInput').value).not.toBe('');
    expect(document.getElementById('playbookHint').textContent).toContain('Momentum');
  });

  it('keeps the ticket manual when manual is selected', async () => {
    const { applyPlaybook, getSelectedPlaybook } = await import('../playbooks.js');

    document.getElementById('priceInput').value = '112.5';
    document.getElementById('tpPctInput').value = '3';
    document.getElementById('slPctInput').value = '1';

    applyPlaybook('Manual', { side: 'buy' });

    expect(getSelectedPlaybook()).toBe('Manual');
    expect(document.getElementById('playbookSelect').value).toBe('Manual');
    expect(document.getElementById('priceInput').value).toBe('112.5');
    expect(document.getElementById('tpPctInput').value).toBe('');
    expect(document.getElementById('slPctInput').value).toBe('');
    expect(document.getElementById('playbookHint').textContent).toContain('Plain limit order');
  });
});
