/**
 * State store - canonical state object and shared mutable runtime caches
 */

import {
  beginChartSession,
  completeChartSession,
  failChartSession,
  getChartSession,
  setChartSessionNotice,
  setIsLoadingChart,
} from './chart-session.js';

const RVWAP_LOOKBACKS = Object.freeze(['7D', '30D', '90D', '365D']);
const RVWAP_BAND_LOOKBACKS = Object.freeze(['7D', '30D', '90D']);
const SESSION_VWAP_PERIODS = Object.freeze(['daily', 'weekly', 'monthly']);
const INDICATOR_STARTUP_DEFAULTS = Object.freeze({
  manualAnchoredVwapVisible: true,
  sessionVwap: Object.freeze({
    daily: false,
    weekly: false,
    monthly: false,
  }),
  rvwapLookbacks: Object.freeze(['30D']),
  rvwapBandLookbacks: Object.freeze(['30D']),
  priceProjectionVisible: false,
  // Remaining-week path projection (research-only; off by default).
  weekPathProjectionVisible: false,
  weekPathEnvelopeVisible: true,
  monthlyVolumeProfileVisible: false,
  volumeProfilePeriod: 'visible',
  volumeProfileLvnVisible: true,
  liquidationClustersVisible: false,
  whaleMarkersVisible: false,
  whaleMarkerMinNotional: 100000,
  jevSignalsVisible: false,
  candleOverlay: Object.freeze({
    mode: 'off',
    baseCandles: 'dimmed',
    contrast: 0.5,
    heikinAshi: Object.freeze({
      showWicks: true,
      dimmed: false,
      opacity: 0.5,
    }),
    renko: Object.freeze({
      brickMode: 'atr',
      atrPeriod: 14,
      percent: 0.25,
      fixedSize: 0,
      showWicks: false,
      dimmed: true,
      opacity: 0.5,
    }),
  }),
});

