// User-curated watchlist of markets, persisted to localStorage. Coins are stored
// as already-normalized keys (the same form getAllPerpCoins / buildCoinButtonHtml
// emit), so no further normalization is needed here. Follows the pez:-prefixed
// JSON convention used elsewhere (see deploy-config.js, drawing-tools.js).

const STORAGE_KEY = 'pez:watchlist';

// In-memory cache, lazily loaded from localStorage on first access.
let cache = null;

// Change subscribers (e.g. the preload-hint service re-posts the watchlist to
// the backend when it changes). Notified after every successful add/remove.
const subscribers = new Set();

// Only standard perps and xyz HIP-3 markets are loadable. Non-xyz builder
// prefixes (para:, vntl:, mkts:, …) are stripped from persisted watchlists.
function isLoadableWatchlistCoin(coin) {
  if (typeof coin !== 'string' || !coin) return false;
  const idx = coin.indexOf(':');
  if (idx > 0) {
    return coin.substring(0, idx).toLowerCase() === 'xyz';
  }
  return true;
}

function notify() {
  subscribers.forEach((cb) => {
    try {
      cb();
    } catch (_) {
      // A misbehaving subscriber must not break watchlist edits.
    }
  });
}

// subscribeWatchlist registers cb to run on every watchlist change. Returns an
// unsubscribe function.
export function subscribeWatchlist(cb) {
  if (typeof cb !== 'function') return () => {};
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function load() {
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    // Keep only loadable non-empty strings, de-duplicated, preserving order.
    return [...new Set(parsed.filter(isLoadableWatchlistCoin))];
  } catch (_) {
    return [];
  }
}

function persist() {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (_) {
    // localStorage unavailable — keep the in-memory list working anyway.
  }
}

function ensureLoaded() {
  if (cache === null) cache = load();
  return cache;
}

export function getWatchlist() {
  return [...ensureLoaded()];
}

export function isWatchlisted(coin) {
  if (!coin) return false;
  return ensureLoaded().includes(coin);
}

export function addToWatchlist(coin) {
  if (!isLoadableWatchlistCoin(coin)) return;
  ensureLoaded();
  if (cache.includes(coin)) return;
  cache.push(coin);
  persist();
  notify();
}

export function removeFromWatchlist(coin) {
  if (!coin) return;
  ensureLoaded();
  const next = cache.filter((c) => c !== coin);
  if (next.length === cache.length) return;
  cache = next;
  persist();
  notify();
}
