/**
 * Empirical historical-analogue price projection from confirmed OHLCV candles.
 *
 * The model is deliberately local and non-parametric: describe the current
 * momentum/volatility/range/volume state, find comparable historical states,
 * and use their subsequently realised returns as the forecast distribution.
 * Rolling-origin multiplicative interval factors recalibrate pointwise bands
 * (shrink when raw fans over-cover, widen when they under-cover). Dependent,
 * overlapping market returns do not meet exchangeability, so no finite-sample
 * coverage guarantee is claimed. No synthetic row produced here is allowed
 * into canonical market state.
 */

const FEATURE_WINDOW = 32;
const ANALOG_COUNT = 60;
const VOLATILITY_ANALOG_COUNT = 120;
const MIN_EFFECTIVE_SAMPLE = 20;
const EMBARGO_BARS = 32;
const MAX_CALIBRATION_ORIGINS = 60;
// Floor when horizon-specific scaling is unavailable.
const MIN_CALIBRATION_ORIGINS_FLOOR = 16;
const MIN_PREQUENTIAL_SCORES_FLOOR = 10;
// Long month-span horizons use large outcome blocks; require only a modest
// independent-block ESS so 28–31d months are not rejected solely by recency tilt.
const MIN_CLUSTER_EFFECTIVE_SAMPLE = 5;
// Live overlay is one UTC calendar month (28–31 days). History stays day-based.
const MIN_MONTH_DAYS = 28;
const MAX_MONTH_DAYS = 31;
const DEFAULT_HORIZON_DAYS = MAX_MONTH_DAYS;
const DAY_SECONDS = 24 * 60 * 60;
// Same eligibility window as Monthly Volume Profile.
const PROFILE_KEEP_MONTHS = 6;
const PROFILE_MIN_BARS = 5;
// Lookback history is day-denominated, then converted to bars for the chart TF.
const MIN_SOURCE_DAYS = 90;
// Daily/weekly charts rarely hold 90 calendar bars of depth in the store.
const MIN_SOURCE_DAYS_COARSE = 60;
const MAX_SOURCE_DAYS = 1_000;
// Baseline sample uses the full retained day window; recency still down-weights
// older blocks. Half-life spans multiple multi-day outcome blocks.
const BASELINE_HISTORY_DAYS = 1_000;
const RECENCY_HALF_LIFE_DAYS = 250;
const QUANTILE_LEVELS = Object.freeze([0.10, 0.25, 0.50, 0.75, 0.90]);
const QUANTILE_KEYS = Object.freeze(['q10', 'q25', 'q50', 'q75', 'q90']);
// Absolute compute ceiling only; the primary history unit remains calendar days.
const MAX_SOURCE_BARS_HARD = 15_000;
// Cap path length so short timeframes cannot emit multi-thousand-bar paths.
// A 31-day UTC month on 1h is the densest accepted resolution.
const MAX_HORIZON_BARS = MAX_MONTH_DAYS * 24;
// HAR windows in bars (Corsi-style short/medium/long cascade).
const HAR_SHORT_BARS = 8;
const HAR_MED_BARS = 32;
const HAR_LONG_BARS = 96;
const HAR_WEIGHT_SHORT = 0.40;
const HAR_WEIGHT_MED = 0.35;
const HAR_WEIGHT_LONG = 0.25;
// Extra Corsi-style monthly RV weight, applied only on the live cone so the
// shared 8/32/96 helper (week-path, tests) stays unchanged.
const MONTH_HAR_WEIGHT = 0.20;
const MIN_MONTH_STATE_BARS = 8;
const VOLUME_WIDTH_FLOOR = 0.75;
const VOLUME_WIDTH_CEIL = 1.40;
const SIDE_TILT_MIN = 0.78;
const SIDE_TILT_MAX = 1.28;
// James-Stein / empirical-Bayes shrink of the state-conditional median toward 0.
// Need ~10 independent month-blocks before the tilt is trusted halfway.
const AUCTION_MEDIAN_SHRINK_K = 10;
// Variance half-life (bars) for multiperiod HAR mean reversion toward RV_long.
const HAR_VAR_HALF_LIFE_BARS = HAR_MED_BARS;
// Cap residual-score memory so early extreme regimes do not permanently inflate
// or deflate later interval factors (rolling prequential window).
const RESIDUAL_SCORE_WINDOW = 48;
const MODEL_IDS = Object.freeze({
  LEGACY_ANALOGUE: 'analogue-v1',
  VOLATILITY_ANALOGUE: 'analogue-volatility-v2',
  VOLATILITY_BASELINE: 'volatility-baseline-v1',
  MONTH_OPEN_MAP: 'month-open-map-v1',
});
// Live overlay is a month-from-open occupancy map. The retired 5/10/20-day
// freeze does not transfer; evidence stays unvalidated until a month-horizon
// freeze is intentionally locked.
const ACTIVE_MODEL_ID = MODEL_IDS.MONTH_OPEN_MAP;
const OCCUPANCY_BINS = 80;
const OCCUPANCY_SLICES = 60;
const MONTH_OPEN_MIN_POOL = 8;
const MONTH_OPEN_MIN_ESS = 8;
const MODEL_EVIDENCE = Object.freeze({
  status: 'unvalidated',
  validationReportId: '',
  purpose: 'research-only',
});
const VOL_MODEL_ID = 'har-month-conditioned-rv';
const FIXED_INTERVAL_SECONDS = Object.freeze({
  '1m': 60,
  '3m': 3 * 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '30m': 30 * 60,
  '1h': 60 * 60,
  '2h': 2 * 60 * 60,
  '4h': 4 * 60 * 60,
  '8h': 8 * 60 * 60,
  '12h': 12 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
});

/**
 * Convert a calendar-day span into bars for the active chart timeframe.
 * Used for both forward horizons and lookback history.
 */
export function barsForCalendarDays(days, timeframe) {
  const span = Number(days);
  if (!(span > 0)) return 0;
  if (timeframe === '1M') return Math.max(1, Math.round(span / 30));
  if (timeframe === '1w') return Math.max(1, Math.ceil(span / 7));
  const intervalSeconds = FIXED_INTERVAL_SECONDS[timeframe];
  if (!(intervalSeconds > 0)) return 0;
  return Math.max(1, Math.round((span * DAY_SECONDS) / intervalSeconds));
}

/**
 * Non-overlapping calibration origins required for a calendar-day horizon.
 * Longer horizons need fewer origins so typical 2h/4h history remains usable.
 */
export function minCalibrationOriginsForHorizon(horizonDays) {
  const days = Number(horizonDays);
  // Month-length (~28–31d) needs fewer blocks so ~2k-bar 2h charts still fit.
  if (days >= MIN_MONTH_DAYS) return 4;
  if (days >= 20) return 12;
  if (days >= 10) return 16;
  return 20;
}

export function minPrequentialScoresForHorizon(horizonDays) {
  const days = Number(horizonDays);
  if (days >= MIN_MONTH_DAYS) return 2;
  return Math.max(
    MIN_PREQUENTIAL_SCORES_FLOOR,
    Math.floor(minCalibrationOriginsForHorizon(horizonDays) / 2),
  );
}

/**
 * Day-denominated source history limits, expressed as bars for one timeframe.
 * Optional horizonDays tightens structural minimums for multi-day calibration.
 */
export function sourceHistoryLimits(timeframe, horizonDays = DEFAULT_HORIZON_DAYS) {
  const coarse = timeframe === '1d' || timeframe === '1w' || timeframe === '1M';
  const minSourceDays = coarse ? MIN_SOURCE_DAYS_COARSE : MIN_SOURCE_DAYS;
  const maxBars = Math.min(
    MAX_SOURCE_BARS_HARD,
    barsForCalendarDays(MAX_SOURCE_DAYS, timeframe),
  );
  const resolved = resolveHorizonBars(horizonDays, timeframe);
  const horizonBars = resolved.ok ? resolved.horizonBars : 0;
  const minOrigins = minCalibrationOriginsForHorizon(horizonDays);
  // FEATURE + embargo + (minOrigins+1) separated blocks of horizonBars.
  const structuralMin = horizonBars > 0
    ? FEATURE_WINDOW + EMBARGO_BARS + horizonBars * (minOrigins + 1) + 16
    : FEATURE_WINDOW + EMBARGO_BARS + 80;
  const minBars = Math.min(
    maxBars,
    Math.max(
      FEATURE_WINDOW + EMBARGO_BARS + 80,
      barsForCalendarDays(minSourceDays, timeframe),
      // Cap structural min so coarse TFs with thin stores are not impossible.
      Math.min(structuralMin, Math.floor(maxBars * 0.95)),
    ),
  );
  return {
    minSourceDays,
    maxSourceDays: MAX_SOURCE_DAYS,
    minBars,
    maxBars,
    minCalibrationOrigins: minOrigins,
    minPrequentialScores: minPrequentialScoresForHorizon(horizonDays),
    baselineHistoryBars: Math.min(maxBars, barsForCalendarDays(BASELINE_HISTORY_DAYS, timeframe)),
    recencyHalfLifeBars: Math.max(1, barsForCalendarDays(RECENCY_HALF_LIFE_DAYS, timeframe)),
  };
}

export function utcMonthStartUnix(timeSec) {
  const numeric = Number(timeSec);
  if (!(numeric > 0)) return 0;
  const date = new Date(numeric * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

export function utcMonthEndUnix(timeSec) {
  const numeric = Number(timeSec);
  if (!(numeric > 0)) return 0;
  const date = new Date(numeric * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000);
}

export function utcMonthKey(timeSec) {
  const numeric = Number(timeSec);
  if (!(numeric > 0)) return 0;
  const date = new Date(numeric * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

export function lastIndexBefore(rows, timeSec) {
  const cutoff = Number(timeSec);
  if (!Array.isArray(rows) || !(cutoff > 0)) return -1;
  let index = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].time < cutoff) index = i;
    else break;
  }
  return index;
}

/**
 * Months that Monthly Volume Profile would render: last `keepMonths` UTC
 * months with at least `minBars` bars, a non-degenerate range, and volume.
 */
export function listEligibleMonthWindows(rows, options = {}) {
  const keepMonths = Number(options.keepMonths) > 0
    ? Math.floor(Number(options.keepMonths))
    : PROFILE_KEEP_MONTHS;
  const minBars = Number(options.minBars) > 0
    ? Math.floor(Number(options.minBars))
    : PROFILE_MIN_BARS;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const groups = [];
  let currentKey = null;
  for (const row of rows) {
    const time = Number(row.time || 0);
    if (!(time > 0)) continue;
    const key = utcMonthKey(time);
    if (key !== currentKey) {
      currentKey = key;
      groups.push([]);
    }
    groups[groups.length - 1].push(row);
  }

  const windows = [];
  const kept = groups.slice(-keepMonths);
  for (let monthIndex = 0; monthIndex < kept.length; monthIndex += 1) {
    const bars = kept[monthIndex];
    if (bars.length < minBars) continue;
    let lo = Infinity;
    let hi = -Infinity;
    let volume = 0;
    for (const bar of bars) {
      const high = Number(bar.high ?? bar.h);
      const low = Number(bar.low ?? bar.l);
      const vol = Number(bar.volume ?? bar.v);
      if (Number.isFinite(low)) lo = Math.min(lo, low);
      if (Number.isFinite(high)) hi = Math.max(hi, high);
      if (Number.isFinite(vol) && vol > 0) volume += vol;
    }
    if (!(hi > lo) || !(volume > 0)) continue;
    const startTime = Number(bars[0].time);
    const monthStart = utcMonthStartUnix(startTime);
    const isLatest = monthIndex === kept.length - 1;
    if (!isLatest && startTime > monthStart + DAY_SECONDS) continue;
    windows.push({
      monthKey: utcMonthKey(startTime),
      monthStart,
      monthEnd: utcMonthEndUnix(startTime),
      startTime,
      endTime: Number(bars[bars.length - 1].time),
      barCount: bars.length,
    });
  }
  return windows;
}

/**
 * Exact bar count for one UTC calendar month on the active chart timeframe.
 */
export function resolveMonthHorizonBars(monthStart, monthEnd, timeframe) {
  const start = Number(monthStart);
  const end = Number(monthEnd);
  const days = (end - start) / DAY_SECONDS;
  if (!(start > 0) || !(end > start) || days < MIN_MONTH_DAYS || days > MAX_MONTH_DAYS) {
    return {
      ok: false,
      reason: 'invalid-horizon',
      horizonDays: days,
      horizonBars: 0,
      monthStart: start,
      monthEnd: end,
    };
  }
  return resolveHorizonBars(days, timeframe, { monthStart: start, monthEnd: end });
}

/**
 * Exact remaining bars from a closed origin to the next UTC month open.
 * Uses (monthEnd − origin) / interval so mid-month spans stay integer
 * even when remaining days are not a whole number.
 */
export function resolveRemainingMonthHorizon(originTime, monthEnd, timeframe) {
  const origin = Number(originTime);
  const end = Number(monthEnd);
  const days = (end - origin) / DAY_SECONDS;
  const extra = { originTime: origin, monthEnd: end };
  if (!(origin > 0) || !(end > origin) || !Number.isFinite(days) || !(days > 0)) {
    return {
      ok: false,
      reason: 'invalid-horizon',
      horizonDays: days,
      horizonBars: 0,
      ...extra,
    };
  }
  if (timeframe === '1M' || timeframe === '1w') {
    return resolveHorizonBars(days, timeframe, extra);
  }
  const intervalSeconds = FIXED_INTERVAL_SECONDS[timeframe];
  if (!(intervalSeconds > 0)) {
    return {
      ok: false,
      reason: 'invalid-timeframe',
      horizonDays: days,
      horizonBars: 0,
      ...extra,
    };
  }
  // Mid-month remaining days are often not an integer; bar count still is
  // when candles sit on the timeframe grid. Off-grid origins (tests, repaired
  // tails) round to the nearest bar so the live month is not dropped.
  const exactBars = (end - origin) / intervalSeconds;
  const bars = Math.max(1, Math.round(exactBars));
  if (!(bars > 0) || !Number.isFinite(bars)) {
    return {
      ok: false,
      reason: 'horizon-not-aligned-to-timeframe',
      horizonDays: days,
      horizonBars: 0,
      ...extra,
    };
  }
  if (bars > MAX_HORIZON_BARS) {
    return {
      ok: false,
      reason: 'horizon-too-long-for-timeframe',
      horizonDays: days,
      horizonBars: bars,
      maxHorizonBars: MAX_HORIZON_BARS,
      ...extra,
    };
  }
  return {
    ok: true,
    reason: '',
    horizonDays: days,
    horizonBars: bars,
    aligned: Math.abs(exactBars - bars) <= 1e-9,
    ...extra,
  };
}

/**
 * Convert a calendar-day span into an exact bar count for the active chart
 * timeframe. Non-integer or sub-bar mappings are rejected rather than rounded.
 */
export function resolveHorizonBars(horizonDays, timeframe, extra = {}) {
  const days = Number(horizonDays);
  if (!(days > 0) || !Number.isFinite(days)) {
    return {
      ok: false,
      reason: 'invalid-horizon',
      horizonDays: days,
      horizonBars: 0,
      ...extra,
    };
  }
  if (timeframe === '1M') {
    return {
      ok: false,
      reason: 'horizon-too-short-for-timeframe',
      horizonDays: days,
      horizonBars: 0,
      detail: 'monthly bars are longer than a UTC calendar month',
      ...extra,
    };
  }
  if (timeframe === '1w') {
    const bars = days / 7;
    if (!Number.isInteger(bars) || bars < 1) {
      return {
        ok: false,
        reason: 'horizon-not-aligned-to-timeframe',
        horizonDays: days,
        horizonBars: 0,
        ...extra,
      };
    }
    return { ok: true, reason: '', horizonDays: days, horizonBars: bars, ...extra };
  }
  const intervalSeconds = FIXED_INTERVAL_SECONDS[timeframe];
  if (!(intervalSeconds > 0)) {
    return {
      ok: false,
      reason: 'invalid-timeframe',
      horizonDays: days,
      horizonBars: 0,
      ...extra,
    };
  }
  const exactBars = (days * DAY_SECONDS) / intervalSeconds;
  if (!Number.isInteger(exactBars) || exactBars < 1) {
    return {
      ok: false,
      reason: 'horizon-not-aligned-to-timeframe',
      horizonDays: days,
      horizonBars: 0,
      ...extra,
    };
  }
  if (exactBars > MAX_HORIZON_BARS) {
    return {
      ok: false,
      reason: 'horizon-too-long-for-timeframe',
      horizonDays: days,
      horizonBars: exactBars,
      maxHorizonBars: MAX_HORIZON_BARS,
      ...extra,
    };
  }
  return { ok: true, reason: '', horizonDays: days, horizonBars: exactBars, ...extra };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeTime(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric >= 100_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function unavailable(reason, detail = {}) {
  return {
    status: 'unavailable',
    reason,
    horizon: Number(detail.horizon || 0),
    sourceCount: Number(detail.sourceCount || 0),
    ...detail,
  };
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return { rows: [], reason: 'invalid-source' };
  const rows = [];
  let previousTime = 0;
  for (const candle of candles) {
    const time = normalizeTime(candle?.t);
    const open = Number(candle?.o);
    const high = Number(candle?.h);
    const low = Number(candle?.l);
    const close = Number(candle?.c);
    const volume = Number(candle?.v);
    if (!(time > previousTime)
      || ![open, high, low, close, volume].every(Number.isFinite)
      || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
      || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      return { rows: [], reason: 'invalid-source' };
    }
    rows.push({ time, open, high, low, close, volume });
    previousTime = time;
  }
  return { rows, reason: '' };
}

function expectedStepSeconds(timeframe, sampleInterval) {
  if (timeframe === '1M') return null;
  return FIXED_INTERVAL_SECONDS[timeframe] || sampleInterval || 0;
}

function stepIsRegular(previous, next, timeframe, expectedInterval) {
  if (timeframe === '1M') {
    const prev = new Date(previous.time * 1000);
    const expected = Math.floor(Date.UTC(
      prev.getUTCFullYear(),
      prev.getUTCMonth() + 1,
      1,
    ) / 1000);
    return next.time === expected;
  }
  return expectedInterval > 0 && next.time - previous.time === expectedInterval;
}

function hasRegularCadence(rows, timeframe) {
  if (rows.length < 2) return true;
  const expectedInterval = expectedStepSeconds(
    timeframe,
    rows[1].time - rows[0].time,
  );
  for (let index = 1; index < rows.length; index += 1) {
    if (!stepIsRegular(rows[index - 1], rows[index], timeframe, expectedInterval)) {
      return false;
    }
  }
  return true;
}

/**
 * Keep the trailing contiguous regular-cadence segment ending at the latest
 * closed bar. Older gaps no longer discard the entire series.
 */
export function trailingCleanSegment(rows, timeframe) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rows: [], startIndex: 0, droppedPrefix: 0, gapped: false };
  }
  if (rows.length === 1) {
    return { rows, startIndex: 0, droppedPrefix: 0, gapped: false };
  }
  const expectedInterval = expectedStepSeconds(
    timeframe,
    rows[rows.length - 1].time - rows[rows.length - 2].time,
  );
  let start = 0;
  for (let index = rows.length - 1; index >= 1; index -= 1) {
    if (!stepIsRegular(rows[index - 1], rows[index], timeframe, expectedInterval)) {
      start = index;
      break;
    }
  }
  return {
    rows: start === 0 ? rows : rows.slice(start),
    startIndex: start,
    droppedPrefix: start,
    gapped: start > 0,
  };
}

