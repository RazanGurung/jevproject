/**
 * Preload hint service - tells the backend which coins are in the user's
 * watchlist so the server-side warm coordinator keeps their charts warm. The
 * watchlist is otherwise localStorage-only and invisible to the backend, so a
 * watchlist coin would be a cold load on first click without this hint.
 *
 * The caller gates this to the PRIMARY tab (like the other scanners) so
 * duplicate tabs don't multiply the POST. The backend ages out hints that stop
 * being asserted, so we re-post on every watchlist change and on a periodic
 * keep-alive. Best-effort: a failed POST just means those coins warm on-demand.
 */
function createPreloadHintService({
  apiPost,
  getWatchlist,
  subscribeWatchlist = () => () => {},
  onAcceptedWatchlist = () => {},
  onStop = () => {},
  keepAliveMs = 120000,
  startDelayMs = 1000,
  setIntervalFn = (cb, ms) => globalThis.setInterval(cb, ms),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
  setTimeoutFn = (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
} = {}) {
  let intervalId = null;
  let startTimer = null;
  let unsubscribe = null;

  async function postWatchlist() {
    const watchlist = getWatchlist().slice(0, 50);
    try {
      const response = await apiPost('/api/preload-hint', { watchlist });
      const acceptedCoins = Array.isArray(response?.acceptedCoins)
        ? response.acceptedCoins.map((coin) => String(coin || '').trim()).filter(Boolean)
        : watchlist.slice(0, Number.isFinite(Number(response?.accepted))
          ? Math.max(0, Math.min(watchlist.length, Number(response.accepted)))
          : watchlist.length);
      onAcceptedWatchlist(acceptedCoins);
    } catch (_error) {
      // Best-effort hint; the coins still warm on-demand when first viewed.
    }
  }

  function startPreloadHints() {
    if (unsubscribe || startTimer || intervalId) return; // already running
    // Re-post immediately whenever the watchlist changes.
    unsubscribe = subscribeWatchlist(() => {
      postWatchlist();
    });
    // First post is slightly delayed so it doesn't ride alongside the initial
    // active-chart load; then a keep-alive refreshes the backend TTL.
    startTimer = setTimeoutFn(() => {
      startTimer = null;
      postWatchlist();
      intervalId = setIntervalFn(postWatchlist, keepAliveMs);
    }, startDelayMs);
  }

  function stopPreloadHints() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (startTimer) {
      clearTimeoutFn(startTimer);
      startTimer = null;
    }
    if (intervalId) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
    onStop();
  }

  return {
    postWatchlist,
    startPreloadHints,
    stopPreloadHints,
  };
}

export {
  createPreloadHintService,
};
