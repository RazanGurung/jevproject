/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('runtime compatibility bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.botModule = undefined;
    window.StrategyManager = undefined;
    window.applyBotStatus = undefined;
  });

  it('coalesces legacy bot trade updates for the same trade burst', async () => {
    const callbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      callbacks.push(cb);
      return callbacks.length;
    });

    window.botModule = {
      onTradeUpdate: vi.fn(),
    };

    const { scheduleLegacyBotTradeUpdate } = await import('../runtime-compat.js');

    scheduleLegacyBotTradeUpdate([{ px: '100', sz: '600', side: 'B' }]);
    scheduleLegacyBotTradeUpdate([{ px: '101', sz: '700', side: 'A' }]);

    expect(window.botModule.onTradeUpdate).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.();

    expect(window.botModule.onTradeUpdate).toHaveBeenCalledTimes(1);
  });

  it('delivers queued bot trade updates to the bot module active at schedule time', async () => {
    const callbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      callbacks.push(cb);
      return callbacks.length;
    });

    const firstBotModule = {
      onTradeUpdate: vi.fn(),
    };
    const secondBotModule = {
      onTradeUpdate: vi.fn(),
    };
    window.botModule = firstBotModule;

    const { scheduleLegacyBotTradeUpdate } = await import('../runtime-compat.js');

    scheduleLegacyBotTradeUpdate([{ px: '100', sz: '600', side: 'B' }]);
    window.botModule = secondBotModule;

    callbacks[0]?.();

    expect(firstBotModule.onTradeUpdate).toHaveBeenCalledTimes(1);
    expect(secondBotModule.onTradeUpdate).not.toHaveBeenCalled();
  });

  it('forwards bot status through the compatibility bridge', async () => {
    window.applyBotStatus = vi.fn();
    const { applyBotStatusBridge } = await import('../runtime-compat.js');

    applyBotStatusBridge({ running: true, coin: 'BTC' });

    expect(window.applyBotStatus).toHaveBeenCalledWith({ running: true, coin: 'BTC' });
  });

  it('exposes explicit runtime accessors for bot loading', async () => {
    const botModule = { onTradeUpdate: vi.fn() };
    const botLoader = vi.fn();
    window.botModule = botModule;
    window.BOT = { running: true };
    window.loadBotStrategy = botLoader;

    const {
      getBotModule,
      getBotStrategyLoader,
      isLegacyBotRunning,
    } = await import('../runtime-compat.js');

    expect(getBotModule()).toBe(botModule);
    expect(isLegacyBotRunning()).toBe(true);
    expect(getBotStrategyLoader()).toBe(botLoader);
  });

  it('exposes the legacy bot-status refresher through the compat bridge', async () => {
    const refreshBotStatus = vi.fn();
    window.refreshBotStatus = refreshBotStatus;

    const { getBotStatusRefresher } = await import('../runtime-compat.js');

    expect(getBotStatusRefresher()).toBe(refreshBotStatus);
  });
});
