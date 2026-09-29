/** @vitest-environment jsdom */

// FLOW strip in the DOM header (renderOrderFlow, after the FLOW/TRADES panels
// were folded into the unified DOM column). The last-whale readout that used
// to live alongside it was retired — whale prints now mark their price row on
// the DOM ladder instead (see render/__tests__/dom-ladder.test.js).

import { beforeEach, describe, expect, it } from 'vitest';

function headerFixture() {
  document.body.innerHTML = `
    <span id="domFlowBuy"></span>
    <span id="domFlowBar"></span>
    <span id="domFlowSell"></span>
    <span id="domWhaleFlowBuy"></span>
    <span id="domWhaleFlowBar"></span>
    <span id="domWhaleFlowSell"></span>`;
  document.body.classList.remove('classic-theme');
}

describe('DOM header FLOW strip', () => {
  beforeEach(headerFixture);

  it('renders buy/sell totals and a split bar proportioned by buy share', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderOrderFlow } = await import('../trades.js');
    AppState.ui.hideValues = false;
    AppState.trading.currentCoin = 'BTC';
    AppState.market.orderFlow = { buyVol: 75000, sellVol: 25000, sampleCount: 500, sampleCapacity: 500 };
    AppState.market.largeTradeFlow = { buyVol: 30000, sellVol: 10000, sampleCount: 40, sampleCapacity: 500 };
    // Old flow metadata must not decay rolling header values.
    AppState.market.flowMetaCache.set('BTC', {
      asOf: 1, halfLifeMs: 1, whaleFlowThresholdUsd: 100000,
    });

    renderOrderFlow();

    expect(document.getElementById('domFlowBuy').textContent).toBe('$75.0K');
    expect(document.getElementById('domFlowSell').textContent).toBe('$25.0K');
    const flowBackground = document.getElementById('domFlowBar').style.background.replace(/\s/g, '');
    expect(flowBackground).toContain('75.0%');
    expect(flowBackground).toContain('rgba(34,204,230,0.5)');
    expect(document.getElementById('domWhaleFlowBuy').textContent).toBe('$30.0K');
    expect(document.getElementById('domWhaleFlowSell').textContent).toBe('$10.0K');
    const whaleBackground = document.getElementById('domWhaleFlowBar').style.background.replace(/\s/g, '');
    expect(whaleBackground).toContain('75.0%');
    expect(whaleBackground).toContain('rgba(255,80,80,0.5)');
    expect(document.getElementById('domWhaleFlowBar').getAttribute('aria-label')).toContain('Latest 40 prints at least $100.0K');
    expect(document.getElementById('domFlowBar').title).toContain('ALL rolling flow');
    expect(document.getElementById('domFlowBar').title).toContain('500/500 latest valid prints');
    expect(document.getElementById('domWhaleFlowBar').title).toContain('40/500 latest prints ≥ $100.0K');
    expect(document.getElementById('domFlowBar').title).not.toContain('Half-life');
  });

  it('keeps market-wide totals visible under hideValues and shows warming state before the first print', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderOrderFlow } = await import('../trades.js');
    // hideValues protects account dollars and own trade sizes only — the FLOW
    // totals are market-wide volume, so they stay visible.
    AppState.ui.hideValues = true;
    AppState.market.orderFlow = { buyVol: 75000, sellVol: 25000, sampleCount: 25, sampleCapacity: 500 };
    AppState.market.largeTradeFlow = { buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500 };
    renderOrderFlow();
    expect(document.getElementById('domFlowBuy').textContent).toBe('$75.0K');
    expect(document.getElementById('domFlowSell').textContent).toBe('$25.0K');
    expect(document.getElementById('domWhaleFlowBuy').textContent).toBe('$0');
    expect(document.getElementById('domWhaleFlowSell').textContent).toBe('$0');
    expect(document.getElementById('domWhaleFlowBar').title).toContain('0/500 latest prints ≥ $100.0K');
    AppState.ui.hideValues = false;

    AppState.market.orderFlow = { buyVol: 0, sellVol: 0 };
    AppState.market.largeTradeFlow = { buyVol: 0, sellVol: 0 };
    renderOrderFlow();
    expect(document.getElementById('domFlowBuy').textContent).toBe('WARM');
    expect(document.getElementById('domFlowSell').textContent).toBe('0/500');
    expect(document.getElementById('domFlowBar').title).toContain('Warming BTC public flow');
  });
});
