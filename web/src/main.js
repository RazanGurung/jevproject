import { AppState, candleCache, setCurrentPrice as setTradingCurrentPrice } from './state/store.js';
import { beginChartSession, completeChartSession, failChartSession } from './state/chart-session.js';
import { attachLegacyFacade, syncLegacyGlobals, setLegacy } from './state/legacy-globals.js';
import { getDesiredTradeCoins, setDesiredMarketSubscription } from './state/market-subscription-state.js';
import { pruneMarketCoinCaches } from './state/market-trades.js';
import { subscribeWatchlist } from './services/watchlist-store.js';
import { resetMarketRuntimeState, setBookVersion } from './state/runtime-mirrors.js';
import {
  getBotConfigInputSyncer,
  getBotTotalsUpdater,
  installStrategyHostBridge,
} from './state/strategy-host.js';
import { installAppHostBridge } from './state/app-host.js';
import { setUserEditedPrice, setActiveCandleRequestToken } from './state/trading-runtime.js';
import { createBeforeUnloadHandler, renderActiveBottomTab } from './bootstrap/app-lifecycle.js';
import { createGroupedWindowBindings, createWindowBindingGroups } from './bootstrap/app-bindings.js';
import { createInit, installAppWindowEvents, setupAppDelegation } from './bootstrap/app-runtime.js';
import { initializeWindowState, installRuntimeGlobals } from './bootstrap/window-state.js';
import { setupActionDelegation } from './bootstrap/action-delegation.js';

initializeWindowState(AppState);
// Install PezStrategyHost early; bot/PriceFeed deps are injected after optional trading loads.
installStrategyHostBridge();
installAppHostBridge();

