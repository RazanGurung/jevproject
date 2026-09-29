/**
 * Controls UI - Leverage, dropdown, wallet button
 * Extracted from main.js
 */

import { AppState } from '../state/store.js';
import { setExchangeLeverage } from '../state/store.js';
import { getCoin24hChange, getAssetSnapshot } from '../state/market-state.js';
import { getCurrentCoin } from '../state/trading-selectors.js';
import { getMaxLeverage, getCoinMeta } from '../state/coin-meta.js';
import { showToast } from './toast.js';
import { handleWalletBtnClick as handleWalletButtonSession, requireKey } from '../services/wallet-service.js';
import { requestAccountEnrichment } from '../services/action-feedback.js';
import { apiPost } from '../services/api.js';
import { coinToTabId, isBuilderPerpCoin, isHip3Coin } from '../utils/helpers.js';
import { escapeHtml } from '../utils/html.js';
import { fmtPrice, fmtVol } from '../utils/format.js';
import { getManagedExchangePrivateKey } from '../services/exchange-auth.js';
import { getSizeSliderMaxUpdater } from '../state/app-host.js';
import { getWatchlist, addToWatchlist as addWl, removeFromWatchlist as removeWl } from '../services/watchlist-store.js';
import { getHideList, isHideListed, addToHideList as addHl, removeFromHideList as removeHl } from '../services/hide-list-store.js';
import {
  closeCoinDropdown,
  getCoinDropdownElements,
  getDisplayedLeverageValue,
  getLeverageControlElements,
} from './control-surface.js';
import { syncLeverageControls, setActiveCoinTab } from './market-display.js';
import { togglePopover } from './popover-controller.js';

let leverageTimeout = null;
const COIN_DROPDOWN_VIEWPORT_MARGIN_PX = 8;
const COIN_DROPDOWN_GAP_PX = 4;

function applyConfirmedLeverage(coin, lev) {
  if (!Number.isFinite(lev) || lev <= 0) return;
  setExchangeLeverage(coin, lev);
  syncLeverageControls(lev);
  getSizeSliderMaxUpdater()?.();
}

function mobileDockInset() {
  const dock = document.getElementById('mobileDock');
  if (!dock) return 0;
  const style = window.getComputedStyle?.(dock);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return 0;
  return dock.offsetHeight || 0;
}

function positionCoinDropdown(category) {
  const { dropdown, trigger } = getCoinDropdownElements(category);
  if (!dropdown || !trigger) return;

  dropdown.style.position = 'fixed';
  dropdown.style.zIndex = '5000';
  dropdown.style.visibility = 'hidden';
  dropdown.style.display = 'flex';

  const triggerRect = trigger.getBoundingClientRect();
  const margin = COIN_DROPDOWN_VIEWPORT_MARGIN_PX;
  const bottomInset = margin + mobileDockInset();
  // Prefer nearly full width on narrow viewports so the market grid is usable.
  const isNarrow = window.innerWidth <= 767;
  if (isNarrow) {
    dropdown.style.width = `${Math.min(window.innerWidth - margin * 2, 640)}px`;
    dropdown.style.maxWidth = `${window.innerWidth - margin * 2}px`;
    dropdown.style.minWidth = '0';
    dropdown.style.maxHeight = `${Math.max(160, window.innerHeight - bottomInset - margin - 48)}px`;
  }

  const dropdownWidth = Math.max(dropdown.offsetWidth || 0, isNarrow ? 0 : 160);
  const dropdownHeight = dropdown.offsetHeight || 0;
  const maxLeft = Math.max(
    margin,
    window.innerWidth - dropdownWidth - margin
  );
  const left = isNarrow
    ? margin
    : Math.min(Math.max(triggerRect.left, margin), maxLeft);
  const preferredTop = triggerRect.bottom + COIN_DROPDOWN_GAP_PX;
  const aboveTop = triggerRect.top - dropdownHeight - COIN_DROPDOWN_GAP_PX;
  const top = (
    dropdownHeight > 0
    && preferredTop + dropdownHeight > window.innerHeight - bottomInset
    && aboveTop >= margin
  )
    ? aboveTop
    : Math.min(
      preferredTop,
      Math.max(
        margin,
        window.innerHeight - dropdownHeight - bottomInset
      )
    );

  dropdown.style.left = `${Math.round(left)}px`;
  dropdown.style.top = `${Math.round(top)}px`;
  dropdown.style.visibility = 'visible';
}

export async function setLeverage(coin) {
  if (!requireKey()) return;
  
  const maxLev = getMaxLeverage(coin) || 20;
  const currentLev = getDisplayedLeverageValue(maxLev);
  const levStr = prompt(`Set leverage for ${coin} (1-${maxLev}):`, currentLev.toString());
  if (!levStr || isNaN(parseInt(levStr))) return;

  const lev = parseInt(levStr);
  if (lev < 1 || lev > maxLev) {
    showToast(`Leverage must be 1-${maxLev}`, true);
    return;
  }

  try {
    const d = await apiPost('/api/set-leverage', {
      privateKey: getManagedExchangePrivateKey(),
      coin: coin,
      leverage: lev,
      isCross: !isBuilderPerpCoin(coin),
      mainnet: true
    });
    if (d.status === 'ok') {
      applyConfirmedLeverage(coin, lev);
      showToast(`✓ ${coin} leverage set to ${lev}x`, false);
      requestAccountEnrichment();
    } else {
      showToast('Set leverage failed: ' + (d.error || 'Unknown error'), true);
    }
  } catch(e) {
    showToast('Error: ' + e.message, true);
  }
}

