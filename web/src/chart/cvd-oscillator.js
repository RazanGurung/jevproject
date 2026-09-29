import { CVD } from './cvd.js';

const DEFAULT_LOOKBACK_DAYS = 90;
const SECONDS_PER_DAY = 86400;
const RATIO_DIVISOR = 5;
const MIN_PRICE_BAND_SECONDS = 6 * 3600;
const MIN_EXTREME_SAMPLES = 2;
const CVD_SCALE = 0.25;
const EPS = 1e-9;
const AMP_SCALE = 2.5;
const MIN_AMP_PERIODS = 8;
const BEAR_COLOR = 'rgba(255,80,80,0.50)';
const BULL_COLOR = 'rgba(34,204,230,0.50)';
const NEUTRAL_COLOR = 'rgba(150,150,150,0.30)';

function normalizeTimestamp(time) {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
}

function dedupeAndSort(bars) {
  if (!Array.isArray(bars)) return [];
  const byTime = new Map();
  for (const bar of bars) {
    const t = normalizeTimestamp(bar?.t);
    if (t > 0) byTime.set(t, bar);
  }
  return [...byTime.values()].sort((a, b) => normalizeTimestamp(a.t) - normalizeTimestamp(b.t));
}

function colorForValue(value) {
  if (value > 0) return BULL_COLOR;
  if (value < 0) return BEAR_COLOR;
  return NEUTRAL_COLOR;
}

function timeExtreme(times, values, windowSec, minSamples, isMax) {
  const n = values.length;
  const out = new Array(n);
  const dq = [];
  const win = [];
  let dqHead = 0;
  let winHead = 0;
  const need = Math.max(1, Math.floor(minSamples));
  for (let i = 0; i < n; i += 1) {
    const lo = times[i] - windowSec;
    while (dqHead < dq.length && times[dq[dqHead]] < lo) dqHead += 1;
    while (winHead < win.length && times[win[winHead]] < lo) winHead += 1;
    const v = values[i];
    if (Number.isFinite(v)) {
      while (dq.length > dqHead) {
        const back = values[dq[dq.length - 1]];
        if (isMax ? back <= v : back >= v) dq.pop();
        else break;
      }
      dq.push(i);
      win.push(i);
    }
    const count = win.length - winHead;
    out[i] = (dq.length > dqHead && count >= need) ? values[dq[dqHead]] : undefined;
  }
  return out;
}

function timeMeanAbs(times, values, windowSec, minSamples) {
  const n = values.length;
  const out = new Array(n);
  const q = [];
  let head = 0;
  let sum = 0;
  const need = Math.max(1, Math.floor(minSamples));
  for (let i = 0; i < n; i += 1) {
    const lo = times[i] - windowSec;
    while (head < q.length && times[q[head].i] < lo) {
      sum -= q[head].v;
      head += 1;
    }
    const v = values[i];
    if (Number.isFinite(v)) {
      q.push({ i, v });
      sum += v;
    }
    const count = q.length - head;
    out[i] = count >= need ? sum / count : undefined;
  }
  return out;
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function computeOscillator(bars, lookbackDays) {
  const n = bars.length;
  const cvdRows = CVD.calculate(bars, { anchorTimeframe: 'CONTINUOUS' });
  const times = new Array(n);
  const raw = new Array(n);
  const highs = new Array(n);
  const lows = new Array(n);
  const closes = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    times[i] = normalizeTimestamp(bar.t);
    highs[i] = Number.parseFloat(bar.h);
    lows[i] = Number.parseFloat(bar.l);
    closes[i] = Number.parseFloat(bar.c);
    const cv = cvdRows[i] && !cvdRows[i].whitespace ? Number(cvdRows[i].value) : undefined;
    raw[i] = Number.isFinite(cv) ? cv : (i > 0 ? raw[i - 1] : 0);
  }

  const days = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : DEFAULT_LOOKBACK_DAYS;
  const normSec = days * SECONDS_PER_DAY;
  const ratioSec = Math.max(normSec / RATIO_DIVISOR, MIN_PRICE_BAND_SECONDS);
  const distSec = ratioSec;

  const oscHi = timeExtreme(times, raw, normSec, MIN_EXTREME_SAMPLES, true);
  const oscLo = timeExtreme(times, raw, normSec, MIN_EXTREME_SAMPLES, false);
  const hiHigh = timeExtreme(times, highs, ratioSec, MIN_EXTREME_SAMPLES, true);
  const loLow = timeExtreme(times, lows, ratioSec, MIN_EXTREME_SAMPLES, false);

  const oscScaled = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const priceHi = i > 0 ? hiHigh[i - 1] : undefined;
    const priceLo = i > 0 ? loLow[i - 1] : undefined;
    const hi = oscHi[i];
    const lo = oscLo[i];
    if (!Number.isFinite(priceHi) || !Number.isFinite(priceLo)
      || !Number.isFinite(hi) || !Number.isFinite(lo)) {
      oscScaled[i] = undefined;
      continue;
    }
    const oscNorm = (raw[i] - lo) / Math.max(hi - lo, 1e-10);
    const priceRng = priceHi - priceLo;
    const priceMid = priceLo + priceRng * 0.5;
    oscScaled[i] = priceMid + (oscNorm - 0.5) * priceRng * CVD_SCALE;
  }

  const rawDist = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const prevScaled = i > 0 ? oscScaled[i - 1] : undefined;
    const prevClose = i > 0 ? closes[i - 1] : undefined;
    rawDist[i] = (Number.isFinite(prevScaled) && Number.isFinite(prevClose))
      ? prevClose - prevScaled
      : undefined;
  }

  const absDist = rawDist.map((d) => (Number.isFinite(d) ? Math.abs(d) : undefined));
  const meanAbs = timeMeanAbs(times, absDist, distSec, MIN_AMP_PERIODS);

  const osc = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const d = rawDist[i];
    const amp = Number.isFinite(meanAbs[i]) ? meanAbs[i] * AMP_SCALE : undefined;
    osc[i] = (Number.isFinite(d) && Number.isFinite(amp))
      ? clamp(d / Math.max(amp, EPS), -1, 1)
      : undefined;
  }
  return osc;
}

function calculate(targetBars, { timeframe = '4h', lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const targets = dedupeAndSort(targetBars);
  if (targets.length === 0) return [];

  const computeBars = targets;
  if (computeBars.length === 0) {
    return targets.map((bar) => ({ time: normalizeTimestamp(bar.t) }));
  }

  const osc = computeOscillator(computeBars, lookbackDays);
  const computeTimes = computeBars.map((bar) => normalizeTimestamp(bar.t));

  const rows = new Array(targets.length);
  let ci = 0;
  for (let ti = 0; ti < targets.length; ti += 1) {
    const t = normalizeTimestamp(targets[ti].t);
    while (ci + 1 < computeTimes.length && computeTimes[ci + 1] <= t) ci += 1;
    const value = computeTimes[ci] <= t ? osc[ci] : undefined;
    rows[ti] = Number.isFinite(value)
      ? { time: t, value, color: colorForValue(value) }
      : { time: t };
  }
  return rows;
}

const CvdOscillator = { calculate };

export { CvdOscillator, BEAR_COLOR, BULL_COLOR, NEUTRAL_COLOR, colorForValue };
export default CvdOscillator;
