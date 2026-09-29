#!/usr/bin/env node

/**
 * Frozen walk-forward validation for price projection.
 *
 * Residual scoring is identical to live chart diagnostics: the shared
 * scorePrequentialForecasts path accumulates per-step multiplicative interval
 * scale factors (λ) and evaluates terminal coverage prequentially. ACI-lite
 * factor inflate/deflate remains a live rendering step (applyPathCalibration)
 * and is not re-scored here so promotion gates match the UI BT50/BT80 diagnostics.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  PRICE_PROJECTION_MODELS,
  resolveHorizonBars,
  resolveMonthHorizonBars,
  sourceHistoryLimits,
  minPrequentialScoresForHorizon,
  __PRICE_PROJECTION_INTERNALS,
} from '../web/src/chart/price-projection.js';

const {
  normalizeCandles,
  trailingCleanSegment,
  buildFeatureState,
  rawForecast,
  scorePrequentialForecasts,
  listEligibleMonthWindows,
  lastIndexBefore,
} = __PRICE_PROJECTION_INTERNALS;

const MODEL_ORDER = [
  PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE,
  PRICE_PROJECTION_MODELS.VOLATILITY_ANALOGUE,
  PRICE_PROJECTION_MODELS.LEGACY_ANALOGUE,
];

function parseArgs(argv) {
  const result = {
    snapshot: 'data/candle-snapshot.json.gz',
    output: 'price-projection-validation.json',
    markdown: 'price-projection-validation.md',
    // Calendar-day horizons; resolved to exact bars per timeframe.
    horizons: [5, 10, 20],
    maxSeries: Infinity,
    maxOriginsPerPhase: 30,
    coins: null,
    originMode: 'day-horizon',
    outputExplicit: false,
    markdownExplicit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--snapshot') result.snapshot = value, index += 1;
    else if (arg === '--output') result.output = value, result.outputExplicit = true, index += 1;
    else if (arg === '--markdown') result.markdown = value, result.markdownExplicit = true, index += 1;
    else if (arg === '--horizons') result.horizons = value.split(',').map(Number), index += 1;
    else if (arg === '--max-series') result.maxSeries = Number(value), index += 1;
    else if (arg === '--max-origins') result.maxOriginsPerPhase = Number(value), index += 1;
    else if (arg === '--coins') result.coins = new Set(value.split(',').map((item) => item.trim())), index += 1;
    else if (arg === '--origin-mode') result.originMode = value, index += 1;
    else if (arg === '--help') {
      console.log('Usage: node scripts/price_projection_validation.mjs [--snapshot FILE] [--output FILE] [--markdown FILE] [--horizons 5,10,20] [--origin-mode day-horizon|month-open] [--coins BTC,ETH] [--max-series N] [--max-origins N]');
      process.exit(0);
    }
  }
  if (result.originMode === 'month-open') {
    if (!result.outputExplicit) result.output = 'docs/PRICE_PROJECTION_MONTH_OPEN_VALIDATION.json';
    if (!result.markdownExplicit) result.markdown = 'docs/PRICE_PROJECTION_MONTH_OPEN_VALIDATION.md';
  }
  return result;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

/**
 * Expand snapshot series to row candles.
 * Supports v1 `{ candles: [...] }` and v2 columnar `{ t,T,o,h,l,c,v }`.
 */
function expandSeriesCandles(source) {
  if (Array.isArray(source?.candles)) return source.candles;
  const t = source?.t;
  if (!Array.isArray(t) || t.length === 0) return [];
  const T = source.T || [];
  const o = source.o || [];
  const h = source.h || [];
  const l = source.l || [];
  const c = source.c || [];
  const v = source.v || [];
  const rows = new Array(t.length);
  for (let i = 0; i < t.length; i += 1) {
    rows[i] = {
      t: t[i],
      T: T[i],
      o: o[i],
      h: h[i],
      l: l[i],
      c: c[i],
      v: v[i],
    };
  }
  return rows;
}

function phaseOrigins(rows, horizon, maxPerPhase) {
  const first = 32 + 32 + horizon + 240;
  const last = rows.length - horizon - 1;
  const phases = { development: [], validation: [], test: [] };
  for (let origin = first; origin <= last; origin += horizon) {
    const ratio = origin / rows.length;
    const phase = ratio < 0.60 ? 'development' : ratio < 0.80 ? 'validation' : 'test';
    phases[phase].push(origin);
  }
  for (const phase of Object.keys(phases)) {
    phases[phase] = phases[phase].slice(-maxPerPhase);
  }
  return phases;
}

