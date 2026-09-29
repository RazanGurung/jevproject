// Trade state buffering for the active coin. Flow math now lives on the backend
// (it relays trades messages annotated with `_flow`); this module only buffers
// relayed data and copies it into the render-facing market slice. See
// annotateTradesMessage in the Go market WS handler for the producer of `_flow`.
// Liquidations are no longer derived from the public trades feed — that feed
// carries no liquidation tag. Own-account liquidations come from userFills.
//
// normalizeTradeBatch is the single parse/dedupe pass for a relayed batch:
// every downstream cache (the recent/large lists here, the DOM ladder's
// per-price activity in dom-ladder-state.js) consumes its output instead of
// re-parsing and re-deduping the same payload independently.

// Frontend fallbacks mirror the backend-published thresholds. The _flow
// annotation carries the authoritative values for display/protocol consumers.
const LARGE_TRADE_MIN_NOTIONAL = 5000;
const WHALE_NOTIONAL = 100000;
const WHALE_FLOW_NOTIONAL = 100000;
const MAJOR_WHALE_NOTIONAL = 250000;
const WHALE_HALO_HALF_LIFE_MS = 180000;
const FLOW_SAMPLE_CAPACITY = 500;

// Relay resends are deduped against a per-coin identity set, preferring tid,
// then hash+fields, then fields+batch occurrence. The set lives for the
// subscription (pruneMarketCoinCaches drops it). FIFO evicts only after
// MAX_SEEN_KEYS, well above Hyperliquid's reconnect replay window, so a
// resent recent print cannot double-count session DOM volume.
const IDENTITY_REPLAY_WINDOW = 1200;
const MAX_SEEN_KEYS = 10000;

function rememberSeenKey(seen, key) {
  if (seen.has(key)) return false;
  seen.add(key);
  const overflow = seen.size - MAX_SEEN_KEYS;
  if (overflow <= 0) return true;
  let dropped = 0;
  for (const existing of seen) {
    if (dropped >= overflow) break;
    if (existing === key) continue;
    seen.delete(existing);
    dropped += 1;
  }
  return true;
}

// normalizeTradeBatch dedupes and parses a relayed trades batch once. Returns
// entries { raw, px, sz, time, side, isBuy, notional }; trades with
// unparseable px/sz keep NaN px/sz/notional (the recent-trades list still
// buffers them; numeric consumers skip them). Already-seen trades are dropped.
function normalizeTradeBatch(marketState, coin, trades = [], now = Date.now()) {
  if (!marketState || !coin || !Array.isArray(trades) || trades.length === 0) return [];

  if (!(marketState.tradeSeenKeys instanceof Map)) marketState.tradeSeenKeys = new Map();
  if (!marketState.tradeSeenKeys.has(coin)) marketState.tradeSeenKeys.set(coin, new Set());
  const seen = marketState.tradeSeenKeys.get(coin);
  const occurrences = new Map();
  const flowMeta = marketState.flowMetaCache?.get(coin) || {};
  const whaleThreshold = Number(flowMeta.whaleThresholdUsd) || WHALE_NOTIONAL;
  const majorWhaleThreshold = Number(flowMeta.majorWhaleThresholdUsd) || MAJOR_WHALE_NOTIONAL;

  const normalized = [];
  trades.forEach((trade) => {
    if (!trade) return;
    const fingerprint = `${trade.time}:${trade.px}:${trade.sz}:${trade.side || ''}`;
    const occurrence = occurrences.get(fingerprint) || 0;
    occurrences.set(fingerprint, occurrence + 1);
    const tid = trade.tid ?? trade.tradeId;
    const hash = String(trade.hash || '').trim();
    const key = tid !== undefined && tid !== null && String(tid) !== ''
      ? `tid:${tid}`
      : hash
        ? `hash:${hash}:${fingerprint}`
        : `fallback:${fingerprint}:${occurrence}`;
    if (!rememberSeenKey(seen, key)) return;

    const px = parseFloat(trade.px);
    const sz = parseFloat(trade.sz);
    const numeric = Number.isFinite(px) && Number.isFinite(sz);
    normalized.push({
      raw: trade,
      px,
      sz,
      time: Number(trade.time) || now,
      side: trade.side || '',
      isBuy: trade.side === 'B' || trade.side === 'buy',
      notional: numeric ? Math.abs(px * sz) : NaN,
      tradeId: `${coin}:${key}`,
      isWhale: numeric && Math.abs(px * sz) >= whaleThreshold,
      isMajorWhale: numeric && Math.abs(px * sz) >= majorWhaleThreshold,
    });
  });
  return normalized;
}

