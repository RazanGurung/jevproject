import { loadActiveChartSession } from '../services/chart-load-session.js';
import { getPaletteColor } from '../services/color-palette.js';

const TIMEFRAME_SWITCH_DEBOUNCE_MS = 100;
let lastTimeframeSwitchAt = 0;

function previewLimitOrderOnChart({
  currentTimeframe,
  sizeUsd,
  limitPx,
  currentSide,
  setChartPreviewLevels,
  requestChartRefresh,
  showToast,
} = {}) {
  if (currentTimeframe === '1m') {
    showToast?.('1m chart uses auto-tracking. Price updates automatically.', false);
    return false;
  }

  if (!(sizeUsd > 0) || !(limitPx > 0)) {
    showToast?.('Error: Enter size and price', true);
    return false;
  }

  setChartPreviewLevels?.([{
    price: limitPx,
    label: `${currentSide === 'buy' ? 'BUY' : 'SELL'} $${sizeUsd.toFixed(0)}`,
    color: getPaletteColor(currentSide === 'buy' ? 'bullish' : 'bearish'),
    lineWidth: 1.5,
    lineDash: [4, 3],
    isPreview: true,
    isBuy: currentSide === 'buy',
    priority: 4,
  }]);

  requestChartRefresh?.();
  showToast?.('Preview shown. Click Place Order to send.', false);
  return true;
}

function shouldStartTimeframeSwitch(now = Date.now()) {
  if (now - lastTimeframeSwitchAt < TIMEFRAME_SWITCH_DEBOUNCE_MS) {
    return false;
  }
  lastTimeframeSwitchAt = now;
  return true;
}

function resetTimeframeSwitchDebounceForTests() {
  lastTimeframeSwitchAt = 0;
}

function beginTimeframeSwitch({
  timeframe,
  tabElement,
  currentCoin,
  currentOrderType,
  setCurrentTimeframe,
  applyTimeframeTabButton,
  reconcileTimeframePreview,
  setLimitAutoTrackForTimeframe,
  resetUserEditedPrice,
  setActiveCandleRequestToken,
  syncLimitPreviewLevels,
  clearAllPreviewSync,
  clearScalePreview,
  getChartPreviewLevels,
  syncLimitAutoTrackState,
  updateLimitPriceEntryUi,
  applyPreviewButtonVisibility,
  setMarketCandles,
  initialCandles = [],
  setDesiredMarketSubscription,
  beginChartSession,
  clearHistoryLoadState,
  requestChartRefresh,
} = {}) {
  setCurrentTimeframe?.(timeframe);
  if (typeof window !== 'undefined' && typeof window.onChartTimeframeChanged === 'function') {
    try { window.onChartTimeframeChanged(timeframe); } catch {}
  }
  setDesiredMarketSubscription?.({
    coin: currentCoin,
    interval: timeframe,
  });
  applyTimeframeTabButton?.(tabElement);

  const requestToken = reconcileTimeframePreview?.({
    currentOrderType,
    timeframe,
    setLimitAutoTrackForTimeframe,
    resetUserEditedPrice,
    setActiveCandleRequestToken,
    syncLimitPreviewLevels,
    clearAllPreviewSync,
    clearScalePreview,
    getChartPreviewLevels,
  });

  if (currentOrderType === 'limit' && timeframe === '1m') {
    syncLimitAutoTrackState?.({ requestChartRefresh: true, syncUi: false });
  } else {
    updateLimitPriceEntryUi?.('manual');
  }

  applyPreviewButtonVisibility?.({ orderType: currentOrderType, timeframe });
  setMarketCandles?.(Array.isArray(initialCandles) ? initialCandles : []);
  beginChartSession({
    coin: currentCoin,
    timeframe,
    requestToken,
  });
  clearHistoryLoadState?.(currentCoin, timeframe);
  requestChartRefresh?.();

  return requestToken;
}

async function completeTimeframeSwitch({
  requestToken,
  timeframe,
  currentCoin,
  fetchCandles,
  fetchOptions = {},
  completeChartSession,
  failChartSession,
  getActiveCandleRequestToken,
  loadMarketActions,
  requestChartRefresh,
} = {}) {
  return loadActiveChartSession({
    coin: currentCoin,
    timeframe,
    requestToken,
    getActiveCandleRequestToken,
    fetchCandles,
    fetchOptions,
    subscribeMarket: async () => {
      const { subscribeMarket } = await loadMarketActions();
      return subscribeMarket?.();
    },
    completeChartSession,
    failChartSession,
    requestChartRefresh,
    subscribeWarningPrefix: '[market] subscribeMarket degraded during timeframe switch:',
  });
}

export {
  beginTimeframeSwitch,
  completeTimeframeSwitch,
  previewLimitOrderOnChart,
  resetTimeframeSwitchDebounceForTests,
  shouldStartTimeframeSwitch,
};