import { loadCoinMeta, getMaxLeverage, getCoinDecimals, getTickSize } from './state/coin-meta.js';
import { scheduleOrderbookRender, syncActiveTradeState, cancelPendingRenders, subscribeMarket, recoverActiveCandlesIfStale } from './streams/market-ws.js';
import { connectAccountStream, disconnectAccountStream, refreshAccountStream, resetReconnectBackoff, getLastMessageAgeMs, getAccountStreamSocket } from './streams/account-stream.js';
import { connectMarketStream, disconnectMarketStream, refreshMarketStream, resetMarketReconnectBackoff, getMarketStreamSocket, getMarketStreamMessageAgeMs } from './streams/market-stream.js';
import { fetchCandles, prefetchAdjacentTimeframes, fetchL2Snapshot } from './services/chart-candle-service.js';
import { ensureRvwapSource, scheduleActiveRvwapHydration } from './services/rvwap-source-service.js';
import { fetchMeta, refreshExchangeInfo, fetchVWAP, fetchFunding } from './services/market-service.js';
import {
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
} from './services/market-pollers.js';
import { configureMarketSession } from './services/market-session.js';
import { createHoverPrefetchService } from './services/hover-prefetch.js';
import { startTabLeadership } from './services/tab-leader.js';
import { fetchAccount, updateBalanceDisplay, updateSizeSliderMax, debouncedFetchAccount, fetchExchangeLeverage, ensureMaxLeverageDefault } from './services/account-service.js';
import { autoLogin, restoreBackendSession } from './services/wallet-service.js';
import { hlPost, fetchWithDedup } from './services/api.js';
import { initChart, updateChart, drawChart, scheduleChartRender, recoverChartSurfaceAfterResume, updateChartWithCandles, clearHistoryLoadState } from './chart/chart-render.js';
import { getLightweightChartDebugState as getChartDebugState } from './chart/lightweight-chart.js';
import { getIndicatorWorkerStats } from './chart/indicator-worker-pool.js';
import { fetchJournalExecutions, fetchJournalSummary } from './services/execution-journal-service.js';
import { initIndicatorUI, toggleIndicators, onToggleManualAnchoredVwap, onToggleSessionVwap, onToggleManualAnchoredVwapBands, onChangeManualAnchoredVwapSigma, addManualAnchoredVwap, onToggleRvwap, onToggleRvwapBands, onChangeCvdOscillatorLookback, onToggleMonthlyVolumeProfile, onChangeVolumeProfilePeriod, onToggleVolumeProfileLvn, onToggleLiquidationClusters, onToggleJevSignals, onToggleWhaleMarkers, onChangeWhaleMarkerMin, onTogglePriceProjection, onToggleWeekPathProjection, onToggleWeekPathEnvelope, onToggleCvdAlerts } from './ui/chart-indicator-ui.js';
import {
  initCandleOverlayUI,
  toggleCandleOverlay,
  onToggleDimAllOverlays,
  selectCandleOverlayMode,
  onChangeCandleOverlayBaseCandles,
  onInputCandleOverlayContrast,
  onChangeCandleOverlayContrast,
  onToggleHeikinAshiDimmed,
  onInputHeikinAshiOpacity,
  onChangeHeikinAshiOpacity,
  onToggleHeikinAshiWicks,
  onToggleRenkoDimmed,
  onInputRenkoOpacity,
  onChangeRenkoOpacity,
  onChangeRenkoBrickMode,
  onInputRenkoFixedSize,
  onToggleRenkoWicks,
} from './ui/candle-overlay-ui.js';
import {
  initDrawingToolUI,
  onSelectDrawingTool,
  onClearDrawingTool,
  onClearDrawings,
  onClearMessagesAndDrawings,
  toggleDrawingTools,
} from './ui/chart-drawing-ui.js';
import { initColorPaletteUI, toggleColorPalette, toggleSettings } from './ui/color-palette-ui.js';
import { armChartPricePick, fitChartView, jumpChartToLive, syncMobileChartActionBar } from './chart/chart-interactions.js';
import { updateChartLevels } from './chart/chart-levels.js';
import { scheduleRender } from './render/scheduler.js';
import { scheduleLayoutRender } from './render/layout-scheduler.js';
import { renderPositions } from './render/positions.js';
import { renderOpenOrders as renderOrders, toggleSelectAll, updateSelectedCount } from './render/orders.js';
import { renderLiquidations, renderOrderFlow } from './render/trades.js';
import { renderDomLadder, domLadderPick, pruneSpacingCache } from './render/dom-ladder.js';
import { showConnectModal, hideConnectModal, modalConnect, clearNewsConfigFromModal } from './ui/wallet-modal.js';
import { updateTopBar } from './ui/topbar.js';
import { showToast, clearToasts } from './ui/toast.js';
import {
  toggleHide,
  switchTab,
  updateTabCounts,
  toggleMarketRadar,
  toggleTradingPanel,
  toggleLiqPanel,
  setMobileView,
  toggleMoversCollapsed,
} from './render/ui-state.js';
import { renderFundingTable } from './render/funding.js';
import { renderTrades } from './render/trades.js';
import { renderFills } from './render/fills.js';
import { setSide, setOrderType, setPlaybook, setTimeframe, setPreset, setSize, setScaleTotal, updateSummary, updateScaleSummary, updateTicketLayoutMode, restoreManualTicketMode, previewOrder, submitOrderFromTicket, placeOrderWithSide, showPreview, hidePreviewRows, debouncedOrderPreview, fetchOrderPreview, getAutoLimitPriceForSide, syncLimitPreviewLevels, syncLimitAutoTrackState, onManualPriceInput, onManualSizeInput, onManualTpInput, onManualSlInput, setLimitPriceEntryModeSelection } from './ui/tabs.js';
import { applyTicketPrice } from './ui/tabs.js';
import { showModifyModal, bulkCancelSelected, scheduleCancelUI, hideConfirmModal } from './ui/order-ui.js';
import { buildCancelsFromOrders, bulkCancelOrders } from './services/order-cancel.js';
import { setLeverage, updateLeverageFromSlider, toggleCoinDropdown, addToWatchlist, removeFromWatchlist, addToHideList, removeFromHideList, handleWalletBtnClick, updateCoinTabChange } from './ui/controls.js';
import { cancelOid, cancelAllOrders, closePosition, closeAllPositions, setTP, setSL, placeScaleOrder } from './services/trading-service.js';
import { showScalePreview, clearScalePreview } from './services/trading-service-scale.js';
import { wouldReducePosition } from './services/trading-service-helpers.js';
import { cancelActiveTwap, renderTwapStatus } from './services/trading-service-twap.js';
import { getBotModule, getBotStatusRefresher } from './services/runtime-compat.js';
import {
  invokeOptionalBotAction,
  loadOptionalTradingRuntime,
  scheduleOptionalTradingRuntime,
} from './bootstrap/optional-trading-loader.js';
import { fmtPrice, fmtVol, fmtVolAlways, fmtPct } from './utils/format.js';
import { coinToTabId, isHip3Coin, getDex } from './utils/helpers.js';
import { renderSignalRadar, scheduleSignalRadarRender } from './ui/signal-radar.js';
import { fetchRecentFills } from './services/fills-service.js';
import { deployFillAction } from './services/fill-actions.js';
import { updateDeploySizingSetting, resetDeploySizingSettings, renderDeploySizingControls } from './services/deploy-config.js';
import { fetchNewsConfig, fetchRadarNews, refreshTickerNews, ensureRadarNewsCoverage, startNewsPolling, stopNewsPolling } from './services/news-service.js';
import { createSwitchCoin } from './services/coin-switch.js';
import { beginRecoveryOverlay } from './services/recovery-overlay.js';
import { createTabResumeRecoverer } from './services/tab-resume.js';
import { getAllMids } from './state/market-selectors.js';
import { getEffectiveCurrentCoin, getEffectiveCurrentOrderType, getEffectiveCurrentSide, getEffectiveCurrentTimeframe, getEffectiveWalletAddress } from './state/effective-trading.js';

