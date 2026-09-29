/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../chart/chart-render.js', () => ({
  scheduleChartRender: vi.fn(),
}));

vi.mock('../../render/trades.js', () => ({
  renderLiquidations: vi.fn(),
  renderOrderFlow: vi.fn(),
}));

vi.mock('../../render/dom-ladder.js', () => ({
  renderDomLadder: vi.fn(),
}));

vi.mock('../../ui/tabs.js', () => ({
  syncLimitAutoTrackState: vi.fn(),
}));

describe('market render runtime', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentOrderType = 'limit';
    AppState.ui.limitPriceEntryMode = 'auto';
    AppState.ui.userEditedPrice = false;
  });

  it('coalesces active trade panel rendering to one frame for the active coin', async () => {
    const callbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      callbacks.push(cb);
      return callbacks.length;
    });

    const runtime = await import('../market-render-runtime.js');
    const tradesRenderModule = await import('../../render/trades.js');

    runtime.scheduleActiveTradePanelsRender('BTC');
    runtime.scheduleActiveTradePanelsRender('BTC');

    expect(tradesRenderModule.renderOrderFlow).not.toHaveBeenCalled();

    callbacks.forEach((cb) => cb?.());

    expect(tradesRenderModule.renderOrderFlow).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a full chart overlay repaint from book ticks', async () => {
    const runtime = await import('../market-render-runtime.js');
    const chartRenderModule = await import('../../chart/chart-render.js');

    runtime.scheduleOrderbookRender();
    runtime.scheduleOrderbookRender();

    // Live price line is owned by applyCurrentPrice; book frames must not
    // force drawChart on every L2 update.
    expect(chartRenderModule.scheduleChartRender).not.toHaveBeenCalled();
  });

  it('lets cancelPendingRenders suppress an already-scheduled Flow repaint', async () => {
    let scheduledCallback = null;
    global.requestAnimationFrame = vi.fn((cb) => {
      scheduledCallback = cb;
      return 1;
    });

    const runtime = await import('../market-render-runtime.js');
    const tradesRenderModule = await import('../../render/trades.js');

    runtime.scheduleActiveTradePanelsRender('BTC');
    runtime.cancelPendingRenders();
    scheduledCallback?.();

    expect(tradesRenderModule.renderOrderFlow).not.toHaveBeenCalled();
  });

  it('lets a new schedule after cancelPendingRenders paint on the next frame', async () => {
    const callbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      callbacks.push(cb);
      return callbacks.length;
    });

    const runtime = await import('../market-render-runtime.js');
    const tradesRenderModule = await import('../../render/trades.js');
    const ladderModule = await import('../../render/dom-ladder.js');

    runtime.scheduleActiveTradePanelsRender('BTC');
    runtime.cancelPendingRenders();
    runtime.scheduleActiveTradePanelsRender('BTC');
    callbacks.forEach((cb) => cb?.());

    expect(tradesRenderModule.renderOrderFlow).toHaveBeenCalledTimes(1);
    expect(ladderModule.renderDomLadder).toHaveBeenCalledTimes(1);
  });

  it('coalesces a book tick and a trade tick into one ladder paint', async () => {
    const callbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      callbacks.push(cb);
      return callbacks.length;
    });

    const runtime = await import('../market-render-runtime.js');
    const ladderModule = await import('../../render/dom-ladder.js');

    runtime.scheduleLiveDomLadderRender();
    runtime.scheduleActiveTradePanelsRender('BTC');
    callbacks.forEach((cb) => cb?.());

    expect(ladderModule.renderDomLadder).toHaveBeenCalledTimes(1);
  });

  it('refreshes limit preview tracking only for active 1m limit auto-track mode', async () => {
    const runtime = await import('../market-render-runtime.js');
    const tabsModule = await import('../../ui/tabs.js');
    const chartRenderModule = await import('../../chart/chart-render.js');

    tabsModule.syncLimitAutoTrackState.mockReturnValue(true);

    runtime.refreshLimitPreviewTracking();

    expect(tabsModule.syncLimitAutoTrackState).toHaveBeenCalledWith({
      requestChartRefresh: false,
      syncUi: true,
    });
    expect(chartRenderModule.scheduleChartRender).toHaveBeenCalledTimes(1);
  });
});