/**
 * Evaluate one series with the same residual scorer the live chart uses.
 * Residuals carry prequentially across development → validation → test within
 * a series so coverage corrections are never fit on the evaluated origin.
 */
function evaluateSeries(
  rows,
  timeframe,
  horizonBars,
  horizonDays,
  modelId,
  maxOriginsPerPhase,
  allowedPhases = new Set(['development', 'validation', 'test']),
) {
  const featureState = buildFeatureState(rows);
  const history = sourceHistoryLimits(timeframe, horizonDays);
  const minPrequential = history.minPrequentialScores
    ?? minPrequentialScoresForHorizon(horizonDays);
  const phases = phaseOrigins(rows, horizonBars, maxOriginsPerPhase);
  const ordered = Object.entries(phases)
    .filter(([phase]) => allowedPhases.has(phase))
    .flatMap(([phase, origins]) => origins.map((origin) => ({ phase, origin })))
    .sort((left, right) => left.origin - right.origin);

  const sequence = [];
  const meta = [];
  for (const { phase, origin } of ordered) {
    const forecast = rawForecast(rows, featureState, origin, horizonBars, modelId, history);
    if (!forecast) continue;
    const actual = [];
    for (let step = 1; step <= horizonBars; step += 1) {
      actual.push(Math.log(rows[origin + step].close / rows[origin].close));
    }
    const baselineForecast = modelId === PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE
      ? forecast
      : rawForecast(
        rows,
        featureState,
        origin,
        horizonBars,
        PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE,
        history,
      );
    sequence.push({
      actual,
      quantiles: forecast.quantiles,
      analogueUpFrequency: forecast.analogueUpFrequency,
      baselineQuantiles: baselineForecast?.quantiles || null,
    });
    meta.push({ phase, origin });
  }

  const scored = scorePrequentialForecasts(sequence, {
    horizon: horizonBars,
    minPrequential,
  });

  return scored.rows.map((row, index) => ({
    phase: meta[index].phase,
    origin: meta[index].origin,
    horizonDays: meta[index].horizonDays || null,
    horizonBars: meta[index].horizonBars || null,
    absoluteError: row.absoluteError,
    zeroError: row.zeroError,
    pinball: row.pinball,
    brier: row.brier,
    climatologyBrier: row.climatologyBrier,
    covered50: row.covered50,
    covered80: row.covered80,
    width50: row.width50,
    width80: row.width80,
    intervalScore50: row.intervalScore50,
    intervalScore80: row.intervalScore80,
  }));
}

function monthOpenPhaseOrigins(rows, timeframe, maxPerPhase) {
  const windows = listEligibleMonthWindows(rows, { keepMonths: 48, minBars: 5 });
  const items = [];
  for (const window of windows) {
    const origin = lastIndexBefore(rows, window.monthStart);
    const resolved = resolveMonthHorizonBars(window.monthStart, window.monthEnd, timeframe);
    if (!resolved.ok || origin < 64) continue;
    if (origin + resolved.horizonBars >= rows.length) continue;
    items.push({
      origin,
      horizonBars: resolved.horizonBars,
      horizonDays: resolved.horizonDays,
    });
  }
  const phases = { development: [], validation: [], test: [] };
  for (const item of items) {
    const ratio = item.origin / Math.max(1, rows.length);
    const phase = ratio < 0.60 ? 'development' : ratio < 0.80 ? 'validation' : 'test';
    phases[phase].push(item);
  }
  for (const phase of Object.keys(phases)) {
    phases[phase] = phases[phase].slice(-maxPerPhase);
  }
  return phases;
}