/** Mean of squared one-bar log returns over the last `window` bars at `end`. */
function realizedVariance(returns, end, window) {
  if (!(window > 0) || end < 1) return NaN;
  const from = Math.max(1, end - window + 1);
  let sum = 0;
  let count = 0;
  for (let i = from; i <= end; i += 1) {
    const value = returns[i];
    if (!Number.isFinite(value)) continue;
    sum += value * value;
    count += 1;
  }
  return count > 0 ? sum / count : NaN;
}

/**
 * Blend short/medium/long realized variance into a one-step HAR variance.
 * Returns { harVar1, rvLong } for multiperiod mean reversion.
 */
export function harOneStepVariance(returns, endIndex) {
  const rvShort = realizedVariance(returns, endIndex, Math.min(HAR_SHORT_BARS, endIndex));
  const rvMed = realizedVariance(returns, endIndex, Math.min(HAR_MED_BARS, endIndex));
  const rvLong = realizedVariance(returns, endIndex, Math.min(HAR_LONG_BARS, endIndex));
  const parts = [];
  if (Number.isFinite(rvShort)) parts.push([HAR_WEIGHT_SHORT, rvShort]);
  if (Number.isFinite(rvMed)) parts.push([HAR_WEIGHT_MED, rvMed]);
  if (Number.isFinite(rvLong)) parts.push([HAR_WEIGHT_LONG, rvLong]);
  if (parts.length === 0) {
    return { harVar1: 1e-16, rvLong: 1e-16 };
  }
  const weightSum = parts.reduce((sum, [weight]) => sum + weight, 0);
  const harVar1 = Math.max(
    parts.reduce((sum, [weight, value]) => sum + weight * value, 0) / weightSum,
    1e-16,
  );
  const longRun = Number.isFinite(rvLong) && rvLong > 0
    ? Math.max(rvLong, 1e-16)
    : harVar1;
  return { harVar1, rvLong: longRun };
}

/**
 * Multiperiod HAR scale: one-step HAR variance mean-reverts toward RV_long
 * with half-life HAR_VAR_HALF_LIFE_BARS; scale is sqrt of cumulative variance
 * over `step` bars. When harVar1 ≈ rvLong this recovers σ√step; high-vol
 * spikes tighten long-horizon scales relative to pure local constancy.
 *
 * Prefer precomputed { harVar1, rvLong } from featureState for O(1) paths.
 */
export function harHorizonScale(returns, endIndex, step, precomputed = null) {
  const safeStep = Math.max(1, Math.floor(Number(step) || 1));
  let harVar1;
  let rvLong;
  if (precomputed && typeof precomputed === 'object' && Number.isFinite(precomputed.harVar1)) {
    harVar1 = Math.max(precomputed.harVar1, 1e-16);
    rvLong = Math.max(
      Number.isFinite(precomputed.rvLong) ? precomputed.rvLong : harVar1,
      1e-16,
    );
  } else if (Number.isFinite(precomputed) && precomputed > 0) {
    // Backward-compatible: bare one-step variance → local-constancy √(σ²·h).
    harVar1 = precomputed;
    rvLong = precomputed;
  } else {
    const computed = harOneStepVariance(returns, endIndex);
    harVar1 = computed.harVar1;
    rvLong = computed.rvLong;
  }
  if (safeStep === 1) return Math.sqrt(harVar1);

  // ρ such that variance gap halves every HAR_VAR_HALF_LIFE_BARS steps.
  const rho = Math.exp(-Math.log(2) / Math.max(1, HAR_VAR_HALF_LIFE_BARS));
  // Closed form: sum_{k=0}^{h-1} (LR + (v0-LR) ρ^k)
  //            = h·LR + (v0-LR)·(1-ρ^h)/(1-ρ)
  const gap = harVar1 - rvLong;
  let cum;
  if (Math.abs(1 - rho) < 1e-12) {
    cum = harVar1 * safeStep;
  } else {
    cum = safeStep * rvLong + gap * (1 - Math.pow(rho, safeStep)) / (1 - rho);
  }
  return Math.sqrt(Math.max(cum, 1e-16));
}

/**
 * Calendar-month realized state at `endIndex` using only bars in that UTC
 * month through the origin (no look-ahead). Used to condition cone width.
 */
export function calendarMonthState(rows, endIndex) {
  const end = Math.floor(Number(endIndex));
  if (!Array.isArray(rows) || end < 1 || end >= rows.length) return null;
  const monthStart = utcMonthStartUnix(rows[end].time);
  if (!(monthStart > 0)) return null;
  let rvSum = 0;
  let rsUp = 0;
  let rsDown = 0;
  let retCount = 0;
  let volume = 0;
  let volCount = 0;
  let barCount = 0;
  for (let index = 0; index <= end; index += 1) {
    if (rows[index].time < monthStart) continue;
    barCount += 1;
    const vol = Number(rows[index].volume);
    if (Number.isFinite(vol) && vol >= 0) {
      volume += vol;
      volCount += 1;
    }
    if (index < 1) continue;
    const ret = Math.log(rows[index].close / rows[index - 1].close);
    if (!Number.isFinite(ret)) continue;
    const squared = ret * ret;
    rvSum += squared;
    if (ret >= 0) rsUp += squared;
    else rsDown += squared;
    retCount += 1;
  }
  if (barCount < MIN_MONTH_STATE_BARS || retCount < 4) return null;
  const rv = rvSum / retCount;
  if (!(rv > 0)) return null;
  return {
    monthStart,
    barCount,
    rv: Math.max(rv, 1e-16),
    rsUp: rsUp / retCount,
    rsDown: rsDown / retCount,
    meanVolume: volCount > 0 ? volume / volCount : 0,
    volume,
  };
}

export function blendHarWithMonthRv(har, monthRv) {
  const harVar1 = Math.max(Number(har?.harVar1) || 1e-16, 1e-16);
  const rvLong = Math.max(Number(har?.rvLong) || harVar1, 1e-16);
  if (!(Number(monthRv) > 0) || !Number.isFinite(Number(monthRv))) {
    return { harVar1, rvLong };
  }
  const weight = MONTH_HAR_WEIGHT;
  const monthly = Math.max(Number(monthRv), 1e-16);
  return {
    harVar1: Math.max((1 - weight) * harVar1 + weight * monthly, 1e-16),
    rvLong: Math.max((1 - weight) * rvLong + weight * monthly, 1e-16),
  };
}

function trailingMeanVolume(rows, endIndex, beforeTime, lookbackBars) {
  const end = Math.floor(Number(endIndex));
  const lookback = Math.max(20, Math.floor(Number(lookbackBars) || 0));
  const cutoff = Number(beforeTime);
  if (!Array.isArray(rows) || end < 1 || !(cutoff > 0)) return 0;
  const from = Math.max(0, end - lookback);
  let sum = 0;
  let count = 0;
  for (let index = from; index <= end; index += 1) {
    if (rows[index].time >= cutoff) continue;
    const vol = Number(rows[index].volume);
    if (!Number.isFinite(vol) || vol < 0) continue;
    sum += vol;
    count += 1;
  }
  return count >= 20 ? sum / count : 0;
}

function emptyMonthConditioning() {
  return {
    leftMult: 1,
    rightMult: 1,
    volumeMult: 1,
    monthRv: NaN,
    state: null,
  };
}

function hasMonthConditioningState(cond) {
  return Boolean(cond?.state)
    && Number.isFinite(Number(cond.monthRv))
    && Number(cond.monthRv) > 0;
}

/**
 * Mix a completed previous-month prior with live month-to-date state.
 * MTD weight is at most half the elapsed fraction so the finished auction
 * never drops below 50% — HAR at the live tip already carries recent vol.
 */
export function blendMonthConditioning(prior, mtd, elapsed) {
  const alpha = clamp(0.5 * (Number(elapsed) || 0), 0, 0.5);
  if (!hasMonthConditioningState(mtd)) {
    return {
      ...(hasMonthConditioningState(prior) ? prior : emptyMonthConditioning()),
      source: hasMonthConditioningState(prior) ? 'previous-month' : 'none',
      elapsed: 0,
      mtdWeight: 0,
    };
  }
  if (!hasMonthConditioningState(prior)) {
    return {
      ...mtd,
      source: 'mtd',
      elapsed: clamp(Number(elapsed) || 0, 0, 1),
      mtdWeight: 1,
    };
  }
  const mix = (left, right) => Math.exp(
    (1 - alpha) * Math.log(Math.max(Number(left) || 1, 1e-12))
    + alpha * Math.log(Math.max(Number(right) || 1, 1e-12)),
  );
  return {
    leftMult: clamp(mix(prior.leftMult, mtd.leftMult), SIDE_TILT_MIN, SIDE_TILT_MAX),
    rightMult: clamp(mix(prior.rightMult, mtd.rightMult), SIDE_TILT_MIN, SIDE_TILT_MAX),
    volumeMult: clamp(
      mix(prior.volumeMult, mtd.volumeMult),
      VOLUME_WIDTH_FLOOR,
      VOLUME_WIDTH_CEIL,
    ),
    monthRv: (1 - alpha) * prior.monthRv + alpha * mtd.monthRv,
    state: mtd.state,
    priorState: prior.state,
    source: 'previous-month+mtd',
    elapsed: clamp(Number(elapsed) || 0, 0, 1),
    mtdWeight: alpha,
  };
}

/**
 * Previous-month (or month-to-date) width state at an origin.
 * Month-open origins use the completed prior. When `elapsedOriginIndex` is a
 * closed bar inside the forecast month, blend MTD state without moving origin.
 */
export function originMonthConditioning(rows, originIndex, lookbackBars = 0, options = {}) {
  const monthStart = Number(options.monthStart) || 0;
  const monthEnd = Number(options.monthEnd) || 0;
  if (options.adaptiveMonth !== true || !(monthStart > 0)) {
    return monthConditioning(rows, originIndex, lookbackBars);
  }
  const tipIndex = Number.isInteger(options.elapsedOriginIndex)
    ? options.elapsedOriginIndex
    : originIndex;
  const tipTime = Number(rows[tipIndex]?.time) || 0;
  const priorIndex = lastIndexBefore(rows, monthStart);
  const prior = priorIndex >= 0
    ? monthConditioning(rows, priorIndex, lookbackBars)
    : emptyMonthConditioning();
  const inLiveMonth = tipTime >= monthStart
    && (monthEnd <= 0 || tipTime < monthEnd);
  if (!inLiveMonth) {
    return {
      ...prior,
      source: hasMonthConditioningState(prior) ? 'previous-month' : 'none',
      elapsed: 0,
      mtdWeight: 0,
    };
  }
  const mtd = monthConditioning(rows, tipIndex, lookbackBars);
  const elapsed = monthEnd > monthStart
    ? clamp((tipTime - monthStart) / (monthEnd - monthStart), 0, 1)
    : 0;
  return blendMonthConditioning(prior, mtd, elapsed);
}

