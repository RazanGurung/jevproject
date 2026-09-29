/**
 * Two-week path projection from confirmed OHLCV candles.
 *
 * Projects a coherent path fan from the latest closed bar to the Monday 00:00
 * UTC two ISO weeks after the current week start (remaining of this week + the
 * next full week), plus optional current-week high/low envelope levels.
 * Research-only: reuses HAR multiperiod RV, coherent terminal-rank paths, and
 * multiplicative λ calibration from price-projection.js. No finite-sample
 * coverage guarantee; no trading/order coupling.
 */

import {
  harHorizonScale,
  coherentPathQuantiles,
  scorePrequentialForecasts,
  applyPathCalibration,
  trailingCleanSegment,
  barsForCalendarDays,
  __PRICE_PROJECTION_INTERNALS as PP,
} from './price-projection.js';

const FEATURE_WINDOW = 32;
const EMBARGO_BARS = 32;
const MAX_CALIBRATION_ORIGINS = 60;
// Same-remaining-length week origins are sparse (~1/week); day-class pooling
// for the vol baseline multiplies candidates. Keep a modest ESS floor.
const MIN_EFFECTIVE_SAMPLE = 12;
const MIN_CLUSTER_EFFECTIVE_SAMPLE = 5;
const MIN_SOURCE_DAYS = 90;
const MIN_SOURCE_DAYS_COARSE = 60;
const MAX_SOURCE_DAYS = 1_000;
const BASELINE_HISTORY_DAYS = 1_000;
const RECENCY_HALF_LIFE_DAYS = 90;
const MAX_SOURCE_BARS_HARD = 15_000;
// Horizon is two ISO weeks from the current week start (Mon→Mon+14d).
// Full 2-week window on 1h is 336 bars; denser TFs (15m full window) are rejected.
const HORIZON_WEEKS = 2;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const HORIZON_SECONDS = HORIZON_WEEKS * WEEK_SECONDS;
const MAX_WEEK_PATH_BARS = HORIZON_WEEKS * 7 * 24; // 336
const DAY_SECONDS = 24 * 60 * 60;
const MAX_REMAINING_DAY_CLASS = HORIZON_WEEKS * 7; // 14
const QUANTILE_LEVELS = Object.freeze([0.10, 0.25, 0.50, 0.75, 0.90]);
const QUANTILE_KEYS = Object.freeze(['q10', 'q25', 'q50', 'q75', 'q90']);
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

const MODEL_IDS = Object.freeze({
  WEEK_VOL_BASELINE: 'week-vol-baseline-v1',
  WEEK_WTD_ANALOGUE: 'week-wtd-analogue-v1',
});
const ACTIVE_MODEL_ID = MODEL_IDS.WEEK_VOL_BASELINE;
const MODEL_EVIDENCE = Object.freeze({
  // Frozen walk-forward ran; promotion failed (C50/Brier). Keep honest unvalidated
  // with the report id so evidence is pinned, not silent.
  status: 'unvalidated',
  validationReportId: 'week-path-projection-walk-forward-1786546708882',
  purpose: 'research-only',
});
const VOL_MODEL_ID = 'har-multiperiod-rv';
const ANALOGUE_COUNT = 120;

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Monday 00:00 UTC of the ISO week containing `unixSeconds`.
 */