const AppState = {
  trading: {
    currentCoin: 'BTC',
    currentTimeframe: '2h',
    currentSide: 'buy',
    currentOrderType: 'limit',
    currentPrice: 0,
    lastDeployedPlan: null,
    trackedCoins: [],
    recentCoins: [],
  },
  market: {
    candles: [],
    // Advances only when a REST snapshot/history replacement becomes the
    // active chart source. Live WebSocket ticks intentionally do not touch it:
    // they are rendered incrementally by series.update().
    candleSnapshotRevision: 0,
    candleIntegrity: {
      detectedGaps: 0,
      repairAttempts: 0,
      repairSuccesses: 0,
      validationFailures: 0,
      activeRepair: null,
      lastVerifiedSnapshotAt: 0,
    },
    rvwapSource: {
      coin: '',
      interval: '4h',
      status: 'idle',
      requestedAt: 0,
      loadedAt: 0,
      count: 0,
      firstTime: 0,
      lastTime: 0,
      complete: false,
      verifiedAt: 0,
      stale: false,
      refreshing: false,
      error: '',
    },
    trades: [],
    book: { asks: [], bids: [] },
    allMids: {},
    vwapData: null,
    newsByCoin: {},
    newsItems: [],
    newsSourceHealth: {},
    newsConfigured: true,
    newsProvider: 'google-news-rss',
    newsLoading: false,
    newsError: '',
    lastPriceUpdateAt: {},
    largeTrades: [],
    // orderFlow / largeTradeFlow hold the active coin's backend-computed flow
    // (see applyFlowSnapshot); the *Cache Maps hold every streamed coin's flow.
    orderFlow: { buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500 },
    largeTradeFlow: { buyVol: 0, sellVol: 0, sampleCount: 0, sampleCapacity: 500 },
    tradeCache: new Map(),
    largeTradeCache: new Map(),
    flowCache: new Map(),
    whaleFlowCache: new Map(),
    flowMetaCache: new Map(),
    // Per-coin transport epoch and backend revision. Values remain cached
    // across reconnects, but only the current connected epoch is switch-safe.
    flowFreshnessCache: new Map(),
    whaleEventCache: new Map(),
    whaleResponseCache: new Map(),
    chartWhaleTrades: new Map(),
    bookCache: new Map(),
    // Per-coin vol/OI/funding snapshots from /api/24h-changes (watchlist columns).
    assetSnapshots: {},
    activeJevSignal: null,
  },
  account: {
    privateKey: '',
    signerAddress: '',
    walletAddress: '',
    state: null,
    exchangeLeverageByCoin: {},
    defaultLeverageAppliedByCoin: {},
    spotBalance: 0,
    openOrders: [],
    lastOrderRevision: 0,
    fills: [],
    twapStates: {},
    lastTwapId: null,
    pendingHip3CloseUntilByCoin: {},
  },
  ui: {
    hideValues: false,
    isLoadingChart: false,
    chartNotice: '',
    chartTouchMode: 'inspect',
    chartSession: {
      status: 'idle',
      message: '',
      coin: '',
      timeframe: '',
      requestToken: null,
      updatedAt: 0,
    },
    // The read-only ticker news feed is visible and connected by default.
    marketRadarVisible: true,
    marketRadarConnected: true,
    tradingPanelVisible: false,
    liqPanelVisible: false,
    // Mobile dock: chart | book | news | trade | account
    mobileView: 'chart',
    // Layout prefs (persisted in localStorage)
    moversCollapsed: false,
    colWidths: null,
    userEditedPrice: false,
    limitPriceEntryMode: 'auto',
    limitPriceAutoTrack: true,
    limitPreviewAutoTrack: true,
    activeCandleRequestToken: null,
    chartPreviewLevels: [],
    scalePreviewOrders: null,
    indicatorsPanelVisible: false,
    manualAnchoredVwapVisible: INDICATOR_STARTUP_DEFAULTS.manualAnchoredVwapVisible,
    manualAnchoredVwapPlacementActive: false,
    sessionVwap: { ...INDICATOR_STARTUP_DEFAULTS.sessionVwap },
    rvwapLookbacks: [...INDICATOR_STARTUP_DEFAULTS.rvwapLookbacks],
    rvwapBandLookbacks: [...INDICATOR_STARTUP_DEFAULTS.rvwapBandLookbacks],
    priceProjectionVisible: INDICATOR_STARTUP_DEFAULTS.priceProjectionVisible,
    weekPathProjectionVisible: INDICATOR_STARTUP_DEFAULTS.weekPathProjectionVisible,
    weekPathEnvelopeVisible: INDICATOR_STARTUP_DEFAULTS.weekPathEnvelopeVisible,
    cvdOscillatorLookback: '90D',
    monthlyVolumeProfileVisible: INDICATOR_STARTUP_DEFAULTS.monthlyVolumeProfileVisible,
    volumeProfilePeriod: INDICATOR_STARTUP_DEFAULTS.volumeProfilePeriod,
    volumeProfileLvnVisible: INDICATOR_STARTUP_DEFAULTS.volumeProfileLvnVisible,
    liquidationClustersVisible: INDICATOR_STARTUP_DEFAULTS.liquidationClustersVisible,
    whaleMarkersVisible: INDICATOR_STARTUP_DEFAULTS.whaleMarkersVisible,
    whaleMarkerMinNotional: INDICATOR_STARTUP_DEFAULTS.whaleMarkerMinNotional,
    jevSignalsVisible: INDICATOR_STARTUP_DEFAULTS.jevSignalsVisible,
    candleOverlay: {
      mode: INDICATOR_STARTUP_DEFAULTS.candleOverlay.mode,
      baseCandles: INDICATOR_STARTUP_DEFAULTS.candleOverlay.baseCandles,
      contrast: INDICATOR_STARTUP_DEFAULTS.candleOverlay.contrast,
      heikinAshi: { ...INDICATOR_STARTUP_DEFAULTS.candleOverlay.heikinAshi },
      renko: { ...INDICATOR_STARTUP_DEFAULTS.candleOverlay.renko },
    },
    candleOverlayPanelVisible: false,
    activeDrawingTool: null,
    drawingPanelVisible: true,
  },
  connection: {
    tradingState: 'disconnected',
    marketState: 'disconnected',
    marketSubscription: {
      coin: '',
      interval: '',
      tradeCoins: [],
      indicatorIntervals: [],
      updatedAt: 0,
    },
    acceptedTradeCoins: [],
    droppedTradeCoins: [],
    marketEpoch: 0,
    marketLastTickAt: 0,
    marketUpstreamConnected: false,
  },
};

