/**
 * Self-contained pure indicator computation functions for Web Worker execution.
 * These functions have zero DOM, window, or framework dependencies and can run
 * either inside a Web Worker thread or directly on the main thread as a fallback.
 */

export const normalizeTimestamp = (time) => {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
};

export function dedupeAndSort(candles) {
  const byTime = new Map();
  for (const c of candles) {
    const t = normalizeTimestamp(c?.t ?? c?.time);
    if (Number.isFinite(t) && t > 0) byTime.set(t, c);
  }
  return [...byTime.values()].sort((a, b) =>
    normalizeTimestamp(a?.t ?? a?.time) - normalizeTimestamp(b?.t ?? b?.time));
}

export function monthKey(timeSec) {
  const d = new Date(timeSec * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

export function monthStartSec(date) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

export function monthEndSec(date) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000);
}

export function quarterKey(timeSec) {
  const d = new Date(timeSec * 1000);
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
}

export function quarterStartSec(date) {
  const qMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return Math.floor(Date.UTC(date.getUTCFullYear(), qMonth, 1) / 1000);
}

export function quarterEndSec(date) {
  const qMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return Math.floor(Date.UTC(date.getUTCFullYear(), qMonth + 3, 1) / 1000);
}

export function findProfilePocs(vols, lo, binH, numBins = 100, knownPocIdx = -1, knownMaxVol = 0) {
  if (!Array.isArray(vols) || vols.length === 0) return [];
  const bins = vols.length;

  let maxVol = knownMaxVol;
  let pocIdx = knownPocIdx;
  if (pocIdx < 0 || maxVol <= 0) {
    maxVol = 0;
    pocIdx = 0;
    for (let b = 0; b < bins; b += 1) {
      if (vols[b] > maxVol) {
        maxVol = vols[b];
        pocIdx = b;
      }
    }
  }
  if (maxVol <= 0) return [];

  const candidatePeaks = [];
  let i = 0;
  while (i < bins) {
    if (vols[i] <= 0) {
      i += 1;
      continue;
    }
    const start = i;
    while (i + 1 < bins && vols[i + 1] === vols[start]) {
      i += 1;
    }
    const end = i;
    const prevVol = start > 0 ? vols[start - 1] : 0;
    const nextVol = end < bins - 1 ? vols[end + 1] : 0;
    if (vols[start] >= prevVol && vols[start] >= nextVol && (vols[start] > prevVol || vols[start] > nextVol)) {
      candidatePeaks.push({ index: start, volume: vols[start] });
    }
    i += 1;
  }

  if (!candidatePeaks.some((p) => p.index === pocIdx)) {
    candidatePeaks.push({ index: pocIdx, volume: maxVol });
  }

  candidatePeaks.sort((a, b) => b.volume - a.volume || a.index - b.index);

  const minDistance = Math.max(2, Math.floor(bins * 0.03));
  const selected = [];

  for (const cand of candidatePeaks) {
    if (selected.length >= 3) break;
    const tooClose = selected.some((s) => Math.abs(s.index - cand.index) < minDistance);
    if (!tooClose) selected.push(cand);
  }

  if (selected.length < 3) {
    for (const cand of candidatePeaks) {
      if (selected.length >= 3) break;
      if (!selected.some((s) => s.index === cand.index)) selected.push(cand);
    }
  }

  return selected.map((s, idx) => ({
    price: lo + (s.index + 0.5) * binH,
    volume: s.volume,
    index: s.index,
    rank: idx + 1,
  }));
}

