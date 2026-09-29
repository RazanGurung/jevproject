#!/usr/bin/env node

/**
 * Frozen walk-forward validation for 2-week path projection.
 *
 * Geometry: at each origin, the remaining horizon is Mon 00:00 UTC week start
 * + 14 calendar days (same as live computeWeekPathProjection). Residual scoring
 * reuses scorePrequentialForecasts (pre-ACI) from price-projection.js so
 * promotion gates match live BT50/BT80 diagnostics. ACI-lite is chart-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  WEEK_PATH_PROJECTION_MODELS,
  remainingDayClass,
  minPrequentialScoresForRemainingDays,
  __WEEK_PATH_PROJECTION_INTERNALS,
} from '../web/src/chart/week-path-projection.js';
import {
  __PRICE_PROJECTION_INTERNALS,
  trailingCleanSegment,
} from '../web/src/chart/price-projection.js';

const {
  rawWeekForecast,
  remainingBarsCache,
  sourceHistoryLimits,
} = __WEEK_PATH_PROJECTION_INTERNALS;

const {
  normalizeCandles,
  buildFeatureState,
  scorePrequentialForecasts,
} = __PRICE_PROJECTION_INTERNALS;

const MODEL_ORDER = [
  WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE,
  WEEK_PATH_PROJECTION_MODELS.WEEK_WTD_ANALOGUE,
];

const PRIMARY_TIMEFRAMES = new Set(['1h', '2h', '4h']);

function parseArgs(argv) {
  const result = {
    snapshot: 'data/candle-snapshot.json.gz',
    output: 'docs/WEEK_PATH_PROJECTION_VALIDATION.json',
    markdown: 'docs/WEEK_PATH_PROJECTION_VALIDATION.md',
    maxSeries: Infinity,
    maxOriginsPerPhase: 24,
    coins: null,
    timeframes: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--snapshot') result.snapshot = value, index += 1;
    else if (arg === '--output') result.output = value, index += 1;
    else if (arg === '--markdown') result.markdown = value, index += 1;
    else if (arg === '--max-series') result.maxSeries = Number(value), index += 1;
    else if (arg === '--max-origins') result.maxOriginsPerPhase = Number(value), index += 1;
    else if (arg === '--coins') result.coins = new Set(value.split(',').map((item) => item.trim())), index += 1;
    else if (arg === '--timeframes') {
      result.timeframes = new Set(value.split(',').map((item) => item.trim()));
      index += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/week_path_projection_validation.mjs [--snapshot FILE] [--output FILE] [--markdown FILE] [--coins BTC,ETH] [--timeframes 1h,2h,4h] [--max-series N] [--max-origins N]');
      process.exit(0);
    }
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

/**
 * Collect non-overlapping origins whose remaining bars > 0 and whose realized
 * path fits in-sample. Phase by chronological position in the series.
 */
function phaseOrigins(rows, remainingCache, maxPerPhase) {
  const candidates = [];
  for (let origin = 32 + 32; origin < rows.length - 1; origin += 1) {
    const horizon = remainingCache[origin];
    if (!(horizon >= 1)) continue;
    if (origin + horizon >= rows.length) continue;
    candidates.push({ origin, horizon });
  }
  // Thin to non-overlapping: step by each origin's own horizon.
  const nonOverlap = [];
  for (const item of candidates) {
    if (nonOverlap.length === 0) {
      nonOverlap.push(item);
      continue;
    }
    const prev = nonOverlap[nonOverlap.length - 1];
    if (item.origin - prev.origin >= prev.horizon) nonOverlap.push(item);
  }

  const phases = { development: [], validation: [], test: [] };
  for (const item of nonOverlap) {
    const ratio = item.origin / rows.length;
    const phase = ratio < 0.60 ? 'development' : ratio < 0.80 ? 'validation' : 'test';
    phases[phase].push(item);
  }
  for (const phase of Object.keys(phases)) {
    phases[phase] = phases[phase].slice(-maxPerPhase);
  }
  return phases;
}