export function monthConditioning(rows, endIndex, lookbackBars = 0) {
  const state = calendarMonthState(rows, endIndex);
  if (!state) {
    return emptyMonthConditioning();
  }
  let leftMult = Math.sqrt((state.rsDown + 0.5 * state.rv) / state.rv);
  let rightMult = Math.sqrt((state.rsUp + 0.5 * state.rv) / state.rv);
  leftMult = clamp(leftMult, SIDE_TILT_MIN, SIDE_TILT_MAX);
  rightMult = clamp(rightMult, SIDE_TILT_MIN, SIDE_TILT_MAX);
  const baselineVolume = trailingMeanVolume(
    rows,
    endIndex,
    state.monthStart,
    lookbackBars,
  );
  let volumeMult = 1;
  if (baselineVolume > 0 && state.meanVolume > 0) {
    volumeMult = clamp(
      Math.sqrt(state.meanVolume / baselineVolume),
      VOLUME_WIDTH_FLOOR,
      VOLUME_WIDTH_CEIL,
    );
  }
  return {
    leftMult,
    rightMult,
    volumeMult,
    monthRv: state.rv,
    state,
  };
}

/**
 * One O(n) pass: previous-UTC-month (or month-to-date) auction state at each
 * bar using only data through that bar. Profile location is close vs VWAP
 * inside the month range — the same information the monthly profile shows,
 * without leaking later bars in the month.
 */
export function buildMonthAuctionStates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const states = new Array(rows.length).fill(null);
  let monthKey = null;
  let monthStart = 0;
  let hi = -Infinity;
  let lo = Infinity;
  let volSum = 0;
  let typicalVolume = 0;
  let rvSum = 0;
  let rsUp = 0;
  let rsDown = 0;
  let retCount = 0;
  let barCount = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const key = utcMonthKey(rows[index].time);
    if (key !== monthKey) {
      monthKey = key;
      monthStart = utcMonthStartUnix(rows[index].time);
      hi = -Infinity;
      lo = Infinity;
      volSum = 0;
      typicalVolume = 0;
      rvSum = 0;
      rsUp = 0;
      rsDown = 0;
      retCount = 0;
      barCount = 0;
    }
    barCount += 1;
    const high = Number(rows[index].high);
    const low = Number(rows[index].low);
    if (Number.isFinite(high)) hi = Math.max(hi, high);
    if (Number.isFinite(low)) lo = Math.min(lo, low);
    const vol = Number(rows[index].volume);
    if (Number.isFinite(vol) && vol >= 0) {
      volSum += vol;
      typicalVolume += ((high + low + Number(rows[index].close)) / 3) * vol;
    }
    if (index >= 1) {
      const ret = Math.log(rows[index].close / rows[index - 1].close);
      if (Number.isFinite(ret)) {
        const squared = ret * ret;
        rvSum += squared;
        if (ret >= 0) rsUp += squared;
        else rsDown += squared;
        retCount += 1;
      }
    }
    if (barCount >= MIN_MONTH_STATE_BARS && retCount >= 4 && volSum > 0 && hi > lo) {
      const rv = Math.max(rvSum / retCount, 1e-16);
      const vwap = typicalVolume / volSum;
      states[index] = {
        monthStart,
        rv,
        rsUp: rsUp / retCount,
        rsDown: rsDown / retCount,
        meanVolume: volSum / barCount,
        loc: clamp((Number(rows[index].close) - vwap) / (hi - lo), -3, 3),
        logRange: Math.log(Math.max((hi - lo) / Number(rows[index].close), 1e-8)),
        barCount,
      };
    }
  }
  return states;
}

export function auctionFeatureVector(state) {
  if (!state || !(state.rv > 0)) return null;
  return [
    Math.log(state.rv),
    Math.log(Math.max(state.meanVolume, 1e-12)),
    clamp((state.rsDown - state.rsUp) / state.rv, -1, 1),
    state.loc,
    state.logRange,
  ];
}

/**
 * Last closed bar of each UTC month in [min, max] — the month-open origin
 * for the following calendar month.
 */
export function collectMonthOpenIndexes(rows, minCandidate, maxCandidate) {
  const lo = Math.max(0, Math.floor(Number(minCandidate) || 0));
  const hi = Math.floor(Number(maxCandidate) || 0);
  if (!Array.isArray(rows) || hi < lo) return [];
  const found = [];
  for (let index = lo; index <= hi; index += 1) {
    const next = index + 1;
    if (next >= rows.length) continue;
    if (utcMonthKey(rows[next].time) !== utcMonthKey(rows[index].time)) {
      found.push(index);
    }
  }
  return found;
}

function elapsedIndexForCandidate(rows, candidateIndex, elapsed) {
  const originTime = Number(rows[candidateIndex]?.time) || 0;
  if (!(originTime > 0)) return -1;
  const nextMonthStart = utcMonthEndUnix(originTime);
  const nextMonthEnd = utcMonthEndUnix(nextMonthStart);
  if (!(nextMonthEnd > nextMonthStart)) return -1;
  const frac = clamp(Number(elapsed) || 0, 0, 1);
  const target = nextMonthStart + frac * (nextMonthEnd - nextMonthStart);
  const index = lastIndexBefore(rows, Math.min(target + 1e-9, nextMonthEnd));
  return index > candidateIndex ? index : -1;
}

function tryAuctionReweight(selected, rows, originIndex, horizon, auctionStates) {
  const originVec = auctionFeatureVector(auctionStates[originIndex]);
  if (!originVec) return false;
  const auctionIndexes = [];
  const auctionFeatures = [];
  for (const candidate of selected) {
    const vector = auctionFeatureVector(auctionStates[candidate.index]);
    if (!vector) continue;
    auctionIndexes.push(candidate.index);
    auctionFeatures.push(vector);
  }
  if (auctionIndexes.length < MIN_EFFECTIVE_SAMPLE) return false;
  const featureByIndex = new Map();
  auctionIndexes.forEach((index, offset) => {
    featureByIndex.set(index, auctionFeatures[offset]);
  });
  const scales = robustFeatureScales(
    auctionFeatures,
    auctionFeatures.map((_, offset) => offset),
  );
  let trialWeight = 0;
  let trialSq = 0;
  const trial = [];
  for (const candidate of selected) {
    const vector = featureByIndex.get(candidate.index);
    const sim = vector
      ? Math.exp(-0.5 * featureSquaredDistance(originVec, vector, scales))
      : 0.25;
    const weight = candidate.recency * sim;
    trial.push(weight);
    trialWeight += weight;
    trialSq += weight * weight;
  }
  const trialEss = trialSq > 0 ? (trialWeight * trialWeight) / trialSq : 0;
  const trialCluster = clusteredEffectiveSampleSize(
    selected.map((candidate, offset) => ({ ...candidate, weight: trial[offset] })),
    horizon,
    trialWeight,
  );
  if (trialEss < Math.max(MIN_EFFECTIVE_SAMPLE, 40)
    || trialCluster < MIN_CLUSTER_EFFECTIVE_SAMPLE) {
    return false;
  }
  selected.forEach((candidate, offset) => {
    candidate.weight = trial[offset];
  });
  return { sumWeight: trialWeight, sumWeightSquared: trialSq };
}

function featureKernelSimilarities(originVec, selected, vectorsByIndex, scales) {
  return selected.map((candidate) => {
    const vector = vectorsByIndex.get(candidate.index);
    if (!originVec || !vector) return 1;
    return Math.exp(-0.5 * featureSquaredDistance(originVec, vector, scales));
  });
}

function monthAuctionKernel(selected, originIndex, auctionStates) {
  const originVec = auctionFeatureVector(auctionStates[originIndex]);
  if (!originVec) return null;
  const vectors = [];
  const indexes = [];
  for (const candidate of selected) {
    const vector = auctionFeatureVector(auctionStates[candidate.index]);
    if (!vector) continue;
    indexes.push(candidate.index);
    vectors.push(vector);
  }
  if (indexes.length < MONTH_OPEN_MIN_POOL) return null;
  const byIndex = new Map(indexes.map((index, offset) => [index, vectors[offset]]));
  const scales = robustFeatureScales(vectors, vectors.map((_, offset) => offset));
  return featureKernelSimilarities(originVec, selected, byIndex, scales);
}

function monthElapsedKernel(
  selected,
  rows,
  auctionStates,
  tipIndex,
  monthStart,
  monthEnd,
) {
  if (!(tipIndex >= 0) || !(monthEnd > monthStart)) return null;
  const tipTime = Number(rows[tipIndex]?.time) || 0;
  const elapsed = (tipTime - monthStart) / (monthEnd - monthStart);
  if (!(elapsed > 0.04) || !(elapsed < 0.96)) return null;
  const tipVec = auctionFeatureVector(auctionStates[tipIndex]);
  if (!tipVec) return null;
  const vectors = [];
  const indexes = [];
  for (const candidate of selected) {
    const elapsedIndex = elapsedIndexForCandidate(rows, candidate.index, elapsed);
    const vector = elapsedIndex >= 0
      ? auctionFeatureVector(auctionStates[elapsedIndex])
      : null;
    if (!vector) continue;
    indexes.push(candidate.index);
    vectors.push(vector);
  }
  if (indexes.length < MONTH_OPEN_MIN_POOL) return null;
  const byIndex = new Map(indexes.map((index, offset) => [index, vectors[offset]]));
  const scales = robustFeatureScales(vectors, vectors.map((_, offset) => offset));
  return {
    elapsed,
    similarities: featureKernelSimilarities(tipVec, selected, byIndex, scales),
  };
}

function applyProductKernels(selected, multipliers) {
  let sumWeight = 0;
  let sumWeightSquared = 0;
  selected.forEach((candidate, offset) => {
    const factor = Number(multipliers[offset]);
    if (Number.isFinite(factor) && factor > 0) candidate.weight *= factor;
    sumWeight += candidate.weight;
    sumWeightSquared += candidate.weight * candidate.weight;
  });
  return { sumWeight, sumWeightSquared };
}

function monthPathItem(rows, returns, harAt, candidateIndex, horizon, weight) {
  const originClose = Number(rows[candidateIndex]?.close);
  if (!(originClose > 0) || !(weight > 0)) return null;
  const path = [];
  const highPath = [];
  const lowPath = [];
  let runHigh = -Infinity;
  let runLow = Infinity;
  for (let step = 1; step <= horizon; step += 1) {
    const at = candidateIndex + step;
    const row = rows[at];
    if (!row) return null;
    const realized = Math.log(row.close / originClose);
    if (!Number.isFinite(realized)) return null;
    const scale = Math.max(
      harHorizonScale(returns, candidateIndex, step, harAt(candidateIndex)),
      1e-10,
    );
    const highRet = Math.log(row.high / originClose);
    const lowRet = Math.log(row.low / originClose);
    const highValue = Number.isFinite(highRet) ? highRet : realized;
    const lowValue = Number.isFinite(lowRet) ? lowRet : realized;
    runHigh = Math.max(runHigh, highValue);
    runLow = Math.min(runLow, lowValue);
    path.push(realized / scale);
    highPath.push(runHigh / scale);
    lowPath.push(runLow / scale);
  }
  if (path.length !== horizon) return null;
  return {
    weight,
    path,
    highPath,
    lowPath,
    terminal: path[path.length - 1],
  };
}

function normalizePositiveWeights(items) {
  const total = (Array.isArray(items) ? items : [])
    .reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
  if (!(total > 0)) return [];
  return items.map((item) => ({ ...item, weight: item.weight / total }));
}

function occupancySamplesAtStep(items, stepIndex, scale) {
  const samples = [];
  for (const item of Array.isArray(items) ? items : []) {
    const z = Number(item.path?.[stepIndex]);
    if (!Number.isFinite(z) || !(item.weight > 0)) continue;
    samples.push({ weight: item.weight, ret: z * scale });
  }
  return samples;
}

/** α·analogue + (1-α)·climatology after each measure is normalized. */
function mixOccupancySamples(analogue, climate, analogueMix) {
  const alpha = clamp(Number(analogueMix), 0, 1);
  const left = normalizePositiveWeights(analogue);
  const right = normalizePositiveWeights(climate);
  if (alpha >= 1 || right.length === 0) return left;
  if (alpha <= 0) return right;
  const mixed = [];
  for (const sample of left) mixed.push({ ret: sample.ret, weight: alpha * sample.weight });
  for (const sample of right) mixed.push({ ret: sample.ret, weight: (1 - alpha) * sample.weight });
  return mixed.filter((sample) => sample.weight > 0);
}

function highestDensitySpan(masses, total, target) {
  const need = Math.max(0, Number(target) || 0) * Math.max(0, Number(total) || 0);
  if (!(need > 0) || !Array.isArray(masses) || masses.length === 0) return null;
  let bestLo = 0;
  let bestHi = masses.length - 1;
  let bestWidth = masses.length;
  let left = 0;
  let sum = 0;
  for (let right = 0; right < masses.length; right += 1) {
    sum += masses[right];
    while (left < right && sum - masses[left] >= need) {
      sum -= masses[left];
      left += 1;
    }
    if (sum >= need && (right - left) < bestWidth) {
      bestWidth = right - left;
      bestLo = left;
      bestHi = right;
    }
  }
  return { lo: bestLo, hi: bestHi };
}