export function updateLeverageFromSlider(slider) {
  const val = slider.value;
  const { sliderValue: levDisplay } = getLeverageControlElements();
  if (levDisplay) levDisplay.textContent = val + 'x';
  
  clearTimeout(leverageTimeout);
  leverageTimeout = setTimeout(async () => {
    if (!requireKey()) return;
    const coin = getCurrentCoin();
    const lev = parseInt(val);
    
    try {
      const d = await apiPost('/api/set-leverage', {
        privateKey: getManagedExchangePrivateKey(),
        coin: coin,
        leverage: lev,
        isCross: !isBuilderPerpCoin(coin),
        mainnet: true
      });
      if (d.status === 'ok') {
        applyConfirmedLeverage(coin, lev);
        requestAccountEnrichment();
      }
  } catch(e) {
    console.error('updateLeverageFromSlider error:', e);
  }
  }, 500);
}

// Perp pairs are split across separate category dropdowns. "crypto" covers all
// native perps; xyz synthetics are grouped into Indices, Commodities, Stocks, FX.
// Each dropdown shows the FULL list for its category (core tickers also remain
// available as the fixed tabs above).
const COIN_CATEGORIES = [
  { id: 'crypto', label: 'Crypto' },
  { id: 'indices', label: 'Indices' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'fx', label: 'FX' },
];

// Explicit classification for known xyz synthetics. Unknown xyz symbols default
// to "stocks" (the vast majority of HIP-3 equity listings). Keys are the bare
// symbol after "xyz:". Scoped to HL's active xyz dex listing — no aliases, no
// delisted names — so equity indices, country/sector ETFs, commodities, and FX
// land in the right dropdown instead of being dumped into Stocks.
const XYZ_CATEGORY = {
  // Equity index futures + broad/country/sector ETF baskets
  SP500: 'indices', XYZ100: 'indices', KR200: 'indices', JP225: 'indices',
  EWY: 'indices', EWJ: 'indices', EWT: 'indices', EWZ: 'indices',
  XLE: 'indices', SMH: 'indices', URNM: 'indices',
  // Commodities
  CL: 'commodities', BRENTOIL: 'commodities', NATGAS: 'commodities',
  GOLD: 'commodities', SILVER: 'commodities', COPPER: 'commodities',
  PLATINUM: 'commodities', PALLADIUM: 'commodities',
  // FX
  JPY: 'fx', EUR: 'fx', GBP: 'fx',
};

function classifyCoin(coin) {
  // Only xyz HIP-3 listings are synthetics (equities, indices, commodities, FX).
  // Native perps AND perps on other builder dexs are all crypto — never route a
  // non-xyz coin into Stocks just because it carries a "<dex>:" prefix.
  if (!coin || !isHip3Coin(coin)) return 'crypto';
  const idx = coin.indexOf(':');
  const sym = (idx >= 0 ? coin.substring(idx + 1) : coin).toUpperCase();
  return XYZ_CATEGORY[sym] || 'stocks';
}

