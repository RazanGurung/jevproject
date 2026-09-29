/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('strategy host', () => {
  beforeEach(async () => {
    vi.resetModules();
    window.ChartLayers = { id: 'chart-window' };
    window.PriceFeed = { update: vi.fn(), id: 'price-window' };
    window.StrategyManager = { activeStrategy: { id: 'strat-window' } };
    window.botModule = { init: vi.fn(), id: 'bot-module-window' };
    window.BOT = { running: true, id: 'bot-window' };
    window.refreshBotStatus = vi.fn();
    window.applyBotStatus = vi.fn();
    window.loadBotStrategy = vi.fn();
    window.updateTotals = vi.fn();
    window.updateBotConfigFromInputs = vi.fn();
    window.onAccountStreamConnectionStateChange = vi.fn();
    window.StrategyHelpers = {
      saveStrategyState: vi.fn(),
      loadStrategyState: vi.fn(),
      clearStrategyState: vi.fn(),
    };
    window.botLog = vi.fn();
  });

  it('reads bot and chart host surfaces from the browser host when no deps injected', async () => {
    const {
      getBotModule,
      getBotRuntime,
      getBotStatusApplier,
      getBotStatusRefresher,
      getBotStrategyLoader,
      getBotTotalsUpdater,
      getBotConfigInputSyncer,
      getAccountStreamConnectionStateHandler,
      getChartService,
      getPriceFeed,
      getStrategyManager,
      clearStrategyHostDeps,
    } = await import('../strategy-host.js');

    clearStrategyHostDeps();

    expect(getChartService()).toBe(window.ChartLayers);
    expect(getPriceFeed()).toBe(window.PriceFeed);
    expect(getStrategyManager()).toBe(window.StrategyManager);
    expect(getBotModule()).toBe(window.botModule);
    expect(getBotRuntime()).toBe(window.BOT);
    expect(getBotStatusRefresher()).toBe(window.refreshBotStatus);
    expect(getBotStatusApplier()).toBe(window.applyBotStatus);
    expect(getBotStrategyLoader()).toBe(window.loadBotStrategy);
    expect(getBotTotalsUpdater()).toBe(window.updateTotals);
    expect(getBotConfigInputSyncer()).toBe(window.updateBotConfigFromInputs);
    expect(getAccountStreamConnectionStateHandler()).toBe(window.onAccountStreamConnectionStateChange);
  });

  it('prefers injected module deps over window (Stage 3 Slice B)', async () => {
    const {
      setStrategyHostDeps,
      clearStrategyHostDeps,
      getChartService,
      getPriceFeed,
      getStrategyManager,
      getStrategyHelpers,
      getBotRuntime,
      getBotStatusRefresher,
      getLogger,
      installStrategyHostBridge,
    } = await import('../strategy-host.js');

    clearStrategyHostDeps();

    const chartService = { id: 'chart-module' };
    const priceFeed = { id: 'price-module' };
    const strategyManager = { id: 'manager-module' };
    const strategyHelpers = { saveStrategyState: vi.fn() };
    const botRuntime = { running: false, id: 'bot-module' };
    const refreshBotStatus = vi.fn();
    const botLog = vi.fn();

    setStrategyHostDeps({
      chartService,
      priceFeed,
      strategyManager,
      strategyHelpers,
      botRuntime,
      refreshBotStatus,
      botLog,
    });

    expect(getChartService()).toBe(chartService);
    expect(getChartService()).not.toBe(window.ChartLayers);
    expect(getPriceFeed()).toBe(priceFeed);
    expect(getStrategyManager()).toBe(strategyManager);
    expect(getStrategyHelpers()).toBe(strategyHelpers);
    expect(getBotRuntime()).toBe(botRuntime);
    expect(getBotStatusRefresher()).toBe(refreshBotStatus);
    expect(getLogger()).toBe(botLog);

    const host = installStrategyHostBridge();
    expect(host).toBe(window.PezStrategyHost);
    expect(host.getChartService()).toBe(chartService);
    expect(host.getBotRuntime()).toBe(botRuntime);
    expect(host.getBotStatusRefresher()).toBe(refreshBotStatus);
  });

  it('installs the strategy host bridge with the expanded bot/chart surface', async () => {
    const { installStrategyHostBridge, clearStrategyHostDeps } = await import('../strategy-host.js');
    clearStrategyHostDeps();

    const host = installStrategyHostBridge();

    expect(host).toBe(window.PezStrategyHost);
    expect(host.getChartService()).toBe(window.ChartLayers);
    expect(host.getBotModule()).toBe(window.botModule);
    expect(host.getBotRuntime()).toBe(window.BOT);
    expect(host.getBotStatusRefresher()).toBe(window.refreshBotStatus);
    expect(host.getBotStatusApplier()).toBe(window.applyBotStatus);
    expect(host.getBotStrategyLoader()).toBe(window.loadBotStrategy);
    expect(host.getBotTotalsUpdater()).toBe(window.updateTotals);
    expect(host.getBotConfigInputSyncer()).toBe(window.updateBotConfigFromInputs);
    expect(host.getAccountStreamConnectionStateHandler()).toBe(window.onAccountStreamConnectionStateChange);
  });
});
