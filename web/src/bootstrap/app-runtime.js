import { initBottomPanelResize } from '../ui/bottom-panel-resize.js';
import { initLayoutDensity } from '../ui/layout-density.js';
import { initLayoutPrefs } from '../ui/layout-prefs.js';
import { initColumnResize } from '../ui/column-resize.js';

export function createInit(deps) {
  return async function init() {
    try {
      initBottomPanelResize();
      initLayoutPrefs();
      initColumnResize();
      initLayoutDensity();
      const bottomContent = document.getElementById('bottomContent');
      if (bottomContent) {
        bottomContent.innerHTML = '<div class="empty-state">Connecting...</div>';
      }

      deps.setupDelegation();
      deps.attachLegacyFacade();
      deps.initColorPaletteUI?.();
      await deps.loadCoinMeta();
      // Strip any accidental window.privateKey exposure (legacy-globals helper).
      deps.syncLegacyGlobals?.();

      deps.renderDeploySizingControls();
      const limitTab = document.querySelector('.type-tab');
      if (limitTab) deps.setOrderType('limit', limitTab);

      deps.renderLiquidations();
      deps.renderOrderFlow();
      deps.renderSignalRadar();
      deps.updateSummary();

      // Start local market chrome pollers (top movers, 24h changes, stock mispricing).
      // These call local Go server endpoints (/api/market-movers, /api/24h-changes,
      // /api/stock-mispricing) served in <1ms from memory, with ZERO external
      // Hyperliquid requests. Starting them immediately ensures topbar gainers/losers
      // are rendered on initial paint without waiting for chart candles or radar.
      deps.startTopMoversPolling?.();
      deps.start24hPolling?.();
      deps.startMispricingPolling?.();

      if (deps.isMarketRadarConnected()) {
        await deps.fetchNewsConfig().catch((error) => {
          console.warn('News config fetch failed:', error);
        });
        deps.startNewsPolling();
      }

      setTimeout(function() {
        deps.initChart();
        if (typeof deps.initIndicatorUI === 'function') deps.initIndicatorUI();
        if (typeof deps.initDrawingToolUI === 'function') deps.initDrawingToolUI();
        if (typeof deps.initCandleOverlayUI === 'function') deps.initCandleOverlayUI();
      }, 100);

      const initialRequestToken = Date.now() + Math.random();
      deps.setActiveCandleRequestToken?.(initialRequestToken);
      const initialMarketJobs = [
        deps.fetchCandles({ requestToken: initialRequestToken }),
        deps.refreshExchangeInfo(),
      ];

	  // Market transport is independent from wallet/account boot. Start it
	  // immediately so live candles and mids cannot be delayed by login or
	  // account reconciliation.
	  deps.connectMarketStream?.();

      const initialMarketBoot = Promise.allSettled(initialMarketJobs)
        .then(() => (
          deps.isMarketRadarConnected()
            ? deps.ensureRadarNewsCoverage({ force: true }).catch(() => {})
            : undefined
        ))
        .then(() => {
          deps.renderSignalRadar();
          deps.updateSummary();
          deps.scheduleRender();
        });

      const accountBoot = deps.autoLogin()
        .catch((error) => {
          console.error('Auto login error:', error);
        })
        .then(() => {
          if (deps.getEffectiveWalletAddress()) {
            deps.fetchRecentFills().catch(() => {});
          }
          if (!deps.getAccountStreamSocket?.()) {
            deps.connectAccountStream();
          }
        });

      await initialMarketBoot;

      // Heavy/exclusive background jobs that fan out upstream or emit audio
      // alerts (CVD alert monitor, preload hints) only run on the PRIMARY tab
      // to avoid duplicate audio alerts and duplicate preload bursts.
      const setPollers = (isLeader) => {
        if (isLeader) {
          deps.startPreloadHints?.();
          deps.startCvdAlertMonitor?.();
        } else {
          deps.stopPreloadHints?.();
          deps.stopCvdAlertMonitor?.();
        }
      };
      if (typeof deps.startTabLeadership === 'function') {
        deps.startTabLeadership(setPollers);
      } else {
        setPollers(true); // no coordination available -> act as primary
      }

      await accountBoot;

      await deps.loadOptionalTradingRuntime?.().catch(() => null);

      const botModule = deps.getBotModule?.();
      if (botModule && typeof botModule.init === 'function') {
        botModule.init();
      }
    } catch (error) {
      console.error('Init error:', error);
      const bottomContent = document.getElementById('bottomContent');
      if (bottomContent) {
        const message = document.createElement('div');
        message.className = 'empty-state';
        message.textContent = `Error: ${error?.message || 'initialization failed'}`;
        bottomContent.replaceChildren(message);
      }
    }
  };
}

