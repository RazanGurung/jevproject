// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInit, installAppWindowEvents } from '../app-runtime.js';

describe('app runtime init', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '<div id="bottomContent"></div><button class="type-tab"></button>';
  });

  function createDeps(overrides = {}) {
    return {
      setupDelegation: vi.fn(),
      attachLegacyFacade: vi.fn(),
      loadCoinMeta: vi.fn().mockResolvedValue(undefined),
      syncLegacyGlobals: vi.fn(),
      renderDeploySizingControls: vi.fn(),
      setOrderType: vi.fn(),
      renderLiquidations: vi.fn(),
      renderOrderFlow: vi.fn(),
      renderSignalRadar: vi.fn(),
      updateSummary: vi.fn(),
      isMarketRadarConnected: vi.fn(() => false),
      start24hPolling: vi.fn(),
      startTopMoversPolling: vi.fn(),
      startMispricingPolling: vi.fn(),
      startCvdAlertMonitor: vi.fn(),
      fetchNewsConfig: vi.fn().mockResolvedValue(undefined),
      startNewsPolling: vi.fn(),
      initChart: vi.fn(),
      fetchCandles: vi.fn().mockResolvedValue(undefined),
      refreshExchangeInfo: vi.fn().mockResolvedValue(undefined),
      ensureRadarNewsCoverage: vi.fn().mockResolvedValue(undefined),
      scheduleRender: vi.fn(),
      autoLogin: vi.fn().mockResolvedValue(undefined),
      getEffectiveWalletAddress: vi.fn(() => ''),
      fetchRecentFills: vi.fn().mockResolvedValue(undefined),
      connectAccountStream: vi.fn(),
      getAccountStreamSocket: vi.fn(() => null),
      getBotModule: vi.fn(() => null),
      subscribeMarket: vi.fn(),
      getEffectiveCurrentCoin: vi.fn(() => 'BTC'),
      getEffectiveCurrentTimeframe: vi.fn(() => '4h'),
      getDesiredTradeCoins: vi.fn(() => ['BTC', 'ETH']),
      ...overrides,
    };
  }

  it('connects the account stream during init without posting a duplicate eager market subscribe', async () => {
    const deps = createDeps();
    const init = createInit(deps);

    await init();

    expect(deps.setOrderType).toHaveBeenCalledWith('limit', document.querySelector('.type-tab'));
    expect(deps.updateSummary).toHaveBeenCalledTimes(2);
    expect(deps.connectAccountStream).toHaveBeenCalledTimes(1);
    expect(deps.subscribeMarket).not.toHaveBeenCalled();
    expect(deps.fetchCandles).toHaveBeenCalledWith(expect.objectContaining({ requestToken: expect.anything() }));
    expect(deps.startNewsPolling).not.toHaveBeenCalled();
  });

  it('fetches recent fills after auto-login when a wallet is active', async () => {
    const deps = createDeps({
      getEffectiveWalletAddress: vi.fn(() => '0x123'),
    });
    const init = createInit(deps);

    await init();

    expect(deps.fetchRecentFills).toHaveBeenCalledTimes(1);
    expect(deps.connectAccountStream).toHaveBeenCalledTimes(1);
  });

  it('boots ticker news polling when the news panel is enabled', async () => {
    const deps = createDeps({
      isMarketRadarConnected: vi.fn(() => true),
    });
    const init = createInit(deps);

    await init();

    expect(deps.fetchNewsConfig).toHaveBeenCalledTimes(1);
    expect(deps.startNewsPolling).toHaveBeenCalledTimes(1);
    expect(deps.ensureRadarNewsCoverage).toHaveBeenCalledWith({ force: true });
  });

  it('does not reconnect the account stream when one already exists', async () => {
    const deps = createDeps({
      getAccountStreamSocket: vi.fn(() => ({ readyState: 1 })),
    });
    const init = createInit(deps);

    await init();

    expect(deps.connectAccountStream).not.toHaveBeenCalled();
  });

  it('initializes the bot module through the injected getter', async () => {
    const botModule = { init: vi.fn() };
    const deps = createDeps({
      getBotModule: vi.fn(() => botModule),
    });
    const init = createInit(deps);

    await init();

    expect(botModule.init).toHaveBeenCalledTimes(1);
  });
});

describe('app window recovery events', () => {
  it('routes pageshow, bfcache, freeze-resume, and online into tab recovery', () => {
    const recoverAfterTabResume = vi.fn();
    const recoverChartSurface = vi.fn();
    const scheduleChartRender = vi.fn();

    installAppWindowEvents({
      recoverAfterTabResume,
      recoverChartSurface,
      scheduleChartRender,
      onBeforeUnload: vi.fn(),
    });

    window.dispatchEvent(new Event('pageshow'));
    expect(recoverAfterTabResume).toHaveBeenCalledWith('pageshow');

    const persisted = new Event('pageshow');
    Object.defineProperty(persisted, 'persisted', { value: true });
    window.dispatchEvent(persisted);
    expect(recoverAfterTabResume).toHaveBeenCalledWith('pageshow-bfcache');

    document.dispatchEvent(new Event('resume'));
    expect(recoverAfterTabResume).toHaveBeenCalledWith('page-resume');

    window.dispatchEvent(new Event('online'));
    expect(recoverAfterTabResume).toHaveBeenCalledWith('online');
  });

  it('force-repaints the chart surface after the window resizes', async () => {
    const recoverChartSurface = vi.fn();
    const scheduleChartRender = vi.fn();

    installAppWindowEvents({
      recoverAfterTabResume: vi.fn(),
      recoverChartSurface,
      scheduleChartRender,
      onBeforeUnload: vi.fn(),
    });

    window.dispatchEvent(new Event('resize'));
    expect(recoverChartSurface).not.toHaveBeenCalled();
    expect(scheduleChartRender).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(recoverChartSurface).toHaveBeenCalled();
    expect(scheduleChartRender).toHaveBeenCalled();
  });
});

