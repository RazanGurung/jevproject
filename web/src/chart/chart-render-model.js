/**
 * Chart render model — builds the render model for each frame.
 *
 * The lightweight-charts series is driven by the canonical pattern:
 *   - series.setData() for initial load / reload
 *   - series.update() for live candle ticks (single source of truth)
 *
 * There is no wall-clock synthesis or mid-price projection. The library
 * renders exchange candles while the current mid/mark uses a price line.
 */

import { DEFAULT_TIMEFRAME } from './chart-history-requirements.js';
import { AppState } from '../state/store.js';
export function collectChartLevelPrices(levels = {}) {
  return [
    ...(levels.positions || []).map((level) => level?.price),
    ...(levels.orders || []).map((level) => level?.price),
    ...(levels.levels || []).map((level) => level?.price),
  ].filter((price) => Number.isFinite(price) && price > 0);
}

export function getChartRuntime({
  appState,
  scalePreviewLevels,
  chartLayers,
}) {
  return {
    currentCoin: appState.trading.currentCoin,
    currentTimeframe: appState.trading.currentTimeframe || DEFAULT_TIMEFRAME,
    currentPrice: appState.trading.currentPrice,
    candles: appState.market.candles || [],
    allMids: appState.market.allMids || {},
    scalePreviewLevels,
    chartLayers,
  };
}

export function computeFallbackPriceRange(visibleCandles = [], levelPrices = [], refPrice = 0) {
  let hi = -Infinity;
  let lo = Infinity;

  visibleCandles.forEach((candle) => {
    const high = Number.parseFloat(candle?.h);
    const low = Number.parseFloat(candle?.l);
    if (high > 0 && low > 0 && Number.isFinite(high) && Number.isFinite(low)) {
      hi = Math.max(hi, high);
      lo = Math.min(lo, low);
    }
  });

  if (hi === -Infinity || lo === Infinity) {
    if (levelPrices.length > 0) {
      hi = Math.max(...levelPrices, refPrice * 1.02);
      lo = Math.min(...levelPrices, refPrice * 0.98);
    } else {
      hi = refPrice > 0 ? refPrice * 1.02 : 1;
      lo = refPrice > 0 ? refPrice * 0.98 : 0;
    }
  }

  const pad = (hi - lo) * 0.06 || hi * 0.001 || 1;
  const yMax = hi + pad;
  const yMin = Math.max(0, lo - pad);
  return {
    yMax,
    yMin,
    yRange: Math.max(yMax - yMin, 1),
  };
}

export function buildLightweightRenderModel({
  ctx,
  width,
  height,
  runtime,
  candles,
  chartSession,
  overlayState,
  levels,
  chartPad,
  viewStart,
  viewCount,
  needsFitContent,
  fitSucceeded = true,
  forceVisibleRangeSync,
  syncOrderLines,
  syncPositionLines,
  syncPreviewLines,
  syncJevSignalLines,
  syncOrderLabels,
  syncPositionLabels,
  syncLivePriceLine,
  priceToCoordinate,
}) {
  const chartW = width - chartPad.left - chartPad.right;
  const chartH = height - chartPad.top - chartPad.bottom;
  const volH = Math.round(chartH * 0.15);
  const priceH = chartH - volH - 4;

  // The candle series is synced by the caller (buildRenderModel in
  // chart-render.js) before invoking this function. We do not call
  // syncLightweightChart here — duplicating that call would re-evaluate the
  // visible-range, fit-content, and theme paths twice per frame, even though
  // the signature dedup makes the second setData() a no-op.

  // Only clear the fit request after a successful overview. A failed fit
  // (e.g. chart width still 0) must retry on the next frame so startup never
  // sticks on the default zoomed-in barSpacing viewport.
  const nextNeedsFitContent = needsFitContent
    ? !(runtime.candles.length > 0 && fitSucceeded !== false)
    : needsFitContent;

  // Keep native lightweight lines in sync even while the chart is in a loading
  // state so pair/timeframe switches do not leave the previous coin's lines
  // visible underneath the loading overlay.
  syncOrderLines(levels.orders);
  syncPositionLines(levels.positions, levels.liquidations);
  syncPreviewLines(runtime.scalePreviewLevels);
  if (typeof syncJevSignalLines === 'function') {
    const shouldShowJev = AppState.ui.jevSignalsVisible === true;
    const activeSig = shouldShowJev ? (levels.jevSignal || AppState.market?.activeJevSignal) : null;
    const isMatchingCoin = activeSig && activeSig.coin === runtime.currentCoin;
    syncJevSignalLines(isMatchingCoin ? activeSig : null);
  }
  syncOrderLabels(levels.orders, runtime.currentCoin);
  syncPositionLabels(levels.positions, runtime.currentCoin);

  if (overlayState.shouldShowOverlay) {
    syncLivePriceLine(0, 0);
    return {
      model: {
        ctx,
        W: width,
        H: height,
        loading: true,
        overlayText: overlayState.overlayText,
      },
      nextNeedsFitContent,
      nextForceVisibleRangeSync: false,
    };
  }

  syncLivePriceLine(runtime.currentPrice, Number(candles[candles.length - 1]?.o || runtime.currentPrice || 0));

  const visible = candles.length
    ? candles.slice(viewStart, Math.min(viewStart + viewCount, candles.length))
    : [];
  const levelPrices = collectChartLevelPrices(levels);
  const refPrice = runtime.currentPrice || runtime.allMids?.[runtime.currentCoin] || 50000;
  const { yMax, yMin, yRange } = computeFallbackPriceRange(visible, levelPrices, refPrice);

  return {
    model: {
      ctx,
      W: width,
      H: height,
      PAD: chartPad,
      chartW,
      chartH,
      priceH,
      volH,
      visible,
      currentTimeframe: runtime.currentTimeframe,
      runtime,
      chartSession,
      yMax,
      yMin,
      yRange,
      toY: (price) => {
        const libY = priceToCoordinate(Number(price));
        return libY ?? (chartPad.top + priceH - ((Number(price) - yMin) / yRange * priceH));
      },
      loading: false,
    },
    nextNeedsFitContent,
    nextForceVisibleRangeSync: false,
  };
}