export function isoWeekStartUnix(unixSeconds) {
  const ms = Number(unixSeconds) * 1000;
  if (!(ms > 0)) return 0;
  const date = new Date(ms);
  const day = date.getUTCDay(); // 0 Sun .. 6 Sat
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function isoWeekEndUnix(unixSeconds) {
  const start = isoWeekStartUnix(unixSeconds);
  return start > 0 ? start + WEEK_SECONDS : 0;
}

/**
 * Path terminal: Monday 00:00 UTC two weeks after the ISO week start that
 * contains `unixSeconds` (current week start + 14 calendar days).
 */
export function twoWeekHorizonEndUnix(unixSeconds) {
  const start = isoWeekStartUnix(unixSeconds);
  return start > 0 ? start + HORIZON_SECONDS : 0;
}

export function barIntervalSeconds(timeframe) {
  if (timeframe === '1M') return null;
  return FIXED_INTERVAL_SECONDS[timeframe] || null;
}

/**
 * Exact remaining bars from the bar at `barTime` until the 2-week horizon end
 * (current ISO week start + 14d). Bar exactly at the terminal has remaining 0.
 * Rejects non-aligned intervals and paths denser than MAX_WEEK_PATH_BARS.
 */
export function remainingBarsToWeekEnd(barTime, timeframe) {
  const time = Number(barTime);
  const interval = barIntervalSeconds(timeframe);
  if (!(time > 0) || !(interval > 0)) {
    return { ok: false, reason: 'unsupported-timeframe', remainingBars: 0, weekEnd: 0 };
  }
  if (timeframe === '1w' || timeframe === '1M') {
    return { ok: false, reason: 'horizon-too-short-for-timeframe', remainingBars: 0, weekEnd: 0 };
  }
  const weekStart = isoWeekStartUnix(time);
  const weekEnd = twoWeekHorizonEndUnix(time);
  if (!(weekEnd > time)) {
    return { ok: true, reason: '', remainingBars: 0, weekEnd, weekStart };
  }
  const span = weekEnd - time;
  if (span % interval !== 0) {
    return {
      ok: false,
      reason: 'horizon-not-aligned-to-timeframe',
      remainingBars: 0,
      weekEnd,
      weekStart,
    };
  }
  const remainingBars = span / interval;
  if (remainingBars > MAX_WEEK_PATH_BARS) {
    return {
      ok: false,
      reason: 'horizon-too-long-for-timeframe',
      remainingBars,
      weekEnd,
      weekStart,
      maxWeekPathBars: MAX_WEEK_PATH_BARS,
    };
  }
  return {
    ok: true,
    reason: '',
    remainingBars,
    weekEnd,
    weekStart,
  };
}

/** Remaining calendar days class for calibration minimums (1..14). */
export function remainingDayClass(remainingBars, timeframe) {
  const interval = barIntervalSeconds(timeframe);
  if (!(interval > 0) || !(remainingBars > 0)) return 0;
  return Math.max(
    1,
    Math.min(MAX_REMAINING_DAY_CLASS, Math.ceil((remainingBars * interval) / DAY_SECONDS)),
  );
}

export function minCalibrationOriginsForRemainingDays(remainingDays) {
  // Same-remaining-length origins appear ~once per week, so minima stay modest.
  // Longer remaining windows need fewer non-overlapping blocks to fit ~90d history.
  const days = Number(remainingDays);
  if (days <= 2) return 12;
  if (days <= 4) return 10;
  if (days <= 7) return 8;
  if (days <= 10) return 6;
  return 5;
}

export function minPrequentialScoresForRemainingDays(remainingDays) {
  return Math.max(
    6,
    Math.floor(minCalibrationOriginsForRemainingDays(remainingDays) / 2),
  );
}

function sourceHistoryLimits(timeframe) {
  const coarse = timeframe === '1d' || timeframe === '1w' || timeframe === '1M';
  const minSourceDays = coarse ? MIN_SOURCE_DAYS_COARSE : MIN_SOURCE_DAYS;
  const maxSourceDays = MAX_SOURCE_DAYS;
  const minBars = barsForCalendarDays(minSourceDays, timeframe);
  const maxBars = Math.min(
    MAX_SOURCE_BARS_HARD,
    barsForCalendarDays(maxSourceDays, timeframe),
  );
  const baselineHistoryBars = barsForCalendarDays(BASELINE_HISTORY_DAYS, timeframe);
  const recencyHalfLifeBars = barsForCalendarDays(RECENCY_HALF_LIFE_DAYS, timeframe);
  return {
    minSourceDays,
    maxSourceDays,
    minBars,
    maxBars,
    baselineHistoryBars,
    recencyHalfLifeBars,
  };
}

function unavailable(reason, detail = {}) {
  return {
    status: 'unavailable',
    reason,
    ...detail,
  };
}

function projectedTime(anchorTime, timeframe, step, inferredInterval) {
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

/**
 * Index of the first bar whose open/time is at or after week start.
 * Uses bar time as open time (Hyperliquid open-time candles).
 */
export function weekOpenIndex(rows, weekStartUnix) {
  if (!Array.isArray(rows) || !(weekStartUnix > 0)) return -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].time >= weekStartUnix) return i;
  }
  return -1;
}

