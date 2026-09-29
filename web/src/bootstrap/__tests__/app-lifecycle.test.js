// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createBeforeUnloadHandler, renderActiveBottomTab } from '../app-lifecycle.js';

describe('app lifecycle helpers', () => {
  it('renders the currently active bottom tab', () => {
    document.body.innerHTML = '<button class="bottom-tab active" data-tab="orders"></button>';
    const renderPositions = vi.fn();
    const renderOrders = vi.fn();
    const renderTrades = vi.fn();
    const renderFills = vi.fn();

    renderActiveBottomTab({
      getActiveTab: () => document.querySelector('.bottom-tab.active')?.dataset.tab || 'positions',
      renderPositions,
      renderOrders,
      renderTrades,
      renderFills,
    });

    expect(renderOrders).toHaveBeenCalledTimes(1);
    expect(renderPositions).not.toHaveBeenCalled();
    expect(renderTrades).not.toHaveBeenCalled();
    expect(renderFills).not.toHaveBeenCalled();
  });

  it('cleans up runtime resources on unload', () => {
    const close = vi.fn();
    const stop24hPolling = vi.fn();
    const stopNewsPolling = vi.fn();
    const clearPrivateKey = vi.fn();
    const clearAccountStreamSocket = vi.fn();
    const stopBotModule = vi.fn();
    const botModule = { stop: vi.fn() };

    const onBeforeUnload = createBeforeUnloadHandler({
      getBotModule: () => botModule,
      stopBotModule,
      clearPrivateKey,
      getAccountStreamSocket: () => ({ close }),
      clearAccountStreamSocket,
      stop24hPolling,
      stopNewsPolling,
    });

    onBeforeUnload();

    expect(stopBotModule).toHaveBeenCalledWith(botModule);
    expect(clearPrivateKey).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(clearAccountStreamSocket).toHaveBeenCalledTimes(1);
    expect(stop24hPolling).toHaveBeenCalledTimes(1);
    expect(stopNewsPolling).toHaveBeenCalledTimes(1);
  });
});
