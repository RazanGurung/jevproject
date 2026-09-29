import { beginChartSession, completeChartSession, failChartSession } from '../state/chart-session.js';
import { setDesiredMarketSubscription } from '../state/market-subscription-state.js';
import { clearAllPreview, getChartPreviewLevels } from '../state/preview-state.js';
import { setMarketCandles } from '../state/market-state.js';
import {
  getEffectiveCurrentCoin,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentTimeframe,
} from '../state/effective-trading.js';
import { getActiveCandleRequestToken, setActiveCandleRequestToken, setLimitAutoTrackForTimeframe } from '../state/trading-runtime.js';
import { setCurrentTimeframe } from '../state/store.js';
import { clearHistoryLoadState, updateChart } from '../chart/chart-render.js';
import { prefetchAdjacentTimeframes } from '../services/chart-candle-service.js';
import {
  cancelPendingMarketRenders,
  requestChartCandles,
} from '../services/market-session.js';
import {
  beginTimeframeSwitch,
  completeTimeframeSwitch,
  shouldStartTimeframeSwitch,
} from './ticket-chart-actions.js';
import { markUiPerformance } from '../utils/performance.js';

function createTimeframeSwitchRuntime({
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
} = {}) {
  let pendingTimeframeSwitch = null;
  let pendingTimeframeTimer = null;

  // Prefer injected loaders (tests + tabs wiring); fall back to market-session
  // so pure UI paths never need a direct market-ws import.
  const resolveMarketActions = typeof loadMarketActions === 'function'
    ? loadMarketActions
    : async () => {
      await cancelPendingMarketRenders();
      return { cancelPendingRenders: () => {} };
    };
  const resolveFetchCandles = typeof fetchCandles === 'function'
    ? fetchCandles
    : requestChartCandles;

  function requestChartRefresh() {
    // Timeframe switches must re-fit the full series. scheduleChartRender alone
    // can leave the previous interval's zoom window on screen.
    updateChart();
  }

  function runTimeframeSwitch(timeframe, tabElement) {
    if (pendingTimeframeTimer !== null) {
      clearTimeout(pendingTimeframeTimer);
      pendingTimeframeTimer = null;
    }
    pendingTimeframeSwitch = null;

    resolveMarketActions().then(({ cancelPendingRenders }) => cancelPendingRenders?.());

    const currentCoin = getEffectiveCurrentCoin();
    const currentOrderType = getEffectiveCurrentOrderType();
    const cachedCandles = getCachedCandles?.(currentCoin, timeframe);

    markUiPerformance('timeframe-switch-start', {
      coin: currentCoin,
      timeframe,
      previousTimeframe: getEffectiveCurrentTimeframe(),
    });
    const requestToken = beginTimeframeSwitch({
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
      clearAllPreviewSync: clearAllPreview,
      clearScalePreview,
      getChartPreviewLevels,
      syncLimitAutoTrackState,
      updateLimitPriceEntryUi,
      applyPreviewButtonVisibility,
      setMarketCandles,
      initialCandles: Array.isArray(cachedCandles) ? cachedCandles : [],
      setDesiredMarketSubscription,
      beginChartSession,
      clearHistoryLoadState,
      requestChartRefresh,
    });
    markUiPerformance('timeframe-switch-commit', {
      coin: currentCoin,
      timeframe,
      cachedCandles: Array.isArray(cachedCandles) ? cachedCandles.length : 0,
    });

    completeTimeframeSwitch({
      currentCoin,
      timeframe,
      requestToken,
      getActiveCandleRequestToken,
      // Market session owns backend candle fetch when no custom fetcher is injected.
      fetchCandles: resolveFetchCandles,
      fetchOptions: {},
      completeChartSession,
      failChartSession,
      loadMarketActions: resolveMarketActions,
      requestChartRefresh,
    });

    // Warm the neighbouring timeframes on idle so the next flip is instant.
    prefetchAdjacentTimeframes({ coin: currentCoin, timeframe });

    return true;
  }

  function flushPendingTimeframeSwitch() {
    pendingTimeframeTimer = null;
    const pending = pendingTimeframeSwitch;
    if (!pending) return;
    if (!shouldStartTimeframeSwitch()) {
      pendingTimeframeTimer = setTimeout(flushPendingTimeframeSwitch, 100);
      return;
    }
    runTimeframeSwitch(pending.timeframe, pending.tabElement);
  }

  function setTimeframe(timeframe, tabElement) {
    // Clicking the already-selected interval is a UI no-op. Besides avoiding a
    // redundant candle fetch/session reset, this also lets a final click on the
    // active tab cancel a rapidly queued interval change.
    if (timeframe === getEffectiveCurrentTimeframe()) {
      pendingTimeframeSwitch = null;
      if (pendingTimeframeTimer !== null) {
        clearTimeout(pendingTimeframeTimer);
        pendingTimeframeTimer = null;
      }
      applyTimeframeTabButton?.(tabElement);
      return false;
    }
    if (shouldStartTimeframeSwitch()) {
      return runTimeframeSwitch(timeframe, tabElement);
    }

    // Do not drop the user's final selection during rapid tab/coin churn. The
    // active request token makes stale fetch completions harmless; this short
    // trailing coalesce keeps the request volume bounded while preserving the
    // latest intent.
    pendingTimeframeSwitch = { timeframe, tabElement };
    if (pendingTimeframeTimer !== null) clearTimeout(pendingTimeframeTimer);
    pendingTimeframeTimer = setTimeout(flushPendingTimeframeSwitch, 100);
    return false;
  }

  return {
    setTimeframe,
  };
}

export {
  createTimeframeSwitchRuntime,
};