function ensureCoinTradeBuckets(marketState, coin) {
  if (!marketState || !coin) return;

  if (!(marketState.tradeCache instanceof Map)) marketState.tradeCache = new Map();
  if (!(marketState.largeTradeCache instanceof Map)) marketState.largeTradeCache = new Map();
  if (!(marketState.flowCache instanceof Map)) marketState.flowCache = new Map();
  if (!(marketState.whaleFlowCache instanceof Map)) marketState.whaleFlowCache = new Map();
  if (!(marketState.flowMetaCache instanceof Map)) marketState.flowMetaCache = new Map();
  if (!(marketState.flowFreshnessCache instanceof Map)) marketState.flowFreshnessCache = new Map();

  if (!marketState.tradeCache.has(coin)) marketState.tradeCache.set(coin, []);
  if (!marketState.largeTradeCache.has(coin)) marketState.largeTradeCache.set(coin, []);
  if (!marketState.flowCache.has(coin)) marketState.flowCache.set(coin, {
    buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: FLOW_SAMPLE_CAPACITY,
  });
  if (!marketState.whaleFlowCache.has(coin)) marketState.whaleFlowCache.set(coin, {
    buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: FLOW_SAMPLE_CAPACITY,
  });
}

// applyFlowSnapshot stores the backend-computed per-coin order/whale flow. The
// browser caches the backend's exact independent latest-500 ALL and WHALE
// windows from each trades message's `_flow` annotation, then renders the
// active coin's snapshots.
function applyFlowSnapshot(marketState, coin, flow, { marketEpoch = 0 } = {}) {
  if (!marketState || !coin || !flow) return false;
  ensureCoinTradeBuckets(marketState, coin);
  const incomingEpoch = Math.max(0, Number(marketEpoch) || 0);
  const incomingRevision = Math.max(0, Number(flow.revision) || 0);
  const currentFreshness = marketState.flowFreshnessCache.get(coin);
  if (currentFreshness) {
    const currentEpoch = Math.max(0, Number(currentFreshness.marketEpoch) || 0);
    const currentRevision = Math.max(0, Number(currentFreshness.revision) || 0);
    if (incomingEpoch > 0 && currentEpoch > 0) {
      if (incomingEpoch < currentEpoch) return false;
      if (incomingEpoch === currentEpoch && incomingRevision < currentRevision) return false;
    } else if (incomingRevision < currentRevision) {
      return false;
    }
  }
  marketState.flowCache.set(coin, {
    buyVol: Number(flow.buyVol) || 0,
    sellVol: Number(flow.sellVol) || 0,
    sampleCount: Math.max(0, Number(flow.sampleCount) || 0),
    sampleCapacity: Math.max(1, Number(flow.sampleCapacity) || FLOW_SAMPLE_CAPACITY),
    oldestTimeMs: Math.max(0, Number(flow.oldestTimeMs) || 0),
    newestTimeMs: Math.max(0, Number(flow.newestTimeMs) || 0),
  });
  marketState.whaleFlowCache.set(coin, {
    buyVol: Number(flow.whaleBuyVol) || 0,
    sellVol: Number(flow.whaleSellVol) || 0,
    // Older servers published WHALE as a subset of the ALL sample and have no
    // whale-specific coverage fields. Fall back to those shared fields while
    // accepting the additive independent-window metadata from newer servers.
    sampleCount: Math.max(0, Number(flow.whaleSampleCount ?? flow.sampleCount) || 0),
    sampleCapacity: Math.max(1, Number(flow.whaleSampleCapacity ?? flow.sampleCapacity)
      || FLOW_SAMPLE_CAPACITY),
    oldestTimeMs: Math.max(0, Number(flow.whaleOldestTimeMs ?? flow.oldestTimeMs) || 0),
    newestTimeMs: Math.max(0, Number(flow.whaleNewestTimeMs ?? flow.newestTimeMs) || 0),
  });
  marketState.flowMetaCache.set(coin, {
    whaleHaloHalfLifeMs: Number(flow.whaleHaloHalfLifeMs)
      || Number(flow.halfLifeMs)
      || WHALE_HALO_HALF_LIFE_MS,
    flowThresholdUsd: Math.max(0, Number(flow.flowThresholdUsd) || 0),
    whaleThresholdUsd: Number(flow.whaleThresholdUsd) || WHALE_NOTIONAL,
    whaleFlowThresholdUsd: Number(flow.whaleFlowThresholdUsd) || WHALE_FLOW_NOTIONAL,
    majorWhaleThresholdUsd: Number(flow.majorWhaleThresholdUsd) || MAJOR_WHALE_NOTIONAL,
  });
  marketState.flowFreshnessCache.set(coin, {
    marketEpoch: incomingEpoch,
    revision: incomingRevision,
  });
  return true;
}

