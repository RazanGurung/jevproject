/**
 * Market UI - market data adapters for display, chart sync, and UI updates.
 * Canonical market-state writes are delegated to state helpers rather than
 * being owned directly in this module.
 */

import { AppState, setExchangeLeverage } from '../state/store.js';
import { completeChartSession } from '../state/chart-session.js';
import {
  findAssetCtx,
  getAssetSnapshot,
  isActiveMarketSelection,
  setActiveAssetCtx,
  setMarketBookSnapshot,
  setMarketCandles,
  setMarketPrice,
  setMarketVwapData,
} from '../state/market-state.js';
import { getCurrentPrice } from '../state/trading-selectors.js';
import { fmtVol } from '../utils/format.js';
import { updateSizeSliderMax } from './account-ui.js';
import { syncLeverageControls } from './market-display.js';
import { syncPriceConsumers } from './topbar.js';
import { updateCoinTabChange, renderMoverRows } from './controls.js';
import { scheduleOrderbookRender } from '../streams/market-ws.js';
import { isHideListed, subscribeHideList } from '../services/hide-list-store.js';

const $ = id => document.getElementById(id);

/**
 * Apply a resolved price to state and notify UI consumers.
 */
function applyResolvedPrice(coin, price) {
  if (!coin || !Number.isFinite(price) || price <= 0) return;
  setMarketPrice(coin, price);
  syncPriceConsumers(coin, price, { refreshTopBar: coin === AppState.trading.currentCoin });
}

function applyExchangeLeverage(coin, leverage) {
  if (!Number.isFinite(leverage) || leverage <= 0) return;
  setExchangeLeverage(coin, leverage);
  syncLeverageControls(leverage);
  updateSizeSliderMax();
}

/**
 * Update the exchange metadata display (volume, OI, funding, leverage).
 */
function updateExchangeHtml(coin, meta, funding, activeAssetData) {
  const currentCoin = AppState.trading.currentCoin;
  if (coin !== currentCoin) return;

  let resolvedPrice = getCurrentPrice();
  const ctx = findAssetCtx(meta, coin);
  if (ctx) setActiveAssetCtx(coin, ctx);

  const metaMarkPx = parseFloat(ctx?.markPx || 0);
  const activeMarkPx = parseFloat(activeAssetData?.markPx || 0);
  resolvedPrice = resolvedPrice || metaMarkPx || activeMarkPx;

  if (resolvedPrice > 0) {
    applyResolvedPrice(coin, resolvedPrice);
  }

  if ($('oiVal') && ctx) {
    const oiPrice = resolvedPrice || metaMarkPx || activeMarkPx;
    const openInterest = parseFloat(ctx.openInterest || 0);
    if (oiPrice > 0 && openInterest > 0) {
      $('oiVal').textContent = fmtVol(openInterest * oiPrice);
    } else if (openInterest > 0) {
      $('oiVal').textContent = fmtVol(openInterest);
    }
  }

  if ($('fundingVal')) {
    let ratePct = null;
    if (Array.isArray(funding) && funding.length > 0) {
      ratePct = parseFloat(funding[funding.length - 1].fundingRate || 0) * 100;
    } else if (funding != null && !Array.isArray(funding) && Number.isFinite(Number(funding))) {
      ratePct = Number(funding);
    } else {
      const snapFunding = getAssetSnapshot(coin)?.funding;
      if (Number.isFinite(Number(snapFunding))) ratePct = Number(snapFunding);
    }
    if (Number.isFinite(ratePct)) {
      $('fundingVal').textContent = ratePct.toFixed(4) + '% / 8h';
      $('fundingVal').style.color = 'var(--text2)';
    }
  }

  const leverage = parseInt(activeAssetData?.leverage, 10);
  if (Number.isFinite(leverage) && leverage > 0) {
    applyExchangeLeverage(coin, leverage);
  }
}

/**
 * Apply candle data to state and render the chart.
 */
async function applyCandles(candles, coin, timeframe) {
  if (!Array.isArray(candles) || !candles.length) return;
  const isActiveSelection = isActiveMarketSelection(coin, timeframe);
  if (!isActiveSelection) return;
  // The persistent Lightweight Chart recreates its main series when this key
  // changes. Recreating the compatibility canvas here duplicated the complete
  // setData/indicator pass during cached pair switches and produced 60–90ms
  // main-thread stalls.
  // A snapshot may repair an interior candle without changing the displayed
  // range. Mark it explicitly so every candle-derived overlay rebuilds rather
  // than trusting its head/tail fast-path.
  setMarketCandles(candles, { snapshot: true });
  if (isActiveSelection) {
    completeChartSession({ coin, timeframe });
  }

  if (isActiveSelection) {
    const { initChart, updateChart } = await import('../chart/chart-render.js');
    const hasChartCanvas = typeof document !== 'undefined' && !!document.getElementById('chartCanvas');
    if (!hasChartCanvas) {
      initChart();
    } else {
      updateChart();
    }
  }
}

/**
 * Apply VWAP results to state.
 */
function applyVwapResult(result) {
  if (!result) return;
  setMarketVwapData(result);
}

/**
 * Apply L2 book snapshot to state and schedule render.
 */
function applyBookSnapshot(book) {
  if (!book) return;
  setMarketBookSnapshot(book);
  scheduleOrderbookRender();
}

/**
 * Apply 24h change (and optional vol/OI/funding snapshot) for a coin and update
 * tab / open-watchlist display.
 */
async function applyCoin24hChange(coin, changeOrSnapshot) {
  const { setAssetSnapshot } = await import('../state/market-state.js');
  setAssetSnapshot(coin, changeOrSnapshot);
  updateCoinTabChange(coin);
}

function sameCoinMembership(left = [], right = []) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  for (let i = 0; i < left.length; i += 1) {
    if (!rightSet.has(left[i])) return false;
  }
  return true;
}

let lastRawGainers = [];
let lastRawLosers = [];

function reapplyMarketMovers() {
  applyMarketMovers(lastRawGainers, lastRawLosers);
}

subscribeHideList(reapplyMarketMovers);

/**
 * Apply ranked top gainers/losers to the topbar rows.
 * Ranking/order can change every poll; only membership changes should re-warm
 * trade/book subscriptions (same set, new order is a pure UI re-render).
 * Hidden tickers are excluded from populating the top movers.
 */
function applyMarketMovers(gainers = [], losers = []) {
  lastRawGainers = gainers;
  lastRawLosers = losers;
  const visibleGainers = gainers.filter((entry) => !isHideListed(entry?.coin));
  const visibleLosers = losers.filter((entry) => !isHideListed(entry?.coin));
  AppState.market.topGainers = visibleGainers;
  AppState.market.topLosers = visibleLosers;
  const nextTracked = Array.from(new Set(
    [...visibleGainers, ...visibleLosers].map((entry) => String(entry?.coin || '').trim()).filter(Boolean)
  ));
  const membershipChanged = !sameCoinMembership(AppState.trading.trackedCoins || [], nextTracked);
  AppState.trading.trackedCoins = nextTracked;
  renderMoverRows(visibleGainers, visibleLosers);
  if (membershipChanged) {
    document.dispatchEvent(new CustomEvent('pez:tracked-coins-changed'));
  }
}

export {
  applyResolvedPrice,
  applyExchangeLeverage,
  updateExchangeHtml,
  applyCandles,
  applyVwapResult,
  applyBookSnapshot,
  applyCoin24hChange,
  applyMarketMovers,
  reapplyMarketMovers,
};
