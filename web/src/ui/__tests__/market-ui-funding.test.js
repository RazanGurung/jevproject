/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

describe('updateExchangeHtml funding chrome', () => {
  beforeEach(async () => {
    document.body.innerHTML = '<span id="fundingVal">—</span><span id="oiVal"></span>';
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.market.assetSnapshots = { BTC: { funding: 0.0125 } };
  });

  it('paints funding from the 24h-changes snapshot when history is absent', async () => {
    const { updateExchangeHtml } = await import('../market-ui.js');
    updateExchangeHtml('BTC', null, null, null);
    expect(document.getElementById('fundingVal').textContent).toBe('0.0125% / 8h');
  });
});