function buildReturnOccupancy(candidateItems, liveScaleAt, horizon, options = {}) {
  const usable = (Array.isArray(candidateItems) ? candidateItems : [])
    .filter((item) => item && item.weight > 0 && Array.isArray(item.path));
  const climate = (Array.isArray(options.climateItems) ? options.climateItems : [])
    .filter((item) => item && item.weight > 0 && Array.isArray(item.path));
  const analogueMix = Number.isFinite(Number(options.analogueMix))
    ? clamp(Number(options.analogueMix), 0, 1)
    : 1;
  if ((usable.length === 0 && climate.length === 0) || !(horizon > 0)) return null;
  const sliceStep = Math.max(1, Math.round(horizon / OCCUPANCY_SLICES));
  const steps = [];
  for (let step = sliceStep; step < horizon; step += sliceStep) steps.push(step);
  if (steps[steps.length - 1] !== horizon) steps.push(horizon);
  const slices = [];
  for (const step of steps) {
    const stepIndex = step - 1;
    const scale = liveScaleAt(step);
    const samples = mixOccupancySamples(
      occupancySamplesAtStep(usable, stepIndex, scale),
      occupancySamplesAtStep(climate, stepIndex, scale),
      analogueMix,
    );
    if (samples.length === 0) continue;
    const edges = weightedQuantiles(samples.map((sample) => ({
      value: sample.ret,
      weight: sample.weight,
    })), [0.10, 0.90]);
    if (!edges.every(Number.isFinite)) continue;
    const pad = edges[1] > edges[0]
      ? 0.12 * (edges[1] - edges[0])
      : Math.max(Math.abs(edges[0]) * 1e-4, 1e-8);
    const lo = edges[0] - pad;
    const hi = edges[1] + pad;
    const span = hi - lo;
    const masses = new Array(OCCUPANCY_BINS).fill(0);
    let total = 0;
    for (const sample of samples) {
      if (sample.ret < lo || sample.ret > hi) continue;
      const bin = clamp(
        Math.floor(((sample.ret - lo) / span) * OCCUPANCY_BINS),
        0,
        OCCUPANCY_BINS - 1,
      );
      masses[bin] += sample.weight;
      total += sample.weight;
    }
    if (!(total > 0)) continue;
    const maxMass = masses.reduce((peak, value) => Math.max(peak, value), 0);
    const modeBin = masses.indexOf(maxMass);
    const hdi50 = highestDensitySpan(masses, total, 0.50);
    const hdi80 = highestDensitySpan(masses, total, 0.80);
    const bins = [];
    const keepLo = hdi80?.lo ?? 0;
    const keepHi = hdi80?.hi ?? (OCCUPANCY_BINS - 1);
    for (let bin = keepLo; bin <= keepHi; bin += 1) {
      if (!(masses[bin] > 0)) continue;
      bins.push({
        retLow: lo + (bin / OCCUPANCY_BINS) * span,
        retHigh: lo + ((bin + 1) / OCCUPANCY_BINS) * span,
        mass: masses[bin] / total,
        fraction: maxMass > 0 ? masses[bin] / maxMass : 0,
      });
    }
    slices.push({
      step,
      lo: lo + (keepLo / OCCUPANCY_BINS) * span,
      hi: lo + ((keepHi + 1) / OCCUPANCY_BINS) * span,
      mode: lo + ((modeBin + 0.5) / OCCUPANCY_BINS) * span,
      hdi50Low: hdi50 ? lo + (hdi50.lo / OCCUPANCY_BINS) * span : lo,
      hdi50High: hdi50 ? lo + ((hdi50.hi + 1) / OCCUPANCY_BINS) * span : hi,
      bins,
    });
  }
  return slices.length ? { binCount: OCCUPANCY_BINS, slices } : null;
}

function occupancyToPrices(occupancy, originClose, times) {
  if (!occupancy?.slices?.length || !(originClose > 0)) return null;
  return {
    binCount: occupancy.binCount || OCCUPANCY_BINS,
    slices: occupancy.slices.map((slice) => {
      const time = Array.isArray(times) ? times[slice.step] : 0;
      return {
        time,
        step: slice.step,
        lo: originClose * Math.exp(slice.lo),
        hi: originClose * Math.exp(slice.hi),
        mode: originClose * Math.exp(slice.mode),
        hdi50Low: originClose * Math.exp(slice.hdi50Low),
        hdi50High: originClose * Math.exp(slice.hdi50High),
        bins: (slice.bins || []).map((bin) => ({
          priceLow: originClose * Math.exp(bin.retLow),
          priceHigh: originClose * Math.exp(bin.retHigh),
          mass: bin.mass,
          fraction: bin.fraction,
        })),
      };
    }).filter((slice) => Number(slice.time) > 0),
  };
}

function meanAndDeviation(values, from, to) {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let i = from; i <= to; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    sumSquares += value * value;
    count += 1;
  }
  if (count === 0) return { mean: 0, deviation: 0, count: 0 };
  const mean = sum / count;
  return {
    mean,
    deviation: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)),
    count,
  };
}

function buildFeatureState(rows) {
  const count = rows.length;
  const logCloses = rows.map((row) => Math.log(row.close));
  const returns = new Array(count).fill(NaN);
  const logVolumes = rows.map((row) => Math.log1p(row.volume));
  const volumes = rows.map((row) => row.volume);
  for (let i = 1; i < count; i += 1) returns[i] = logCloses[i] - logCloses[i - 1];

  const features = new Array(count).fill(null);
  const volatilities = new Array(count).fill(NaN);
  for (let i = FEATURE_WINDOW; i < count; i += 1) {
    const vol32Stats = meanAndDeviation(returns, i - FEATURE_WINDOW + 1, i);
    const vol8Stats = meanAndDeviation(returns, i - 7, i);
    const volumeStats = meanAndDeviation(logVolumes, i - FEATURE_WINDOW + 1, i);
    const rawVolumeStats = meanAndDeviation(volumes, i - FEATURE_WINDOW + 1, i);
    if (vol32Stats.count < FEATURE_WINDOW || vol8Stats.count < 8) continue;

    const row = rows[i];
    const previousClose = rows[i - 1].close;
    const volatility = Math.max(vol32Stats.deviation, 1e-8);
    volatilities[i] = volatility;
    const range = row.high - row.low;
    const trueRange = Math.max(
      range,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose),
    );
    const momentum = (lag) => (logCloses[i] - logCloses[i - lag])
      / (volatility * Math.sqrt(lag));
    const direction = Math.sign(row.close - row.open);
    const relativeVolume = rawVolumeStats.mean > 0 ? row.volume / rawVolumeStats.mean : 1;
    const vector = [
      momentum(1),
      momentum(3),
      momentum(8),
      momentum(24),
      vol8Stats.deviation / volatility,
      trueRange / row.close / volatility,
      range > 0 ? (2 * row.close - row.high - row.low) / range : 0,
      range > 0 ? (row.close - row.open) / range : 0,
      volumeStats.deviation > 1e-10
        ? (logVolumes[i] - volumeStats.mean) / volumeStats.deviation
        : 0,
      direction * relativeVolume,
    ].map((value) => clamp(Number.isFinite(value) ? value : 0, -6, 6));
    features[i] = vector;
  }
  // Precompute multiperiod HAR inputs so multi-step scales are O(1) lookups.
  const harVar1 = new Array(count).fill(NaN);
  const harRvLong = new Array(count).fill(NaN);
  for (let i = FEATURE_WINDOW; i < count; i += 1) {
    const computed = harOneStepVariance(returns, i);
    harVar1[i] = computed.harVar1;
    harRvLong[i] = computed.rvLong;
  }
  return { features, volatilities, returns, harVar1, harRvLong };
}

function buildVolatilityFeatureRows(featureState) {
  return featureState.features.map((vector, index) => {
    if (!vector) return null;
    const volatility = featureState.volatilities[index];
    return [...vector, Math.log(Math.max(volatility, 1e-12))];
  });
}

function featureSquaredDistance(left, right, scales = null) {
  let squared = 0;
  for (let i = 0; i < left.length; i += 1) {
    const scale = scales ? Math.max(Number(scales[i]) || 0, 1e-6) : 1;
    const difference = (left[i] - right[i]) / scale;
    squared += difference * difference;
  }
  return squared / left.length;
}

function robustFeatureScales(features, indexes) {
  const dimension = features[indexes[0]]?.length || 0;
  const scales = [];
  for (let featureIndex = 0; featureIndex < dimension; featureIndex += 1) {
    const values = indexes
      .map((index) => features[index]?.[featureIndex])
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    if (values.length === 0) {
      scales.push(1);
      continue;
    }
    const lower = values[Math.floor((values.length - 1) * 0.25)];
    const upper = values[Math.floor((values.length - 1) * 0.75)];
    // IQR / 1.349 estimates standard deviation for a Gaussian while retaining
    // robustness to the fat tails common in market features.
    scales.push(Math.max((upper - lower) / 1.349, 1e-6));
  }
  return scales;
}

function compareCandidates(left, right) {
  return left.distanceSquared - right.distanceSquared || right.index - left.index;
}

// Keep the exact best K candidates in a max-heap. This is equivalent to
// sorting the full library and slicing K, but avoids O(n log n) work at every
// rolling calibration origin.
function pushNearestCandidate(heap, candidate, limit) {
  const isWorse = (left, right) => compareCandidates(left, right) > 0;
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!isWorse(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
    return;
  }
  if (compareCandidates(candidate, heap[0]) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && isWorse(heap[left], heap[worst])) worst = left;
    if (right < heap.length && isWorse(heap[right], heap[worst])) worst = right;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

function weightedQuantiles(points, quantiles) {
  const sorted = points
    .filter((point) => Number.isFinite(point.value) && point.weight > 0)
    .sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((sum, point) => sum + point.weight, 0);
  if (!(totalWeight > 0) || sorted.length === 0) return quantiles.map(() => NaN);
  const targets = quantiles.map((quantile) => clamp(quantile, 0, 1) * totalWeight);
  const output = new Array(targets.length);
  let cumulative = 0;
  let targetIndex = 0;
  for (const point of sorted) {
    cumulative += point.weight;
    while (targetIndex < targets.length && cumulative >= targets[targetIndex]) {
      output[targetIndex] = point.value;
      targetIndex += 1;
    }
    if (targetIndex >= targets.length) break;
  }
  while (targetIndex < targets.length) {
    output[targetIndex] = sorted[sorted.length - 1].value;
    targetIndex += 1;
  }
  return output;
}

/**
 * Pathwise quantiles: rank whole historical trajectories by terminal return
 * (or terminal Z), then carry each selected path through every step. This is
 * coherent by construction (no independent step-wise quantile crossing).
 */
export function coherentPathQuantiles(candidatePaths, levels = QUANTILE_LEVELS) {
  const sorted = candidatePaths
    .filter((item) => Number.isFinite(item.terminal) && item.weight > 0 && Array.isArray(item.path))
    .sort((left, right) => left.terminal - right.terminal
      || left.path[0] - right.path[0]
      || left.path.length - right.path.length);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (!(totalWeight > 0) || sorted.length === 0) return null;
  return levels.map((level) => {
    const target = clamp(level, 0, 1) * totalWeight;
    let cumulative = 0;
    for (const item of sorted) {
      cumulative += item.weight;
      if (cumulative >= target) return item.path;
    }
    return sorted[sorted.length - 1].path;
  });
}

/**
 * Per-step weighted quantiles of every analogue trajectory. A single
 * terminal-rank path is often on the wrong side of the median for the first
 * 1–2 weeks of a month-span; pinning q50 = 0 then clamps that path to a flat
 * origin line. Stepwise FHS uses the actual α-quantile at each horizon.
 */
export function stepwiseWeightedQuantiles(candidatePaths, levels = QUANTILE_LEVELS) {
  const usable = (Array.isArray(candidatePaths) ? candidatePaths : [])
    .filter((item) => item && item.weight > 0 && Array.isArray(item.path) && item.path.length > 0);
  if (usable.length === 0) return null;
  const horizon = usable[0].path.length;
  for (const item of usable) {
    if (item.path.length !== horizon) return null;
  }
  const picked = levels.map(() => new Array(horizon));
  for (let step = 0; step < horizon; step += 1) {
    const points = [];
    for (const item of usable) {
      const value = Number(item.path[step]);
      if (!Number.isFinite(value)) continue;
      points.push({ value, weight: item.weight });
    }
    const quantiles = weightedQuantiles(points, levels);
    for (let index = 0; index < levels.length; index += 1) {
      if (!Number.isFinite(quantiles[index])) return null;
      picked[index][step] = quantiles[index];
    }
  }
  return picked;
}

/**
 * ACI-lite on multiplicative interval factors: inflate when recent coverage is
 * short of target, mildly deflate when recent coverage overshoots. Live path
 * rendering only; promotion diagnostics use pre-ACI factors.
 */
export function adaptiveCoverageWiden(corrections, coverage, target, samples) {
  if (!Array.isArray(corrections)) return corrections;
  if (!(samples >= 10) || !Number.isFinite(coverage) || !Number.isFinite(target)) {
    return corrections;
  }
  const gap = target - coverage;
  // Symmetric mild adjustment; caps runaway moves under small samples.
  let factor = 1;
  if (gap > 0) {
    factor = 1 + Math.min(0.45, gap * 2.2);
  } else if (gap < 0) {
    factor = 1 - Math.min(0.25, (-gap) * 1.2);
  }
  if (Math.abs(factor - 1) < 1e-12) return corrections;
  return corrections.map((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    // Factors must stay positive so ordered bands do not collapse inverted.
    return Math.max(0, numeric * factor);
  });
}

/** Linear-interpolated empirical quantile (less discrete than order-stat ceil). */
function empiricalQuantile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const q = clamp(Number(quantile) || 0, 0, 1);
  const position = q * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

/** Additive CQR residual (outside distance). Retained for tests / legacy comparison. */
function nonconformity(value, lower, upper) {
  return Math.max(lower - value, value - upper, 0);
}

/**
 * Multiplicative interval scale factor relative to the median.
 * λ = 0 at the median, λ = 1 at the raw band edge, λ > 1 outside.
 * Prequential quantiles of λ can shrink (over-cover) or widen (under-cover).
 * No artificial [0.4, 2] hard cap — structural guards are terminal broadcast +
 * per-side nesting; this only needs numerical stability on degenerate widths.
 */
const DEGENERATE_HALF_WIDTH = 1e-8;

export function intervalScaleFactor(value, lower, upper, median) {
  const mid = Number.isFinite(median) ? median : 0.5 * (Number(lower) + Number(upper));
  const leftRaw = mid - Math.min(Number(lower), mid);
  const rightRaw = Math.max(Number(upper), mid) - mid;
  const y = Number(value);
  if (!Number.isFinite(y) || !Number.isFinite(mid)) return 0;
  // Degenerate / crossed half-width: treat as non-informative (λ = 0) so a
  // near-zero raw band cannot manufacture an infinite scale factor.
  if (y <= mid) {
    if (!(leftRaw > DEGENERATE_HALF_WIDTH)) return 0;
    return Math.max(0, (mid - y) / leftRaw);
  }
  if (!(rightRaw > DEGENERATE_HALF_WIDTH)) return 0;
  return Math.max(0, (y - mid) / rightRaw);
}

/**
 * Sanitize a multiplicative half-width factor for path application.
 * Only rejects non-finite / non-positive values — no hard min/max cap.
 */
export function clampAppliedScaleFactor(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    const fb = Number(fallback);
    return Number.isFinite(fb) && fb > 0 ? fb : 1;
  }
  return numeric;
}

function pushRollingScore(scores, value, window = RESIDUAL_SCORE_WINDOW) {
  scores.push(value);
  const maxLen = Math.max(8, Number(window) || RESIDUAL_SCORE_WINDOW);
  if (scores.length > maxLen) scores.splice(0, scores.length - maxLen);
}

/**
 * Scale half-widths so the path peak never exceeds the terminal half, while
 * keeping the terminal half fixed and preserving relative intermediate shape.
 * Hard absolute clamps (every overshoot → same constant) created flat plateaus.
 */
function scaleHalvesToTerminal(halves, termIndex) {
  const clean = halves.map((value) => Math.max(0, Number(value) || 0));
  const terminalHalf = clean[termIndex] || 0;
  let peak = 0;
  for (const value of clean) if (value > peak) peak = value;
  if (!(peak > 0)) return clean;
  if (!(terminalHalf > 0)) {
    // Terminal is degenerate on this side: collapse all steps on this side.
    return clean.map(() => 0);
  }
  if (peak <= terminalHalf + 1e-15) return clean;
  const scale = terminalHalf / peak;
  const scaled = clean.map((value) => value * scale);
  // Keep the horizon outcome fixed; only intermediate overshoots were the issue.
  scaled[termIndex] = terminalHalf;
  return scaled;
}

