/**
 * Helper utilities - generic shared helpers that don't belong elsewhere
 */

// Display aliases for HIP-3 xyz synthetics. Keys are the bare symbol portion
// after "xyz:" (case-insensitive).
const XYZ_TAB_ALIAS = {
  CL: 'WTI',
  SP500: 'SPX',
  JPY: 'USDJPY',
  SPCX: 'SPACEX',
};

function coinToTabId(coin) {
  if (!coin) return '';

  // HIP-3 xyz synthetics: show a clean label for EVERY pair.
  // - Default: bare symbol ("xyz:GOLD" -> "GOLD")
  // - Aliases: a handful of curated display tickers ("xyz:SP500" -> "SPX")
  // Note: incoming coin keys can vary in symbol casing depending on source.
  const colonIdx = coin.indexOf(':');
  if (colonIdx > 0) {
    const dex = coin.substring(0, colonIdx);
    const rawSym = coin.substring(colonIdx + 1);
    if (!dex || !rawSym) return coin;
    if (dex.toLowerCase() === 'xyz') {
      const sym = rawSym.toUpperCase();
      return XYZ_TAB_ALIAS[sym] || sym;
    }

    // Non-xyz dex-qualified perps: include dex in the label so the dropdown
    // doesn't collapse distinct markets into a single ambiguous ticker.
    return `${rawSym} (${dex})`;
  }

  return coin;
}

// Canonical builder-perp routing check: any well-formed "<dex>:<symbol>".
function isBuilderPerpCoin(coin) {
  if (typeof coin !== 'string') return false;
  const separator = coin.indexOf(':');
  return separator > 0 && separator < coin.length - 1;
}

// xyz HIP-3 category label only — not a routing rule. Prefer isBuilderPerpCoin
// for order/market paths; use this for xyz-only product categories (mispricing, tabs).
function isHip3Coin(coin) {
  return getDex(coin) === 'xyz';
}

function truncAddr(a) {
  if (!a) return '';
  return a.slice(0, 2) + '...' + a.slice(-2);  // Match backup: shorter format
}

function getDex(coin) {
  if (typeof coin !== 'string') return null;
  const separator = coin.indexOf(':');
  if (separator <= 0 || separator >= coin.length - 1) return null;
  return coin.slice(0, separator).toLowerCase();
}

// parseFloat-based numeric coercion with a finite guard. Non-numeric,
// NaN, and +/-Infinity inputs all collapse to 0. Canonical shared version
// of the toNumber helper previously duplicated across services.
function toNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export {
  coinToTabId,
  isHip3Coin,
  isBuilderPerpCoin,
  truncAddr,
  getDex,
  toNumber,
  clamp,
  sleep,
};
