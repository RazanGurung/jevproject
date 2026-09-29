/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('bot lifecycle backend bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    document.body.innerHTML = `
      <div id="botLogConsole"></div>
      <button id="botToggleBtn"></button>
      <div id="botOrdersDisplay"></div>
      <div id="botRuntimeStatus"></div>
      <div id="botLinkStatus"></div>
      <select id="botStrategy">
        <option value="rvwap-short-bollinger" selected>RVWAP Short</option>
      </select>
      <input id="botNumOrders" value="8" />
      <input id="botOrderSize" value="15" />
      <input id="bidSkew" value="1" />
      <input id="askSkew" value="1" />
      <input id="bulkOrders" value="8" />
      <input id="bulkSize" value="15" />
      <input id="bulkBidSkew" value="1" />
      <input id="bulkAskSkew" value="1" />
      <span id="bidSkewValue"></span>
      <span id="askSkewValue"></span>
      <span id="bulkBidSkewValue"></span>
      <span id="bulkAskSkewValue"></span>
      <span id="seqTotal"></span>
      <span id="bulkTotalDisplay"></span>
      <div id="seqSection"></div>
      <div id="bulkSection" style="display:none"></div>
      <button id="modeSeq"></button>
      <button id="modeBulk"></button>
      <input type="radio" name="botMode" value="sequential" checked />
      <input type="radio" name="botMode" value="bulk" />
    `;

    window.__PEZ_CONFIG__ = { apiBaseUrl: '' };
    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/api/bot/status') {
        return {
          ok: true,
          text: async () => JSON.stringify({ running: false, logs: [] }),
        };
      }
      if (url === '/api/bot/start') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            running: true,
            strategy: 'rvwap-short-bollinger',
            coin: 'BTC',
            orderIds: [11, 12],
            logs: [{ seq: 1, type: 'success', message: 'started' }],
          }),
        };
      }
      if (url === '/api/bot/stop') {
        return {
          ok: true,
          text: async () => JSON.stringify({ status: 'ok' }),
        };
      }
      throw new Error(`unexpected fetch ${url} ${(options && options.method) || 'GET'}`);
    });
  });

  it('starts and stops through backend endpoints', async () => {
    // Import store + bot together after resetModules so they share one instance.
    const { AppState } = await import('../../state/store.js');
    const { initBotUI } = await import('../../services/bot.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 50000;
    AppState.account.state = {
      marginSummary: { accountValue: '1000', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '1000', totalMarginUsed: '0' },
      riskSummary: { availableMargin: '1000' },
    };
    AppState.account.exchangeLeverageByCoin = { BTC: 5 };
    AppState.account.privateKey = 'key';

    initBotUI();

    await window.botStart();

    expect(window.BOT.running).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/bot/start',
      expect.objectContaining({ method: 'POST' }),
    );

    const startCall = global.fetch.mock.calls.find(([url]) => url === '/api/bot/start');
    expect(JSON.parse(startCall[1].body)).toEqual({
      strategy: 'rvwap-short-bollinger',
      coin: 'BTC',
      config: {
        ordersPerSide: 8,
        orderSize: 15,
        bidSkew: 1,
        askSkew: 1,
        bulkMode: false,
      },
    });

    expect(document.getElementById('botOrdersDisplay').textContent).toBe('2 live');
    expect(document.getElementById('botRuntimeStatus').textContent).toBe('running on server');

    await window.botStop();

    expect(window.BOT.running).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/bot/stop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not poll bot status without a signing session', async () => {
    vi.useFakeTimers();
    const { AppState } = await import('../../state/store.js');
    const { initBotUI } = await import('../../services/bot.js');
    AppState.account.privateKey = '';
    initBotUI();
    const before = global.fetch.mock.calls.filter(([url]) => url === '/api/bot/status').length;
    await vi.advanceTimersByTimeAsync(9000);
    const after = global.fetch.mock.calls.filter(([url]) => url === '/api/bot/status').length;
    expect(after).toBe(before);
    vi.useRealTimers();
  });
});
