/**
 * Market mispricing service - polls close-based reference rows for supported
 * closed-session markets. Live midpoint recomputation happens in the renderer.
 */

function createMispricingService({
  apiGet,
  applyMispricing = () => {},
  // Refresh marks and session-close references; allMids repaints independently.
  intervalMs = 15000,
  // Keep startup staggered behind the active chart and metadata boot.
  startDelayMs = 15000,
  setIntervalFn = (cb, ms) => globalThis.setInterval(cb, ms),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
  setTimeoutFn = (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
} = {}) {
  let intervalId = null;
  let startTimer = null;

  async function fetchMispricing() {
    try {
      const data = await apiGet('/api/stock-mispricing');
      const entries = Array.isArray(data) ? data : [];
      applyMispricing(entries);
      return entries;
    } catch (_error) {
      // Endpoint unavailable; leave the existing snapshot in place.
    }
    return null;
  }

  function startMispricingPolling() {
    startTimer = setTimeoutFn(() => {
      startTimer = null;
      fetchMispricing();
      intervalId = setIntervalFn(fetchMispricing, intervalMs);
    }, startDelayMs);
  }

  function stopMispricingPolling() {
    if (startTimer) {
      clearTimeoutFn(startTimer);
      startTimer = null;
    }
    if (intervalId) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
  }

  return {
    fetchMispricing,
    startMispricingPolling,
    stopMispricingPolling,
  };
}

export {
  createMispricingService,
};