// Market session owns chart transport intent; UI modules go through it.
configureMarketSession({
  loadMarketActions: () => import('./streams/market-ws.js'),
  fetchCandles,
  ensureRvwapSource,
});

Object.assign(window, createGroupedWindowBindings({
  appState: AppState,
  showToast,
  groups: createWindowBindingGroups({
  fmtPrice,
  fmtVol,
  fmtVolAlways,
  fmtPct,
  coinToTabId,
  isHip3Coin,
  getDex,
  getMaxLeverage,
  getCoinDecimals,
  getTickSize,
  fetchAccount,
  debouncedFetchAccount,
  updateBalanceDisplay,
  updateSizeSliderMax,
  fetchExchangeLeverage,
  ensureMaxLeverageDefault,
  connectAccountStream,
  refreshAccountStream,
  autoLogin,
  fetchCandles,
  fetchMeta,
  refreshExchangeInfo,
  fetchVWAP,
  fetchFunding,
  fetchNewsConfig,
  fetchRadarNews,
  scheduleRender,
  renderLiquidations,
  renderOrderFlow,
  renderDomLadder,
  scheduleLayoutRender,
  scheduleOrderbookRender,
  syncActiveTradeState,
  cancelPendingRenders,
  subscribeMarket,
  getDesiredTradeCoins,
  hlPost,
  fetchWithDedup,
  renderFundingTable,
  renderTrades,
  renderFills,
  renderPositions,
  renderOpenOrders: renderOrders,
  toggleSelectAll,
  updateSelectedCount,
  initChart,
  initIndicatorUI,
  initDrawingToolUI,
  initCandleOverlayUI,
  toggleCandleOverlay,
  onToggleDimAllOverlays,
  selectCandleOverlayMode,
  onChangeCandleOverlayBaseCandles,
  onInputCandleOverlayContrast,
  onChangeCandleOverlayContrast,
  onToggleHeikinAshiDimmed,
  onInputHeikinAshiOpacity,
  onChangeHeikinAshiOpacity,
  onToggleHeikinAshiWicks,
  onToggleRenkoDimmed,
  onInputRenkoOpacity,
  onChangeRenkoOpacity,
  onChangeRenkoBrickMode,
  onInputRenkoFixedSize,
  onToggleRenkoWicks,
  updateChart,
  drawChart,
  updateChartLevels,
  scheduleChartRender,
  updateChartWithCandles,
  armChartPricePick,
  fitChartView,
  jumpChartToLive,
  getChartDebugState,
  getIndicatorWorkerStats,
  fetchJournalExecutions,
  fetchJournalSummary,
  selectDrawingTool: onSelectDrawingTool,
  clearDrawingTool: onClearDrawingTool,
  clearDrawings: onClearDrawings,
  toggleDrawingTools,
  debouncedOrderPreview,
  fetchOrderPreview,
  showPreview,
  hidePreviewRows,
  syncLimitPreviewLevels,
  getAutoLimitPriceForSide,
  placeOrder: submitOrderFromTicket,
  placeOrderWithSide,
  placeScaleOrder,
  cancelActiveTwap,
  showScalePreview,
  clearScalePreview,
  renderTwapStatus,
  setSide,
  setOrderType,
  setPlaybook,
  setTimeframe,
  setPreset,
  setSize,
  setScaleTotal,
  updateSummary,
  updateScaleSummary,
  previewOrder,
  wouldReducePosition,
  closePosition,
  setTP,
  setSL,
  cancelOid,
  cancelAllOrders,
  showModifyModal,
  bulkCancelSelected,
  scheduleCancelUI,
  closeAllPositions,
  hideConfirmModal,
  buildCancelsFromOrders,
  bulkCancelOrders,
  showConnectModal,
  hideConnectModal,
  modalConnect,
  clearNewsConfigFromModal,
  toggleHide,
  switchTab,
  setLeverage,
  updateLeverageFromSlider,
  toggleCoinDropdown,
  addToWatchlist,
  removeFromWatchlist,
  addToHideList,
  removeFromHideList,
  toggleMarketRadar,
  toggleTradingPanel,
  toggleLiqPanel,
  handleWalletBtnClick,
  updateCoinTabChange,
  renderSignalRadar,
  scheduleSignalRadarRender,
  deployFillAction,
  updateDeploySizingSetting,
  resetDeploySizingSettings,
  renderDeploySizingControls,
  }),
}));

