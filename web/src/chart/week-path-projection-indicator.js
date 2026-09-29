import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
import {
  computeWeekPathProjection,
  WEEK_PATH_PROJECTION_DEFAULTS,
  WEEK_PATH_PROJECTION_MODELS,
} from './week-path-projection.js';

/** Fingerprint one OHLCV row for source-change detection. */
function candleFingerprint(row) {
  if (!row) return '';
  return [row.t || '', row.o || '', row.h || '', row.l || '', row.c || '', row.v || ''].join(',');
}

/**
 * Source signature for recompute gating.
 * Length + tip alone miss mid-series repairs; sample first/q1/mid/q3/last
 * plus revision so authoritative snapshot reloads always recompute.
 */
function sourceSignature(candles, coin, timeframe, revision, envelopeVisible) {
  const rows = Array.isArray(candles) ? candles : [];
  const n = rows.length;
  const first = n > 0 ? rows[0] : null;
  const q1 = n > 3 ? rows[Math.floor(n / 4)] : null;
  const mid = n > 0 ? rows[Math.floor((n - 1) / 2)] : null;
  const q3 = n > 3 ? rows[Math.floor((3 * n) / 4)] : null;
  const last = n > 0 ? rows[n - 1] : null;
  return [
    coin,
    timeframe,
    envelopeVisible ? 1 : 0,
    revision,
    n,
    candleFingerprint(first),
    candleFingerprint(q1),
    candleFingerprint(mid),
    candleFingerprint(q3),
    candleFingerprint(last),
  ].join(':');
}

function publicStatus(result, enabled) {
  if (!enabled) {
    return {
      status: 'disabled',
      reason: '',
      remainingBars: 0,
      remainingDays: 0,
      horizonBars: 0,
    };
  }
  if (!result) {
    return {
      status: 'pending',
      reason: '',
      remainingBars: 0,
      remainingDays: 0,
      horizonBars: 0,
    };
  }
  if (result.status !== 'ready') {
    return {
      ...result,
      remainingBars: Number(result.remainingBars || result.horizonBars || 0),
      remainingDays: Number(result.remainingDays || 0),
      horizonBars: Number(result.horizonBars || result.remainingBars || 0),
    };
  }
  return {
    status: result.status,
    reason: '',
    model: result.model ? { ...result.model } : null,
    evidenceStatus: result.evidenceStatus || 'unvalidated',
    timeframe: result.timeframe,
    remainingBars: result.remainingBars,
    remainingDays: result.remainingDays,
    horizonBars: result.horizonBars,
    weekStart: result.weekStart,
    weekEnd: result.weekEnd,
    weekFractionElapsed: result.weekFractionElapsed,
    weekOpenPrice: result.weekOpenPrice,
    wtdReturn: result.wtdReturn,
    wtdHigh: result.wtdHigh,
    wtdLow: result.wtdLow,
    anchorTime: result.anchorTime,
    lastProjectionTime: result.lastProjectionTime,
    sourceCount: result.sourceCount,
    analogueUpFrequency: result.analogueUpFrequency,
    analogCount: result.analogCount,
    weightEffectiveSampleSize: result.weightEffectiveSampleSize,
    clusterEffectiveSampleSize: result.clusterEffectiveSampleSize,
    envelope: result.envelope ? { ...result.envelope } : null,
    calibration: { ...result.calibration },
  };
}

function envelopeLevelPoints(price, fromTime, toTime) {
  const value = Number(price);
  const t0 = Number(fromTime);
  const t1 = Number(toTime);
  if (!(value > 0) || !(t0 > 0) || !(t1 > t0)) return [];
  return [
    { time: t0, value },
    { time: t1, value },
  ];
}

