/**
 * On-Chart Candle Overlay Primitive (Heikin Ashi & Renko)
 *
 * Provides canvas-based candlestick and brick overlays directly on the price chart:
 *   - Heikin Ashi: Smoothed trend bars calculated from OHLC averages.
 *   - Renko: Price-action bricks filtering market noise using ATR, percentage, or fixed size.
 *
 * Implemented as a Lightweight Charts series primitive in bitmap coordinate space
 * (zero autoscale distortion, pristine Retina crispness).
 */

import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
export {
  calculateHeikinAshiAsync,
  calculateRenkoBricksAsync,
} from './indicator-worker-pool.js';

export const CANDLE_OVERLAY_MODES = Object.freeze(['off', 'heikin-ashi', 'renko', 'both']);
export const RENKO_BRICK_MODES = Object.freeze(['atr', 'percent', 'fixed']);
export const BASE_CANDLE_MODES = Object.freeze(['dimmed', 'hidden', 'normal']);

export const DEFAULT_CANDLE_OVERLAY_OPTIONS = Object.freeze({
  mode: 'off',
  baseCandles: 'dimmed',
  contrast: 0.5,
  heikinAshi: Object.freeze({
    showWicks: true,
    dimmed: false,
    opacity: 0.5,
  }),
  renko: Object.freeze({
    brickMode: 'atr',
    atrPeriod: 14,
    percent: 0.25,
    fixedSize: 0,
    showWicks: false,
    dimmed: true,
    opacity: 0.5,
  }),
});

export function normalizeTimestamp(time) {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
}

export function getCandleOverlayColors() {
  return {
    bullish: getPaletteColor('bullish') || '#22cce6',
    bearish: getPaletteColor('bearish') || '#ff5050',
  };
}

/**
 * Computes canonical Heikin Ashi candlestick series from raw OHLC candles.
 * Tolerates both short (t, o, h, l, c) and long (time, open, high, low, close) field names.
 *
 * haClose = (Open + High + Low + Close) / 4
 * haOpen  = (prevHaOpen + prevHaClose) / 2   (first bar: (Open + Close) / 2)
 * haHigh  = max(High, haOpen, haClose)
 * haLow   = min(Low, haOpen, haClose)
 */
export function computeHeikinAshi(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const result = [];
  let prevHaOpen = 0;
  let prevHaClose = 0;
  let isFirst = true;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const time = normalizeTimestamp(c.t ?? c.time);
    const open = Number(c.o ?? c.open);
    const high = Number(c.h ?? c.high);
    const low = Number(c.l ?? c.low);
    const close = Number(c.c ?? c.close);

    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || time <= 0) {
      continue;
    }

    const haClose = (open + high + low + close) / 4;
    const haOpen = isFirst
      ? (open + close) / 2
      : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(high, haOpen, haClose);
    const haLow = Math.min(low, haOpen, haClose);

    prevHaOpen = haOpen;
    prevHaClose = haClose;
    isFirst = false;

    result.push({
      time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      isUp: haClose >= haOpen,
    });
  }

  return result;
}

/**
 * Rounds a price to safe decimal precision to prevent IEEE 754 float drift.
 */
export function roundPrice(val, brickSize = 1) {
  if (!Number.isFinite(val)) return 0;
  if (brickSize >= 1) {
    return Math.round(val * 10000) / 10000;
  }
  if (brickSize >= 0.001) {
    return Math.round(val * 1000000) / 1000000;
  }
  return Math.round(val * 100000000) / 100000000;
}

/**
 * Computes Average True Range (ATR) across historical candles.
 */
export function computeATR(candles = [], period = 14, { excludeForming = false } = {}) {
  if (!Array.isArray(candles) || candles.length < 2) {
    const fallbackPrice = Number(candles?.[0]?.c ?? candles?.[0]?.close ?? 1);
    return Math.max(0.00000001, fallbackPrice * 0.002);
  }

  const p = Math.max(1, Math.min(period, candles.length));
  let trSum = 0;
  let count = 0;

  // When excludeForming is requested and we have enough candles, exclude the last incomplete bar
  const endIdx = (excludeForming && candles.length >= p + 2) ? candles.length - 1 : candles.length;
  const startIdx = Math.max(1, endIdx - p);

  for (let i = startIdx; i < endIdx; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (!curr || !prev) continue;
    const h = Number(curr.h ?? curr.high);
    const l = Number(curr.l ?? curr.low);
    const prevC = Number(prev.c ?? prev.close);

    if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(prevC)) {
      const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      if (Number.isFinite(tr) && tr >= 0) {
        trSum += tr;
        count += 1;
      }
    }
  }

  const lastCandle = candles[candles.length - 1];
  const fallbackPrice = Number(lastCandle?.c ?? lastCandle?.close ?? 1);
  if (count === 0) {
    return Math.max(0.00000001, fallbackPrice * 0.002);
  }

  const avgTr = trSum / count;
  if (!Number.isFinite(avgTr) || avgTr <= 0) {
    return Math.max(0.00000001, fallbackPrice * 0.002);
  }

  return Math.max(0.00000001, avgTr);
}

