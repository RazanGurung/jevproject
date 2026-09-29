/**
 * DOM ladder rendering — fixed-axis depth-of-market view in the book-panel's
 * bottom half. Rows are a uniform price grid anchored near mid (asks above,
 * bids below), so prices hold still while sizes update in place — book levels
 * and session traded volume are bucketed onto the grid each frame. The center
 * is sticky: mid walks across the fixed grid (the mid marker moves with it,
 * damped by MID_FLIP_HYSTERESIS so a boundary-hovering mid doesn't flutter it)
 * and the ladder only re-centers when mid drifts to within
 * RECENTER_EDGE_MARGIN_ROWS buckets of the visible edge. Three columns:
 * size (depth bar, colored by side), price, and session volume-at-price
 * (buy/sell split bar). Per-price buy/sell totals, whale markers, and max
 * print identity accumulate for the pair subscription and do not shrink when
 * the top FLOW rolling sample advances — that 500-print window is header-only.
 * Rows flash neutral grey as trades print, brightness weighted by the prints'
 * notional (tradeIntensity) and fading over HIGHLIGHT_TTL_MS only. Whale
 * markers are sticky for the session at their price. The ladder fills the
 * whole book-panel column — the row count is derived from the container
 * height (floored at 12 per side).
 *
 * The grid spacing is the Hyperliquid effective tick at the current mid —
 * 5-significant-figure prices make the effective tick coarser than the nominal
 * one for high-priced coins, and getHyperliquidPriceDecimals encodes that rule
 * exactly (same source of truth as price displays). When coin metadata can't
 * resolve it, the median gap between adjacent book levels (snapped up to a
 * tick multiple) approximates it instead; either way the value is sticky per
 * coin so a transient change (mid crossing a decade boundary, a thin book
 * patch) doesn't re-bucket the whole ladder.
 *
 * AppState.market.book is cleared on coin switch (resetMarketRuntimeState),
 * then immediately restored from the per-coin bookCache (state/market-book.js)
 * if the new coin has streamed a book this session — see coin-switch.js's
 * syncCoinSwitchChartCache. lastBookCoin (noted from handleBook, or from that
 * restore path directly) gates rendering: until the new coin's book — cached
 * or freshly ticked — is in place the panel shows a waiting state instead of
 * the previous coin's ladder.
 */

import { AppState } from '../state/store.js';
import { getPaletteColor } from '../services/color-palette.js';
import { getDomTradeActivity, getDomActivityVersion, HIGHLIGHT_TTL_MS } from '../state/dom-ladder-state.js';
import { getTickSize } from '../state/coin-meta.js';
import { applyTicketPrice, setOrderType } from '../ui/tabs.js';
import { fmtPrice, getHyperliquidPriceDecimals } from '../utils/format.js';
import { scheduleFrame } from '../utils/frame.js';
import { tradeIntensity } from './trades.js';
import { getDecayedWhaleEvents } from '../state/whale-response.js';

function whaleIntensity(val) {
  return Math.min(1, Math.max(0.08, Math.sqrt((parseFloat(val) || 0) / 500000)));
}

const WHALE_MARK_MIN_NOTIONAL = 100000;
const WHALE_MARK_MAX_NOTIONAL = 5000000;
const WHALE_MARK_STAGES = [
  { minNotional: WHALE_MARK_MIN_NOTIONAL, size: 3 },
  { minNotional: 250000, size: 6 },
  { minNotional: 500000, size: 9 },
  { minNotional: 1000000, size: 12 },
  { minNotional: WHALE_MARK_MAX_NOTIONAL, size: 15 },
];
const WHALE_MARK_LANE_SIZE = WHALE_MARK_STAGES[WHALE_MARK_STAGES.length - 1].size;
// Let the largest marker extend into the inter-column gap so every stage is
// centered between the price digits and the mirrored outer value column.
const WHALE_MARK_LANE_INSET = -2;
// Fixed price-spine width on the hard-set 240px DOM panel: mirrored marker
// lanes (WHALE_MARK_LANE_SIZE each side) plus room for mid-price digits.
const DOM_PRICE_SPINE_PX = WHALE_MARK_LANE_SIZE * 2 + 34;

function whaleMarkerProgress(val) {
  const notional = Math.max(WHALE_MARK_MIN_NOTIONAL, parseFloat(val) || 0);
  return Math.min(1, Math.max(0,
    Math.log(notional / WHALE_MARK_MIN_NOTIONAL)
      / Math.log(WHALE_MARK_MAX_NOTIONAL / WHALE_MARK_MIN_NOTIONAL)));
}

function whaleMarkerStage(val) {
  const notional = parseFloat(val) || 0;
  let stage = 0;
  WHALE_MARK_STAGES.forEach((entry, index) => {
    if (notional >= entry.minNotional) stage = index;
  });
  return stage;
}