export function setupAppDelegation(deps) {
  deps.setupActionDelegation({
    switchCoin: deps.switchCoin,
    toggleCoinDropdown: deps.toggleCoinDropdown,
    addToWatchlist: deps.addToWatchlist,
    removeFromWatchlist: deps.removeFromWatchlist,
    addToHideList: deps.addToHideList,
    removeFromHideList: deps.removeFromHideList,
    toggleHide: deps.toggleHide,
    clearMessagesAndDrawings: deps.clearMessagesAndDrawings,
    domLadderPick: deps.domLadderPick,
    toggleMarketRadar: deps.toggleMarketRadar,
    toggleTradingPanel: deps.toggleTradingPanel,
    toggleLiqPanel: deps.toggleLiqPanel,
    setMobileView: deps.setMobileView,
    toggleMoversCollapsed: deps.toggleMoversCollapsed,
    toggleIndicators: deps.toggleIndicators,
    toggleCandleOverlay: deps.toggleCandleOverlay,
    onToggleDimAllOverlays: deps.onToggleDimAllOverlays,
    selectCandleOverlayMode: deps.selectCandleOverlayMode,
    onChangeCandleOverlayBaseCandles: deps.onChangeCandleOverlayBaseCandles,
    onInputCandleOverlayContrast: deps.onInputCandleOverlayContrast,
    onChangeCandleOverlayContrast: deps.onChangeCandleOverlayContrast,
    onToggleHeikinAshiDimmed: deps.onToggleHeikinAshiDimmed,
    onInputHeikinAshiOpacity: deps.onInputHeikinAshiOpacity,
    onChangeHeikinAshiOpacity: deps.onChangeHeikinAshiOpacity,
    onToggleHeikinAshiWicks: deps.onToggleHeikinAshiWicks,
    onToggleRenkoDimmed: deps.onToggleRenkoDimmed,
    onInputRenkoOpacity: deps.onInputRenkoOpacity,
    onChangeRenkoOpacity: deps.onChangeRenkoOpacity,
    onChangeRenkoBrickMode: deps.onChangeRenkoBrickMode,
    onInputRenkoFixedSize: deps.onInputRenkoFixedSize,
    onToggleRenkoWicks: deps.onToggleRenkoWicks,
    toggleSettings: deps.toggleSettings,
    toggleColorPalette: deps.toggleColorPalette,
    onToggleManualAnchoredVwap: deps.onToggleManualAnchoredVwap,
    onToggleSessionVwap: deps.onToggleSessionVwap,
    onToggleManualAnchoredVwapBands: deps.onToggleManualAnchoredVwapBands,
    onChangeManualAnchoredVwapSigma: deps.onChangeManualAnchoredVwapSigma,
    addManualAnchoredVwap: deps.addManualAnchoredVwap,
    onToggleRvwap: deps.onToggleRvwap,
    onToggleRvwapBands: deps.onToggleRvwapBands,
    onChangeCvdOscillatorLookback: deps.onChangeCvdOscillatorLookback,
    onToggleMonthlyVolumeProfile: deps.onToggleMonthlyVolumeProfile,
    onChangeVolumeProfilePeriod: deps.onChangeVolumeProfilePeriod,
    onToggleVolumeProfileLvn: deps.onToggleVolumeProfileLvn,
    onToggleLiquidationClusters: deps.onToggleLiquidationClusters,
    onToggleJevSignals: deps.onToggleJevSignals,
    onToggleWhaleMarkers: deps.onToggleWhaleMarkers,
    onChangeWhaleMarkerMin: deps.onChangeWhaleMarkerMin,
    onTogglePriceProjection: deps.onTogglePriceProjection,
    onToggleWeekPathProjection: deps.onToggleWeekPathProjection,
    onToggleWeekPathEnvelope: deps.onToggleWeekPathEnvelope,
    onToggleCvdAlerts: deps.onToggleCvdAlerts,
    setTimeframe: deps.setTimeframe,
    switchTab: deps.switchTab,
    showConnectModal: deps.showConnectModal,
    handleWalletBtnClick: deps.handleWalletBtnClick,
    closeAllPositions: deps.closeAllPositions,
    cancelAllOrders: deps.cancelAllOrders,
    scheduleCancelUI: deps.scheduleCancelUI,
    updateLeverageFromSlider: deps.updateLeverageFromSlider,
    hideConnectModal: deps.hideConnectModal,
    modalConnect: deps.modalConnect,
    clearNewsConfig: deps.clearNewsConfigFromModal,
    setOrderType: deps.setOrderType,
    setPlaybook: deps.setPlaybook,
    updateScaleSummary: deps.updateScaleSummary,
    setScaleTotal: deps.setScaleTotal,
    setLimitPriceEntryModeSelection: deps.setLimitPriceEntryModeSelection,
    onManualPriceInput: deps.onManualPriceInput,
    onManualSizeInput: deps.onManualSizeInput,
    onManualTpInput: deps.onManualTpInput,
    onManualSlInput: deps.onManualSlInput,
    setSide: deps.setSide,
    updateSummary: deps.updateSummary,
    previewOrder: deps.previewOrder,
    placeOrder: deps.placeOrder,
    placeOrderWithSide: deps.placeOrderWithSide,
    cancelActiveTwap: deps.cancelActiveTwap,
    hideConfirmModal: deps.hideConfirmModal,
    markUserEditedPrice: deps.markUserEditedPrice,
    syncBotTotals: deps.syncBotTotals,
    restoreManualTicketMode: deps.restoreManualTicketMode,
    updateDeploySizingSetting: deps.updateDeploySizingSetting,
    resetDeploySizingSettings: deps.resetDeploySizingSettings,
    armChartPricePick: deps.armChartPricePick,
    fitChartView: deps.fitChartView,
    jumpChartToLive: deps.jumpChartToLive,
    selectDrawingTool: deps.selectDrawingTool,
    clearDrawingTool: deps.clearDrawingTool,
    clearDrawings: deps.clearDrawings,
    toggleDrawingTools: deps.toggleDrawingTools,
    botToggle: deps.botToggle,
    loadBotStrategy: deps.loadBotStrategy,
    setBotMode: deps.setBotMode,
    onBidSkewChange: deps.onBidSkewChange,
    onAskSkewChange: deps.onAskSkewChange,
    onBulkBidSkewChange: deps.onBulkBidSkewChange,
    onBulkAskSkewChange: deps.onBulkAskSkewChange,
  });
}

