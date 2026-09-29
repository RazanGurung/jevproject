import { describe, expect, it } from 'vitest';
import {
  computePriceProjection,
  PRICE_PROJECTION_DEFAULTS,
  PRICE_PROJECTION_MODELS,
  resolveHorizonBars,
  resolveMonthHorizonBars,
  resolveRemainingMonthHorizon,
  utcMonthEndUnix,
  utcMonthStartUnix,
  __PRICE_PROJECTION_INTERNALS,
} from '../price-projection.js';

function syntheticCandles(count = 4_000, {
  start = 1_700_000_000,
  interval = 4 * 3600,
  timeAt = null,
  volatility = 1,
} = {}) {
  const rows = [];
  let close = 100;
  for (let i = 0; i < count; i += 1) {
    const cycle = Math.sin(i / 9) * 0.0012 + Math.cos(i / 31) * 0.00055;
    const drift = (i % 140 < 85 ? 0.00018 : -0.00012);
    const open = close;
    close = Math.max(1, open * Math.exp((cycle + drift) * volatility));
    const spread = open * (0.0015 + Math.abs(Math.sin(i / 13)) * 0.001 * volatility);
    rows.push({
      t: timeAt ? timeAt(i) : start + i * interval,
      o: String(open),
      h: String(Math.max(open, close) + spread),
      l: String(Math.min(open, close) - spread),
      c: String(close),
      v: String(100 + (i % 37) * 7 + Math.round(40 * Math.abs(Math.sin(i / 17)))),
    });
  }
  return rows;
}

function candlesWithPreviousMonth({
  prevVolatility = 1,
  prevDrift = 0,
  prevVolume = 100,
  count = 3_200,
} = {}) {
  const start = Date.UTC(2023, 0, 1) / 1000;
  const interval = 4 * 3600;
  const lastTime = start + (count - 1) * interval;
  const liveStart = utcMonthStartUnix(lastTime);
  const prevStart = utcMonthStartUnix(liveStart - 1);
  const rows = [];
  let close = 100;
  for (let i = 0; i < count; i += 1) {
    const time = start + i * interval;
    const inPrev = time >= prevStart && time < liveStart;
    const volatility = inPrev ? prevVolatility : 1;
    const cycle = Math.sin(i / 9) * 0.0012 + Math.cos(i / 31) * 0.00055;
    const drift = inPrev ? prevDrift : (i % 140 < 85 ? 0.00018 : -0.00012);
    const open = close;
    close = Math.max(1, open * Math.exp((cycle + drift) * volatility));
    const spread = open * (0.0015 + Math.abs(Math.sin(i / 13)) * 0.001 * volatility);
    rows.push({
      t: time,
      o: String(open),
      h: String(Math.max(open, close) + spread),
      l: String(Math.min(open, close) - spread),
      c: String(close),
      v: String(inPrev ? prevVolume : 100 + (i % 37) * 7),
    });
  }
  return rows;
}