// Row count adapts to the container height; never fewer than the original
// half-panel geometry (12 per side, 25 rows).
const MIN_ROWS_PER_SIDE = 12;
const ROW_HEIGHT_PX = 12;
// Spacing sampling depth stays fixed so the derived grid spacing doesn't
// change when the panel is resized.
const SPACING_SAMPLE_LEVELS = 12;
// Whale prints leave a concentric-square footprint on their row: sticky, no
// time-based fade. It shows the session's single dominant (largest) print at
// that price and persists for the pair subscription (not the top FLOW 500
// window). Five discrete sizes keep whales distinguishable through $5m
// instead of saturating at the previous $500k ceiling.
// Automatic price grouping is local to the live book. A direct drag on the
// price spine applies a per-coin session bias over this 1-2-5 baseline.
const DOM_GROUPING_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
const AUTO_DEPTH_LEVELS = 10;
const SCALE_DRAG_THRESHOLD_PX = 5;
const SCALE_DRAG_STEP_PX = 18;
// Fallback grid spacing (when the effective tick can't be resolved from coin
// metadata) snaps the median level gap to these tick multiples.
const SPACING_TICK_MULTIPLES = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000];
// A changed spacing is adopted only after it persists this long, so a passing
// thin/dense patch in the book doesn't re-bucket the whole ladder.
const SPACING_HOLD_MS = 2500;
const AUTO_GROUPING_HOLD_MS = 2500;
// The grey flash must finish fading even when the market goes quiet and no
// book/trade tick arrives to trigger the next repaint; the whale dot no
// longer decays over time, so it needs no fallback cadence of its own.
const FADE_FALLBACK_DELAY_MS = 150;

function fadeFallbackDelay(flashActive, recentWhalesActive = false) {
  return flashActive || recentWhalesActive ? FADE_FALLBACK_DELAY_MS : 0;
}

let lastBookCoin = '';
let ladderFrame = null;
let fadeTimer = null;
let grid = null; // { container, rows: [{ root, bar, size, price, volBar, vol }] }
const spacingByCoin = new Map(); // coin -> { value, candidate, candidateSince }
const autoGroupingByCoin = new Map(); // coin -> { value, candidate, candidateSince }
const manualGroupingBiasByCoin = new Map(); // session-only coin -> 1-2-5 step offset
const renderedGroupingByCoin = new Map(); // coin -> { autoIndex, index, multiplier }
// High-water max for right-column bar widths so bars do not expand when the
// current max level scrolls out of the visible window. Resets on coin/spacing.
const maxVolHighWaterByCoin = new Map(); // coin -> { spacing, maxVol }
let suppressNextPriceClick = false;
let scaleBadgeTimer = null;

// Per-frame bucket memos. The book memo keys on the book object's identity —
// setMarketBookSnapshot replaces the object on every write (WS or REST), so
// trade-only ticks and fade repaints reuse the buckets. The activity memo keys
// on domActivityVersion, bumped only when ingest actually changes the map.
let bookBucketMemo = null; // { book, spacing, bidBuckets, askBuckets }
let volBucketMemo = null;  // { coin, version, spacing, minIdx, maxIdx, buckets }

function noteDomBookCoin(coin) {
  lastBookCoin = coin || '';
}

// Drops held render state for coins no longer subscribed (called on coin
// switch alongside pruneMarketCoinCaches). A coin reintroduced after pruning
// starts over from its local automatic grouping.
function pruneSpacingCache(keepCoins = []) {
  const keep = keepCoins instanceof Set ? keepCoins : new Set(keepCoins);
  Array.from(spacingByCoin.keys()).forEach((coin) => {
    if (!keep.has(coin)) spacingByCoin.delete(coin);
  });
  Array.from(autoGroupingByCoin.keys()).forEach((coin) => {
    if (!keep.has(coin)) autoGroupingByCoin.delete(coin);
  });
  Array.from(maxVolHighWaterByCoin.keys()).forEach((coin) => {
    if (!keep.has(coin)) maxVolHighWaterByCoin.delete(coin);
  });
  Array.from(renderedGroupingByCoin.keys()).forEach((coin) => {
    if (!keep.has(coin)) renderedGroupingByCoin.delete(coin);
  });
}

// Test/debug seam. Manual zoom memory intentionally survives normal cache
// pruning so switching away and back preserves the trader's chosen scale.
function resetDomScaleState() {
  spacingByCoin.clear();
  autoGroupingByCoin.clear();
  manualGroupingBiasByCoin.clear();
  renderedGroupingByCoin.clear();
  maxVolHighWaterByCoin.clear();
  centerAnchor = null;
  midAnchor = null;
  bookBucketMemo = null;
  volBucketMemo = null;
  suppressNextPriceClick = false;
}

function getDomScaleDebugState(coin = AppState.trading.currentCoin) {
  const grouping = renderedGroupingByCoin.get(coin);
  if (!grouping) return null;
  return { ...grouping };
}

function fmtSz(sz) {
  const n = parseFloat(sz) || 0;
  if (n === 0) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(3);
}

