// Per-price trade activity for the DOM ladder.
//
// All ladder fields are session-persistent per tick price for the active pair
// subscription: buy/sell volume, whale markers, and max-print identity only
// grow (or clear on prune). They never rebuild from a rolling tape sample.
//
// The latest-500 rolling sample is owned solely by the top ALL/WHALE flow
// header (backend _flow). Grey row flash is time-based only (HIGHLIGHT_TTL_MS).
//
// Consumes normalizeTradeBatch output (market-trades.js) — parsing and relay
// dedupe happen once there for every trade cache.

import { getTickSize } from './coin-meta.js';
import { WHALE_NOTIONAL } from './market-trades.js';

const HIGHLIGHT_TTL_MS = 1200;
// Soft cap on unique session price levels. When exceeded, drop levels farthest
// from the recent mid so near-market structure stays bounded.
const MAX_SESSION_PRICES = 2000;
const MAX_TRACKED_PRICES = MAX_SESSION_PRICES;

// Canonical price key: integer tick index. Trades execute at book-level prices,
// so keys match ladder rows exactly; rounding only absorbs float noise.
function priceKey(px, coin) {
  const tick = getTickSize(coin);
  const price = parseFloat(px);
  if (!Number.isFinite(price) || !(tick > 0)) return '';
  return String(Math.round(price / tick));
}

function ensureDomBuckets(marketState, coin) {
  if (!marketState || !coin) return;

  if (!(marketState.domTradeCache instanceof Map)) marketState.domTradeCache = new Map();
  if (!(marketState.domSessionMid instanceof Map)) marketState.domSessionMid = new Map();
  if (!(marketState.domSessionMidTime instanceof Map)) marketState.domSessionMidTime = new Map();
  if (!marketState.domTradeCache.has(coin)) marketState.domTradeCache.set(coin, new Map());
}

// Bumped whenever ingest changes any coin's activity map; the ladder renderer
// keys its per-frame bucket memo on this, so fade-only repaints skip
// re-aggregating an unchanged activity map.
function getDomActivityVersion(marketState) {
  return marketState?.domActivityVersion || 0;
}

function emptyActivityEntry(px) {
  return {
    px,
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
}

// Drop price levels farthest from mid when the session map exceeds the cap.
function trimSessionPrices(activity, midPx, maxPrices = MAX_SESSION_PRICES) {
  if (!(activity instanceof Map) || activity.size <= maxPrices) return;
  const anchor = Number.isFinite(midPx) ? midPx : 0;
  const ranked = Array.from(activity.entries()).sort((left, right) => {
    const leftDist = Math.abs((left[1]?.px || 0) - anchor);
    const rightDist = Math.abs((right[1]?.px || 0) - anchor);
    if (leftDist !== rightDist) return leftDist - rightDist;
    return String(left[0]).localeCompare(String(right[0]));
  });
  const keep = new Set(ranked.slice(0, maxPrices).map(([key]) => key));
  ranked.forEach(([key]) => {
    if (!keep.has(key)) activity.delete(key);
  });
}

// Apply one accepted print onto the session activity map. Nothing is ever
// subtracted here — aging prints do not shrink ladder state.
function applySessionTrade(activity, coin, trade) {
  const { px, sz } = trade;
  if (!Number.isFinite(px) || !Number.isFinite(sz)) return null;

  const key = priceKey(px, coin);
  if (!key) return null;

  const entry = activity.get(key) || emptyActivityEntry(px);
  const time = trade.time;
  entry.px = px;
  if (trade.isBuy) entry.buyVol += sz;
  else entry.sellVol += sz;

  // last* follows exchange time: only advance when this print is as new or newer.
  if (!entry.lastTime || time >= entry.lastTime) {
    entry.lastSide = trade.isBuy ? 'buy' : 'sell';
    entry.lastTime = time;
  }

  // Flash meter: prints within HIGHLIGHT_TTL_MS of each other accumulate; a
  // print after quiet resets to its own notional. Stale out-of-order prints
  // must not brighten a fresher flash.
  const notional = Number.isFinite(trade.notional) ? trade.notional : Math.abs(px * sz);
  const priorFlashTime = entry.flashTime || 0;
  if (time >= priorFlashTime) {
    entry.flashNotional = time - priorFlashTime < HIGHLIGHT_TTL_MS
      ? (entry.flashNotional || 0) + notional
      : notional;
    entry.flashTime = time;
  }

  if (trade.isWhale ?? notional >= WHALE_NOTIONAL) {
    entry.whaleTime = Math.max(entry.whaleTime || 0, time);
    entry.whaleVol = (entry.whaleVol || 0) + sz;
    if (trade.isBuy) entry.whaleBuyNotional = (entry.whaleBuyNotional || 0) + notional;
    else entry.whaleSellNotional = (entry.whaleSellNotional || 0) + notional;
    if (trade.isMajorWhale) entry.majorWhaleSeen = true;
  }
  if (notional > (entry.maxPrintNotional || 0)) {
    entry.maxPrintNotional = notional;
    entry.maxPrintSz = sz;
    entry.maxPrintTime = time;
    entry.maxPrintSide = trade.isBuy ? 'buy' : 'sell';
  }

  activity.set(key, entry);
  return px;
}

// ingestDomTrades permanently folds accepted prints into the session activity
// map. No rolling queue — the 500-print window is top FLOW only.
function ingestDomTrades(marketState, coin, normalized = []) {
  if (!marketState || !coin || !Array.isArray(normalized) || normalized.length === 0) return;

  ensureDomBuckets(marketState, coin);
  const valid = normalized.filter((trade) => trade
    && Number.isFinite(trade.px)
    && Number.isFinite(trade.sz));
  if (!valid.length) return;

  // Sort by exchange time so flash/last-side within a batch is deterministic
  // when the relay delivers out of order.
  const ordered = valid.sort((left, right) => (Number(left.time) || 0) - (Number(right.time) || 0)
    || String(left.tradeId || '').localeCompare(String(right.tradeId || '')));

  const activity = marketState.domTradeCache.get(coin);
  let lastPx = null;
  let lastTime = 0;
  ordered.forEach((trade) => {
    const px = applySessionTrade(activity, coin, trade);
    if (Number.isFinite(px)) {
      lastPx = px;
      lastTime = Math.max(lastTime, Number(trade.time) || 0);
    }
  });

  if (Number.isFinite(lastPx)) {
    marketState.domSessionMid.set(coin, lastPx);
    if (!(marketState.domSessionMidTime instanceof Map)) marketState.domSessionMidTime = new Map();
    marketState.domSessionMidTime.set(coin, lastTime || Date.now());
  }
  trimSessionPrices(activity, marketState.domSessionMid.get(coin), MAX_SESSION_PRICES);

  marketState.domActivityVersion = getDomActivityVersion(marketState) + 1;
}

// getDomTradeActivity returns the per-price session activity map for the coin.
function getDomTradeActivity(marketState, coin) {
  if (!marketState || !coin || !(marketState.domTradeCache instanceof Map)) return new Map();
  const activity = marketState.domTradeCache.get(coin);
  return activity instanceof Map ? activity : new Map();
}

export {
  HIGHLIGHT_TTL_MS,
  MAX_SESSION_PRICES,
  WHALE_NOTIONAL,
  MAX_TRACKED_PRICES,
  priceKey,
  ensureDomBuckets,
  ingestDomTrades,
  getDomTradeActivity,
  getDomActivityVersion,
  trimSessionPrices,
};
