import { colorRgbChannels, getPaletteColor } from '../services/color-palette.js';
import { computeMonthlyVolumeProfiles } from './monthly-volume-profile.js';
import {
  computePriceProjection,
  utcMonthEndUnix,
  utcMonthStartUnix,
} from './price-projection.js';
import { DEFAULT_TIMEFRAME } from './chart-history-requirements.js';

/** Fingerprint one OHLCV row for source-change detection. */
function candleFingerprint(row) {
  if (!row) return '';
  return [row.t || '', row.o || '', row.h || '', row.l || '', row.c || '', row.v || ''].join(',');
}

function normalizeTime(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric >= 100_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function monthWindowsFromProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).map((profile) => {
    const startHint = Number(profile.monthStart || profile.startTime || 0);
    return {
      startTime: Number(profile.startTime) || startHint,
      endTime: Number(profile.endTime) || 0,
      barCount: Number(profile.barCount) || 0,
      monthStart: Number(profile.monthStart) || utcMonthStartUnix(startHint),
      monthEnd: Number(profile.monthEnd) || utcMonthEndUnix(startHint),
    };
  }).filter((window) => window.monthStart > 0 && window.monthEnd > window.monthStart);
}

/** Map a unix time onto the LC time scale, including bars past the last candle. */
export function logicalIndexForUnix(timeScale, time, lastBarTime, barSeconds) {
  const t = Number(time);
  if (!timeScale || !(t > 0) || typeof timeScale.timeToIndex !== 'function') return null;
  const last = Number(lastBarTime);
  const iv = Number(barSeconds);
  if (last > 0 && t > last && iv > 0) {
    const lastIdx = timeScale.timeToIndex(last, true);
    if (lastIdx == null || !Number.isFinite(Number(lastIdx))) return null;
    return Number(lastIdx) + (t - last) / iv;
  }
  const idx = timeScale.timeToIndex(t, true);
  return idx == null || !Number.isFinite(Number(idx)) ? null : Number(idx);
}

const OCCUPANCY_INTENSITY_POWER = 1.35;
const OCCUPANCY_FUTURE_ALPHA = Object.freeze({ min: 0.28, span: 0.52, wash: 0.05 });
const OCCUPANCY_ELAPSED_ALPHA = Object.freeze({ min: 0.06, span: 0.14, wash: 0.015 });

/** Density-to-alpha for occupancy cells. Elapsed month-to-date stays faint. */
export function occupancyCellAlpha(fraction, elapsed = false) {
  const intensity = Math.pow(Math.max(0, Number(fraction) || 0), OCCUPANCY_INTENSITY_POWER);
  const scale = elapsed ? OCCUPANCY_ELAPSED_ALPHA : OCCUPANCY_FUTURE_ALPHA;
  return scale.min + scale.span * intensity;
}

function inferBarSeconds(candles, result) {
  const horizonBars = Number(result?.horizonBars || 0);
  const start = Number(result?.monthStart || result?.anchorTime || 0);
  const end = Number(result?.lastProjectionTime || result?.monthEnd || 0);
  if (horizonBars > 0 && end > start) return (end - start) / horizonBars;
  const rows = Array.isArray(candles) ? candles : [];
  if (rows.length >= 2) {
    const last = normalizeTime(rows[rows.length - 1]?.t);
    const prev = normalizeTime(rows[rows.length - 2]?.t);
    if (last > prev) return last - prev;
  }
  return 0;
}

function sampleFingerprints(rows) {
  const n = Array.isArray(rows) ? rows.length : 0;
  const first = n > 0 ? rows[0] : null;
  const q1 = n > 3 ? rows[Math.floor(n / 4)] : null;
  const mid = n > 0 ? rows[Math.floor((n - 1) / 2)] : null;
  const q3 = n > 3 ? rows[Math.floor((3 * n) / 4)] : null;
  const last = n > 0 ? rows[n - 1] : null;
  return [
    n,
    candleFingerprint(first),
    candleFingerprint(q1),
    candleFingerprint(mid),
    candleFingerprint(q3),
    candleFingerprint(last),
  ];
}