export function installAppWindowEvents({
  recoverAfterTabResume,
  recoverChartSurface,
  scheduleChartRender,
  onBeforeUnload,
}) {
  let resizeTimer;

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      recoverChartSurface?.();
      scheduleChartRender();
    }, 100);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      recoverAfterTabResume('visibilitychange');
    }
  });

  window.addEventListener('focus', () => {
    if (document.hidden) return;
    recoverAfterTabResume('focus');
  });

  window.addEventListener('pageshow', (event) => {
    recoverAfterTabResume(event?.persisted === true ? 'pageshow-bfcache' : 'pageshow');
  });

  // Chrome Page Lifecycle: freeze/resume fire when the tab is CPU-frozen
  // (including some lid-wake cases with no visibility change).
  document.addEventListener('resume', () => {
    recoverAfterTabResume('page-resume');
  });

  window.addEventListener('online', () => {
    recoverAfterTabResume('online');
  });

  window.addEventListener('beforeunload', onBeforeUnload);

  let dprQuery = null;
  let dprHandler = null;
  const subscribeDevicePixelRatio = () => {
    if (typeof window.matchMedia !== 'function') return;
    if (dprQuery && dprHandler) {
      if (typeof dprQuery.removeEventListener === 'function') {
        dprQuery.removeEventListener('change', dprHandler);
      } else if (typeof dprQuery.removeListener === 'function') {
        dprQuery.removeListener(dprHandler);
      }
    }
    dprHandler = () => {
      try { recoverChartSurface?.('dpr-change'); } catch {}
      try { scheduleChartRender?.(); } catch {}
      subscribeDevicePixelRatio();
    };
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    if (typeof dprQuery.addEventListener === 'function') {
      dprQuery.addEventListener('change', dprHandler);
    } else if (typeof dprQuery.addListener === 'function') {
      dprQuery.addListener(dprHandler);
    }
  };
  subscribeDevicePixelRatio();
}