const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  POLLING: 'polling'
};

// Trading connection status lives only on AppState.connection.tradingState
// (read via getConnectionState / written via setConnectionState).

let orderDebounceUntil = 0;
const ORDER_DEBOUNCE_MS = 250;
let orderPending = false;

const candleCache = new Map();
const MAX_CANDLE_CACHE_ENTRIES = 50;
const rvwapSourceCache = new Map();
const rvwapSourceMetaCache = new Map();
// One active coin plus the backend's accepted 50-coin watchlist hydration set.
const MAX_RVWAP_SOURCE_CACHE_ENTRIES = 51;

function evictCandleCache() {
  if (candleCache.size <= MAX_CANDLE_CACHE_ENTRIES) return;
  const toDelete = candleCache.size - MAX_CANDLE_CACHE_ENTRIES;
  const activeCoin = String(AppState.trading.currentCoin || '');
  const protectedKeys = new Set([
    `${activeCoin}:${AppState.trading.currentTimeframe || ''}`,
  ]);
  let count = 0;
  for (const key of candleCache.keys()) {
    if (count >= toDelete) break;
    if (protectedKeys.has(key)) continue;
    candleCache.delete(key);
    count++;
  }
}

// Delete-then-set moves the key to the end of the Map's insertion order, so
// evictCandleCache's front-first loop drops least-recently-written entries,
// excluding the active display series.
// The live candle merge re-writes the active chart's series on every tick,
// which keeps it at the back of the line — a background radar/alert sweep
// filling the cache can no longer evict the chart the user is looking at.
function setCandleCacheEntry(key, value) {
  candleCache.delete(key);
  candleCache.set(key, value);
  evictCandleCache();
}

function setRvwapSourceCacheEntry(coin, value, meta) {
  const key = String(coin || '').trim();
  if (!key) return;
  rvwapSourceCache.delete(key);
  rvwapSourceCache.set(key, value);
  if (meta !== undefined) {
    rvwapSourceMetaCache.delete(key);
    rvwapSourceMetaCache.set(key, meta);
  }
  if (rvwapSourceCache.size <= MAX_RVWAP_SOURCE_CACHE_ENTRIES) return;
  const activeCoin = String(AppState.trading.currentCoin || '');
  for (const cachedCoin of rvwapSourceCache.keys()) {
    if (rvwapSourceCache.size <= MAX_RVWAP_SOURCE_CACHE_ENTRIES) break;
    if (cachedCoin === activeCoin) continue;
    rvwapSourceCache.delete(cachedCoin);
    rvwapSourceMetaCache.delete(cachedCoin);
  }
}

let coin24hChanges = {};

const chartLevelCache = new Map();
const chartLevelHashes = new Map();

const suppressedOrderOids = new Map();
const suppressedPositionCoins = new Map();

function getConnectionState() {
  return AppState.connection.tradingState || ConnectionState.DISCONNECTED;
}

function setCurrentCoin(coin) {
  AppState.trading.currentCoin = coin;
}

function setCurrentPrice(price) {
  AppState.trading.currentPrice = price;
}

function setCurrentSide(side) {
  AppState.trading.currentSide = side;
}

