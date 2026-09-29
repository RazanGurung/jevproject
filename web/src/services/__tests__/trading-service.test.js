/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateChartLevels = vi.fn();
const scheduleChartRender = vi.fn();
const scheduleRender = vi.fn();

vi.mock('../../chart/chart-levels.js', () => ({
  updateChartLevels,
}));

vi.mock('../../chart/chart-render.js', () => ({
  scheduleChartRender,
}));

vi.mock('../../render/scheduler.js', () => ({
  scheduleRender,
}));

async function mockTradingRuntime({ requireKeyResult = true, tickSize = 0.001, coinDecimals = 3 } = {}) {
  const walletModule = await import('../wallet-service.js');
  const toastModule = await import('../../ui/toast.js');
  const tabsModule = await import('../../ui/tabs.js');
  const coinMetaModule = await import('../../state/coin-meta.js');
  const accountServiceModule = await import('../account-service.js');

  const requireKeySpy = vi.spyOn(walletModule, 'requireKey').mockReturnValue(requireKeyResult);
  const showToastSpy = vi.spyOn(toastModule, 'showToast').mockImplementation(() => {});
  const updateSummarySpy = vi.spyOn(tabsModule, 'updateSummary').mockImplementation(() => {});
  const tickSizeSpy = vi.spyOn(coinMetaModule, 'getTickSize').mockImplementation(() => tickSize);
  const coinDecimalsSpy = vi.spyOn(coinMetaModule, 'getCoinDecimals').mockImplementation(() => coinDecimals);
  vi.spyOn(accountServiceModule, 'debouncedFetchAccount').mockImplementation(() => {});

  const { AppState, ConnectionState } = await import('../../state/store.js');
  AppState.connection.marketState = ConnectionState.CONNECTED;
  AppState.connection.marketUpstreamConnected = true;
  AppState.connection.marketLastTickAt = Date.now();
  AppState.market.lastPriceUpdateAt = {
    ...(AppState.market.lastPriceUpdateAt || {}),
    [AppState.trading.currentCoin || 'BTC']: Date.now(),
  };

  window.requireKey = requireKeySpy;
  window.showToast = showToastSpy;
  window.updateSummary = updateSummarySpy;
  window.getTickSize = tickSizeSpy;
  window.getCoinDecimals = coinDecimalsSpy;

  return {
    requireKeySpy,
    showToastSpy,
    updateSummarySpy,
    tickSizeSpy,
    coinDecimalsSpy,
  };
}

async function readExplicitTicketInput(overrides = {}) {
  const { readOrderTicketInput } = await import('../../ui/ticket-submit-state.js');
  return readOrderTicketInput({
    onSizeUsdChange: window.updateSummary,
    ...overrides,
  });
}