function weekToDateStats(rows, weekOpenIdx, originIndex) {
  if (weekOpenIdx < 0 || originIndex < weekOpenIdx) return null;
  const openClose = rows[weekOpenIdx].close;
  if (!(openClose > 0)) return null;
  let high = rows[weekOpenIdx].high;
  let low = rows[weekOpenIdx].low;
  for (let i = weekOpenIdx; i <= originIndex; i += 1) {
    high = Math.max(high, rows[i].high);
    low = Math.min(low, rows[i].low);
  }
  const close = rows[originIndex].close;
  return {
    weekOpenPrice: openClose,
    weekOpenTime: rows[weekOpenIdx].time,
    wtdReturn: Math.log(close / openClose),
    wtdHigh: high,
    wtdLow: low,
    closeLocation: high > low ? (close - low) / (high - low) : 0.5,
  };
}

/**
 * WTD feature vector for analogue matching (research trial).
 * [normalized WTD return, range used / scale, short/long vol, close loc, remaining-horizon frac]
 */
function wtdFeatureAt(rows, featureState, index, timeframe, remainingBars, horizonBarsTotal) {
  const weekStart = isoWeekStartUnix(rows[index].time);
  const openIdx = weekOpenIndex(rows, weekStart);
  if (openIdx < 0 || openIdx > index) return null;
  const wtd = weekToDateStats(rows, openIdx, index);
  if (!wtd) return null;
  const har = Number.isFinite(featureState.harVar1?.[index])
    ? { harVar1: featureState.harVar1[index], rvLong: featureState.harRvLong[index] }
    : null;
  const scale1 = harHorizonScale(featureState.returns, index, 1, har);
  const scaleRem = harHorizonScale(featureState.returns, index, Math.max(1, remainingBars), har);
  const wtdRange = Math.log(Math.max(wtd.wtdHigh, wtd.weekOpenPrice) / Math.max(wtd.wtdLow, 1e-12));
  const remainingFrac = horizonBarsTotal > 0 ? remainingBars / horizonBarsTotal : 0;
  const volShort = har?.harVar1 > 0 ? Math.sqrt(har.harVar1) : scale1;
  const volLong = har?.rvLong > 0 ? Math.sqrt(har.rvLong) : volShort;
  return [
    wtd.wtdReturn / Math.max(scaleRem, 1e-10),
    wtdRange / Math.max(scaleRem, 1e-10),
    volShort / Math.max(volLong, 1e-10),
    clamp(wtd.closeLocation, 0, 1) * 2 - 1,
    remainingFrac * 2 - 1,
  ].map((value) => clamp(Number.isFinite(value) ? value : 0, -6, 6));
}

function featureDistance(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) {
    const d = left[i] - right[i];
    sum += d * d;
  }
  return sum / left.length;
}

function clusteredEss(selected, horizon, sumWeight) {
  const clusterWeights = new Map();
  for (const candidate of selected) {
    const cluster = Math.floor(candidate.index / Math.max(1, horizon));
    clusterWeights.set(cluster, (clusterWeights.get(cluster) || 0) + candidate.weight);
  }
  const sumSquares = [...clusterWeights.values()]
    .reduce((sum, weight) => sum + weight * weight, 0);
  return sumSquares > 0 ? (sumWeight * sumWeight) / sumSquares : 0;
}

function remainingBarsCache(rows, timeframe) {
  const cache = new Array(rows.length).fill(null);
  for (let i = 0; i < rows.length; i += 1) {
    const resolved = remainingBarsToWeekEnd(rows[i].time, timeframe);
    cache[i] = resolved.ok ? resolved.remainingBars : -1;
  }
  return cache;
}