/**
 * Coherent terminal-rank paths can flare mid-horizon (different paths per
 * quantile). Proportionally shrink each side of the 50%/80% bands so no step is
 * more extreme on that side than the terminal, while preserving path shape.
 */
export function nestPathWidthsToTerminal(quantiles, horizon, pinMedian = null) {
  const h = Math.max(1, Number(horizon) || 1);
  const term = h - 1;
  const out = {
    q10: [...quantiles.q10],
    q25: [...quantiles.q25],
    q50: [...quantiles.q50],
    q75: [...quantiles.q75],
    q90: [...quantiles.q90],
  };
  const mids = [];
  const left80 = [];
  const right80 = [];
  const left50 = [];
  const right50 = [];
  for (let index = 0; index < h; index += 1) {
    const median = pinMedian !== null && Number.isFinite(pinMedian)
      ? pinMedian
      : Number(out.q50[index]);
    mids.push(median);
    left80.push(Math.max(0, median - Number(out.q10[index])));
    right80.push(Math.max(0, Number(out.q90[index]) - median));
    left50.push(Math.max(0, median - Number(out.q25[index])));
    right50.push(Math.max(0, Number(out.q75[index]) - median));
  }
  const scaledLeft80 = scaleHalvesToTerminal(left80, term);
  const scaledRight80 = scaleHalvesToTerminal(right80, term);
  let scaledLeft50 = scaleHalvesToTerminal(left50, term);
  let scaledRight50 = scaleHalvesToTerminal(right50, term);
  // Keep 50% inside 80% so enforceOrdered cannot re-expand an outer side.
  scaledLeft50 = scaledLeft50.map((value, index) => Math.min(value, scaledLeft80[index]));
  scaledRight50 = scaledRight50.map((value, index) => Math.min(value, scaledRight80[index]));
  for (let index = 0; index < h; index += 1) {
    const median = mids[index];
    out.q10[index] = median - scaledLeft80[index];
    out.q90[index] = median + scaledRight80[index];
    out.q25[index] = median - scaledLeft50[index];
    out.q75[index] = median + scaledRight50[index];
    out.q50[index] = median;
  }
  return enforceOrderedQuantiles(out, h, { pinMedian });
}

export function applyMultiplicativeFactors(rawQuantiles, factors50, factors80, horizon, pinMedian = null) {
  const h = Math.max(1, Number(horizon) || 1);
  // Prefer a single terminal-derived factor for the whole path so intermediate
  // steps keep FHS shape instead of independent λ explosions.
  const terminal50 = clampAppliedScaleFactor(
    factors50?.[h - 1] ?? factors50?.[0] ?? 1,
    1,
  );
  const terminal80 = clampAppliedScaleFactor(
    factors80?.[h - 1] ?? factors80?.[0] ?? 1,
    1,
  );
  const q10 = [];
  const q25 = [];
  const q50 = [];
  const q75 = [];
  const q90 = [];
  for (let index = 0; index < h; index += 1) {
    const median = pinMedian !== null && Number.isFinite(pinMedian)
      ? pinMedian
      : Number(rawQuantiles.q50[index]);
    // Uniform terminal factor: preserves FHS path shape (no early-step λ blow-ups).
    const f50 = terminal50;
    const f80 = terminal80;
    const raw10 = Number(rawQuantiles.q10[index]);
    const raw25 = Number(rawQuantiles.q25[index]);
    const raw75 = Number(rawQuantiles.q75[index]);
    const raw90 = Number(rawQuantiles.q90[index]);
    q50.push(median);
    q25.push(median - f50 * Math.max(median - raw25, 0));
    q75.push(median + f50 * Math.max(raw75 - median, 0));
    q10.push(median - f80 * Math.max(median - raw10, 0));
    q90.push(median + f80 * Math.max(raw90 - median, 0));
  }
  const ordered = enforceOrderedQuantiles({ q10, q25, q50, q75, q90 }, h, { pinMedian });
  return nestPathWidthsToTerminal(ordered, h, pinMedian);
}

function clusteredEffectiveSampleSize(selected, horizon, sumWeight) {
  // Fixed horizon-sized blocks prevent overlapping outcomes from masquerading
  // as independent observations without transitively merging an entire dense
  // history into one cluster.
  const clusterWeights = new Map();
  for (const candidate of selected) {
    const cluster = Math.floor(candidate.index / Math.max(1, horizon));
    clusterWeights.set(cluster, (clusterWeights.get(cluster) || 0) + candidate.weight);
  }
  const sumSquares = [...clusterWeights.values()]
    .reduce((sum, weight) => sum + weight * weight, 0);
  return sumSquares > 0 ? (sumWeight * sumWeight) / sumSquares : 0;
}

function rawForecast(
  rows,
  featureState,
  originIndex,
  horizon,
  modelId = ACTIVE_MODEL_ID,
  historyLimits = null,
  forecastOptions = null,
) {
  const limits = historyLimits || {
    maxBars: MAX_SOURCE_BARS_HARD,
    baselineHistoryBars: barsForCalendarDays(BASELINE_HISTORY_DAYS, '2h'),
    recencyHalfLifeBars: barsForCalendarDays(RECENCY_HALF_LIFE_DAYS, '2h'),
  };
  const legacy = modelId === MODEL_IDS.LEGACY_ANALOGUE;
  const baseline = modelId === MODEL_IDS.VOLATILITY_BASELINE;
  const monthMap = modelId === MODEL_IDS.MONTH_OPEN_MAP;
  const features = legacy ? featureState.features : buildVolatilityFeatureRows(featureState);
  const originFeature = features[originIndex];
  if (!originFeature) return null;
  const maxCandidate = originIndex - EMBARGO_BARS - horizon;
  if (maxCandidate < FEATURE_WINDOW) return null;
  // Use the full retained window so candle history is not left on the floor.
  const candidateHistoryBars = limits.maxBars;
  const minCandidate = Math.max(FEATURE_WINDOW, maxCandidate - candidateHistoryBars + 1);
  const eligibleIndexes = [];
  for (let index = minCandidate; index <= maxCandidate; index += 1) {
    if (features[index] && index + horizon < rows.length) eligibleIndexes.push(index);
  }
  if (eligibleIndexes.length === 0) return null;

  let pool = eligibleIndexes;
  let monthOpenPool = false;
  if (monthMap && forecastOptions?.matchCurrentState !== true) {
    const monthOpens = collectMonthOpenIndexes(rows, minCandidate, maxCandidate)
      .filter((index) => features[index] && index + horizon < rows.length);
    if (monthOpens.length >= MONTH_OPEN_MIN_POOL) {
      pool = monthOpens;
      monthOpenPool = true;
    }
  }

  const selected = [];
  const analogueCount = monthMap
    ? Math.min(VOLATILITY_ANALOG_COUNT, pool.length)
    : (legacy ? ANALOG_COUNT : VOLATILITY_ANALOG_COUNT);
  if (analogueCount < (monthMap ? MONTH_OPEN_MIN_POOL : 1)) return null;
  const featureScales = legacy || baseline ? null : robustFeatureScales(features, pool);
  if (baseline) {
    for (const index of eligibleIndexes) selected.push({ index, distanceSquared: 0, distance: 0 });
  } else if (monthMap && monthOpenPool && pool.length <= VOLATILITY_ANALOG_COUNT) {
    for (const index of pool) {
      selected.push({
        index,
        distanceSquared: featureSquaredDistance(originFeature, features[index], featureScales),
      });
    }
  } else {
    for (const index of pool) {
      pushNearestCandidate(selected, {
        index,
        distanceSquared: featureSquaredDistance(originFeature, features[index], featureScales),
      }, analogueCount);
    }
  }
  if (selected.length < analogueCount) return null;
  selected.sort(compareCandidates);
  for (const candidate of selected) candidate.distance = Math.sqrt(candidate.distanceSquared);
  const sortedDistances = selected.map((candidate) => candidate.distance).sort((a, b) => a - b);
  const medianDistance = sortedDistances[Math.floor(sortedDistances.length / 2)];
  const similarityScale = Math.max(medianDistance, 1e-6);
  let sumWeight = 0;
  let sumWeightSquared = 0;
  const recencyHalfLifeBars = Math.max(1, limits.recencyHalfLifeBars);
  for (const candidate of selected) {
    const similarity = baseline
      ? 1
      : Math.exp(-0.5 * Math.pow(candidate.distance / similarityScale, 2));
    const recency = Math.pow(0.5, (originIndex - candidate.index) / recencyHalfLifeBars);
    candidate.recency = recency;
    candidate.weight = similarity * recency;
    sumWeight += candidate.weight;
    sumWeightSquared += candidate.weight * candidate.weight;
  }
  let auctionWeighted = false;
  let elapsedWeighted = false;
  let elapsedFraction = 0;
  const auctionStates = (baseline || monthMap) ? buildMonthAuctionStates(rows) : null;
  if (baseline && auctionStates) {
    const auction = tryAuctionReweight(
      selected,
      rows,
      originIndex,
      horizon,
      auctionStates,
    );
    if (auction) {
      sumWeight = auction.sumWeight;
      sumWeightSquared = auction.sumWeightSquared;
      auctionWeighted = true;
    }
  }
  if (monthMap && auctionStates) {
    const auctionSims = monthAuctionKernel(selected, originIndex, auctionStates);
    if (auctionSims) {
      const applied = applyProductKernels(
        selected,
        auctionSims.map((similarity) => 0.35 + 0.65 * similarity),
      );
      sumWeight = applied.sumWeight;
      sumWeightSquared = applied.sumWeightSquared;
      auctionWeighted = true;
    }
    const elapsed = monthElapsedKernel(
      selected,
      rows,
      auctionStates,
      Number.isInteger(forecastOptions?.elapsedOriginIndex)
        ? forecastOptions.elapsedOriginIndex
        : -1,
      Number(forecastOptions?.monthStart) || 0,
      Number(forecastOptions?.monthEnd) || 0,
    );
    if (elapsed) {
      const applied = applyProductKernels(
        selected,
        elapsed.similarities.map((similarity) => 0.35 + 0.65 * similarity),
      );
      sumWeight = applied.sumWeight;
      sumWeightSquared = applied.sumWeightSquared;
      elapsedWeighted = true;
      elapsedFraction = elapsed.elapsed;
    }
  }
  const effectiveSampleSize = sumWeightSquared > 0
    ? (sumWeight * sumWeight) / sumWeightSquared
    : 0;
  const clusterEffectiveSampleSize = clusteredEffectiveSampleSize(selected, horizon, sumWeight);
  const requiredEffectiveSample = legacy
    ? MIN_EFFECTIVE_SAMPLE
    : Math.max(MIN_EFFECTIVE_SAMPLE, 40);
  if (!monthMap && (effectiveSampleSize < requiredEffectiveSample
    || clusterEffectiveSampleSize < MIN_CLUSTER_EFFECTIVE_SAMPLE)) return null;
  if (monthMap && selected.length < MONTH_OPEN_MIN_POOL) return null;

  const returns = featureState.returns
    || rows.map((row, index) => (
      index === 0 ? NaN : Math.log(row.close / rows[index - 1].close)
    ));
  const harVar1 = featureState.harVar1 || null;
  const harRvLong = featureState.harRvLong || null;
  const harAt = (index) => (
    Number.isFinite(harVar1?.[index])
      ? { harVar1: harVar1[index], rvLong: harRvLong?.[index] }
      : null
  );
  const originCond = (baseline || monthMap)
    ? originMonthConditioning(
      rows,
      originIndex,
      limits.baselineHistoryBars || limits.maxBars,
      forecastOptions || {},
    )
    : { leftMult: 1, rightMult: 1, volumeMult: 1, monthRv: NaN, state: null };
  const originHar = (baseline || monthMap)
    ? blendHarWithMonthRv(harAt(originIndex), originCond.monthRv)
    : harAt(originIndex);
  const liveScaleAt = (step) => {
    if (legacy) return 1;
    return harHorizonScale(returns, originIndex, step, originHar);
  };

  let pickedPaths = null;
  let pathModel = 'coherent-terminal-rank';
  let positiveWeight = 0;
  let occupancy = null;
  let analogueLibrarySize = selected.length;

  if (monthMap) {
    const candidateItems = [];
    for (const candidate of selected) {
      const item = monthPathItem(
        rows,
        returns,
        harAt,
        candidate.index,
        horizon,
        candidate.weight,
      );
      if (!item) continue;
      candidateItems.push(item);
      if (item.terminal > 0) positiveWeight += item.weight;
    }
    const climateIndexes = monthOpenPool
      ? pool
      : selected.map((candidate) => candidate.index);
    const climateItems = [];
    for (const index of climateIndexes) {
      const recency = Math.pow(0.5, (originIndex - index) / recencyHalfLifeBars);
      const item = monthPathItem(rows, returns, harAt, index, horizon, recency);
      if (item) climateItems.push(item);
    }
    const analogueMix = clusterEffectiveSampleSize
      / (clusterEffectiveSampleSize + AUCTION_MEDIAN_SHRINK_K);
    pickedPaths = stepwiseWeightedQuantiles(
      candidateItems.length ? candidateItems : climateItems,
      QUANTILE_LEVELS,
    );
    if (pickedPaths) {
      const shrink = analogueMix;
      const medianPath = pickedPaths[2] || [];
      for (let step = 0; step < medianPath.length; step += 1) {
        medianPath[step] *= shrink;
      }
      originCond.medianZ = Number(medianPath[medianPath.length - 1]) || 0;
      originCond.medianShrink = shrink;
    }
    occupancy = buildReturnOccupancy(
      candidateItems.length ? candidateItems : climateItems,
      liveScaleAt,
      horizon,
      {
        climateItems: candidateItems.length ? climateItems : [],
        analogueMix: candidateItems.length ? analogueMix : 0,
      },
    );
    analogueLibrarySize = candidateItems.length || climateItems.length;
    pathModel = 'month-open-occupancy';
    originCond.auctionWeighted = auctionWeighted;
    originCond.elapsedWeighted = elapsedWeighted;
    originCond.elapsed = elapsedFraction;
    originCond.monthOpenPool = monthOpenPool;
    originCond.occupancyMix = candidateItems.length ? analogueMix : 0;
    originCond.occupancyClimateCount = climateItems.length;
  } else if (baseline) {
    // Production fan: recency-weighted quantiles of terminal Z, broadcast
    // through live HAR scale(h) mixed with previous-month / MTD RV. Volume
    // and signed RV tilt width only; the median stays zero.
    const terminals = [];
    for (const candidate of selected) {
      const realized = Math.log(
        rows[candidate.index + horizon].close / rows[candidate.index].close,
      );
      const scale = harHorizonScale(
        returns,
        candidate.index,
        horizon,
        harAt(candidate.index),
      );
      const terminal = realized / Math.max(scale, 1e-10);
      if (!Number.isFinite(terminal)) continue;
      terminals.push({ value: terminal, weight: candidate.weight });
      if (terminal > 0) positiveWeight += candidate.weight;
    }
    const zq = weightedQuantiles(terminals, QUANTILE_LEVELS);
    if (!zq.every(Number.isFinite)) return null;
    const shrink = clusterEffectiveSampleSize
      / (clusterEffectiveSampleSize + AUCTION_MEDIAN_SHRINK_K);
    const medianZ = (Number(zq[2]) || 0) * shrink;
    pickedPaths = QUANTILE_LEVELS.map((_, qi) => {
      const path = [];
      const level = qi === 2 ? medianZ : zq[qi];
      for (let step = 1; step <= horizon; step += 1) path.push(level);
      return path;
    });
    pathModel = 'month-auction-cone';
    originCond.medianZ = medianZ;
    originCond.medianShrink = shrink;
    originCond.auctionWeighted = auctionWeighted;
  } else {
    const candidatePaths = selected.map((candidate) => {
      const path = [];
      for (let step = 1; step <= horizon; step += 1) {
        const realized = Math.log(rows[candidate.index + step].close / rows[candidate.index].close);
        if (legacy) {
          path.push(realized);
        } else {
          const scale = harHorizonScale(
            returns,
            candidate.index,
            step,
            harAt(candidate.index),
          );
          path.push(realized / Math.max(scale, 1e-10));
        }
      }
      return {
        weight: candidate.weight,
        path,
        terminal: path[path.length - 1],
      };
    });
    pickedPaths = legacy
      ? coherentPathQuantiles(candidatePaths, QUANTILE_LEVELS)
      : stepwiseWeightedQuantiles(candidatePaths, QUANTILE_LEVELS);
    pathModel = legacy ? 'coherent-terminal-rank' : 'stepwise-weighted-quantile';
    positiveWeight = candidatePaths.reduce(
      (sum, item) => sum + (item.terminal > 0 ? item.weight : 0),
      0,
    );
  }
  if (!pickedPaths) return null;

  const rawQuantiles = { q10: [], q25: [], q50: [], q75: [], q90: [] };
  for (let step = 1; step <= horizon; step += 1) {
    const stepIndex = step - 1;
    const liveScale = liveScaleAt(step);
    for (let qi = 0; qi < QUANTILE_KEYS.length; qi += 1) {
      let value = Number(pickedPaths[qi][stepIndex]);
      if (!legacy) value *= liveScale;
      if ((baseline || monthMap) && qi !== 2) {
        const side = qi < 2 ? originCond.leftMult : originCond.rightMult;
        value *= side * originCond.volumeMult;
      }
      rawQuantiles[QUANTILE_KEYS[qi]].push(value);
    }
  }
  const quantiles = enforceOrderedQuantiles(
    rawQuantiles,
    horizon,
    { pinMedian: (baseline || monthMap) ? 'q50' : null },
  );
  return {
    quantiles,
    analogueUpFrequency: sumWeight > 0 ? positiveWeight / sumWeight : 0.5,
    analogCount: analogueLibrarySize,
    weightEffectiveSampleSize: effectiveSampleSize,
    clusterEffectiveSampleSize,
    pathModel,
    occupancy,
    conditioning: (baseline || monthMap)
      ? {
        leftMult: originCond.leftMult,
        rightMult: originCond.rightMult,
        volumeMult: originCond.volumeMult,
        monthRv: originCond.monthRv,
        medianZ: originCond.medianZ || 0,
        medianShrink: originCond.medianShrink || 0,
        auctionWeighted: originCond.auctionWeighted === true,
        elapsedWeighted: originCond.elapsedWeighted === true,
        monthOpenPool: originCond.monthOpenPool === true,
        source: originCond.source || '',
        elapsed: Number(originCond.elapsed) || 0,
        mtdWeight: Number(originCond.mtdWeight) || 0,
        occupancyMix: Number(originCond.occupancyMix),
        occupancyClimateCount: Number(originCond.occupancyClimateCount) || 0,
      }
      : null,
  };
}