// Hyperliquid's allMids feed mixes unnamed pseudo-tickers in with the real perp
// symbols: spot indices keyed as "@<index>" (e.g. "@1", "@107") and builder-perp
// asset IDs keyed as "#<index>" (e.g. "#1000", "#1581"). This is a perps
// terminal, so those unnamed numeric entries must be excluded from the coin
// dropdowns (otherwise they classify as "crypto" and, sorting before A-Z, bury
// the real tickers like BTC/ETH/SOL).
const NUMERIC_PSEUDO_TICKER = /^[@#]\d+$/;

function normalizeCoinKey(coin) {
  if (!coin) return coin;
  const idx = coin.indexOf(':');
  if (idx <= 0) return coin;
  const dex = coin.substring(0, idx);
  const rest = coin.substring(idx + 1);
  // Strip double dex:dex: prefix that allMids sometimes produces
  // (e.g. xyz:xyz:AAPL -> xyz:AAPL, km:km:USBOND -> km:USBOND)
  // Use recursion to handle arbitrary nesting depth.
  if (rest.toLowerCase().startsWith(dex.toLowerCase() + ':')) {
    return normalizeCoinKey(rest);
  }
  // Normalize xyz: prefix to lowercase for consistent classification
  if (dex.toLowerCase() === 'xyz') {
    return 'xyz:' + rest;
  }
  return coin;
}

// isLoadableMarketCoin keeps standard perps and xyz HIP-3 markets only.
// Other builder/HIP-3 dexs (para:, vntl:, mkts:, …) are excluded from every
// market list so they never appear as loadable coins.
function isLoadableMarketCoin(coin) {
  if (!coin || NUMERIC_PSEUDO_TICKER.test(coin)) return false;
  const idx = coin.indexOf(':');
  if (idx > 0) {
    return coin.substring(0, idx).toLowerCase() === 'xyz';
  }
  return true;
}

function getAllPerpCoins() {
  const coins = new Set();
  const mids = AppState.market?.allMids || {};
  for (const coin of Object.keys(mids)) coins.add(normalizeCoinKey(coin));
  // Merge in coin metadata so lists are complete even before allMids streams in.
  try {
    const meta = getCoinMeta?.();
    if (meta?.COIN_DECIMALS) for (const coin of Object.keys(meta.COIN_DECIMALS)) coins.add(normalizeCoinKey(coin));
  } catch { /* metadata not ready yet */ }
  return [...coins].filter(isLoadableMarketCoin);
}

function getCoinsForCategory(category) {
  return getAllPerpCoins()
    .filter((coin) => classifyCoin(coin) === category)
    .sort((a, b) => coinToTabId(a).localeCompare(coinToTabId(b)));
}

function buildCoinButtonHtml(coin) {
  const label = coinToTabId(coin);
  const haystack = `${label} ${coin}`.toLowerCase();
  return `<button class="coin-tab coin-dropdown-item" data-action="switchCoin" data-arg="${escapeHtml(coin)}" data-coin-search="${escapeHtml(haystack)}">${escapeHtml(label)}</button>`;
}

function filterCoinDropdownItems(searchTerm) {
  const list = document.getElementById('coinDropdownList');
  if (!list) return;
  const term = searchTerm.toLowerCase().trim();
  let visibleCount = 0;
  for (const item of list.children) {
    if (item.classList.contains('coin-dropdown-empty')) continue;
    const haystack = item.getAttribute('data-coin-search') || item.textContent.toLowerCase();
    const match = !term || haystack.includes(term);
    item.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  }
  let emptyMsg = list.querySelector('.coin-dropdown-empty');
  if (!visibleCount) {
    if (!emptyMsg) {
      emptyMsg = document.createElement('div');
      emptyMsg.className = 'coin-dropdown-empty';
      emptyMsg.textContent = 'No matching markets\u2026';
      list.appendChild(emptyMsg);
    }
    emptyMsg.style.display = '';
  } else if (emptyMsg) {
    emptyMsg.style.display = 'none';
  }
}

// Size the watchlist add-candidate list to its visible matches. Shrinks for a
// few hits; caps (and scrolls) when the set is large.
function fitWatchlistSearchList(list, dropdown) {
  if (!list || list.style.display === 'none') return;
  // Measure natural content height with CSS max-height temporarily disabled so
  // scrollHeight reflects every visible match (not the previous clamp).
  list.style.height = 'auto';
  list.style.maxHeight = 'none';
  const natural = list.scrollHeight;

  const viewportCap = Math.min(window.innerHeight * 0.5, 420);
  let cap = viewportCap;
  if (dropdown) {
    const searchH = dropdown.querySelector('.coin-dropdown-search')?.offsetHeight || 0;
    const pad = 20;
    const favFloor = 72;
    // Budget against the open panel / viewport so favorites stay reachable.
    const panelBudget = Math.max(
      64,
      Math.min(window.innerHeight * 0.85, 720) - searchH - favFloor - pad
    );
    cap = Math.min(viewportCap, panelBudget);
  }
  const next = Math.max(0, Math.min(natural, cap));
  list.style.height = `${Math.ceil(next)}px`;
  list.style.maxHeight = '';
}

// Daily % change presentation, matching the formatting/colors used by the coin
// tabs (buildMoverButtonHtml). Falls back to an em dash when the 24h cache has
// no value for the coin yet.
function formatChangePct(coin) {
  const raw = getCoin24hChange(coin);
  const change = Number(raw);
  if (raw === null || raw === undefined || !Number.isFinite(change)) {
    return { text: '—', cls: '' };
  }
  const sign = change >= 0 ? '+' : '';
  return { text: `${sign}${change.toFixed(2)}%`, cls: change >= 0 ? 'pos' : 'neg' };
}

function getWatchlistMidPrice(coin) {
  const mid = Number(AppState.market?.allMids?.[coin]);
  if (Number.isFinite(mid) && mid > 0) return mid;
  const mark = Number(getAssetSnapshot(coin)?.markPx);
  if (Number.isFinite(mark) && mark > 0) return mark;
  return null;
}

function formatWatchlistPrice(coin) {
  const px = getWatchlistMidPrice(coin);
  if (px == null) return '—';
  return fmtPrice(px, coin);
}

function formatWatchlistVol(coin) {
  const vol = Number(getAssetSnapshot(coin)?.dayNtlVlm);
  if (!Number.isFinite(vol) || vol <= 0) return '—';
  return fmtVol(vol);
}

function formatWatchlistOi(coin) {
  const oi = Number(getAssetSnapshot(coin)?.oi);
  if (!Number.isFinite(oi) || oi <= 0) return '—';
  return fmtVol(oi);
}

function formatWatchlistFunding(coin) {
  const funding = Number(getAssetSnapshot(coin)?.funding);
  if (!Number.isFinite(funding)) return { text: '—', cls: '' };
  // Snapshot already stores percent points (rate × 100). Color matches the
  // signed number like 24h %: positive green, negative red.
  const sign = funding > 0 ? '+' : '';
  return {
    text: `${sign}${funding.toFixed(4)}%`,
    cls: funding > 0 ? 'pos' : funding < 0 ? 'neg' : '',
  };
}

// Rolling ALL-print buy share from the live flow cache (watchlist coins stream
// trades alongside the active pair). Ideal short-horizon trigger context.
function getWatchlistFlowBuyPct(coin) {
  const flow = AppState.market?.flowCache?.get?.(coin);
  const buy = Number(flow?.buyVol) || 0;
  const sell = Number(flow?.sellVol) || 0;
  const total = buy + sell;
  if (!(total > 0)) return null;
  return (buy / total) * 100;
}

function formatWatchlistFlow(coin) {
  const buyPct = getWatchlistFlowBuyPct(coin);
  if (buyPct == null) return { text: '—', cls: '' };
  return {
    text: `${buyPct.toFixed(0)}%`,
    cls: buyPct >= 55 ? 'pos' : buyPct <= 45 ? 'neg' : '',
  };
}

// Session-local sort for the open watchlist table. Click a column title to
// sort; click again to flip direction. Defaults favor trading-trigger scans
// (biggest 24h/vol/OI first) while Pair defaults A→Z.
const WATCHLIST_SORT_COLUMNS = [
  { key: 'sym', label: 'Pair', cls: 'wl-sym', title: 'Sort by ticker', defaultDir: 'asc' },
  { key: 'px', label: 'Price', cls: 'wl-px', title: 'Sort by price', defaultDir: 'desc' },
  { key: 'vol', label: 'Vol', cls: 'wl-vol', title: 'Sort by 24h notional volume', defaultDir: 'desc' },
  { key: 'oi', label: 'OI', cls: 'wl-oi', title: 'Sort by open interest (notional)', defaultDir: 'desc' },
  { key: 'chg', label: '24h', cls: 'wl-chg', title: 'Sort by 24h change (gains / losers)', defaultDir: 'desc' },
  { key: 'fund', label: 'Fund', cls: 'wl-fund', title: 'Sort by funding rate', defaultDir: 'desc' },
  { key: 'flow', label: 'Flow', cls: 'wl-flow', title: 'Sort by recent buy share of tape', defaultDir: 'desc' },
];

let watchlistSort = { key: 'sym', dir: 'asc' };

function getWatchlistSortValue(coin, key) {
  switch (key) {
    case 'sym':
      return coinToTabId(coin).toLowerCase();
    case 'px':
      return getWatchlistMidPrice(coin);
    case 'chg': {
      const raw = getCoin24hChange(coin);
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'vol': {
      const n = Number(getAssetSnapshot(coin)?.dayNtlVlm);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    case 'oi': {
      const n = Number(getAssetSnapshot(coin)?.oi);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    case 'fund': {
      const n = Number(getAssetSnapshot(coin)?.funding);
      return Number.isFinite(n) ? n : null;
    }
    case 'flow':
      return getWatchlistFlowBuyPct(coin);
    default:
      return null;
  }
}

function compareWatchlistCoins(a, b, key = watchlistSort.key, dir = watchlistSort.dir) {
  const av = getWatchlistSortValue(a, key);
  const bv = getWatchlistSortValue(b, key);
  const aNull = av == null || av === '';
  const bNull = bv == null || bv === '';
  // Missing metrics sink to the bottom in both directions so ranked scans stay
  // useful (e.g. biggest 24h gains first, unknowns last).
  if (aNull && bNull) return coinToTabId(a).localeCompare(coinToTabId(b));
  if (aNull) return 1;
  if (bNull) return -1;
  let cmp = typeof av === 'string'
    ? av.localeCompare(String(bv))
    : av - bv;
  if (cmp === 0) cmp = coinToTabId(a).localeCompare(coinToTabId(b));
  return dir === 'asc' ? cmp : -cmp;
}

function sortWatchlistCoins(coins) {
  return [...coins].sort((a, b) => compareWatchlistCoins(a, b));
}

function setWatchlistSort(key) {
  if (!WATCHLIST_SORT_COLUMNS.some((col) => col.key === key)) return;
  if (watchlistSort.key === key) {
    watchlistSort = { key, dir: watchlistSort.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    const col = WATCHLIST_SORT_COLUMNS.find((c) => c.key === key);
    watchlistSort = { key, dir: col?.defaultDir || 'desc' };
  }
  refreshOpenWatchlist();
}

function buildWatchlistHeaderHtml() {
  const buttons = WATCHLIST_SORT_COLUMNS.map((col) => {
    const active = watchlistSort.key === col.key;
    const ariaSort = active
      ? (watchlistSort.dir === 'asc' ? 'ascending' : 'descending')
      : 'none';
    const marker = active ? (watchlistSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const activeCls = active ? ' is-active' : '';
    return `<button type="button" class="watchlist-sort-btn ${col.cls}${activeCls}"`
      + ` data-wl-sort="${col.key}"`
      + ` aria-sort="${ariaSort}"`
      + ` title="${escapeHtml(col.title)}">`
      + `${escapeHtml(col.label)}${marker}`
      + `</button>`;
  }).join('');
  return `<div class="watchlist-col-header" role="row">${buttons}</div>`;
}

function buildWatchlistFavoriteRowHtml(coin) {
  const label = coinToTabId(coin);
  const safeCoin = escapeHtml(coin);
  const safeLabel = escapeHtml(label);
  const change = formatChangePct(coin);
  const funding = formatWatchlistFunding(coin);
  const flow = formatWatchlistFlow(coin);
  const price = escapeHtml(formatWatchlistPrice(coin));
  const vol = escapeHtml(formatWatchlistVol(coin));
  const oi = escapeHtml(formatWatchlistOi(coin));
  const changeCls = change.cls ? ` ${change.cls}` : '';
  const fundCls = funding.cls ? ` ${funding.cls}` : '';
  const flowCls = flow.cls ? ` ${flow.cls}` : '';

  return `<div class="watchlist-fav-row" data-watchlist-coin="${safeCoin}">`
    + `<button class="coin-tab coin-dropdown-item watchlist-fav-btn" data-action="switchCoin" data-arg="${safeCoin}" title="Open ${safeLabel}">`
    + `<span class="wl-sym watchlist-fav-label">${safeLabel}</span>`
    + `<span class="wl-px" data-wl="price">${price}</span>`
    + `<span class="wl-vol" data-wl="vol">${vol}</span>`
    + `<span class="wl-oi" data-wl="oi">${oi}</span>`
    + `<span class="wl-chg change-pct${changeCls}" data-wl="change">${escapeHtml(change.text)}</span>`
    + `<span class="wl-fund${fundCls}" data-wl="fund">${escapeHtml(funding.text)}</span>`
    + `<span class="wl-flow${flowCls}" data-wl="flow">${escapeHtml(flow.text)}</span>`
    + `</button>`
    + `<button class="watchlist-remove-btn" data-action="removeFromWatchlist" data-arg="${safeCoin}" data-stop-propagation="true" title="Remove from watchlist" aria-label="Remove ${safeLabel} from watchlist">✕</button>`
    + `</div>`;
}

function buildWatchlistAddButtonHtml(coin) {
  const label = coinToTabId(coin);
  const haystack = `${label} ${coin}`.toLowerCase();
  return `<button class="coin-tab coin-dropdown-item" data-action="addToWatchlist" data-arg="${escapeHtml(coin)}" data-coin-search="${escapeHtml(haystack)}">${escapeHtml(label)}</button>`;
}

function renderWatchlistDropdown(dropdown) {
  // Mark the surface before positionCoinDropdown measures offsetWidth, so the
  // content-sized watchlist width (CSS [data-category="watchlist"]) is applied
  // when the open position is computed rather than the wide default.
  dropdown.dataset.category = 'watchlist';
  const watchlisted = new Set(getWatchlist());
  // Add-candidates: the full universe minus coins already watchlisted.
  const candidates = getAllPerpCoins()
    .filter((coin) => !watchlisted.has(coin))
    .sort((a, b) => coinToTabId(a).localeCompare(coinToTabId(b)));
  const favorites = getWatchlist();

  let html = '';
  html += '<input class="coin-dropdown-search" type="text" placeholder="Search to add…" autocomplete="off">';
  // Results: shown only while searching (hidden when the search box is empty).
  html += '<div id="coinDropdownList" class="coin-dropdown-list" style="display:none;">';
  html += candidates.map(buildWatchlistAddButtonHtml).join('');
  html += '</div>';
  // Favorites: always visible below the search. Pair-sort keeps category
  // groups; metric sorts flatten so biggest gains/vol/OI rank across types.
  html += '<div class="watchlist-favorites">';
  if (!favorites.length) {
    html += '<div class="coin-dropdown-empty">No markets yet — search above to add.</div>';
  } else {
    html += buildWatchlistHeaderHtml();
    if (watchlistSort.key === 'sym') {
      const groups = {};
      for (const cat of COIN_CATEGORIES) groups[cat.id] = [];
      for (const coin of favorites) {
        const cat = classifyCoin(coin);
        if (groups[cat]) groups[cat].push(coin);
      }
      for (const cat of COIN_CATEGORIES) {
        const coins = groups[cat.id];
        if (!coins.length) continue;
        html += '<div class="watchlist-group"><div class="watchlist-group-label">' + cat.label + '</div>';
        html += sortWatchlistCoins(coins).map(buildWatchlistFavoriteRowHtml).join('');
        html += '</div>';
      }
    } else {
      html += '<div class="watchlist-group">';
      html += sortWatchlistCoins(favorites).map(buildWatchlistFavoriteRowHtml).join('');
      html += '</div>';
    }
  }
  html += '</div>';
  dropdown.innerHTML = html;

  const searchInput = dropdown.querySelector('.coin-dropdown-search');
  const list = dropdown.querySelector('#coinDropdownList');
  if (searchInput && list) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim();
      list.style.display = term ? '' : 'none';
      // Clear any prior inline height so the panel can re-size to matches.
      list.style.height = '';
      list.style.maxHeight = '';
      dropdown.classList.toggle('is-searching', Boolean(term));
      if (term) filterCoinDropdownItems(searchInput.value);
      // Fit list height to visible results (capped by CSS max-height).
      if (term) fitWatchlistSearchList(list, dropdown);
      // Re-anchor after height changes so the panel stays in the viewport.
      if (dropdown.dataset.open === 'true') positionCoinDropdown('watchlist');
    });
  }
  dropdown.classList.remove('is-searching');
  for (const btn of dropdown.querySelectorAll('[data-wl-sort]')) {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setWatchlistSort(btn.getAttribute('data-wl-sort'));
    });
  }
  if (list) list.scrollTop = 0;
  // Only auto-focus search on a fresh open; re-sort re-renders should leave
  // focus on the header the user just clicked.
  if (searchInput && !dropdown.dataset.watchlistSorted) {
    requestAnimationFrame(() => searchInput.focus());
  }
  if (favorites.length) dropdown.dataset.watchlistSorted = '1';
}

function renderCoinDropdown(category) {
  const { dropdown } = getCoinDropdownElements(category);
  if (!dropdown) return;

  if (category === 'watchlist') {
    renderWatchlistDropdown(dropdown);
    return;
  }

  if (category === 'hidelist' || category === 'hideList') {
    renderHideListDropdown(dropdown);
    return;
  }

  const coins = getCoinsForCategory(category);

  let html = '';
  // Search input
  html += '<input class="coin-dropdown-search" type="text" placeholder="Search markets\u2026" autocomplete="off">';
  html += '<div id="coinDropdownList" class="coin-dropdown-list">';
  if (!coins.length) {
    html += '<div class="coin-dropdown-empty">No markets available yet\u2026</div>';
  } else {
    html += coins.map(buildCoinButtonHtml).join('');
  }
  html += '</div>';
  dropdown.innerHTML = html;

  // Wire up search input
  const searchInput = dropdown.querySelector('.coin-dropdown-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterCoinDropdownItems(searchInput.value);
    });
  }

  // The dropdown surface is reused across categories. Ensure each open starts at
  // the top; otherwise prior scroll position can make it look like A-G (or
  // earlier tickers) are missing until the user scrolls upward.
  const list = dropdown.querySelector('#coinDropdownList');
  if (list) list.scrollTop = 0;

  // Focus the search input
  if (searchInput) {
    requestAnimationFrame(() => searchInput.focus());
  }
}