/**
 * Eligible historical origin for a live horizon.
 * - Exact remaining length always matches (WTD analogue + baseline).
 * - Vol baseline also pools same remaining-day class when the candidate has
 *   at least `horizon` realized bars (first `horizon` steps are used).
 *   Exact-only matching is too sparse for 8–14d remaining on ~90–180d history.
 */
function remainingMatches(candidateRemaining, horizon, timeframe, { baseline = false } = {}) {
  const candidate = Number(candidateRemaining);
  const h = Number(horizon);
  if (!(candidate > 0) || !(h > 0)) return false;
  if (candidate === h) return true;
  if (!baseline) return false;
  if (candidate < h) return false;
  return remainingDayClass(candidate, timeframe) === remainingDayClass(h, timeframe);
}

function rawWeekForecast(
  rows,
  featureState,
  originIndex,
  horizon,
  modelId,
  historyLimits,
  timeframe,
  remainingCache,
) {
  const baseline = modelId === MODEL_IDS.WEEK_VOL_BASELINE;
  const maxCandidate = originIndex - EMBARGO_BARS - horizon;
  if (maxCandidate < FEATURE_WINDOW) return null;

  const candidateHistoryBars = historyLimits.maxBars;
  const minCandidate = Math.max(FEATURE_WINDOW, maxCandidate - candidateHistoryBars + 1);
  const eligibleIndexes = [];
  for (let index = minCandidate; index <= maxCandidate; index += 1) {
    if (
      remainingMatches(remainingCache[index], horizon, timeframe, { baseline })
      && index + horizon < rows.length
    ) {
      eligibleIndexes.push(index);
    }
  }
  // Same-h week origins are sparse (~1/week); day-class pooling helps baseline.
  // Do not demand PP's 120-analogue floor.
  const minCandidates = baseline ? MIN_EFFECTIVE_SAMPLE : Math.max(MIN_EFFECTIVE_SAMPLE, 40);
  if (eligibleIndexes.length < minCandidates) return null;

  const interval = barIntervalSeconds(timeframe) || DAY_SECONDS;
  const horizonBarsTotal = Math.round(HORIZON_SECONDS / interval);
  const originFeature = baseline
    ? null
    : wtdFeatureAt(rows, featureState, originIndex, timeframe, horizon, horizonBarsTotal);
  if (!baseline && !originFeature) return null;

  const selected = [];
  if (baseline) {
    for (const index of eligibleIndexes) {
      selected.push({ index, distanceSquared: 0, distance: 0 });
    }
  } else {
    for (const index of eligibleIndexes) {
      const feature = wtdFeatureAt(rows, featureState, index, timeframe, horizon, horizonBarsTotal);
      if (!feature) continue;
      const distanceSquared = featureDistance(originFeature, feature);
      if (selected.length < ANALOGUE_COUNT) {
        selected.push({ index, distanceSquared, distance: 0 });
        if (selected.length === ANALOGUE_COUNT) {
          selected.sort((a, b) => b.distanceSquared - a.distanceSquared);
        }
      } else if (distanceSquared < selected[0].distanceSquared) {
        selected[0] = { index, distanceSquared, distance: 0 };
        selected.sort((a, b) => b.distanceSquared - a.distanceSquared);
      }
    }
    if (selected.length < minCandidates) return null;
  }

  selected.sort((a, b) => a.distanceSquared - b.distanceSquared
    || a.index - b.index);
  for (const candidate of selected) {
    candidate.distance = Math.sqrt(candidate.distanceSquared);
  }
  const sortedDistances = selected.map((c) => c.distance).sort((a, b) => a - b);
  const medianDistance = sortedDistances[Math.floor(sortedDistances.length / 2)] || 0;
  const similarityScale = Math.max(medianDistance, 1e-6);
  let sumWeight = 0;
  let sumWeightSquared = 0;
  const recencyHalfLifeBars = Math.max(1, historyLimits.recencyHalfLifeBars);
  for (const candidate of selected) {
    const similarity = baseline
      ? 1
      : Math.exp(-0.5 * Math.pow(candidate.distance / similarityScale, 2));
    const recency = Math.pow(0.5, (originIndex - candidate.index) / recencyHalfLifeBars);
    candidate.weight = similarity * recency;
    sumWeight += candidate.weight;
    sumWeightSquared += candidate.weight * candidate.weight;
  }
  const effectiveSampleSize = sumWeightSquared > 0
    ? (sumWeight * sumWeight) / sumWeightSquared
    : 0;
  const clusterEffectiveSampleSize = clusteredEss(selected, horizon, sumWeight);
  const requiredEss = baseline ? MIN_EFFECTIVE_SAMPLE : Math.max(MIN_EFFECTIVE_SAMPLE, 40);
  if (effectiveSampleSize < requiredEss
    || clusterEffectiveSampleSize < MIN_CLUSTER_EFFECTIVE_SAMPLE) {
    return null;
  }

  const returns = featureState.returns;
  const harAt = (index) => (
    Number.isFinite(featureState.harVar1?.[index])
      ? { harVar1: featureState.harVar1[index], rvLong: featureState.harRvLong[index] }
      : null
  );

  const candidatePaths = selected.map((candidate) => {
    const path = [];
    let maxZ = -Infinity;
    let minZ = Infinity;
    for (let step = 1; step <= horizon; step += 1) {
      const realized = Math.log(rows[candidate.index + step].close / rows[candidate.index].close);
      const scale = harHorizonScale(returns, candidate.index, step, harAt(candidate.index));
      const z = realized / Math.max(scale, 1e-10);
      path.push(z);
      if (z > maxZ) maxZ = z;
      if (z < minZ) minZ = z;
    }
    return {
      weight: candidate.weight,
      path,
      terminal: path[path.length - 1],
      maxZ: Number.isFinite(maxZ) ? maxZ : 0,
      minZ: Number.isFinite(minZ) ? minZ : 0,
    };
  });

  const pickedPaths = coherentPathQuantiles(candidatePaths, QUANTILE_LEVELS);
  if (!pickedPaths) return null;

  const rawQuantiles = { q10: [], q25: [], q50: [], q75: [], q90: [] };
  for (let step = 1; step <= horizon; step += 1) {
    const stepIndex = step - 1;
    const liveScale = harHorizonScale(returns, originIndex, step, harAt(originIndex));
    for (let qi = 0; qi < QUANTILE_KEYS.length; qi += 1) {
      let value = Number(pickedPaths[qi][stepIndex]) * liveScale;
      if (baseline && qi === 2) value = 0;
      rawQuantiles[QUANTILE_KEYS[qi]].push(value);
    }
  }
  const quantiles = PP.enforceOrderedQuantiles(rawQuantiles, horizon, {
    pinMedian: baseline ? 0 : null,
  });

  // Envelope extremes from weighted max/min Z of remaining paths, scaled by live h scale.
  // Highs use upper quantiles (0.50 / 0.80); lows use lower quantiles (0.50 / 0.20)
  // so p80 is the more extreme wing on each side.
  const liveScaleH = harHorizonScale(returns, originIndex, horizon, harAt(originIndex));
  const maxSamples = candidatePaths.map((item) => ({
    value: item.maxZ,
    weight: item.weight,
  }));
  const minSamples = candidatePaths.map((item) => ({
    value: item.minZ,
    weight: item.weight,
  }));
  const maxQ = PP.weightedQuantiles(maxSamples, [0.50, 0.80]);
  const minQ = PP.weightedQuantiles(minSamples, [0.50, 0.20]);
  const remainingHigh = {
    p50: liveScaleH * (maxQ?.[0] ?? 0),
    p80: liveScaleH * (maxQ?.[1] ?? 0),
  };
  const remainingLow = {
    p50: liveScaleH * (minQ?.[0] ?? 0),
    p80: liveScaleH * (minQ?.[1] ?? 0),
  };

  const positiveWeight = candidatePaths.reduce(
    (sum, item) => sum + (item.terminal > 0 ? item.weight : 0),
    0,
  );

  return {
    quantiles,
    remainingHigh,
    remainingLow,
    analogueUpFrequency: sumWeight > 0 ? positiveWeight / sumWeight : 0.5,
    analogCount: selected.length,
    weightEffectiveSampleSize: effectiveSampleSize,
    clusterEffectiveSampleSize,
    pathModel: 'coherent-terminal-rank',
  };
}

