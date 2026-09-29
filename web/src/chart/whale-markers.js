/**
 * On-Chart Historical Whale Markers Indicator
 *
 * Visualizes historical whale volume directly on the price chart from the
 * built-in historical candle data stream:
 *   - Evaluated across completed historical candles (strictly excluding the
 *     live forming bar)
 *   - Plotted as circles at the exact execution price and time on the chart
 *   - Circle radii scale logarithmically with USD notional (volume * price)
 *   - Specially highlights mega prints over $1,000,000 USD with distinct concentric
 *     dashed accent halo rings and compact notional text badges (e.g. $1.0M, $2.5M)
 *   - Major prints (>= $250k) feature a solid inner core
 *   - Side coloring:
 *     - Buyer-dominant (cvdDelta >= 0 or close >= open): Bullish palette color
 *     - Seller-dominant (cvdDelta < 0 or close < open): Bearish palette color
 *
 * Attached to the candlestick series as a lightweight-charts series primitive
 * in bitmap coordinate space (zero autoscale distortion).
 */

import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
import { selectClosedCandles } from '../state/market-candles.js';

export const WHALE_THRESHOLDS = Object.freeze([100000, 250000, 500000, 1000000, 5000000]);
export const MAJOR_WHALE_USD = 250000;
export const MEGA_WHALE_USD = 1000000;
export const MAX_WHALE_SCALE_USD = 5000000;

export function getWhaleMarkerColors() {
  return {
    bullish: getPaletteColor('bullish') || '#22cce6',
    bearish: getPaletteColor('bearish') || '#ff5050',
  };
}

export const normalizeTimestamp = (time) => {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
};

