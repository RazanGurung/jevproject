/**
 * Monthly Volume Profile — per-calendar-month horizontal volume histograms.
 *
 * Ported from PineScript "monthly volume profiles":
 *   - Bars are grouped by UTC calendar month (Pine groups by the chart's
 *     exchange timezone; this port uses UTC).
 *   - Each month's high-low range is split into 100 price bins (doubled from 50
 *     for higher accuracy); every bar's volume is spread evenly across the bins
 *     its high-low span covers.
 *   - Each non-empty bin renders as a horizontal box anchored at the month's
 *     first bar, width and opacity scaled by pow(binVol / maxBinVol, contrast).
 *   - The POC (first bin holding the max volume) renders as a horizontal line
 *     from month start to the latest bar — aqua when close >= POC, red below.
 *   - Value Area High (VAH) and Value Area Low (VAL) encompass 70% of total
 *     volume expanding outward from the POC; Value Area bins render with full
 *     contrast while extreme tails render softly.
 *   - Keeps the last 6 months, capped at 4800 bars; months with fewer than
 *     5 bars or a degenerate price range are skipped.
 *
 * Rendering uses a lightweight-charts series primitive attached to the candle
 * series (the first primitive in this codebase): boxes are drawn in bitmap
 * coordinate space and track pan/zoom automatically. Month-start x positions
 * come from timeToIndex + logicalToCoordinate so months scrolled off-screen
 * still anchor correctly (timeToCoordinate would return null there).
 *
 * Lifecycle follows the vwap-bands.js overlay pattern:
 *   - setCandles(candles, coin, timeframe) — full recompute
 *   - updateLast(candles, timeframe)       — live tick (POC right edge)
 *   - applyTheme()                         — palette refresh
 *   - detach()                             — clean up
 */

import { colorRgbChannels, getPaletteColor } from '../services/color-palette.js';
export { calculateVolumeProfilesAsync } from './indicator-worker-pool.js';

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
// Oldest slice at the history edge is omitted until the calendar open is
// loaded. Otherwise its POC jumps when prepended bars fill the missing open.
const PERIOD_OPEN_SLACK_SEC = 24 * 3600;

const normalizeTimestamp = (time) => {
  const raw = Number(time || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 100000000000 ? Math.floor(raw / 1000) : Math.floor(raw);
};

function dedupeAndSort(candles) {
  const byTime = new Map();
  for (const c of candles) {
    const t = normalizeTimestamp(c?.t);
    if (Number.isFinite(t) && t > 0) byTime.set(t, c);
  }
  return [...byTime.values()].sort((a, b) =>
    normalizeTimestamp(a.t) - normalizeTimestamp(b.t));
}

function monthKey(timeSec) {
  const d = new Date(timeSec * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function monthStartSec(date) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

function monthEndSec(date) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000);
}

function quarterKey(timeSec) {
  const d = new Date(timeSec * 1000);
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
}

function quarterStartSec(date) {
  const qMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return Math.floor(Date.UTC(date.getUTCFullYear(), qMonth, 1) / 1000);
}

function quarterEndSec(date) {
  const qMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return Math.floor(Date.UTC(date.getUTCFullYear(), qMonth + 3, 1) / 1000);
}

function themePalette() {
  const profile = colorRgbChannels(getPaletteColor('profile'));
  return { box: profile, poc: profile };
}

/**
 * Identifies up to 3 Points of Control (POCs) from a profile's volume-at-price distribution.
 * 1. Global maximum is the primary POC (rank 1, largest volume).
 * 2. Identifies local maxima (peaks) across the price bins.
 * 3. Selects secondary and tertiary peaks with minimum spatial separation (cluster suppression)
 *    so multiple POCs capture distinct high-volume nodes rather than adjacent bins of the same peak.
 * 4. Falls back to next highest volume bins if fewer than 3 local peaks exist.
 * Returns array of up to 3 POCs sorted by volume descending: [{ price, volume, index, rank }].
 */
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

  // Pass 1: Select candidate peaks respecting minimum spatial separation
  for (const cand of candidatePeaks) {
    if (selected.length >= 3) break;
    const tooClose = selected.some((s) => Math.abs(s.index - cand.index) < minDistance);
    if (!tooClose) {
      selected.push(cand);
    }
  }

  // Pass 2: If fewer than 3, relax distance and take remaining candidate peaks
  if (selected.length < 3) {
    for (const cand of candidatePeaks) {
      if (selected.length >= 3) break;
      if (!selected.some((s) => s.index === cand.index)) {
        selected.push(cand);
      }
    }
  }

  // Pass 3: If still fewer than 3, fill from remaining positive volume bins (volume descending)
  if (selected.length < 3) {
    const remainingBins = [];
    for (let b = 0; b < bins; b += 1) {
      if (vols[b] > 0 && !selected.some((s) => s.index === b)) {
        remainingBins.push({ index: b, volume: vols[b] });
      }
    }
    remainingBins.sort((a, b) => b.volume - a.volume || a.index - b.index);
    for (const cand of remainingBins) {
      if (selected.length >= 3) break;
      selected.push(cand);
    }
  }

  selected.sort((a, b) => b.volume - a.volume || a.index - b.index);

  return selected.map((s, idx) => ({
    price: lo + (s.index + 0.5) * binH,
    volume: s.volume,
    index: s.index,
    rank: idx + 1,
  }));
}