/**
 * Computes Renko bricks with standard 2-brick reversals.
 * Fully symmetrical initial brick establishment in either upward or downward direction.
 *
 * @param {Array} candles - Raw OHLC candles
 * @param {Object} options - { brickMode, atrPeriod, percent, fixedSize }
 * @returns {Object} { bricks, brickSize, currentDirection }
 */
export function computeRenkoBricks(candles = [], options = {}) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { bricks: [], brickSize: 0, currentDirection: 0 };
  }

  const brickMode = options.brickMode || 'atr';
  const excludeForming = options.excludeForming === true;
  let brickSize = 0;

  if (brickMode === 'fixed' && Number(options.fixedSize) > 0) {
    brickSize = Number(options.fixedSize);
  } else if (brickMode === 'percent') {
    const targetCandle = (excludeForming && candles.length > 1)
      ? (candles[candles.length - 2] ?? candles[0])
      : (candles[candles.length - 1] ?? candles[0]);
    const targetClose = Number(targetCandle?.c ?? targetCandle?.close ?? 1);
    const pct = Number(options.percent || 1.0) / 100;
    brickSize = Math.max(0.00000001, targetClose * pct);
  } else {
    brickSize = computeATR(candles, Number(options.atrPeriod) || 14, { excludeForming: true });
  }

  brickSize = Math.max(0.00000001, Number(brickSize) || 1);

  // Find first valid candle with positive finite close and valid timestamp
  let firstValidCandle = null;
  let firstIndex = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c) {
      const time = normalizeTimestamp(c.t ?? c.time);
      const close = Number(c.c ?? c.close);
      if (Number.isFinite(close) && close > 0 && time > 0) {
        firstValidCandle = c;
        firstIndex = i;
        break;
      }
    }
  }
  if (!firstValidCandle) {
    return { bricks: [], brickSize, currentDirection: 0 };
  }

  const bricks = [];
  let currentDirection = 0; // 0 = unestablished, 1 = up, -1 = down
  const rawRef = Number(firstValidCandle.o ?? firstValidCandle.open ?? firstValidCandle.c ?? firstValidCandle.close ?? 0);
  let currentStep = Math.round(rawRef / brickSize);
  const quantizedRef = roundPrice(currentStep * brickSize, brickSize);
  const refPrice = Number.isFinite(quantizedRef) && quantizedRef > 0 ? quantizedRef : rawRef;
  let currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
  let currentBottom = roundPrice(currentStep * brickSize, brickSize);

  let pendingHigh = Number(firstValidCandle.h ?? firstValidCandle.high ?? refPrice);
  let pendingLow = Number(firstValidCandle.l ?? firstValidCandle.low ?? refPrice);

  const EPS = Math.max(1e-15, brickSize * 1e-6);
  const MAX_STEPS = 1000;
  const candleLimit = (excludeForming && candles.length > 1)
    ? candles.length - 1
    : candles.length;

  for (let i = firstIndex; i < candleLimit; i++) {
    const c = candles[i];
    if (!c) continue;
    const time = normalizeTimestamp(c.t ?? c.time);
    const close = Number(c.c ?? c.close);
    const high = Number(c.h ?? c.high ?? close);
    const low = Number(c.l ?? c.low ?? close);

    if (!Number.isFinite(close) || time <= 0) continue;

    const startIndex = bricks.length;
    let stepsInCandle = 0;

    pendingHigh = Math.max(pendingHigh, high);
    pendingLow = Math.min(pendingLow, low);

    if (currentDirection === 0) {
      if (close >= refPrice + brickSize - EPS) {
        currentDirection = 1;
        currentBottom = refPrice;
        currentTop = roundPrice(refPrice + brickSize, brickSize);
        currentStep = Math.round(currentBottom / brickSize);
        bricks.push({
          time,
          open: currentBottom,
          close: currentTop,
          high: Math.max(pendingHigh, currentTop),
          low: Math.min(pendingLow, currentBottom),
          isUp: true,
          candleIndex: i,
        });
        pendingHigh = high;
        pendingLow = low;
        while (close >= currentTop + brickSize - EPS) {
          if (++stepsInCandle > MAX_STEPS) break;
          currentStep++;
          currentBottom = roundPrice(currentStep * brickSize, brickSize);
          currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
          bricks.push({
            time,
            open: currentBottom,
            close: currentTop,
            high: Math.max(pendingHigh, currentTop),
            low: Math.min(pendingLow, currentBottom),
            isUp: true,
            candleIndex: i,
          });
        }
      } else if (close <= refPrice - brickSize + EPS) {
        currentDirection = -1;
        currentTop = refPrice;
        currentBottom = roundPrice(refPrice - brickSize, brickSize);
        currentStep = Math.round(currentBottom / brickSize);
        bricks.push({
          time,
          open: currentTop,
          close: currentBottom,
          high: Math.max(pendingHigh, currentTop),
          low: Math.min(pendingLow, currentBottom),
          isUp: false,
          candleIndex: i,
        });
        pendingHigh = high;
        pendingLow = low;
        while (close <= currentBottom - brickSize + EPS) {
          if (++stepsInCandle > MAX_STEPS) break;
          currentStep--;
          currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
          currentBottom = roundPrice(currentStep * brickSize, brickSize);
          bricks.push({
            time,
            open: currentTop,
            close: currentBottom,
            high: Math.max(pendingHigh, currentTop),
            low: Math.min(pendingLow, currentBottom),
            isUp: false,
            candleIndex: i,
          });
        }
      }
    } else if (currentDirection === 1) {
      // Up continuation
      while (close >= currentTop + brickSize - EPS) {
        if (++stepsInCandle > MAX_STEPS) break;
        currentStep++;
        currentBottom = roundPrice(currentStep * brickSize, brickSize);
        currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
        bricks.push({
          time,
          open: currentBottom,
          close: currentTop,
          high: Math.max(pendingHigh, currentTop),
          low: Math.min(pendingLow, currentBottom),
          isUp: true,
          candleIndex: i,
        });
        pendingHigh = high;
        pendingLow = low;
      }

      // 2-brick reversal downward
      if (close <= currentBottom - brickSize + EPS) {
        currentDirection = -1;
        currentStep--;
        currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
        currentBottom = roundPrice(currentStep * brickSize, brickSize);
        bricks.push({
          time,
          open: currentTop,
          close: currentBottom,
          high: Math.max(pendingHigh, currentTop),
          low: Math.min(pendingLow, currentBottom),
          isUp: false,
          candleIndex: i,
        });
        pendingHigh = high;
        pendingLow = low;

        // Additional drop bricks in same candle
        while (close <= currentBottom - brickSize + EPS) {
          if (++stepsInCandle > MAX_STEPS) break;
          currentStep--;
          currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
          currentBottom = roundPrice(currentStep * brickSize, brickSize);
          bricks.push({
            time,
            open: currentTop,
            close: currentBottom,
            high: Math.max(pendingHigh, currentTop),
            low: Math.min(pendingLow, currentBottom),
            isUp: false,
            candleIndex: i,
          });
        }
      }
    } else if (currentDirection === -1) {
      // Down continuation
      while (close <= currentBottom - brickSize + EPS) {
        if (++stepsInCandle > MAX_STEPS) break;
        currentStep--;
        currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
        currentBottom = roundPrice(currentStep * brickSize, brickSize);
        bricks.push({
          time,
          open: currentTop,
          close: currentBottom,
          high: Math.max(pendingHigh, currentTop),
          low: Math.min(pendingLow, currentBottom),
          isUp: false,
          candleIndex: i,
        });
        pendingHigh = high;
        pendingLow = low;
      }

      // 2-brick reversal upward
      if (close >= currentTop + brickSize - EPS) {
        currentDirection = 1;
        currentStep++;
        currentBottom = roundPrice(currentStep * brickSize, brickSize);
        currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
        bricks.push({
          time,
          open: currentBottom,
          close: currentTop,
          high: Math.max(pendingHigh, currentTop),
          low: Math.min(pendingLow, currentBottom),
          isUp: true,
          candleIndex: i,
        });
        pendingHigh = high;
        pendingLow = low;

        // Additional up bricks in same candle
        while (close >= currentTop + brickSize - EPS) {
          if (++stepsInCandle > MAX_STEPS) break;
          currentStep++;
          currentBottom = roundPrice(currentStep * brickSize, brickSize);
          currentTop = roundPrice((currentStep + 1) * brickSize, brickSize);
          bricks.push({
            time,
            open: currentBottom,
            close: currentTop,
            high: Math.max(pendingHigh, currentTop),
            low: Math.min(pendingLow, currentBottom),
            isUp: true,
            candleIndex: i,
          });
        }
      }
    }

    const candleBricksCount = bricks.length - startIndex;
    if (candleBricksCount > 0) {
      for (let j = 0; j < candleBricksCount; j++) {
        bricks[startIndex + j].intraIndex = j;
        bricks[startIndex + j].totalInCandle = candleBricksCount;
      }
    }
  }

  // Populate endTime on bricks so they span horizontally until replaced
  const lastCandle = candles[candles.length - 1];
  const candleTime = normalizeTimestamp(lastCandle?.t ?? lastCandle?.time);
  const liveTime = Number(options.liveTime || 0);
  const lastTime = liveTime > 0 ? Math.max(candleTime, liveTime) : candleTime;
  for (let k = 0; k < bricks.length; k++) {
    const isIntermediate = bricks[k].totalInCandle > 1 && bricks[k].intraIndex < bricks[k].totalInCandle - 1;
    if (isIntermediate) {
      bricks[k].endTime = bricks[k].time;
    } else {
      let nextCandleTime = lastTime;
      for (let nextK = k + 1; nextK < bricks.length; nextK++) {
        if (bricks[nextK].time > bricks[k].time) {
          nextCandleTime = bricks[nextK].time;
          break;
        }
      }
      bricks[k].endTime = nextCandleTime;
    }
  }

  return { bricks, brickSize, currentDirection };
}

