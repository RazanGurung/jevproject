/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const beginChartSession = vi.fn();
const completeChartSession = vi.fn();
const failChartSession = vi.fn();
const setDesiredMarketSubscription = vi.fn();
const clearAllPreview = vi.fn();
const getChartPreviewLevels = vi.fn(() => []);
const setMarketCandles = vi.fn();
const getEffectiveCurrentCoin = vi.fn(() => 'BTC');
const getEffectiveCurrentOrderType = vi.fn(() => 'limit');
const getEffectiveCurrentTimeframe = vi.fn(() => '2h');
const getActiveCandleRequestToken = vi.fn(() => 'token-1');
const setActiveCandleRequestToken = vi.fn();
const setLimitAutoTrackForTimeframe = vi.fn();
const setCurrentTimeframe = vi.fn();
const clearHistoryLoadState = vi.fn();
const scheduleChartRender = vi.fn();
const fetchCandles = vi.fn();
const beginTimeframeSwitch = vi.fn(() => 'token-1');
const completeTimeframeSwitch = vi.fn();
const shouldStartTimeframeSwitch = vi.fn(() => true);

vi.mock('../../state/chart-session.js', () => ({
  beginChartSession,
  completeChartSession,
  failChartSession,
}));

vi.mock('../../state/market-subscription-state.js', () => ({
  setDesiredMarketSubscription,
}));

vi.mock('../../state/preview-state.js', () => ({
  clearAllPreview,
  getChartPreviewLevels,
}));

vi.mock('../../state/market-state.js', () => ({
  setMarketCandles,
}));

vi.mock('../../state/effective-trading.js', () => ({
  getEffectiveCurrentCoin,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentTimeframe,
}));

vi.mock('../../state/trading-runtime.js', () => ({
  getActiveCandleRequestToken,
  setActiveCandleRequestToken,
  setLimitAutoTrackForTimeframe,
}));

vi.mock('../../state/store.js', () => ({
  setCurrentTimeframe,
}));

vi.mock('../../chart/chart-render.js', () => ({
  clearHistoryLoadState,
  scheduleChartRender,
}));

vi.mock('../../services/market-service.js', () => ({
  fetchCandles,
  prefetchAdjacentTimeframes: vi.fn(),
}));

vi.mock('../../services/chart-candle-service.js', () => ({
  prefetchAdjacentTimeframes: vi.fn(),
}));

vi.mock('../ticket-chart-actions.js', () => ({
  beginTimeframeSwitch,
  completeTimeframeSwitch,
  shouldStartTimeframeSwitch,
}));