let hidelistSort = { key: 'sym', dir: 'asc' };

function setHideListSort(key) {
  if (!WATCHLIST_SORT_COLUMNS.some((col) => col.key === key)) return;
  if (hidelistSort.key === key) {
    hidelistSort = { key, dir: hidelistSort.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    const col = WATCHLIST_SORT_COLUMNS.find((c) => c.key === key);
    hidelistSort = { key, dir: col?.defaultDir || 'desc' };
  }
  refreshOpenHideList();
}

function sortHideListCoins(coins) {
  return [...coins].sort((a, b) => compareWatchlistCoins(a, b, hidelistSort.key, hidelistSort.dir));
}

function buildHideListHeaderHtml() {
  const buttons = WATCHLIST_SORT_COLUMNS.map((col) => {
    const active = hidelistSort.key === col.key;
    const ariaSort = active
      ? (hidelistSort.dir === 'asc' ? 'ascending' : 'descending')
      : 'none';
    const marker = active ? (hidelistSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const activeCls = active ? ' is-active' : '';
    return `<button type="button" class="watchlist-sort-btn ${col.cls}${activeCls}"`
      + ` data-hl-sort="${col.key}"`
      + ` aria-sort="${ariaSort}"`
      + ` title="${escapeHtml(col.title)}">`
      + `${escapeHtml(col.label)}${marker}`
      + `</button>`;
  }).join('');
  return `<div class="watchlist-col-header" role="row">${buttons}</div>`;
}

function buildHideListRowHtml(coin) {
  const label = coinToTabId(coin);
  const safeCoin = escapeHtml(coin);
  const safeLabel = escapeHtml(label);
  const change = formatChangePct(coin);
  const funding = formatWatchlistFunding(coin);
  const flow = formatWatchlistFlow(coin);
  const price = escapeHtml(formatWatchlistPrice(coin));
  const vol = escapeHtml(formatWatchlistVol(coin));
  const oi = escapeHtml(formatWatchlistOi(coin));
  const changeCls = change.cls ? ` ${change.cls}` : '';
  const fundCls = funding.cls ? ` ${funding.cls}` : '';
  const flowCls = flow.cls ? ` ${flow.cls}` : '';

  return `<div class="watchlist-fav-row" data-watchlist-coin="${safeCoin}" data-hidelist-coin="${safeCoin}">`
    + `<button class="coin-tab coin-dropdown-item watchlist-fav-btn" data-action="switchCoin" data-arg="${safeCoin}" title="Open ${safeLabel}">`
    + `<span class="wl-sym watchlist-fav-label">${safeLabel}</span>`
    + `<span class="wl-px" data-wl="price">${price}</span>`
    + `<span class="wl-vol" data-wl="vol">${vol}</span>`
    + `<span class="wl-oi" data-wl="oi">${oi}</span>`
    + `<span class="wl-chg change-pct${changeCls}" data-wl="change">${escapeHtml(change.text)}</span>`
    + `<span class="wl-fund${fundCls}" data-wl="fund">${escapeHtml(funding.text)}</span>`
    + `<span class="wl-flow${flowCls}" data-wl="flow">${escapeHtml(flow.text)}</span>`
    + `</button>`
    + `<button class="watchlist-remove-btn" data-action="removeFromHideList" data-arg="${safeCoin}" data-stop-propagation="true" title="Remove from hide list" aria-label="Remove ${safeLabel} from hide list">✕</button>`
    + `</div>`;
}

function buildHideListAddButtonHtml(coin) {
  const label = coinToTabId(coin);
  const haystack = `${label} ${coin}`.toLowerCase();
  return `<button class="coin-tab coin-dropdown-item" data-action="addToHideList" data-arg="${escapeHtml(coin)}" data-coin-search="${escapeHtml(haystack)}">${escapeHtml(label)}</button>`;
}

function renderHideListDropdown(dropdown) {
  dropdown.dataset.category = 'hidelist';
  const hideListed = new Set(getHideList());
  const candidates = getAllPerpCoins()
    .filter((coin) => !hideListed.has(coin))
    .sort((a, b) => coinToTabId(a).localeCompare(coinToTabId(b)));
  const hiddenCoins = getHideList();

  let html = '';
  html += '<input class="coin-dropdown-search" type="text" placeholder="Search to hide…" autocomplete="off">';
  html += '<div id="coinDropdownList" class="coin-dropdown-list" style="display:none;">';
  html += candidates.map(buildHideListAddButtonHtml).join('');
  html += '</div>';
  html += '<div class="watchlist-favorites">';
  if (!hiddenCoins.length) {
    html += '<div class="coin-dropdown-empty">No hidden markets — search above to hide tickers from top movers.</div>';
  } else {
    html += buildHideListHeaderHtml();
    if (hidelistSort.key === 'sym') {
      const groups = {};
      for (const cat of COIN_CATEGORIES) groups[cat.id] = [];
      for (const coin of hiddenCoins) {
        const cat = classifyCoin(coin);
        if (groups[cat]) groups[cat].push(coin);
      }
      for (const cat of COIN_CATEGORIES) {
        const coins = groups[cat.id];
        if (!coins.length) continue;
        html += '<div class="watchlist-group"><div class="watchlist-group-label">' + cat.label + '</div>';
        html += sortHideListCoins(coins).map(buildHideListRowHtml).join('');
        html += '</div>';
      }
    } else {
      html += '<div class="watchlist-group">';
      html += sortHideListCoins(hiddenCoins).map(buildHideListRowHtml).join('');
      html += '</div>';
    }
  }
  html += '</div>';
  dropdown.innerHTML = html;

  const searchInput = dropdown.querySelector('.coin-dropdown-search');
  const list = dropdown.querySelector('#coinDropdownList');
  if (searchInput && list) {
    searchInput.addEventListener('input', () => {
      const term = searchInput.value.trim();
      list.style.display = term ? '' : 'none';
      list.style.height = '';
      list.style.maxHeight = '';
      dropdown.classList.toggle('is-searching', Boolean(term));
      if (term) filterCoinDropdownItems(searchInput.value);
      if (term) fitWatchlistSearchList(list, dropdown);
      if (dropdown.dataset.open === 'true') positionCoinDropdown('hidelist');
    });
  }
  dropdown.classList.remove('is-searching');
  for (const btn of dropdown.querySelectorAll('[data-hl-sort]')) {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setHideListSort(btn.getAttribute('data-hl-sort'));
    });
  }
  if (list) list.scrollTop = 0;
  if (searchInput && !dropdown.dataset.hidelistSorted) {
    requestAnimationFrame(() => searchInput.focus());
  }
  if (hiddenCoins.length) dropdown.dataset.hidelistSorted = '1';
}