// A warm cache is display-safe only when the backend accepted that coin and
// the snapshot was received on the currently connected downstream market
// socket. Cache values survive reconnects, but their old epoch is ineligible.
function isFlowSnapshotEligible(marketState, coin, {
  acceptedTradeCoins = [],
  marketEpoch = 0,
  marketState: connectionState = '',
} = {}) {
  if (!marketState || !coin || connectionState !== 'connected') return false;
  if (!Array.isArray(acceptedTradeCoins) || !acceptedTradeCoins.includes(coin)) return false;
  const freshness = marketState.flowFreshnessCache?.get(coin);
  const currentEpoch = Math.max(0, Number(marketEpoch) || 0);
  return currentEpoch > 0
    && Number(freshness?.marketEpoch) === currentEpoch
    && marketState.flowCache?.has(coin) === true;
}

// ingestMarketLiquidations buffers the market-wide liquidations pushed by the
// backend feed (channel `liquidations`). This is global (all coins), not
// per-coin. The backend streams Bybit (+ QuickNode when configured); own-account
// liquidations come separately from userFills. Deduped by user+time+px+sz (Bybit
// carries no user, so it is time+px+sz there).
function ingestMarketLiquidations(marketState, liquidations = []) {
  if (!marketState || !Array.isArray(liquidations) || liquidations.length === 0) return;

  const buffer = Array.isArray(marketState.marketLiquidations) ? marketState.marketLiquidations : [];
  liquidations.forEach((liq) => {
    if (!liq) return;
    const exists = buffer.some((item) => item.time === liq.time && item.px === liq.px
      && item.sz === liq.sz && item.user === liq.user);
    if (exists) return;
    buffer.unshift(liq);
    if (buffer.length > 100) buffer.pop();
  });
  marketState.marketLiquidations = buffer;
}