const switchCoin = createSwitchCoin({
  AppState,
  setLegacy,
  updateTicketLayoutMode,
  getEffectiveWalletAddress,
  getMaxLeverage,
  ensureMaxLeverageDefault,
  setBookVersion,
  clearScalePreview,
  getEffectiveCurrentTimeframe,
  syncLimitPreviewLevels,
  drawChart,
  scheduleChartRender,
  coinToTabId,
  updateSizeSliderMax,
  scheduleRender,
  renderTwapStatus,
  resetMarketRuntimeState,
  updateChartLevels,
  fmtPrice,
  getEffectiveCurrentOrderType,
  getAutoLimitPriceForSide,
  applyTicketPrice,
  getEffectiveCurrentSide,
  updateTopBar,
  updateSummary,
  syncActiveTradeState,
  cancelPendingRenders,
  renderLiquidations,
  renderOrderFlow,
  renderDomLadder,
  scheduleLayoutRender,
  fetchWithDedup,
  hlPost,
  subscribeMarket,
  getDesiredTradeCoins,
  setDesiredMarketSubscription,
  renderSignalRadar,
  scheduleSignalRadarRender,
  refreshTickerNews,
  beginChartSession,
  completeChartSession,
  failChartSession,
  fetchCandles,
  prefetchAdjacentTimeframes,
  scheduleActiveRvwapHydration,
  initChart,
  updateChart,
  clearHistoryLoadState,
  refreshExchangeInfo,
  fetchL2Snapshot,
  getAllMids,
});

function markUserEditedPrice() {
  setUserEditedPrice(true);
}

function syncBotTotals() {
  getBotTotalsUpdater()?.();
  getBotConfigInputSyncer()?.();
}