/**
 * Recompute when closed history used for historical fans changes, or when
 * the live month-to-date tip moves (weights/occupancy refresh; origin stays
 * at month open). Prefix samples still gate frozen completed months.
 */
function sourceSignature(candles, coin, timeframe, revision, monthWindows) {
  const latestStart = monthWindows.at(-1)?.monthStart || 0;
  const latestEnd = monthWindows.at(-1)?.monthEnd || 0;
  const prefix = [];
  const live = [];
  for (const row of Array.isArray(candles) ? candles : []) {
    const time = normalizeTime(row?.t);
    if (latestStart > 0 && time >= latestStart && (latestEnd <= 0 || time < latestEnd)) {
      live.push(row);
    } else if (time < latestStart || latestStart <= 0) {
      prefix.push(row);
    }
  }
  const monthPart = monthWindows
    .map((window) => `${window.monthStart}:${window.monthEnd}`)
    .join(',');
  return [
    coin,
    timeframe,
    revision,
    monthPart,
    ...sampleFingerprints(prefix),
    ...sampleFingerprints(live),
  ].join(':');
}

function publicStatus(result, enabled) {
  const computedMonths = Number(result?.monthCount || 0);
  if (!enabled) {
    return {
      status: 'disabled',
      reason: '',
      monthCount: 0,
      drawnMonthCount: 0,
      horizon: 0,
      horizonDays: 0,
      horizonBars: 0,
      originMode: '',
      monthDays: 0,
    };
  }
  if (!result) {
    return {
      status: 'pending',
      reason: '',
      monthCount: 0,
      drawnMonthCount: 0,
      horizon: 0,
      horizonDays: 0,
      horizonBars: 0,
      originMode: '',
      monthDays: 0,
    };
  }
  if (result.status !== 'ready') {
    return {
      ...result,
      monthCount: computedMonths,
      drawnMonthCount: 0,
      horizon: Number(result.horizonDays || result.horizon || 0),
      horizonDays: Number(result.horizonDays || result.horizon || 0),
      horizonBars: Number(result.horizonBars || 0),
    };
  }
  return {
    status: result.status,
    reason: '',
    model: result.model ? { ...result.model } : null,
    evidenceStatus: result.evidenceStatus || 'unvalidated',
    timeframe: result.timeframe,
    monthCount: computedMonths,
    drawnMonthCount: computedMonths > 0 ? 1 : 0,
    monthStart: result.monthStart,
    monthEnd: result.monthEnd,
    monthDays: result.monthDays,
    originMode: result.originMode || '',
    horizon: result.horizonDays ?? result.horizon,
    horizonDays: result.horizonDays ?? result.horizon,
    horizonBars: result.horizonBars,
    anchorTime: result.anchorTime,
    lastProjectionTime: result.lastProjectionTime,
    sourceCount: result.sourceCount,
    analogueUpFrequency: result.analogueUpFrequency,
    analogCount: result.analogCount,
    weightEffectiveSampleSize: result.weightEffectiveSampleSize,
    clusterEffectiveSampleSize: result.clusterEffectiveSampleSize,
    pathModel: result.pathModel || '',
    occupancySliceCount: Number(result.occupancy?.slices?.length || 0),
    remainingPointCount: Array.isArray(result.remainingPath) ? result.remainingPath.length : 0,
    calibration: { ...result.calibration },
  };
}

