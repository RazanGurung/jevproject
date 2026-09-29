const POSITIVE_COLOR = 'rgba(34,204,230,0.70)';
const NEGATIVE_COLOR = 'rgba(255,80,80,0.70)';
const NEUTRAL_COLOR  = 'rgba(150,150,150,0.40)';

const DEFAULT_PALETTE = Object.freeze({
  positive: POSITIVE_COLOR,
  negative: NEGATIVE_COLOR,
  neutral:  NEUTRAL_COLOR,
});

const TIMEFRAME_SECONDS = Object.freeze({
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
  '1M': 30 * 24 * 60 * 60,
});

const CANONICAL_WEEKLY_ANCHOR = '1W-MON00';
const LEGACY_WEEKLY_ANCHOR = '1W-MON14';
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MONDAY_EPOCH_OFFSET_SECONDS = 4 * 24 * 60 * 60;

// Unix epoch (1970-01-01) was a Thursday. Shifting by four days makes the
// integer week boundary Monday 00:00 UTC for anchored CVD.
function mondayUtcWeekStart(timeSeconds) {
  return Math.floor((timeSeconds - MONDAY_EPOCH_OFFSET_SECONDS) / WEEK_SECONDS)
    * WEEK_SECONDS + MONDAY_EPOCH_OFFSET_SECONDS;
}

function normalizeCvdAnchorTimeframe(timeframe = '1D') {
  const raw = String(timeframe || '1D');
  const upper = raw.toUpperCase();
  if (upper === CANONICAL_WEEKLY_ANCHOR || upper === LEGACY_WEEKLY_ANCHOR) {
    return CANONICAL_WEEKLY_ANCHOR;
  }
  return raw;
}

function normalizeTimestamp(time) {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
}

function getStartOfPeriod(timeSeconds, timeframe) {
  const tf = (timeframe || '1D').toUpperCase();
  if (tf === 'CONTINUOUS' || tf === 'NONE') return 0;
  if (tf === CANONICAL_WEEKLY_ANCHOR || tf === LEGACY_WEEKLY_ANCHOR) {
    return mondayUtcWeekStart(timeSeconds);
  }
  const date = new Date(timeSeconds * 1000);
  if (tf === '1W' || tf === 'W') {
    const day = date.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    date.setUTCDate(date.getUTCDate() - diff);
    date.setUTCHours(0, 0, 0, 0);
  } else if (tf === '1M' || tf === 'M') {
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  return Math.floor(date.getTime() / 1000);
}

function isCustomAnchorTimeframe(timeframe) {
  const tf = (timeframe || '').toUpperCase();
  return tf === 'CUSTOM' || tf === 'MANUAL' || tf === 'VISIBLE';
}

function isWeeklyAnchorTimeframe(timeframe) {
  return normalizeCvdAnchorTimeframe(timeframe).toUpperCase() === CANONICAL_WEEKLY_ANCHOR;
}

function isNewPeriod(currentTimeSeconds, previousTimeSeconds, timeframe) {
  if (!(previousTimeSeconds > 0)) return true;
  return getStartOfPeriod(currentTimeSeconds, timeframe) !== getStartOfPeriod(previousTimeSeconds, timeframe);
}

function colorForDelta(delta, palette = DEFAULT_PALETTE) {
  if (delta > 0) return palette.positive;
  if (delta < 0) return palette.negative;
  return palette.neutral;
}

function parseBar(bar) {
  if (!bar) return null;
  const t = normalizeTimestamp(bar.t);
  if (!(t > 0)) return null;
  const o = Number.parseFloat(bar.o);
  const c = Number.parseFloat(bar.c);
  if (!Number.isFinite(o) || !Number.isFinite(c)) return null;
  const rawV = Number.parseFloat(bar.v);
  const v = Number.isFinite(rawV) && rawV > 0 ? rawV : 0;
  const cvdDelta = bar.cvdDelta != null ? Number(bar.cvdDelta) : undefined;
  return { t, o, c, v, cvdDelta };
}

function directionalDeltaForBar(bar) {
  if (!bar || !(bar.v > 0)) return 0;
  if (bar.c > bar.o) return bar.v;
  if (bar.c < bar.o) return -bar.v;
  return 0;
}

function createState(inputs = {}) {
  const anchorTimeframe = normalizeCvdAnchorTimeframe(inputs.anchorTimeframe || '1D');
  const anchorStartTime = normalizeTimestamp(inputs.anchorStartTime);
  const palette = { ...DEFAULT_PALETTE, ...(inputs.palette || {}) };
  const useCustomAnchor = anchorStartTime > 0 || isCustomAnchorTimeframe(anchorTimeframe);
  const useWeeklyAnchor = isWeeklyAnchorTimeframe(anchorTimeframe);

  let cumDelta = 0;
  let cumBeforeLast = 0;
  let lastTime = 0;
  let lastWasAnchor = false;
  let customAnchorReached = !useCustomAnchor;
  let lastWeekKey = -1;

  function ingest(bar) {
    const parsed = parseBar(bar);
    if (!parsed) return null;
    const { t } = parsed;

    if (lastTime > 0 && t < lastTime) return null;

    if (useCustomAnchor && !customAnchorReached && t < anchorStartTime) {
      lastTime = t;
      lastWasAnchor = false;
      return { time: t, whitespace: true };
    }

    let isAnchor;
    if (t === lastTime) {
      cumDelta = cumBeforeLast;
      isAnchor = lastWasAnchor;
    } else {
      if (useWeeklyAnchor) {
        const weekKey = mondayUtcWeekStart(t);
        isAnchor = weekKey !== lastWeekKey;
        if (isAnchor) {
          lastWeekKey = weekKey;
          cumDelta = 0;
        }
      } else if (useCustomAnchor && !customAnchorReached && t >= anchorStartTime) {
        customAnchorReached = true;
        isAnchor = true;
        if (isAnchor) cumDelta = 0;
      } else {
        isAnchor = useCustomAnchor ? false : isNewPeriod(t, lastTime, anchorTimeframe);
        if (isAnchor) cumDelta = 0;
      }
      cumBeforeLast = cumDelta;
      lastTime = t;
      lastWasAnchor = isAnchor;
    }

    const delta = parsed.cvdDelta != null ? parsed.cvdDelta : directionalDeltaForBar(parsed);
    cumDelta += delta;

    return {
      time: t,
      value: cumDelta,
      color: colorForDelta(delta, palette),
      isAnchor,
    };
  }

  function snapshot() {
    return {
      cumDelta,
      cumBeforeLast,
      lastTime,
      lastWasAnchor,
      customAnchorReached,
      lastWeekKey,
    };
  }

  return { ingest, snapshot };
}

function calculate(bars, inputs = {}) {
  const runner = createState(inputs);
  const rows = [];
  if (!Array.isArray(bars)) return rows;
  for (let i = 0; i < bars.length; i += 1) {
    const row = runner.ingest(bars[i]);
    if (row) rows.push(row);
  }
  return rows;
}

const CVD = { calculate, createState };

export {
  CANONICAL_WEEKLY_ANCHOR,
  CVD,
  DEFAULT_PALETTE,
  LEGACY_WEEKLY_ANCHOR,
  POSITIVE_COLOR,
  NEGATIVE_COLOR,
  NEUTRAL_COLOR,
  normalizeCvdAnchorTimeframe,
};
export default CVD;
