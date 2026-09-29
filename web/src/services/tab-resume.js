import { scheduleFrame } from '../utils/frame.js';
import { recordResumeEvent } from './transport-metrics.js';
import { getPriceFeed as getStrategyHostPriceFeed } from '../state/strategy-host.js';

export const TAB_RESUME_MIN_INTERVAL_MS = 5000;
export const TAB_RESUME_STREAM_STALE_MS = 45000;
// Market heartbeats are frequent while the browser is running. If that clock
// is older than one resume throttle window, the page may have been suspended
// even though the active display candle still belongs to the current 4h/8h/1d
// bucket. Force a snapshot so a missed composite CVD revision cannot be frozen
// into history when the next bucket opens.
export const TAB_RESUME_CANDLE_STALE_MS = TAB_RESUME_MIN_INTERVAL_MS;
const FORCE_RECONNECT_REASONS = new Set(['online', 'pageshow-bfcache']);

export function createTabResumeRecoverer({
  getNow = () => Date.now(),
  minIntervalMs = TAB_RESUME_MIN_INTERVAL_MS,
  streamStaleMs = TAB_RESUME_STREAM_STALE_MS,
  candleStaleMs = TAB_RESUME_CANDLE_STALE_MS,
  getWalletAddress = () => '',
  beginRecoveryOverlay = () => 0,
  restoreBackendSession = () => null,
  getSocketClosedState = () => globalThis.WebSocket?.CLOSED,
  getAccountStreamSocket = () => null,
  getAccountStreamMessageAgeMs = () => Number.POSITIVE_INFINITY,
  getChartCanvas = () => globalThis.document?.getElementById?.('chartCanvas') || null,
  getChartWrap = () => globalThis.document?.getElementById?.('chartWrap') || null,
  getPriceFeed = () => getStrategyHostPriceFeed(),
  getCurrentPrice = () => 0,
  connectAccountStream = () => {},
  refreshAccountStream = () => {},
  resetStreamBackoff = () => {},
  getMarketStreamSocket = () => null,
  getMarketStreamMessageAgeMs = () => Number.POSITIVE_INFINITY,
  connectMarketStream = () => {},
  refreshMarketStream = () => {},
  resetMarketStreamBackoff = () => {},
  recoverStaleCandles = () => {},
  recoverChartSurface = () => {},
  fetchAccount = () => {},
  refreshBotStatus = () => {},
  refreshExchangeInfo = () => Promise.resolve(),
  refreshTopMovers = () => Promise.resolve(),
  refresh24hChanges = () => Promise.resolve(),
  refreshMispricing = () => Promise.resolve(),
  ensureRadarNewsCoverage = () => Promise.resolve(),
  startNewsPolling = () => {},
  renderActiveTab = () => {},
  renderPositions = () => {},
  renderOrders = () => {},
  renderFills = () => {},
  renderLiquidations = () => {},
  renderOrderFlow = () => {},
  renderSignalRadar = () => {},
  renderDeploySizingControls = () => {},
  renderTwapStatus = () => {},
  updateTabCounts = () => {},
  syncLimitAutoTrackState = () => false,
  isMarketRadarConnected = () => false,
  initChart = () => {},
  drawChart = () => {},
  scheduleRender = () => {},
  scheduleSignalRadarRender = () => {},
  scheduleChartRender = () => {},
  getCurrentCoin = () => 'BTC',
  requestFrame = (cb) => scheduleFrame(cb),
  scheduleTimeout = (cb, ms) => globalThis.setTimeout(cb, ms),
} = {}) {
  let lastTabResumeAt = 0;
  let repaintTimeoutId = null;

  function repaintVisibleState() {
    const chartWrap = getChartWrap();
    if (chartWrap?.offsetWidth && chartWrap?.offsetHeight && !getChartCanvas()) {
      initChart();
    }

    renderActiveTab();
    renderLiquidations();
    renderOrderFlow();
    renderSignalRadar();
    renderDeploySizingControls();
    renderTwapStatus();
    updateTabCounts();
    drawChart();
  }

  function refreshPriceFeedTimestamp() {
    const priceFeed = getPriceFeed();
    if (!priceFeed) return;
    // Do not stamp the last known price as fresh. After sleep that value is
    // pre-wake and must wait for a post-wake tick.
    priceFeed.markForegroundResume?.();
  }

  function runRepaintPass({ radarConnected }) {
    repaintVisibleState();
    scheduleRender();
    if (radarConnected) scheduleSignalRadarRender();
    scheduleChartRender();
  }

  return function recoverAfterTabResume(reason = 'resume') {
    recordResumeEvent('events');
    // Chart GPU/canvas recovery is cheap and must run even when stream recovery
    // is throttled — a dropped rAF during freeze can otherwise stick the queue.
    try { recoverChartSurface(reason); } catch {}
    const now = getNow();
    const forceReconnect = FORCE_RECONNECT_REASONS.has(reason);
    if (!forceReconnect && now - lastTabResumeAt < minIntervalMs) return;
    lastTabResumeAt = now;
    resetStreamBackoff(reason);
    resetMarketStreamBackoff(reason);

    const marketSocket = getMarketStreamSocket();
    const marketMessageAgeMs = getMarketStreamMessageAgeMs();
    const marketClosed = !marketSocket || marketSocket.readyState === getSocketClosedState();
    const marketStale = marketMessageAgeMs > streamStaleMs;
    const candleStateUnknown = marketClosed || marketMessageAgeMs > candleStaleMs || forceReconnect;
    if (forceReconnect) refreshMarketStream(reason);
    else if (marketClosed) connectMarketStream(reason);
    else if (marketStale) refreshMarketStream(reason);

    if (getWalletAddress()) {
      const accountStreamSocket = getAccountStreamSocket();
      const socketState = accountStreamSocket?.readyState;
      const closedState = getSocketClosedState();
      const messageAgeMs = getAccountStreamMessageAgeMs();
      const streamIsClosed = !accountStreamSocket || socketState === closedState;
      const streamIsStale = Number.isFinite(messageAgeMs) && messageAgeMs > streamStaleMs;
      const shouldRestoreBackendSession = streamIsClosed || streamIsStale || forceReconnect;

      if (streamIsClosed) recordResumeEvent('closedRecoveries');
      else if (streamIsStale) recordResumeEvent('staleRecoveries');
      else recordResumeEvent('healthyRecoveries');

      if (shouldRestoreBackendSession) {
        // Only a genuinely broken stream arms the overlay; the next stream
        // message (or socket open + initial snapshot) finishes it.
        beginRecoveryOverlay();
        recordResumeEvent('overlayArmed');
        Promise.resolve(restoreBackendSession()).catch?.(() => {});
        if (streamIsClosed) {
          connectAccountStream(reason);
        } else {
          refreshAccountStream(reason);
        }
      } else {
        recordResumeEvent('silentRecoveries');
        Promise.resolve(fetchAccount(false)).catch?.(() => {});
      }
    } else {
      recordResumeEvent('silentRecoveries');
    }

    recoverStaleCandles(now, { forceAuthoritative: candleStateUnknown });
    refreshBotStatus();
    refreshPriceFeedTimestamp();
    refreshExchangeInfo(getCurrentCoin(), { includeActiveAssetData: false }).catch?.(() => {});
    const radarConnected = isMarketRadarConnected();
    if (radarConnected) {
      ensureRadarNewsCoverage({ force: true }).catch?.(() => {});
      startNewsPolling();
    }
    refreshTopMovers().catch?.(() => {});
    refresh24hChanges().catch?.(() => {});
    refreshMispricing().catch?.(() => {});
    syncLimitAutoTrackState();
    runRepaintPass({ radarConnected });

    requestFrame(() => {
      runRepaintPass({ radarConnected });
    });

    if (repaintTimeoutId) {
      clearTimeout(repaintTimeoutId);
    }
    repaintTimeoutId = scheduleTimeout(() => {
      repaintTimeoutId = null;
      runRepaintPass({ radarConnected });
    }, 150);
  };
}