/**
 * Pure computation: candles -> per-period (quarterly, monthly, or visible range) profiles, oldest first.
 * Returns [{ startTime, endTime, period, periodStart, periodEnd, barCount, lo, hi, pocPrice, pocs,
 *            bins: [{ priceLow, priceHigh, fraction, inValueArea }] }]
 * where fraction = binVolume / maxBinVolume (only bins with volume included).
 */
export function computeVolumeProfiles(candles, options = {}) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const period = ['monthly', 'quarterly'].includes(opts.period) ? opts.period : 'visible';
  const isQuarterly = period === 'quarterly';
  const isVisible = period === 'visible';

  const sorted = dedupeAndSort(Array.isArray(candles) ? candles : [])
    .slice(-opts.maxBars);

  const keyFn = isQuarterly ? quarterKey : monthKey;
  const startFn = isQuarterly ? quarterStartSec : monthStartSec;
  const endFn = isQuarterly ? quarterEndSec : monthEndSec;
  const keepCount = isVisible ? 1 : (isQuarterly
    ? (Number(opts.keepQuarters) || 4)
    : (Number(opts.keepMonths) || 6));

  const groups = [];
  if (isVisible) {
    if (sorted.length > 0) groups.push(sorted);
  } else {
    let currentKey = null;
    for (const c of sorted) {
      const t = normalizeTimestamp(c.t);
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

    const startTime = normalizeTimestamp(bars[0].t);
    const startDate = new Date(startTime * 1000);
    const periodStart = isVisible ? startTime : startFn(startDate);
    const periodEnd = isVisible ? normalizeTimestamp(bars[bars.length - 1].t) : endFn(startDate);
    const isLatest = isVisible || groupIndex === kept.length - 1;
    if (!isLatest && startTime > periodStart + PERIOD_OPEN_SLACK_SEC) continue;

    let lo = Infinity;
    let hi = -Infinity;
    for (const c of bars) {
      const h = +c.h;
      const l = +c.l;
      if (Number.isFinite(l)) lo = Math.min(lo, l);
      if (Number.isFinite(h)) hi = Math.max(hi, h);
    }
    if (!(hi > lo)) continue;

    const binH = (hi - lo) / opts.bins;
    const vols = new Array(opts.bins).fill(0);
    const firstBarTime = new Array(opts.bins).fill(null);
    const lastBarTime = new Array(opts.bins).fill(null);
    const firstBarIdx = new Array(opts.bins).fill(null);
    const lastBarIdx = new Array(opts.bins).fill(null);

    for (let barIdx = 0; barIdx < bars.length; barIdx += 1) {
      const c = bars[barIdx];
      const v = +c.v;
      if (!Number.isFinite(v) || v <= 0) continue;
      const h = +c.h;
      const l = +c.l;
      if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
      const b0 = Math.max(0, Math.min(opts.bins - 1, Math.floor((l - lo) / binH)));
      const b1 = Math.max(0, Math.min(opts.bins - 1, Math.floor((h - lo) / binH)));
      const per = v / (b1 - b0 + 1);
      const t = normalizeTimestamp(c.t);
      for (let b = b0; b <= b1; b += 1) {
        vols[b] += per;
        if (firstBarTime[b] === null) {
          firstBarTime[b] = t;
          firstBarIdx[b] = barIdx;
        }
        lastBarTime[b] = t;
        lastBarIdx[b] = barIdx;
      }
    }

    let maxVol = 0;
    let pocIdx = 0;
    let totalVol = 0;
    for (let b = 0; b < opts.bins; b += 1) {
      totalVol += vols[b];
      if (vols[b] > maxVol) {
        maxVol = vols[b];
        pocIdx = b;
      }
    }
    if (maxVol <= 0) continue;

    // Low Volume Node (LVN) boxes — computed just for the visible range profile.
    // Ported from PineScript pecker19 LVN Zones:
    // - Bins where vol < maxVol * lvnThreshold form contiguous low volume zones.
    // - leftBar is min(firstBar), rightBar is max(lastBar) across bins in the zone.
    // - Box bounds are top/bottom prices and left/right bar times.
    const lvnBoxes = [];
    if (isVisible) {
      const lvnThreshold = Number.isFinite(opts.lvnThreshold) ? opts.lvnThreshold : 0.10;
      const maxLvnBoxes = Number.isFinite(opts.maxLvnBoxes) ? opts.maxLvnBoxes : 30;

      const getZoneBounds = (startB, endB) => {
        let leftTime = null;
        let rightTime = null;
        let leftIdx = null;
        let rightIdx = null;
        let zoneVol = 0;
        for (let bb = startB; bb <= endB; bb += 1) {
          if (firstBarTime[bb] !== null) {
            leftTime = leftTime === null ? firstBarTime[bb] : Math.min(leftTime, firstBarTime[bb]);
            rightTime = rightTime === null ? lastBarTime[bb] : Math.max(rightTime, lastBarTime[bb]);
            leftIdx = leftIdx === null ? firstBarIdx[bb] : Math.min(leftIdx, firstBarIdx[bb]);
            rightIdx = rightIdx === null ? lastBarIdx[bb] : Math.max(rightIdx, lastBarIdx[bb]);
          }
          zoneVol += vols[bb];
        }
        return { leftTime, rightTime, leftIdx, rightIdx, zoneVol };
      };

      const commitZoneLvn = (startB, endB, top, bot) => {
        if (lvnBoxes.length >= maxLvnBoxes) return;
        const bounds = getZoneBounds(startB, endB);
        if (bounds.leftTime === null || bounds.rightTime === null) return;
        lvnBoxes.push({
          top,
          bottom: bot,
          startTime: bounds.leftTime,
          endTime: bounds.rightTime,
          startIndex: bounds.leftIdx,
          endIndex: bounds.rightIdx,
          volume: bounds.zoneVol,
        });
      };

      let inLVN = false;
      let startB = null;
      for (let b = 0; b < opts.bins; b += 1) {
        if (lvnBoxes.length >= maxLvnBoxes) break;
        const isLow = vols[b] < maxVol * lvnThreshold;
        if (isLow && !inLVN) {
          inLVN = true;
          startB = b;
        }
        if (!isLow && inLVN) {
          inLVN = false;
          commitZoneLvn(startB, b - 1, lo + b * binH, lo + startB * binH);
          startB = null;
        }
      }
      if (inLVN && startB !== null && lvnBoxes.length < maxLvnBoxes) {
        commitZoneLvn(startB, opts.bins - 1, hi, lo + startB * binH);
      }
    }

    // Auction Market Theory: Value Area encompasses 70% of total volume expanding outward from POC.
    const targetVaVol = Math.max(0, Number(opts.valueAreaPct || 0.70)) * totalVol;
    let vaVol = vols[pocIdx];
    let vaUpper = pocIdx;
    let vaLower = pocIdx;

    while (vaVol < targetVaVol && (vaUpper < opts.bins - 1 || vaLower > 0)) {
      const nextUp = vaUpper + 1 < opts.bins ? vols[vaUpper + 1] : -1;
      const nextDown = vaLower - 1 >= 0 ? vols[vaLower - 1] : -1;
      if (nextUp >= nextDown) {
        vaUpper += 1;
        vaVol += nextUp;
      } else {
        vaLower -= 1;
        vaVol += nextDown;
      }
    }

    const vahPrice = lo + (vaUpper + 1) * binH;
    const valPrice = lo + vaLower * binH;

    const profileBins = [];
    for (let b = 0; b < opts.bins; b += 1) {
      if (vols[b] <= 0) continue;
      profileBins.push({
        priceLow: lo + b * binH,
        priceHigh: lo + (b + 1) * binH,
        fraction: vols[b] / maxVol,
        inValueArea: b >= vaLower && b <= vaUpper,
      });
    }

    const pocs = findProfilePocs(vols, lo, binH, opts.bins, pocIdx, maxVol);

    profiles.push({
      startTime,
      endTime: normalizeTimestamp(bars[bars.length - 1].t),
      period,
      periodStart,
      periodEnd,
      monthStart: periodStart,
      monthEnd: periodEnd,
      barCount: bars.length,
      lo,
      hi,
      pocPrice: pocs[0]?.price ?? (lo + (pocIdx + 0.5) * binH),
      pocs,
      vahPrice,
      valPrice,
      bins: profileBins,
      lvnBoxes,
    });
  }

  return profiles;
}

