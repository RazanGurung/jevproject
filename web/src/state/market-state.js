/**
 * Market state - canonical market selectors and lightweight cache helpers
 */

import { AppState, coin24hChanges } from './store.js';

function normalizeCoinName(coin) {
  return (coin || '').replace(/^xyz:/, '');
}

function setCoin24hChange(coin, change) {
  if (!coin) return;
  coin24hChanges[coin] = change;
}

function getCoin24hChange(coin) {
  if (!coin) return null;
  return coin24hChanges?.[coin] ?? null;
}

/**
 * Store a compact trading-trigger snapshot for a coin (24h change + vol/OI/funding).
 * Accepts either a plain change string (legacy) or a full snapshot object from
 * /api/24h-changes.
 */
function setAssetSnapshot(coin, entry) {
  if (!coin) return null;
  if (!AppState.market.assetSnapshots || typeof AppState.market.assetSnapshots !== 'object') {
    AppState.market.assetSnapshots = {};
  }
  if (entry == null) return null;

  // Legacy plain-string payload from older servers / candle fallback.
  if (typeof entry === 'string' || typeof entry === 'number') {
    const change = String(entry);
    setCoin24hChange(coin, change);
    const prev = AppState.market.assetSnapshots[coin] || {};
    const next = { ...prev, change };
    AppState.market.assetSnapshots[coin] = next;
    return next;
  }

  if (typeof entry !== 'object') return null;
  const change = entry.change != null ? String(entry.change) : (entry.Change != null ? String(entry.Change) : null);
  if (change != null) setCoin24hChange(coin, change);

  const dayNtlVlm = Number(entry.dayNtlVlm ?? entry.DayVol);
  const oi = Number(entry.oi ?? entry.OI);
  const funding = Number(entry.funding ?? entry.Funding);
  const markPx = Number(entry.markPx ?? entry.MarkPx);

  const next = {
    change: change ?? AppState.market.assetSnapshots[coin]?.change ?? null,
    dayNtlVlm: Number.isFinite(dayNtlVlm) && dayNtlVlm > 0 ? dayNtlVlm : null,
    oi: Number.isFinite(oi) && oi > 0 ? oi : null,
    funding: Number.isFinite(funding) ? funding : null,
    markPx: Number.isFinite(markPx) && markPx > 0 ? markPx : null,
  };
  AppState.market.assetSnapshots[coin] = next;
  return next;
}

function getAssetSnapshot(coin) {
  if (!coin) return null;
  return AppState.market.assetSnapshots?.[coin] ?? null;
}

function isActiveMarketSelection(coin, timeframe = AppState.trading.currentTimeframe) {
  if (!coin) return false;
  return coin === AppState.trading.currentCoin
    && timeframe === AppState.trading.currentTimeframe;
}

function setMarketPrice(coin, price) {
  if (!coin || !Number.isFinite(price) || price <= 0) return;
  AppState.market.allMids[coin] = price.toString();
  if (!AppState.market.lastPriceUpdateAt) AppState.market.lastPriceUpdateAt = {};
  AppState.market.lastPriceUpdateAt[coin] = Date.now();
  if (coin === AppState.trading.currentCoin) {
    AppState.trading.currentPrice = price;
  }
}

function setActiveAssetCtx(coin, ctx) {
  if (!coin || !ctx) return null;
  if (!AppState.market.activeAssetCtx || typeof AppState.market.activeAssetCtx !== 'object') {
    AppState.market.activeAssetCtx = {};
  }
  AppState.market.activeAssetCtx[coin] = ctx;
  return ctx;
}

function setMarketCandles(candles, { snapshot = false } = {}) {
  AppState.market.candles = Array.isArray(candles) ? candles : [];
  if (snapshot) {
    AppState.market.candleSnapshotRevision = (Number(AppState.market.candleSnapshotRevision) || 0) + 1;
  }
  return AppState.market.candles;
}

function setMarketVwapData(result) {
  AppState.market.vwapData = result || null;
  return AppState.market.vwapData;
}

function findAssetCtx(meta, coin) {
  if (!Array.isArray(meta) || meta.length < 2 || !coin) return null;
  const universe = Array.isArray(meta[0]?.universe) ? meta[0].universe : [];
  const assetCtxs = Array.isArray(meta[1]) ? meta[1] : [];
  const idx = universe.findIndex((entry) => normalizeCoinName(entry?.name) === normalizeCoinName(coin));
  return idx >= 0 ? (assetCtxs[idx] || null) : null;
}

function normalizeBookLevel(level) {
  if (!level) return null;
  const px = Number(level.px);
  const sz = Number(level.sz);
  if (!Number.isFinite(px) || !Number.isFinite(sz)) return null;
  return { ...level, px, sz, price: px, size: sz };
}

function normalizeBookSide(levels, { limit = 50 } = {}) {
  if (!Array.isArray(levels)) return [];
  const nextLevels = [];
  for (let i = 0; i < levels.length && nextLevels.length < limit; i++) {
    const normalized = normalizeBookLevel(levels[i]);
    if (normalized) nextLevels.push(normalized);
  }
  return nextLevels;
}

function buildNormalizedBook(levels, { limit = 50 } = {}) {
  const bids = normalizeBookSide(levels?.[0], { limit });
  const asks = normalizeBookSide(levels?.[1], { limit });
  if (!bids.length || !asks.length) return null;
  return { bids, asks };
}

function setMarketBookSnapshot(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  AppState.market.book = { ...(book || {}), bids, asks };
  return AppState.market.book;
}

/**
 * Mid price derived from the top of the book. Used as a fallback when the
 * `allMids` channel hasn't published a price yet for the active coin.
 */
function deriveMidFromBook(book) {
  const bestBid = book?.bids?.[0]?.px;
  const bestAsk = book?.asks?.[0]?.px;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  if (bestBid <= 0 || bestAsk <= 0) return null;
  return (bestBid + bestAsk) / 2;
}

export {
  normalizeCoinName,
  setCoin24hChange,
  getCoin24hChange,
  setAssetSnapshot,
  getAssetSnapshot,
  isActiveMarketSelection,
  setMarketPrice,
  setActiveAssetCtx,
  setMarketCandles,
  setMarketVwapData,
  findAssetCtx,
  normalizeBookLevel,
  normalizeBookSide,
  buildNormalizedBook,
  setMarketBookSnapshot,
  deriveMidFromBook,
};
