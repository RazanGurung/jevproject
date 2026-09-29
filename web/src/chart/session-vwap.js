/**
 * Automated Session Anchored VWAP (Auto-AVWAP)
 *
 * Renders automated volume-weighted average price (VWAP) curves resetting at
 * canonical UTC session boundaries:
 *   - Daily (D): Resets at 00:00:00 UTC each day.
 *   - Weekly (W): Resets on Monday at 00:00:00 UTC (ISO week).
 *   - Monthly (M): Resets on the 1st of each month at 00:00:00 UTC.
 *
 * For each session, tracks the developing volume-weighted HLC3 benchmark.
 * For the active and recent sessions, also projects the prior session's
 * closing VWAP (pD-VWAP, pW-VWAP, pM-VWAP) as a dashed horizontal reference level.
 *
 * Rendering uses a lightweight-charts series primitive attached to the candle
 * series: lines are drawn in bitmap coordinate space, track zoom/pan without
 * price scale distortion, and break cleanly at session boundaries without
 * diagonal reset artifacts.
 */

import { getPaletteColor } from '../services/color-palette.js';

export const SESSION_VWAP_PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);

export const DEFAULT_SESSION_VWAP_OPTIONS = Object.freeze({
  daily: false,
  weekly: false,
  monthly: false,
  maxBars: 4800,
});

const TIMEFRAME_MINUTES = Object.freeze({
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '8h': 480,
  '1d': 1440,
  '1w': 10080,
  '1M': 43200,
});

export function timeframeToMinutes(tf) {
  if (!tf) return 60;
  const direct = TIMEFRAME_MINUTES[tf];
  if (direct) return direct;
  const match = /^(\d+)([mhdM])$/.exec(tf);
  if (!match) return 60;
  const count = Number(match[1]);
  const unit = match[2];
  if (unit === 'm') return count;
  if (unit === 'h') return count * 60;
  if (unit === 'd') return count * 1440;
  if (unit === 'M') return count * 43200;
  return 60;
}

export function isSessionPeriodSupported(period, timeframe) {
  const minutes = timeframeToMinutes(timeframe);
  if (period === 'daily') return minutes < 1440;
  if (period === 'weekly') return minutes < 10080;
  if (period === 'monthly') return minutes < 43200;
  return false;
}

const normalizeTimestamp = (time) => {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
};

