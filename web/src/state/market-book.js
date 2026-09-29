// Per-coin order-book depth caching — mirrors market-trades.js's tradeCache so
// switching between watchlist/tracked coins restores the DOM ladder's book
// instantly instead of showing "Waiting for book..." until the next live tick.
// Bounded implicitly by pruneMarketCoinCaches's keepCoins eviction (active +
// tracked + watchlist, the same coin set trades already cache for) — no
// separate LRU cap needed.

function ensureBookCache(marketState) {
  if (!(marketState.bookCache instanceof Map)) marketState.bookCache = new Map();
  return marketState.bookCache;
}

// ingestBook caches a normalized book ({bids, asks}) for ANY subscribed coin
// (active or background) — unlike the pre-fix handleBook, which discarded
// background coins' ticks entirely.
function ingestBook(marketState, coin, book) {
  if (!marketState || !coin || !book) return;
  ensureBookCache(marketState).set(coin, book);
}

// getCachedBook returns the coin's most recently cached book, or null.
function getCachedBook(marketState, coin) {
  if (!marketState || !coin) return null;
  return marketState.bookCache?.get(coin) || null;
}

export { ensureBookCache, ingestBook, getCachedBook };
