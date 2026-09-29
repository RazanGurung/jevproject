/**
 * Top movers service - polls /api/market-movers and applies the two topbar rows
 * (top gainers / top losers). The backend owns the ranking (high-OI cohort →
 * gainers/losers split); this service only fetches and forwards the result.
 */

function createTopMoversService({
  apiGet,
  applyMovers = () => {},
  intervalMs = 60000,
  setIntervalFn = (cb, ms) => globalThis.setInterval(cb, ms),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
  setTimeoutFn = (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
} = {}) {
  let intervalId = null;
  let retryTimer = null;
  let retryCount = 0;
  const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

  function clearRetry() {
    if (retryTimer) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
  }

  async function fetchTopMovers() {
    try {
      const data = await apiGet('/api/market-movers');
      const gainers = Array.isArray(data?.gainers) ? data.gainers : [];
      const losers = Array.isArray(data?.losers) ? data.losers : [];
      if (gainers.length > 0 || losers.length > 0) {
        retryCount = 0;
        clearRetry();
        applyMovers(gainers, losers);
        return { gainers, losers };
      }
      // If data is empty (e.g. backend still warming asset contexts on startup),
      // schedule an immediate quick retry instead of waiting a whole minute.
      if (retryCount < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[retryCount++];
        clearRetry();
        retryTimer = setTimeoutFn(fetchTopMovers, delay);
      }
      applyMovers(gainers, losers);
      return { gainers, losers };
    } catch (_error) {
      // Movers endpoint unavailable; schedule retry on early startup.
      if (retryCount < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[retryCount++];
        clearRetry();
        retryTimer = setTimeoutFn(fetchTopMovers, delay);
      }
    }
    return null;
  }

  function startTopMoversPolling() {
    clearRetry();
    retryCount = 0;
    fetchTopMovers();
    if (!intervalId) {
      intervalId = setIntervalFn(fetchTopMovers, intervalMs);
    }
  }

  function stopTopMoversPolling() {
    clearRetry();
    if (intervalId) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
  }

  return {
    fetchTopMovers,
    startTopMoversPolling,
    stopTopMoversPolling,
  };
}

export {
  createTopMoversService,
};