function pinballLoss(actual, predicted, quantile) {
  const error = actual - predicted;
  return error >= 0 ? quantile * error : (quantile - 1) * error;
}

function meanQuantileLoss(actual, quantiles, terminal) {
  const keys = ['q10', 'q25', 'q50', 'q75', 'q90'];
  const levels = [0.10, 0.25, 0.50, 0.75, 0.90];
  return keys.reduce(
    (sum, key, index) => sum + pinballLoss(actual, quantiles[key][terminal], levels[index]),
    0,
  ) / keys.length;
}

function intervalScore(actual, lower, upper, alpha) {
  const width = upper - lower;
  if (actual < lower) return width + (2 / alpha) * (lower - actual);
  if (actual > upper) return width + (2 / alpha) * (actual - upper);
  return width;
}

function average(values) {
  const clean = (Array.isArray(values) ? values : []).filter(Number.isFinite);
  return clean.length > 0
    ? clean.reduce((sum, value) => sum + value, 0) / clean.length
    : null;
}

function blockBootstrapMeanInterval(values, seed = 1) {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;
  if (clean.length === 1) return [clean[0], clean[0]];
  const blockSize = Math.max(2, Math.floor(Math.sqrt(clean.length)));
  const estimates = [];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let repetition = 0; repetition < 300; repetition += 1) {
    const sample = [];
    while (sample.length < clean.length) {
      const start = Math.floor(random() * clean.length);
      for (let offset = 0; offset < blockSize && sample.length < clean.length; offset += 1) {
        sample.push(clean[(start + offset) % clean.length]);
      }
    }
    estimates.push(average(sample));
  }
  estimates.sort((left, right) => left - right);
  return [
    estimates[Math.floor(estimates.length * 0.025)],
    estimates[Math.floor(estimates.length * 0.975)],
  ];
}

/**
 * Shared prequential multiplicative interval scoring for live diagnostics and
 * offline walk-forward validation. Per-step scale factors λ (0 at median, 1 at
 * raw band edge, >1 outside) accumulate in a rolling window; terminal coverage
 * uses λ quantiles estimated only from earlier origins (prequential). ACI-lite
 * factor adjustment is applied separately via applyPathCalibration so chart
 * bands and residual diagnostics stay explicit.
 *
 * sequence items must be chronological:
 *   {
 *     actual: number[],                 // length = horizon, cumulative log returns
 *     quantiles: { q10..q90: number[] },
 *     analogueUpFrequency?: number,
 *     baselineQuantiles?: { q10..q90: number[] } | null,
 *   }
 */
export function scorePrequentialForecasts(sequence, {
  horizon,
  minPrequential = MIN_PREQUENTIAL_SCORES_FLOOR,
  residualWindow = RESIDUAL_SCORE_WINDOW,
} = {}) {
  const rows = Array.isArray(sequence) ? sequence : [];
  const safeHorizon = Math.max(1, Number(horizon) || 1);
  const scores50 = Array.from({ length: safeHorizon }, () => []);
  const scores80 = Array.from({ length: safeHorizon }, () => []);
  const coverage50Rows = [];
  const coverage80Rows = [];
  const absoluteLogErrors = [];
  const zeroReturnAbsoluteLogErrors = [];
  const brierScores = [];
  const climatologyBrierScores = [];
  const pinballLosses = [];
  const baselinePinballLosses = [];
  const interval50Widths = [];
  const interval80Widths = [];
  const interval50Scores = [];
  const interval80Scores = [];
  const observationRows = [];
  let directionalHits = 0;
  let priorUpCount = 0;
  let priorObservationCount = 0;

  for (const row of rows) {
    const terminal = safeHorizon - 1;
    const actualPath = Array.isArray(row.actual) ? row.actual : [];
    const quantiles = row.quantiles || {};
    const actual = actualPath[terminal];
    const median = quantiles.q50?.[terminal];
    const observedUp = actual > 0 ? 1 : 0;
    const analogueUpFrequency = clamp(Number(row.analogueUpFrequency), 0, 1);
    const climatologyUpFrequency = (priorUpCount + 1) / (priorObservationCount + 2);
    const absoluteError = Math.abs(actual - median);
    const zeroError = Math.abs(actual);
    const pinball = meanQuantileLoss(actual, quantiles, terminal);
    const baselinePinball = row.baselineQuantiles
      ? meanQuantileLoss(actual, row.baselineQuantiles, terminal)
      : NaN;
    const brier = Math.pow(analogueUpFrequency - observedUp, 2);
    const climatologyBrier = Math.pow(climatologyUpFrequency - observedUp, 2);
    if ((median > 0) === (actual > 0)) directionalHits += 1;
    absoluteLogErrors.push(absoluteError);
    zeroReturnAbsoluteLogErrors.push(zeroError);
    brierScores.push(brier);
    climatologyBrierScores.push(climatologyBrier);
    pinballLosses.push(pinball);
    baselinePinballLosses.push(baselinePinball);

    let covered50 = NaN;
    let covered80 = NaN;
    let width50 = NaN;
    let width80 = NaN;
    let score50 = NaN;
    let score80 = NaN;
    if (scores50[terminal].length >= minPrequential) {
      const factor50 = clampAppliedScaleFactor(empiricalQuantile(scores50[terminal], 0.50), 1);
      const factor80 = clampAppliedScaleFactor(empiricalQuantile(scores80[terminal], 0.80), 1);
      const mid = Number(median);
      const lower50 = mid - factor50 * Math.max(mid - quantiles.q25[terminal], 0);
      const upper50 = mid + factor50 * Math.max(quantiles.q75[terminal] - mid, 0);
      const lower80 = mid - factor80 * Math.max(mid - quantiles.q10[terminal], 0);
      const upper80 = mid + factor80 * Math.max(quantiles.q90[terminal] - mid, 0);
      covered50 = actual >= lower50 && actual <= upper50 ? 1 : 0;
      covered80 = actual >= lower80 && actual <= upper80 ? 1 : 0;
      width50 = upper50 - lower50;
      width80 = upper80 - lower80;
      score50 = intervalScore(actual, lower50, upper50, 0.50);
      score80 = intervalScore(actual, lower80, upper80, 0.20);
      coverage50Rows.push(covered50);
      coverage80Rows.push(covered80);
      interval50Widths.push(width50);
      interval80Widths.push(width80);
      interval50Scores.push(score50);
      interval80Scores.push(score80);
    }

    for (let step = 0; step < safeHorizon; step += 1) {
      const stepMedian = quantiles.q50?.[step];
      pushRollingScore(
        scores50[step],
        intervalScaleFactor(
          actualPath[step],
          quantiles.q25?.[step],
          quantiles.q75?.[step],
          stepMedian,
        ),
        residualWindow,
      );
      pushRollingScore(
        scores80[step],
        intervalScaleFactor(
          actualPath[step],
          quantiles.q10?.[step],
          quantiles.q90?.[step],
          stepMedian,
        ),
        residualWindow,
      );
    }
    priorUpCount += observedUp;
    priorObservationCount += 1;
    observationRows.push({
      absoluteError,
      zeroError,
      pinball,
      baselinePinball,
      brier,
      climatologyBrier,
      covered50,
      covered80,
      width50,
      width80,
      intervalScore50: score50,
      intervalScore80: score80,
    });
  }

  const meanAbsoluteLogError = average(absoluteLogErrors);
  const zeroReturnMeanAbsoluteLogError = average(zeroReturnAbsoluteLogErrors);
  const meanPinballLoss = average(pinballLosses);
  const baselineMeanPinballLoss = average(baselinePinballLosses);
  const brierScore = average(brierScores);
  const climatologyBrierScore = average(climatologyBrierScores);
  // Path calibration uses the terminal λ quantile only (broadcast). Per-step
  // intermediate λ is too noisy after coherent-path reordering and produced
  // mid-fan explosions (factors hitting the score cap on tight early steps).
  const terminalFactor50 = scores50[safeHorizon - 1].length > 0
    ? clampAppliedScaleFactor(empiricalQuantile(scores50[safeHorizon - 1], 0.50), 1)
    : 1;
  const terminalFactor80 = scores80[safeHorizon - 1].length > 0
    ? clampAppliedScaleFactor(empiricalQuantile(scores80[safeHorizon - 1], 0.80), 1)
    : 1;
  const corrections50 = Array.from({ length: safeHorizon }, () => terminalFactor50);
  const corrections80 = Array.from({ length: safeHorizon }, () => terminalFactor80);
  return {
    minPrequentialScores: minPrequential,
    // Multiplicative interval factors (1 ≈ raw width; <1 shrink; >1 widen).
    // Broadcast from terminal λ; applied uniformly in applyMultiplicativeFactors.
    corrections50,
    corrections80,
    terminalFactor50,
    terminalFactor80,
    calibrationMode: 'multiplicative-interval-scale-terminal-broadcast',
    residualWindow: Math.max(8, Number(residualWindow) || RESIDUAL_SCORE_WINDOW),
    coverage50: average(coverage50Rows),
    coverage80: average(coverage80Rows),
    coverage50Interval: blockBootstrapMeanInterval(coverage50Rows, 50 + safeHorizon),
    coverage80Interval: blockBootstrapMeanInterval(coverage80Rows, 80 + safeHorizon),
    coverageSamples: coverage50Rows.length,
    evaluationSamples: rows.length,
    directionalAccuracy: rows.length > 0 ? directionalHits / rows.length : null,
    meanAbsoluteLogError,
    zeroReturnMeanAbsoluteLogError,
    maeSkillVsZero: zeroReturnMeanAbsoluteLogError > 0
      ? 1 - meanAbsoluteLogError / zeroReturnMeanAbsoluteLogError
      : null,
    meanPinballLoss,
    baselineMeanPinballLoss,
    pinballSkillVsBaseline: baselineMeanPinballLoss > 0
      ? 1 - meanPinballLoss / baselineMeanPinballLoss
      : null,
    brierScore,
    climatologyBrierScore,
    brierSkillVsClimatology: climatologyBrierScore > 0
      ? 1 - brierScore / climatologyBrierScore
      : null,
    neutralBrierScore: 0.25,
    meanInterval50Width: average(interval50Widths),
    meanInterval80Width: average(interval80Widths),
    meanInterval50Score: average(interval50Scores),
    meanInterval80Score: average(interval80Scores),
    meanAbsoluteLogErrorInterval: blockBootstrapMeanInterval(absoluteLogErrors, 100 + safeHorizon),
    meanPinballLossInterval: blockBootstrapMeanInterval(pinballLosses, 200 + safeHorizon),
    brierScoreInterval: blockBootstrapMeanInterval(brierScores, 300 + safeHorizon),
    rows: observationRows,
  };
}

/**
 * Apply the live chart residual path: multiplicative interval factors, ACI-lite
 * inflate/deflate when rolling coverage misses nominal, then ordered quantiles.
 * pinMedian keeps the production baseline's zero-return median fixed.
 */
