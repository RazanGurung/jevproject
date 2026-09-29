/**
 * Lightweight Charts series sync controller.
 *
 * Follows the canonical real-time update pattern from the official
 * lightweight-charts documentation:
 *
 *   1. series.setData(initialData)  — set all historical data at once
 *   2. series.update(newBar)        — for each new tick:
 *        - Same time as last bar → replaces the last bar (update HLC)
 *        - New time              → appends a new bar
 *
 * This implementation:
 *   - syncSeries()  — full setData() for initial load or reload
 *   - updateSeries() — single series.update() for live candle ticks
 */

import { DEFAULT_TIMEFRAME } from './chart-history-requirements.js';

function normalizeTime(time) {
  const numeric = Number(time || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric >= 100000000000) {
    return Math.floor(numeric / 1000);
  }
  return Math.floor(numeric);
}

function getDataSignature(candles = [], timeframe = DEFAULT_TIMEFRAME, coin = '') {
  const first = candles[0];
  const last = candles[candles.length - 1];
  const parts = [
    timeframe,
    candles.length,
    first?.t || '',
    last?.t || '',
    last?.o || '',
    last?.h || '',
    last?.l || '',
    last?.c || '',
    last?.v || '',
  ];
  return coin ? [coin, ...parts].join(':') : parts.join(':');
}

function restoreVisibleLogicalRange(timeScale, range, shift = 0) {
  if (
    !range
    || !Number.isFinite(Number(range.from))
    || !Number.isFinite(Number(range.to))
    || typeof timeScale?.setVisibleLogicalRange !== 'function'
  ) {
    return;
  }
  const from = Number(range.from) + Number(shift || 0);
  const to = Number(range.to) + Number(shift || 0);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;
  try { timeScale.setVisibleLogicalRange({ from, to }); } catch {}
}

function buildCandlestickData(candles = []) {
  return candles
    .map((candle) => ({
      time: normalizeTime(candle.t),
      open: Number.parseFloat(candle.o),
      high: Number.parseFloat(candle.h),
      low: Number.parseFloat(candle.l),
      close: Number.parseFloat(candle.c),
    }))
    .filter((candle) => candle.time > 0 && Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close));
}

function buildCandlestickBar(candle) {
  if (!candle) return null;
  const bar = {
    time: normalizeTime(candle.t),
    open: Number.parseFloat(candle.o),
    high: Number.parseFloat(candle.h),
    low: Number.parseFloat(candle.l),
    close: Number.parseFloat(candle.c),
  };
  if (!(bar.time > 0 && Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close))) {
    return null;
  }
  return bar;
}

function getSeriesMeta(candles = [], timeframe = DEFAULT_TIMEFRAME, coin = '') {
  const first = candles[0];
  const last = candles[candles.length - 1];
  return {
    coin,
    timeframe,
    length: candles.length,
    firstTime: normalizeTime(first?.t),
    lastTime: normalizeTime(last?.t),
    lastOpen: last ? Number.parseFloat(last.o) : NaN,
    lastHigh: last ? Number.parseFloat(last.h) : NaN,
    lastLow: last ? Number.parseFloat(last.l) : NaN,
    lastClose: last ? Number.parseFloat(last.c) : NaN,
  };
}