export function createWeekPathProjectionOverlay({ getChart, LineSeries, LineStyle, ensureVisible } = {}) {
  if (typeof getChart !== 'function' || !LineSeries || !LineStyle) {
    throw new Error('createWeekPathProjectionOverlay requires getChart, LineSeries, and LineStyle');
  }

  let enabled = false;
  let envelopeVisible = WEEK_PATH_PROJECTION_DEFAULTS.envelopeVisibleDefault !== false;
  let attachedChart = null;
  let series = null;
  let lastSignature = '';
  let lastResult = null;
  let dataSetCount = 0;
  let computeCount = 0;
  let statusListener = null;
  let lastPublishedStatus = '';

  function publishStatus() {
    const status = publicStatus(lastResult, enabled);
    const signature = JSON.stringify(status);
    if (signature === lastPublishedStatus) return;
    lastPublishedStatus = signature;
    try { statusListener?.(status); } catch {}
  }

  function removeSeries() {
    if (attachedChart && series) {
      for (const item of Object.values(series)) {
        try { attachedChart.removeSeries(item); } catch {}
      }
    }
    attachedChart = null;
    series = null;
  }

  function detach({ resetResult = true } = {}) {
    removeSeries();
    lastSignature = '';
    if (resetResult) lastResult = null;
    publishStatus();
  }

  // Same Colors-menu swatch as Price Projection (AVWAP row) so both fans recolor together.
  function indicatorBaseColor() {
    return getPaletteColor('avwap');
  }

  function isZeroMedianBaseline(result = lastResult) {
    const modelId = result?.model?.id || WEEK_PATH_PROJECTION_DEFAULTS.modelId;
    return modelId === WEEK_PATH_PROJECTION_MODELS.WEEK_VOL_BASELINE;
  }

  function lineOptions(width, style, alpha = 0.8) {
    return {
      color: colorWithAlpha(indicatorBaseColor(), alpha),
      lineWidth: width,
      lineStyle: style,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceScaleId: 'right',
      visible: true,
      // Research fans must not expand the candle price scale.
      autoscaleInfoProvider: () => null,
    };
  }

  function bandStyle(baseline) {
    if (baseline) {
      return {
        q50: { width: 1, style: LineStyle.Solid, alpha: 0.0, visible: false },
        q25: { width: 1, style: LineStyle.Solid, alpha: 0.95, visible: true },
        q75: { width: 1, style: LineStyle.Solid, alpha: 0.95, visible: true },
        q10: { width: 1, style: LineStyle.Dashed, alpha: 0.82, visible: true },
        q90: { width: 1, style: LineStyle.Dashed, alpha: 0.82, visible: true },
      };
    }
    return {
      q50: { width: 2, style: LineStyle.Solid, alpha: 0.92, visible: true },
      q25: { width: 1, style: LineStyle.Dashed, alpha: 0.55, visible: true },
      q75: { width: 1, style: LineStyle.Dashed, alpha: 0.55, visible: true },
      q10: { width: 1, style: LineStyle.Dotted, alpha: 0.35, visible: true },
      q90: { width: 1, style: LineStyle.Dotted, alpha: 0.35, visible: true },
    };
  }

  function attachIfNeeded() {
    const chart = getChart();
    if (!enabled || !chart) return false;
    if (attachedChart === chart && series) return true;
    removeSeries();
    try {
      attachedChart = chart;
      const style = bandStyle(true);
      series = {
        q50: chart.addSeries(LineSeries, lineOptions(style.q50.width, style.q50.style, style.q50.alpha)),
        q25: chart.addSeries(LineSeries, lineOptions(style.q25.width, style.q25.style, style.q25.alpha)),
        q75: chart.addSeries(LineSeries, lineOptions(style.q75.width, style.q75.style, style.q75.alpha)),
        q10: chart.addSeries(LineSeries, lineOptions(style.q10.width, style.q10.style, style.q10.alpha)),
        q90: chart.addSeries(LineSeries, lineOptions(style.q90.width, style.q90.style, style.q90.alpha)),
        high50: chart.addSeries(LineSeries, lineOptions(1, LineStyle.Dashed, 0.55)),
        high80: chart.addSeries(LineSeries, lineOptions(1, LineStyle.Dotted, 0.4)),
        low50: chart.addSeries(LineSeries, lineOptions(1, LineStyle.Dashed, 0.55)),
        low80: chart.addSeries(LineSeries, lineOptions(1, LineStyle.Dotted, 0.4)),
      };
      series.q50.applyOptions({ visible: style.q50.visible });
      return true;
    } catch (error) {
      console.warn('[week-path-projection] attach failed:', error);
      removeSeries();
      return false;
    }
  }

  function applyTheme() {
    if (!series) return;
    const base = indicatorBaseColor();
    const style = bandStyle(isZeroMedianBaseline());
    for (const key of ['q50', 'q25', 'q75', 'q10', 'q90']) {
      const spec = style[key];
      series[key].applyOptions({
        color: colorWithAlpha(base, spec.alpha),
        lineWidth: spec.width,
        lineStyle: spec.style,
        visible: spec.visible !== false,
      });
    }
    for (const key of ['high50', 'low50']) {
      series[key].applyOptions({
        color: colorWithAlpha(base, 0.55),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        visible: envelopeVisible,
      });
    }
    for (const key of ['high80', 'low80']) {
      series[key].applyOptions({
        color: colorWithAlpha(base, 0.4),
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        visible: envelopeVisible,
      });
    }
  }

  function clearData() {
    if (!series) return;
    for (const item of Object.values(series)) {
      item.setData([]);
      dataSetCount += 1;
    }
  }

  function setOptions(options = {}) {
    const nextEnabled = options.visible === true;
    const nextEnvelope = options.envelopeVisible !== false
      && options.envelopeVisible !== 'false';
    const visibilityChanged = nextEnabled !== enabled;
    const envelopeChanged = nextEnvelope !== envelopeVisible;
    enabled = nextEnabled;
    envelopeVisible = nextEnvelope;
    if (!enabled) {
      detach();
      return;
    }
    if (visibilityChanged || envelopeChanged) {
      lastSignature = '';
      if (visibilityChanged) lastResult = null;
      publishStatus();
    }
  }

  function setCandles(candles, coin = '', timeframe = '2h', revision = 0) {
    if (!enabled) return false;
    if (!attachIfNeeded()) return false;
    const signature = sourceSignature(candles, coin, timeframe, revision, envelopeVisible);
    if (signature === lastSignature) return true;
    lastSignature = signature;
    computeCount += 1;
    lastResult = computeWeekPathProjection(candles, { timeframe });
    if (lastResult.status === 'ready') {
      const applyPathData = (seriesInstance, points) => {
        try {
          seriesInstance.setData(points);
        } catch {
          try { getChart()?.clearCrosshairPosition?.(); } catch {}
          try { seriesInstance.setData(points); } catch {}
        }
      };
      const baseline = isZeroMedianBaseline(lastResult);
      for (const key of ['q10', 'q25', 'q50', 'q75', 'q90']) {
        const points = baseline && key === 'q50' ? [] : lastResult.paths[key];
        applyPathData(series[key], points);
        dataSetCount += 1;
      }
      const env = lastResult.envelope || {};
      const from = lastResult.anchorTime;
      const to = lastResult.lastProjectionTime;
      if (envelopeVisible) {
        applyPathData(series.high50, envelopeLevelPoints(env.high50, from, to));
        applyPathData(series.high80, envelopeLevelPoints(env.high80, from, to));
        applyPathData(series.low50, envelopeLevelPoints(env.low50, from, to));
        applyPathData(series.low80, envelopeLevelPoints(env.low80, from, to));
      } else {
        applyPathData(series.high50, []);
        applyPathData(series.high80, []);
        applyPathData(series.low50, []);
        applyPathData(series.low80, []);
      }
      dataSetCount += 4;
      applyTheme();
      try { ensureVisible?.(lastResult.anchorTime, lastResult.lastProjectionTime); } catch {}
    } else {
      clearData();
    }
    publishStatus();
    return lastResult.status === 'ready';
  }

  function updateLast(candles, coin = '', timeframe = '2h', revision = 0) {
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
      envelopeVisible,
      attached: Boolean(attachedChart && series),
      seriesCount: series ? Object.keys(series).length : 0,
      dataSetCount,
      computeCount,
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
