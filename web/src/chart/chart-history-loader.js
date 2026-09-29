function createChartHistoryLoader({
  getCurrentCoin = () => '',
  getCurrentTimeframe = () => '2h',
  getCandles = () => [],
  setCandles = () => {},
  fetchHistoricalCandles = async () => [],
  candleCache,
  evictCandleCache = () => {},
  setCandleCacheEntry = (k, v) => {
    candleCache?.delete?.(k);
    candleCache?.set?.(k, v);
    evictCandleCache?.();
  },
  getViewStart = () => 0,
  setViewStart = () => {},
  getViewCount = () => 1,
  // Official logical ranges are fractional (partially visible bars). Prefer the
  // live LC range when shifting after a prepend; viewStart/viewCount are an
  // integer fallback from the leftover app view model.
  getVisibleLogicalRange = () => null,
  // Lightweight Charts keeps the same logical {from,to} after prepend setData,
  // which would jump the viewport onto older bars. Callers should wire this to
  // requestVisibleLogicalRange so the pending range is re-applied after render.
  requestVisibleLogicalRange = () => {},
  scheduleChartRender = () => {},
  normalizeCandles = (candles) => candles,
  onClearHistoryState = () => {},
  historyPreloadThresholdBars = 200,
  historyChunkSize = 1000,
  maxLoadedCandles = 40000,
} = {}) {
  const historyLoadState = new Map();
  let loadGeneration = 0;

  function getHistoryStateKey(coin = getCurrentCoin(), timeframe = getCurrentTimeframe() || '2h') {
    return `${coin}:${timeframe}`;
  }

  function clearHistoryLoadState(coin, timeframe) {
    loadGeneration += 1;
    for (const state of historyLoadState.values()) {
      state.controller?.abort?.();
    }
    historyLoadState.clear();
    onClearHistoryState();
  }

  async function ensureHistoricalCandles(range, options = {}) {
    if (!range) return;
    const background = options.background === true;
    const continueFill = options.continueFill !== false;
    const barsBefore = Number(range.barsBefore);
    const nearHistoryEdge = Number.isFinite(barsBefore)
      ? barsBefore <= historyPreloadThresholdBars
      : Number.isFinite(range.from) && range.from <= historyPreloadThresholdBars;
    if (!nearHistoryEdge) return;

    const coin = getCurrentCoin();
    const timeframe = getCurrentTimeframe() || '2h';
    const stateKey = getHistoryStateKey(coin, timeframe);
    const state = historyLoadState.get(stateKey) || { loading: false, complete: false, controller: null };
    if (state.loading || state.complete) return;

    const candles = Array.isArray(getCandles()) ? getCandles() : [];
    const oldestTime = Number(candles[0]?.t || 0);
    if (!oldestTime) return;
    // At the in-memory cap there is nowhere to retain older bars. Mark the
    // edge complete so left-edge pans do not refetch the same discarded chunk.
    if (candles.length >= maxLoadedCandles) {
      state.complete = true;
      historyLoadState.set(stateKey, state);
      return;
    }

    state.loading = true;
    state.controller = typeof AbortController === 'function' ? new AbortController() : null;
    const generationAtStart = loadGeneration;
    historyLoadState.set(stateKey, state);

    try {
      const olderCandles = await fetchHistoricalCandles({
        coin,
        timeframe,
        endTime: oldestTime - 1,
        limit: historyChunkSize,
        background,
        signal: state.controller?.signal,
      });
      // A coin/timeframe switch invalidates and aborts every older history
      // request. Guard again after await because an upstream response may win
      // the abort race.
      if (
        generationAtStart !== loadGeneration
        || getCurrentCoin() !== coin
        || (getCurrentTimeframe() || '2h') !== timeframe
      ) return;
      // A failed/aborted fetch is deliberately distinct from a successful
      // empty response. Keep the edge retryable so one transient failure does
      // not permanently declare the chart's older history exhausted.
      if (!Array.isArray(olderCandles)) return;
      const currentCandles = Array.isArray(getCandles()) ? getCandles() : [];
      if (Number(currentCandles[0]?.t || 0) !== oldestTime) return;
      const uniqueOlder = olderCandles.filter((candle) => Number(candle?.t || 0) > 0 && Number(candle.t) < oldestTime);

      if (!uniqueOlder.length) {
        state.complete = true;
        return;
      }

      const byTime = new Map();
      for (const candle of [...uniqueOlder, ...currentCandles]) {
        const time = Number(candle?.t || 0);
        if (time > 0) byTime.set(time, candle);
      }
      const merged = normalizeCandles([...byTime.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, candle]) => candle))
        .slice(-maxLoadedCandles);
      const addedCount = merged.filter((candle) => Number(candle?.t || 0) < oldestTime).length;
      if (addedCount === 0) {
        state.complete = true;
        return;
      }
      setCandles(merged);
      setCandleCacheEntry(stateKey, merged);
      // Prepend shifts every existing bar's logical index by addedCount. Keep
      // the inspected window put by translating the *current* logical range,
      // including the fractional partial-bar edges LC uses while scrolling.
      const visible = getVisibleLogicalRange?.();
      const hasVisible = visible
        && Number.isFinite(Number(visible.from))
        && Number.isFinite(Number(visible.to));
      const shifted = hasVisible
        ? {
          from: Number(visible.from) + addedCount,
          to: Number(visible.to) + addedCount,
        }
        : null;
      const nextStart = shifted
        ? Math.max(0, Math.floor(shifted.from))
        : getViewStart() + addedCount;
      const viewCount = shifted
        ? Math.max(1, Math.ceil(shifted.to) - Math.floor(shifted.from) + 1)
        : Math.max(1, Number(getViewCount()) || 1);
      setViewStart(nextStart);
      requestVisibleLogicalRange(shifted || {
        from: nextStart,
        to: nextStart + viewCount - 1,
      });
      scheduleChartRender();
      // After the first prepend the live window is shifted away from the left
      // edge (barsBefore jumps by addedCount). Keep walking older chunks in
      // the background until the exchange is exhausted or the in-memory cap.
      if (continueFill && addedCount > 0 && merged.length < maxLoadedCandles) {
        const generationForFill = generationAtStart;
        const scheduleFill = (cb) => {
          if (typeof globalThis.requestIdleCallback === 'function') {
            return globalThis.requestIdleCallback(cb, { timeout: 250 });
          }
          return globalThis.setTimeout(cb, 0);
        };
        scheduleFill(() => {
          if (generationForFill !== loadGeneration) return;
          ensureHistoricalCandles({ barsBefore: 0 }, { background: true, continueFill: true });
        });
      }
    } finally {
      if (generationAtStart === loadGeneration && historyLoadState.get(stateKey) === state) {
        state.loading = false;
        state.controller = null;
        historyLoadState.set(stateKey, state);
      }
    }
  }

  return {
    clearHistoryLoadState,
    ensureHistoricalCandles,
    getHistoryStateKey,
  };
}

export {
  createChartHistoryLoader,
};
