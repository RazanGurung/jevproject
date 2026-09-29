import { AppState } from '../state/store.js';
import { setLegacy } from '../state/legacy-globals.js';
import { deriveMidFromBook, setMarketPrice } from '../state/market-state.js';
import {
  getLivePriceLineAgeMs,
  invalidateLivePriceLine,
  syncProjectedLiveCandle,
  syncLivePriceLine,
} from '../chart/lightweight-chart.js';
import { syncPriceConsumers } from '../ui/topbar.js';
import { markUiPerformance } from '../utils/performance.js';

let startupSplashHidden = false;

function maybeHideStartupSplash() {
  if (startupSplashHidden) return;
  const candles = AppState.market.candles;
  if (!Array.isArray(candles) || candles.length === 0) return;
  const splash = document.getElementById('startup-splash');
  if (!splash) return;
  startupSplashHidden = true;
  markUiPerformance('startup-interactive', {
    coin: AppState.trading.currentCoin,
    timeframe: AppState.trading.currentTimeframe,
    candles: candles.length,
  });
  splash.classList.add('hidden');
  setTimeout(() => splash.remove(), 260);
}

function applyCurrentPrice(coin, price) {
  if (!coin || !Number.isFinite(price) || price <= 0) return;
  setMarketPrice(coin, price);
  const isActiveCoin = coin === AppState.trading.currentCoin;
  if (isActiveCoin) {
    // Live chart primitives update every tick (cheap native LC calls).
    const lastCandleOpen = Number(AppState.market.candles?.[AppState.market.candles.length - 1]?.o || price);
    syncLivePriceLine(price, lastCandleOpen);
    syncProjectedLiveCandle({
      price,
      candles: AppState.market.candles,
      coin,
      timeframe: AppState.trading.currentTimeframe,
    });
    maybeHideStartupSplash();
  }
  // Topbar digit, document title, and ticket summary are throttled inside
  // syncPriceConsumers → updateTopBar so mid/book storms do not recompute the
  // full ticket layout at exchange tick rate.
  syncPriceConsumers(coin, price, { refreshTopBar: isActiveCoin });
  if (isActiveCoin) setLegacy('currentPrice', price);
}

function maybeInvalidateStaleLivePriceLine(maxAgeMs) {
  if (getLivePriceLineAgeMs() <= maxAgeMs) return;
  invalidateLivePriceLine();
}

function updatePriceFromL2({
  onSummaryUpdate,
  onRefreshLimitPreviewTracking,
} = {}) {
  const currentCoin = AppState.trading.currentCoin;
  if (AppState.market.allMids[currentCoin]) return false;

  const mid = deriveMidFromBook(AppState.market.book);
  if (mid === null) return false;

  applyCurrentPrice(currentCoin, mid);
  onSummaryUpdate?.();
  onRefreshLimitPreviewTracking?.();
  return true;
}

export {
  applyCurrentPrice,
  maybeInvalidateStaleLivePriceLine,
  updatePriceFromL2,
};
