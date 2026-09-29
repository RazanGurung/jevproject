import { describe, expect, it, vi } from 'vitest';
import { createTabResumeRecoverer } from '../tab-resume.js';

describe('tab resume recovery', () => {
  it('keeps a healthy stream and redraws current visuals on tab return', () => {
    const calls = {
      restoreBackendSession: vi.fn(),
      refreshAccountStream: vi.fn(),
      connectAccountStream: vi.fn(),
      fetchAccount: vi.fn(),
      refreshBotStatus: vi.fn(),
      refreshExchangeInfo: vi.fn(() => Promise.resolve()),
      ensureRadarNewsCoverage: vi.fn(() => Promise.resolve()),
      startNewsPolling: vi.fn(),
      renderActiveTab: vi.fn(),
      renderPositions: vi.fn(),
      renderOrders: vi.fn(),
      renderFills: vi.fn(),
      renderOrderFlow: vi.fn(),
      renderSignalRadar: vi.fn(),
      renderDeploySizingControls: vi.fn(),
      renderTwapStatus: vi.fn(),
      updateTabCounts: vi.fn(),
      syncLimitAutoTrackState: vi.fn(),
      initChart: vi.fn(),
      drawChart: vi.fn(),
      scheduleRender: vi.fn(),
      scheduleSignalRadarRender: vi.fn(),
      scheduleChartRender: vi.fn(),
      requestFrame: vi.fn((cb) => cb()),
      scheduleTimeout: vi.fn((cb) => {
        cb();
        return 1;
      }),
    };

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 10_000,
      getWalletAddress: () => '0xabc',
      restoreBackendSession: calls.restoreBackendSession,
      getAccountStreamSocket: () => ({ readyState: 1 }),
      getSocketClosedState: () => 2,
      getAccountStreamMessageAgeMs: () => 1000,
      getChartWrap: () => ({ offsetWidth: 100, offsetHeight: 100 }),
      getChartCanvas: () => ({ getContext: () => ({}) }),
      connectAccountStream: calls.connectAccountStream,
      refreshAccountStream: calls.refreshAccountStream,
      fetchAccount: calls.fetchAccount,
      refreshBotStatus: calls.refreshBotStatus,
      refreshExchangeInfo: calls.refreshExchangeInfo,
      ensureRadarNewsCoverage: calls.ensureRadarNewsCoverage,
      startNewsPolling: calls.startNewsPolling,
      renderActiveTab: calls.renderActiveTab,
      renderPositions: calls.renderPositions,
      renderOrders: calls.renderOrders,
      renderFills: calls.renderFills,
      renderOrderFlow: calls.renderOrderFlow,
      renderSignalRadar: calls.renderSignalRadar,
      renderDeploySizingControls: calls.renderDeploySizingControls,
      renderTwapStatus: calls.renderTwapStatus,
      updateTabCounts: calls.updateTabCounts,
      syncLimitAutoTrackState: calls.syncLimitAutoTrackState,
      isMarketRadarConnected: () => true,
      initChart: calls.initChart,
      drawChart: calls.drawChart,
      scheduleRender: calls.scheduleRender,
      scheduleSignalRadarRender: calls.scheduleSignalRadarRender,
      scheduleChartRender: calls.scheduleChartRender,
      getCurrentCoin: () => 'ETH',
      requestFrame: calls.requestFrame,
      scheduleTimeout: calls.scheduleTimeout,
    });

    recoverAfterTabResume('focus');

    expect(calls.refreshAccountStream).not.toHaveBeenCalled();
    expect(calls.connectAccountStream).not.toHaveBeenCalled();
    expect(calls.restoreBackendSession).not.toHaveBeenCalled();
    expect(calls.fetchAccount).toHaveBeenCalledWith(false);
    expect(calls.refreshExchangeInfo).toHaveBeenCalledWith('ETH', { includeActiveAssetData: false });
    expect(calls.ensureRadarNewsCoverage).toHaveBeenCalledWith({ force: true });
    expect(calls.syncLimitAutoTrackState).toHaveBeenCalledOnce();
    expect(calls.renderActiveTab).toHaveBeenCalledTimes(3);
    expect(calls.renderPositions).not.toHaveBeenCalled();
    expect(calls.renderOrders).not.toHaveBeenCalled();
    expect(calls.renderFills).not.toHaveBeenCalled();
    expect(calls.renderOrderFlow).toHaveBeenCalledTimes(3);
    expect(calls.renderSignalRadar).toHaveBeenCalledTimes(3);
    expect(calls.renderDeploySizingControls).toHaveBeenCalledTimes(3);
    expect(calls.renderTwapStatus).toHaveBeenCalledTimes(3);
    expect(calls.updateTabCounts).toHaveBeenCalledTimes(3);
    expect(calls.initChart).not.toHaveBeenCalled();
    expect(calls.drawChart).toHaveBeenCalledTimes(3);
    expect(calls.scheduleRender).toHaveBeenCalledTimes(3);
    expect(calls.scheduleSignalRadarRender).toHaveBeenCalledTimes(3);
    expect(calls.scheduleChartRender).toHaveBeenCalledTimes(3);
    expect(calls.requestFrame).toHaveBeenCalledOnce();
    expect(calls.scheduleTimeout).toHaveBeenCalledOnce();
  });

  it('opens a new stream when the prior socket is closed', () => {
    const restoreBackendSession = vi.fn();
    const connectAccountStream = vi.fn();
    const refreshAccountStream = vi.fn();
    const fetchAccount = vi.fn();

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 20_000,
      getWalletAddress: () => '0xabc',
      restoreBackendSession,
      getAccountStreamSocket: () => ({ readyState: 2 }),
      getSocketClosedState: () => 2,
      connectAccountStream,
      refreshAccountStream,
      fetchAccount,
    });

    recoverAfterTabResume('visibilitychange');

    expect(restoreBackendSession).toHaveBeenCalledOnce();
    expect(connectAccountStream).toHaveBeenCalledOnce();
    expect(refreshAccountStream).not.toHaveBeenCalled();
    expect(fetchAccount).not.toHaveBeenCalled();
  });

  it('refreshes the stream when the prior socket is stale on tab return', () => {
    const restoreBackendSession = vi.fn();
    const connectAccountStream = vi.fn();
    const refreshAccountStream = vi.fn();
    const fetchAccount = vi.fn();

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 25_000,
      streamStaleMs: 5_000,
      getWalletAddress: () => '0xabc',
      restoreBackendSession,
      getAccountStreamSocket: () => ({ readyState: 1 }),
      getSocketClosedState: () => 2,
      getAccountStreamMessageAgeMs: () => 8_000,
      connectAccountStream,
      refreshAccountStream,
      fetchAccount,
    });

    recoverAfterTabResume('focus');

    expect(restoreBackendSession).toHaveBeenCalledOnce();
    expect(connectAccountStream).not.toHaveBeenCalled();
    expect(refreshAccountStream).toHaveBeenCalledOnce();
    expect(fetchAccount).not.toHaveBeenCalled();
  });

  it('restores the backend session in parallel with reconnecting account data after tab return', async () => {
    const callOrder = [];
    let releaseRestore;
    const restoreBackendSession = vi.fn(() => new Promise((resolve) => {
      releaseRestore = () => {
        callOrder.push('restore:resolved');
        resolve(true);
      };
    }));
    const connectAccountStream = vi.fn(() => {
      callOrder.push('connect');
    });
    const fetchAccount = vi.fn(() => {
      callOrder.push('fetch');
    });

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 27_000,
      getWalletAddress: () => '0xabc',
      restoreBackendSession: () => {
        callOrder.push('restore:start');
        return restoreBackendSession();
      },
      getAccountStreamSocket: () => ({ readyState: 2 }),
      getSocketClosedState: () => 2,
      connectAccountStream,
      fetchAccount,
    });

    recoverAfterTabResume('focus');

    expect(callOrder).toEqual(['restore:start', 'connect']);
    expect(connectAccountStream).toHaveBeenCalledOnce();
    expect(fetchAccount).not.toHaveBeenCalled();

    releaseRestore();
    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder).toEqual(['restore:start', 'connect', 'restore:resolved']);
  });

  it('throttles repeated tab resume events inside the minimum interval', () => {
    let now = 30_000;
    const refreshAccountStream = vi.fn();
    const recoverChartSurface = vi.fn();

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => now,
      streamStaleMs: 5_000,
      getWalletAddress: () => '0xabc',
      getAccountStreamSocket: () => ({ readyState: 1 }),
      getSocketClosedState: () => 2,
      getAccountStreamMessageAgeMs: () => 8_000,
      refreshAccountStream,
      recoverChartSurface,
      fetchAccount: vi.fn(),
    });

    recoverAfterTabResume('focus');
    now += 1000;
    recoverAfterTabResume('pageshow');

    expect(refreshAccountStream).toHaveBeenCalledOnce();
    expect(recoverChartSurface).toHaveBeenCalledTimes(2);
    expect(recoverChartSurface).toHaveBeenNthCalledWith(2, 'pageshow');
  });

  it('recycles a zombie market socket on online and bfcache even inside the throttle window', () => {
    let now = 31_000;
    const refreshMarketStream = vi.fn();
    const connectMarketStream = vi.fn();
    const recoverStaleCandles = vi.fn();

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => now,
      streamStaleMs: 45_000,
      candleStaleMs: 5_000,
      getMarketStreamSocket: () => ({ readyState: 1 }),
      getMarketStreamMessageAgeMs: () => 800,
      getSocketClosedState: () => 2,
      refreshMarketStream,
      connectMarketStream,
      recoverStaleCandles,
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn(() => 1),
    });

    recoverAfterTabResume('focus');
    now += 200;
    recoverAfterTabResume('online');

    expect(connectMarketStream).not.toHaveBeenCalled();
    expect(refreshMarketStream).toHaveBeenCalledWith('online');
    expect(recoverStaleCandles).toHaveBeenLastCalledWith(31_200, { forceAuthoritative: true });
  });

  it('refreshes the shared price feed through the injected getter on resume', () => {
    const priceFeed = {
      markForegroundResume: vi.fn(),
      touch: vi.fn(),
    };

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 35_000,
      getPriceFeed: () => priceFeed,
      getCurrentCoin: () => 'BTC',
      getCurrentPrice: () => 102.5,
    });

    recoverAfterTabResume('focus');

    expect(priceFeed.markForegroundResume).toHaveBeenCalledOnce();
    expect(priceFeed.touch).not.toHaveBeenCalled();
  });

  it('allows the active bottom tab renderer to decide which panel to repaint', () => {
    const renderActiveTab = vi.fn();
    const renderPositions = vi.fn();
    const renderOrders = vi.fn();
    const renderFills = vi.fn();

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 40_000,
      renderActiveTab,
      renderPositions,
      renderOrders,
      renderFills,
    });

    recoverAfterTabResume('focus');

    expect(renderActiveTab).toHaveBeenCalledOnce();
    expect(renderPositions).not.toHaveBeenCalled();
    expect(renderOrders).not.toHaveBeenCalled();
    expect(renderFills).not.toHaveBeenCalled();
  });

  it('starts the recovery overlay and leaves stream-backed completion to live transport recovery', async () => {
    const beginRecoveryOverlay = vi.fn(() => 42);
    const finishRecoveryOverlay = vi.fn();
    const fetchAccount = vi.fn(() => Promise.resolve());

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 45_000,
      getWalletAddress: () => '0xabc',
      beginRecoveryOverlay,
      finishRecoveryOverlay,
      getAccountStreamSocket: () => ({ readyState: 2 }),
      getSocketClosedState: () => 2,
      connectAccountStream: vi.fn(),
      fetchAccount,
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn((cb) => {
        cb();
        return 1;
      }),
    });

    recoverAfterTabResume('focus');
    await Promise.resolve();
    await Promise.resolve();

    expect(beginRecoveryOverlay).toHaveBeenCalledOnce();
    expect(finishRecoveryOverlay).not.toHaveBeenCalledWith(42);
  });

  it('never arms the recovery overlay when the stream is healthy on tab return', () => {
    const beginRecoveryOverlay = vi.fn(() => 42);
    const fetchAccount = vi.fn(() => Promise.resolve());

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 46_000,
      getWalletAddress: () => '0xabc',
      beginRecoveryOverlay,
      getAccountStreamSocket: () => ({ readyState: 1 }),
      getSocketClosedState: () => 2,
      getAccountStreamMessageAgeMs: () => 1000,
      fetchAccount,
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn(() => 1),
    });

    recoverAfterTabResume('focus');

    expect(beginRecoveryOverlay).not.toHaveBeenCalled();
    expect(fetchAccount).toHaveBeenCalledWith(false);
  });

  it('never arms the recovery overlay when no wallet is connected', () => {
    const beginRecoveryOverlay = vi.fn(() => 42);

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 47_000,
      getWalletAddress: () => '',
      beginRecoveryOverlay,
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn(() => 1),
    });

    recoverAfterTabResume('focus');

    expect(beginRecoveryOverlay).not.toHaveBeenCalled();
  });

  it('resets stream backoff and probes stale candles on every recovery pass', () => {
    const resetStreamBackoff = vi.fn();
    const recoverStaleCandles = vi.fn();

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 48_000,
      getWalletAddress: () => '0xabc',
      getAccountStreamSocket: () => ({ readyState: 1 }),
      getSocketClosedState: () => 2,
      getAccountStreamMessageAgeMs: () => 1000,
      getMarketStreamSocket: () => ({ readyState: 1 }),
      getMarketStreamMessageAgeMs: () => 1000,
      resetStreamBackoff,
      recoverStaleCandles,
      fetchAccount: vi.fn(() => Promise.resolve()),
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn(() => 1),
    });

    recoverAfterTabResume('focus');

    expect(resetStreamBackoff).toHaveBeenCalledWith('focus');
    expect(recoverStaleCandles).toHaveBeenCalledWith(48_000, { forceAuthoritative: false });
  });

  it('forces an authoritative candle snapshot when foreground return reveals a suspended market clock', () => {
    const refreshMarketStream = vi.fn();
    const recoverStaleCandles = vi.fn();

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 49_000,
      streamStaleMs: 45_000,
      candleStaleMs: 5_000,
      getMarketStreamSocket: () => ({ readyState: 1 }),
      getMarketStreamMessageAgeMs: () => 10_000,
      getSocketClosedState: () => 2,
      refreshMarketStream,
      recoverStaleCandles,
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn(() => 1),
    });

    recoverAfterTabResume('visibilitychange');

    // A ten-second suspension does not churn the healthy socket, but it does
    // make the current candle's CVD enrichment untrustworthy until REST repair.
    expect(refreshMarketStream).not.toHaveBeenCalled();
    expect(recoverStaleCandles).toHaveBeenCalledWith(49_000, { forceAuthoritative: true });
  });

  it('re-initializes the chart when the canvas is missing on tab return', () => {
    const initChart = vi.fn();
    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 50_000,
      getChartWrap: () => ({ offsetWidth: 100, offsetHeight: 100 }),
      getChartCanvas: () => null,
      initChart,
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn(() => 1),
    });

    recoverAfterTabResume('focus');

    expect(initChart).toHaveBeenCalledOnce();
  });

  it('marks resume without forging last-price freshness', () => {
    const touch = vi.fn();
    const markForegroundResume = vi.fn();
    const previousWindow = globalThis.window;
    globalThis.window = { ...(previousWindow || {}), PriceFeed: { touch, markForegroundResume } };

    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => 60_000,
      getCurrentCoin: () => 'BTC',
      getCurrentPrice: () => 105000,
      requestFrame: vi.fn(),
      scheduleTimeout: vi.fn(() => 1),
    });

    recoverAfterTabResume('focus');

    expect(markForegroundResume).toHaveBeenCalledOnce();
    expect(touch).not.toHaveBeenCalled();
    globalThis.window = previousWindow;
  });
});