function evaluateMonthOpenSeries(
  rows,
  timeframe,
  modelId,
  maxOriginsPerPhase,
  allowedPhases = new Set(['development', 'validation', 'test']),
) {
  const featureState = buildFeatureState(rows);
  const phases = monthOpenPhaseOrigins(rows, timeframe, maxOriginsPerPhase);
  const ordered = Object.entries(phases)
    .filter(([phase]) => allowedPhases.has(phase))
    .flatMap(([phase, origins]) => origins.map((item) => ({ phase, ...item })))
    .sort((left, right) => left.origin - right.origin);

  const prepared = [];
  for (const { phase, origin, horizonBars, horizonDays } of ordered) {
    const history = sourceHistoryLimits(timeframe, horizonDays);
    const forecast = rawForecast(rows, featureState, origin, horizonBars, modelId, history);
    if (!forecast) continue;
    const actual = [];
    for (let step = 1; step <= horizonBars; step += 1) {
      actual.push(Math.log(rows[origin + step].close / rows[origin].close));
    }
    const baselineForecast = modelId === PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE
      ? forecast
      : rawForecast(
        rows,
        featureState,
        origin,
        horizonBars,
        PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE,
        history,
      );
    prepared.push({
      phase,
      origin,
      horizonDays,
      horizonBars,
      minPrequential: history.minPrequentialScores
        ?? minPrequentialScoresForHorizon(horizonDays),
      item: {
        actual,
        quantiles: forecast.quantiles,
        analogueUpFrequency: forecast.analogueUpFrequency,
        baselineQuantiles: baselineForecast?.quantiles || null,
      },
    });
  }
  const byHorizon = new Map();
  for (const row of prepared) {
    const bucket = byHorizon.get(row.horizonBars) || [];
    bucket.push(row);
    byHorizon.set(row.horizonBars, bucket);
  }
  const scoredRows = [];
  for (const bucket of byHorizon.values()) {
    const scored = scorePrequentialForecasts(
      bucket.map((row) => row.item),
      { horizon: bucket[0].horizonBars, minPrequential: bucket[0].minPrequential },
    );
    scored.rows.forEach((row, index) => {
      scoredRows.push({
        phase: bucket[index].phase,
        origin: bucket[index].origin,
        horizonDays: bucket[index].horizonDays,
        horizonBars: bucket[index].horizonBars,
        absoluteError: row.absoluteError,
        zeroError: row.zeroError,
        pinball: row.pinball,
        brier: row.brier,
        climatologyBrier: row.climatologyBrier,
        covered50: row.covered50,
        covered80: row.covered80,
        width50: row.width50,
        width80: row.width80,
        intervalScore50: row.intervalScore50,
        intervalScore80: row.intervalScore80,
      });
    });
  }
  return scoredRows.sort((left, right) => left.origin - right.origin);
}

function summarize(rows) {
  return {
    samples: rows.length,
    meanPinballLoss: average(rows.map((row) => row.pinball)),
    meanAbsoluteLogError: average(rows.map((row) => row.absoluteError)),
    zeroReturnMeanAbsoluteLogError: average(rows.map((row) => row.zeroError)),
    brierScore: average(rows.map((row) => row.brier)),
    climatologyBrierScore: average(rows.map((row) => row.climatologyBrier)),
    coverage50: average(rows.map((row) => row.covered50)),
    coverage80: average(rows.map((row) => row.covered80)),
    meanInterval50Width: average(rows.map((row) => row.width50)),
    meanInterval80Width: average(rows.map((row) => row.width80)),
    meanInterval50Score: average(rows.map((row) => row.intervalScore50)),
    meanInterval80Score: average(rows.map((row) => row.intervalScore80)),
  };
}

function promotionDecision(selected, testSummaries, subgroupRows) {
  const result = testSummaries[selected];
  const baseline = testSummaries[PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE];
  const subgroupFailures = subgroupRows
    .filter((group) => group.modelId === selected && group.phase === 'test' && group.summary.samples >= 40)
    .filter((group) => group.summary.coverage50 < 0.40 || group.summary.coverage80 < 0.70)
    .map((group) => group.group);
  const selectedIsBaseline = selected === PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE;
  const gates = {
    // Identity for baseline (median pinned at 0 / model is the baseline).
    pinballNoWorseThanBaseline: selectedIsBaseline
      ? true
      : result.meanPinballLoss <= baseline.meanPinballLoss,
    maeNoWorseThanZero: selectedIsBaseline
      ? true
      : result.meanAbsoluteLogError <= result.zeroReturnMeanAbsoluteLogError,
    pinballGateVacuousForZeroMedianBaseline: selectedIsBaseline,
    maeGateVacuousForZeroMedianBaseline: selectedIsBaseline,
    brierNoWorseThanClimatology: result.brierScore <= result.climatologyBrierScore,
    pooledCoverage50WithinFivePoints: Math.abs(result.coverage50 - 0.50) <= 0.05,
    pooledCoverage80WithinFivePoints: Math.abs(result.coverage80 - 0.80) <= 0.05,
    noMaterialSubgroupUndercoverage: subgroupFailures.length === 0,
  };
  // Vacuous identity flags are documentation only — not required for promotion.
  const required = {
    pinballNoWorseThanBaseline: gates.pinballNoWorseThanBaseline,
    maeNoWorseThanZero: gates.maeNoWorseThanZero,
    brierNoWorseThanClimatology: gates.brierNoWorseThanClimatology,
    pooledCoverage50WithinFivePoints: gates.pooledCoverage50WithinFivePoints,
    pooledCoverage80WithinFivePoints: gates.pooledCoverage80WithinFivePoints,
    noMaterialSubgroupUndercoverage: gates.noMaterialSubgroupUndercoverage,
  };
  return {
    passed: Object.values(required).every(Boolean),
    gates,
    subgroupFailures,
    evidenceStatus: Object.values(required).every(Boolean) ? 'validated-frozen-test' : 'unvalidated',
    scoringPath: 'scorePrequentialForecasts-per-step-multiplicative-scale-pre-aci',
  };
}