export function computeMonthlyVolumeProfiles(candles, options = {}) {
  return computeVolumeProfiles(candles, { ...options, period: options?.period || 'monthly' });
}

export function createMonthlyVolumeProfileOverlay({ getChart, getCandleSeries, options } = {}) {
  if (typeof getChart !== 'function' || typeof getCandleSeries !== 'function') {
    throw new Error('createMonthlyVolumeProfileOverlay requires getChart, getCandleSeries');
  }
  const opts = { ...DEFAULTS, ...(options || {}) };

  const state = {
    profiles: [],
    lastBarTime: 0,
    palette: themePalette(),
    visibleCacheKey: '',
    visibleProfiles: [],
  };

  let attachedChart = null;
  let attachedSeries = null;
  let requestUpdate = null;
  let lastSig = '';
  let lastCoin = '';
  let lastSnapshotRevision = -1;

  function candlesSignature(candles, coin) {
    if (!Array.isArray(candles) || candles.length === 0) return '0';
    const first = candles[0];
    const last = candles[candles.length - 1];
    return `${coin}:${candles.length}:${first?.t || 0}:${last?.t || 0}:${last?.c || 0}:${last?.v || 0}`;
  }

  function draw(target) {
    if (!attachedChart || !attachedSeries || state.profiles.length === 0) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const ts = attachedChart.timeScale();
      const isVisible = opts.period === 'visible';
      let profilesToDraw = state.profiles;
      let visibleX0 = null;
      let visibleMaxWidthPx = null;
      let visibleXRight = null;
      let visibleLogicalFrom = 0;

      if (isVisible) {
        const vlr = ts.getVisibleLogicalRange?.();
        if (vlr && Number.isFinite(vlr.from) && Number.isFinite(vlr.to) && lastCandles.length > 0) {
          const iFrom = Math.max(0, Math.floor(vlr.from));
          const iTo = Math.min(lastCandles.length - 1, Math.ceil(vlr.to));
          visibleLogicalFrom = iFrom;
          if (iTo - iFrom + 1 >= opts.minBars) {
            const cacheKey = `${iFrom}:${iTo}:${lastCandles.length}:${state.lastBarTime}`;
            if (state.visibleCacheKey !== cacheKey) {
              state.visibleCacheKey = cacheKey;
              const visibleBars = lastCandles.slice(iFrom, iTo + 1);
              state.visibleProfiles = computeVolumeProfiles(visibleBars, { ...opts, period: 'visible' });
            }
            profilesToDraw = state.visibleProfiles;

            const coordFrom = ts.logicalToCoordinate(iFrom);
            const coordTo = ts.logicalToCoordinate(iTo);
            visibleX0 = coordFrom != null ? Math.max(0, coordFrom) : 0;
            visibleXRight = coordTo != null ? coordTo : (visibleX0 + 400);
            const visibleWidth = Math.max(100, visibleXRight - visibleX0);
            visibleMaxWidthPx = Math.max(20, visibleWidth * 0.35);
          } else {
            profilesToDraw = [];
          }
        }
      }

      for (const profile of profilesToDraw) {
        let x0, maxWidthPx, xRight;
        if (isVisible) {
          x0 = visibleX0 != null ? visibleX0 : 0;
          maxWidthPx = visibleMaxWidthPx != null ? visibleMaxWidthPx : 200;
          xRight = visibleXRight != null ? visibleXRight : (x0 + 400);

          // Render Low Volume Node (LVN) boxes for visible range profile
          if (opts.showLvn !== false && Array.isArray(profile.lvnBoxes) && profile.lvnBoxes.length > 0) {
            for (const lvn of profile.lvnBoxes) {
              let iStart = typeof ts.timeToIndex === 'function' ? ts.timeToIndex(lvn.startTime, true) : null;
              let iEnd = typeof ts.timeToIndex === 'function' ? ts.timeToIndex(lvn.endTime, true) : null;
              if (iStart === null || iStart === undefined) {
                iStart = lvn.startIndex != null ? (visibleLogicalFrom + lvn.startIndex) : null;
              }
              if (iEnd === null || iEnd === undefined) {
                iEnd = lvn.endIndex != null ? (visibleLogicalFrom + lvn.endIndex) : null;
              }
              if (iStart === null || iEnd === null) continue;

              const x0Coord = ts.logicalToCoordinate(iStart);
              const x1Coord = ts.logicalToCoordinate(iEnd);
              if (x0Coord === null && x1Coord === null) continue;
              const validX0 = x0Coord !== null ? x0Coord : (x1Coord !== null ? x1Coord - 10 : 0);
              const validX1 = x1Coord !== null ? x1Coord : (x0Coord !== null ? x0Coord + 10 : validX0 + 20);

              const xNext = ts.logicalToCoordinate(Math.max(iStart, iEnd) + 1);
              const xPrev = ts.logicalToCoordinate(Math.min(iStart, iEnd) - 1);
              let barSpacing = 6;
              if (xNext !== null) {
                barSpacing = Math.max(1, Math.abs(xNext - Math.max(validX0, validX1)));
              } else if (xPrev !== null) {
                barSpacing = Math.max(1, Math.abs(Math.min(validX0, validX1) - xPrev));
              }

              const leftX = Math.min(validX0, validX1) - barSpacing / 2;
              const rightX = Math.max(validX0, validX1) + barSpacing / 2;
              const widthPx = Math.max(2, rightX - leftX);

              const yTop = attachedSeries.priceToCoordinate(lvn.top);
              const yBot = attachedSeries.priceToCoordinate(lvn.bottom);
              if (yTop === null || yBot === null) continue;

              const boxY = Math.min(yTop, yBot);
              const boxHeight = Math.max(1, Math.abs(yBot - yTop));

              if (ctx?.canvas?.height) {
                const canvasH = Number(ctx.canvas.height) / (vpr || 1);
                if (boxY + boxHeight < -50 || boxY > canvasH + 50) continue;
              }

              ctx.save();
              ctx.fillStyle = `rgba(${state.palette.box}, 0.12)`;
              ctx.fillRect(leftX * hpr, boxY * vpr, widthPx * hpr, boxHeight * vpr);
              ctx.strokeStyle = `rgba(${state.palette.box}, 0.22)`;
              ctx.lineWidth = Math.max(1, 1 * vpr);
              if (typeof ctx.strokeRect === 'function') {
                ctx.strokeRect(leftX * hpr, boxY * vpr, widthPx * hpr, boxHeight * vpr);
              } else if (typeof ctx.rect === 'function') {
                ctx.beginPath();
                ctx.rect(leftX * hpr, boxY * vpr, widthPx * hpr, boxHeight * vpr);
                ctx.stroke();
              } else {
                ctx.beginPath();
                ctx.moveTo(leftX * hpr, boxY * vpr);
                ctx.lineTo((leftX + widthPx) * hpr, boxY * vpr);
                ctx.lineTo((leftX + widthPx) * hpr, (boxY + boxHeight) * vpr);
                ctx.lineTo(leftX * hpr, (boxY + boxHeight) * vpr);
                ctx.lineTo(leftX * hpr, boxY * vpr);
                ctx.stroke();
              }
              ctx.restore();
            }
          }
        } else {
          const i0 = ts.timeToIndex(profile.startTime, true);
          if (i0 === null || i0 === undefined) continue;
          x0 = ts.logicalToCoordinate(i0);
          const x1 = ts.logicalToCoordinate(i0 + 1);
          if (x0 === null || x1 === null) continue;
          const barSpacing = x1 - x0;
          maxWidthPx = Math.max(1, profile.barCount * opts.widthPct * barSpacing);
          const iLast = ts.timeToIndex(state.lastBarTime, true);
          xRight = (iLast !== null && iLast !== undefined) ? ts.logicalToCoordinate(iLast) : null;
        }

        for (const bin of profile.bins) {
          const yTop = attachedSeries.priceToCoordinate(bin.priceHigh);
          const yBot = attachedSeries.priceToCoordinate(bin.priceLow);
          if (yTop === null || yBot === null) continue;
          const intensity = Math.pow(bin.fraction, opts.contrast);
          const widthPx = Math.max(1, intensity * maxWidthPx);
          // Value Area bins have prominent contrast (0.35..0.90); extreme tails are softer (0.15..0.45)
          const alpha = bin.inValueArea
            ? 0.35 + 0.55 * intensity
            : 0.15 + 0.30 * intensity;
          ctx.fillStyle = `rgba(${state.palette.box}, ${alpha.toFixed(3)})`;
          ctx.fillRect(x0 * hpr, yTop * vpr, widthPx * hpr, Math.max(1, (yBot - yTop) * vpr));
        }

        if (isVisible && Array.isArray(profile.pocs) && profile.pocs.length > 0) {
          // Render in reverse order (rank 3 -> rank 2 -> rank 1) so the largest POC is drawn on top
          const pocsToDraw = [...profile.pocs].reverse();
          for (const poc of pocsToDraw) {
            const yPoc = attachedSeries.priceToCoordinate(poc.price);
            if (yPoc !== null && xRight !== null) {
              const widthMultiplier = poc.rank === 1 ? 3 : (poc.rank === 2 ? 2 : 1);
              ctx.save();
              ctx.strokeStyle = `rgba(${state.palette.poc}, 0.8)`;
              ctx.lineWidth = Math.max(widthMultiplier, widthMultiplier * vpr);
              ctx.lineCap = 'round';
              ctx.setLineDash([1 * hpr, 4 * hpr]);
              ctx.beginPath();
              ctx.moveTo(x0 * hpr, yPoc * vpr);
              ctx.lineTo(xRight * hpr, yPoc * vpr);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.restore();
            }
          }
        } else {
          const yPoc = attachedSeries.priceToCoordinate(profile.pocPrice);
          if (yPoc !== null && xRight !== null) {
            ctx.save();
            ctx.strokeStyle = `rgba(${state.palette.poc}, 0.8)`;
            ctx.lineWidth = Math.max(1, 1 * vpr);
            ctx.lineCap = 'round';
            ctx.setLineDash([1 * hpr, 4 * hpr]);
            ctx.beginPath();
            ctx.moveTo(x0 * hpr, yPoc * vpr);
            ctx.lineTo(xRight * hpr, yPoc * vpr);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      }
    });
  }

  const paneView = {
    zOrder: () => 'bottom',
    renderer: () => ({ draw }),
  };

  const primitive = {
    attached(params) {
      requestUpdate = params?.requestUpdate || null;
    },
    detached() {
      requestUpdate = null;
    },
    updateAllViews() {},
    paneViews: () => [paneView],
  };

  function redraw() {
    if (typeof requestUpdate === 'function') {
      try { requestUpdate(); } catch {}
    }
  }

  function detach() {
    if (attachedSeries && typeof attachedSeries.detachPrimitive === 'function') {
      // The recreate path removes the candle series before notifying, so the
      // series may already be gone here.
      try { attachedSeries.detachPrimitive(primitive); } catch {}
    }
    attachedChart = null;
    attachedSeries = null;
    requestUpdate = null;
    state.profiles = [];
    state.visibleProfiles = [];
    state.visibleCacheKey = '';
    state.lastBarTime = 0;
    lastSig = '';
    lastSnapshotRevision = -1;
  }

  function attachIfNeeded() {
    const chart = getChart();
    const series = getCandleSeries();
    if (!chart || !series) return false;
    if (attachedChart === chart && attachedSeries === series) return true;
    detach();
    if (typeof series.attachPrimitive !== 'function') return false;
    try {
      // Hidden overlays do not receive an applyTheme pass. Resolve the live
      // palette at attachment so enabling this indicator after a color change
      // cannot resurrect the construction-time default.
      state.palette = themePalette();
      series.attachPrimitive(primitive);
      attachedChart = chart;
      attachedSeries = series;
      return true;
    } catch (err) {
      console.warn('[monthly-volume-profile] attach failed:', err);
      attachedChart = null;
      attachedSeries = null;
      return false;
    }
  }

  let lastCandles = [];
  let lastTimeframe = '4h';

  function setCandles(candles, coin = '', timeframe = '4h', snapshotRevision = 0) {
    lastCandles = Array.isArray(candles) ? candles : [];
    lastTimeframe = timeframe;
    if (coin !== lastCoin) {
      detach();
    }
    if (!attachIfNeeded()) return;
    const sig = `${opts.period}:${candlesSignature(candles, coin)}`;
    if (snapshotRevision === lastSnapshotRevision && sig === lastSig && coin === lastCoin) return;
    lastCoin = coin;
    lastSig = sig;
    lastSnapshotRevision = snapshotRevision;

    const sorted = dedupeAndSort(lastCandles);
    state.profiles = computeVolumeProfiles(sorted, opts);
    const last = sorted[sorted.length - 1];
    state.lastBarTime = last ? normalizeTimestamp(last.t) : 0;
    redraw();
  }

  function updateLast(candles, timeframe = '4h') {
    if (!attachedSeries) return;
    if (!Array.isArray(candles) || candles.length === 0) return;
    // Live ticks only move the POC right edge; the bins themselves are
    // rebuilt from confirmed bars on the next full sync.
    const last = candles[candles.length - 1];
    const t = normalizeTimestamp(last?.t);
    if (t > 0) state.lastBarTime = Math.max(state.lastBarTime, t);
    redraw();
  }

  function setPeriod(period) {
    const nextPeriod = ['monthly', 'quarterly'].includes(period) ? period : 'visible';
    if (opts.period === nextPeriod) return;
    opts.period = nextPeriod;
    lastSig = '';
    state.visibleCacheKey = '';
    if (attachedSeries && lastCandles.length > 0) {
      setCandles(lastCandles, lastCoin, lastTimeframe, lastSnapshotRevision);
    }
  }

  function setLvnVisible(visible) {
    const nextVisible = visible !== false;
    if (opts.showLvn === nextVisible) return;
    opts.showLvn = nextVisible;
    redraw();
  }

  function getLvnVisible() {
    return opts.showLvn !== false;
  }

  function applyTheme() {
    state.palette = themePalette();
    redraw();
  }

  const getDebugState = () => ({
    attached: Boolean(attachedChart && attachedSeries),
    profileCount: state.profiles.length,
    lastBarTime: state.lastBarTime,
    period: opts.period,
    bins: opts.bins,
    lvnCount: (opts.period === 'visible' && state.visibleProfiles[0]?.lvnBoxes)
      ? state.visibleProfiles[0].lvnBoxes.length
      : (state.profiles[0]?.lvnBoxes?.length || 0),
    lvnVisible: opts.showLvn !== false,
    pocCount: (opts.period === 'visible' && state.visibleProfiles[0]?.pocs)
      ? state.visibleProfiles[0].pocs.length
      : (state.profiles[0]?.pocs?.length || 0),
  });
  return { setCandles, updateLast, applyTheme, detach, setPeriod, getPeriod: () => opts.period, setLvnVisible, getLvnVisible, getDebugState };
}

export { createMonthlyVolumeProfileOverlay as createVolumeProfileOverlay };