// syncActiveTradeStateSnapshot copies the active coin's buffers into the render
// slice, including the backend-supplied per-coin flow. A coin without flow yet
// renders zeros until its first trades `_flow` arrives.
function syncActiveTradeStateSnapshot(marketState, coin, { useCachedFlow = true } = {}) {
  if (!marketState || !coin) return;

  ensureCoinTradeBuckets(marketState, coin);
  marketState.trades = [...(marketState.tradeCache.get(coin) || [])];
  marketState.largeTrades = [...(marketState.largeTradeCache.get(coin) || [])];
  const emptyFlow = { buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: FLOW_SAMPLE_CAPACITY };
  const flow = useCachedFlow ? (marketState.flowCache.get(coin) || emptyFlow) : emptyFlow;
  const whaleFlow = useCachedFlow ? (marketState.whaleFlowCache.get(coin) || emptyFlow) : emptyFlow;
  marketState.orderFlow = { ...flow };
  marketState.largeTradeFlow = { ...whaleFlow };
}

// ingestTrades buffers a normalized batch (normalizeTradeBatch output — parse
// and dedupe already done) into the per-coin caches: the canonical
// recent-trades list and the large-trade list. It performs no classification or
// flow math — those are backend-owned.
function ingestTrades(marketState, tradeCoin, normalized = []) {
  if (!marketState || !tradeCoin || !Array.isArray(normalized) || normalized.length === 0) return;

  ensureCoinTradeBuckets(marketState, tradeCoin);

  const tradeList = marketState.tradeCache.get(tradeCoin) || [];
  const largeTrades = marketState.largeTradeCache.get(tradeCoin) || [];

  normalized.forEach((entry) => {
    if (!entry || !entry.raw) return;
    tradeList.unshift({ ...entry.raw, time: entry.raw.time, coin: tradeCoin });
    if (Number.isFinite(entry.notional) && entry.notional >= LARGE_TRADE_MIN_NOTIONAL) {
      largeTrades.unshift({ ...entry.raw, value: entry.notional, time: entry.raw.time, coin: tradeCoin });
      if (largeTrades.length > 100) largeTrades.pop();
    }
  });
  if (tradeList.length > FLOW_SAMPLE_CAPACITY) tradeList.length = FLOW_SAMPLE_CAPACITY;

  marketState.tradeCache.set(tradeCoin, tradeList);
  marketState.largeTradeCache.set(tradeCoin, largeTrades);
}

// pruneMarketCoinCaches drops per-coin cache entries for coins outside
// keepCoins. Without this the outer Maps accrete an entry for every coin the
// app streamed. Called on coin switch with the currently subscribed set
// (active + watchlist + recent coins). Also covers the DOM ladder's activity map and
// per-coin book cache (same marketState, same lifecycle).
function pruneMarketCoinCaches(marketState, keepCoins = []) {
  if (!marketState) return;
  const keep = keepCoins instanceof Set ? keepCoins : new Set(keepCoins);
  [
    marketState.tradeCache,
    marketState.largeTradeCache,
    marketState.flowCache,
    marketState.whaleFlowCache,
    marketState.flowMetaCache,
    marketState.flowFreshnessCache,
    marketState.tradeSeenKeys,
    marketState.domTradeCache,
    marketState.domSessionMid,
    marketState.domSessionMidTime,
    marketState.bookCache,
    marketState.whaleEventCache,
    marketState.whaleResponseCache,
  ].forEach((cache) => {
    if (!(cache instanceof Map)) return;
    Array.from(cache.keys()).forEach((coin) => {
      if (!keep.has(coin)) cache.delete(coin);
    });
  });
}

export {
  LARGE_TRADE_MIN_NOTIONAL,
  WHALE_NOTIONAL,
  WHALE_FLOW_NOTIONAL,
  MAJOR_WHALE_NOTIONAL,
  WHALE_HALO_HALF_LIFE_MS,
  FLOW_SAMPLE_CAPACITY,
  IDENTITY_REPLAY_WINDOW,
  MAX_SEEN_KEYS,
  applyFlowSnapshot,
  ensureCoinTradeBuckets,
  ingestMarketLiquidations,
  ingestTrades,
  isFlowSnapshotEligible,
  normalizeTradeBatch,
  pruneMarketCoinCaches,
  syncActiveTradeStateSnapshot,
};