export function formatNotionalCompact(val) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `$${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Computes circle radius in CSS media pixels for a given trade notional.
 * Sized conservatively (3.5px - 14px max) to serve as elegant, unobtrusive
 * chart markers without obscuring candlesticks, wicks, or price action.
 */
export function getWhaleRadius(notional, minNotional = 100000) {
  const minFloor = Math.max(1000, Number(minNotional) || 100000);
  const val = Math.max(minFloor, Number(notional) || 0);
  const maxCap = Math.max(minFloor * 2, MAX_WHALE_SCALE_USD);
  const t = Math.min(1, Math.max(0, Math.log(val / minFloor) / Math.log(maxCap / minFloor)));
  // Radius scales from 3.5px up to 12px; mega whales (>= $1M) scale up to 14px for extreme prints
  const baseRadius = 3.5;
  const maxRadius = 12;
  let r = baseRadius + t * (maxRadius - baseRadius);
  if (val >= MEGA_WHALE_USD) {
    const extraMega = Math.min(2, ((val - MEGA_WHALE_USD) / (MAX_WHALE_SCALE_USD * 2)) * 2);
    r += extraMega;
  }
  return r;
}

export const DEFAULT_WHALE_LOOKBACK = 20;
export const DEFAULT_SWING_WINDOW = 12;
export const DEFAULT_ACTIVITY_THRESHOLD = 1.8;
export const DEFAULT_CLUSTER_RADIUS = 2;

/**
 * Pure function: calculates historical whale markers from closed candles.
 * Evaluates tape speed, relative volume (RVOL), and structural chart levels
 * to isolate true institutional inflections and avoid overwhelming the chart:
 *   1. Activity surge: tape speed (trade count n) or RVOL >= 1.8x baseline
 *   2. Structural level: local swing high/low, liquidity sweep/SFP, absorption wick,
 *      range breakout, or extreme volume climax
 *   3. Cluster peak suppression: eliminates overlapping multi-bar sausages by
 *      isolating the dominant climax bar per cluster
 */
export function computeWhaleMarkers(candles = [], options = {}) {
  const minNotional = Number(options.minNotional || 100000);
  const lookback = Number(options.lookback || DEFAULT_WHALE_LOOKBACK);
  const swingWindow = Number(options.swingWindow || DEFAULT_SWING_WINDOW);
  const activityThreshold = Number(options.activityThreshold || DEFAULT_ACTIVITY_THRESHOLD);
  const clusterRadius = options.clusterRadius !== undefined ? Number(options.clusterRadius) : DEFAULT_CLUSTER_RADIUS;

  if (!Array.isArray(candles) || candles.length === 0) return [];

  const candidates = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const time = normalizeTimestamp(candle.t);
    const o = Number(candle.o);
    const h = Number(candle.h);
    const l = Number(candle.l);
    const c = Number(candle.c);
    const v = Number(candle.v);
    if (!(time > 0) || !Number.isFinite(c) || !(v > 0)) continue;

    const notional = v * c;
    if (notional < minNotional) continue;

    const price = [h, l, c].every(Number.isFinite) ? (h + l + c) / 3 : c;
    const cvdDelta = Number(candle.cvdDelta);
    const isBuy = Number.isFinite(cvdDelta) ? cvdDelta >= 0 : c >= (Number.isFinite(o) ? o : c);

    // Lookback window for relative baseline
    const startIdx = Math.max(0, i - lookback);
    const windowBars = candles.slice(startIdx, i);

    let activityScore = 1;
    let rvol = 1;
    let tapeSpeedRatio = 1;
    let isImportantLevel = false;
    let isActivitySurge = false;
    let levelType = 'standard';

    if (windowBars.length >= 4) {
      // 1. Relative Volume (RVOL)
      const avgNotional = windowBars.reduce((sum, b) => sum + (Number(b.v || 0) * Number(b.c || 0)), 0) / windowBars.length;
      rvol = avgNotional > 0 ? notional / avgNotional : 1;

      // 2. Tape Speed (trade count surge)
      const tradeCount = Number(candle.n);
      if (Number.isFinite(tradeCount) && tradeCount > 0) {
        const avgN = windowBars.reduce((sum, b) => sum + (Number(b.n) || 0), 0) / windowBars.length;
        tapeSpeedRatio = avgN > 0 ? tradeCount / avgN : rvol;
      } else {
        tapeSpeedRatio = rvol;
      }

      activityScore = Math.max(rvol, tapeSpeedRatio);

      // 3. Important Level Qualification:
      // Local swing high/low lookback
      const swingStart = Math.max(0, i - swingWindow);
      const swingBars = candles.slice(swingStart, i);
      const priorHigh = Math.max(...swingBars.map((b) => Number(b.h) || Number(b.c) || 0));
      const priorLow = Math.min(...swingBars.map((b) => Number(b.l) || Number(b.c) || Infinity));

      const avgRange = windowBars.reduce((sum, b) => {
        const bh = Number(b.h) || Number(b.c);
        const bl = Number(b.l) || Number(b.c);
        return sum + Math.max(0, bh - bl);
      }, 0) / windowBars.length;

      const barRange = Math.max(0, (Number.isFinite(h) ? h : c) - (Number.isFinite(l) ? l : c));

      // Structural level conditions:
      // a. Swing high / low test
      const isSwingHigh = Number.isFinite(h) && priorHigh > 0 && h >= priorHigh;
      const isSwingLow = Number.isFinite(l) && priorLow < Infinity && l <= priorLow;

      // b. Liquidity sweep / Swing failure pattern (SFP)
      const isSweepHigh = Number.isFinite(h) && priorHigh > 0 && h > priorHigh && c < priorHigh;
      const isSweepLow = Number.isFinite(l) && priorLow < Infinity && l < priorLow && c > priorLow;

      // c. Absorption climax wicks
      const bodyTop = Math.max(Number.isFinite(o) ? o : c, c);
      const bodyBottom = Math.min(Number.isFinite(o) ? o : c, c);
      const upperWickRatio = barRange > 0 ? (h - bodyTop) / barRange : 0;
      const lowerWickRatio = barRange > 0 ? (bodyBottom - l) / barRange : 0;
      const isAbsorption = (upperWickRatio >= 0.35 && priorHigh > 0 && h >= priorHigh * 0.998) ||
                           (lowerWickRatio >= 0.35 && priorLow < Infinity && l <= priorLow * 1.002);

      // d. Volatility breakout
      const isBreakout = avgRange > 0 && barRange >= 1.5 * avgRange && (c > priorHigh || c < priorLow);

      // e. Extreme volume climax (major institutional print)
      const isVolumeClimax = rvol >= 2.5 || notional >= minNotional * 5;

      isImportantLevel = isSwingHigh || isSwingLow || isSweepHigh || isSweepLow ||
                         isAbsorption || isBreakout || isVolumeClimax;

      isActivitySurge = activityScore >= activityThreshold || isVolumeClimax || notional >= MEGA_WHALE_USD;

      levelType = isSweepHigh || isSweepLow ? 'sweep'
        : isAbsorption ? 'absorption'
        : isBreakout ? 'breakout'
        : isSwingHigh || isSwingLow ? 'swing'
        : 'climax';
    } else {
      // Short or early history: qualify if meeting notional threshold
      activityScore = 1;
      rvol = 1;
      tapeSpeedRatio = 1;
      isImportantLevel = true;
      isActivitySurge = true;
      levelType = 'early';
    }

    if (isActivitySurge && isImportantLevel) {
      candidates.push({
        index: i,
        time,
        price,
        notional,
        isBuy,
        isMajorWhale: notional >= MAJOR_WHALE_USD,
        isMegaWhale: notional >= MEGA_WHALE_USD,
        activityScore,
        rvol,
        tapeSpeedRatio,
        levelType,
        // Score used for cluster peak selection: product of activity surge and logarithmic size
        peakScore: activityScore * Math.log10(Math.max(10, notional)),
      });
    }
  }

  // 4. Cluster Peak Suppression:
  // When high-velocity multi-bar runs occur, suppress adjacent bars to leave only the climax marker
  if (clusterRadius <= 0 || candidates.length <= 1) {
    return candidates.map(({ index, peakScore, ...rest }) => rest);
  }

  const result = [];
  for (let k = 0; k < candidates.length; k++) {
    const cand = candidates[k];
    let isDominantPeak = true;

    for (let j = 0; j < candidates.length; j++) {
      if (j === k) continue;
      const other = candidates[j];
      if (Math.abs(other.index - cand.index) <= clusterRadius) {
        if (other.peakScore > cand.peakScore || (other.peakScore === cand.peakScore && other.index < cand.index)) {
          isDominantPeak = false;
          break;
        }
      }
    }

    if (isDominantPeak) {
      const { index, peakScore, ...marker } = cand;
      result.push(marker);
    }
  }

  return result;
}

/**
 * Creates the lightweight-charts series primitive overlay for on-chart whale markers.
 */
export function createWhaleMarkersOverlay({ getChart, getCandleSeries, options = {} } = {}) {
  let attachedChart = null;
  let attachedSeries = null;
  let requestUpdate = null;

  const state = {
    visible: false,
    minNotional: 100000,
    clusterRadius: DEFAULT_CLUSTER_RADIUS,
    coin: '',
    timeframe: '',
    rawCandles: [],
    markers: [],
    colors: getWhaleMarkerColors(),
    lastCount: 0,
  };

  if (options.visible !== undefined) state.visible = Boolean(options.visible);
  if (options.minNotional !== undefined) state.minNotional = Number(options.minNotional) || 100000;
  if (options.clusterRadius !== undefined) state.clusterRadius = Number(options.clusterRadius);

  function draw(target) {
    if (!attachedChart || !attachedSeries || !state.visible || state.markers.length === 0) return;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const ts = attachedChart.timeScale();
      const visibleRange = ts.getVisibleLogicalRange?.();
      if (!visibleRange) return;

      const minNotional = Math.max(0, Number(state.minNotional) || 100000);
      const pixelRatio = (hpr + vpr) / 2;

      for (const marker of state.markers) {
        if (marker.notional < minNotional) continue;
        const timeSec = marker.time;
        const idx = ts.timeToIndex(timeSec, true);
        if (idx === null || idx === undefined) continue;

        // Viewport culling (only render visible circles)
        if (idx < visibleRange.from - 2 || idx > visibleRange.to + 2) continue;

        const x = ts.logicalToCoordinate(idx);
        const y = attachedSeries.priceToCoordinate(marker.price);
        if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;

        if (ctx?.canvas?.height) {
          const canvasH = Number(ctx.canvas.height) / (vpr || 1);
          if (y < -40 || y > canvasH + 40) continue;
        }

        const color = marker.isBuy ? state.colors.bullish : state.colors.bearish;
        const r = getWhaleRadius(marker.notional, minNotional);
        const rPx = r * pixelRatio;
        const cx = x * hpr;
        const cy = y * vpr;

        ctx.save();

        // 1. Outer circle body - delicate translucency so price action remains visible
        ctx.beginPath();
        ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
        ctx.fillStyle = colorWithAlpha(color, 0.18);
        ctx.fill();
        ctx.lineWidth = Math.max(1, 1.2 * pixelRatio);
        ctx.strokeStyle = colorWithAlpha(color, 0.70);
        ctx.stroke();

        // 2. Major whale accent (>= $250k): subtle solid inner center core
        if (marker.isMajorWhale) {
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1.2 * pixelRatio, rPx * 0.28), 0, Math.PI * 2);
          ctx.fillStyle = colorWithAlpha(color, 0.85);
          ctx.fill();
        }

        // 3. Mega whale accent (>= $1,000,000 USD): outer dashed halo ring + compact notional badge
        if (marker.isMegaWhale) {
          ctx.beginPath();
          ctx.arc(cx, cy, rPx + 3 * pixelRatio, 0, Math.PI * 2);
          ctx.lineWidth = Math.max(1, 1.0 * pixelRatio);
          ctx.strokeStyle = colorWithAlpha(color, 0.45);
          ctx.setLineDash([3 * hpr, 3 * hpr]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Compact USD text badge on circle
          const label = formatNotionalCompact(marker.notional);
          const fontSize = Math.max(8, Math.round(8.5 * pixelRatio));
          ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // Draw subtle text shadow for contrast
          ctx.fillStyle = 'rgba(0, 0, 0, 0.70)';
          ctx.fillText(label, cx + 1, cy + 1);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(label, cx, cy);
        }

        ctx.restore();
      }
    });
  }

  const paneView = {
    zOrder: () => 'bottom',
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

  function redraw() {
    if (typeof requestUpdate === 'function') {
      try { requestUpdate(); } catch {}
    }
  }

  function detach() {
    if (attachedSeries && typeof attachedSeries.detachPrimitive === 'function') {
      try { attachedSeries.detachPrimitive(primitive); } catch {}
    }
    attachedChart = null;
    attachedSeries = null;
    requestUpdate = null;
    state.markers = [];
    state.rawCandles = [];
    state.lastCount = 0;
  }

  function attachIfNeeded() {
    const chart = typeof getChart === 'function' ? getChart() : null;
    const series = typeof getCandleSeries === 'function' ? getCandleSeries() : null;
    if (!chart || !series || !state.visible) return false;
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

  function setOptions(opts = {}) {
    let recompute = false;
    if (opts.visible !== undefined) {
      state.visible = Boolean(opts.visible);
      if (!state.visible) {
        detach();
        return;
      }
    }
    if (opts.minNotional !== undefined) {
      const n = Number(opts.minNotional);
      const nextMin = Number.isFinite(n) && n > 0 ? n : 100000;
      if (nextMin !== state.minNotional) {
        state.minNotional = nextMin;
        recompute = true;
      }
    }
    if (opts.clusterRadius !== undefined) {
      const cr = Number(opts.clusterRadius);
      if (cr !== state.clusterRadius) {
        state.clusterRadius = cr;
        recompute = true;
      }
    }
    if (recompute && state.rawCandles.length > 0) {
      state.markers = computeWhaleMarkers(state.rawCandles, {
        minNotional: state.minNotional,
        clusterRadius: state.clusterRadius,
      });
      state.lastCount = state.markers.length;
    }
    if (state.visible) {
      attachIfNeeded();
      redraw();
    }
  }

  function setCandles(candles = [], coin = '', timeframe = '') {
    state.coin = String(coin || '').toUpperCase();
    state.timeframe = String(timeframe || '');
    // Ensure only closed historical candles are used ("historical, not live or current bar")
    if (state.timeframe) {
      state.rawCandles = selectClosedCandles(candles, state.timeframe);
    } else {
      state.rawCandles = Array.isArray(candles) ? candles : [];
    }
    state.markers = computeWhaleMarkers(state.rawCandles, {
      minNotional: state.minNotional,
      clusterRadius: state.clusterRadius,
    });
    state.lastCount = state.markers.length;
    if (state.visible) {
      attachIfNeeded();
      redraw();
    }
  }

  function updateLast(candles = [], timeframe = '') {
    // Current / live forming bar is explicitly excluded ("not live or current bar").
    // Only recompute when a closed candle completes and enters history.
    if (!state.visible || !Array.isArray(candles)) return;
    const tf = timeframe || state.timeframe;
    const closed = tf ? selectClosedCandles(candles, tf) : candles;
    if (closed.length !== state.rawCandles.length) {
      setCandles(closed, state.coin, tf);
    }
  }

  function applyTheme() {
    state.colors = getWhaleMarkerColors();
    if (state.visible) redraw();
  }

  function getDebugState() {
    return {
      visible: state.visible,
      minNotional: state.minNotional,
      coin: state.coin,
      timeframe: state.timeframe,
      markerCount: state.markers.length,
      attached: attachedSeries !== null,
    };
  }

  return {
    attachIfNeeded,
    detach,
    redraw,
    setOptions,
    setCandles,
    updateLast,
    applyTheme,
    getDebugState,
    _getInternalState: () => state,
  };
}