export function toggleCoinDropdown(category = 'crypto') {
  const { dropdown, trigger } = getCoinDropdownElements(category);
  if (!dropdown || !trigger) return;
  togglePopover({
    id: 'markets',
    panel: dropdown,
    trigger,
    triggers: '[data-action="toggleCoinDropdown"]',
    openClass: 'cat-open',
    beforeOpen: () => {
      dropdown.dataset.category = category;
      renderCoinDropdown(category);
    },
    position: () => positionCoinDropdown(category),
    onClose: () => {
      delete dropdown.dataset.category;
      delete dropdown.dataset.watchlistSorted;
      delete dropdown.dataset.hidelistSorted;
    },
  });
}

// Re-render the watchlist dropdown in place if it's currently open. Resets the
// search back to the favorites view, which is the desired result after add/remove.
function refreshOpenWatchlist() {
  const dropdown = document.getElementById('coinDropdown');
  if (!dropdown || dropdown.dataset.open !== 'true' || dropdown.dataset.category !== 'watchlist') return;
  renderWatchlistDropdown(dropdown);
}

export function addToWatchlist(coin) {
  if (!coin) return;
  addWl(coin);
  refreshOpenWatchlist();
}

export function removeFromWatchlist(coin) {
  if (!coin) return;
  removeWl(coin);
  refreshOpenWatchlist();
}