describe('ticket timeframe runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    beginChartSession.mockReset();
    completeChartSession.mockReset();
    failChartSession.mockReset();
    setDesiredMarketSubscription.mockReset();
    clearAllPreview.mockReset();
    getChartPreviewLevels.mockReset();
    getChartPreviewLevels.mockReturnValue([]);
    setMarketCandles.mockReset();
    getEffectiveCurrentCoin.mockReset();
    getEffectiveCurrentCoin.mockReturnValue('BTC');
    getEffectiveCurrentOrderType.mockReset();
    getEffectiveCurrentOrderType.mockReturnValue('limit');
    getEffectiveCurrentTimeframe.mockReset();
    getEffectiveCurrentTimeframe.mockReturnValue('2h');
    getActiveCandleRequestToken.mockReset();
    getActiveCandleRequestToken.mockReturnValue('token-1');
    setActiveCandleRequestToken.mockReset();
    setLimitAutoTrackForTimeframe.mockReset();
    setCurrentTimeframe.mockReset();
    clearHistoryLoadState.mockReset();
    scheduleChartRender.mockReset();
    fetchCandles.mockReset();
    beginTimeframeSwitch.mockReset();
    beginTimeframeSwitch.mockReturnValue('token-1');
    completeTimeframeSwitch.mockReset();
    shouldStartTimeframeSwitch.mockReset();
    shouldStartTimeframeSwitch.mockReturnValue(true);
  });

  it('delegates timeframe switch orchestration through the runtime helper', async () => {
    const { createTimeframeSwitchRuntime } = await import('../ticket-timeframe-runtime.js');
    const cancelPendingRenders = vi.fn();
    const loadMarketActions = vi.fn().mockResolvedValue({ cancelPendingRenders });
    const applyTimeframeTabButton = vi.fn();
    const reconcileTimeframePreview = vi.fn(() => 'token-1');
    const clearScalePreview = vi.fn();
    const syncLimitPreviewLevels = vi.fn();
    const syncLimitAutoTrackState = vi.fn();
    const updateLimitPriceEntryUi = vi.fn();
    const applyPreviewButtonVisibility = vi.fn();
    const resetUserEditedPrice = vi.fn();
    const cachedCandles = [{ t: 1, c: '100' }];
    const getCachedCandles = vi.fn(() => cachedCandles);

    const runtime = createTimeframeSwitchRuntime({
      loadMarketActions,
      fetchCandles,
      applyTimeframeTabButton,
      reconcileTimeframePreview,
      clearScalePreview,
      syncLimitPreviewLevels,
      syncLimitAutoTrackState,
      updateLimitPriceEntryUi,
      applyPreviewButtonVisibility,
      resetUserEditedPrice,
      getCachedCandles,
    });

    const started = runtime.setTimeframe('1m', document.createElement('button'));
    await Promise.resolve();

    expect(started).toBe(true);
    expect(loadMarketActions).toHaveBeenCalledTimes(1);
    expect(cancelPendingRenders).toHaveBeenCalledTimes(1);
    expect(beginTimeframeSwitch).toHaveBeenCalledWith(expect.objectContaining({
      timeframe: '1m',
      currentCoin: 'BTC',
      currentOrderType: 'limit',
      applyTimeframeTabButton,
      reconcileTimeframePreview,
      clearScalePreview,
      syncLimitPreviewLevels,
      syncLimitAutoTrackState,
      updateLimitPriceEntryUi,
      applyPreviewButtonVisibility,
      resetUserEditedPrice,
      setCurrentTimeframe,
      setLimitAutoTrackForTimeframe,
      setActiveCandleRequestToken,
      clearAllPreviewSync: clearAllPreview,
      getChartPreviewLevels,
      setMarketCandles,
      initialCandles: cachedCandles,
      setDesiredMarketSubscription,
      beginChartSession,
      clearHistoryLoadState,
      requestChartRefresh: expect.any(Function),
    }));
    expect(completeTimeframeSwitch).toHaveBeenCalledWith({
      currentCoin: 'BTC',
      timeframe: '1m',
      requestToken: 'token-1',
      getActiveCandleRequestToken,
      fetchCandles,
      fetchOptions: {},
      completeChartSession,
      failChartSession,
      loadMarketActions,
      requestChartRefresh: expect.any(Function),
    });
  });

  it('does not restart the chart session when the active timeframe is clicked', async () => {
    const { createTimeframeSwitchRuntime } = await import('../ticket-timeframe-runtime.js');
    const applyTimeframeTabButton = vi.fn();
    const runtime = createTimeframeSwitchRuntime({
      loadMarketActions: vi.fn(),
      applyTimeframeTabButton,
    });
    const tab = document.createElement('button');

    expect(runtime.setTimeframe('2h', tab)).toBe(false);
    expect(applyTimeframeTabButton).toHaveBeenCalledWith(tab);
    expect(shouldStartTimeframeSwitch).not.toHaveBeenCalled();
    expect(beginTimeframeSwitch).not.toHaveBeenCalled();
    expect(completeTimeframeSwitch).not.toHaveBeenCalled();
  });

  it('lets a final active-tab click cancel a queued timeframe intent', async () => {
    vi.useFakeTimers();
    shouldStartTimeframeSwitch.mockReturnValue(false);
    const { createTimeframeSwitchRuntime } = await import('../ticket-timeframe-runtime.js');
    const runtime = createTimeframeSwitchRuntime({ loadMarketActions: vi.fn() });

    runtime.setTimeframe('5m', document.createElement('button'));
    runtime.setTimeframe('2h', document.createElement('button'));
    await vi.advanceTimersByTimeAsync(200);

    expect(beginTimeframeSwitch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('coalesces a blocked timeframe switch and runs the latest intent', async () => {
    vi.useFakeTimers();
    shouldStartTimeframeSwitch.mockReturnValue(false);
    const { createTimeframeSwitchRuntime } = await import('../ticket-timeframe-runtime.js');
    const loadMarketActions = vi.fn().mockResolvedValue({});

    const runtime = createTimeframeSwitchRuntime({
      loadMarketActions,
      reconcileTimeframePreview: vi.fn(),
      clearScalePreview: vi.fn(),
      syncLimitPreviewLevels: vi.fn(),
      syncLimitAutoTrackState: vi.fn(),
      updateLimitPriceEntryUi: vi.fn(),
      applyPreviewButtonVisibility: vi.fn(),
      resetUserEditedPrice: vi.fn(),
    });

    const started = runtime.setTimeframe('1m', document.createElement('button'));

    expect(started).toBe(false);
    expect(loadMarketActions).not.toHaveBeenCalled();
    expect(beginTimeframeSwitch).not.toHaveBeenCalled();
    expect(completeTimeframeSwitch).not.toHaveBeenCalled();

    shouldStartTimeframeSwitch.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(beginTimeframeSwitch).toHaveBeenCalledWith(expect.objectContaining({
      timeframe: '1m',
      currentCoin: 'BTC',
    }));
    expect(completeTimeframeSwitch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