function createSeriesSyncController({
  getCandleSeries,
  getLastSeriesMeta,
  setLastSeriesMeta,
  getLastDataSignature,
  setLastDataSignature,
  applyThemeIfNeeded,
  getTimeScale = () => null,
  clearCrosshair = () => {},
}) {
  let setDataCount = 0;
  let updateCount = 0;
  let authoritativeUpdateCount = 0;
  let projectedUpdateCount = 0;
  let reconciliationSetDataCount = 0;
  let headEvictionSetDataCount = 0;
  let rejectedUpdateCount = 0;
  let latestSeriesTime = 0;
  /**
   * Apply a single candle update to the series via series.update().
   * This is the canonical lightweight-charts real-time update pattern.
   *
   * Returns true if the update was applied, false if it was skipped
   * (e.g. time gap detected, invalid candle, or time ordering violation).
   */
  function updateSeries({
    candle,
    candles = [],
    timeframe = DEFAULT_TIMEFRAME,
    coin = '',
    updateKind = 'authoritative',
    preserveCanonicalMeta = false,
  } = {}) {
    const candleSeries = getCandleSeries();
    if (!candleSeries) {
      rejectedUpdateCount += 1;
      return false;
    }

    const candleBar = buildCandlestickBar(candle);
    if (!candleBar) {
      rejectedUpdateCount += 1;
      return false;
    }

    // AppState can switch coin/TF before the rAF recreate/setData lands.
    // update() would append a foreign bar onto the still-mounted series.
    const lastMeta = getLastSeriesMeta();
    if (!lastMeta || lastMeta.coin !== coin || lastMeta.timeframe !== timeframe || lastMeta.length === 0) {
      rejectedUpdateCount += 1;
      return false;
    }

    // Verify time ordering before update
    const orderingTime = Math.max(latestSeriesTime, Number(lastMeta?.lastTime || 0));
    // A mid tick can open the next display-only bucket just before the
    // exchange sends its final revision for the preceding canonical bucket.
    // That narrow case is reconciled from the ordered canonical array below;
    // all other out-of-order traffic remains rejected.
    const historicalCanonicalReconciliation = updateKind === 'authoritative'
      && candleBar.time < orderingTime
      && candleBar.time === Number(lastMeta?.lastTime || 0)
      && latestSeriesTime > candleBar.time;
    if (candleBar.time < orderingTime && !historicalCanonicalReconciliation) {
      // Incoming candle is older than the last known candle — skip to prevent corruption
      rejectedUpdateCount += 1;
      return false;
    }

    applyThemeIfNeeded();

    const nextMeta = getSeriesMeta(candles, timeframe, coin);
    const appending = candleBar.time > orderingTime;
    const droppedCount = appending
      ? Math.max(0, lastMeta.length + 1 - nextMeta.length)
      : 0;
    const headEvicted = appending
      && droppedCount > 0
      && nextMeta.length > 0
      && nextMeta.firstTime > 0
      && nextMeta.firstTime !== lastMeta.firstTime;

    const applyCanonicalSetData = (shift = 0) => {
      const canonicalData = buildCandlestickData(candles);
      if (canonicalData.length === 0 || canonicalData[canonicalData.length - 1].time !== candleBar.time) {
        return false;
      }
      // Conflation rejects historical update(..., true). setData can jump
      // the visible range (LC #1875); restore the logical window after.
      // Head eviction also has to shift that window left by the dropped
      // prefix so the inspected market does not walk forward one bar.
      const timeScale = typeof getTimeScale === 'function' ? getTimeScale() : null;
      const visibleRange = timeScale?.getVisibleLogicalRange?.() || null;
      try {
        candleSeries.setData(canonicalData);
      } catch (err) {
        try { clearCrosshair(); } catch {}
        candleSeries.setData(canonicalData);
      }
      restoreVisibleLogicalRange(timeScale, visibleRange, shift);
      return true;
    };

    // Wrap the library data call in try/catch to prevent render loop crash.
    // Lightweight Charts rejects historical update(..., true) calls whenever
    // conflation is enabled because conflated data must be processed in order.
    // Rebuild from the ordered canonical array instead; the caller immediately
    // reapplies the display-only current-bucket projection afterward.
    // If update() races a hover during coin/TF churn and throws "Value is null",
    // catch the error, clear the crosshair, and fall back to setData so the
    // native series recovers without clearing cursor labels on normal ticks.
    try {
      if (historicalCanonicalReconciliation || headEvicted) {
        if (!applyCanonicalSetData(headEvicted ? -droppedCount : 0)) {
          rejectedUpdateCount += 1;
          return false;
        }
        setDataCount += 1;
        if (historicalCanonicalReconciliation) {
          reconciliationSetDataCount += 1;
          authoritativeUpdateCount += 1;
        } else {
          headEvictionSetDataCount += 1;
          if (updateKind === 'projection') projectedUpdateCount += 1;
          else authoritativeUpdateCount += 1;
        }
      } else {
        candleSeries.update(candleBar);
        updateCount += 1;
        if (updateKind === 'projection') projectedUpdateCount += 1;
        else authoritativeUpdateCount += 1;
      }
      latestSeriesTime = Math.max(latestSeriesTime, candleBar.time);
    } catch (err) {
      try { clearCrosshair(); } catch {}
      const recovered = applyCanonicalSetData(headEvicted ? -droppedCount : 0);
      if (!recovered) {
        console.warn('[chart] series.update() failed:', err);
        rejectedUpdateCount += 1;
        return false;
      }
      setDataCount += 1;
      if (updateKind === 'projection') projectedUpdateCount += 1;
      else authoritativeUpdateCount += 1;
      latestSeriesTime = Math.max(latestSeriesTime, candleBar.time);
    }

    if (!preserveCanonicalMeta) {
      setLastSeriesMeta(getSeriesMeta(candles, timeframe, coin));
      setLastDataSignature(getDataSignature(candles, timeframe, coin));
    }
    return true;
  }

  /**
   * Full series sync — used for initial load, reload, or when a time gap
   * is detected. Calls series.setData() with the full candle array.
   *
   * This is the canonical lightweight-charts pattern for setting historical data.
   */
  function syncSeries({ candles = [], timeframe = DEFAULT_TIMEFRAME, coin = '', force = false } = {}) {
    const candleSeries = getCandleSeries();
    if (!candleSeries) return false;
    const nextCandles = Array.isArray(candles) ? candles : [];

    if (nextCandles.length === 0) {
      const emptySignature = getDataSignature([], timeframe, coin);
      if (!force && emptySignature === getLastDataSignature()) return true;
      try { clearCrosshair(); } catch {}
      candleSeries.setData([]);
      setDataCount += 1;
      setLastDataSignature(emptySignature);
      const emptyMeta = getSeriesMeta([], timeframe, coin);
      setLastSeriesMeta(emptyMeta);
      latestSeriesTime = 0;
      return true;
    }

    const signature = getDataSignature(nextCandles, timeframe, coin);
    if (!force && signature === getLastDataSignature()) return true;

    // Full setData — this is the canonical pattern for loading/reloading data.
    // The library handles everything internally (time ordering, gap detection, etc.).
    applyThemeIfNeeded();
    // setData can jump the viewport (LC #1875). Capture the live window first
    // and put it back. Callers that need a different range (overview fit,
    // history-prepend shift) apply that range after this returns.
    const timeScale = typeof getTimeScale === 'function' ? getTimeScale() : null;
    const visibleRange = timeScale?.getVisibleLogicalRange?.() || null;
    try {
      candleSeries.setData(buildCandlestickData(nextCandles));
    } catch (err) {
      try { clearCrosshair(); } catch {}
      candleSeries.setData(buildCandlestickData(nextCandles));
    }
    restoreVisibleLogicalRange(timeScale, visibleRange);
    setDataCount += 1;

    setLastDataSignature(signature);
    const nextMeta = getSeriesMeta(nextCandles, timeframe, coin);
    setLastSeriesMeta(nextMeta);
    latestSeriesTime = nextMeta.lastTime;
    return true;
  }

  function resetLiveCursor() {
    latestSeriesTime = 0;
  }

  return {
    updateSeries,
    syncSeries,
    resetLiveCursor,
    getDebugState: () => ({
      setDataCount,
      updateCount,
      authoritativeUpdateCount,
      projectedUpdateCount,
      reconciliationSetDataCount,
      headEvictionSetDataCount,
      rejectedUpdateCount,
    }),
  };
}

export {
  createSeriesSyncController,
};