describe('trading service confirmation parsing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('treats accepted canonical result as confirmed placement', async () => {
    const { parseOrderConfirmation } = await import('../trading-service.js');

    const result = parseOrderConfirmation({ accepted: true, oid: 123, latencyMs: 5 });

    expect(result.accepted).toBe(true);
    expect(result.error).toBe('');
  });

  it('locks optimistic open-order size as coin, not USD notional', async () => {
    const { extractAcceptedOrderLocks } = await import('../trading-service-order-api.js');
    const [lock] = extractAcceptedOrderLocks(
      { accepted: true, oid: 99 },
      [{ coin: 'BTC', isBuy: true, sz: 250, szCoin: 0.00384615, limitPx: 65000 }],
    );
    expect(lock.sz).toBeCloseTo(0.00384615);
    expect(lock.sz).not.toBe(250);
  });

  it('keeps exact position size when trigger-price rounding changes notional', async () => {
    const { positionTriggerSizing } = await import('../trading-service.js');

    expect(positionTriggerSizing(0.00016, 63423.96)).toEqual({
      sz: 10.1478336,
      szCoin: 0.00016,
    });
  });

  it('treats canonical result with oid and filled as confirmed', async () => {
    const { parseOrderConfirmation } = await import('../trading-service.js');

    const result = parseOrderConfirmation({
      accepted: true,
      oid: 123,
      filled: { avgPx: '50000', totalSz: '0.01' },
    });

    expect(result.accepted).toBe(true);
    expect(result.filled).toBeTruthy();
    expect(result.error).toBe('');
  });

  it('treats canonical result without accepted as not confirmed', async () => {
    const { parseOrderConfirmation } = await import('../trading-service.js');

    const result = parseOrderConfirmation({ accepted: false, error: 'Order was not confirmed by exchange' });

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('not confirmed');
  });

  it('formats api errors with endpoint and status', async () => {
    const { formatApiError } = await import('../trading-service.js');
    const error = new Error('/api/order 422: invalid order');
    error.url = '/api/order';
    error.status = 422;
    error.rawMessage = 'invalid order';

    expect(formatApiError('Order submit failed', error)).toBe('Order submit failed: /api/order 422 invalid order');
  });

  it('reuses shared optimistic cancel cleanup for single-order cancel', async () => {
    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.openOrders = [
      { oid: 390799739978, coin: 'xyz:SP500', side: 'A', limitPx: 6020, sz: 1 },
      { oid: 2, coin: 'BTC', side: 'B', limitPx: 100000, sz: 0.01 },
    ];

    const apiModule = await import('../api.js');
    vi.spyOn(apiModule, 'apiPost').mockResolvedValue({ status: 'ok' });

    const { cancelOid } = await import('../trading-service.js');
    await cancelOid('xyz:SP500', 390799739978);

    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ oid: 2, coin: 'BTC' }),
    ]);
    expect(updateChartLevels).toHaveBeenCalled();
    expect(scheduleRender).toHaveBeenCalled();
    expect(scheduleChartRender).toHaveBeenCalled();
    expect(window.showToast).toHaveBeenCalledWith('✓ xyz:SP500 order cancelled', false);
  });

  it('removes inline tp/sl from xyz entry orders', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="113.0493" />
      <input id="tpPctInput" value="4.2" />
      <input id="slPctInput" value="1.7" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Breakout</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.requireKey = vi.fn(() => true);
    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'xyz:CL';
    window.currentSide = 'buy';
    window.currentOrderType = 'limit';
    window.currentPrice = 112.85;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime();
    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'xyz:CL';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 112.85;
    AppState.trading.lastDeployedPlan = null;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 1,
      latencyMs: 5,
    });

    const riskModule = await import('../risk-engine.js');
    vi.spyOn(riskModule, 'evaluateOrderRisk').mockReturnValue({
      allowed: true,
      mode: 'normal',
      message: 'ok',
      cappedSizeUsd: 680,
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder(await readExplicitTicketInput());

    expect(apiSpy).toHaveBeenCalledWith('/api/order', expect.objectContaining({
      coin: 'xyz:CL',
      tpPct: 4.2,
      slPct: 1.7,
    }));
  });

  it('sends HIP-3 protection intent to the backend instead of placing trigger orders from the browser', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="113.0493" />
      <input id="tpPctInput" value="4" />
      <input id="slPctInput" value="2" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Breakout</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'xyz:CL';
    window.currentSide = 'buy';
    window.currentOrderType = 'limit';
    window.currentPrice = 112.85;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'xyz:CL';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 112.85;
    AppState.trading.lastDeployedPlan = null;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 1,
      filled: { avgPx: '100', totalSz: '2' },
      latencyMs: 5,
    });

    const riskModule = await import('../risk-engine.js');
    vi.spyOn(riskModule, 'evaluateOrderRisk').mockReturnValue({
      allowed: true,
      mode: 'normal',
      message: 'ok',
      cappedSizeUsd: 680,
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder(await readExplicitTicketInput());

    expect(apiSpy).toHaveBeenCalledTimes(1);
    expect(apiSpy).toHaveBeenCalledWith('/api/order', expect.objectContaining({
      coin: 'xyz:CL',
      tpPct: 4,
      slPct: 2,
    }));
  });

  it('submits an order from explicit ticket input without scraping form fields', async () => {
    document.body.innerHTML = '';

    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 50000;
    AppState.trading.lastDeployedPlan = null;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 123,
      latencyMs: 5,
    });

    const riskModule = await import('../risk-engine.js');
    vi.spyOn(riskModule, 'evaluateOrderRisk').mockReturnValue({
      allowed: true,
      mode: 'normal',
      message: 'ok',
      cappedSizeUsd: 680,
    });

    const button = { disabled: false, textContent: 'Place Order' };
    const syncSizeUsd = vi.fn();

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder({
      sizeUsd: 680,
      rawLimitPrice: 50010.4,
      tpPct: 4,
      slPct: 2,
      selectedPlaybook: 'Breakout',
      submitButtonEl: button,
      syncSizeUsd,
    });

    expect(apiSpy).toHaveBeenCalledWith('/api/order', expect.objectContaining({
      privateKey: '__AUTO__',
      coin: 'BTC',
      isBuy: true,
      sz: 680,
      limitPx: 50010,
      tpPct: 4,
      slPct: 2,
    }));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Place Order');
    expect(syncSizeUsd).not.toHaveBeenCalled();
  });

  it('refreshes chart caches immediately after optimistic accepted limit placement', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="50000" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Manual</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'limit';
    window.currentPrice = 50000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    await mockTradingRuntime({ tickSize: 1 });

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 50000;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 123,
      latencyMs: 5,
    });

    const riskModule = await import('../risk-engine.js');
    vi.spyOn(riskModule, 'evaluateOrderRisk').mockReturnValue({
      allowed: true,
      mode: 'normal',
      message: 'ok',
      cappedSizeUsd: 680,
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder(await readExplicitTicketInput());

    expect(updateChartLevels).toHaveBeenCalled();
    expect(scheduleRender).toHaveBeenCalled();
    expect(scheduleChartRender).toHaveBeenCalled();
  });


  it('blocks manual ticket orders when risk gating rejects them', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="113.0493" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Breakout</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'limit';
    window.currentPrice = 50000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 50000;
    AppState.trading.lastDeployedPlan = null;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 1,
      latencyMs: 5,
    });

    const riskModule = await import('../risk-engine.js');
    const riskSpy = vi.spyOn(riskModule, 'evaluateOrderRisk').mockReturnValue({
      allowed: false,
      mode: 'avoid',
      message: 'blocked',
      cappedSizeUsd: 0,
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder(await readExplicitTicketInput());

    expect(riskSpy).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'BTC',
      playbook: 'Manual',
      source: 'manual',
    }));
    expect(apiSpy).not.toHaveBeenCalled();
  });

  it('sends limit buy and sell orders with the expected side and price payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T22:00:00Z'));

    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="50000.25" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Manual</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentOrderType = 'limit';
    window.currentPrice = 50000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime({ tickSize: 0.001 });

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 50000;
    AppState.trading.lastDeployedPlan = null;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 1,
      latencyMs: 5,
    });

    const riskModule = await import('../risk-engine.js');
    vi.spyOn(riskModule, 'evaluateOrderRisk').mockReturnValue({
      allowed: true,
      mode: 'normal',
      message: 'ok',
      cappedSizeUsd: 680,
    });

    const { placeOrder } = await import('../trading-service.js');

    window.currentSide = 'buy';
    AppState.trading.currentSide = 'buy';
    await placeOrder(await readExplicitTicketInput());

    vi.advanceTimersByTime(300);

    window.currentSide = 'sell';
    AppState.trading.currentSide = 'sell';
    await placeOrder(await readExplicitTicketInput());

    expect(apiSpy).toHaveBeenNthCalledWith(1, '/api/order', expect.objectContaining({
      coin: 'BTC',
      isBuy: true,
      limitPx: 50000,
    }));
    expect(apiSpy).toHaveBeenNthCalledWith(2, '/api/order', expect.objectContaining({
      coin: 'BTC',
      isBuy: false,
      limitPx: 50000,
    }));

    vi.useRealTimers();
  });

  it('still runs radar risk gating for deployed signal orders', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="113.0493" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Breakout</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'limit';
    window.currentPrice = 50000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime({ tickSize: 0.001 });

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 50000;
    AppState.trading.lastDeployedPlan = {
      coin: 'BTC',
      side: 'buy',
      orderType: 'limit',
      playbook: 'Breakout',
      limitPx: 113.049,
      sizeUsd: 680,
      takeProfitPct: 0,
      stopLossPct: 0,
    };
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 1,
      latencyMs: 5,
    });

    const riskModule = await import('../risk-engine.js');
    const riskSpy = vi.spyOn(riskModule, 'evaluateOrderRisk').mockReturnValue({
      allowed: false,
      mode: 'avoid',
      message: 'blocked',
      cappedSizeUsd: 0,
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder(await readExplicitTicketInput());

    expect(riskSpy).toHaveBeenCalled();
    expect(apiSpy).not.toHaveBeenCalled();
    expect(window.showToast).toHaveBeenCalledWith('blocked', true);
  });

  it('blocks market orders when the coin price feed is stale', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="20" />
      <input id="priceInput" value="" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <input id="sizeSlider" value="20" />
      <select id="playbookSelect"><option selected>Manual</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'xyz:CL';
    window.currentSide = 'buy';
    window.currentOrderType = 'market';
    window.currentPrice = 112.85;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'xyz:CL';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'market';
    AppState.trading.currentPrice = 112.85;
    AppState.market.lastPriceUpdateAt = { 'xyz:CL': Date.now() - 20000 };
    AppState.trading.lastDeployedPlan = null;
    window.AppState = AppState;
    window.lastPriceUpdateAt = AppState.market.lastPriceUpdateAt;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: true,
      oid: 1,
      latencyMs: 5,
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder(await readExplicitTicketInput());

    expect(apiSpy).not.toHaveBeenCalled();
    expect(window.showToast).toHaveBeenCalledWith(expect.stringContaining('Price feed stale for xyz:CL'), true);
  });

  it('fails manual limit submit when api returns ok without confirmation statuses', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="10" />
      <input id="priceInput" value="67396" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <input id="sizeSlider" value="10" />
      <select id="playbookSelect"><option selected>Manual</option></select>
      <button id="placeBtn">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'limit';
    window.currentPrice = 67396;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentPrice = 67396;
    AppState.trading.lastDeployedPlan = null;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      accepted: false,
      error: 'Order was not confirmed by exchange',
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder(await readExplicitTicketInput());

    expect(window.showToast).toHaveBeenCalledWith('Order failed: Order was not confirmed by exchange', true);
    expect(window.fetchAccount).not.toHaveBeenCalled();
  });

  it('submits scale orders through bulk orders endpoint', async () => {
    document.body.innerHTML = `
      <input id="scaleTotal" value="1000" />
      <input id="scaleOrders" value="2" />
      <input id="scaleHigh" value="71000" />
      <input id="scaleLow" value="69000" />
      <input id="sizeInput" value="" />
      <input id="priceInput" value="" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    window.requireKey = vi.fn(() => true);
    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'scale';
    window.currentPrice = 70000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime({ tickSize: 1 });

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 70000;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost')
      .mockResolvedValueOnce({
        orders: [
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000, reduceOnly: false },
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000, reduceOnly: false },
        ],
      })
      .mockResolvedValueOnce({
        statuses: [
          { accepted: true, oid: 1 },
          { accepted: true, oid: 2 },
        ],
        latencyMs: 5,
      });

    const { placeScaleOrder } = await import('../trading-service.js');
    await placeScaleOrder();
    await document.getElementById('placeBtn').onclick();

    expect(apiSpy).toHaveBeenCalledWith('/api/scale-preview', expect.objectContaining({
      coin: 'BTC',
      isBuy: true,
      totalUsd: 1000,
      numOrders: 2,
      lowPx: 69000,
      highPx: 71000,
      reduceOnly: false,
      mainnet: true,
    }));
    expect(apiSpy).toHaveBeenCalledWith('/api/bulk-orders', expect.objectContaining({
      privateKey: '__AUTO__',
      mainnet: true,
      orders: [
        expect.objectContaining({ coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000 }),
        expect.objectContaining({ coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000 }),
      ],
    }));
    expect(apiSpy).not.toHaveBeenCalledWith('/api/order', expect.anything());
    expect(window.showToast).toHaveBeenCalledWith('✓ 2 orders placed', false);
  });

  it('does not send scale orders while the market feed is stale', async () => {
    document.body.innerHTML = `
      <input id="scaleTotal" value="1000" />
      <input id="scaleOrders" value="2" />
      <input id="scaleHigh" value="71000" />
      <input id="scaleLow" value="69000" />
      <input id="sizeInput" value="" />
      <input id="priceInput" value="" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    window.requireKey = vi.fn(() => true);
    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'scale';
    window.currentPrice = 70000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime({ tickSize: 1 });

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 70000;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost')
      .mockResolvedValueOnce({
        orders: [
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000, reduceOnly: false },
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000, reduceOnly: false },
        ],
      });

    const { placeScaleOrder } = await import('../trading-service.js');
    await placeScaleOrder();
    AppState.connection.marketLastTickAt = 0;
    AppState.connection.marketUpstreamConnected = false;
    await document.getElementById('placeBtn').onclick();

    expect(apiSpy).toHaveBeenCalledWith('/api/scale-preview', expect.any(Object));
    expect(apiSpy).not.toHaveBeenCalledWith('/api/bulk-orders', expect.anything());
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Price feed stale'),
      true,
    );
  });

  it('does not replay a scale bulk submit after an ambiguous transport failure', async () => {
    vi.useFakeTimers();

    document.body.innerHTML = `
      <input id="scaleTotal" value="1000" />
      <input id="scaleOrders" value="2" />
      <input id="scaleHigh" value="71000" />
      <input id="scaleLow" value="69000" />
      <input id="sizeInput" value="" />
      <input id="priceInput" value="" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'scale';
    window.currentPrice = 70000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    window.fetchAccount = vi.fn();
    await mockTradingRuntime({ tickSize: 1 });

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 70000;
    window.AppState = AppState;

    const transientError = new Error('/api/bulk-orders 429: rate limit exceeded');
    transientError.url = '/api/bulk-orders';
    transientError.status = 429;
    transientError.rawMessage = 'rate limit exceeded';

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost')
      .mockResolvedValueOnce({
        orders: [
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000, reduceOnly: false },
          { coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000, reduceOnly: false },
        ],
      })
      .mockRejectedValueOnce(transientError);

    const { placeScaleOrder } = await import('../trading-service.js');
    await placeScaleOrder();

    const sendPromise = document.getElementById('placeBtn').onclick();
    await vi.runAllTimersAsync();
    await sendPromise;

    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(apiSpy).toHaveBeenNthCalledWith(1, '/api/scale-preview', expect.any(Object));
    expect(apiSpy).toHaveBeenNthCalledWith(2, '/api/bulk-orders', expect.any(Object));
    expect(window.showToast).toHaveBeenCalledWith(expect.stringContaining('429'), true);
  });

  it('rejects obviously stale xyz scale ranges after a pair switch', async () => {
    document.body.innerHTML = `
      <input id="scaleTotal" value="240" />
      <input id="scaleOrders" value="16" />
      <input id="scaleHigh" value="220.07" />
      <input id="scaleLow" value="210.00" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    await mockTradingRuntime({ tickSize: 0.1 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'xyz:GOLD';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 4715.8;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({ statuses: [] });

    const { placeScaleOrder } = await import('../trading-service.js');
    await placeScaleOrder();

    expect(apiSpy).not.toHaveBeenCalled();
    expect(window.showToast).toHaveBeenCalledWith(
      'Error: Scale range looks stale for xyz:GOLD. Reset high/low for the current market.',
      true,
    );
  });

  it('rejects scale orders when per-order size drops below the exchange minimum', async () => {
    document.body.innerHTML = `
      <input id="scaleTotal" value="72" />
      <input id="scaleOrders" value="8" />
      <input id="scaleHigh" value="180.5" />
      <input id="scaleLow" value="179.5" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    await mockTradingRuntime({ tickSize: 0.01 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'xyz:NVDA';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 180.5;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const previewError = new Error('/api/scale-preview 400: each scale order must be at least $10');
    previewError.status = 400;
    previewError.url = '/api/scale-preview';
    previewError.rawMessage = 'each scale order must be at least $10';
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockRejectedValue(previewError);

    const { placeScaleOrder } = await import('../trading-service.js');
    await placeScaleOrder();

    expect(apiSpy).toHaveBeenCalledTimes(1);
    expect(window.showToast).toHaveBeenCalledWith(
      'Error: each scale order must be at least $10',
      true,
    );
  });

  it('routes placeOrder through the scale preview flow when scale mode is active', async () => {
    document.body.innerHTML = `
      <input id="scaleTotal" value="1000" />
      <input id="scaleOrders" value="2" />
      <input id="scaleHigh" value="71000" />
      <input id="scaleLow" value="69000" />
      <input id="sizeInput" value="" />
      <input id="priceInput" value="" />
      <input id="tpPctInput" value="" />
      <input id="slPctInput" value="" />
      <button id="placeBtn" data-action="placeOrder">Place Order</button>
    `;

    window.privateKey = 'a'.repeat(64);
    window.walletAddress = '0x123';
    window.currentCoin = 'BTC';
    window.currentSide = 'buy';
    window.currentOrderType = 'scale';
    window.currentPrice = 70000;
    window.bookData = { bids: [], asks: [] };
    window.accountState = { assetPositions: [] };
    await mockTradingRuntime({ tickSize: 1 });

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = { assetPositions: [] };
    AppState.market.book = { bids: [], asks: [] };
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentSide = 'buy';
    AppState.trading.currentOrderType = 'scale';
    AppState.trading.currentPrice = 70000;
    window.AppState = AppState;

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost').mockResolvedValue({
      orders: [
        { coin: 'BTC', isBuy: true, sz: 500, limitPx: 69000, reduceOnly: false },
        { coin: 'BTC', isBuy: true, sz: 500, limitPx: 71000, reduceOnly: false },
      ],
    });

    const { placeOrder } = await import('../trading-service.js');
    await placeOrder();

    expect(apiSpy).toHaveBeenCalledTimes(1);
    expect(apiSpy).toHaveBeenCalledWith('/api/scale-preview', expect.objectContaining({
      coin: 'BTC',
      totalUsd: 1000,
      numOrders: 2,
    }));
  });

  it('optimistically removes only the local position after a successful full close', async () => {
    document.body.innerHTML = '<button id="closeBtn">Close</button>';

    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = {
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.5', entryPx: '100000', unrealizedPnl: '0' } },
        { position: { coin: 'ETH', szi: '1', entryPx: '3000', unrealizedPnl: '0' } },
      ],
    };
    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', side: 'B', limitPx: 99500, sz: 0.01 },
      { oid: 2, coin: 'ETH', side: 'A', limitPx: 3100, sz: 0.5 },
    ];

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost')
      .mockResolvedValueOnce({ status: 'ok' });

    const { closePosition } = await import('../trading-service.js');
    await closePosition('BTC', 1.0, document.getElementById('closeBtn'));

    expect(apiSpy).toHaveBeenNthCalledWith(1, '/api/close-position', expect.objectContaining({
      address: '0x123',
      coin: 'BTC',
      fraction: 1,
      positionSize: 0.5,
      positionSzi: 0.5,
    }));
    expect(apiSpy).toHaveBeenCalledWith('/api/close-position', expect.objectContaining({
      address: '0x123',
      coin: 'BTC',
      fraction: 1,
      positionSize: 0.5,
      positionSzi: 0.5,
    }));
    expect(AppState.account.state.assetPositions).toEqual([
      expect.objectContaining({
        position: expect.objectContaining({ coin: 'ETH' }),
      }),
    ]);
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ coin: 'BTC', oid: 1 }),
      expect.objectContaining({ coin: 'ETH', oid: 2 }),
    ]);
    expect(updateChartLevels).toHaveBeenCalled();
    expect(scheduleRender).toHaveBeenCalled();
    expect(scheduleChartRender).toHaveBeenCalled();
  });

  it('bulk close closes positions without cancelling same-coin limit orders', async () => {
    document.body.innerHTML = '<button id="closeAllBtn">CLOSE</button>';

    await mockTradingRuntime();

    const { AppState } = await import('../../state/store.js');
    AppState.account.privateKey = 'a'.repeat(64);
    AppState.account.walletAddress = '0x123';
    AppState.account.state = {
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.5', entryPx: '100000', unrealizedPnl: '0' } },
        { position: { coin: 'ETH', szi: '-1', entryPx: '3000', unrealizedPnl: '0' } },
      ],
    };
    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', side: 'B', limitPx: 99500, sz: 0.01 },
      { oid: 2, coin: 'ETH', side: 'A', limitPx: 3100, sz: 0.5 },
    ];

    const apiModule = await import('../api.js');
    const apiSpy = vi.spyOn(apiModule, 'apiPost')
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({ status: 'ok' });

    const { closeAllPositions } = await import('../trading-service.js');
    await closeAllPositions(document.getElementById('closeAllBtn'));

    expect(apiSpy).toHaveBeenCalledTimes(2);
    expect(apiSpy).toHaveBeenNthCalledWith(1, '/api/close-position', expect.objectContaining({
      address: '0x123',
      coin: 'BTC',
      fraction: 1,
      positionSize: 0.5,
      positionSzi: 0.5,
    }));
    expect(apiSpy).toHaveBeenNthCalledWith(2, '/api/close-position', expect.objectContaining({
      address: '0x123',
      coin: 'ETH',
      fraction: 1,
      positionSize: 1,
      positionSzi: -1,
    }));
    expect(AppState.account.state.assetPositions).toEqual([]);
    expect(AppState.account.openOrders).toEqual([
      expect.objectContaining({ coin: 'BTC', oid: 1 }),
      expect.objectContaining({ coin: 'ETH', oid: 2 }),
    ]);
    expect(updateChartLevels).toHaveBeenCalled();
    expect(scheduleRender).toHaveBeenCalled();
    expect(scheduleChartRender).toHaveBeenCalled();
  });
});