export function createPriceProjectionOverlay({ getChart, getCandleSeries, ensureVisible } = {}) {
  if (typeof getChart !== 'function') {
    throw new Error('createPriceProjectionOverlay requires getChart');
  }

  let enabled = false;
  let attachedChart = null;
  let lastSignature = '';
  let lastResult = null;
  let computeCount = 0;
  let statusListener = null;
  let lastPublishedStatus = '';
  let occupancyHost = null;
  let occupancyRequestUpdate = null;
  const occupancyState = {
    slices: [],
    monthStart: 0,
    lastBarTime: 0,
    barSeconds: 0,
    current: true,
  };

  function timeToLogical(ts, time) {
    return logicalIndexForUnix(
      ts,
      time,
      occupancyState.lastBarTime,
      occupancyState.barSeconds,
    );
  }

  function occupancyDraw(target) {
    if (!attachedChart || !occupancyHost || occupancyState.slices.length === 0) return;
    const rgb = colorRgbChannels(indicatorBaseColor());
    if (!rgb) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const ts = attachedChart.timeScale();
      const slices = occupancyState.slices;
      for (let index = 0; index < slices.length; index += 1) {
        const slice = slices[index];
        const prevTime = index === 0 ? occupancyState.monthStart : slices[index - 1].time;
        const i0 = timeToLogical(ts, prevTime);
        const i1 = timeToLogical(ts, slice.time);
        if (i0 == null || i1 == null) continue;
        const x0 = ts.logicalToCoordinate(i0);
        const x1 = ts.logicalToCoordinate(i1);
        if (x0 == null || x1 == null) continue;
        const width = Math.max(1, x1 - x0);
        const elapsed = occupancyState.lastBarTime > 0
          && Number(slice.time) <= occupancyState.lastBarTime;
        const wash = elapsed ? OCCUPANCY_ELAPSED_ALPHA.wash : OCCUPANCY_FUTURE_ALPHA.wash;
        const y50Top = occupancyHost.priceToCoordinate(slice.hdi50High);
        const y50Bot = occupancyHost.priceToCoordinate(slice.hdi50Low);
        if (y50Top != null && y50Bot != null) {
          ctx.fillStyle = `rgba(${rgb}, ${wash.toFixed(3)})`;
          ctx.fillRect(
            x0 * hpr,
            y50Top * vpr,
            width * hpr,
            Math.max(1, (y50Bot - y50Top) * vpr),
          );
        }
        for (const bin of slice.bins || []) {
          const yTop = occupancyHost.priceToCoordinate(bin.priceHigh);
          const yBot = occupancyHost.priceToCoordinate(bin.priceLow);
          if (yTop == null || yBot == null) continue;
          const fraction = Math.max(0, Number(bin.fraction) || 0);
          if (fraction < 0.04) continue;
          const alpha = occupancyCellAlpha(fraction, elapsed);
          ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
          ctx.fillRect(
            x0 * hpr,
            yTop * vpr,
            width * hpr,
            Math.max(1, (yBot - yTop) * vpr),
          );
        }
      }
    });
  }

  const occupancyPrimitive = {
    attached(params) {
      occupancyRequestUpdate = params?.requestUpdate || null;
    },
    detached() {
      occupancyRequestUpdate = null;
    },
    updateAllViews() {},
    paneViews: () => [{
      zOrder: () => 'bottom',
      renderer: () => ({ draw: occupancyDraw }),
    }],
  };

  function detachOccupancy() {
    if (occupancyHost && typeof occupancyHost.detachPrimitive === 'function') {
      try { occupancyHost.detachPrimitive(occupancyPrimitive); } catch {}
    }
    occupancyHost = null;
    occupancyRequestUpdate = null;
    occupancyState.slices = [];
    occupancyState.monthStart = 0;
    occupancyState.lastBarTime = 0;
    occupancyState.barSeconds = 0;
  }

  function syncOccupancy(months, geometry = {}) {
    const live = Array.isArray(months) && months.length ? months[months.length - 1] : null;
    const slices = live?.occupancy?.slices || [];
    const monthStart = Number(live?.monthStart) || Number(live?.anchorTime) || 0;
    const current = live?.originMode === 'month-open-live';
    occupancyState.lastBarTime = Number(geometry.lastBarTime) || occupancyState.lastBarTime;
    occupancyState.barSeconds = Number(geometry.barSeconds) || occupancyState.barSeconds;
    const host = typeof getCandleSeries === 'function' ? getCandleSeries() : null;
    if (!host || typeof host.attachPrimitive !== 'function') {
      detachOccupancy();
      return;
    }
    if (occupancyHost !== host) {
      if (occupancyHost && typeof occupancyHost.detachPrimitive === 'function') {
        try { occupancyHost.detachPrimitive(occupancyPrimitive); } catch {}
      }
      occupancyHost = null;
      occupancyRequestUpdate = null;
      try {
        host.attachPrimitive(occupancyPrimitive);
        occupancyHost = host;
      } catch {
        occupancyHost = null;
        occupancyState.slices = [];
        occupancyState.monthStart = 0;
        occupancyState.lastBarTime = 0;
        occupancyState.barSeconds = 0;
        return;
      }
    }
    occupancyState.slices = slices;
    occupancyState.monthStart = monthStart;
    occupancyState.current = current;
    if (typeof occupancyRequestUpdate === 'function') {
      try { occupancyRequestUpdate(); } catch {}
    }
  }

  function publishStatus() {
    const status = publicStatus(lastResult, enabled);
    const signature = JSON.stringify(status);
    if (signature === lastPublishedStatus) return;
    lastPublishedStatus = signature;
    try { statusListener?.(status); } catch {}
  }

  function removeSeries() {
    detachOccupancy();
    attachedChart = null;
  }

  function detach({ resetResult = true } = {}) {
    removeSeries();
    lastSignature = '';
    if (resetResult) lastResult = null;
    publishStatus();
  }

  function indicatorBaseColor() {
    return getPaletteColor('projection');
  }

  function attachIfNeeded() {
    const chart = getChart();
    if (!enabled || !chart) return false;
    if (attachedChart === chart) return true;
    removeSeries();
    attachedChart = chart;
    return true;
  }

  function applyTheme() {
    if (typeof occupancyRequestUpdate === 'function') {
      try { occupancyRequestUpdate(); } catch {}
    }
  }

  function clearData() {
    syncOccupancy([]);
  }

  function setOptions(options = {}) {
    const nextEnabled = options.visible === true;
    const enabledChanged = nextEnabled !== enabled;
    enabled = nextEnabled;
    if (!enabled) {
      detach();
      return;
    }
    if (enabledChanged) {
      lastSignature = '';
      lastResult = null;
      publishStatus();
    }
  }

  function setCandles(candles, coin = '', timeframe = DEFAULT_TIMEFRAME, revision = 0) {
    if (!enabled) return false;
    if (!attachIfNeeded()) return false;
    const profiles = computeMonthlyVolumeProfiles(candles);
    const monthWindows = monthWindowsFromProfiles(profiles);
    const signature = sourceSignature(candles, coin, timeframe, revision, monthWindows);
    if (signature === lastSignature) return true;
    lastSignature = signature;
    computeCount += 1;
    lastResult = computePriceProjection(candles, { timeframe, profileMonths: profiles });
    if (lastResult.status === 'ready') {
      try {
        syncOccupancy(lastResult.months || [], {
          lastBarTime: normalizeTime(candles?.at?.(-1)?.t),
          barSeconds: inferBarSeconds(candles, lastResult),
        });
      } catch (error) {
        console.warn('[price-projection] attach failed:', error);
        detachOccupancy();
        attachedChart = getChart();
        publishStatus();
        return false;
      }
      try {
        const live = lastResult.months?.at(-1);
        ensureVisible?.(
          live?.anchorTime || lastResult.anchorTime,
          lastResult.lastProjectionTime,
        );
      } catch {}
    } else {
      clearData();
    }
    publishStatus();
    return lastResult.status === 'ready';
  }

  function updateLast(candles, coin = '', timeframe = DEFAULT_TIMEFRAME, revision = 0) {
    return setCandles(candles, coin, timeframe, revision);
  }

  function setOnStatusChange(listener) {
    statusListener = typeof listener === 'function' ? listener : null;
    lastPublishedStatus = '';
    publishStatus();
  }

  function getDebugState() {
    return {
      enabled,
      attached: Boolean(attachedChart),
      seriesCount: 0,
      computeCount,
      occupancySliceCount: Number(lastResult?.occupancy?.slices?.length || 0),
      occupancyAttached: Boolean(occupancyHost),
      ...publicStatus(lastResult, enabled),
    };
  }

  return {
    setOptions,
    setCandles,
    updateLast,
    applyTheme,
    detach,
    setOnStatusChange,
    getStatus: () => publicStatus(lastResult, enabled),
    getDebugState,
  };
}