function refreshOpenHideList() {
  const dropdown = document.getElementById('coinDropdown');
  if (!dropdown || dropdown.dataset.open !== 'true' || (dropdown.dataset.category !== 'hidelist' && dropdown.dataset.category !== 'hideList')) return;
  renderHideListDropdown(dropdown);
}

export function addToHideList(coin) {
  if (!coin) return;
  addHl(coin);
  refreshOpenHideList();
}

export function removeFromHideList(coin) {
  if (!coin) return;
  removeHl(coin);
  refreshOpenHideList();
}

export function handleWalletBtnClick() {
  handleWalletButtonSession();
}

export function updateCoinTabChange(coin) {
  const tabId = coinToTabId(coin);
  const changeEl = document.getElementById('change-' + tabId);
  const change = getCoin24hChange(coin);

  if (changeEl && change !== undefined) {
    const sign = parseFloat(change) >= 0 ? '+' : '';
    changeEl.textContent = sign + change + '%';
    changeEl.className = 'change-pct ' + (parseFloat(change) >= 0 ? 'pos' : 'neg');
  }

  // Mirror the live tick onto the watchlist dropdown if it's open.
  updateWatchlistChange(coin);
}

function isWatchlistDropdownOpen() {
  const dropdown = document.getElementById('coinDropdown');
  return !!(dropdown && dropdown.dataset.open === 'true' && (dropdown.dataset.category === 'watchlist' || dropdown.dataset.category === 'hidelist' || dropdown.dataset.category === 'hideList'));
}

