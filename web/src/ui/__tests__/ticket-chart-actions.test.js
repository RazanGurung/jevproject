/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('ticket chart actions', () => {
  beforeEach(async () => {
    const { resetTimeframeSwitchDebounceForTests } = await import('../ticket-chart-actions.js');
    resetTimeframeSwitchDebounceForTests();
  });

  it('builds and applies a manual limit preview line for non-1m charts', async () => {
    const { previewLimitOrderOnChart } = await import('../ticket-chart-actions.js');
    const setChartPreviewLevels = vi.fn();
    const requestChartRefresh = vi.fn();
    const showToast = vi.fn();

    const changed = previewLimitOrderOnChart({
      currentTimeframe: '4h',
      sizeUsd: 250,
      limitPx: 123.45,
      currentSide: 'buy',
      setChartPreviewLevels,
      requestChartRefresh,
      showToast,
    });

    expect(changed).toBe(true);
    expect(setChartPreviewLevels).toHaveBeenCalledWith([
      expect.objectContaining({
        price: 123.45,
        label: 'BUY $250',
        isBuy: true,
      }),
    ]);
    expect(requestChartRefresh).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Preview shown. Click Place Order to send.', false);
  });

  it('blocks manual preview placement on 1m charts', async () => {
    const { previewLimitOrderOnChart } = await import('../ticket-chart-actions.js');
    const setChartPreviewLevels = vi.fn();
    const requestChartRefresh = vi.fn();
    const showToast = vi.fn();

    const changed = previewLimitOrderOnChart({
      currentTimeframe: '1m',
      sizeUsd: 250,
      limitPx: 123.45,
      currentSide: 'buy',
      setChartPreviewLevels,
      requestChartRefresh,
      showToast,
    });

    expect(changed).toBe(false);
    expect(setChartPreviewLevels).not.toHaveBeenCalled();
    expect(requestChartRefresh).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('1m chart uses auto-tracking. Price updates automatically.', false);
  });

  it('forces an immediate chart refresh from cached target candles on a timeframe switch', async () => {
    const { beginTimeframeSwitch } = await import('../ticket-chart-actions.js');
    const setCurrentTimeframe = vi.fn();
    const applyTimeframeTabButton = vi.fn();
    const reconcileTimeframePreview = vi.fn(() => 'token-1');
    const setMarketCandles = vi.fn();
    const setDesiredMarketSubscription = vi.fn();
    const beginChartSession = vi.fn();
    const clearHistoryLoadState = vi.fn();
    const requestChartRefresh = vi.fn();
    const initialCandles = [{ t: 1, o: '100', h: '101', l: '99', c: '100' }];

    const requestToken = beginTimeframeSwitch({
      timeframe: '5m',
      tabElement: document.createElement('button'),
      currentCoin: 'BTC',
      currentOrderType: 'market',
      setCurrentTimeframe,
      setDesiredMarketSubscription,
      applyTimeframeTabButton,
      reconcileTimeframePreview,
      setMarketCandles,
      initialCandles,
      beginChartSession,
      clearHistoryLoadState,
      requestChartRefresh,
    });

    expect(requestToken).toBe('token-1');
    expect(setCurrentTimeframe).toHaveBeenCalledWith('5m');
    expect(setDesiredMarketSubscription).toHaveBeenCalledWith({
      coin: 'BTC',
      interval: '5m',
    });
    expect(setMarketCandles).toHaveBeenCalledWith(initialCandles);
    expect(beginChartSession).toHaveBeenCalledWith({
      coin: 'BTC',
      timeframe: '5m',
      requestToken: 'token-1',
    });
    expect(clearHistoryLoadState).toHaveBeenCalledWith('BTC', '5m');
    expect(requestChartRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the chart session ready when realtime subscribe degrades after candles load', async () => {
    const { completeTimeframeSwitch } = await import('../ticket-chart-actions.js');
    const completeChartSession = vi.fn();
    const requestChartRefresh = vi.fn();
    const subscribeMarket = vi.fn().mockRejectedValue(new Error('subscribe failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const completed = await completeTimeframeSwitch({
      requestToken: 'token-1',
      timeframe: '1m',
      currentCoin: 'BTC',
      completeChartSession,
      getActiveCandleRequestToken: () => 'token-1',
      loadMarketActions: async () => ({
        subscribeMarket,
      }),
      requestChartRefresh,
    });

    expect(completed).toBe(true);
    expect(subscribeMarket).toHaveBeenCalledTimes(1);
    expect(completeChartSession).toHaveBeenCalledWith({
      coin: 'BTC',
      timeframe: '1m',
      requestToken: 'token-1',
    });
    expect(requestChartRefresh).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps timeframe switch debounce state module-local instead of on window', async () => {
    const { shouldStartTimeframeSwitch } = await import('../ticket-chart-actions.js');

    expect(shouldStartTimeframeSwitch(1_000)).toBe(true);
    expect(shouldStartTimeframeSwitch(1_050)).toBe(false);
    expect(shouldStartTimeframeSwitch(1_101)).toBe(true);
    expect(window.tfSwitchDebounce).toBeUndefined();
  });
});
