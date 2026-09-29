/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderSignalRadar = vi.fn();
const scheduleChartRender = vi.fn();
const updateChartLevels = vi.fn();
const fetchNewsConfig = vi.fn(() => Promise.resolve());
const startNewsPolling = vi.fn();
const stopNewsPolling = vi.fn();
const subscribeMarket = vi.fn(() => Promise.resolve(true));
const scheduleLayoutRender = vi.fn();

vi.mock('../../ui/signal-radar.js', () => ({
  renderSignalRadar,
}));

vi.mock('../../chart/chart-render.js', () => ({
  scheduleChartRender,
}));

vi.mock('../../chart/chart-levels.js', () => ({
  updateChartLevels,
}));

vi.mock('../../ui/account-ui.js', () => ({
  updateBalanceDisplay: vi.fn(),
}));

vi.mock('../../services/news-service.js', () => ({
  fetchNewsConfig,
  startNewsPolling,
  stopNewsPolling,
}));

vi.mock('../../streams/market-ws.js', () => ({
  subscribeMarket,
}));

vi.mock('../layout-scheduler.js', () => ({
  scheduleLayoutRender,
}));

describe('toggleHide', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `
      <button id="hideValuesBtn" aria-pressed="false" title="Hide account dollar values">Hide $</button>
    `;
    const { AppState } = await import('../../state/store.js');
    AppState.ui.hideValues = false;
  });

  it('describes whether account dollar values will be hidden or shown', async () => {
    const { AppState } = await import('../../state/store.js');
    const { toggleHide } = await import('../ui-state.js');
    const button = document.getElementById('hideValuesBtn');

    toggleHide();
    expect(AppState.ui.hideValues).toBe(true);
    expect(button.textContent).toBe('Show $');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toBe('Show account dollar values');

    toggleHide();
    expect(AppState.ui.hideValues).toBe(false);
    expect(button.textContent).toBe('Hide $');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe('Hide account dollar values');
  });
});

describe('toggleMarketRadar', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    const { AppState } = await import('../../state/store.js');
    AppState.ui.marketRadarVisible = false;
    AppState.ui.marketRadarConnected = false;
  });

  it('connects radar services and expands the chart layout when enabled', async () => {
    const { AppState } = await import('../../state/store.js');
    const { toggleMarketRadar } = await import('../ui-state.js');

    toggleMarketRadar();
    await vi.waitFor(() => {
      expect(startNewsPolling).toHaveBeenCalledTimes(1);
    });

    expect(AppState.ui.marketRadarVisible).toBe(true);
    expect(AppState.ui.marketRadarConnected).toBe(true);
    expect(fetchNewsConfig).toHaveBeenCalledTimes(1);
    expect(startNewsPolling).toHaveBeenCalledTimes(1);
    expect(subscribeMarket).toHaveBeenCalledTimes(1);
    expect(renderSignalRadar).toHaveBeenCalled();
    expect(scheduleLayoutRender).not.toHaveBeenCalled();
  });

  it('disconnects radar services when disabled', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.ui.marketRadarVisible = true;
    AppState.ui.marketRadarConnected = true;

    const { toggleMarketRadar } = await import('../ui-state.js');

    toggleMarketRadar();

    expect(AppState.ui.marketRadarVisible).toBe(false);
    expect(AppState.ui.marketRadarConnected).toBe(false);
    expect(stopNewsPolling).toHaveBeenCalledTimes(1);
    expect(subscribeMarket).toHaveBeenCalledTimes(1);
    expect(renderSignalRadar).toHaveBeenCalled();
    expect(scheduleLayoutRender).not.toHaveBeenCalled();
  });
});

describe('toggleLiqPanel', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `
      <div id="mainLayout" class="main"></div>
      <button id="liqToggleBtn"></button>
    `;
  });

  it('toggles liq panel visibility and updates button state', async () => {
    const { AppState } = await import('../../state/store.js');
    const { toggleLiqPanel } = await import('../ui-state.js');
    AppState.ui.liqPanelVisible = true;

    toggleLiqPanel();

    expect(AppState.ui.liqPanelVisible).toBe(false);
    expect(document.getElementById('mainLayout')?.classList.contains('liq-hidden')).toBe(true);
    const btn = document.getElementById('liqToggleBtn');
    expect(btn?.classList.contains('disconnected')).toBe(true);
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    expect(btn?.title).toBe('Show liquidations, misprice and signal');

    toggleLiqPanel();

    expect(AppState.ui.liqPanelVisible).toBe(true);
    expect(document.getElementById('mainLayout')?.classList.contains('liq-hidden')).toBe(false);
    expect(btn?.classList.contains('connected')).toBe(true);
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(btn?.title).toBe('Hide liquidations, misprice and signal');
  });

  it('sets liq panel visibility state directly via setLiqPanelState', async () => {
    const { AppState } = await import('../../state/store.js');
    const { setLiqPanelState } = await import('../ui-state.js');

    setLiqPanelState(false);
    expect(AppState.ui.liqPanelVisible).toBe(false);
    expect(window.liqPanelVisible).toBe(false);
    expect(document.getElementById('mainLayout')?.classList.contains('liq-hidden')).toBe(true);
    const btn = document.getElementById('liqToggleBtn');
    expect(btn?.classList.contains('disconnected')).toBe(true);
    expect(btn?.getAttribute('aria-pressed')).toBe('false');

    setLiqPanelState(true);
    expect(AppState.ui.liqPanelVisible).toBe(true);
    expect(window.liqPanelVisible).toBe(true);
    expect(document.getElementById('mainLayout')?.classList.contains('liq-hidden')).toBe(false);
    expect(btn?.classList.contains('connected')).toBe(true);
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('toggleTradingPanel', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = `
      <div id="mainLayout" class="main trading-hidden"></div>
      <button id="tradingToggleBtn" class="disconnected"></button>
    `;
  });

  it('toggles trading panel visibility and updates button state', async () => {
    const { AppState } = await import('../../state/store.js');
    const { toggleTradingPanel } = await import('../ui-state.js');
    AppState.ui.tradingPanelVisible = false;

    toggleTradingPanel();

    expect(AppState.ui.tradingPanelVisible).toBe(true);
    expect(window.tradingPanelVisible).toBe(true);
    expect(document.getElementById('mainLayout')?.classList.contains('trading-hidden')).toBe(false);
    const btn = document.getElementById('tradingToggleBtn');
    expect(btn?.classList.contains('connected')).toBe(true);
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(btn?.title).toBe('Hide order entry & positions');

    toggleTradingPanel();

    expect(AppState.ui.tradingPanelVisible).toBe(false);
    expect(window.tradingPanelVisible).toBe(false);
    expect(document.getElementById('mainLayout')?.classList.contains('trading-hidden')).toBe(true);
    expect(btn?.classList.contains('disconnected')).toBe(true);
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    expect(btn?.title).toBe('Show order entry & positions');
  });
});
