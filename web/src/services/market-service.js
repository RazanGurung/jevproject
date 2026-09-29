/**
 * Market service façade — wires pollers / reference data / CVD alerts and
 * re-exports chart + RVWAP services. Chart candle implementation lives in
 * chart-candle-service.js; RVWAP in rvwap-source-service.js.
 */

import { AppState } from '../state/store.js';
import { hlPost, fetchWithDedup, apiGet, apiPost } from './api.js';
import { createMarket24hPollingService } from './market-24h-polling.js';
import { createTopMoversService } from './top-movers-service.js';
import { createMispricingService } from './mispricing-service.js';
import { createPreloadHintService } from './preload-hint-service.js';
import { renderMispricing } from '../render/mispricing.js';
import { createCvdAlertMonitor, isCvdAlertsMuted } from './cvd-alert-monitor.js';
import { getWatchlist, subscribeWatchlist } from './watchlist-store.js';
import { createMarketReferenceDataService } from './market-reference-data.js';
import { showToast } from '../ui/toast.js';
import { playAlertBeep } from '../ui/alert-sound.js';
import { getWalletAddress } from '../state/account-selectors.js';
import { getCurrentCoin } from '../state/trading-selectors.js';
import { fetchChartCandles as requestChartCandles } from './chart-data.js';
import { getDex } from '../utils/helpers.js';
import {
  ensureRvwapSource,
  hydrateRvwapSource,
  scheduleActiveRvwapHydration,
  setWatchlistRvwapHydration,
  stopWatchlistRvwapHydration,
  cancelRvwapHydrationWork,
  cancelRvwapSourceRetries,
  RVWAP_SOURCE_INTERVAL,
  RVWAP_SOURCE_LOOKBACK_MS,
} from './rvwap-source-service.js';
import {
  fetchCandles,
  ensureActiveCvdRefresh,
  prefetchAdjacentTimeframes,
  fetchHistoricalCandles,
  fetchL2Snapshot,
} from './chart-candle-service.js';
import {
  updateExchangeHtml,
  applyVwapResult,
  applyCoin24hChange,
  applyMarketMovers,
} from '../ui/market-ui.js';

const marketReferenceDataService = createMarketReferenceDataService({
  getCurrentCoin,
  getWalletAddress,
  getDex,
  hlPost,
  fetchWithDedup,
  apiPost,
  fetchChartCandles: requestChartCandles,
  updateExchangeHtml,
  applyVwapResult,
});

const {
  refreshExchangeInfo,
  fetchMeta,
  fetchVWAP,
  fetchFunding,
} = marketReferenceDataService;

const market24hPollingService = createMarket24hPollingService({
  apiGet,
  hlPost,
  fetchChartCandles: requestChartCandles,
  applyCoin24hChange,
});

const {
  fetch24hChanges,
  start24hPolling,
  stop24hPolling,
} = market24hPollingService;

const topMoversService = createTopMoversService({
  apiGet,
  applyMovers: applyMarketMovers,
});

const {
  fetchTopMovers,
  startTopMoversPolling,
  stopTopMoversPolling,
} = topMoversService;

const mispricingService = createMispricingService({
  apiGet,
  applyMispricing: (entries) => {
    AppState.market.stockMispricing = entries;
    renderMispricing();
  },
});

const {
  fetchMispricing,
  startMispricingPolling,
  stopMispricingPolling,
} = mispricingService;

const preloadHintService = createPreloadHintService({
  apiPost,
  getWatchlist,
  subscribeWatchlist,
  onAcceptedWatchlist: setWatchlistRvwapHydration,
  onStop: stopWatchlistRvwapHydration,
});

const {
  startPreloadHints,
  stopPreloadHints,
} = preloadHintService;

function getMonitoredCoins() {
  const movers = [
    ...(Array.isArray(AppState.market.topGainers) ? AppState.market.topGainers : []),
    ...(Array.isArray(AppState.market.topLosers) ? AppState.market.topLosers : []),
  ].map((entry) => entry?.coin).filter(Boolean);
  // Watch the user's watchlisted pairs too, not just the top movers. The
  // monitor de-dupes its coin list, so overlap with movers is harmless.
  return [...movers, ...getWatchlist()];
}

function announceCvdAlert({ coin, direction }) {
  // +0.98 is a bullish extreme, -0.98 a bearish extreme.
  const message = direction === 'up'
    ? `⚡ ${coin} bullish extreme`
    : `⚡ ${coin} bearish extreme`;
  // Persist until the user clicks it — a CVD extreme is easy to miss if the
  // toast auto-dismisses while they're away from the screen.
  showToast(message, false, { persist: true });
  playAlertBeep();
}

const cvdAlertMonitor = createCvdAlertMonitor({
  getMoverCoins: getMonitoredCoins,
  fetchReadings: (coins) => apiPost('/api/cvd-scan', { coins }),
  onAlert: announceCvdAlert,
  isMuted: isCvdAlertsMuted,
  // Runs independent of the market radar. The backend owns candle hydration,
  // closed-1h-bar selection and oscillator computation; this monitor owns only
  // crossing state and delivery.
  getIsConnected: () => true,
});

const { start: startCvdAlertMonitor, stop: stopCvdAlertMonitor } = cvdAlertMonitor;


export {
  fetchMeta,
  refreshExchangeInfo,
  fetchCandles,
  ensureActiveCvdRefresh,
  prefetchAdjacentTimeframes,
  fetchHistoricalCandles,
  ensureRvwapSource,
  hydrateRvwapSource,
  scheduleActiveRvwapHydration,
  setWatchlistRvwapHydration,
  stopWatchlistRvwapHydration,
  cancelRvwapHydrationWork,
  cancelRvwapSourceRetries,
  RVWAP_SOURCE_INTERVAL,
  RVWAP_SOURCE_LOOKBACK_MS,
  fetchVWAP,
  fetchFunding,
  fetch24hChanges,
  fetchL2Snapshot,
  start24hPolling,
  stop24hPolling,
  fetchTopMovers,
  startTopMoversPolling,
  stopTopMoversPolling,
  fetchMispricing,
  startMispricingPolling,
  stopMispricingPolling,
  startPreloadHints,
  stopPreloadHints,
  startCvdAlertMonitor,
  stopCvdAlertMonitor,
};