function setCurrentTimeframe(tf) {
  AppState.trading.currentTimeframe = tf;
}

function setCurrentOrderType(type) {
  AppState.trading.currentOrderType = type;
}

function setExchangeLeverage(coin, leverage) {
  if (!coin) return;
  if (!AppState.account.exchangeLeverageByCoin) {
    AppState.account.exchangeLeverageByCoin = {};
  }
  AppState.account.exchangeLeverageByCoin[coin] = leverage;
}

function setDefaultLeverageApplied(coin, leverage) {
  if (!coin) return;
  if (!AppState.account.defaultLeverageAppliedByCoin) {
    AppState.account.defaultLeverageAppliedByCoin = {};
  }
  AppState.account.defaultLeverageAppliedByCoin[coin] = leverage;
}

function setLastDeployedPlan(plan) {
  AppState.trading.lastDeployedPlan = plan || null;
}

function setHideValues(val) {
  AppState.ui.hideValues = val;
}

function setChartTouchMode(mode) {
  const nextMode = mode === 'buy' || mode === 'sell' ? mode : 'inspect';
  AppState.ui.chartTouchMode = nextMode;
}

function setManualAnchoredVwapVisible(val) {
  AppState.ui.manualAnchoredVwapVisible = val === true || val === 'true';
}

function setManualAnchoredVwapPlacementActive(val) {
  AppState.ui.manualAnchoredVwapPlacementActive = val === true || val === 'true';
}

function setActiveJevSignal(sig) {
  AppState.market.activeJevSignal = sig || null;
}

function getActiveJevSignal() {
  return AppState.market.activeJevSignal;
}

function setSessionVwapVisible(period, val) {
  if (!SESSION_VWAP_PERIODS.includes(period)) return;
  AppState.ui.sessionVwap = {
    ...AppState.ui.sessionVwap,
    [period]: val === true || val === 'true',
  };
}

function setRvwapLookbackVisible(lookback, visible) {
  if (!RVWAP_LOOKBACKS.includes(lookback)) return;
  const current = Array.isArray(AppState.ui.rvwapLookbacks)
    ? AppState.ui.rvwapLookbacks.filter((value) => RVWAP_LOOKBACKS.includes(value))
    : [];
  const enabled = visible === true || visible === 'true';
  const next = enabled
    ? [...new Set([...current, lookback])]
    : current.filter((value) => value !== lookback);
  AppState.ui.rvwapLookbacks = RVWAP_LOOKBACKS.filter((value) => next.includes(value));
}

function setRvwapBandsVisible(lookback, visible) {
  if (!RVWAP_BAND_LOOKBACKS.includes(lookback)) return;
  const current = Array.isArray(AppState.ui.rvwapBandLookbacks)
    ? AppState.ui.rvwapBandLookbacks.filter((value) => RVWAP_BAND_LOOKBACKS.includes(value))
    : [];
  const enabled = visible === true || visible === 'true';
  const next = enabled
    ? [...new Set([...current, lookback])]
    : current.filter((value) => value !== lookback);
  AppState.ui.rvwapBandLookbacks = RVWAP_BAND_LOOKBACKS.filter((value) => next.includes(value));
}

function setCvdOscillatorLookback(val) {
  if (val === '3D' || val === '10D' || val === '20D' || val === '30D' || val === '90D') {
    AppState.ui.cvdOscillatorLookback = val;
  }
}

function setPriceProjectionVisible(val) {
  AppState.ui.priceProjectionVisible = val === true || val === 'true';
}

function setWeekPathProjectionVisible(val) {
  AppState.ui.weekPathProjectionVisible = val === true || val === 'true';
}

function setWeekPathEnvelopeVisible(val) {
  AppState.ui.weekPathEnvelopeVisible = val === true || val === 'true';
}

function setMonthlyVolumeProfileVisible(val) {
  AppState.ui.monthlyVolumeProfileVisible = val === true || val === 'true';
}