describe('price projection model', () => {
  it('maps a UTC calendar month to exact bar counts per timeframe', () => {
    const january = Date.UTC(2024, 0, 1) / 1000;
    const february = Date.UTC(2024, 1, 1) / 1000;
    const march = Date.UTC(2024, 2, 1) / 1000;
    expect(resolveMonthHorizonBars(january, february, '4h')).toMatchObject({
      ok: true,
      horizonDays: 31,
      horizonBars: 186,
    });
    expect(resolveMonthHorizonBars(february, march, '2h')).toMatchObject({
      ok: true,
      horizonDays: 29,
      horizonBars: 348,
    });
    expect(resolveHorizonBars(31, '1d')).toMatchObject({ ok: true, horizonBars: 31 });
    expect(resolveMonthHorizonBars(january, february, '1w')).toMatchObject({
      ok: false,
      reason: 'horizon-not-aligned-to-timeframe',
    });
    expect(resolveMonthHorizonBars(january, february, '1m')).toMatchObject({
      ok: false,
      reason: 'horizon-too-long-for-timeframe',
    });
    expect(resolveHorizonBars(0, '2h')).toMatchObject({
      ok: false,
      reason: 'invalid-horizon',
    });
    expect(resolveRemainingMonthHorizon(
      february - 4 * 60 * 60,
      february,
      '4h',
    )).toMatchObject({
      ok: true,
      horizonDays: 4 / 24,
      horizonBars: 1,
    });
    expect(resolveRemainingMonthHorizon(january, february, '4h')).toMatchObject({
      ok: true,
      horizonDays: 31,
      horizonBars: 186,
    });
  });

  it('builds deterministic calibrated percentile paths from valid history', () => {
    const candles = syntheticCandles(3_000);
    const first = computePriceProjection(candles, { timeframe: '4h' });
    const second = computePriceProjection(candles, { timeframe: '4h' });

    expect(first).toEqual(second);
    expect(first.status).toBe('ready');
    expect(first.model).toMatchObject({
      id: PRICE_PROJECTION_MODELS.MONTH_OPEN_MAP,
      status: 'unvalidated',
      purpose: 'research-only',
    });
    expect(first.evidenceStatus).toBe('unvalidated');
    expect(first.monthCount).toBeGreaterThanOrEqual(1);
    expect(first.horizonDays).toBeGreaterThan(0);
    expect(first.horizonDays).toBeLessThanOrEqual(31);
    expect(Math.abs(first.horizonBars - first.horizonDays * 6)).toBeLessThan(1);
    expect(first.analogCount).toBeGreaterThanOrEqual(8);
    expect(first.weightEffectiveSampleSize).toBeGreaterThanOrEqual(8);
    expect(first.clusterEffectiveSampleSize).toBeGreaterThanOrEqual(5);
    expect(first.analogueUpFrequency).toBeGreaterThanOrEqual(0);
    expect(first.analogueUpFrequency).toBeLessThanOrEqual(1);
    expect(first.calibration.originCount).toBeGreaterThanOrEqual(4);
    expect(first.calibration).toMatchObject({
      method: 'rolling-origin-multiplicative-scale-aci-lite',
      guarantee: 'empirical-only-dependent-series',
      calibrationMode: 'multiplicative-interval-scale-terminal-broadcast',
    });
    expect(Number.isFinite(first.calibration.factor50PreAci)).toBe(true);
    expect(Number.isFinite(first.calibration.factor50Drawn)).toBe(true);
    expect(typeof first.calibration.aciAdjusted).toBe('boolean');
    expect(first.pathModel).toBe('month-open-occupancy');
    expect(first.volModel).toBe('har-month-conditioned-rv');
    expect(first.calibration.evaluationSamples).toBe(first.calibration.originCount);
    expect(first.calibration.originSeparationBars).toBe(first.horizonBars);
    expect(first.calibration.directionalAccuracy).toBeGreaterThanOrEqual(0);
    expect(first.calibration.directionalAccuracy).toBeLessThanOrEqual(1);
    expect(first.calibration.meanAbsoluteLogError).toBeGreaterThanOrEqual(0);
    expect(first.calibration.zeroReturnMeanAbsoluteLogError).toBeGreaterThanOrEqual(0);
    expect(first.calibration.brierScore).toBeGreaterThanOrEqual(0);
    expect(first.calibration.brierScore).toBeLessThanOrEqual(1);
    expect(first.calibration.neutralBrierScore).toBe(0.25);
    expect(first.calibration.climatologyBrierScore).toBeGreaterThanOrEqual(0);
    expect(first.calibration.meanPinballLoss).toBeGreaterThanOrEqual(0);
    expect(first.calibration.baselineMeanPinballLoss).toBeGreaterThanOrEqual(0);
    expect(first.calibration.coverage50Interval).toHaveLength(2);
    expect(first.calibration.coverage80Interval).toHaveLength(2);
    const current = first.months.at(-1);
    expect(current.paths.q50).toHaveLength(current.horizonBars + 1);
    expect(current.originMode).toBe('month-open-live');
    expect(current.paths.q50[0]).toEqual({
      time: current.monthStart,
      value: current.anchorPrice,
    });
    expect(current.anchorTime).toBe(current.monthStart);
    expect(current.originTime).toBeLessThan(current.monthStart);
    expect(current.lastProjectionTime).toBe(current.monthEnd);
    expect(first.lastProjectionTime - first.anchorTime)
      .toBeCloseTo(first.horizonDays * 24 * 60 * 60, 8);
    expect(current.occupancy?.slices?.length).toBeGreaterThan(0);
    expect(current.occupancyMix).toBeGreaterThanOrEqual(0);
    expect(current.occupancyMix).toBeLessThanOrEqual(1);
    expect(current.occupancyClimateCount).toBeGreaterThanOrEqual(8);
    expect(current.occupancy.binCount).toBe(PRICE_PROJECTION_DEFAULTS.occupancyBins);
    expect(PRICE_PROJECTION_DEFAULTS.occupancyBins).toBe(80);
    expect(PRICE_PROJECTION_DEFAULTS.occupancySlices).toBe(60);
    expect(current.occupancy.slices.length).toBeGreaterThanOrEqual(24);
    expect(current.occupancy.slices.every((slice) => (
      Number(slice.time) > 0
      && Number(slice.mode) > 0
      && Number(slice.hdi50Low) > 0
      && Number(slice.hdi50High) > Number(slice.hdi50Low)
      && Array.isArray(slice.bins)
      && slice.bins.length > 0
      && slice.bins.every((bin) => bin.priceHigh > bin.priceLow && bin.mass >= 0)
    ))).toBe(true);

    const currentTimes = new Set(current.paths.q50.map((point) => point.time));
    for (const point of first.paths.q50) {
      if (!Number.isFinite(point.value)) continue;
      const inner = ['q25', 'q50', 'q75']
        .map((key) => first.paths[key].find((row) => row.time === point.time)?.value);
      expect(inner.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
      expect(inner).toEqual([...inner].sort((left, right) => left - right));
      if (!currentTimes.has(point.time)) continue;
      const outer = ['q10', 'q25', 'q50', 'q75', 'q90']
        .map((key) => first.paths[key].find((row) => row.time === point.time)?.value);
      expect(outer.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
      expect(outer).toEqual([...outer].sort((left, right) => left - right));
    }
  }, 60_000);

  it('keeps all projected timestamps in the selected chart cadence', () => {
    const twoHour = computePriceProjection(
      syntheticCandles(5_000, { interval: 2 * 60 * 60 }),
      { timeframe: '2h' },
    );
    expect(twoHour.status).toBe('ready');
    expect(Math.abs(twoHour.horizonBars - twoHour.horizonDays * 12)).toBeLessThan(1);
    expect(twoHour.months[0].originMode).toBe('month-open');
    expect(twoHour.paths.q50[1].time - twoHour.months[0].monthStart).toBe(2 * 60 * 60);
    expect(twoHour.lastProjectionTime - twoHour.anchorTime)
      .toBeCloseTo(twoHour.horizonDays * 24 * 60 * 60, 8);

    const monthlyCandles = syntheticCandles(900, {
      timeAt: (index) => Math.floor(Date.UTC(1971, index, 1) / 1000),
    });
    const monthly = computePriceProjection(monthlyCandles, { timeframe: '1M' });
    expect(monthly).toMatchObject({
      status: 'unavailable',
      reason: 'horizon-too-short-for-timeframe',
    });
  }, 60_000);

  it('projects only profile-eligible UTC months from month open to month end', () => {
    const start = Date.UTC(2023, 0, 1) / 1000;
    const candles = syntheticCandles(4_000, {
      start,
      interval: 4 * 60 * 60,
    });
    const result = computePriceProjection(candles, { timeframe: '4h' });
    expect(result.status).toBe('ready');
    expect(result.monthCount).toBeGreaterThanOrEqual(2);
    expect(result.monthCount).toBeLessThanOrEqual(PRICE_PROJECTION_DEFAULTS.keepMonths);
    expect(result.sourceHistoryDays).toBe(PRICE_PROJECTION_DEFAULTS.maxSourceDays);
    let previousEnd = 0;
    const current = result.months.at(-1);
    for (const month of result.months) {
      const live = month === current;
      expect(month.monthStart).toBe(utcMonthStartUnix(month.monthStart));
      expect(month.monthEnd).toBe(utcMonthEndUnix(month.monthStart));
      expect(month.monthDays).toBeGreaterThanOrEqual(28);
      expect(month.monthDays).toBeLessThanOrEqual(31);
      if (live) {
        expect(month.originMode).toBe('month-open-live');
        expect(month.originTime).toBeLessThan(month.monthStart);
        expect(month.paths.q50[0].time).toBe(month.monthStart);
        expect(month.anchorTime).toBe(month.monthStart);
        expect(month.lastProjectionTime).toBe(month.monthEnd);
        expect(month.paths.q50).toHaveLength(month.horizonBars + 1);
        expect(month.horizonDays).toBeGreaterThanOrEqual(28);
        expect(month.horizonDays).toBeLessThanOrEqual(31);
        expect(month.horizonBars).toBe((month.monthEnd - month.monthStart) / (4 * 60 * 60));
        expect(month.occupancy?.slices?.length).toBeGreaterThan(0);
      } else {
        expect(month.originMode).toBe('month-open');
        expect(month.originTime).toBeLessThan(month.monthStart);
        expect(month.paths.q50[0].time).toBe(month.monthStart);
        expect(month.lastProjectionTime).toBe(month.monthEnd - 4 * 60 * 60);
        expect(month.paths.q50).toHaveLength(month.horizonBars);
        expect(month.horizonDays).toBeGreaterThanOrEqual(28);
        expect(month.horizonDays).toBeLessThanOrEqual(31);
      }
      if (previousEnd) expect(month.monthStart).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = month.monthEnd;
    }
    for (let index = 1; index < result.months.length; index += 1) {
      const previous = result.months[index - 1];
      const month = result.months[index];
      expect(previous.lastProjectionTime).toBeLessThan(month.monthStart);
      expect(previous.paths.q25.at(-1).time).toBeLessThan(month.paths.q25[0].time);
      expect(previous.paths.q75.at(-1).time).toBeLessThan(month.paths.q75[0].time);
    }

    const { isWhitespacePoint } = __PRICE_PROJECTION_INTERNALS;
    for (const key of ['q25', 'q50', 'q75']) {
      const breaks = result.paths[key].filter(isWhitespacePoint);
      expect(breaks.length).toBe(result.monthCount - 1);
      for (let index = 1; index < result.paths[key].length; index += 1) {
        const previous = result.paths[key][index - 1];
        const point = result.paths[key][index];
        if (Number.isFinite(previous.value) && Number.isFinite(point.value)) {
          expect(point.time - previous.time).toBeLessThanOrEqual(4 * 60 * 60);
        }
      }
    }
    const finiteOuter = (key) => result.paths[key].filter((point) => Number.isFinite(point.value));
    const monthOuter = (key) => result.months.reduce(
      (sum, month) => sum + month.paths[key].length,
      0,
    );
    expect(finiteOuter('q10')).toHaveLength(monthOuter('q10'));
    expect(finiteOuter('q90')).toHaveLength(monthOuter('q90'));
    for (const key of ['q10', 'q90']) {
      const breaks = result.paths[key].filter(isWhitespacePoint);
      expect(breaks.length).toBe(result.monthCount - 1);
    }
  }, 60_000);

  it('returns explicit unavailable states instead of weakening requirements', () => {
    const short = computePriceProjection(
      syntheticCandles(200),
      { timeframe: '4h' },
    );
    expect(short).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient-history',
    });
    expect(short.requiredSourceCount).toBeGreaterThan(200);

    const invalid = syntheticCandles();
    invalid[300] = { ...invalid[300], t: invalid[299].t };
    expect(computePriceProjection(invalid, { timeframe: '4h' }))
      .toMatchObject({ status: 'unavailable', reason: 'invalid-source' });
    expect(computePriceProjection(syntheticCandles(), { timeframe: '1m' }))
      .toMatchObject({ status: 'unavailable', reason: 'horizon-too-long-for-timeframe' });

    // Early gap: trailing clean segment is still long enough → projection remains ready.
    const gappedEarly = syntheticCandles();
    gappedEarly.splice(300, 1);
    const recovered = computePriceProjection(gappedEarly, { timeframe: '4h' });
    expect(recovered.status).toBe('ready');
    expect(recovered.droppedPrefixBars).toBeGreaterThan(0);

    // Gap near the end leaves a short trailing segment → insufficient history.
    const gappedLate = syntheticCandles(800);
    gappedLate.splice(gappedLate.length - 50, 1);
    expect(computePriceProjection(gappedLate, { timeframe: '4h' }))
      .toMatchObject({ status: 'unavailable', reason: 'insufficient-history' });
  }, 60_000);

  it('uses multiperiod HAR vol; high-vol regimes tighten vs pure σ√h', () => {
    const { harHorizonScale, harOneStepVariance } = __PRICE_PROJECTION_INTERNALS;
    const returns = [];
    for (let i = 0; i < 200; i += 1) {
      // Quiet history then a late vol spike so harVar1 >> rvLong at the tip.
      returns.push(i === 0 ? NaN : (i < 160 ? 0.001 : 0.04) * Math.sin(i / 7));
    }
    const short = harHorizonScale(returns, 199, 1);
    const long = harHorizonScale(returns, 199, 16);
    const { harVar1, rvLong } = harOneStepVariance(returns, 199);
    expect(harVar1).toBeGreaterThan(rvLong);
    // Pure √h would give long/short = 4; mean reversion toward rvLong is tighter.
    expect(long / short).toBeGreaterThan(2);
    expect(long / short).toBeLessThan(4);
    // Equal regime recovers √h identity.
    const flat = harHorizonScale(returns, 199, 16, { harVar1: 0.0001, rvLong: 0.0001 });
    expect(flat / Math.sqrt(0.0001)).toBeCloseTo(4, 10);
  });

  it('selects coherent whole-path quantiles by terminal rank', () => {
    const {
      coherentPathQuantiles,
      stepwiseWeightedQuantiles,
      adaptiveCoverageWiden,
      intervalScaleFactor,
    } = __PRICE_PROJECTION_INTERNALS;
    const paths = [
      { weight: 1, terminal: -2, path: [-1, -2] },
      { weight: 1, terminal: -1, path: [-0.5, -1] },
      { weight: 1, terminal: 0, path: [0, 0] },
      { weight: 1, terminal: 1, path: [0.5, 1] },
      { weight: 1, terminal: 2, path: [1, 2] },
    ];
    const picked = coherentPathQuantiles(paths, [0.1, 0.5, 0.9]);
    expect(picked).toEqual([
      [-1, -2],
      [0, 0],
      [1, 2],
    ]);
    // Intermediate steps belong to the same trajectories (coherent).
    expect(picked[0][0]).toBe(-1);
    expect(picked[2][0]).toBe(1);

    // Terminal-rank q25 can be the path that is *up* early and down late.
    // Pinning the median to 0 would flatten that early stretch. Stepwise
    // quantiles use the cross-section at each step instead.
    const crossing = [
      { weight: 1, terminal: -2, path: [1, -2] },
      { weight: 1, terminal: -1, path: [1, -1] },
      { weight: 1, terminal: 0, path: [0, 0] },
      { weight: 1, terminal: 1, path: [-1, 1] },
      { weight: 1, terminal: 2, path: [-1, 2] },
    ];
    const coherentEarly = coherentPathQuantiles(crossing, [0.25, 0.75]);
    expect(coherentEarly[0][0]).toBe(1);
    const stepwise = stepwiseWeightedQuantiles(crossing, [0.25, 0.75]);
    expect(stepwise[0][0]).toBeLessThan(0);
    expect(stepwise[1][0]).toBeGreaterThan(0);
    expect(stepwise[0][1]).toBeLessThan(0);
    expect(stepwise[1][1]).toBeGreaterThan(0);

    const widened = adaptiveCoverageWiden([1, 2, 3], 0.40, 0.50, 20);
    expect(widened[0]).toBeGreaterThan(1);
    // Symmetric: over-coverage mildly deflates multiplicative factors.
    const narrowed = adaptiveCoverageWiden([1, 2, 3], 0.65, 0.50, 20);
    expect(narrowed[0]).toBeLessThan(1);
    expect(adaptiveCoverageWiden([1, 2], 0.50, 0.50, 20)).toEqual([1, 2]);
    expect(intervalScaleFactor(0, -2, 2, 0)).toBe(0);
    expect(intervalScaleFactor(2, -2, 2, 0)).toBeCloseTo(1, 12);
    expect(intervalScaleFactor(3, -2, 2, 0)).toBeCloseTo(1.5, 12);
  });

  it('shares prequential residual scoring and path calibration with offline validation', () => {
    const {
      scorePrequentialForecasts,
      applyPathCalibration,
      adaptiveCoverageWiden,
      applyMultiplicativeFactors,
    } = __PRICE_PROJECTION_INTERNALS;

    const sequence = [];
    for (let origin = 0; origin < 24; origin += 1) {
      const drift = (origin - 12) * 0.001;
      const path = [drift * 0.5, drift];
      sequence.push({
        actual: path,
        quantiles: {
          q10: [drift - 0.02, drift - 0.04],
          q25: [drift - 0.01, drift - 0.02],
          q50: [0, 0],
          q75: [drift + 0.01, drift + 0.02],
          q90: [drift + 0.02, drift + 0.04],
        },
        analogueUpFrequency: path[1] > 0 ? 0.6 : 0.4,
        baselineQuantiles: {
          q10: [-0.02, -0.04],
          q25: [-0.01, -0.02],
          q50: [0, 0],
          q75: [0.01, 0.02],
          q90: [0.02, 0.04],
        },
      });
    }

    const scored = scorePrequentialForecasts(sequence, { horizon: 2, minPrequential: 10 });
    expect(scored.evaluationSamples).toBe(24);
    expect(scored.coverageSamples).toBe(14);
    expect(scored.calibrationMode).toBe('multiplicative-interval-scale-terminal-broadcast');
    expect(scored.corrections50).toHaveLength(2);
    expect(scored.corrections80).toHaveLength(2);
    // Terminal λ is broadcast to every step (avoids mid-path factor explosions).
    expect(scored.corrections50[0]).toBe(scored.corrections50[1]);
    expect(scored.corrections80[0]).toBe(scored.corrections80[1]);
    // Factors are unclamped (no hard [0.4, 2] cap); only require finite & positive.
    expect(scored.corrections50.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
    expect(scored.corrections80.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
    expect(scored.rows).toHaveLength(24);
    expect(scored.rows.slice(0, 10).every((row) => Number.isNaN(row.covered50))).toBe(true);
    expect(scored.rows.slice(10).every((row) => row.covered50 === 0 || row.covered50 === 1)).toBe(true);
    // Zero-median baseline: MAE skill vs zero is identity (0).
    expect(scored.maeSkillVsZero).toBeCloseTo(0, 12);

    const live = applyPathCalibration(sequence.at(-1).quantiles, {
      corrections50: scored.corrections50,
      corrections80: scored.corrections80,
      coverage50: scored.coverage50,
      coverage80: scored.coverage80,
      coverageSamples: scored.coverageSamples,
      horizon: 2,
      pinMedian: 0,
    });
    const manual50 = adaptiveCoverageWiden(
      scored.corrections50,
      scored.coverage50,
      0.50,
      scored.coverageSamples,
    );
    const manual80 = adaptiveCoverageWiden(
      scored.corrections80,
      scored.coverage80,
      0.80,
      scored.coverageSamples,
    );
    const manual = applyMultiplicativeFactors(
      sequence.at(-1).quantiles,
      manual50,
      manual80,
      2,
      0,
    );
    expect(live.quantiles).toEqual(manual);
    expect(live.quantiles.q50).toEqual([0, 0]);
  });

  it('handles zero volume and nearly flat prices without non-finite output', () => {
    const rows = syntheticCandles(2_500).map((row, index) => ({
      ...row,
      o: String(100 + Math.sin(index / 20) * 1e-7),
      h: String(100.000001),
      l: String(99.999999),
      c: String(100 + Math.sin((index + 1) / 20) * 1e-7),
      v: '0.01',
    }));
    const result = computePriceProjection(rows, { timeframe: '4h' });
    expect(result.status).toBe('ready');
    expect(Object.values(result.paths).flat().every((point) => (
      Number.isFinite(point.time)
      && (Number.isFinite(point.value) || !('value' in point))
    ))).toBe(true);
    expect(Object.values(result.paths).flat()
      .filter((point) => Number.isFinite(point.value))
      .every((point) => Number.isFinite(point.value))).toBe(true);
  }, 60_000);

  it('keeps the volatility baseline as an explicit month-auction candidate', () => {
    const result = computePriceProjection(syntheticCandles(4_000), {
      timeframe: '4h',
      modelId: PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE,
    });
    expect(result.status).toBe('ready');
    expect(result.model.id).toBe(PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE);
    expect(result.pathModel).toBe('month-auction-cone');
    expect(result.originMode).toBe('month-open-live');
    expect(result.months.at(-1).originTime).toBeLessThan(result.months.at(-1).monthStart);
  }, 60_000);

  it('finds the shortest interval that holds a target occupancy mass', () => {
    const { highestDensitySpan } = __PRICE_PROJECTION_INTERNALS;
    expect(highestDensitySpan([1, 8, 1], 10, 0.5)).toEqual({ lo: 1, hi: 1 });
    expect(highestDensitySpan([2, 2, 2, 2], 8, 0.5)).toEqual({ lo: 0, hi: 1 });
  });

  it('mixes analogue occupancy toward recency climatology with a normalized weight', () => {
    const { mixOccupancySamples, buildReturnOccupancy } = __PRICE_PROJECTION_INTERNALS;
    const analogue = [{ weight: 2, ret: 1 }];
    const climate = [{ weight: 8, ret: -1 }];
    const mixed = mixOccupancySamples(analogue, climate, 0.5);
    const left = mixed.find((sample) => sample.ret === 1);
    const right = mixed.find((sample) => sample.ret === -1);
    expect(left.weight).toBeCloseTo(0.5, 10);
    expect(right.weight).toBeCloseTo(0.5, 10);
    expect(mixOccupancySamples(analogue, climate, 1).every((sample) => sample.ret === 1)).toBe(true);
    expect(mixOccupancySamples(analogue, climate, 0).every((sample) => sample.ret === -1)).toBe(true);

    const scaleAt = () => 1;
    const up = [{ weight: 1, path: [1, 1, 1] }];
    const down = [{ weight: 1, path: [-1, -1, -1] }];
    const peaked = buildReturnOccupancy(up, scaleAt, 3, { climateItems: down, analogueMix: 1 });
    const prior = buildReturnOccupancy(up, scaleAt, 3, { climateItems: down, analogueMix: 0 });
    const blended = buildReturnOccupancy(up, scaleAt, 3, { climateItems: down, analogueMix: 0.5 });
    expect(peaked.slices.at(-1).mode).toBeGreaterThan(0);
    expect(prior.slices.at(-1).mode).toBeLessThan(0);
    expect(blended.slices.at(-1).bins.length).toBeGreaterThan(1);
    expect(blended.slices.at(-1).bins.reduce((sum, bin) => sum + bin.mass, 0)).toBeCloseTo(1, 8);
  });

  it('collects one month-open origin per UTC month seam', () => {
    const { collectMonthOpenIndexes, normalizeCandles } = __PRICE_PROJECTION_INTERNALS;
    const rows = normalizeCandles(syntheticCandles(400, {
      start: Date.UTC(2023, 0, 1) / 1000,
      interval: 4 * 60 * 60,
    })).rows;
    const opens = collectMonthOpenIndexes(rows, 0, rows.length - 2);
    expect(opens.length).toBeGreaterThan(0);
    for (const index of opens) {
      expect(utcMonthStartUnix(rows[index + 1].time)).toBe(utcMonthEndUnix(rows[index].time));
    }
  });

  it('retains the legacy analogue as an explicit reproducibility candidate', () => {
    const result = computePriceProjection(syntheticCandles(4_000), {
      timeframe: '4h',
      modelId: PRICE_PROJECTION_MODELS.LEGACY_ANALOGUE,
    });
    expect(result.status).toBe('ready');
    expect(result.model.id).toBe(PRICE_PROJECTION_MODELS.LEGACY_ANALOGUE);
    expect(result.analogCount).toBe(PRICE_PROJECTION_DEFAULTS.analogCount);
  }, 60_000);

  it('scales return bands with the current volatility regime', () => {
    const low = computePriceProjection(syntheticCandles(4_000, { volatility: 1 }), {
      timeframe: '4h',
    });
    const high = computePriceProjection(syntheticCandles(4_000, { volatility: 2 }), {
      timeframe: '4h',
    });
    expect(low.status).toBe('ready');
    expect(high.status).toBe('ready');
    const terminalWidth = (result) => Math.log(
      result.paths.q90.at(-1).value / result.paths.q10.at(-1).value,
    );
    expect(terminalWidth(high) / terminalWidth(low)).toBeGreaterThan(1.4);
    expect(terminalWidth(high) / terminalWidth(low)).toBeLessThan(2.6);
  }, 60_000);

  it('widens the live cone after a high-vol, high-volume previous month', () => {
    const calm = computePriceProjection(
      candlesWithPreviousMonth({ prevVolatility: 0.6, prevVolume: 40 }),
      { timeframe: '4h' },
    );
    const wild = computePriceProjection(
      candlesWithPreviousMonth({ prevVolatility: 3.2, prevVolume: 420 }),
      { timeframe: '4h' },
    );
    expect(calm.status).toBe('ready');
    expect(wild.status).toBe('ready');
    const width = (result) => Math.log(
      result.months.at(-1).paths.q90.at(-1).value
      / result.months.at(-1).paths.q10.at(-1).value,
    );
    expect(width(wild)).toBeGreaterThan(width(calm) * 1.08);
    expect(wild.months.at(-1).conditioning.volumeMult)
      .toBeGreaterThan(calm.months.at(-1).conditioning.volumeMult);
    expect(wild.volModel).toBe('har-month-conditioned-rv');
  }, 60_000);

  it('tilts the live cone toward the previous month signed-vol side', () => {
    const dump = computePriceProjection(
      candlesWithPreviousMonth({ prevVolatility: 2.4, prevDrift: -0.0035 }),
      { timeframe: '4h' },
    );
    const rally = computePriceProjection(
      candlesWithPreviousMonth({ prevVolatility: 2.4, prevDrift: 0.0035 }),
      { timeframe: '4h' },
    );
    expect(dump.status).toBe('ready');
    expect(rally.status).toBe('ready');
    const liveDump = dump.months.at(-1);
    const liveRally = rally.months.at(-1);
    const left = (month) => -Math.log(month.paths.q10.at(-1).value / month.anchorPrice);
    const right = (month) => Math.log(month.paths.q90.at(-1).value / month.anchorPrice);
    expect(liveDump.conditioning.leftMult).toBeGreaterThan(liveDump.conditioning.rightMult);
    expect(liveRally.conditioning.rightMult).toBeGreaterThan(liveRally.conditioning.leftMult);
    const baselineDump = computePriceProjection(
      candlesWithPreviousMonth({ prevVolatility: 2.4, prevDrift: -0.0035 }),
      { timeframe: '4h', modelId: PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE },
    );
    const baselineRally = computePriceProjection(
      candlesWithPreviousMonth({ prevVolatility: 2.4, prevDrift: 0.0035 }),
      { timeframe: '4h', modelId: PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE },
    );
    expect(left(baselineDump.months.at(-1)) / right(baselineDump.months.at(-1)))
      .toBeGreaterThan(left(baselineRally.months.at(-1)) / right(baselineRally.months.at(-1)));
  }, 60_000);

  it('builds previous-month state only from bars at or before the origin', () => {
    const { calendarMonthState, normalizeCandles } = __PRICE_PROJECTION_INTERNALS;
    const rows = normalizeCandles(candlesWithPreviousMonth()).rows;
    const last = rows.length - 1;
    const liveStart = utcMonthStartUnix(rows[last].time);
    const origin = __PRICE_PROJECTION_INTERNALS.lastIndexBefore(rows, liveStart);
    const before = calendarMonthState(rows, origin);
    expect(before).toBeTruthy();
    const mutated = rows.map((row, index) => (
      index > origin
        ? { ...row, close: row.close * 3, volume: row.volume * 9 }
        : row
    ));
    expect(calendarMonthState(mutated, origin)).toEqual(before);
  });

  it('builds month-auction state without future bars and shrinks the median to zero when ESS is thin', () => {
    const { buildMonthAuctionStates, auctionFeatureVector, normalizeCandles } = __PRICE_PROJECTION_INTERNALS;
    const rows = normalizeCandles(candlesWithPreviousMonth()).rows;
    const last = rows.length - 1;
    const liveStart = utcMonthStartUnix(rows[last].time);
    const origin = __PRICE_PROJECTION_INTERNALS.lastIndexBefore(rows, liveStart);
    const states = buildMonthAuctionStates(rows);
    expect(auctionFeatureVector(states[origin])).toBeTruthy();
    const mutated = rows.map((row, index) => (
      index > origin
        ? { ...row, close: row.close * 2.5, high: row.high * 2.5, volume: row.volume * 8 }
        : row
    ));
    const mutatedStates = buildMonthAuctionStates(mutated);
    expect(auctionFeatureVector(mutatedStates[origin]))
      .toEqual(auctionFeatureVector(states[origin]));
    const result = computePriceProjection(syntheticCandles(1_500), { timeframe: '4h' });
    expect(result.status).toBe('ready');
    for (const month of result.months) {
      expect(month.medianShrink).toBeGreaterThanOrEqual(0);
      expect(month.medianShrink).toBeLessThanOrEqual(1);
      if (month.conditioning?.clusterEffectiveSampleSize) {
        expect(Math.abs(month.medianZ)).toBeLessThan(1);
      }
    }
  });

  it('keeps early-horizon 50% width as a real quantile fan, not a flat origin line', () => {
    const result = computePriceProjection(syntheticCandles(3_000), { timeframe: '4h' });
    expect(result.status).toBe('ready');
    for (const month of result.months) {
      const origin = month.anchorPrice;
      const week = Math.min(month.paths.q25.length - 1, 42);
      if (week < 2) continue;
      const widthAt = (index) => Math.log(
        month.paths.q75[index].value / month.paths.q25[index].value,
      );
      const terminal = widthAt(month.paths.q25.length - 1);
      expect(terminal).toBeGreaterThan(0);
      expect(widthAt(week)).toBeGreaterThan(terminal * 0.08);
      expect(widthAt(week)).toBeGreaterThan(0);
      const bothFlat = Math.abs(Math.log(month.paths.q25[week].value / origin)) < 1e-6
        && Math.abs(Math.log(month.paths.q75[week].value / origin)) < 1e-6;
      expect(bothFlat).toBe(false);
    }
  }, 60_000);

  it('keeps intermediate path bands no wider or more one-sided than the terminal', () => {
    const result = computePriceProjection(syntheticCandles(3_000), {
      timeframe: '4h',
    });
    expect(result.status).toBe('ready');
    const current = result.months.at(-1);
    const logWidth = (index) => Math.log(
      current.paths.q90[index].value / current.paths.q10[index].value,
    );
    const left = (index) => Math.max(0, Math.log(current.paths.q50[index].value / current.paths.q10[index].value));
    const right = (index) => Math.max(0, Math.log(current.paths.q90[index].value / current.paths.q50[index].value));
    const term = current.paths.q50.length - 1;
    const terminal = logWidth(term);
    const termLeft = left(term);
    const termRight = right(term);
    expect(terminal).toBeGreaterThan(0);
    for (let index = 1; index < current.paths.q50.length; index += 1) {
      expect(logWidth(index)).toBeLessThanOrEqual(terminal * 1.02 + 1e-9);
      expect(left(index)).toBeLessThanOrEqual(termLeft * 1.02 + 1e-9);
      expect(right(index)).toBeLessThanOrEqual(termRight * 1.02 + 1e-9);
    }
  }, 60_000);

  it('proportionally nests one-sided mid-path flares without flat plateaus', () => {
    const { nestPathWidthsToTerminal } = __PRICE_PROJECTION_INTERNALS;
    const nested = nestPathWidthsToTerminal({
      q10: [-0.01, -0.50, -0.03],
      q25: [-0.005, -0.20, -0.01],
      q50: [0, 0, 0],
      q75: [0.005, 0.40, 0.01],
      q90: [0.01, 0.90, 0.03],
    }, 3, 0);
    // Peak mid step scales to terminal half; terminal half is preserved.
    expect(nested.q10[1]).toBeCloseTo(-0.03, 12);
    expect(nested.q90[1]).toBeCloseTo(0.03, 12);
    expect(nested.q10[2]).toBeCloseTo(-0.03, 12);
    expect(nested.q90[2]).toBeCloseTo(0.03, 12);
    expect(nested.q10[0]).toBeCloseTo(-0.01 * (0.03 / 0.50), 12);
    expect(nested.q90[0]).toBeCloseTo(0.01 * (0.03 / 0.90), 12);
    expect(nested.q25[1]).toBeCloseTo(-0.01, 12);
    expect(nested.q75[1]).toBeCloseTo(0.01, 12);
    // Not a flat plateau: intermediate left halves still differ.
    expect(Math.abs(nested.q10[0] - nested.q10[1])).toBeGreaterThan(1e-6);
    expect(nested.q90[1] - nested.q10[1]).toBeLessThanOrEqual(nested.q90[2] - nested.q10[2] + 1e-12);
  });

  it('does not flatten overshooting steps to a constant terminal absolute', () => {
    const { nestPathWidthsToTerminal } = __PRICE_PROJECTION_INTERNALS;
    // Gradual then huge spike then settle — absolute clamp would flat-line the spike
    // and neighbors at -0.05; proportional scale keeps relative motion.
    const nested = nestPathWidthsToTerminal({
      q10: [-0.01, -0.02, -0.20, -0.15, -0.05],
      q25: [-0.005, -0.01, -0.08, -0.06, -0.02],
      q50: [0, 0, 0, 0, 0],
      q75: [0.005, 0.01, 0.08, 0.06, 0.02],
      q90: [0.01, 0.02, 0.25, 0.12, 0.05],
    }, 5, 0);
    const lefts = nested.q10.map((value) => -value);
    // Strictly increasing envelope toward the peak after scale is not required,
    // but consecutive values must not all equal the terminal half.
    const uniqueLeft = new Set(lefts.map((value) => value.toFixed(8)));
    expect(uniqueLeft.size).toBeGreaterThan(2);
    expect(Math.max(...lefts)).toBeCloseTo(0.05, 12);
    expect(lefts[4]).toBeCloseTo(0.05, 12);
  });

  it('does not hard-cap applied scale factors outside a fixed band', () => {
    const { clampAppliedScaleFactor, intervalScaleFactor } = __PRICE_PROJECTION_INTERNALS;
    expect(clampAppliedScaleFactor(0.15)).toBeCloseTo(0.15, 12);
    expect(clampAppliedScaleFactor(3.5)).toBeCloseTo(3.5, 12);
    expect(clampAppliedScaleFactor(NaN)).toBe(1);
    expect(clampAppliedScaleFactor(-1)).toBe(1);
    // Degenerate half-width does not produce infinite λ.
    expect(intervalScaleFactor(0.5, 0, 0, 0)).toBe(0);
    expect(intervalScaleFactor(0.02, -0.01, 0.01, 0)).toBeCloseTo(2, 12);
  });

  it('matches hand-calculated population deviation and weighted empirical quantiles', () => {
    const stats = __PRICE_PROJECTION_INTERNALS.meanAndDeviation([1, 2, 3, 4], 0, 3);
    expect(stats.mean).toBe(2.5);
    expect(stats.deviation).toBeCloseTo(Math.sqrt(1.25), 12);
    expect(__PRICE_PROJECTION_INTERNALS.weightedQuantiles([
      { value: -1, weight: 1 },
      { value: 0, weight: 2 },
      { value: 3, weight: 1 },
    ], [0.25, 0.5, 0.9])).toEqual([-1, 0, 3]);
  });

  it('breaks concatenated month fans so Lightweight Charts cannot draw a vertical reset', () => {
    const { concatMonthPaths, isWhitespacePoint } = __PRICE_PROJECTION_INTERNALS;
    const monthA = {
      paths: {
        q10: [{ time: 100, value: 50 }, { time: 200, value: 20 }],
        q25: [{ time: 100, value: 80 }, { time: 200, value: 60 }],
        q50: [{ time: 100, value: 100 }, { time: 200, value: 100 }],
        q75: [{ time: 100, value: 120 }, { time: 200, value: 140 }],
        q90: [{ time: 100, value: 150 }, { time: 200, value: 200 }],
      },
    };
    const monthB = {
      paths: {
        q10: [{ time: 200, value: 90 }, { time: 300, value: 70 }],
        q25: [{ time: 200, value: 95 }, { time: 300, value: 85 }],
        q50: [{ time: 200, value: 100 }, { time: 300, value: 100 }],
        q75: [{ time: 200, value: 105 }, { time: 300, value: 115 }],
        q90: [{ time: 200, value: 110 }, { time: 300, value: 130 }],
      },
    };
    const joined = concatMonthPaths([monthA, monthB]);
    expect(joined.q90.filter(isWhitespacePoint)).toHaveLength(1);
    // Shared month-end / next-origin timestamp is popped so LC cannot draw a
    // vertical; historical 80% still contributes its earlier points.
    expect(joined.q90.filter((point) => Number.isFinite(point.value)).map((point) => point.value))
      .toEqual([150, 110, 130]);
    expect(joined.q25.some(isWhitespacePoint)).toBe(true);
    const inner = joined.q25.filter((point) => Number.isFinite(point.value));
    expect(inner[0]).toEqual({ time: 100, value: 80 });
    expect(inner.at(-1)).toEqual({ time: 300, value: 85 });
    expect(inner.some((point) => point.time === 200 && point.value === 20)).toBe(false);
    const breakAt = joined.q25.find(isWhitespacePoint);
    expect(breakAt.time).toBeGreaterThan(100);
    expect(breakAt.time).toBeLessThan(200);
  });

  it('keeps raw analogue widths when prequential residuals are too few to recalibrate', () => {
    const { applyPathCalibration } = __PRICE_PROJECTION_INTERNALS;
    const raw = {
      q10: [-0.10],
      q25: [-0.04],
      q50: [0],
      q75: [0.04],
      q90: [0.10],
    };
    const thin = applyPathCalibration(raw, {
      corrections50: [2.4],
      corrections80: [3.1],
      coverage50: 0.25,
      coverage80: 0.40,
      coverageSamples: 3,
      horizon: 1,
      pinMedian: 0,
    });
    expect(thin.factor50PreAci).toBeCloseTo(2.4, 12);
    expect(thin.factor80PreAci).toBeCloseTo(3.1, 12);
    expect(thin.factor50Drawn).toBe(1);
    expect(thin.factor80Drawn).toBe(1);
    expect(thin.quantiles.q10[0]).toBeCloseTo(-0.10, 12);
    expect(thin.quantiles.q90[0]).toBeCloseTo(0.10, 12);

    const enough = applyPathCalibration(raw, {
      corrections50: [2],
      corrections80: [2],
      coverage50: 0.50,
      coverage80: 0.80,
      coverageSamples: 12,
      horizon: 1,
      pinMedian: 0,
    });
    expect(enough.factor80Drawn).toBeCloseTo(2, 12);
    expect(enough.quantiles.q90[0]).toBeCloseTo(0.20, 12);
  });

  it('uses only the supplied profile months when pairing with monthly profiles', () => {
    const start = Date.UTC(2023, 0, 1) / 1000;
    const candles = syntheticCandles(4_000, { start, interval: 4 * 60 * 60 });
    const full = computePriceProjection(candles, { timeframe: '4h' });
    expect(full.status).toBe('ready');
    expect(full.monthCount).toBeGreaterThan(1);
    const lastMonth = full.months.at(-1);
    const subset = computePriceProjection(candles, {
      timeframe: '4h',
      profileMonths: [{
        monthStart: lastMonth.monthStart,
        monthEnd: lastMonth.monthEnd,
        startTime: lastMonth.monthStart,
        barCount: 20,
      }],
    });
    expect(subset.status).toBe('ready');
    expect(subset.monthCount).toBe(1);
    expect(subset.months[0].monthStart).toBe(lastMonth.monthStart);
    expect(subset.months[0].monthEnd).toBe(lastMonth.monthEnd);
  }, 60_000);

  it('keeps a profile month when the origin forecast exists but calibration is thin', () => {
    const start = Date.UTC(2025, 0, 1) / 1000;
    const candles = syntheticCandles(1_500, {
      start,
      interval: 4 * 60 * 60,
    });
    const result = computePriceProjection(candles, { timeframe: '4h' });
    expect(result.status).toBe('ready');
    const rows = __PRICE_PROJECTION_INTERNALS.normalizeCandles(candles).rows;
    const featureState = __PRICE_PROJECTION_INTERNALS.buildFeatureState(rows);
    const windows = __PRICE_PROJECTION_INTERNALS.listEligibleMonthWindows(rows);
    expect(windows.length).toBeGreaterThan(0);
    const emitted = new Set(result.months.map((month) => month.monthStart));
    for (const window of windows) {
      const originIndex = __PRICE_PROJECTION_INTERNALS.lastIndexBefore(rows, window.monthStart);
      if (originIndex < 32) continue;
      const resolved = __PRICE_PROJECTION_INTERNALS.resolveMonthHorizonBars(
        window.monthStart,
        window.monthEnd,
        '4h',
      );
      if (!resolved.ok) continue;
      const forecast = __PRICE_PROJECTION_INTERNALS.rawForecast(
        rows,
        featureState,
        originIndex,
        resolved.horizonBars,
        PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE,
        __PRICE_PROJECTION_INTERNALS.sourceHistoryLimits('4h', resolved.horizonDays),
      );
      if (!forecast) continue;
      expect(emitted.has(window.monthStart)).toBe(true);
    }
    expect(result.months.some((month) => month.calibration.originCount < 4)).toBe(true);
    expect(result.months.filter((month) => month.calibration.originCount < 4)
      .every((month) => month.calibration.factor50Drawn === 1)).toBe(true);
  }, 60_000);

  it('blends previous-month width with live month-to-date at most half elapsed', () => {
    const { blendMonthConditioning } = __PRICE_PROJECTION_INTERNALS;
    const prior = {
      leftMult: 1.20,
      rightMult: 0.85,
      volumeMult: 1.35,
      monthRv: 0.002,
      state: { barCount: 180 },
    };
    const mtd = {
      leftMult: 0.90,
      rightMult: 1.10,
      volumeMult: 0.80,
      monthRv: 0.0004,
      state: { barCount: 40 },
    };
    const blended = blendMonthConditioning(prior, mtd, 0.5);
    expect(blended.source).toBe('previous-month+mtd');
    expect(blended.mtdWeight).toBeCloseTo(0.25, 12);
    expect(blended.volumeMult).toBeCloseTo(
      Math.exp(0.75 * Math.log(1.35) + 0.25 * Math.log(0.80)),
      12,
    );
    expect(blended.monthRv).toBeCloseTo(0.75 * 0.002 + 0.25 * 0.0004, 12);
    expect(blendMonthConditioning(prior, { ...mtd, state: null, monthRv: NaN }, 0.8).source)
      .toBe('previous-month');
  });

  it('keeps the live month frozen at month open when a new close arrives', () => {
    const start = Date.UTC(2023, 0, 1) / 1000;
    const interval = 4 * 60 * 60;
    let count = 4_000;
    const lastTime = () => start + (count - 1) * interval;
    if (utcMonthStartUnix(lastTime() + interval) !== utcMonthStartUnix(lastTime())) {
      count -= 6;
    }
    const candles = syntheticCandles(count, { start, interval });
    const first = computePriceProjection(candles, { timeframe: '4h' });
    expect(first.status).toBe('ready');
    const live = first.months.at(-1);
    expect(live.originMode).toBe('month-open-live');
    expect(live.anchorTime).toBe(live.monthStart);
    expect(live.paths.q50[0].time).toBe(live.monthStart);
    expect(live.originTime).toBeLessThan(live.monthStart);
    expect(live.lastProjectionTime).toBe(live.monthEnd);
    expect(live.horizonBars).toBe((live.monthEnd - live.monthStart) / interval);
    expect(live.horizonDays).toBeCloseTo((live.monthEnd - live.monthStart) / (24 * 60 * 60), 10);
    expect(live.occupancy?.slices?.length).toBeGreaterThan(0);
    expect(live.remainingPath?.length).toBeGreaterThanOrEqual(2);
    expect(live.remainingPath[0].time).toBeGreaterThanOrEqual(live.monthStart);
    expect(live.remainingPath[0].time).toBeLessThan(live.monthEnd);
    expect(live.remainingPath.at(-1).time).toBe(live.monthEnd);
    expect(live.remainingPath[0].value).toBeGreaterThan(0);

    const grown = candles.map((row) => ({ ...row }));
    const last = grown.at(-1);
    const nextTime = Number(last.t) + interval;
    expect(utcMonthStartUnix(nextTime)).toBe(utcMonthStartUnix(Number(last.t)));
    grown.push({
      ...last,
      t: nextTime,
      o: last.c,
      c: String(Number(last.c) * 1.001),
      h: String(Math.max(Number(last.h), Number(last.c) * 1.001)),
      l: String(Math.min(Number(last.l), Number(last.c) * 1.001)),
    });
    const second = computePriceProjection(grown, { timeframe: '4h' });
    expect(second.status).toBe('ready');
    const live2 = second.months.at(-1);
    expect(live2.monthStart).toBe(live.monthStart);
    expect(live2.originTime).toBe(live.originTime);
    expect(live2.horizonBars).toBe(live.horizonBars);
    expect(live2.anchorPrice).toBe(live.anchorPrice);
    expect(live2.anchorTime).toBe(live.anchorTime);

    const historical = first.months[0];
    const again = second.months.find((month) => month.monthStart === historical.monthStart);
    expect(again).toBeTruthy();
    expect(again.originMode).toBe('month-open');
    expect(again.paths.q25).toEqual(historical.paths.q25);
    expect(again.paths.q75).toEqual(historical.paths.q75);
    expect(again.anchorPrice).toBe(historical.anchorPrice);
  }, 60_000);

  it('does not let later candles change a historical month path', () => {
    const start = Date.UTC(2023, 0, 1) / 1000;
    const original = syntheticCandles(4_000, { start, interval: 4 * 60 * 60 });
    const first = computePriceProjection(original, { timeframe: '4h' });
    expect(first.status).toBe('ready');
    expect(first.monthCount).toBeGreaterThan(1);
    const historical = first.months[0];
    const mutated = original.map((row) => ({ ...row }));
    for (let index = 0; index < mutated.length; index += 1) {
      if (Number(mutated[index].t) < historical.monthStart) continue;
      const factor = 1.25;
      mutated[index] = {
        ...mutated[index],
        o: String(Number(mutated[index].o) * factor),
        h: String(Number(mutated[index].h) * factor),
        l: String(Number(mutated[index].l) * factor),
        c: String(Number(mutated[index].c) * factor),
      };
    }
    const second = computePriceProjection(mutated, { timeframe: '4h' });
    expect(second.status).toBe('ready');
    const again = second.months.find((month) => month.monthStart === historical.monthStart);
    expect(again).toBeTruthy();
    expect(again.paths.q25).toEqual(historical.paths.q25);
    expect(again.paths.q75).toEqual(historical.paths.q75);
    expect(again.anchorPrice).toBe(historical.anchorPrice);
  }, 60_000);

  it('does not let candles after a historical origin alter its forecast', () => {
    const original = syntheticCandles(2_000);
    const changedFuture = original.map((row) => ({ ...row }));
    for (let index = 801; index < changedFuture.length; index += 1) {
      const factor = 1 + (index - 800) * 0.01;
      changedFuture[index].o = String(Number(changedFuture[index].o) * factor);
      changedFuture[index].h = String(Number(changedFuture[index].h) * factor);
      changedFuture[index].l = String(Number(changedFuture[index].l) * factor);
      changedFuture[index].c = String(Number(changedFuture[index].c) * factor);
    }
    const rowsA = __PRICE_PROJECTION_INTERNALS.normalizeCandles(original).rows;
    const rowsB = __PRICE_PROJECTION_INTERNALS.normalizeCandles(changedFuture).rows;
    const forecastA = __PRICE_PROJECTION_INTERNALS.rawForecast(
      rowsA,
      __PRICE_PROJECTION_INTERNALS.buildFeatureState(rowsA),
      800,
      30,
      PRICE_PROJECTION_MODELS.VOLATILITY_ANALOGUE,
    );
    const forecastB = __PRICE_PROJECTION_INTERNALS.rawForecast(
      rowsB,
      __PRICE_PROJECTION_INTERNALS.buildFeatureState(rowsB),
      800,
      30,
      PRICE_PROJECTION_MODELS.VOLATILITY_ANALOGUE,
    );
    expect(forecastA).toEqual(forecastB);
  });
});
