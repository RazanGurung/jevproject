/**
 * Market chrome pollers (24h, movers, mispricing, preload, CVD alerts).
 * Chart candle/RVWAP truth still flows through market-service / market-session;
 * this module only re-exports already-extracted poller factories' bindings.
 */
export {
  fetch24hChanges,
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
} from './market-service.js';
