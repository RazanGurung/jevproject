/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('unified market news feed', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="mainLayout" class="main radar-hidden"></div>
      <button id="marketRadarToggleBtn"></button>
      <div id="marketNewsTitle"></div>
      <div id="signalNewsFeed"></div>
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('automatically replaces the feed when the selected ticker changes', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderSignalRadar } = await import('../signal-radar.js');
    const older = new Date(Date.now() - 60000).toISOString();
    const newer = new Date().toISOString();
    AppState.market.newsConfigured = true;
    AppState.trading.currentCoin = 'BTC';
    AppState.market.newsByCoin = {
      BTC: [{ id: 'btc', headline: 'Bitcoin liquidity expands', sentiment: 0.7, publishedAt: newer, coin: 'BTC' }],
      ETH: [{ id: 'eth', headline: 'Ethereum exploit fears grow', sentiment: -0.8, publishedAt: older, coin: 'ETH' }],
    };

    renderSignalRadar();
    expect(document.querySelector('.signal-tape-headline')?.textContent).toBe('Bitcoin liquidity expands');
    expect(document.querySelector('.signal-tape-sentiment')?.textContent).toBe('BULL');
    expect(document.getElementById('marketNewsTitle')?.textContent).toBe('Market News · BTC');

    AppState.trading.currentCoin = 'ETH';
    renderSignalRadar();

    const headlines = Array.from(document.querySelectorAll('.signal-tape-headline')).map((element) => element.textContent);
    expect(headlines).toEqual(['Ethereum exploit fears grow']);
    expect(document.querySelector('.signal-tape-sentiment')?.textContent).toBe('BEAR');
    expect(document.getElementById('marketNewsTitle')?.textContent).toBe('Market News · ETH');
    expect(document.querySelector('#signalNewsFeed button, #signalNewsFeed select, #signalNewsFeed [data-action]')).toBeNull();
    expect(document.querySelector('.signal-tape-source, .signal-tape-coin, .signal-tape-meta')).toBeNull();
  });

  it('keeps impactful stories beyond 24 hours but removes expired headlines', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderSignalRadar } = await import('../signal-radar.js');
    AppState.market.newsConfigured = true;
    AppState.trading.currentCoin = 'BTC';
    AppState.market.newsByCoin = {
      BTC: [
        { id: 'retained', headline: 'Bitcoin ETF approval reshapes flows', source: 'Archive', publishedAt: new Date(Date.now() - (36 * 60 * 60 * 1000)).toISOString() },
        { id: 'expired', headline: 'Expired Bitcoin story', source: 'Archive', publishedAt: new Date(Date.now() - (73 * 60 * 60 * 1000)).toISOString() },
      ],
    };

    renderSignalRadar();

    const headlines = Array.from(document.querySelectorAll('.signal-tape-headline')).map((element) => element.textContent);
    expect(headlines).toEqual(['Bitcoin ETF approval reshapes flows']);
    expect(document.querySelector('.signal-tape-time')?.textContent).toBe('1d ago');
  });

  it('keeps news hidden by default and labels the top toggle consistently', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderSignalRadar } = await import('../signal-radar.js');
    AppState.ui.marketRadarVisible = false;
    AppState.ui.marketRadarConnected = false;
    AppState.market.newsConfigured = true;

    renderSignalRadar();

    expect(document.getElementById('mainLayout')?.classList.contains('radar-hidden')).toBe(true);
    expect(document.getElementById('marketRadarToggleBtn')?.textContent).toBe('News');
  });
});