function setVolumeProfilePeriod(val) {
  AppState.ui.volumeProfilePeriod = ['monthly', 'quarterly'].includes(val) ? val : 'visible';
}

function setVolumeProfileLvnVisible(val) {
  AppState.ui.volumeProfileLvnVisible = val === true || val === 'true';
}

function setLiquidationClustersVisible(val) {
  AppState.ui.liquidationClustersVisible = val === true || val === 'true';
}

function setWhaleMarkersVisible(val) {
  AppState.ui.whaleMarkersVisible = val === true || val === 'true';
}

function setJevSignalsVisible(val) {
  AppState.ui.jevSignalsVisible = val === true || val === 'true';
}

function setWhaleMarkerMinNotional(val) {
  const n = Number(val);
  AppState.ui.whaleMarkerMinNotional = Number.isFinite(n) && n > 0 ? n : 100000;
}

function setIndicatorsPanelVisible(val) {
  AppState.ui.indicatorsPanelVisible = val === true || val === 'true';
}

function setCandleOverlayMode(mode) {
  const valid = ['off', 'heikin-ashi', 'renko', 'both'].includes(mode) ? mode : 'off';
  AppState.ui.candleOverlay.mode = valid;
}

function setCandleOverlayBaseCandles(val) {
  const valid = ['dimmed', 'hidden', 'normal'].includes(val) ? val : 'dimmed';
  AppState.ui.candleOverlay.baseCandles = valid;
}

function setCandleOverlayContrast(val) {
  const n = Number(val);
  const clamped = Number.isFinite(n) ? Math.max(0.05, Math.min(1.0, n)) : 0.5;
  AppState.ui.candleOverlay.contrast = clamped;
}

function setCandleOverlayHeikinAshiOptions(opts = {}) {
  const next = { ...opts };
  if (next.opacity !== undefined) {
    const n = Number(next.opacity);
    next.opacity = Number.isFinite(n) ? Math.max(0.05, Math.min(1.0, n)) : 0.5;
  }
  if (next.dimmed !== undefined) {
    next.dimmed = next.dimmed === true || next.dimmed === 'true';
  }
  AppState.ui.candleOverlay.heikinAshi = {
    ...AppState.ui.candleOverlay.heikinAshi,
    ...next,
  };
}

function setCandleOverlayRenkoOptions(opts = {}) {
  const next = { ...opts };
  if (next.opacity !== undefined) {
    const n = Number(next.opacity);
    next.opacity = Number.isFinite(n) ? Math.max(0.05, Math.min(1.0, n)) : 0.5;
  }
  if (next.dimmed !== undefined) {
    next.dimmed = next.dimmed === true || next.dimmed === 'true';
  }
  AppState.ui.candleOverlay.renko = {
    ...AppState.ui.candleOverlay.renko,
    ...next,
  };
}

function setCandleOverlayPanelVisible(val) {
  AppState.ui.candleOverlayPanelVisible = val === true || val === 'true';
}

function setActiveDrawingTool(tool) {
  AppState.ui.activeDrawingTool = tool || null;
}

function setDrawingPanelVisible(val) {
  AppState.ui.drawingPanelVisible = val === true || val === 'true';
}

function setConnectionState(state) {
  AppState.connection.tradingState = state || ConnectionState.DISCONNECTED;
}

function getOrderPending() {
  return orderPending;
}

function setOrderPending(val) {
  orderPending = val;
}

function getOrderDebounceUntil() {
  return orderDebounceUntil;
}

function setOrderDebounceUntil(ts) {
  orderDebounceUntil = ts;
}

function cleanupExpiredSuppressions() {
  const now = Date.now();
  for (const [oid, until] of suppressedOrderOids.entries()) {
    if (until <= now) suppressedOrderOids.delete(oid);
  }
  for (const [coin, until] of suppressedPositionCoins.entries()) {
    if (until <= now) suppressedPositionCoins.delete(coin);
  }
}