/**
 * Creates the Candle Overlay controller and Lightweight Charts series primitive.
 */
export function createCandleOverlay({ getChart, getCandleSeries, options = {} } = {}) {
  let attachedChart = null;
  let attachedSeries = null;
  let requestUpdate = null;

  const state = {
    mode: options?.mode ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.mode,
    baseCandles: options?.baseCandles ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.baseCandles,
    contrast: typeof options?.contrast === 'number' ? options.contrast : DEFAULT_CANDLE_OVERLAY_OPTIONS.contrast,
    heikinAshi: {
      showWicks: options?.heikinAshi?.showWicks ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.heikinAshi.showWicks,
      dimmed: options?.heikinAshi?.dimmed ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.heikinAshi.dimmed,
      opacity: typeof options?.heikinAshi?.opacity === 'number' ? options.heikinAshi.opacity : DEFAULT_CANDLE_OVERLAY_OPTIONS.heikinAshi.opacity,
    },
    renko: {
      brickMode: options?.renko?.brickMode ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.brickMode,
      atrPeriod: options?.renko?.atrPeriod ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.atrPeriod,
      percent: options?.renko?.percent ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.percent,
      fixedSize: options?.renko?.fixedSize ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.fixedSize,
      showWicks: options?.renko?.showWicks ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.showWicks,
      dimmed: options?.renko?.dimmed ?? DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.dimmed,
      opacity: typeof options?.renko?.opacity === 'number' ? options.renko.opacity : DEFAULT_CANDLE_OVERLAY_OPTIONS.renko.opacity,
    },
    candles: [],
    closedCandles: null,
    coin: '',
    timeframe: '',
    haCandles: [],
    renkoData: { bricks: [], brickSize: 0, currentDirection: 0 },
    colors: getCandleOverlayColors(),
  };

  function redraw() {
    if (typeof requestUpdate === 'function') {
      try { requestUpdate(); } catch {}
    }
  }

  function drawHeikinAshi(ctx, ts, visibleRange, barSpacingMedia, hpr, vpr, pixelRatio) {
    const haBars = state.haCandles;
    if (!haBars.length) return;

    const barWidthMedia = Math.max(2, Math.round(barSpacingMedia * 0.78));
    const barWidthPx = Math.max(1, Math.round(barWidthMedia * hpr));
    const wickWidthPx = Math.max(1, Math.round(1.5 * hpr));

    const isDimmed = state.heikinAshi.dimmed === true;
    const haDimAlpha = typeof state.heikinAshi.opacity === 'number'
      ? Math.max(0.05, Math.min(1.0, state.heikinAshi.opacity))
      : 0.5;

    const bodyAlpha = isDimmed
      ? haDimAlpha
      : (state.baseCandles === 'hidden' ? 1.0 : 0.85);
    const borderAlpha = isDimmed
      ? Math.min(1.0, haDimAlpha * 1.35)
      : 1.0;
    const wickAlpha = isDimmed
      ? Math.min(1.0, haDimAlpha * 1.35)
      : 0.95;

    for (const bar of haBars) {
      const idx = ts.timeToIndex(bar.time, true);
      if (idx == null) continue;
      if (idx < visibleRange.from - 2) continue;
      if (idx > visibleRange.to + 2) break;
      const x = ts.logicalToCoordinate(idx);
      if (x == null || !Number.isFinite(x)) continue;

      const yOpen = attachedSeries.priceToCoordinate(bar.open);
      const yClose = attachedSeries.priceToCoordinate(bar.close);
      const yHigh = attachedSeries.priceToCoordinate(bar.high);
      const yLow = attachedSeries.priceToCoordinate(bar.low);

      if (yOpen == null || yClose == null || yHigh == null || yLow == null) continue;

      const color = bar.isUp ? state.colors.bullish : state.colors.bearish;
      const cx = Math.round(x * hpr);

      // 1. Draw wick
      if (state.heikinAshi.showWicks !== false) {
        const wickTop = Math.round(Math.min(yHigh, yLow) * vpr);
        const wickHeight = Math.max(1, Math.round(Math.abs(yHigh - yLow) * vpr));
        ctx.fillStyle = colorWithAlpha(color, wickAlpha);
        ctx.fillRect(Math.round(cx - Math.floor(wickWidthPx / 2)), wickTop, wickWidthPx, wickHeight);
      }

      // 2. Draw body (crisp solid fill + sharp outline)
      const bodyTop = Math.round(Math.min(yOpen, yClose) * vpr);
      const bodyHeight = Math.max(2, Math.round(Math.abs(yOpen - yClose) * vpr));
      const bodyLeft = Math.round(cx - barWidthPx / 2);

      ctx.fillStyle = colorWithAlpha(color, bodyAlpha);
      ctx.fillRect(bodyLeft, bodyTop, barWidthPx, bodyHeight);
      ctx.strokeStyle = colorWithAlpha(color, borderAlpha);
      ctx.lineWidth = Math.max(1, Math.round(1 * pixelRatio));
      ctx.strokeRect(bodyLeft, bodyTop, barWidthPx, bodyHeight);
    }
  }

  function drawRenko(ctx, ts, visibleRange, barSpacingMedia, hpr, vpr, pixelRatio, bitmapSize) {
    const bricks = state.renkoData.bricks;
    if (!bricks.length) return;

    const isDimmed = state.renko.dimmed === true;
    const renkoDimAlpha = typeof state.renko.opacity === 'number'
      ? Math.max(0.05, Math.min(1.0, state.renko.opacity))
      : 0.5;

    const brickAlpha = isDimmed
      ? renkoDimAlpha
      : (state.baseCandles === 'hidden' ? 0.95 : 0.75);
    const borderAlpha = isDimmed
      ? Math.min(1.0, renkoDimAlpha * 1.35)
      : 1.0;
    const stepLineAlpha = isDimmed
      ? Math.min(1.0, renkoDimAlpha * 1.35)
      : 1.0;
    const wickAlpha = isDimmed
      ? Math.min(1.0, renkoDimAlpha * 1.2)
      : 0.7;
    const projAlpha = isDimmed
      ? Math.min(1.0, renkoDimAlpha * 1.2)
      : 0.7;

    const candleSlotPx = Math.max(1, Math.round(barSpacingMedia * hpr));
    const defaultBarWidthPx = barSpacingMedia >= 4
      ? Math.max(5, Math.round(barSpacingMedia * 0.82 * hpr))
      : Math.max(1, Math.round(candleSlotPx * 0.82));
    const wickWidthPx = Math.max(1, Math.round(1.5 * hpr));

    // Buffer range to catch shelves entering from the left and projections to the right
    const bufferBars = Math.max(30, Math.round(60 * hpr));
    const minLogical = (visibleRange.from ?? -Infinity) - bufferBars;
    const maxLogical = (visibleRange.to ?? Infinity) + bufferBars;

    // Pass 1: Filter to visible window and compute strictly time-anchored coordinates
    const rawCoords = [];

    for (let bIdx = 0; bIdx < bricks.length; bIdx++) {
      const brick = bricks[bIdx];
      const idxStart = ts.timeToIndex(brick.time, true);
      if (idxStart == null) continue;

      let idxEnd = brick.endTime ? ts.timeToIndex(brick.endTime, true) : null;
      if (idxEnd == null || idxEnd < idxStart) idxEnd = idxStart;

      // Viewport culling by logical index: skip bricks that end before viewport or start after
      if (idxEnd < minLogical) continue;
      if (idxStart > maxLogical) break;
      const xStart = ts.logicalToCoordinate(idxStart);
      if (xStart == null) continue;
      const xEnd = (idxEnd !== idxStart) ? ts.logicalToCoordinate(idxEnd) : null;

      const yOpen = attachedSeries.priceToCoordinate(brick.open);
      const yClose = attachedSeries.priceToCoordinate(brick.close);
      if (yOpen == null || yClose == null) continue;

      const color = brick.isUp ? state.colors.bullish : state.colors.bearish;
      const topY = Math.round(Math.min(yOpen, yClose) * vpr);
      const heightPx = Math.max(3, Math.round(Math.abs(yOpen - yClose) * vpr));

      const candleX = xStart * hpr;
      const candleLeftPx = Math.round(candleX - defaultBarWidthPx / 2);

      // Nominal left of next candle with a brick (or next adjacent candle slot)
      let nextNominalLeft;
      if (xEnd != null && Number.isFinite(xEnd) && idxEnd > idxStart) {
        nextNominalLeft = Math.round(xEnd * hpr - defaultBarWidthPx / 2);
      } else {
        const nextCoord = ts.logicalToCoordinate(idxStart + 1);
        nextNominalLeft = (nextCoord != null && Number.isFinite(nextCoord))
          ? Math.round(nextCoord * hpr - defaultBarWidthPx / 2)
          : Math.round(candleLeftPx + candleSlotPx);
      }

      // Intra-candle multi-brick surges:
      if (brick.totalInCandle > 1 && brick.intraIndex < brick.totalInCandle - 1) {
        continue;
      }

      const leftPx = candleLeftPx;
      const activeCandleX = (bIdx === bricks.length - 1 && idxEnd > idxStart && xEnd != null && Number.isFinite(xEnd))
        ? xEnd * hpr
        : candleX;
      const rightPx = (bIdx === bricks.length - 1)
        ? Math.max(leftPx + defaultBarWidthPx, Math.round(activeCandleX + candleSlotPx * 0.5))
        : Math.max(leftPx + defaultBarWidthPx, nextNominalLeft);
      const widthPx = Math.max(1, rightPx - leftPx);

      rawCoords.push({
        bIdx,
        brick,
        leftPx,
        rightPx,
        widthPx,
        xStart,
        xEnd,
        idxStart,
        idxEnd,
        topY,
        heightPx,
        yOpen,
        yClose,
        color,
      });
    }

    if (!rawCoords.length) return;

    // Pass 2: Viewport culling and rendering
    const minVisibleX = -defaultBarWidthPx * 2;
    const maxVisibleX = (bitmapSize?.width || 2000) + defaultBarWidthPx * 2;

    for (let i = 0; i < rawCoords.length; i++) {
      const item = rawCoords[i];
      const { brick, leftPx, rightPx, widthPx, topY, heightPx, yClose, color } = item;

      if (rightPx < minVisibleX || leftPx > maxVisibleX) continue;

      // 1. Wicks (ONLY if explicitly enabled)
      if (state.renko.showWicks === true && brick.high != null && brick.low != null) {
        const yHigh = attachedSeries.priceToCoordinate(brick.high);
        const yLow = attachedSeries.priceToCoordinate(brick.low);
        if (yHigh != null && yLow != null) {
          const wickCx = Math.round(leftPx + widthPx / 2);
          const wickTop = Math.round(Math.min(yHigh, yLow) * vpr);
          const wickH = Math.max(1, Math.round(Math.abs(yHigh - yLow) * vpr));
          ctx.fillStyle = colorWithAlpha(color, wickAlpha);
          ctx.fillRect(wickCx - Math.floor(wickWidthPx / 2), wickTop, wickWidthPx, wickH);
        }
      }

      // 2. Crisp uniform Renko Brick body: solid fill + sharp border
      ctx.save();
      ctx.fillStyle = colorWithAlpha(color, brickAlpha);
      ctx.fillRect(leftPx, topY, widthPx, heightPx);
      ctx.strokeStyle = colorWithAlpha(color, borderAlpha);
      ctx.lineWidth = Math.max(1.5, Math.round(1.5 * pixelRatio));
      ctx.strokeRect(leftPx, topY, widthPx, heightPx);
      ctx.restore();

      // 3. Connective vertical step line to next brick (orthogonal)
      if (i < rawCoords.length - 1) {
        const nextItem = rawCoords[i + 1];
        const nextYO = Math.round(nextItem.yOpen * vpr);
        const fromY = Math.round(yClose * vpr);
        if (nextYO !== fromY) {
          const stepX = nextItem.leftPx;
          ctx.save();
          ctx.strokeStyle = colorWithAlpha(nextItem.color, stepLineAlpha);
          ctx.lineWidth = Math.max(1.5, Math.round(1.5 * pixelRatio));
          ctx.beginPath();
          ctx.moveTo(stepX, fromY);
          ctx.lineTo(stepX, nextYO);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 4. For the active latest brick, project trigger levels from rightPx
    if (rawCoords.length > 0) {
      const lastItem = rawCoords[rawCoords.length - 1];
      if (lastItem.bIdx === bricks.length - 1) {
        const { brick: lastBrick, rightPx } = lastItem;

        // Project next brick trigger levels for the active latest brick
        const nextUpLevel = lastBrick.isUp
          ? lastBrick.close + state.renkoData.brickSize
          : lastBrick.open + state.renkoData.brickSize;
        const nextDownLevel = lastBrick.isUp
          ? lastBrick.open - state.renkoData.brickSize
          : lastBrick.close - state.renkoData.brickSize;

        const yUp = attachedSeries.priceToCoordinate(nextUpLevel);
        const yDown = attachedSeries.priceToCoordinate(nextDownLevel);

        if (yUp != null || yDown != null) {
          const rightEdge = bitmapSize?.width || (rightPx + 150 * hpr);

          ctx.save();
          ctx.setLineDash([4 * hpr, 3 * hpr]);
          ctx.lineWidth = Math.max(1, Math.round(1.2 * pixelRatio));

          if (yUp != null) {
            ctx.strokeStyle = colorWithAlpha(state.colors.bullish, projAlpha);
            ctx.beginPath();
            ctx.moveTo(rightPx, Math.round(yUp * vpr));
            ctx.lineTo(rightEdge, Math.round(yUp * vpr));
            ctx.stroke();
          }

          if (yDown != null) {
            ctx.strokeStyle = colorWithAlpha(state.colors.bearish, projAlpha);
            ctx.beginPath();
            ctx.moveTo(rightPx, Math.round(yDown * vpr));
            ctx.lineTo(rightEdge, Math.round(yDown * vpr));
            ctx.stroke();
          }

          ctx.restore();
        }
      }
    }
  }

  function draw(target) {
    if (!attachedChart || !attachedSeries) return;
    if (state.mode === 'off') return;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, bitmapSize }) => {
      const ts = attachedChart.timeScale();
      const visibleRange = ts.getVisibleLogicalRange?.();
      if (!visibleRange) return;

      const pixelRatio = (hpr + vpr) / 2;

      // Estimate bar spacing safely
      const x0 = ts.logicalToCoordinate(0);
      const x1 = ts.logicalToCoordinate(1);
      const barSpacingMedia = Number(ts.options?.()?.barSpacing) || ((x0 != null && x1 != null) ? Math.abs(x1 - x0) : 8);

      if (state.mode === 'heikin-ashi') {
        drawHeikinAshi(ctx, ts, visibleRange, barSpacingMedia, hpr, vpr, pixelRatio);
      } else if (state.mode === 'renko') {
        drawRenko(ctx, ts, visibleRange, barSpacingMedia, hpr, vpr, pixelRatio, bitmapSize);
      } else if (state.mode === 'both') {
        drawHeikinAshi(ctx, ts, visibleRange, barSpacingMedia, hpr, vpr, pixelRatio);
        drawRenko(ctx, ts, visibleRange, barSpacingMedia, hpr, vpr, pixelRatio, bitmapSize);
      }
    });
  }

  const paneView = {
    zOrder: () => 'top',
    renderer: () => ({ draw }),
  };

  const primitive = {
    attached(params) {
      requestUpdate = params?.requestUpdate || null;
    },
    detached() {
      requestUpdate = null;
    },
    autoscaleInfo() {
      return null;
    },
    updateAllViews() {},
    paneViews: () => [paneView],
  };

  function attachIfNeeded() {
    const chart = typeof getChart === 'function' ? getChart() : null;
    const series = typeof getCandleSeries === 'function' ? getCandleSeries() : null;
    if (!chart || !series || state.mode === 'off') return false;
    if (attachedChart === chart && attachedSeries === series) return true;

    if (attachedSeries && typeof attachedSeries.detachPrimitive === 'function') {
      try { attachedSeries.detachPrimitive(primitive); } catch {}
    }
    attachedChart = chart;
    attachedSeries = series;
    try {
      series.attachPrimitive(primitive);
      return true;
    } catch {
      attachedChart = null;
      attachedSeries = null;
      return false;
    }
  }

  function detach() {
    if (attachedSeries && typeof attachedSeries.detachPrimitive === 'function') {
      try { attachedSeries.detachPrimitive(primitive); } catch {}
    }
    attachedChart = null;
    attachedSeries = null;
    requestUpdate = null;
  }

  function recompute() {
    if (state.mode === 'off' || !state.candles.length) {
      state.haCandles = [];
      state.renkoData = { bricks: [], brickSize: 0, currentDirection: 0 };
      return;
    }

    const liveCandle = state.candles[state.candles.length - 1];
    const liveTime = normalizeTimestamp(liveCandle?.t ?? liveCandle?.time);
    const renkoSource = state.closedCandles !== null ? state.closedCandles : state.candles;
    const renkoOptions = { ...state.renko, liveTime };

    if (state.mode === 'heikin-ashi') {
      state.haCandles = computeHeikinAshi(state.candles);
      state.renkoData = { bricks: [], brickSize: 0, currentDirection: 0 };
    } else if (state.mode === 'renko') {
      state.haCandles = [];
      state.renkoData = computeRenkoBricks(renkoSource, renkoOptions);
    } else if (state.mode === 'both') {
      state.haCandles = computeHeikinAshi(state.candles);
      state.renkoData = computeRenkoBricks(renkoSource, renkoOptions);
    }
  }

  function setCandles(candles = [], coin = '', timeframe = '', { closedCandles = null } = {}) {
    state.candles = Array.isArray(candles) ? candles : [];
    state.closedCandles = Array.isArray(closedCandles) ? closedCandles : null;
    state.coin = String(coin || '');
    state.timeframe = String(timeframe || '');

    recompute();

    if (state.mode !== 'off') {
      attachIfNeeded();
      redraw();
    } else {
      detach();
    }
  }

  function updateLast(candles = [], maybeCoin = '', maybeTimeframe = '', { closedCandles = null } = {}) {
    let coin = '';
    let timeframe = '';
    if (maybeTimeframe && typeof maybeTimeframe === 'string') {
      coin = String(maybeCoin || '');
      timeframe = String(maybeTimeframe || '');
    } else if (maybeCoin && typeof maybeCoin === 'string') {
      if (/^\d+[mhdws]$/i.test(maybeCoin)) {
        timeframe = String(maybeCoin);
      } else {
        coin = String(maybeCoin);
      }
    }

    if (coin && state.coin && coin !== state.coin) {
      return;
    }
    if (timeframe && state.timeframe && timeframe !== state.timeframe) {
      return;
    }
    if (coin) state.coin = coin;
    if (timeframe) state.timeframe = timeframe;
    if (Array.isArray(candles)) state.candles = candles;
    if (closedCandles !== null) {
      state.closedCandles = Array.isArray(closedCandles) ? closedCandles : null;
    }

    if (state.mode === 'off') return;

    recompute();
    attachIfNeeded();
    redraw();
  }

  function setOptions(opts = {}) {
    let recomputeNeeded = false;
    let redrawNeeded = false;

    if (opts.mode !== undefined && opts.mode !== state.mode) {
      state.mode = CANDLE_OVERLAY_MODES.includes(opts.mode) ? opts.mode : 'off';
      recomputeNeeded = true;
      redrawNeeded = true;
    }
    if (opts.baseCandles !== undefined && opts.baseCandles !== state.baseCandles) {
      state.baseCandles = BASE_CANDLE_MODES.includes(opts.baseCandles) ? opts.baseCandles : 'dimmed';
      redrawNeeded = true;
    }
    if (opts.contrast !== undefined) {
      const c = Number(opts.contrast);
      if (Number.isFinite(c) && c !== state.contrast) {
        state.contrast = Math.max(0.05, Math.min(1.0, c));
        redrawNeeded = true;
      }
    }
    if (opts.heikinAshi) {
      const ha = opts.heikinAshi;
      let haChanged = false;
      if (ha.opacity !== undefined) {
        const o = Number(ha.opacity);
        const validO = Number.isFinite(o) ? Math.max(0.05, Math.min(1.0, o)) : 0.5;
        if (validO !== state.heikinAshi.opacity) {
          state.heikinAshi.opacity = validO;
          haChanged = true;
        }
      }
      if (ha.dimmed !== undefined) {
        const d = ha.dimmed === true || ha.dimmed === 'true';
        if (d !== state.heikinAshi.dimmed) {
          state.heikinAshi.dimmed = d;
          haChanged = true;
        }
      }
      if (ha.showWicks !== undefined) {
        const sw = ha.showWicks !== false;
        if (sw !== state.heikinAshi.showWicks) {
          state.heikinAshi.showWicks = sw;
          haChanged = true;
        }
      }
      if (haChanged) redrawNeeded = true;
    }
    if (opts.renko) {
      const r = opts.renko;
      let renkoCalcChanged = false;
      let renkoVisualChanged = false;

      if (r.brickMode !== undefined && r.brickMode !== state.renko.brickMode) {
        state.renko.brickMode = r.brickMode;
        renkoCalcChanged = true;
      }
      if (r.fixedSize !== undefined) {
        const fs = Number(r.fixedSize) || 0;
        if (fs !== state.renko.fixedSize) {
          state.renko.fixedSize = fs;
          renkoCalcChanged = true;
        }
      }
      if (r.percent !== undefined) {
        const pct = Number(r.percent) || 0;
        if (pct !== state.renko.percent) {
          state.renko.percent = pct;
          renkoCalcChanged = true;
        }
      }
      if (r.atrPeriod !== undefined) {
        const ap = Number(r.atrPeriod) || 14;
        if (ap !== state.renko.atrPeriod) {
          state.renko.atrPeriod = ap;
          renkoCalcChanged = true;
        }
      }
      if (r.opacity !== undefined) {
        const o = Number(r.opacity);
        const validO = Number.isFinite(o) ? Math.max(0.05, Math.min(1.0, o)) : 0.5;
        if (validO !== state.renko.opacity) {
          state.renko.opacity = validO;
          renkoVisualChanged = true;
        }
      }
      if (r.dimmed !== undefined) {
        const d = r.dimmed === true || r.dimmed === 'true';
        if (d !== state.renko.dimmed) {
          state.renko.dimmed = d;
          renkoVisualChanged = true;
        }
      }
      if (r.showWicks !== undefined) {
        const sw = r.showWicks === true || r.showWicks === 'true';
        if (sw !== state.renko.showWicks) {
          state.renko.showWicks = sw;
          renkoVisualChanged = true;
        }
      }

      if (renkoCalcChanged) {
        recomputeNeeded = true;
        redrawNeeded = true;
      } else if (renkoVisualChanged) {
        redrawNeeded = true;
      }
    }

    if (recomputeNeeded) {
      recompute();
    }
    if (state.mode !== 'off') {
      attachIfNeeded();
    } else {
      detach();
    }
    if (redrawNeeded) {
      redraw();
    }
  }

  function applyTheme() {
    state.colors = getCandleOverlayColors();
    redraw();
  }

  function getDebugState() {
    return {
      mode: state.mode,
      baseCandles: state.baseCandles,
      contrast: state.contrast,
      heikinAshi: { ...state.heikinAshi },
      renko: { ...state.renko },
      coin: state.coin,
      timeframe: state.timeframe,
      candleCount: state.candles.length,
      haCount: state.haCandles.length,
      renkoBrickCount: state.renkoData.bricks.length,
      renkoBrickSize: state.renkoData.brickSize,
      attached: attachedSeries != null,
    };
  }

  return {
    setCandles,
    updateLast,
    setOptions,
    applyTheme,
    detach,
    getDebugState,
    _getInternalState: () => state,
  };
}