function dedupeAndSort(candles) {
  const byTime = new Map();
  for (const c of Array.isArray(candles) ? candles : []) {
    const t = normalizeTimestamp(c?.t);
    const h = Number(c?.h);
    const l = Number(c?.l);
    const cl = Number(c?.c);
    const v = Number(c?.v);
    if (t > 0 && [h, l, cl].every(Number.isFinite) && Number.isFinite(v) && v >= 0) {
      byTime.set(t, { ...c, t, h, l, c: cl, v });
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function getSessionStartSec(timeSec, period) {
  const d = new Date(timeSec * 1000);
  if (period === 'daily') {
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
  }
  if (period === 'weekly') {
    const dayOfWeek = d.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
    const daysSinceMon = (dayOfWeek + 6) % 7;
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMon) / 1000);
  }
  if (period === 'monthly') {
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  }
  return timeSec;
}

const MAX_SESSIONS_BY_PERIOD = Object.freeze({
  daily: 4,
  weekly: 4,
  monthly: 3,
});

/**
 * Pure computation of session VWAPs.
 *
 * @param {Array} candles - OHLCV candle list
 * @param {string} timeframe - Current chart timeframe (e.g. '1h', '4h')
 * @param {Object} options - { daily: boolean, weekly: boolean, monthly: boolean, maxBars: number }
 * @returns {Object} Map of period -> Array of SessionObjects:
 *   [{ period, sessionStart, startTime, endTime, closeVwap, priorVwap, points: [{ time, vwap }] }]
 */
export function computeSessionVwaps(candles, timeframe, options = {}) {
  const opts = { ...DEFAULT_SESSION_VWAP_OPTIONS, ...(options || {}) };
  const sorted = dedupeAndSort(candles).slice(-(opts.maxBars || 4800));
  if (sorted.length === 0) return { daily: [], weekly: [], monthly: [] };

  const result = { daily: [], weekly: [], monthly: [] };

  for (const period of SESSION_VWAP_PERIODS) {
    if (opts[period] !== true) continue;
    if (!isSessionPeriodSupported(period, timeframe)) continue;

    const groups = [];
    let currentSessionStart = null;

    for (const c of sorted) {
      const sessionStart = getSessionStartSec(c.t, period);
      if (sessionStart !== currentSessionStart) {
        currentSessionStart = sessionStart;
        groups.push({
          sessionStart,
          bars: [],
        });
      }
      groups[groups.length - 1].bars.push(c);
    }

    const maxKeep = MAX_SESSIONS_BY_PERIOD[period] || 3;
    const keptGroups = groups.slice(-maxKeep);

    const sessions = [];
    let previousCloseVwap = null;

    // To establish priorVwap accurately for the oldest kept session, check the
    // preceding group if one existed in the full series.
    const oldestKeptIndex = groups.length - keptGroups.length;
    if (oldestKeptIndex > 0) {
      const precedingBars = groups[oldestKeptIndex - 1].bars;
      let prevSumV = 0;
      let prevSumVP = 0;
      for (const bar of precedingBars) {
        const v = Math.max(0, bar.v);
        const p = (bar.h + bar.l + bar.c) / 3;
        prevSumV += v;
        prevSumVP += v * p;
      }
      if (prevSumV > 0) previousCloseVwap = prevSumVP / prevSumV;
    }

    for (const group of keptGroups) {
      let sumVol = 0;
      let sumVolPrice = 0;
      const points = [];

      for (const bar of group.bars) {
        const v = Math.max(0, bar.v);
        const p = (bar.h + bar.l + bar.c) / 3;
        sumVol += v;
        sumVolPrice += v * p;
        const vwap = sumVol > 0 ? sumVolPrice / sumVol : p;
        points.push({ time: bar.t, vwap });
      }

      if (points.length === 0) continue;

      const closeVwap = points[points.length - 1].vwap;
      sessions.push({
        period,
        sessionStart: group.sessionStart,
        startTime: points[0].time,
        endTime: points[points.length - 1].time,
        closeVwap,
        priorVwap: previousCloseVwap,
        points,
      });

      previousCloseVwap = closeVwap;
    }

    result[period] = sessions;
  }

  return result;
}

export function getSessionColors() {
  const daily = getPaletteColor('sessionDaily') || '#22cce6';
  const weekly = getPaletteColor('sessionWeekly') || getPaletteColor('avwap') || '#4a9eff';
  const monthly = getPaletteColor('sessionMonthly') || '#a78bfa';
  return {
    daily,
    weekly,
    monthly,
  };
}

const PRIOR_LABELS = Object.freeze({
  daily: 'pD-VWAP',
  weekly: 'pW-VWAP',
  monthly: 'pM-VWAP',
});

/**
 * Creates the lightweight-charts series primitive overlay for automated session VWAPs.
 */
export function createSessionVwapOverlay({ getChart, getCandleSeries }) {
  let attachedChart = null;
  let attachedSeries = null;
  let requestUpdate = null;
  let lastSig = '';
  let lastSnapshotRevision = -1;

  const state = {
    options: { ...DEFAULT_SESSION_VWAP_OPTIONS },
    data: { daily: [], weekly: [], monthly: [] },
    timeframe: '1h',
    coin: '',
    colors: getSessionColors(),
  };

  function candlesSignature(candles, coin, timeframe, options) {
    if (!Array.isArray(candles) || candles.length === 0) return '0';
    const first = candles[0];
    const last = candles[candles.length - 1];
    const optsKey = `${options.daily ? 1 : 0}:${options.weekly ? 1 : 0}:${options.monthly ? 1 : 0}`;
    return `${coin}:${timeframe}:${optsKey}:${candles.length}:${first?.t || 0}:${last?.t || 0}:${last?.c || 0}:${last?.v || 0}`;
  }

  function draw(target) {
    if (!attachedChart || !attachedSeries) return;
    const hasAnySessions = (state.data.daily.length > 0 || state.data.weekly.length > 0 || state.data.monthly.length > 0);
    if (!hasAnySessions) return;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const ts = attachedChart.timeScale();

      for (const period of SESSION_VWAP_PERIODS) {
        if (state.options[period] !== true) continue;
        const sessions = state.data[period] || [];
        if (sessions.length === 0) continue;

        const color = state.colors[period] || '#4a9eff';
        const labelText = PRIOR_LABELS[period] || 'p-VWAP';

        for (const session of sessions) {
          // 1. Draw developing VWAP line
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, 1.5 * vpr);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.setLineDash([]);
          ctx.beginPath();

          let firstPoint = true;
          for (const pt of session.points) {
            const idx = ts.timeToIndex(pt.time, true);
            if (idx == null) continue;
            const x = ts.logicalToCoordinate(idx);
            const y = attachedSeries.priceToCoordinate(pt.vwap);
            if (x == null || y == null) continue;

            if (firstPoint) {
              ctx.moveTo(x * hpr, y * vpr);
              firstPoint = false;
            } else {
              ctx.lineTo(x * hpr, y * vpr);
            }
          }
          if (!firstPoint) ctx.stroke();
          ctx.restore();

          // 2. Draw prior session close reference line (if available)
          if (session.priorVwap != null && Number.isFinite(session.priorVwap)) {
            const iStart = ts.timeToIndex(session.startTime, true);
            const iEnd = ts.timeToIndex(session.endTime, true);
            if (iStart != null && iEnd != null) {
              const xStart = ts.logicalToCoordinate(iStart);
              const xEnd = ts.logicalToCoordinate(iEnd);
              const yPrior = attachedSeries.priceToCoordinate(session.priorVwap);

              if (xStart != null && xEnd != null && yPrior != null && xEnd >= xStart) {
                let inView = true;
                if (ctx?.canvas?.height) {
                  const canvasH = Number(ctx.canvas.height) / (vpr || 1);
                  if (yPrior < -20 || yPrior > canvasH + 20) inView = false;
                }
                if (inView) {
                  ctx.save();
                  ctx.strokeStyle = color;
                  ctx.globalAlpha = 0.65;
                  ctx.lineWidth = Math.max(1, 1 * vpr);
                  ctx.setLineDash([3 * hpr, 3 * hpr]);
                  ctx.beginPath();
                  ctx.moveTo(xStart * hpr, yPrior * vpr);
                  ctx.lineTo(xEnd * hpr, yPrior * vpr);
                  ctx.stroke();

                  // Reference label: docks to visible left edge if session start is scrolled offscreen
                  const labelX = Math.max(xStart + 4, 8);
                  if (labelX + 45 <= xEnd) {
                    ctx.font = `${Math.max(9, Math.round(9 * vpr))}px 'JetBrains Mono', monospace`;
                    ctx.fillStyle = color;
                    ctx.fillText(labelText, labelX * hpr, (yPrior - 3) * vpr);
                  }
                  ctx.restore();
                }
              }
            }
          }
        }
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
    state.data = { daily: [], weekly: [], monthly: [] };
    lastSig = '';
    lastSnapshotRevision = -1;
  }

  function attachIfNeeded() {
    const chart = getChart();
    const series = getCandleSeries();
    if (!chart || !series) return false;
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

  function setOptions(options = {}) {
    state.options = { ...state.options, ...(options || {}) };
    const hasAnyActive = (state.options.daily === true || state.options.weekly === true || state.options.monthly === true);
    if (!hasAnyActive) {
      detach();
      return;
    }
    lastSig = '';
  }

  function setCandles(candles, coin, timeframe, snapshotRevision = -1) {
    const hasAnyActive = (state.options.daily === true || state.options.weekly === true || state.options.monthly === true);
    if (!hasAnyActive) {
      detach();
      return;
    }

    const sig = candlesSignature(candles, coin, timeframe, state.options);
    if (sig === lastSig && snapshotRevision === lastSnapshotRevision && snapshotRevision !== -1) {
      return;
    }
    lastSig = sig;
    lastSnapshotRevision = snapshotRevision;

    state.coin = coin;
    state.timeframe = timeframe;
    state.data = computeSessionVwaps(candles, timeframe, state.options);

    attachIfNeeded();
    redraw();
  }

  function updateLast(candles, timeframe) {
    const hasAnyActive = (state.options.daily === true || state.options.weekly === true || state.options.monthly === true);
    if (!hasAnyActive) return;

    if (Array.isArray(candles) && candles.length > 0) {
      state.timeframe = timeframe || state.timeframe;
      state.data = computeSessionVwaps(candles, state.timeframe, state.options);
      attachIfNeeded();
      redraw();
    }
  }

  function applyTheme() {
    state.colors = getSessionColors();
    redraw();
  }

  function getDebugState() {
    return {
      attached: attachedSeries !== null,
      options: { ...state.options },
      timeframe: state.timeframe,
      coin: state.coin,
      dailyCount: state.data.daily.length,
      weeklyCount: state.data.weekly.length,
      monthlyCount: state.data.monthly.length,
    };
  }

  return {
    setOptions,
    setCandles,
    updateLast,
    applyTheme,
    detach,
    getDebugState,
  };
}