function suppressOrderOid(oid, ttlMs = 15000) {
  if (!oid) return;
  cleanupExpiredSuppressions();
  suppressedOrderOids.set(Number(oid), Date.now() + ttlMs);
}

function suppressPositionCoin(coin, ttlMs = 15000) {
  if (!coin) return;
  cleanupExpiredSuppressions();
  suppressedPositionCoins.set(coin, Date.now() + ttlMs);
}

function clearCoinSuppressions(coin) {
  if (!coin) return;
  suppressedPositionCoins.delete(coin);
}

function isOrderSuppressed(order) {
  cleanupExpiredSuppressions();
  const oid = Number(order?.oid || 0);
  return oid > 0 && suppressedOrderOids.has(oid);
}

function isPositionSuppressed(positionWrapper) {
  cleanupExpiredSuppressions();
  const coin = positionWrapper?.position?.coin;
  return typeof coin === 'string' && suppressedPositionCoins.has(coin);
}

function filterSuppressedOrders(orders) {
  return Array.isArray(orders) ? orders.filter((order) => !isOrderSuppressed(order)) : [];
}

function filterSuppressedPositions(assetPositions) {
  return Array.isArray(assetPositions) ? assetPositions.filter((position) => !isPositionSuppressed(position)) : [];
}

export {
  AppState,
  RVWAP_LOOKBACKS,
  RVWAP_BAND_LOOKBACKS,
  INDICATOR_STARTUP_DEFAULTS,
  ConnectionState,
  getConnectionState,
  setCurrentCoin,
  setCurrentPrice,
  setCurrentSide,
  setCurrentTimeframe,
  setCurrentOrderType,
  setExchangeLeverage,
  setDefaultLeverageApplied,
  setLastDeployedPlan,
  setHideValues,
  setChartTouchMode,
  setActiveJevSignal,
  getActiveJevSignal,
  getChartSession,
  beginChartSession,
  completeChartSession,
  failChartSession,
  setChartSessionNotice,
  setIsLoadingChart,
  setManualAnchoredVwapVisible,
  setManualAnchoredVwapPlacementActive,
  SESSION_VWAP_PERIODS,
  setSessionVwapVisible,
  setRvwapLookbackVisible,
  setRvwapBandsVisible,
  setPriceProjectionVisible,
  setWeekPathProjectionVisible,
  setWeekPathEnvelopeVisible,
  setCvdOscillatorLookback,
  setMonthlyVolumeProfileVisible,
  setVolumeProfilePeriod,
  setVolumeProfilePeriod as setMonthlyVolumeProfilePeriod,
  setVolumeProfileLvnVisible,
  setLiquidationClustersVisible,
  setWhaleMarkersVisible,
  setWhaleMarkerMinNotional,
  setJevSignalsVisible,
  setIndicatorsPanelVisible,
  setCandleOverlayMode,
  setCandleOverlayBaseCandles,
  setCandleOverlayContrast,
  setCandleOverlayHeikinAshiOptions,
  setCandleOverlayRenkoOptions,
  setCandleOverlayPanelVisible,
  setActiveDrawingTool,
  setDrawingPanelVisible,
  setConnectionState,
  getOrderPending,
  setOrderPending,
  getOrderDebounceUntil,
  setOrderDebounceUntil,
  candleCache,
  MAX_CANDLE_CACHE_ENTRIES,
  rvwapSourceCache,
  rvwapSourceMetaCache,
  MAX_RVWAP_SOURCE_CACHE_ENTRIES,
  setRvwapSourceCacheEntry,
  coin24hChanges,
  chartLevelCache,
  chartLevelHashes,
  ORDER_DEBOUNCE_MS,
  suppressOrderOid,
  suppressPositionCoin,
  clearCoinSuppressions,
  filterSuppressedOrders,
  filterSuppressedPositions,
  evictCandleCache,
  setCandleCacheEntry,
};