const setupDelegation = () => setupAppDelegation({
  setupActionDelegation,
  switchCoin,
  toggleCoinDropdown,
  addToWatchlist,
  removeFromWatchlist,
  addToHideList,
  removeFromHideList,
  toggleHide,
  clearMessagesAndDrawings: onClearMessagesAndDrawings,
  domLadderPick,
  toggleMarketRadar,
  toggleTradingPanel,
  toggleLiqPanel,
  setMobileView,
  toggleMoversCollapsed,
  toggleIndicators,
  toggleCandleOverlay,
  selectCandleOverlayMode,
  onChangeCandleOverlayBaseCandles,
  onInputCandleOverlayContrast,
  onChangeCandleOverlayContrast,
  onToggleHeikinAshiWicks,
  onChangeRenkoBrickMode,
  onInputRenkoFixedSize,
  onToggleRenkoWicks,
  toggleSettings,
  toggleColorPalette,
  onToggleManualAnchoredVwap,
  onToggleSessionVwap,
  onToggleManualAnchoredVwapBands,
  onChangeManualAnchoredVwapSigma,
  addManualAnchoredVwap,
  onToggleRvwap,
  onToggleRvwapBands,
  onChangeCvdOscillatorLookback,
  onToggleMonthlyVolumeProfile,
  onChangeVolumeProfilePeriod,
  onToggleVolumeProfileLvn,
  onToggleLiquidationClusters,
  onToggleJevSignals,
  onToggleWhaleMarkers,
  onChangeWhaleMarkerMin,
  onTogglePriceProjection,
  onToggleWeekPathProjection,
  onToggleWeekPathEnvelope,
  onToggleCvdAlerts,
  setTimeframe,
  switchTab,
  showConnectModal,
  handleWalletBtnClick,
  closeAllPositions,
  cancelAllOrders,
  scheduleCancelUI,
  updateLeverageFromSlider,
  hideConnectModal,
  modalConnect,
  clearNewsConfigFromModal,
  setOrderType,
  setPlaybook,
  updateScaleSummary,
  setScaleTotal,
  setLimitPriceEntryModeSelection,
  onManualPriceInput,
  onManualSizeInput,
  onManualTpInput,
  onManualSlInput,
  setSide,
  updateSummary,
  previewOrder,
  placeOrder: submitOrderFromTicket,
  placeOrderWithSide,
  cancelActiveTwap,
  hideConfirmModal,
  markUserEditedPrice,
  syncBotTotals,
  restoreManualTicketMode,
  initIndicatorUI,
  updateDeploySizingSetting,
  resetDeploySizingSettings,
  armChartPricePick,
  fitChartView,
  jumpChartToLive,
  selectDrawingTool: onSelectDrawingTool,
  clearDrawingTool: onClearDrawingTool,
  clearDrawings: onClearDrawings,
  toggleDrawingTools,
  botToggle: (...args) => invokeOptionalBotAction('botToggle', ...args),
  loadBotStrategy: (...args) => invokeOptionalBotAction('loadBotStrategy', ...args),
  setBotMode: (...args) => invokeOptionalBotAction('setBotMode', ...args),
  onBidSkewChange: (...args) => invokeOptionalBotAction('onBidSkewChange', ...args),
  onAskSkewChange: (...args) => invokeOptionalBotAction('onAskSkewChange', ...args),
  onBulkBidSkewChange: (...args) => invokeOptionalBotAction('onBulkBidSkewChange', ...args),
  onBulkAskSkewChange: (...args) => invokeOptionalBotAction('onBulkAskSkewChange', ...args),
});

function initAppColorPalette() {
  initColorPaletteUI({
    onChange: () => {
      renderLiquidations();
      renderOrderFlow();
      renderDomLadder();
      renderSignalRadar();
      updateTopBar();
      scheduleRender();
      scheduleChartRender();
    },
  });
}

const init = createInit({
  setupDelegation,
  attachLegacyFacade,
  initColorPaletteUI: initAppColorPalette,
  loadCoinMeta,
  syncLegacyGlobals,
  renderDeploySizingControls,
  setOrderType,
  renderLiquidations,
  renderOrderFlow,
  renderSignalRadar,
  updateSummary,
  isMarketRadarConnected: () => AppState.ui.marketRadarConnected === true,
  start24hPolling,
  startTopMoversPolling,
  startMispricingPolling,
  startPreloadHints,
  startCvdAlertMonitor,
  stop24hPolling,
  stopTopMoversPolling,
  stopMispricingPolling,
  stopPreloadHints,
  stopCvdAlertMonitor,
  startTabLeadership,
  fetchNewsConfig,
  startNewsPolling,
  initChart,
  initIndicatorUI,
  initDrawingToolUI,
  initCandleOverlayUI,
  fetchCandles,
  setActiveCandleRequestToken,
  refreshExchangeInfo,
  ensureRadarNewsCoverage,
  scheduleRender,
  autoLogin,
  getEffectiveWalletAddress,
  fetchRecentFills,
  connectAccountStream,
  getAccountStreamSocket,
  connectMarketStream,
  getBotModule,
  loadOptionalTradingRuntime,
  subscribeMarket,
  getEffectiveCurrentCoin,
  getEffectiveCurrentTimeframe,
  getDesiredTradeCoins,
});

const renderActiveTabDeps = {
  getActiveTab: () => document.querySelector('.bottom-tab.active')?.dataset.tab || 'positions',
  renderPositions,
  renderOrders,
  renderTrades,
  renderFills,
};