function markdownReport(report) {
  const lines = [
    '# Price Projection Frozen Walk-Forward Validation',
    '',
    `Report ID: \`${report.reportId}\``,
    '',
    `Validation-selected candidate: \`${report.selection.selectedModel}\``,
    '',
    `Production research model: \`${report.selection.productionModel}\``,
    '',
    `Promotion: **${report.promotion.passed ? 'PASS' : 'FAIL'}** (${report.promotion.evidenceStatus})`,
    '',
    `Scoring path: \`${report.configuration.scoringPath}\` (same multiplicative interval scorer as live chart diagnostics; ACI-lite is chart-only factor adjust).`,
    '',
    '| Model | Validation pinball | Test pinball | Test MAE | Zero MAE | Brier | Climatology | C50 | C80 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const modelId of report.configuration.models) {
    const validation = report.summary.validation[modelId] || {};
    const test = report.summary.test[modelId] || {};
    const display = (value) => Number.isFinite(value) ? value.toFixed(6) : '—';
    lines.push(`| ${modelId} | ${display(validation.meanPinballLoss)} | ${display(test.meanPinballLoss)} | ${display(test.meanAbsoluteLogError)} | ${display(test.zeroReturnMeanAbsoluteLogError)} | ${display(test.brierScore)} | ${display(test.climatologyBrierScore)} | ${display(test.coverage50)} | ${display(test.coverage80)} |`);
  }
  lines.push('', '## Promotion gates', '');
  for (const [gate, passed] of Object.entries(report.promotion.gates)) {
    if (typeof passed === 'boolean') {
      lines.push(`- ${passed ? 'PASS' : 'FAIL'} — ${gate}`);
    }
  }
  if (report.promotion.gates.pinballGateVacuousForZeroMedianBaseline) {
    lines.push(
      '',
      'Note: for the zero-median production baseline, pinball-vs-baseline and MAE-vs-zero are identity checks (always true). Coverage and Brier remain the material gates.',
    );
  }
  lines.push('', 'The test period was evaluated once after model selection on the validation period. This report measures forecast behavior, not net trading profitability.');
  return `${lines.join('\n')}\n`;
}

const args = parseArgs(process.argv.slice(2));
const monthOpenMode = args.originMode === 'month-open';
const TRIAL_MODELS = monthOpenMode
  ? [PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE, PRICE_PROJECTION_MODELS.MONTH_OPEN_MAP]
  : MODEL_ORDER;
const snapshotPath = path.resolve(args.snapshot);
const raw = snapshotPath.endsWith('.gz')
  ? gunzipSync(fs.readFileSync(snapshotPath)).toString('utf8')
  : fs.readFileSync(snapshotPath, 'utf8');
const documents = raw.trim().split('\n').map((line) => JSON.parse(line));
const header = documents[0];
const eligibleDocuments = documents.slice(1)
  .filter((source) => !args.coins || args.coins.has(source.coin));
const series = eligibleDocuments.slice(0, Number.isFinite(args.maxSeries) ? args.maxSeries : undefined);
const observations = [];
const subgroupRows = [];
const preparedSeries = [];
let evaluatedSeries = 0;