export function computeVolumeProfilesPure(candles, options = {}) {
  const DEFAULTS = {
    period: 'visible',
    keepMonths: 6,
    keepQuarters: 4,
    maxBars: 4800,
    bins: 100,
    minBars: 5,
    contrast: 2.0,
    widthPct: 0.6,
    valueAreaPct: 0.70,
    showLvn: true,
    lvnThreshold: 0.10,
    maxLvnBoxes: 30,
  };
  const opts = { ...DEFAULTS, ...(options || {}) };
  const period = ['monthly', 'quarterly'].includes(opts.period) ? opts.period : 'visible';
  const isQuarterly = period === 'quarterly';
  const isVisible = period === 'visible';

  const sorted = dedupeAndSort(Array.isArray(candles) ? candles : []).slice(-opts.maxBars);
  const keyFn = isQuarterly ? quarterKey : monthKey;
  const startFn = isQuarterly ? quarterStartSec : monthStartSec;
  const endFn = isQuarterly ? quarterEndSec : monthEndSec;
  const keepCount = isVisible ? 1 : (isQuarterly ? (Number(opts.keepQuarters) || 4) : (Number(opts.keepMonths) || 6));

  const groups = [];
  if (isVisible) {
    if (sorted.length > 0) groups.push(sorted);
  } else {
    let currentKey = null;
    for (const c of sorted) {
      const t = normalizeTimestamp(c.t ?? c.time);
      const key = keyFn(t);
      if (key !== currentKey) {
        currentKey = key;
        groups.push([]);
      }
      groups[groups.length - 1].push(c);
    }
  }

  const profiles = [];
  const kept = groups.slice(-keepCount);
  for (let groupIndex = 0; groupIndex < kept.length; groupIndex += 1) {
    const bars = kept[groupIndex];
    if (bars.length < opts.minBars) continue;

    const startTime = normalizeTimestamp(bars[0].t ?? bars[0].time);
    const startDate = new Date(startTime * 1000);
    const periodStart = isVisible ? startTime : startFn(startDate);
    const periodEnd = isVisible ? normalizeTimestamp(bars[bars.length - 1].t ?? bars[bars.length - 1].time) : endFn(startDate);

    let lo = Infinity;
    let hi = -Infinity;
    for (const c of bars) {
      const h = +(c.h ?? c.high);
      const l = +(c.l ?? c.low);
      if (Number.isFinite(l)) lo = Math.min(lo, l);
      if (Number.isFinite(h)) hi = Math.max(hi, h);
    }
    if (!(hi > lo)) continue;

    const binH = (hi - lo) / opts.bins;
    const vols = new Array(opts.bins).fill(0);
    for (let barIdx = 0; barIdx < bars.length; barIdx += 1) {
      const c = bars[barIdx];
      const v = +(c.v ?? c.volume ?? 1);
      const h = +(c.h ?? c.high);
      const l = +(c.l ?? c.low);
      if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
      const b0 = Math.max(0, Math.min(opts.bins - 1, Math.floor((l - lo) / binH)));
      const b1 = Math.max(0, Math.min(opts.bins - 1, Math.floor((h - lo) / binH)));
      const per = v / (b1 - b0 + 1);
      for (let b = b0; b <= b1; b += 1) vols[b] += per;
    }

    let maxVol = 0;
    let pocIdx = 0;
    for (let b = 0; b < opts.bins; b += 1) {
      if (vols[b] > maxVol) {
        maxVol = vols[b];
        pocIdx = b;
      }
    }
    if (maxVol <= 0) continue;

    const pocPrice = lo + (pocIdx + 0.5) * binH;
    const pocs = findProfilePocs(vols, lo, binH, opts.bins, pocIdx, maxVol);

    const binEntries = [];
    for (let b = 0; b < opts.bins; b += 1) {
      if (vols[b] <= 0) continue;
      binEntries.push({
        priceLow: lo + b * binH,
        priceHigh: lo + (b + 1) * binH,
        fraction: vols[b] / maxVol,
      });
    }

    profiles.push({
      startTime,
      period,
      periodStart,
      periodEnd,
      barCount: bars.length,
      lo,
      hi,
      pocPrice,
      pocs,
      bins: binEntries,
    });
  }

  return profiles;
}

export function computeHeikinAshiPure(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const result = [];
  let prevHaOpen = 0;
  let prevHaClose = 0;
  let isFirst = true;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const time = normalizeTimestamp(c.t ?? c.time);
    const open = Number(c.o ?? c.open);
    const high = Number(c.h ?? c.high);
    const low = Number(c.l ?? c.low);
    const close = Number(c.c ?? c.close);

    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || time <= 0) {
      continue;
    }

    const haClose = (open + high + low + close) / 4;
    const haOpen = isFirst ? (open + close) / 2 : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(high, haOpen, haClose);
    const haLow = Math.min(low, haOpen, haClose);

    prevHaOpen = haOpen;
    prevHaClose = haClose;
    isFirst = false;

    result.push({
      time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      isUp: haClose >= haOpen,
    });
  }

  return result;
}

export function roundPricePure(val, brickSize = 1) {
  if (!Number.isFinite(val)) return 0;
  if (brickSize >= 1) return Math.round(val * 10000) / 10000;
  if (brickSize >= 0.001) return Math.round(val * 1000000) / 1000000;
  return Math.round(val * 100000000) / 100000000;
}

export function computeATRPure(candles = [], period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) {
    const fallbackPrice = Number(candles?.[0]?.c ?? candles?.[0]?.close ?? 1);
    return Math.max(0.00000001, fallbackPrice * 0.002);
  }
  const p = Math.max(1, Math.min(period, candles.length));
  let trSum = 0;
  let count = 0;
  for (let i = Math.max(1, candles.length - p); i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (!curr || !prev) continue;
    const h = Number(curr.h ?? curr.high);
    const l = Number(curr.l ?? curr.low);
    const prevC = Number(prev.c ?? prev.close);
    if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(prevC)) {
      const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      if (Number.isFinite(tr) && tr >= 0) {
        trSum += tr;
        count++;
      }
    }
  }
  const fallbackPrice = Number(candles[candles.length - 1]?.c ?? candles[candles.length - 1]?.close ?? 1);
  const avgTr = count > 0 ? trSum / count : 0;
  if (!Number.isFinite(avgTr) || avgTr <= 0) {
    return Math.max(0.00000001, fallbackPrice * 0.002);
  }
  return Math.max(0.00000001, avgTr);
}