function evaluateSeries(
  rows,
  timeframe,
  modelId,
  maxOriginsPerPhase,
  allowedPhases = new Set(['development', 'validation', 'test']),
) {
  const featureState = buildFeatureState(rows);
  const history = sourceHistoryLimits(timeframe);
  const remainingCache = remainingBarsCache(rows, timeframe);
  const phases = phaseOrigins(rows, remainingCache, maxOriginsPerPhase);
  const ordered = Object.entries(phases)
    .filter(([phase]) => allowedPhases.has(phase))
    .flatMap(([phase, origins]) => origins.map((item) => ({ phase, ...item })))
    .sort((left, right) => left.origin - right.origin);

  const sequence = [];
  const meta = [];
  for (const { phase, origin, horizon } of ordered) {
    const remainingDays = remainingDayClass(horizon, timeframe);
    const minPrequential = minPrequentialScoresForRemainingDays(remainingDays);
    const forecast = rawWeekForecast(
      rows,
      featureState,
      origin,
      horizon,
      modelId,
      history,
      timeframe,
      remainingCache,
    );
    if (!forecast) continue;
    const actual = [];
    for (let step = 1; step <= horizon; step += 1) {
      actual.push(Math.log(rows[origin + step].close / rows[origin].close));
    }
    const baselineForecast = modelId === WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE
      ? forecast
      : rawWeekForecast(
        rows,
        featureState,
        origin,
        horizon,
        WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE,
        history,
        timeframe,
        remainingCache,
      );
    sequence.push({
      actual,
      quantiles: forecast.quantiles,
      analogueUpFrequency: forecast.analogueUpFrequency,
      baselineQuantiles: baselineForecast?.quantiles || null,
      // scorePrequentialForecasts uses horizon from the call; store per-row for meta.
      _horizon: horizon,
      _remainingDays: remainingDays,
      _minPrequential: minPrequential,
    });
    meta.push({ phase, origin, horizon, remainingDays });
  }

  if (!sequence.length) {
    return { rows: [], meta: [] };
  }

  // Group by horizon so the scorer gets a fixed path length per batch.
  const byHorizon = new Map();
  for (let i = 0; i < sequence.length; i += 1) {
    const h = sequence[i]._horizon;
    if (!byHorizon.has(h)) byHorizon.set(h, []);
    byHorizon.get(h).push({ index: i, item: sequence[i], meta: meta[i] });
  }

  const outRows = [];
  for (const [horizon, batch] of byHorizon) {
    const minPrequential = batch[0].item._minPrequential;
    const scored = scorePrequentialForecasts(
      batch.map((entry) => ({
        actual: entry.item.actual,
        quantiles: entry.item.quantiles,
        analogueUpFrequency: entry.item.analogueUpFrequency,
        baselineQuantiles: entry.item.baselineQuantiles,
      })),
      { horizon, minPrequential },
    );
    for (let j = 0; j < scored.rows.length; j += 1) {
      const row = scored.rows[j];
      const { meta: m } = batch[j];
      outRows.push({
        phase: m.phase,
        origin: m.origin,
        horizon: m.horizon,
        remainingDays: m.remainingDays,
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
    }
  }
  // Restore chronological order for residual carry interpretation in reports.
  outRows.sort((a, b) => a.origin - b.origin);
  return { rows: outRows, meta };
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
  const baseline = testSummaries[WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE];
  if (!result || !Number.isFinite(result.samples) || result.samples < 1) {
    return {
      passed: false,
      gates: { insufficientTestSamples: false },
      subgroupFailures: [],
      evidenceStatus: 'unvalidated',
      scoringPath: 'scorePrequentialForecasts-per-step-multiplicative-scale-pre-aci',
    };
  }
  const subgroupFailures = subgroupRows
    .filter((group) => group.modelId === selected && group.phase === 'test' && group.summary.samples >= 20)
    .filter((group) => group.summary.coverage50 < 0.40 || group.summary.coverage80 < 0.70)
    .map((group) => group.group);
  const selectedIsBaseline = selected === WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE;
  const gates = {
    pinballNoWorseThanBaseline: selectedIsBaseline
      ? true
      : (baseline?.meanPinballLoss != null
        ? result.meanPinballLoss <= baseline.meanPinballLoss
        : true),
    maeNoWorseThanZero: selectedIsBaseline
      ? true
      : result.meanAbsoluteLogError <= result.zeroReturnMeanAbsoluteLogError,
    pinballGateVacuousForZeroMedianBaseline: selectedIsBaseline,
    maeGateVacuousForZeroMedianBaseline: selectedIsBaseline,
    brierNoWorseThanClimatology: result.brierScore <= result.climatologyBrierScore,
    pooledCoverage50WithinFivePoints: Math.abs(result.coverage50 - 0.50) <= 0.05,
    pooledCoverage80WithinFivePoints: Math.abs(result.coverage80 - 0.80) <= 0.05,
    noMaterialSubgroupUndercoverage: subgroupFailures.length === 0,
    minTestSamples: result.samples >= 12,
  };
  const required = {
    pinballNoWorseThanBaseline: gates.pinballNoWorseThanBaseline,
    maeNoWorseThanZero: gates.maeNoWorseThanZero,
    brierNoWorseThanClimatology: gates.brierNoWorseThanClimatology,
    pooledCoverage50WithinFivePoints: gates.pooledCoverage50WithinFivePoints,
    pooledCoverage80WithinFivePoints: gates.pooledCoverage80WithinFivePoints,
    noMaterialSubgroupUndercoverage: gates.noMaterialSubgroupUndercoverage,
    minTestSamples: gates.minTestSamples,
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
    '# 2-Week Path Projection Frozen Walk-Forward Validation',
    '',
    `Report ID: \`${report.reportId}\``,
    '',
    `Validation-selected candidate: \`${report.selection.selectedModel}\``,
    '',
    `Production research model: \`${report.selection.productionModel}\``,
    '',
    `Promotion: **${report.promotion.passed ? 'PASS' : 'FAIL'}** (${report.promotion.evidenceStatus})`,
    '',
    `Scoring path: \`${report.configuration.scoringPath}\` (same multiplicative interval scorer as live chart diagnostics; ACI-lite is chart-only).`,
    '',
    'Horizon geometry: remaining bars to Monday 00:00 UTC two weeks after ISO week start (Mon+14d).',
    '',
    '| Model | Validation pinball | Test pinball | Test MAE | Zero MAE | Brier | Climatology | C50 | C80 | Samples |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const modelId of MODEL_ORDER) {
    const validation = report.summary.validation[modelId] || {};
    const test = report.summary.test[modelId] || {};
    const display = (value) => (Number.isFinite(value) ? value.toFixed(6) : '—');
    lines.push(
      `| ${modelId} | ${display(validation.meanPinballLoss)} | ${display(test.meanPinballLoss)} | ${display(test.meanAbsoluteLogError)} | ${display(test.zeroReturnMeanAbsoluteLogError)} | ${display(test.brierScore)} | ${display(test.climatologyBrierScore)} | ${display(test.coverage50)} | ${display(test.coverage80)} | ${test.samples ?? '—'} |`,
    );
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
  if (report.promotion.subgroupFailures?.length) {
    lines.push('', '### Subgroup failures', '');
    for (const group of report.promotion.subgroupFailures) {
      lines.push(`- ${group}`);
    }
  }
  lines.push(
    '',
    'Day-class pooling (vol baseline): candidates with the same remaining-day class (1..14) and at least as many realized bars contribute truncated paths of length horizon.',
    '',
    'This report measures forecast-band quality only, not trading profitability.',
  );
  return `${lines.join('\n')}\n`;
}

const args = parseArgs(process.argv.slice(2));
const snapshotPath = path.resolve(args.snapshot);
const raw = snapshotPath.endsWith('.gz')
  ? gunzipSync(fs.readFileSync(snapshotPath)).toString('utf8')
  : fs.readFileSync(snapshotPath, 'utf8');
const documents = raw.trim().split('\n').map((line) => JSON.parse(line));
const header = documents[0];
const tfFilter = args.timeframes || PRIMARY_TIMEFRAMES;
const eligibleDocuments = documents.slice(1)
  .filter((source) => !args.coins || args.coins.has(source.coin))
  .filter((source) => tfFilter.has(source.interval));
const series = eligibleDocuments.slice(0, Number.isFinite(args.maxSeries) ? args.maxSeries : undefined);
const observations = [];
const subgroupRows = [];
const preparedSeries = [];
let evaluatedSeries = 0;

for (const source of series) {
  const candles = expandSeriesCandles(source);
  const closed = candles.filter((candle) => Number(candle.T || candle.t || 0) <= Number(header.savedAtMs));
  const normalized = normalizeCandles(closed);
  const history = sourceHistoryLimits(source.interval);
  const clean = trailingCleanSegment(normalized.rows, source.interval);
  if (normalized.reason || clean.rows.length < history.minBars) continue;
  normalized.rows = clean.rows;
  evaluatedSeries += 1;
  preparedSeries.push({ coin: source.coin, timeframe: source.interval, rows: normalized.rows });
  for (const modelId of MODEL_ORDER) {
    const result = evaluateSeries(
      normalized.rows,
      source.interval,
      modelId,
      args.maxOriginsPerPhase,
      new Set(['development', 'validation']),
    );
    for (const row of result.rows) {
      observations.push({
        ...row,
        modelId,
        coin: source.coin,
        timeframe: source.interval,
      });
    }
    const grouped = result.rows.filter((row) => row.phase === 'validation');
    if (grouped.length) {
      subgroupRows.push({
        group: `${source.interval}:remaining`,
        modelId,
        phase: 'validation',
        rows: grouped,
      });
    }
  }
}

const summary = { validation: {}, test: {} };
for (const modelId of MODEL_ORDER) {
  summary.validation[modelId] = summarize(
    observations.filter((row) => row.phase === 'validation' && row.modelId === modelId),
  );
}

const validationLosses = MODEL_ORDER
  .map((modelId) => summary.validation[modelId].meanPinballLoss)
  .filter(Number.isFinite);

let selectedModel = WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE;
let minimumValidationLoss = null;
let withinOnePercent = [selectedModel];

if (validationLosses.length > 0) {
  minimumValidationLoss = Math.min(...validationLosses);
  withinOnePercent = MODEL_ORDER.filter(
    (modelId) => Number.isFinite(summary.validation[modelId].meanPinballLoss)
      && summary.validation[modelId].meanPinballLoss <= minimumValidationLoss * 1.01,
  );
  // Prefer simpler model (baseline first in MODEL_ORDER) among near-ties.
  selectedModel = withinOnePercent[0] || WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE;
}

const testModels = [...new Set([selectedModel, WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE])];
for (const source of preparedSeries) {
  for (const modelId of testModels) {
    const result = evaluateSeries(
      source.rows,
      source.timeframe,
      modelId,
      args.maxOriginsPerPhase,
    );
    const grouped = result.rows.filter((row) => row.phase === 'test');
    for (const row of grouped) {
      observations.push({
        ...row,
        modelId,
        coin: source.coin,
        timeframe: source.timeframe,
      });
    }
    if (grouped.length) {
      subgroupRows.push({
        group: `${source.timeframe}:remaining`,
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
const summarizedSubgroups = aggregatedSubgroups.map(({ rows, ...item }) => ({
  ...item,
  summary: summarize(rows),
}));

const reportId = `week-path-projection-walk-forward-${Number(header.savedAtMs)}`;
const promotion = promotionDecision(selectedModel, summary.test, summarizedSubgroups);
const productionModel = promotion.passed
  ? selectedModel
  : WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE;
const scoringPath = 'scorePrequentialForecasts-per-step-multiplicative-scale-pre-aci';

const report = {
  reportId,
  generatedAt: new Date().toISOString(),
  snapshot: {
    path: args.snapshot,
    savedAtMs: header.savedAtMs,
    sourceSeries: series.length,
    evaluatedSeries,
  },
  configuration: {
    models: MODEL_ORDER,
    timeframes: [...tfFilter],
    horizonGeometry: 'iso-week-start + 14 calendar days (remaining bars)',
    chronologicalSplit: {
      development: [0.00, 0.60],
      validation: [0.60, 0.80],
      test: [0.80, 1.00],
    },
    originSeparation: 'non-overlapping by each origin remaining horizon',
    maxOriginsPerPhase: args.maxOriginsPerPhase,
    trials: MODEL_ORDER.length,
    tieRule: 'within 1% of minimum validation pinball chooses simpler model',
    frozenTestModels: testModels,
    scoringPath,
    notes: [
      'Residual scoring uses scorePrequentialForecasts (per-step multiplicative λ), identical to live buildWeekCalibration diagnostics.',
      'ACI-lite applyPathCalibration adjusts chart factors only; promotion coverage matches UI BT50/BT80 (pre-ACI).',
      'For week-vol-baseline-v1, pinball-vs-baseline and MAE-vs-zero are identity (vacuous) because the median is pinned at zero remaining log-return.',
      'Vol model is har-multiperiod-rv shared with price projection; day-class pooling for vol baseline only.',
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

console.log(JSON.stringify({
  reportId,
  promotion: promotion.passed ? 'PASS' : 'FAIL',
  evidenceStatus: promotion.evidenceStatus,
  selectedModel,
  testSamples: summary.test[selectedModel]?.samples ?? 0,
  coverage50: summary.test[selectedModel]?.coverage50 ?? null,
  coverage80: summary.test[selectedModel]?.coverage80 ?? null,
  output: path.resolve(args.output),
  markdown: path.resolve(args.markdown),
}, null, 2));