for (const source of series) {
  const candles = expandSeriesCandles(source);
  const closed = candles.filter((candle) => Number(candle.T || candle.t || 0) <= Number(header.savedAtMs));
  const normalized = normalizeCandles(closed);
  // Per-horizon structural minima are applied inside evaluateSeries via sourceHistoryLimits.
  const history = sourceHistoryLimits(source.interval, 5);
  const clean = trailingCleanSegment(normalized.rows, source.interval);
  if (normalized.reason || clean.rows.length < history.minBars) continue;
  normalized.rows = clean.rows;
  evaluatedSeries += 1;
  preparedSeries.push({ coin: source.coin, timeframe: source.interval, rows: normalized.rows });
  if (monthOpenMode) {
    for (const modelId of TRIAL_MODELS) {
      const result = evaluateMonthOpenSeries(
        normalized.rows,
        source.interval,
        modelId,
        args.maxOriginsPerPhase,
        new Set(['development', 'validation']),
      );
      for (const row of result) {
        observations.push({
          ...row,
          modelId,
          coin: source.coin,
          timeframe: source.interval,
          horizon: row.horizonDays,
          horizonDays: row.horizonDays,
          horizonBars: row.horizonBars,
        });
      }
      const grouped = result.filter((row) => row.phase === 'validation');
      if (grouped.length) subgroupRows.push({
        group: `${source.interval}:month-open`,
        modelId,
        phase: 'validation',
        rows: grouped,
      });
    }
    continue;
  }
  for (const horizonDays of args.horizons) {
    const resolved = resolveHorizonBars(horizonDays, source.interval);
    if (!resolved.ok) continue;
    const horizonBars = resolved.horizonBars;
    for (const modelId of TRIAL_MODELS) {
      const result = evaluateSeries(
        normalized.rows,
        source.interval,
        horizonBars,
        horizonDays,
        modelId,
        args.maxOriginsPerPhase,
        new Set(['development', 'validation']),
      );
      for (const row of result) {
        observations.push({
          ...row,
          modelId,
          coin: source.coin,
          timeframe: source.interval,
          horizon: horizonDays,
          horizonDays,
          horizonBars,
        });
      }
      for (const phase of ['validation']) {
        const grouped = result.filter((row) => row.phase === phase);
        if (grouped.length) subgroupRows.push({
          group: `${source.interval}:${horizonDays}d`,
          modelId,
          phase,
          rows: grouped,
        });
      }
    }
  }
}

const summary = { validation: {}, test: {} };
for (const modelId of TRIAL_MODELS) {
  summary.validation[modelId] = summarize(
    observations.filter((row) => row.phase === 'validation' && row.modelId === modelId),
  );
}
const validationLosses = TRIAL_MODELS
  .map((modelId) => summary.validation[modelId].meanPinballLoss)
  .filter(Number.isFinite);
if (validationLosses.length !== TRIAL_MODELS.length) {
  throw new Error('Insufficient validation observations for every declared model');
}
const minimumValidationLoss = Math.min(...validationLosses);
const withinOnePercent = TRIAL_MODELS.filter(
  (modelId) => summary.validation[modelId].meanPinballLoss <= minimumValidationLoss * 1.01,
);
const selectedModel = withinOnePercent[0];