export function applyPathCalibration(rawQuantiles, {
  corrections50,
  corrections80,
  coverage50,
  coverage80,
  coverageSamples,
  horizon,
  pinMedian = null,
} = {}) {
  const pre50 = (Array.isArray(corrections50) ? corrections50 : [])
    .map((value) => clampAppliedScaleFactor(value, 1));
  const pre80 = (Array.isArray(corrections80) ? corrections80 : [])
    .map((value) => clampAppliedScaleFactor(value, 1));
  // Month-span overlays often have only 2–6 non-overlapping origins. The 80th
  // percentile of two λ samples is just the larger one and can double a
  // already-wide 28–31d analogue envelope. Draw raw FHS widths until the
  // residual window is large enough for a stable interval factor.
  const enoughResiduals = Number(coverageSamples) >= MIN_PREQUENTIAL_SCORES_FLOOR;
  const drawn50 = enoughResiduals ? pre50 : pre50.map(() => 1);
  const drawn80 = enoughResiduals ? pre80 : pre80.map(() => 1);
  const adjusted50 = (adaptiveCoverageWiden(
    drawn50,
    coverage50,
    0.50,
    coverageSamples,
  ) || drawn50).map((value) => clampAppliedScaleFactor(value, 1));
  const adjusted80 = (adaptiveCoverageWiden(
    drawn80,
    coverage80,
    0.80,
    coverageSamples,
  ) || drawn80).map((value) => clampAppliedScaleFactor(value, 1));
  const terminalPre50 = pre50.length ? pre50[pre50.length - 1] : 1;
  const terminalPre80 = pre80.length ? pre80[pre80.length - 1] : 1;
  const terminalDrawn50 = adjusted50.length ? adjusted50[adjusted50.length - 1] : 1;
  const terminalDrawn80 = adjusted80.length ? adjusted80[adjusted80.length - 1] : 1;
  const aciAdjusted = Math.abs(terminalDrawn50 - terminalPre50) > 1e-9
    || Math.abs(terminalDrawn80 - terminalPre80) > 1e-9;
  return {
    corrections50: adjusted50,
    corrections80: adjusted80,
    corrections50PreAci: pre50,
    corrections80PreAci: pre80,
    factor50PreAci: terminalPre50,
    factor80PreAci: terminalPre80,
    factor50Drawn: terminalDrawn50,
    factor80Drawn: terminalDrawn80,
    aciAdjusted,
    quantiles: applyMultiplicativeFactors(
      rawQuantiles,
      adjusted50,
      adjusted80,
      horizon,
      pinMedian,
    ),
  };
}

function buildCalibration(
  rows,
  featureState,
  currentOrigin,
  horizon,
  modelId,
  historyLimits = null,
  horizonDays = DEFAULT_HORIZON_DAYS,
) {
  const forecasts = [];
  // Terminal outcomes do not overlap. Horizon-scaled origin minimums keep 10d/20d
  // usable on typical exchange history depths.
  const originStep = horizon;
  const minOrigins = historyLimits?.minCalibrationOrigins
    ?? minCalibrationOriginsForHorizon(horizonDays);
  const minPrequential = historyLimits?.minPrequentialScores
    ?? minPrequentialScoresForHorizon(horizonDays);
  for (
    let origin = currentOrigin - horizon;
    origin >= FEATURE_WINDOW && forecasts.length < MAX_CALIBRATION_ORIGINS;
    origin -= originStep
  ) {
    if (origin + horizon > currentOrigin) continue;
    const forecast = rawForecast(
      rows,
      featureState,
      origin,
      horizon,
      modelId,
      historyLimits,
    );
    if (!forecast) continue;
    const actual = [];
    for (let step = 1; step <= horizon; step += 1) {
      actual.push(Math.log(rows[origin + step].close / rows[origin].close));
    }
    const baselineForecast = modelId === MODEL_IDS.VOLATILITY_BASELINE
      ? forecast
      : rawForecast(
        rows,
        featureState,
        origin,
        horizon,
        MODEL_IDS.VOLATILITY_BASELINE,
        historyLimits,
      );
    forecasts.push({ origin, forecast, baselineForecast, actual });
  }
  forecasts.sort((left, right) => left.origin - right.origin);
  if (forecasts.length < minOrigins) return null;

  const scored = scorePrequentialForecasts(
    forecasts.map((row) => ({
      actual: row.actual,
      quantiles: row.forecast.quantiles,
      analogueUpFrequency: row.forecast.analogueUpFrequency,
      baselineQuantiles: row.baselineForecast?.quantiles || null,
    })),
    { horizon, minPrequential },
  );
  return {
    originCount: forecasts.length,
    originSeparationBars: originStep,
    minCalibrationOrigins: minOrigins,
    minPrequentialScores: scored.minPrequentialScores,
    corrections50: scored.corrections50,
    corrections80: scored.corrections80,
    coverage50: scored.coverage50,
    coverage80: scored.coverage80,
    coverage50Interval: scored.coverage50Interval,
    coverage80Interval: scored.coverage80Interval,
    coverageSamples: scored.coverageSamples,
    evaluationSamples: scored.evaluationSamples,
    directionalAccuracy: scored.directionalAccuracy,
    meanAbsoluteLogError: scored.meanAbsoluteLogError,
    zeroReturnMeanAbsoluteLogError: scored.zeroReturnMeanAbsoluteLogError,
    maeSkillVsZero: scored.maeSkillVsZero,
    meanPinballLoss: scored.meanPinballLoss,
    baselineMeanPinballLoss: scored.baselineMeanPinballLoss,
    pinballSkillVsBaseline: scored.pinballSkillVsBaseline,
    brierScore: scored.brierScore,
    climatologyBrierScore: scored.climatologyBrierScore,
    brierSkillVsClimatology: scored.brierSkillVsClimatology,
    neutralBrierScore: scored.neutralBrierScore,
    meanInterval50Width: scored.meanInterval50Width,
    meanInterval80Width: scored.meanInterval80Width,
    meanInterval50Score: scored.meanInterval50Score,
    meanInterval80Score: scored.meanInterval80Score,
    meanAbsoluteLogErrorInterval: scored.meanAbsoluteLogErrorInterval,
    meanPinballLossInterval: scored.meanPinballLossInterval,
    brierScoreInterval: scored.brierScoreInterval,
  };
}

function enforceOrderedQuantiles(quantiles, horizon, { pinMedian = null } = {}) {
  const ordered = { q10: [], q25: [], q50: [], q75: [], q90: [] };
  const keys = ['q10', 'q25', 'q50', 'q75', 'q90'];
  const pinPath = pinMedian === 'q50';
  const pinConst = pinMedian !== null && pinMedian !== 'q50' && Number.isFinite(pinMedian);
  for (let index = 0; index < horizon; index += 1) {
    if (pinPath || pinConst) {
      const median = pinPath ? Number(quantiles.q50[index]) : pinMedian;
      if (!Number.isFinite(median)) {
        const values = keys
          .map((key) => Number(quantiles[key][index]))
          .sort((left, right) => left - right);
        keys.forEach((key, keyIndex) => { ordered[key].push(values[keyIndex]); });
        continue;
      }
      let q10 = Number(quantiles.q10[index]);
      let q25 = Number(quantiles.q25[index]);
      let q75 = Number(quantiles.q75[index]);
      let q90 = Number(quantiles.q90[index]);
      q25 = Math.min(q25, median);
      q10 = Math.min(q10, q25);
      q75 = Math.max(q75, median);
      q90 = Math.max(q90, q75);
      ordered.q10.push(q10);
      ordered.q25.push(q25);
      ordered.q50.push(median);
      ordered.q75.push(q75);
      ordered.q90.push(q90);
      continue;
    }
    const values = keys
      .map((key) => Number(quantiles[key][index]))
      .sort((left, right) => left - right);
    keys.forEach((key, keyIndex) => { ordered[key].push(values[keyIndex]); });
  }
  return ordered;
}

function projectedTime(anchorTime, timeframe, step, inferredInterval) {
  if (timeframe === '1M') {
    const anchor = new Date(anchorTime * 1000);
    return Math.floor(Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth() + step,
      1,
    ) / 1000);
  }
  const interval = FIXED_INTERVAL_SECONDS[timeframe] || inferredInterval || 60 * 60;
  return anchorTime + interval * step;
}

function pricePath(anchor, times, returns) {
  return [
    { time: times[0], value: anchor },
    ...returns.map((value, index) => ({
      time: times[index + 1],
      value: anchor * Math.exp(value),
    })),
  ];
}

function normalizeMonthWindow(item) {
  const startHint = Number(item?.monthStart || item?.startTime || 0);
  if (!(startHint > 0)) return null;
  const monthStart = Number(item.monthStart) > 0
    ? Number(item.monthStart)
    : utcMonthStartUnix(startHint);
  const monthEnd = Number(item.monthEnd) > 0
    ? Number(item.monthEnd)
    : utcMonthEndUnix(startHint);
  if (!(monthStart > 0) || !(monthEnd > monthStart)) return null;
  return {
    monthKey: Number(item.monthKey) || utcMonthKey(monthStart),
    monthStart,
    monthEnd,
    startTime: Number(item.startTime) || monthStart,
    endTime: Number(item.endTime) || 0,
    barCount: Number(item.barCount) || 0,
  };
}

function isWhitespacePoint(point) {
  return Boolean(point) && Number(point.time) > 0 && !Number.isFinite(point.value);
}

/**
 * Join per-month fans into one LC line without a vertical reset.
 * Month N ends at the next UTC month open — the same timestamp as month N+1's
 * origin. Popping the collision without a whitespace made LC connect the
 * previous outer band to the new origin price.
 * Historical 80% envelopes stay in the concat (faint on the chart) so
 * walk-forward containment is visible; whitespace still breaks month seams.
 */
function concatMonthPaths(months) {
  const paths = { q10: [], q25: [], q50: [], q75: [], q90: [] };
  for (let monthIndex = 0; monthIndex < months.length; monthIndex += 1) {
    const month = months[monthIndex];
    for (const key of QUANTILE_KEYS) {
      const segment = month.paths[key] || [];
      if (!segment.length) continue;
      if (paths[key].length) {
        const nextTime = Number(segment[0].time);
        while (paths[key].length) {
          const previous = paths[key][paths[key].length - 1];
          if (Number(previous.time) < nextTime) break;
          paths[key].pop();
        }
        const previous = paths[key][paths[key].length - 1];
        if (
          previous
          && !isWhitespacePoint(previous)
          && nextTime > Number(previous.time) + 1
        ) {
          paths[key].push({ time: Number(previous.time) + 1 });
        }
      }
      paths[key].push(...segment);
    }
  }
  return paths;
}

function emptyCalibrationPublicFields(calibrated, horizonBars = 0) {
  return {
    method: 'rolling-origin-multiplicative-scale-aci-lite',
    guarantee: 'empirical-only-dependent-series',
    calibrationMode: 'multiplicative-interval-scale-terminal-broadcast',
    originCount: 0,
    originSeparationBars: Math.max(0, Number(horizonBars) || 0),
    coverage50: null,
    coverage80: null,
    coverage50Interval: null,
    coverage80Interval: null,
    coverageSamples: 0,
    evaluationSamples: 0,
    factor50PreAci: 1,
    factor80PreAci: 1,
    factor50Drawn: Number.isFinite(calibrated?.factor50Drawn) ? calibrated.factor50Drawn : 1,
    factor80Drawn: Number.isFinite(calibrated?.factor80Drawn) ? calibrated.factor80Drawn : 1,
    aciAdjusted: false,
    directionalAccuracy: null,
    meanAbsoluteLogError: null,
    zeroReturnMeanAbsoluteLogError: null,
    maeSkillVsZero: null,
    meanPinballLoss: null,
    baselineMeanPinballLoss: null,
    pinballSkillVsBaseline: null,
    brierScore: null,
    climatologyBrierScore: null,
    brierSkillVsClimatology: null,
    neutralBrierScore: 0.25,
    meanInterval50Width: null,
    meanInterval80Width: null,
    meanInterval50Score: null,
    meanInterval80Score: null,
    meanAbsoluteLogErrorInterval: null,
    meanPinballLossInterval: null,
    brierScoreInterval: null,
  };
}

function calibrationPublicFields(calibration, calibrated, horizonBars = 0) {
  if (!calibration) return emptyCalibrationPublicFields(calibrated, horizonBars);
  return {
    method: 'rolling-origin-multiplicative-scale-aci-lite',
    guarantee: 'empirical-only-dependent-series',
    calibrationMode: 'multiplicative-interval-scale-terminal-broadcast',
    originCount: calibration.originCount,
    originSeparationBars: calibration.originSeparationBars,
    coverage50: calibration.coverage50,
    coverage80: calibration.coverage80,
    coverage50Interval: calibration.coverage50Interval,
    coverage80Interval: calibration.coverage80Interval,
    coverageSamples: calibration.coverageSamples,
    evaluationSamples: calibration.evaluationSamples,
    factor50PreAci: calibrated.factor50PreAci,
    factor80PreAci: calibrated.factor80PreAci,
    factor50Drawn: calibrated.factor50Drawn,
    factor80Drawn: calibrated.factor80Drawn,
    aciAdjusted: calibrated.aciAdjusted === true,
    directionalAccuracy: calibration.directionalAccuracy,
    meanAbsoluteLogError: calibration.meanAbsoluteLogError,
    zeroReturnMeanAbsoluteLogError: calibration.zeroReturnMeanAbsoluteLogError,
    maeSkillVsZero: calibration.maeSkillVsZero,
    meanPinballLoss: calibration.meanPinballLoss,
    baselineMeanPinballLoss: calibration.baselineMeanPinballLoss,
    pinballSkillVsBaseline: calibration.pinballSkillVsBaseline,
    brierScore: calibration.brierScore,
    climatologyBrierScore: calibration.climatologyBrierScore,
    brierSkillVsClimatology: calibration.brierSkillVsClimatology,
    neutralBrierScore: calibration.neutralBrierScore,
    meanInterval50Width: calibration.meanInterval50Width,
    meanInterval80Width: calibration.meanInterval80Width,
    meanInterval50Score: calibration.meanInterval50Score,
    meanInterval80Score: calibration.meanInterval80Score,
    meanAbsoluteLogErrorInterval: calibration.meanAbsoluteLogErrorInterval,
    meanPinballLossInterval: calibration.meanPinballLossInterval,
    brierScoreInterval: calibration.brierScoreInterval,
  };
}

/**
 * Historical fans must not share the next UTC month open with the following
 * origin. Same-x endpoints (forecast vs next origin close) read as a vertical
 * even when each month is its own LC series. The live month-from-open fan
 * still reaches monthEnd from the month open.
 */
function remainingPathFromForecast(forecast, originClose, times) {
  const median = forecast?.quantiles?.q50;
  if (Array.isArray(median) && median.length) {
    return pricePath(originClose, times, median);
  }
  const occupancy = occupancyToPrices(forecast?.occupancy, originClose, times);
  if (!occupancy?.slices?.length) return null;
  const points = [{ time: times[0], value: originClose }];
  for (const slice of occupancy.slices) {
    if (Number(slice.time) > 0 && Number(slice.mode) > 0) {
      points.push({ time: slice.time, value: slice.mode });
    }
  }
  return points.length >= 2 ? points : null;
}