function patchWatchlistCell(row, key, text, className) {
  const el = row.querySelector(`[data-wl="${key}"]`);
  if (!el) return;
  if (className != null) el.className = className;
  if (el.textContent !== text) el.textContent = text;
}

// Live-update a watchlisted coin's trading-trigger cells in place while the
// watchlist dropdown is open (change/vol/OI/funding from the 24h snapshot poll;
// price/flow refresh via refreshOpenWatchlistMetrics).
export function updateWatchlistChange(coin) {
  if (!isWatchlistDropdownOpen()) return;
  const dropdown = document.getElementById('coinDropdown');
  // Match by attribute value (not a CSS.escape selector) so HIP-3 coins like
  // xyz:AAPL never trip on the colon in querySelector.
  const row = [...(dropdown?.querySelectorAll('.watchlist-fav-row') || [])]
    .find((el) => el.getAttribute('data-watchlist-coin') === coin);
  if (!row) return;

  const change = formatChangePct(coin);
  patchWatchlistCell(row, 'change', change.text, `wl-chg change-pct${change.cls ? ' ' + change.cls : ''}`);
  patchWatchlistCell(row, 'vol', formatWatchlistVol(coin), 'wl-vol');
  patchWatchlistCell(row, 'oi', formatWatchlistOi(coin), 'wl-oi');
  const funding = formatWatchlistFunding(coin);
  patchWatchlistCell(row, 'fund', funding.text, `wl-fund${funding.cls ? ' ' + funding.cls : ''}`);
}