// The frozen test is touched only after selection, and only for the selected
// model plus the predeclared baseline required by the promotion gate.
const testModels = [...new Set([selectedModel, PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE])];
for (const source of preparedSeries) {
  if (monthOpenMode) {
    for (const modelId of testModels) {
      const result = evaluateMonthOpenSeries(
        source.rows,
        source.timeframe,
        modelId,
        args.maxOriginsPerPhase,
      );
      const grouped = result.filter((row) => row.phase === 'test');
      for (const row of grouped) observations.push({
        ...row,
        modelId,
        coin: source.coin,
        timeframe: source.timeframe,
        horizon: row.horizonDays,
        horizonDays: row.horizonDays,
        horizonBars: row.horizonBars,
      });
      if (grouped.length) subgroupRows.push({
        group: `${source.timeframe}:month-open`,
        modelId,
        phase: 'test',
        rows: grouped,
      });
    }
    continue;
  }
  for (const horizonDays of args.horizons) {
    const resolved = resolveHorizonBars(horizonDays, source.timeframe);
    if (!resolved.ok) continue;
    const horizonBars = resolved.horizonBars;
    for (const modelId of testModels) {
      // Full chronological path so residual state matches live prequential carry.
      const result = evaluateSeries(
        source.rows,
        source.timeframe,
        horizonBars,
        horizonDays,
        modelId,
        args.maxOriginsPerPhase,
      );
      const grouped = result.filter((row) => row.phase === 'test');
      for (const row of grouped) observations.push({
        ...row,
        modelId,
        coin: source.coin,
        timeframe: source.timeframe,
        horizon: horizonDays,
        horizonDays,
        horizonBars,
      });
      if (grouped.length) subgroupRows.push({
        group: `${source.timeframe}:${horizonDays}d`,
        modelId,
        phase: 'test',
        rows: grouped,
      });
    }
  }
}
for (const modelId of testModels) {
  summary.test[modelId] = summarize(
    observations.filter((row) => row.phase === 'test' && row.modelId === modelId),
  );
}
const aggregatedSubgroups = [];
for (const item of subgroupRows) {
  const existing = aggregatedSubgroups.find((candidate) => candidate.group === item.group
    && candidate.modelId === item.modelId && candidate.phase === item.phase);
  if (existing) existing.rows.push(...item.rows);
  else aggregatedSubgroups.push({ ...item, rows: [...item.rows] });
}
const summarizedSubgroups = aggregatedSubgroups.map(({ rows, ...item }) => ({ ...item, summary: summarize(rows) }));
const reportId = monthOpenMode
  ? `price-projection-month-open-${Number(header.savedAtMs)}`
  : `price-projection-walk-forward-${Number(header.savedAtMs)}`;
const promotion = promotionDecision(selectedModel, summary.test, summarizedSubgroups);
const productionModel = monthOpenMode
  ? PRICE_PROJECTION_MODELS.MONTH_OPEN_MAP
  : (promotion.passed ? selectedModel : PRICE_PROJECTION_MODELS.VOLATILITY_BASELINE);
const scoringPath = 'scorePrequentialForecasts-per-step-multiplicative-scale-pre-aci';
const report = {
  reportId,
  generatedAt: new Date().toISOString(),
  snapshot: { path: args.snapshot, savedAtMs: header.savedAtMs, sourceSeries: series.length, evaluatedSeries },
  configuration: {
    models: TRIAL_MODELS,
    originMode: monthOpenMode ? 'month-open' : 'day-horizon',
    horizonDays: monthOpenMode ? 'utc-month-28-31' : args.horizons,
    chronologicalSplit: { development: [0.40, 0.60], validation: [0.60, 0.80], test: [0.80, 1.00] },
    originSeparationBars: monthOpenMode
      ? 'completed UTC-month opens (horizon = that month bar count)'
      : 'horizonBars (calendar-day horizon resolved per timeframe)',
    maxOriginsPerPhase: args.maxOriginsPerPhase,
    trials: TRIAL_MODELS.length,
    tieRule: 'within 1% of minimum validation pinball chooses simpler model',
    frozenTestModels: testModels,
    scoringPath,
    notes: monthOpenMode
      ? [
        'Month-open monitoring report. This is not a locked freeze and does not transfer the archived 5/10/20-day PASS.',
        'Origins are last closes before completed UTC month opens. Live remaining-horizon rebasing is not scored here.',
        'Live overlay still reports evidenceStatus unvalidated until a month-aligned freeze is intentionally locked.',
        'Residual scoring uses scorePrequentialForecasts grouped by exact month bar count.',
      ]
      : [
        'Residual scoring uses scorePrequentialForecasts (per-step multiplicative interval scale λ), identical to live buildCalibration diagnostics.',
        'ACI-lite applyPathCalibration adjusts chart factors only; promotion coverage matches UI BT50/BT80 (pre-ACI).',
        'For volatility-baseline-v1, pinball-vs-baseline and MAE-vs-zero are identity (vacuous) because the median is pinned at zero log-return.',
        'Vol model is har-multiperiod-rv (mean-reverting HAR cascade); still zero-median point forecast.',
      ],
  },
  selection: {
    selectedModel,
    productionModel,
    fallbackReason: promotion.passed ? null : 'frozen-test-promotion-failed',
    minimumValidationLoss,
    eligibleWithinOnePercent: withinOnePercent,
  },
  promotion,
  summary,
  subgroups: summarizedSubgroups,
};

fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.resolve(args.markdown), markdownReport(report));
console.log(JSON.stringify({ reportId, selectedModel, productionModel, promotion, evaluatedSeries, output: args.output, markdown: args.markdown }, null, 2));