export function computeRenkoBricksPure(candles = [], options = {}) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { bricks: [], brickSize: 0, currentDirection: 0 };
  }

  const brickMode = options.brickMode || 'atr';
  let brickSize = 0;

  if (brickMode === 'fixed' && Number(options.fixedSize) > 0) {
    brickSize = Number(options.fixedSize);
  } else if (brickMode === 'percent') {
    const targetClose = Number(candles[candles.length - 1]?.c ?? candles[candles.length - 1]?.close ?? 1);
    const pct = Number(options.percent || 1.0) / 100;
    brickSize = Math.max(0.00000001, targetClose * pct);
  } else {
    brickSize = computeATRPure(candles, Number(options.atrPeriod) || 14);
  }

  brickSize = Math.max(0.00000001, Number(brickSize) || 1);

  let firstValid = null;
  let firstIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const time = normalizeTimestamp(c?.t ?? c?.time);
    const close = Number(c?.c ?? c?.close);
    if (Number.isFinite(close) && close > 0 && time > 0) {
      firstValid = c;
      firstIdx = i;
      break;
    }
  }
  if (!firstValid) return { bricks: [], brickSize, currentDirection: 0 };

  const bricks = [];
  let currentDirection = 0;
  const rawRef = Number(firstValid.o ?? firstValid.open ?? firstValid.c ?? firstValid.close ?? 0);
  let currentStep = Math.round(rawRef / brickSize);
  const refPrice = roundPricePure(currentStep * brickSize, brickSize);
  let currentTop = roundPricePure((currentStep + 1) * brickSize, brickSize);
  let currentBottom = roundPricePure(currentStep * brickSize, brickSize);
  const EPS = Math.max(1e-15, brickSize * 1e-6);

  for (let i = firstIdx; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    const time = normalizeTimestamp(c.t ?? c.time);
    const close = Number(c.c ?? c.close);
    if (!Number.isFinite(close) || time <= 0) continue;

    if (currentDirection === 0) {
      if (close >= refPrice + brickSize - EPS) {
        currentDirection = 1;
        currentBottom = refPrice;
        currentTop = roundPricePure(refPrice + brickSize, brickSize);
        bricks.push({ time, open: currentBottom, close: currentTop, isUp: true });
      } else if (close <= refPrice - brickSize + EPS) {
        currentDirection = -1;
        currentTop = refPrice;
        currentBottom = roundPricePure(refPrice - brickSize, brickSize);
        bricks.push({ time, open: currentTop, close: currentBottom, isUp: false });
      }
      continue;
    }

    if (currentDirection === 1) {
      while (close >= currentTop + brickSize - EPS && bricks.length < 5000) {
        currentBottom = currentTop;
        currentTop = roundPricePure(currentTop + brickSize, brickSize);
        bricks.push({ time, open: currentBottom, close: currentTop, isUp: true });
      }
      if (close <= currentBottom - brickSize + EPS) {
        currentDirection = -1;
        const newTop = currentBottom;
        currentBottom = roundPricePure(newTop - brickSize, brickSize);
        currentTop = newTop;
        bricks.push({ time, open: currentTop, close: currentBottom, isUp: false });
      }
    } else {
      while (close <= currentBottom - brickSize + EPS && bricks.length < 5000) {
        currentTop = currentBottom;
        currentBottom = roundPricePure(currentBottom - brickSize, brickSize);
        bricks.push({ time, open: currentTop, close: currentBottom, isUp: false });
      }
      if (close >= currentTop + brickSize - EPS) {
        currentDirection = 1;
        const newBottom = currentTop;
        currentTop = roundPricePure(newBottom + brickSize, brickSize);
        currentBottom = newBottom;
        bricks.push({ time, open: currentBottom, close: currentTop, isUp: true });
      }
    }
  }

  return { bricks, brickSize, currentDirection };
}

/**
 * Worker script body serialized as a string for Blob creation.
 */
export const INDICATOR_WORKER_SCRIPT = `
self.onmessage = function(e) {
  const { id, type, payload } = e.data || {};
  const start = performance.now();
  try {
    let result = null;
    if (type === 'VOLUME_PROFILES') {
      result = (${computeVolumeProfilesPure.toString()})(payload.candles, payload.options);
    } else if (type === 'HEIKIN_ASHI') {
      result = (${computeHeikinAshiPure.toString()})(payload.candles);
    } else if (type === 'RENKO_BRICKS') {
      result = (${computeRenkoBricksPure.toString()})(payload.candles, payload.options);
    } else {
      throw new Error('Unknown indicator computation type: ' + type);
    }
    const durationMs = performance.now() - start;
    self.postMessage({ id, success: true, result, durationMs });
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message, durationMs: performance.now() - start });
  }
};
`;