function buildWeekCalibration(
  rows,
  featureState,
  currentOrigin,
  horizon,
  modelId,
  historyLimits,
  timeframe,
  remainingCache,
  remainingDays,
) {
  const originStep = horizon;
  const minOrigins = minCalibrationOriginsForRemainingDays(remainingDays);
  const minPrequential = minPrequentialScoresForRemainingDays(remainingDays);

  // Collect same remaining-length / same remaining-day-class origins (baseline),
  // then thin to non-overlapping blocks.
  const baseline = modelId === MODEL_IDS.WEEK_VOL_BASELINE;
  const matchingOrigins = [];
  for (let origin = FEATURE_WINDOW; origin <= currentOrigin - horizon; origin += 1) {
    if (!remainingMatches(remainingCache[origin], horizon, timeframe, { baseline })) continue;
    if (origin + horizon > currentOrigin) continue;
    matchingOrigins.push(origin);
  }
  const nonOverlapOrigins = [];
  for (const origin of matchingOrigins) {
    if (nonOverlapOrigins.length === 0) {
      nonOverlapOrigins.push(origin);
      continue;
    }
    const prev = nonOverlapOrigins[nonOverlapOrigins.length - 1];
    if (origin - prev >= originStep) nonOverlapOrigins.push(origin);
  }
  // Prefer the most recent non-overlapping origins.
  const selectedOrigins = nonOverlapOrigins.slice(-MAX_CALIBRATION_ORIGINS);

  const forecasts = [];
  for (const origin of selectedOrigins) {
    const forecast = rawWeekForecast(
      rows,
      featureState,
      origin,
      horizon,
      modelId,
      historyLimits,
      timeframe,
      remainingCache,
    );
    if (!forecast) continue;
    const actual = [];
    for (let step = 1; step <= horizon; step += 1) {
      actual.push(Math.log(rows[origin + step].close / rows[origin].close));
    }
    const baselineForecast = modelId === MODEL_IDS.WEEK_VOL_BASELINE
      ? forecast
      : rawWeekForecast(
        rows,
        featureState,
        origin,
        horizon,
        MODEL_IDS.WEEK_VOL_BASELINE,
        historyLimits,
        timeframe,
        remainingCache,
      );
    forecasts.push({ origin, forecast, baselineForecast, actual });
  }

  const nonOverlap = forecasts;
  if (nonOverlap.length < minOrigins) return null;

  const scored = scorePrequentialForecasts(
    nonOverlap.map((row) => ({
      actual: row.actual,
      quantiles: row.forecast.quantiles,
      analogueUpFrequency: row.forecast.analogueUpFrequency,
      baselineQuantiles: row.baselineForecast?.quantiles || null,
    })),
    { horizon, minPrequential },
  );

  return {
    originCount: nonOverlap.length,
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

/**
 * Compute 2-week path projection for the latest closed candle.
 */
export function computeWeekPathProjection(candles, {
  timeframe = '2h',
  modelId = ACTIVE_MODEL_ID,
} = {}) {
  if (!Object.values(MODEL_IDS).includes(modelId)) {
    return unavailable('invalid-model', { modelId, timeframe });
  }

  const history = sourceHistoryLimits(timeframe);
  const normalized = PP.normalizeCandles(candles);
  if (normalized.reason) {
    return unavailable(normalized.reason, {
      timeframe,
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
      timeframe,
      sourceCount: sourceRows.length,
      rawSourceCount: capped.length,
      requiredSourceCount: history.minBars,
      requiredSourceDays: history.minSourceDays,
      maxSourceDays: history.maxSourceDays,
      droppedPrefixBars: clean.droppedPrefix,
      gapped: clean.gapped,
    });
  }

  const originIndex = sourceRows.length - 1;
  const remaining = remainingBarsToWeekEnd(sourceRows[originIndex].time, timeframe);
  if (!remaining.ok) {
    return unavailable(remaining.reason, {
      timeframe,
      remainingBars: remaining.remainingBars,
      maxWeekPathBars: remaining.maxWeekPathBars || MAX_WEEK_PATH_BARS,
      weekEnd: remaining.weekEnd,
      sourceCount: sourceRows.length,
    });
  }
  if (!(remaining.remainingBars >= 1)) {
    return unavailable('horizon-complete', {
      timeframe,
      remainingBars: 0,
      weekEnd: remaining.weekEnd,
      weekStart: remaining.weekStart,
      sourceCount: sourceRows.length,
    });
  }

  const horizonBars = remaining.remainingBars;
  const remainingDays = remainingDayClass(horizonBars, timeframe);
  const weekOpenIdx = weekOpenIndex(sourceRows, remaining.weekStart);
  if (weekOpenIdx < 0) {
    return unavailable('missing-week-open', {
      timeframe,
      remainingBars: horizonBars,
      weekStart: remaining.weekStart,
      sourceCount: sourceRows.length,
    });
  }
  const wtd = weekToDateStats(sourceRows, weekOpenIdx, originIndex);
  if (!wtd) {
    return unavailable('missing-week-open', {
      timeframe,
      remainingBars: horizonBars,
      sourceCount: sourceRows.length,
    });
  }

  const featureState = PP.buildFeatureState(sourceRows);
  const remainingCache = remainingBarsCache(sourceRows, timeframe);
  const forecast = rawWeekForecast(
    sourceRows,
    featureState,
    originIndex,
    horizonBars,
    modelId,
    history,
    timeframe,
    remainingCache,
  );
  if (!forecast) {
    return unavailable('insufficient-analogues', {
      timeframe,
      remainingBars: horizonBars,
      remainingDays,
      sourceCount: sourceRows.length,
      minCalibrationOrigins: minCalibrationOriginsForRemainingDays(remainingDays),
    });
  }

  const calibration = buildWeekCalibration(
    sourceRows,
    featureState,
    originIndex,
    horizonBars,
    modelId,
    history,
    timeframe,
    remainingCache,
    remainingDays,
  );
  if (!calibration) {
    return unavailable('insufficient-calibration', {
      timeframe,
      remainingBars: horizonBars,
      remainingDays,
      sourceCount: sourceRows.length,
      analogCount: forecast.analogCount,
      weightEffectiveSampleSize: forecast.weightEffectiveSampleSize,
      minCalibrationOrigins: minCalibrationOriginsForRemainingDays(remainingDays),
      requiredHistoryBarsApprox:
        FEATURE_WINDOW + EMBARGO_BARS + horizonBars * (minCalibrationOriginsForRemainingDays(remainingDays) + 1),
    });
  }

  const pinMedian = modelId === MODEL_IDS.WEEK_VOL_BASELINE ? 0 : null;
  const calibrated = applyPathCalibration(forecast.quantiles, {
    corrections50: calibration.corrections50,
    corrections80: calibration.corrections80,
    coverage50: calibration.coverage50,
    coverage80: calibration.coverage80,
    coverageSamples: calibration.coverageSamples,
    horizon: horizonBars,
    pinMedian,
  });
  const adjusted = calibrated.quantiles;
  const anchor = sourceRows[originIndex];
  const previous = sourceRows[originIndex - 1];
  const inferredInterval = Math.max(1, anchor.time - previous.time);
  const times = [anchor.time];
  for (let step = 1; step <= horizonBars; step += 1) {
    times.push(projectedTime(anchor.time, timeframe, step, inferredInterval));
  }

  // Week envelope: max/min of WTD extremes and remaining-path extremes from now.
  const scaleHigh = (logMove) => anchor.close * Math.exp(Number(logMove) || 0);
  const remHigh50 = scaleHigh(forecast.remainingHigh.p50);
  const remHigh80 = scaleHigh(forecast.remainingHigh.p80);
  const remLow50 = scaleHigh(forecast.remainingLow.p50);
  const remLow80 = scaleHigh(forecast.remainingLow.p80);
  // Apply same terminal λ factors to envelope half-widths vs current (mild).
  const f50 = calibrated.factor50Drawn || 1;
  const f80 = calibrated.factor80Drawn || 1;
  const widenHigh = (price, factor) => {
    if (!(price > anchor.close)) return Math.max(price, wtd.wtdHigh);
    const logUp = Math.log(price / anchor.close) * factor;
    return Math.max(wtd.wtdHigh, anchor.close * Math.exp(logUp));
  };
  const widenLow = (price, factor) => {
    if (!(price < anchor.close)) return Math.min(price, wtd.wtdLow);
    const logDown = Math.log(price / anchor.close) * factor;
    return Math.min(wtd.wtdLow, anchor.close * Math.exp(logDown));
  };

  let high50 = widenHigh(remHigh50, f50);
  let high80 = widenHigh(remHigh80, f80);
  let low50 = widenLow(remLow50, f50);
  let low80 = widenLow(remLow80, f80);
  if (high80 < high50) high80 = high50;
  if (low80 > low50) low80 = low50;
  const envelope = { high50, high80, low50, low80 };

  const weekFractionElapsed = clamp(
    1 - (horizonBars * (barIntervalSeconds(timeframe) || DAY_SECONDS)) / HORIZON_SECONDS,
    0,
    1,
  );

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
    remainingBars: horizonBars,
    remainingDays,
    horizonBars,
    weekStart: remaining.weekStart,
    weekEnd: remaining.weekEnd,
    weekFractionElapsed,
    weekOpenPrice: wtd.weekOpenPrice,
    weekOpenTime: wtd.weekOpenTime,
    wtdReturn: wtd.wtdReturn,
    wtdHigh: wtd.wtdHigh,
    wtdLow: wtd.wtdLow,
    sourceHistoryDays: history.maxSourceDays,
    sourceCount: sourceRows.length,
    droppedPrefixBars: clean.droppedPrefix,
    volModel: VOL_MODEL_ID,
    pathModel: forecast.pathModel || 'coherent-terminal-rank',
    anchorTime: anchor.time,
    anchorPrice: anchor.close,
    lastProjectionTime: times[times.length - 1],
    paths: {
      q10: pricePath(anchor.close, times, adjusted.q10),
      q25: pricePath(anchor.close, times, adjusted.q25),
      q50: pricePath(anchor.close, times, adjusted.q50),
      q75: pricePath(anchor.close, times, adjusted.q75),
      q90: pricePath(anchor.close, times, adjusted.q90),
    },
    envelope,
    analogueUpFrequency: forecast.analogueUpFrequency,
    analogCount: forecast.analogCount,
    weightEffectiveSampleSize: forecast.weightEffectiveSampleSize,
    clusterEffectiveSampleSize: forecast.clusterEffectiveSampleSize,
    calibration: {
      method: 'rolling-origin-multiplicative-scale-aci-lite',
      guarantee: 'empirical-only-dependent-series',
      calibrationMode: 'multiplicative-interval-scale-terminal-broadcast',
      remainingDayClass: remainingDays,
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
    },
  };
}

export const WEEK_PATH_PROJECTION_DEFAULTS = Object.freeze({
  modelId: ACTIVE_MODEL_ID,
  horizonWeeks: HORIZON_WEEKS,
  maxWeekPathBars: MAX_WEEK_PATH_BARS,
  minSourceDays: MIN_SOURCE_DAYS,
  maxSourceDays: MAX_SOURCE_DAYS,
  recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS,
  envelopeVisibleDefault: true,
  volModel: VOL_MODEL_ID,
  pathModel: 'coherent-terminal-rank',
});

export const WEEK_PATH_PROJECTION_MODELS = MODEL_IDS;

// Offline validation and unit-test surface. Live chart uses computeWeekPathProjection only.
export const __WEEK_PATH_PROJECTION_INTERNALS = Object.freeze({
  rawWeekForecast,
  remainingBarsCache,
  remainingMatches,
  sourceHistoryLimits,
  FEATURE_WINDOW,
  EMBARGO_BARS,
  MAX_CALIBRATION_ORIGINS,
  MODEL_EVIDENCE,
  ACTIVE_MODEL_ID,
  VOL_MODEL_ID,
  HORIZON_WEEKS,
  MAX_WEEK_PATH_BARS,
});
