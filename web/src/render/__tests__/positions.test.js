/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

function position(coin, szi, entryPx, markPx = entryPx) {
  return {
    position: {
      coin,
      szi: String(szi),
      entryPx: String(entryPx),
      markPx: String(markPx),
      positionValue: String(Math.abs(Number(szi) * Number(markPx))),
      unrealizedPnl: '0',
      marginUsed: '10',
    },
  };
}

describe('positions incremental rendering', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="bottomContent"></div>';
    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0xabc';
    AppState.account.state = { assetPositions: [] };
    AppState.market.allMids = {};
    AppState.ui.hideValues = false;
  });

  it('removes stale rows and action targets when a position closes', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderPositions, renderPositionsIncremental } = await import('../positions.js');

    AppState.account.state = {
      assetPositions: [position('BTC', 0.1, 60000), position('ETH', 1, 3000)],
    };
    renderPositions();

    AppState.account.state = { assetPositions: [position('ETH', 1, 3000, 3010)] };
    renderPositionsIncremental();

    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.coin).toBe('ETH');
    expect(rows[0].querySelector('[data-action="closePosition"]')?.dataset.arg).toBe('ETH');
    expect(document.getElementById('bottomContent')?.textContent).not.toContain('BTC');
  });

  it('rebuilds reordered and size-changed rows before updating values', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderPositions, renderPositionsIncremental } = await import('../positions.js');

    AppState.account.state = {
      assetPositions: [position('BTC', 0.1, 60000), position('ETH', 1, 3000)],
    };
    renderPositions();

    AppState.account.state = {
      assetPositions: [position('ETH', -2, 3100), position('BTC', 0.1, 60000)],
    };
    renderPositionsIncremental();

    const rows = [...document.querySelectorAll('tbody tr')];
    expect(rows.map((row) => row.dataset.coin)).toEqual(['ETH', 'BTC']);
    expect(rows[0].dataset.isbuy).toBe('false');
    expect(rows[0].dataset.size).toBe('-2');
    expect(rows[0].querySelector('[data-action="closePosition"]')?.dataset.arg3).toBe('-2');
    expect(rows[0].querySelector('[data-action="setSL"]')?.dataset.arg2).toBe('false');
  });
});
