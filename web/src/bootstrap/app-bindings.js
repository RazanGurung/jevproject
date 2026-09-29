const WINDOW_BINDING_GROUP_KEYS = {
  core: [
    'fmtPrice',
    'fmtVol',
    'fmtVolAlways',
    'fmtPct',
    'coinToTabId',
    'isHip3Coin',
    'getDex',
    'getMaxLeverage',
    'getCoinDecimals',
    'getTickSize',
  ],
  account: [
    'fetchAccount',
    'debouncedFetchAccount',
    'updateBalanceDisplay',
    'updateSizeSliderMax',
    'fetchExchangeLeverage',
    'ensureMaxLeverageDefault',
    'connectAccountStream',
    'refreshAccountStream',
    'autoLogin',
  ],
  market: [
    'fetchCandles',
    'fetchMeta',
    'refreshExchangeInfo',
    'fetchVWAP',
    'fetchFunding',
    'fetchNewsConfig',
    'fetchRadarNews',
    'scheduleRender',
    'renderLiquidations',
    'renderOrderFlow',
    'renderDomLadder',
    'scheduleOrderbookRender',
    'syncActiveTradeState',
    'cancelPendingRenders',
    'subscribeMarket',
    'getDesiredTradeCoins',
    'hlPost',
    'fetchWithDedup',
    'renderFundingTable',
    'renderTrades',
    'renderFills',
    'renderPositions',
    'renderOpenOrders',
    'toggleSelectAll',
    'updateSelectedCount',
  ],
  chart: [
    'initChart',
    'initIndicatorUI',
    'initCandleOverlayUI',
    'toggleCandleOverlay',
    'onToggleDimAllOverlays',
    'selectCandleOverlayMode',
    'onChangeCandleOverlayBaseCandles',
    'onInputCandleOverlayContrast',
    'onChangeCandleOverlayContrast',
    'onToggleHeikinAshiDimmed',
    'onInputHeikinAshiOpacity',
    'onChangeHeikinAshiOpacity',
    'onToggleHeikinAshiWicks',
    'onToggleRenkoDimmed',
    'onInputRenkoOpacity',
    'onChangeRenkoOpacity',
    'onChangeRenkoBrickMode',
    'onInputRenkoFixedSize',
    'onToggleRenkoWicks',
    'updateChart',
    'drawChart',
    'updateChartLevels',
    'scheduleChartRender',
    'updateChartWithCandles',
    'armChartPricePick',
    'fitChartView',
    'jumpChartToLive',
    'getChartDebugState',
    'getIndicatorWorkerStats',
    'selectDrawingTool',
    'clearDrawingTool',
    'clearDrawings',
    'toggleDrawingTools',
    'initDrawingToolUI',
  ],
  ticket: [
    'fetchJournalExecutions',
    'fetchJournalSummary',
    'debouncedOrderPreview',
    'fetchOrderPreview',
    'showPreview',
    'hidePreviewRows',
    'syncLimitPreviewLevels',
    'getAutoLimitPriceForSide',
    'placeOrder',
    'placeOrderWithSide',
    'placeScaleOrder',
    'cancelActiveTwap',
    'showScalePreview',
    'clearScalePreview',
    'renderTwapStatus',
    'setSide',
    'setOrderType',
    'setPlaybook',
    'setTimeframe',
    'setPreset',
    'setSize',
    'setScaleTotal',
    'updateSummary',
    'updateScaleSummary',
    'previewOrder',
    'wouldReducePosition',
  ],
  orders: [
    'closePosition',
    'setTP',
    'setSL',
    'cancelOid',
    'cancelAllOrders',
    'showModifyModal',
    'bulkCancelSelected',
    'scheduleCancelUI',
    'closeAllPositions',
    'hideConfirmModal',
    'buildCancelsFromOrders',
    'bulkCancelOrders',
  ],
  controls: [
    'showConnectModal',
    'hideConnectModal',
    'modalConnect',
    'clearNewsConfigFromModal',
    'showToast',
    'toggleHide',
    'switchTab',
    'setLeverage',
    'updateLeverageFromSlider',
    'toggleCoinDropdown',
    'addToWatchlist',
    'removeFromWatchlist',
    'addToHideList',
    'removeFromHideList',
    'toggleMarketRadar',
    'toggleTradingPanel',
    'toggleLiqPanel',
    'setMobileView',
    'toggleMoversCollapsed',
    'handleWalletBtnClick',
    'updateCoinTabChange',
  ],
  signals: [
    'renderSignalRadar',
    'scheduleSignalRadarRender',
    'deployFillAction',
    'updateDeploySizingSetting',
    'resetDeploySizingSettings',
    'renderDeploySizingControls',
  ],
};

function pickBindings(deps, keys) {
  return Object.fromEntries(keys.map((key) => [key, deps[key]]));
}

function createCompatWindowBindings({
  appState,
  showToast,
} = {}) {
  return {
    requireKey(msg = 'Load your private key first') {
      if (!appState?.account?.privateKey) {
        showToast?.('Error: ' + msg, true);
        return false;
      }
      return true;
    },
    getApiKey() {
      return appState?.account?.privateKey || '';
    },
  };
}

export function createWindowBindingGroups(deps) {
  return Object.fromEntries(
    Object.entries(WINDOW_BINDING_GROUP_KEYS).map(([group, keys]) => [group, pickBindings(deps, keys)])
  );
}

// Groups still needed for data-action HTML shell + strategy host. Pure format
// helpers (`core`) stay available as modules — do not dump them on window.
const PRODUCTION_WINDOW_GROUPS = Object.freeze([
  'account',
  'market',
  'chart',
  'ticket',
  'orders',
  'controls',
  'signals',
]);

export function createGroupedWindowBindings({
  appState,
  showToast,
  groups,
  includeCoreUtils = false,
} = {}) {
  const selected = [];
  for (const [name, bag] of Object.entries(groups || {})) {
    if (name === 'core' && !includeCoreUtils) continue;
    if (PRODUCTION_WINDOW_GROUPS.includes(name) || (name === 'core' && includeCoreUtils)) {
      selected.push(bag);
    }
  }
  return Object.assign(
    {},
    ...selected,
    createCompatWindowBindings({ appState, showToast })
  );
}