const recoverAfterTabResume = createTabResumeRecoverer({
  getWalletAddress: getEffectiveWalletAddress,
  beginRecoveryOverlay,
  restoreBackendSession,
  getAccountStreamSocket,
  getAccountStreamMessageAgeMs: () => getLastMessageAgeMs(),
  getCurrentPrice: () => AppState.trading.currentPrice,
  connectAccountStream,
  refreshAccountStream,
  resetStreamBackoff: resetReconnectBackoff,
  getMarketStreamSocket,
  getMarketStreamMessageAgeMs,
  connectMarketStream,
  refreshMarketStream,
  resetMarketStreamBackoff: resetMarketReconnectBackoff,
  recoverStaleCandles: recoverActiveCandlesIfStale,
  recoverChartSurface: recoverChartSurfaceAfterResume,
  fetchAccount,
  refreshBotStatus: () => getBotStatusRefresher()?.(),
  refreshExchangeInfo,
  refreshTopMovers: fetchTopMovers,
  refresh24hChanges: fetch24hChanges,
  refreshMispricing: fetchMispricing,
  ensureRadarNewsCoverage,
  startNewsPolling,
  renderPositions,
  renderOrders,
  renderTrades,
  renderFills,
  renderLiquidations,
  renderOrderFlow,
  renderSignalRadar,
  renderDeploySizingControls,
  renderTwapStatus,
  updateTabCounts,
  syncLimitAutoTrackState,
  isMarketRadarConnected: () => AppState.ui.marketRadarConnected === true,
  initChart,
  drawChart,
  scheduleRender,
  scheduleSignalRadarRender,
  scheduleChartRender,
  getCurrentCoin: () => AppState.trading.currentCoin,
  renderActiveTab: () => renderActiveBottomTab(renderActiveTabDeps),
});

const onBeforeUnload = createBeforeUnloadHandler({
  getBotModule,
  stopBotModule: (botModule) => botModule.stop?.(),
  clearPrivateKey: () => {
    setLegacy('privateKey', '');
  },
  getAccountStreamSocket,
  disconnectAccountStream,
  getMarketStreamSocket,
  disconnectMarketStream,
  stop24hPolling,
  stopTopMoversPolling,
  stopMispricingPolling,
  stopPreloadHints,
  stopCvdAlertMonitor,
  stopNewsPolling,
});

installAppWindowEvents({
  recoverAfterTabResume,
  recoverChartSurface: recoverChartSurfaceAfterResume,
  scheduleChartRender,
  onBeforeUnload,
});

// Watchlist or recent-coin membership changes update the warm trade/book set. Each
// accepted coin keeps a bounded rolling sample and latest book ready for fast
// pair switches. Trailing-coalesce so reconnect + movers + watchlist bursts
// collapse to one POST; the controller also dedupes unchanged membership.
const BACKGROUND_MARKET_SUB_DEBOUNCE_MS = 250;
let backgroundMarketSubTimer = null;

function refreshBackgroundMarketSubscription() {
  if (!AppState.trading.currentCoin) return;
  if (backgroundMarketSubTimer != null) {
    clearTimeout(backgroundMarketSubTimer);
  }
  backgroundMarketSubTimer = setTimeout(() => {
    backgroundMarketSubTimer = null;
    if (!AppState.trading.currentCoin) return;
    setDesiredMarketSubscription({});
    subscribeMarket()?.then?.(() => {
      const accepted = AppState.connection.acceptedTradeCoins || [];
      const keepCoins = new Set([AppState.trading.currentCoin, ...accepted]);
      pruneMarketCoinCaches(AppState.market, keepCoins);
      pruneSpacingCache(keepCoins);
    }).catch?.(() => {});
  }, BACKGROUND_MARKET_SUB_DEBOUNCE_MS);
}

subscribeWatchlist(refreshBackgroundMarketSubscription);
document.addEventListener('pez:tracked-coins-changed', refreshBackgroundMarketSubscription);

const hoverPrefetch = createHoverPrefetchService();
hoverPrefetch.start();
window.app = {
  init,
  fetchAccount,
  connectAccountStream,
  setCurrentCoin: switchCoin,
  setCurrentPrice: (p) => setTradingCurrentPrice(p),
  setTimeframe,
  setOrderType,
  renderPositions,
  renderOpenOrders: renderOrders,
  renderFills,
  showConnectModal,
  modalConnect,
  toggleHide,
  switchTab,
  showToast,
  updateTopBar,
};
installRuntimeGlobals({
  switchCoin,
  syncMobileChartActionBar,
});
syncMobileChartActionBar();

// Heavy strategy/bot modules load after the initial chart gets the main thread.
// Delegated bot actions call the same loader, so a very early click is queued
// behind the module promise rather than being dropped.
scheduleOptionalTradingRuntime();

// Start
init();