function buildRemainingAdaptivePath(
  rows,
  featureState,
  tipIndex,
  window,
  timeframe,
  modelId,
  historyLimits,
  inferredInterval,
) {
  const remaining = resolveRemainingMonthHorizon(
    rows[tipIndex].time,
    window.monthEnd,
    timeframe,
  );
  if (!remaining.ok || remaining.horizonBars < 1) return null;
  const options = {
    adaptiveMonth: true,
    monthStart: window.monthStart,
    monthEnd: window.monthEnd,
    elapsedOriginIndex: tipIndex,
    matchCurrentState: true,
  };
  let forecast = rawForecast(
    rows,
    featureState,
    tipIndex,
    remaining.horizonBars,
    modelId,
    historyLimits,
    options,
  );
  if (!forecast && modelId === MODEL_IDS.MONTH_OPEN_MAP) {
    forecast = rawForecast(
      rows,
      featureState,
      tipIndex,
      remaining.horizonBars,
      MODEL_IDS.VOLATILITY_BASELINE,
      historyLimits,
      options,
    );
  }
  if (!forecast) return null;
  const tipTime = rows[tipIndex].time;
  const times = [tipTime];
  for (let step = 1; step < remaining.horizonBars; step += 1) {
    times.push(projectedTime(tipTime, timeframe, step, inferredInterval));
  }
  times.push(window.monthEnd);
  return remainingPathFromForecast(forecast, rows[tipIndex].close, times);
}

function clipCompletedMonthPaths(months) {
  if (!Array.isArray(months) || months.length < 2) return months;
  const lastIndex = months.length - 1;
  for (let monthIndex = 0; monthIndex < lastIndex; monthIndex += 1) {
    const month = months[monthIndex];
    const cutoff = Number(month.monthEnd);
    if (!(cutoff > 0)) continue;
    for (const key of QUANTILE_KEYS) {
      const path = month.paths?.[key];
      if (!Array.isArray(path) || path.length < 2) continue;
      while (path.length > 1 && Number(path[path.length - 1].time) >= cutoff) {
        path.pop();
      }
    }
    const tip = month.paths?.q50?.at(-1) || month.paths?.q25?.at(-1);
    if (tip && Number(tip.time) > 0) month.lastProjectionTime = tip.time;
  }
  return months;
}

export function computePriceProjection(candles, {
  timeframe = '2h',
  modelId = ACTIVE_MODEL_ID,
  profileMonths = null,
} = {}) {
  if (!Object.values(MODEL_IDS).includes(modelId)) {
    return unavailable('invalid-model', { modelId, monthCount: 0 });
  }
  // A 31-day UTC month is the densest path this overlay will ever draw.
  // Reject the timeframe before history gating so 1m/15m fail honestly.
  const timeframeProbe = resolveMonthHorizonBars(
    Date.UTC(2024, 0, 1) / 1000,
    Date.UTC(2024, 1, 1) / 1000,
    timeframe,
  );
  if (!timeframeProbe.ok) {
    return unavailable(timeframeProbe.reason, {
      monthCount: 0,
      horizonDays: timeframeProbe.horizonDays,
      horizonBars: timeframeProbe.horizonBars,
      maxHorizonBars: timeframeProbe.maxHorizonBars,
      detail: timeframeProbe.detail,
    });
  }
  const history = sourceHistoryLimits(timeframe, DEFAULT_HORIZON_DAYS);
  const normalized = normalizeCandles(candles);
  if (normalized.reason) {
    return unavailable(normalized.reason, {
      monthCount: 0,
      sourceCount: Array.isArray(candles) ? candles.length : 0,
    });
  }
  const capped = normalized.rows.length > history.maxBars
    ? normalized.rows.slice(-history.maxBars)
    : normalized.rows;
  const clean = trailingCleanSegment(capped, timeframe);
  const sourceRows = clean.rows;
  if (sourceRows.length < history.minBars) {
    return unavailable('insufficient-history', {
      monthCount: 0,
      sourceCount: sourceRows.length,
      rawSourceCount: capped.length,
      requiredSourceCount: history.minBars,
      requiredSourceDays: history.minSourceDays,
      maxSourceDays: history.maxSourceDays,
      droppedPrefixBars: clean.droppedPrefix,
      gapped: clean.gapped,
      minCalibrationOrigins: history.minCalibrationOrigins,
    });
  }

  const windows = Array.isArray(profileMonths)
    ? profileMonths.map(normalizeMonthWindow).filter(Boolean)
    : listEligibleMonthWindows(sourceRows);
  if (windows.length === 0) {
    return unavailable('no-profile-months', {
      monthCount: 0,
      sourceCount: sourceRows.length,
      droppedPrefixBars: clean.droppedPrefix,
      gapped: clean.gapped,
    });
  }

  const featureState = buildFeatureState(sourceRows);
  const months = [];
  let lastFail = null;
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    const window = windows[windowIndex];
    const live = windowIndex === windows.length - 1;
    const monthResolved = resolveMonthHorizonBars(window.monthStart, window.monthEnd, timeframe);
    if (!monthResolved.ok) {
      lastFail = {
        reason: monthResolved.reason,
        horizonDays: monthResolved.horizonDays,
        horizonBars: monthResolved.horizonBars,
        maxHorizonBars: monthResolved.maxHorizonBars,
        detail: monthResolved.detail,
      };
      continue;
    }
    const originIndex = lastIndexBefore(sourceRows, window.monthStart);
    const resolved = monthResolved;
    const pathAnchorTime = window.monthStart;
    const originMode = live ? 'month-open-live' : 'month-open';
    const tipIndex = lastIndexBefore(sourceRows, window.monthEnd);
    if (originIndex < FEATURE_WINDOW) {
      lastFail = {
        reason: 'insufficient-history',
        horizonDays: resolved.horizonDays,
        horizonBars: resolved.horizonBars,
        minCalibrationOrigins: history.minCalibrationOrigins,
      };
      continue;
    }
    const monthHistory = sourceHistoryLimits(timeframe, monthResolved.horizonDays);
    const liveTip = live
      && tipIndex >= 0
      && sourceRows[tipIndex].time >= window.monthStart;
    const forecastOptions = {
      adaptiveMonth: live,
      monthStart: window.monthStart,
      monthEnd: window.monthEnd,
      elapsedOriginIndex: liveTip ? tipIndex : null,
    };
    let forecast = rawForecast(
      sourceRows,
      featureState,
      originIndex,
      resolved.horizonBars,
      modelId,
      monthHistory,
      forecastOptions,
    );
    let usedModel = modelId;
    if (!forecast && modelId === MODEL_IDS.MONTH_OPEN_MAP) {
      forecast = rawForecast(
        sourceRows,
        featureState,
        originIndex,
        resolved.horizonBars,
        MODEL_IDS.VOLATILITY_BASELINE,
        monthHistory,
        forecastOptions,
      );
      usedModel = MODEL_IDS.VOLATILITY_BASELINE;
    }
    if (!forecast) {
      lastFail = {
        reason: 'insufficient-analogues',
        horizonDays: resolved.horizonDays,
        horizonBars: resolved.horizonBars,
        minCalibrationOrigins: monthHistory.minCalibrationOrigins,
      };
      continue;
    }
    const calibration = buildCalibration(
      sourceRows,
      featureState,
      originIndex,
      resolved.horizonBars,
      usedModel,
      monthHistory,
      monthResolved.horizonDays,
    );
    // Thin calibration must not drop a valid origin forecast. Drawn λ is
    // already 1 until ≥10 prequential residuals; missing origins just stay raw.
    const pinMedian = usedModel === MODEL_IDS.VOLATILITY_BASELINE
      || usedModel === MODEL_IDS.MONTH_OPEN_MAP
      ? 'q50'
      : null;
    const calibrated = applyPathCalibration(forecast.quantiles, {
      corrections50: calibration?.corrections50,
      corrections80: calibration?.corrections80,
      coverage50: calibration?.coverage50,
      coverage80: calibration?.coverage80,
      coverageSamples: calibration?.coverageSamples || 0,
      horizon: resolved.horizonBars,
      pinMedian,
    });
    const origin = sourceRows[originIndex];
    const previous = originIndex > 0 ? sourceRows[originIndex - 1] : null;
    const inferredInterval = previous
      ? Math.max(1, origin.time - previous.time)
      : FIXED_INTERVAL_SECONDS[timeframe] || 3600;
    const times = [pathAnchorTime];
    for (let step = 1; step < resolved.horizonBars; step += 1) {
      times.push(projectedTime(pathAnchorTime, timeframe, step, inferredInterval));
    }
    times.push(projectedTime(
      pathAnchorTime,
      timeframe,
      resolved.horizonBars,
      inferredInterval,
    ));
    const remainingPath = live && liveTip
      ? buildRemainingAdaptivePath(
        sourceRows,
        featureState,
        tipIndex,
        window,
        timeframe,
        modelId,
        monthHistory,
        inferredInterval,
      )
      : null;
    months.push({
      monthKey: window.monthKey,
      monthStart: window.monthStart,
      monthEnd: window.monthEnd,
      monthDays: monthResolved.horizonDays,
      originMode,
      horizonDays: resolved.horizonDays,
      horizonBars: resolved.horizonBars,
      originTime: origin.time,
      originIndex,
      originPrice: origin.close,
      anchorTime: pathAnchorTime,
      anchorPrice: origin.close,
      lastProjectionTime: times[times.length - 1],
      paths: {
        q10: pricePath(origin.close, times, calibrated.quantiles.q10),
        q25: pricePath(origin.close, times, calibrated.quantiles.q25),
        q50: pricePath(origin.close, times, calibrated.quantiles.q50),
        q75: pricePath(origin.close, times, calibrated.quantiles.q75),
        q90: pricePath(origin.close, times, calibrated.quantiles.q90),
      },
      occupancy: occupancyToPrices(forecast.occupancy, origin.close, times),
      occupancyMix: Number(forecast.conditioning?.occupancyMix),
      occupancyClimateCount: Number(forecast.conditioning?.occupancyClimateCount) || 0,
      remainingPath,
      analogueUpFrequency: forecast.analogueUpFrequency,
      analogCount: forecast.analogCount,
      conditioning: forecast.conditioning || null,
      medianZ: Number(forecast.conditioning?.medianZ) || 0,
      medianShrink: Number(forecast.conditioning?.medianShrink) || 0,
      weightEffectiveSampleSize: forecast.weightEffectiveSampleSize,
      clusterEffectiveSampleSize: forecast.clusterEffectiveSampleSize,
      pathModel: forecast.pathModel || 'month-open-occupancy',
      usedModel,
      calibration: calibrationPublicFields(calibration, calibrated, resolved.horizonBars),
    });
  }
  clipCompletedMonthPaths(months);

  if (months.length === 0) {
    return unavailable(lastFail?.reason || 'insufficient-history', {
      monthCount: 0,
      sourceCount: sourceRows.length,
      droppedPrefixBars: clean.droppedPrefix,
      gapped: clean.gapped,
      ...lastFail,
    });
  }

  const current = months[months.length - 1];
  return {
    status: 'ready',
    reason: '',
    model: {
      id: modelId,
      version: modelId.split('-v').at(-1) || '1',
      ...MODEL_EVIDENCE,
    },
    evidenceStatus: MODEL_EVIDENCE.status,
    timeframe,
    monthCount: months.length,
    months,
    horizon: current.horizonDays,
    horizonDays: current.horizonDays,
    horizonBars: current.horizonBars,
    monthStart: current.monthStart,
    monthEnd: current.monthEnd,
    monthDays: current.monthDays,
    originMode: current.originMode,
    sourceHistoryDays: history.maxSourceDays,
    sourceCount: sourceRows.length,
    droppedPrefixBars: clean.droppedPrefix,
    volModel: VOL_MODEL_ID,
    pathModel: current.pathModel,
    occupancy: current.occupancy || null,
    occupancyMix: Number(current.occupancyMix),
    occupancyClimateCount: Number(current.occupancyClimateCount) || 0,
    remainingPath: current.remainingPath || null,
    anchorTime: current.anchorTime,
    anchorPrice: current.anchorPrice,
    lastProjectionTime: current.lastProjectionTime,
    paths: concatMonthPaths(months),
    analogueUpFrequency: current.analogueUpFrequency,
    analogCount: current.analogCount,
    weightEffectiveSampleSize: current.weightEffectiveSampleSize,
    clusterEffectiveSampleSize: current.clusterEffectiveSampleSize,
    calibration: current.calibration,
  };
}

export const PRICE_PROJECTION_DEFAULTS = Object.freeze({
  keepMonths: PROFILE_KEEP_MONTHS,
  minProfileBars: PROFILE_MIN_BARS,
  minMonthDays: MIN_MONTH_DAYS,
  maxMonthDays: MAX_MONTH_DAYS,
  maxHorizonBars: MAX_HORIZON_BARS,
  minSourceDays: MIN_SOURCE_DAYS,
  minSourceDaysCoarse: MIN_SOURCE_DAYS_COARSE,
  maxSourceDays: MAX_SOURCE_DAYS,
  analogCount: ANALOG_COUNT,
  modelId: ACTIVE_MODEL_ID,
  volModel: VOL_MODEL_ID,
  pathModel: 'month-open-occupancy',
  occupancyBins: OCCUPANCY_BINS,
  occupancySlices: OCCUPANCY_SLICES,
  occupancyShrinkK: AUCTION_MEDIAN_SHRINK_K,
});

export const PRICE_PROJECTION_MODELS = MODEL_IDS;

// Offline validation and unit-test surface. The live chart should use only
// computePriceProjection; exposing the pure pieces avoids maintaining a second,
// subtly different research implementation.
export const __PRICE_PROJECTION_INTERNALS = Object.freeze({
  normalizeCandles,
  hasRegularCadence,
  trailingCleanSegment,
  meanAndDeviation,
  weightedQuantiles,
  coherentPathQuantiles,
  stepwiseWeightedQuantiles,
  adaptiveCoverageWiden,
  scorePrequentialForecasts,
  applyPathCalibration,
  applyMultiplicativeFactors,
  nestPathWidthsToTerminal,
  intervalScaleFactor,
  clampAppliedScaleFactor,
  buildFeatureState,
  robustFeatureScales,
  featureSquaredDistance,
  rawForecast,
  nonconformity,
  empiricalQuantile,
  enforceOrderedQuantiles,
  pinballLoss,
  intervalScore,
  resolveHorizonBars,
  resolveMonthHorizonBars,
  resolveRemainingMonthHorizon,
  utcMonthStartUnix,
  utcMonthEndUnix,
  utcMonthKey,
  lastIndexBefore,
  listEligibleMonthWindows,
  concatMonthPaths,
  clipCompletedMonthPaths,
  isWhitespacePoint,
  barsForCalendarDays,
  sourceHistoryLimits,
  harHorizonScale,
  harOneStepVariance,
  calendarMonthState,
  blendHarWithMonthRv,
  monthConditioning,
  blendMonthConditioning,
  originMonthConditioning,
  buildMonthAuctionStates,
  auctionFeatureVector,
  collectMonthOpenIndexes,
  elapsedIndexForCandidate,
  highestDensitySpan,
  mixOccupancySamples,
  buildReturnOccupancy,
  occupancyToPrices,
  minCalibrationOriginsForHorizon,
  minPrequentialScoresForHorizon,
  MAX_HORIZON_BARS,
  RESIDUAL_SCORE_WINDOW,
  VOL_MODEL_ID,
});