function fmtUsd(n) {
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

// Memoized: tooltip strings are rebuilt per traded row per frame, and
// toLocaleTimeString is real Intl work — a print's clock string never changes,
// so pay for it once per timestamp.
const clockCache = new Map();
function fmtClock(t) {
  let s = clockCache.get(t);
  if (s === undefined) {
    s = new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (clockCache.size >= 256) clockCache.clear();
    clockCache.set(t, s);
  }
  return s;
}

// Row tooltip detail: the retired TRADES list's information, on demand at the
// exact price being asked about — rolling total with buy share, whale volume,
// and the largest single print.
function volDetail(vol) {
  if (!vol) return '';
  const whaleTotal = (vol.whaleBuyNotional || 0) + (vol.whaleSellNotional || 0);
  if (!(whaleTotal > 0)) return '';
  const parts = [`Whales ${fmtUsd(vol.whaleBuyNotional || 0)} buy / ${fmtUsd(vol.whaleSellNotional || 0)} sell`];
  if (vol.maxPrintNotional > 0) {
    parts.push(`Largest ${fmtUsd(vol.maxPrintNotional)} ${vol.maxPrintSide} · ${fmtClock(vol.maxPrintTime)}`);
  }
  const response = vol.latestResponse;
  if (response) {
    const label = response.status === 'follow' ? `Follow +${Math.abs(response.returnPct).toFixed(2)}%`
      : response.status === 'rejected' ? `Rejected -${Math.abs(response.returnPct).toFixed(2)}%`
        : response.status === 'absorbed' ? 'Absorbed' : 'Unknown';
    parts.push(`Result ${label}`);
  }
  return parts.slice(0, 3).join('\n');
}

function medianLevelGap(levels) {
  const gaps = [];
  const count = Math.min(SPACING_SAMPLE_LEVELS, levels.length);
  for (let i = 1; i < count; i++) {
    const gap = Math.abs(levels[i].px - levels[i - 1].px);
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// The Hyperliquid effective tick at a price: 5-significant-figure pricing
// (via getHyperliquidPriceDecimals) makes the real book granularity coarser
// than the nominal tick for high-priced coins — SOL at $150 moves in 0.01
// steps despite its 0.001 tick. Deterministic in mid alone, so the grid
// spacing can't flip-flop with book density. 0 when metadata can't resolve it.
function effectiveTick(coin, mid) {
  const decimals = getHyperliquidPriceDecimals(mid, coin);
  if (!Number.isInteger(decimals)) return 0;
  // toFixed round-trip strips binary noise (10 ** -2 -> exactly 0.01).
  const sigFigTick = Number((10 ** -decimals).toFixed(decimals));
  return Math.max(getTickSize(coin), sigFigTick);
}

// Grid spacing: the effective tick at mid; when that can't be resolved, the
// median adjacent-level gap near the top of the book snapped up to a tick
// multiple. Sticky per coin: the held value only changes once a differing
// spacing has persisted for SPACING_HOLD_MS (damps mid crossing a decade
// boundary, and book-density noise on the fallback path).
function computeGridSpacing(coin, bids, asks, now = Date.now()) {
  const tick = getTickSize(coin);
  const mid = bids.length && asks.length ? (bids[0].px + asks[0].px) / 2 : 0;
  let next = effectiveTick(coin, mid);
  if (!(next > 0)) {
    const gap = Math.max(medianLevelGap(bids), medianLevelGap(asks), tick);
    const multiple = SPACING_TICK_MULTIPLES.find((m) => m * tick >= gap - tick * 1e-6)
      || SPACING_TICK_MULTIPLES[SPACING_TICK_MULTIPLES.length - 1];
    next = multiple * tick;
  }
  const held = spacingByCoin.get(coin);
  if (!held) {
    spacingByCoin.set(coin, { value: next, candidate: 0, candidateSince: 0 });
    return next;
  }
  if (next === held.value) {
    held.candidate = 0;
    return held.value;
  }
  if (next !== held.candidate) {
    held.candidate = next;
    held.candidateSince = now;
    return held.value;
  }
  if (now - held.candidateSince < SPACING_HOLD_MS) return held.value;
  held.value = next;
  held.candidate = 0;
  return next;
}

function bucketIndex(px, spacing) {
  return Math.round(px / spacing);
}

function groupingIndex(value) {
  const numeric = Number(value);
  const index = DOM_GROUPING_STEPS.findIndex((step) => step >= numeric);
  return index >= 0 ? index : DOM_GROUPING_STEPS.length - 1;
}

function computeLocalAutoMultiplier({ baseSpacing, rowsPerSide, mid, bids = [], asks = [] } = {}) {
  if (!(baseSpacing > 0) || !(rowsPerSide > 0) || !(mid > 0)) return 5;
  const nearby = [...bids.slice(0, AUTO_DEPTH_LEVELS), ...asks.slice(0, AUTO_DEPTH_LEVELS)];
  const farthest = nearby.reduce((distance, level) => {
    const price = Number(level?.px);
    return Number.isFinite(price) ? Math.max(distance, Math.abs(price - mid)) : distance;
  }, 0);
  // Five ticks is the automatic floor: it gives a live trading ladder enough
  // headroom to avoid re-centering on ordinary micro-moves. A trader can still
  // drag upward to ×2 or ×1 for a deliberately tighter view.
  const required = farthest > 0 ? farthest / (baseSpacing * rowsPerSide) : 5;
  return DOM_GROUPING_STEPS[groupingIndex(Math.max(5, required))];
}

function heldAutoMultiplier(coin, next, now = Date.now()) {
  const held = autoGroupingByCoin.get(coin);
  if (!held) {
    autoGroupingByCoin.set(coin, { value: next, candidate: 0, candidateSince: 0 });
    return next;
  }
  if (held.value === next) {
    held.candidate = 0;
    return held.value;
  }
  if (held.candidate !== next) {
    held.candidate = next;
    held.candidateSince = now;
    return held.value;
  }
  if (now - held.candidateSince < AUTO_GROUPING_HOLD_MS) return held.value;
  held.value = next;
  held.candidate = 0;
  return held.value;
}

function resolvedGrouping(coin, autoMultiplier) {
  const autoIndex = groupingIndex(autoMultiplier);
  const bias = Number(manualGroupingBiasByCoin.get(coin)) || 0;
  const index = Math.max(0, Math.min(DOM_GROUPING_STEPS.length - 1, autoIndex + bias));
  return { multiplier: DOM_GROUPING_STEPS[index], autoIndex, index, bias: index - autoIndex };
}

// Decimal places needed to print the grid step (and thus every row price)
// exactly. Every row in a view is formatted with this count, so the price
// column keeps a stable width and precision no matter which multiplier is
// active — no trailing-zero trimming mixing "3000" with "3000.1".
function spacingDecimals(spacing) {
  if (!(spacing > 0)) return 0;
  for (let d = 0; d <= 10; d++) {
    const scaled = spacing * 10 ** d;
    // Tolerance relative to the scaled value so sub-1e-6 spacings (PEPE-scale
    // ticks) don't read as integers at d=0.
    if (Math.abs(scaled - Math.round(scaled)) < scaled * 1e-6) return d;
  }
  return 10;
}

// Displayed center row is sticky: it snaps to mid only when mid comes within
// RECENTER_EDGE_MARGIN_ROWS buckets of the ladder's visible edge (or the coin
// or spacing changes), so row prices genuinely hold still while mid wanders,
// then the ladder re-centers in one jump once price nears an edge. Scaling the
// drift allowance with the ladder height keeps the disruptive recenter jump
// equally rare on tall and short ladders (a 12-per-side ladder recenters past
// 5 buckets of drift, matching the original half-panel tuning).
const RECENTER_EDGE_MARGIN_ROWS = 7;
let centerAnchor = null; // { coin, spacing, centerIdx }

function anchoredCenterIdx(coin, spacing, midIdx, rowsPerSide) {
  const driftAllowance = Math.max(1, rowsPerSide - RECENTER_EDGE_MARGIN_ROWS);
  if (!centerAnchor
    || centerAnchor.coin !== coin
    || centerAnchor.spacing !== spacing
    || Math.abs(midIdx - centerAnchor.centerIdx) > driftAllowance) {
    centerAnchor = { coin, spacing, centerIdx: midIdx };
  }
  return centerAnchor.centerIdx;
}

// Mid-marker hysteresis: a mid hovering exactly at a bucket edge would flutter
// the marker between two rows on every tick. The marker holds its row until
// mid moves MID_FLIP_HYSTERESIS buckets past the row boundary; decisive moves
// still flip it immediately.
const MID_FLIP_HYSTERESIS = 0.25;
let midAnchor = null; // { coin, spacing, idx }

function dampedMidIdx(coin, spacing, mid) {
  const pos = mid / spacing;
  if (!midAnchor
    || midAnchor.coin !== coin
    || midAnchor.spacing !== spacing
    || Math.abs(pos - midAnchor.idx) > 0.5 + MID_FLIP_HYSTERESIS) {
    midAnchor = { coin, spacing, idx: Math.round(pos) };
  }
  return midAnchor.idx;
}

function bucketBookSide(levels, spacing, side) {
  const buckets = new Map();
  levels.forEach((level) => {
    const raw = level.px / spacing;
    const epsilon = Math.max(1, Math.abs(raw)) * 1e-12;
    const idx = side === 'ask' ? Math.ceil(raw - epsilon) : Math.floor(raw + epsilon);
    buckets.set(idx, (buckets.get(idx) || 0) + level.sz);
  });
  return buckets;
}

// Buckets only the visible index range: the session activity map can hold many
// prices per coin, but each frame renders ~2×rowsPerSide+1 rows — entries
// outside the window are skipped before any allocation or merging.
function bucketTradeActivity(activity, spacing, minIdx, maxIdx) {
  const buckets = new Map();
  activity.forEach((entry) => {
    const idx = bucketIndex(entry.px, spacing);
    if (idx < minIdx || idx > maxIdx) return;
    const bucket = buckets.get(idx)
      || {
        buyVol: 0,
        sellVol: 0,
        lastSide: '',
        lastTime: 0,
        flashNotional: 0,
        flashTime: 0,
        whaleTime: 0,
        whaleVol: 0,
        whaleBuyNotional: 0,
        whaleSellNotional: 0,
        majorWhaleSeen: false,
        latestResponse: null,
        maxPrintNotional: 0,
        maxPrintSz: 0,
        maxPrintTime: 0,
        maxPrintSide: '',
      };
    bucket.buyVol += entry.buyVol;
    bucket.sellVol += entry.sellVol;
    bucket.flashNotional += entry.flashNotional || 0;
    bucket.flashTime = Math.max(bucket.flashTime, entry.flashTime || 0);
    bucket.whaleTime = Math.max(bucket.whaleTime, entry.whaleTime || 0);
    bucket.whaleVol += entry.whaleVol || 0;
    bucket.whaleBuyNotional += entry.whaleBuyNotional || 0;
    bucket.whaleSellNotional += entry.whaleSellNotional || 0;
    bucket.majorWhaleSeen ||= !!entry.majorWhaleSeen;
    if (entry.latestResponse && (!bucket.latestResponse || entry.latestResponse.time > bucket.latestResponse.time)) {
      bucket.latestResponse = entry.latestResponse;
    }
    if ((entry.maxPrintNotional || 0) > bucket.maxPrintNotional) {
      bucket.maxPrintNotional = entry.maxPrintNotional;
      bucket.maxPrintSz = entry.maxPrintSz || 0;
      bucket.maxPrintTime = entry.maxPrintTime || 0;
      bucket.maxPrintSide = entry.maxPrintSide || '';
    }
    if (entry.lastTime > bucket.lastTime) {
      bucket.lastTime = entry.lastTime;
      bucket.lastSide = entry.lastSide;
    }
    buckets.set(idx, bucket);
  });
  return buckets;
}

// Rows per side for the container's current height (jsdom and collapsed
// panels report 0 and fall back to the minimum).
function rowsPerSideFor(container) {
  const perSide = Math.floor((container.clientHeight / ROW_HEIGHT_PX - 1) / 2);
  return Math.max(MIN_ROWS_PER_SIDE, perSide);
}

function showScaleBadge(container, label) {
  let badge = container.querySelector('.dom-scale-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'dom-scale-badge';
    container.appendChild(badge);
  }
  badge.textContent = label;
  badge.classList.add('visible');
  if (scaleBadgeTimer) clearTimeout(scaleBadgeTimer);
  scaleBadgeTimer = setTimeout(() => badge.classList.remove('visible'), 900);
}

function dragStepDelta(deltaY) {
  const distance = Math.abs(deltaY);
  if (distance < SCALE_DRAG_THRESHOLD_PX) return 0;
  const steps = 1 + Math.floor((distance - SCALE_DRAG_THRESHOLD_PX) / SCALE_DRAG_STEP_PX);
  return Math.sign(deltaY) * steps;
}

function bindScaleInteraction(container) {
  if (container.dataset.scaleDragBound === '1') return;
  container.dataset.scaleDragBound = '1';
  let drag = null;

  const finish = () => {
    if (!drag) return;
    if (drag.dragging) suppressNextPriceClick = true;
    drag.target.releasePointerCapture?.(drag.pointerId);
    drag = null;
    document.body.classList.remove('dom-scale-dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  };

  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) >= SCALE_DRAG_THRESHOLD_PX) {
      drag.dragging = true;
      document.body.classList.add('dom-scale-dragging');
    }
    if (!drag.dragging) return;
    const grouping = renderedGroupingByCoin.get(drag.coin);
    if (!grouping) return;
    const delta = dragStepDelta(deltaY);
    const nextIndex = Math.max(0, Math.min(DOM_GROUPING_STEPS.length - 1, drag.startIndex + delta));
    const nextBias = nextIndex - grouping.autoIndex;
    manualGroupingBiasByCoin.set(drag.coin, nextBias);
    showScaleBadge(container, `${nextBias === 0 ? 'AUTO ' : ''}×${DOM_GROUPING_STEPS[nextIndex]}`);
    scheduleDomLadderRender();
    event.preventDefault();
  };

  container.addEventListener('pointerdown', (event) => {
    const target = event.target.closest('.dom-price');
    if (!target || (event.button !== undefined && event.button !== 0)) return;
    const coin = AppState.trading.currentCoin;
    const grouping = renderedGroupingByCoin.get(coin);
    if (!coin || !grouping) return;
    drag = {
      coin,
      pointerId: event.pointerId,
      startY: event.clientY,
      startIndex: grouping.index,
      target,
      dragging: false,
    };
    target.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  });

  container.addEventListener('click', (event) => {
    const priceSpine = event.target.closest('.dom-price');
    if (!priceSpine) return;
    if (event.detail > 1) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!suppressNextPriceClick) return;
    suppressNextPriceClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  container.addEventListener('dblclick', (event) => {
    const priceSpine = event.target.closest('.dom-price');
    if (!priceSpine) return;
    suppressNextPriceClick = false;
    manualGroupingBiasByCoin.set(AppState.trading.currentCoin, 0);
    showScaleBadge(container, 'AUTO');
    scheduleDomLadderRender();
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

// Pooled row elements: the skeleton is built once and cells are updated in
// place each frame, so nothing re-flows and rows never flicker. Rebuilt only
// when the container or its height-derived row count changes.
function ensureGrid(container) {
  bindScaleInteraction(container);
  const rowsPerSide = rowsPerSideFor(container);
  const rowCount = rowsPerSide * 2 + 1;
  if (grid && grid.container === container && grid.rows.length === rowCount && grid.rows[0].root.isConnected) {
    return grid;
  }
  let html = '';
  for (let i = 0; i < rowCount; i++) {
    // Anatomy is symmetric around the price spine: resting size and historical
    // traded total both hug the price column, with identical bars growing
    // outward. Bars are inset and low-opacity so the numerals stay dominant.
    // Bar columns share the remaining width of the hard-set 240px panel; the
    // price spine is a fixed track sized for digits plus max whale lanes so
    // the largest marker never covers size/price/volume numerals.
    html += `<div class="book-row" data-action="domLadderPick" title="Click to load this price into the limit ticket" style="display:grid;grid-template-columns:1fr ${DOM_PRICE_SPINE_PX}px 1fr;gap:3px;align-items:center;padding:0 4px;font-size:8px;line-height:12px;position:relative;font-family:var(--mono);">
      <span style="position:relative;overflow:hidden;text-align:right;"><i class="depth-bar" style="position:absolute;left:auto;right:0;top:2px;bottom:2px;opacity:0.22;pointer-events:none;border-radius:1px;"></i><b style="position:relative;font-weight:400;"></b></span>
      <span class="dom-price" style="text-align:center;color:var(--text2);position:relative;box-sizing:border-box;padding:0 ${WHALE_MARK_LANE_SIZE}px;"><u class="dom-whale" style="position:absolute;top:50%;width:3px;height:3px;margin-top:-1.5px;color:rgba(154,164,178,0.9);opacity:0;pointer-events:none;text-decoration:none;"><i data-whale-stage="0" style="position:absolute;left:50%;top:50%;width:3px;height:3px;transform:translate(-50%,-50%);background:currentColor;"></i><i data-whale-stage="1" style="display:none;position:absolute;left:50%;top:50%;width:6px;height:6px;box-sizing:border-box;transform:translate(-50%,-50%);border:1px solid currentColor;"></i><i data-whale-stage="2" style="display:none;position:absolute;left:50%;top:50%;width:9px;height:9px;box-sizing:border-box;transform:translate(-50%,-50%);border:1px solid currentColor;"></i><i data-whale-stage="3" style="display:none;position:absolute;left:50%;top:50%;width:12px;height:12px;box-sizing:border-box;transform:translate(-50%,-50%);border:1px solid currentColor;"></i><i data-whale-stage="4" style="display:none;position:absolute;left:50%;top:50%;width:15px;height:15px;box-sizing:border-box;transform:translate(-50%,-50%);border:1px solid currentColor;"></i></u><b class="dom-price-cell" style="position:relative;font-weight:400;"></b></span>
      <span class="dom-vol" style="position:relative;overflow:hidden;text-align:left;"><i style="position:absolute;left:0;right:auto;top:2px;bottom:2px;opacity:0.22;pointer-events:none;border-radius:1px;"></i><b style="position:relative;font-weight:400;"></b></span>
    </div>`;
  }
  container.innerHTML = html;
  const rows = Array.from(container.children).map((root) => ({
    root,
    bar: root.children[0].children[0],
    size: root.children[0].children[1],
    price: root.children[1].children[1],
    whale: root.children[1].children[0],
    whaleStages: Array.from(root.children[1].children[0].children),
    volBar: root.children[2].children[0],
    vol: root.children[2].children[1],
  }));
  grid = { container, rows, rowsPerSide };
  return grid;
}

// Resolves the active mid price for the DOM ladder.
// Resting depth arrives in throttled l2Book snapshots (~500ms), while taker
// trades and allMids stream at high frequency. Prioritize the exchange's live
// allMids price (updated by allMids ticks and tape-sweeping trades) so the
// DOM mid marker never lags behind trade activity.
function resolveDomMid(coin, bids = [], asks = []) {
  const allMid = parseFloat(AppState.market?.allMids?.[coin]);
  if (Number.isFinite(allMid) && allMid > 0) {
    return allMid;
  }
  return bids.length && asks.length ? (bids[0].px + asks[0].px) / 2 : 0;
}

function renderDomLadder() {
  const container = document.getElementById('domLadderList');
  if (!container) return;

  const currentCoin = AppState.trading.currentCoin;
  const book = AppState.market.book || { bids: [], asks: [] };
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];

  if (!currentCoin || lastBookCoin !== currentCoin || !bids.length || !asks.length) {
    grid = null;
    // Skip the innerHTML churn on repeat ticks while still waiting.
    if (!container.querySelector('.empty-state')) {
      container.innerHTML = '<div class="empty-state" style="padding:4px;font-size:9px;">Waiting for book...</div>';
    }
    return;
  }

  const now = Date.now();
  const buyColor = getPaletteColor('bullish');
  const sellColor = getPaletteColor('bearish');
  // Trade flash is a neutral grey (the --text2 slate tone), deliberately
  // side-free: red/aqua mean resting depth only, the grey pulse means "a trade
  // just printed here", and the buy/sell breakdown of prints lives in the
  // volume column's split bar.
  const flashRgb = '154,164,178';

  const { rows, rowsPerSide } = ensureGrid(container);

  const mid = resolveDomMid(currentCoin, bids, asks, now);
  const activity = getDomTradeActivity(AppState.market, currentCoin);
  const baseSpacing = computeGridSpacing(currentCoin, bids, asks);
  const autoCandidate = computeLocalAutoMultiplier({ baseSpacing, rowsPerSide, mid, bids, asks });
  const autoMultiplier = heldAutoMultiplier(currentCoin, autoCandidate);
  const grouping = resolvedGrouping(currentCoin, autoMultiplier);
  renderedGroupingByCoin.set(currentCoin, grouping);
  const spacing = baseSpacing * grouping.multiplier;
  const midIdx = dampedMidIdx(currentCoin, spacing, mid);
  const centerIdx = anchoredCenterIdx(currentCoin, spacing, midIdx, rowsPerSide);

  if (!bookBucketMemo || bookBucketMemo.book !== book || bookBucketMemo.spacing !== spacing) {
    bookBucketMemo = {
      book,
      spacing,
      bidBuckets: bucketBookSide(bids, spacing, 'bid'),
      askBuckets: bucketBookSide(asks, spacing, 'ask'),
    };
  }
  const { bidBuckets, askBuckets } = bookBucketMemo;

  const activityVersion = getDomActivityVersion(AppState.market);
  const minIdx = centerIdx - rowsPerSide;
  const maxIdx = centerIdx + rowsPerSide;
  if (!volBucketMemo
    || volBucketMemo.coin !== currentCoin
    || volBucketMemo.version !== activityVersion
    || volBucketMemo.spacing !== spacing
    || volBucketMemo.minIdx !== minIdx
    || volBucketMemo.maxIdx !== maxIdx) {
    volBucketMemo = {
      coin: currentCoin,
      version: activityVersion,
      spacing,
      minIdx,
      maxIdx,
      buckets: bucketTradeActivity(activity, spacing, minIdx, maxIdx),
    };
  }
  const volBuckets = volBucketMemo.buckets;
  const flowMeta = AppState.market.flowMetaCache?.get(currentCoin);
  const recentWhaleBuckets = new Map();
  getDecayedWhaleEvents(AppState.market, currentCoin, now, flowMeta?.whaleHaloHalfLifeMs).forEach((event) => {
    const idx = bucketIndex(event.px, spacing);
    if (idx < minIdx || idx > maxIdx) return;
    const bucket = recentWhaleBuckets.get(idx) || { buy: 0, sell: 0 };
    bucket[event.side] += event.weightedNotional;
    recentWhaleBuckets.set(idx, bucket);
  });

  let maxSz = 0;
  let maxVol = 0;
  for (let idx = centerIdx - rowsPerSide; idx <= centerIdx + rowsPerSide; idx++) {
    maxSz = Math.max(maxSz, (bidBuckets.get(idx) || 0) + (askBuckets.get(idx) || 0));
    const vol = volBuckets.get(idx);
    if (vol) maxVol = Math.max(maxVol, vol.buyVol + vol.sellVol);
  }
  // Hold the peak visible total so bar widths stay stable when the previous
  // max level scrolls off; reset when grid spacing (zoom) changes.
  const heldMaxVol = maxVolHighWaterByCoin.get(currentCoin);
  if (!heldMaxVol || heldMaxVol.spacing !== spacing) {
    maxVolHighWaterByCoin.set(currentCoin, { spacing, maxVol });
  } else {
    heldMaxVol.maxVol = Math.max(heldMaxVol.maxVol, maxVol);
    maxVol = heldMaxVol.maxVol;
  }

  let hasActiveFlash = false;
  let hasActiveRecentWhales = false;
  const labelDecimals = spacingDecimals(spacing);

  rows.forEach((row, i) => {
    const idx = centerIdx + rowsPerSide - i; // top row = highest price
    // toPrecision round-trip strips the float noise of idx * spacing
    // (1501 * 0.1 -> 150.10000000000002), so the label and the picked ticket
    // price are the exact grid value.
    const price = Number((idx * spacing).toPrecision(12));
    const askSz = askBuckets.get(idx) || 0;
    const bidSz = bidBuckets.get(idx) || 0;
    // Empty rows inherit their side from the mid marker. Coarse rows retain
    // both live sides and render a split instead of hiding the smaller side.
    const isAskSide = askSz > 0 || bidSz > 0
      ? (askSz === bidSz ? idx > midIdx : askSz > bidSz)
      : idx > midIdx;
    const sz = askSz + bidSz;
    const hasBothSides = askSz > 0 && bidSz > 0;
    const sideColor = isAskSide ? sellColor : buyColor;
    const vol = volBuckets.get(idx);
    const recentWhales = recentWhaleBuckets.get(idx);

    row.root.dataset.arg = String(price);
    row.price.textContent = price.toFixed(labelDecimals);
    row.size.textContent = hasBothSides ? `${fmtSz(bidSz)}·${fmtSz(askSz)}` : (sz > 0 ? fmtSz(sz) : '');
    row.size.style.color = hasBothSides ? 'var(--text2)' : sideColor;
    row.bar.style.width = maxSz > 0 ? `${Math.min(100, (sz / maxSz) * 100).toFixed(1)}%` : '0%';
    const bidPct = sz > 0 ? Math.round((bidSz / sz) * 100) : 0;
    row.bar.style.background = hasBothSides
      ? `linear-gradient(to right, ${buyColor} ${bidPct}%, ${sellColor} ${bidPct}%)`
      : sideColor;

    if (vol && vol.buyVol + vol.sellVol > 0) {
      const total = vol.buyVol + vol.sellVol;
      row.vol.textContent = fmtSz(total);
      const buyPct = Math.round((vol.buyVol / total) * 100);
      const historyColor = buyPct >= 50 ? buyColor : sellColor;
      row.volBar.style.width = maxVol > 0 ? `${Math.min(100, (total / maxVol) * 100).toFixed(1)}%` : '0%';
      row.volBar.style.background = `linear-gradient(to right, ${buyColor} ${buyPct}%, ${sellColor} ${buyPct}%)`;
      row.vol.style.color = historyColor;
    } else {
      row.vol.textContent = '';
      row.volBar.style.width = '0%';
      row.volBar.style.background = '';
      row.vol.style.color = '';
    }

    // Trade flash: neutral grey tint whose brightness is weighted by the
    // recent prints' notional (dust shimmers faintly, whale-sized flow
    // glows). Age clamps at 0 so server timestamps slightly ahead of the
    // local clock still flash.
    const flashAt = vol ? (vol.flashTime || vol.lastTime) : 0;
    const age = flashAt ? Math.max(0, now - flashAt) : Infinity;
    const ttl = HIGHLIGHT_TTL_MS;
    if (age < ttl) {
      const alpha = ((1 - age / ttl) * 0.38 * tradeIntensity(vol.flashNotional)).toFixed(2);
      row.root.style.background = `rgba(${flashRgb},${alpha})`;
      hasActiveFlash = true;
    } else {
      row.root.style.background = '';
    }

    // Whale marker: sticky, no time-based fade — shows this row's dominant
    // (single largest) print once it clears the whale threshold. A filled
    // center and up to four concentric rings step through $100k, $250k, $500k,
    // $1m, and $5m while opacity progresses logarithmically between the
    // endpoints. Buy markers sit on the left, sell markers on the right,
    // mirroring the flow
    // header's buy-left / sell-right layout. It stays put (or grows/changes
    // side) for the pair session.
    const dominant = vol && ((vol.whaleBuyNotional || 0) + (vol.whaleSellNotional || 0) > 0) ? vol : null;
    if (dominant) {
      const stage = whaleMarkerStage(dominant.maxPrintNotional);
      const markerSize = WHALE_MARK_STAGES[stage].size;
      const markerEdgeOffset = WHALE_MARK_LANE_INSET + (WHALE_MARK_LANE_SIZE - markerSize) / 2;
      const markerOpacity = 0.35 + whaleMarkerProgress(dominant.maxPrintNotional) * 0.65;
      const isBuy = dominant.maxPrintSide === 'buy';
      row.whale.style.width = `${markerSize}px`;
      row.whale.style.height = `${markerSize}px`;
      row.whale.style.marginTop = `${-markerSize / 2}px`;
      row.whale.style.left = isBuy ? `${markerEdgeOffset}px` : '';
      row.whale.style.right = isBuy ? '' : `${markerEdgeOffset}px`;
      row.whale.style.color = isBuy ? buyColor : sellColor;
      row.whale.style.opacity = markerOpacity.toFixed(2);
      row.whaleStages.forEach((layer, index) => {
        layer.style.display = index <= stage ? 'block' : 'none';
      });
      const recentBuy = recentWhales?.buy || 0;
      const recentSell = recentWhales?.sell || 0;
      const recentTotal = recentBuy + recentSell;
      const haloColor = recentBuy >= recentSell ? buyColor : sellColor;
      const haloSize = recentTotal > 0 ? 2 + whaleIntensity(recentTotal) * 5 : 0;
      const majorRing = dominant.majorWhaleSeen ? `0 0 0 1px ${isBuy ? buyColor : sellColor}` : '';
      row.whale.style.boxShadow = [majorRing, haloSize ? `0 0 ${haloSize.toFixed(1)}px ${haloColor}` : ''].filter(Boolean).join(',');
      hasActiveRecentWhales ||= recentTotal > 0;
    } else {
      row.whale.style.opacity = '0';
      row.whale.style.boxShadow = '';
    }

    // Mid marker: hairlines above and below (no layout shift, tint shows
    // through) rather than a filled block that reads as a selection. Follows
    // mid across the sticky grid, so it can sit off the middle row. Row
    // tooltips carry the rolling detail for their price.
    const depthDetail = hasBothSides ? `Bid ${fmtSz(bidSz)} / Ask ${fmtSz(askSz)}` : '';
    const detail = [depthDetail, volDetail(vol)].filter(Boolean).join('\n');
    const pickHint = 'Click price to load limit · drag price to zoom · double-click resets AUTO';
    if (idx === midIdx) {
      row.root.style.boxShadow = 'inset 0 1px 0 var(--border2), inset 0 -1px 0 var(--border2)';
      row.price.style.color = 'var(--text1)';
      row.price.style.fontSize = '10px';
      row.price.style.fontWeight = '700';
      row.root.title = detail || `mid ${fmtPrice(mid, currentCoin)} • spread ${fmtPrice(asks[0].px - bids[0].px, currentCoin)}`;
    } else {
      row.root.style.boxShadow = '';
      row.price.style.color = 'var(--text2)';
      row.price.style.fontSize = '8px';
      row.price.style.fontWeight = '400';
      row.root.title = detail || pickHint;
    }
  });

  // Keep the grid's middle row centered in the half-height panel; row
  // positions are stable, so the target only moves when the panel is resized.
  if (container.scrollHeight > container.clientHeight) {
    const centerEl = rows[rowsPerSide].root;
    const target = centerEl.offsetTop - (container.clientHeight - centerEl.offsetHeight) / 2;
    if (Math.abs(container.scrollTop - target) > 1) container.scrollTop = target;
  }

  const fallbackDelay = fadeFallbackDelay(hasActiveFlash, hasActiveRecentWhales);
  if (fallbackDelay && fadeTimer === null) {
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      scheduleDomLadderRender();
    }, fallbackDelay);
  }
}

// Delegated click handler (data-action="domLadderPick"): loads the row's grid
// price into the limit ticket, mirroring the chart's price-pick behavior
// (applyPickedLimitPrice in chart-interactions.js) — snapToTick cleans up any
// float noise from the grid arithmetic.
function domLadderPick(price) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0) return;
  if (AppState.trading.currentOrderType !== 'limit') setOrderType('limit');
  applyTicketPrice(px, { userEdited: true, snapToTick: true });
}

// Book and trade ticks can each fire several times per second; coalesce to one
// repaint per animation frame.
function scheduleDomLadderRender() {
  if (ladderFrame) return;
  ladderFrame = scheduleFrame(() => {
    ladderFrame = null;
    renderDomLadder();
  });
}

export {
  renderDomLadder,
  scheduleDomLadderRender,
  noteDomBookCoin,
  computeGridSpacing,
  spacingDecimals,
  pruneSpacingCache,
  domLadderPick,
  computeLocalAutoMultiplier,
  dragStepDelta,
  getDomScaleDebugState,
  resetDomScaleState,
  fadeFallbackDelay,
  resolveDomMid,
};