// Refresh price + flow for every open watchlist row. Called on mids ticks and
// after flow snapshots so the trigger columns stay live without re-rendering
// the whole dropdown (which would steal focus from the search box).
export function refreshOpenWatchlistMetrics() {
  if (!isWatchlistDropdownOpen()) return;
  const dropdown = document.getElementById('coinDropdown');
  for (const row of dropdown.querySelectorAll('.watchlist-fav-row[data-watchlist-coin]')) {
    const coin = row.getAttribute('data-watchlist-coin');
    if (!coin) continue;
    patchWatchlistCell(row, 'price', formatWatchlistPrice(coin), 'wl-px');
    const flow = formatWatchlistFlow(coin);
    patchWatchlistCell(row, 'flow', flow.text, `wl-flow${flow.cls ? ' ' + flow.cls : ''}`);
  }
}

// Build a single dynamic ticker button. Keeps the same markup, id scheme and
// switchCoin delegation as the old static tabs so coin-switching and the active
// highlight (setActiveCoinTab) keep working unchanged.
function buildMoverButtonHtml(entry) {
  const coin = entry.coin;
  const tabId = coinToTabId(coin);
  const change = Number(entry.change);
  const sign = change >= 0 ? '+' : '';
  const cls = change >= 0 ? 'pos' : 'neg';
  const changeStr = Number.isFinite(change) ? `${sign}${change.toFixed(2)}%` : '—';
  // No id on the change span: renderMoverRows owns this value (from the movers
  // payload). Giving it id="change-<tabId>" would let the legacy 24h poller's
  // updateCoinTabChange() clobber it with a differently-computed % and color.
  return `<button class="coin-tab" data-action="switchCoin" data-arg="${escapeHtml(coin)}" data-stop-propagation="true" id="tab-${escapeHtml(tabId)}"><span style="display:block">${escapeHtml(tabId)}</span><span class="change-pct ${cls}">${changeStr}</span></button>`;
}

export function renderMoverRows(gainers = [], losers = []) {
  const gainersRow = document.getElementById('gainersRow');
  const losersRow = document.getElementById('losersRow');
  const visibleGainers = gainers.filter((entry) => !isHideListed(entry?.coin));
  const visibleLosers = losers.filter((entry) => !isHideListed(entry?.coin));
  if (gainersRow) gainersRow.innerHTML = visibleGainers.map(buildMoverButtonHtml).join('');
  if (losersRow) losersRow.innerHTML = visibleLosers.map(buildMoverButtonHtml).join('');
  // Re-apply the active highlight: the current coin may have been re-rendered.
  setActiveCoinTab(getCurrentCoin(), coinToTabId);
}
