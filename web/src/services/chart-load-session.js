import { markUiPerformance } from '../utils/performance.js';

function hasActiveChartRequest(requestToken, getActiveCandleRequestToken) {
  return getActiveCandleRequestToken?.() === requestToken;
}

async function loadActiveChartSession({
  coin,
  timeframe,
  requestToken,
  getActiveCandleRequestToken,
  fetchCandles,
  fetchOptions = {},
  subscribeMarket,
  subscribeMode = 'afterFetch',
  completeChartSession,
  failChartSession,
  requestChartRefresh,
  updateChart,
  initChart,
  hasChartCanvas = () => Boolean(globalThis.window?.chartCanvas),
  failMessage = 'Chart unavailable',
  subscribeWarningPrefix = '[market] subscribeMarket degraded during chart load:',
  } = {}) {
  const maybeSubscribe = async () => {
    if (typeof subscribeMarket !== 'function') return;
    try {
      await subscribeMarket();
    } catch (error) {
      console.warn(subscribeWarningPrefix, error);
    }
  };

  try {
    if (subscribeMode === 'beforeFetch') {
      // Subscription acknowledgement is transport readiness, not chart
      // readiness. Cached candles can already paint, so do not hold the
      // visual session in "loading" while this background request settles.
      void maybeSubscribe();
    }

    if (typeof fetchCandles === 'function') {
      await fetchCandles({ coin, timeframe, requestToken, ...fetchOptions });
    }

    if (!hasActiveChartRequest(requestToken, getActiveCandleRequestToken)) return false;

    if (subscribeMode !== 'beforeFetch') {
      await maybeSubscribe();
    }

    if (!hasActiveChartRequest(requestToken, getActiveCandleRequestToken)) return false;

    completeChartSession?.({ coin, timeframe, requestToken });
    markUiPerformance('chart-session-ready', { coin, timeframe, requestToken });
    if (typeof initChart === 'function' && !hasChartCanvas()) {
      initChart();
    } else if (typeof updateChart === 'function') {
      // updateChart re-fits when the series span or auto-fit flag demands it.
      updateChart();
    } else {
      requestChartRefresh?.();
    }
    return true;
  } catch (error) {
    if (hasActiveChartRequest(requestToken, getActiveCandleRequestToken)) {
      failChartSession?.({
        coin,
        timeframe,
        requestToken,
        message: failMessage,
      });
      markUiPerformance('chart-session-failed', {
        coin,
        timeframe,
        requestToken,
        message: String(error?.message || error || failMessage),
      });
    }
    return false;
  }
}

export {
  loadActiveChartSession,
};
