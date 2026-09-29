// Canonical browser-test coverage for the interactive HTML shell.
//
// The static contract test compares these variants with web/index.html. The
// live performance harness consumes the same data, so adding a control without
// deciding how it is validated fails locally instead of silently reducing UI
// coverage.

const ACTION_ATTRIBUTES = Object.freeze([
  'data-action',
  'data-input-action',
  'data-change-action',
  'data-submit-action',
  'data-enter-action',
]);

const ACTION_VARIANTS = Object.freeze({
  'data-action': Object.freeze({
    addManualAnchoredVwap: [''],
    armChartPricePick: ['buy', 'sell'],
    botToggle: [''],
    cancelActiveTwap: [''],
    cancelAllOrders: [''],
    clearDrawingTool: [''],
    clearMessagesAndDrawings: [''],
    closeAllPositions: [''],
    fitChartView: [''],
    handleWalletBtnClick: [''],
    hideConfirmModal: ['false', 'true'],
    hideConnectModal: [''],
    jumpChartToLive: [''],
    placeOrder: [''],
    placeOrderWithSide: ['buy', 'sell'],
    previewOrder: [''],
    scheduleCancelUI: [''],
    selectCandleOverlayMode: ['off', 'heikin-ashi', 'renko', 'both'],
    selectDrawingTool: [
      'trendline', 'curve', 'arrow', 'horizontal', 'hray', 'vertical',
      'channel', 'box', 'circle', 'pencil', 'zigzag', 'arrowUp',
      'arrowDown', 'fib', 'measure', 'text', 'longPosition', 'shortPosition',
    ],
    setMobileView: ['chart', 'book', 'news', 'trade', 'account'],
    setOrderType: ['limit', 'market', 'scale', 'twap', 'bot'],
    setSide: ['buy', 'sell'],
    setTimeframe: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '1w', '1M'],
    showConnectModal: [''],
    switchTab: ['positions', 'orders', 'trades', 'fills'],
    toggleCandleOverlay: [''],
    onToggleDimAllOverlays: [''],
    toggleCoinDropdown: ['crypto', 'indices', 'commodities', 'stocks', 'fx', 'watchlist', 'hidelist'],
    toggleColorPalette: [''],
    toggleDrawingTools: [''],
    toggleHide: [''],
    toggleIndicators: [''],
    toggleMarketRadar: [''],
    toggleMoversCollapsed: [''],
    toggleLiqPanel: [''],
    toggleSettings: [''],
    toggleTradingPanel: [''],
  }),
  'data-input-action': Object.freeze({
    onAskSkewChange: [''],
    onBidSkewChange: [''],
    onBulkAskSkewChange: [''],
    onBulkBidSkewChange: [''],
    onInputCandleOverlayContrast: [''],
    onInputHeikinAshiOpacity: [''],
    onInputRenkoFixedSize: [''],
    onInputRenkoOpacity: [''],
    onManualPriceInput: [''],
    onManualSizeInput: [''],
    onManualSlInput: [''],
    onManualTpInput: [''],
    setScaleTotal: [''],
    setSize: [''],
    syncBotTotals: [''],
    updateLeverageFromSlider: [''],
    updateScaleSummary: [''],
  }),
  'data-change-action': Object.freeze({
    loadBotStrategy: [''],
    onChangeCandleOverlayBaseCandles: ['dimmed', 'hidden', 'normal'],
    onChangeCandleOverlayContrast: [''],
    onChangeCvdOscillatorLookback: [''],
    onChangeHeikinAshiOpacity: [''],
    onChangeRenkoBrickMode: [''],
    onChangeRenkoOpacity: [''],
    onChangeVolumeProfilePeriod: [''],
    onChangeWhaleMarkerMin: [''],
    onToggleCvdAlerts: [''],
    onToggleHeikinAshiDimmed: [''],
    onToggleHeikinAshiWicks: [''],
    onToggleManualAnchoredVwap: [''],
    onToggleSessionVwap: ['daily', 'weekly', 'monthly'],
    onToggleMonthlyVolumeProfile: [''],
    onToggleVolumeProfileLvn: [''],
    onToggleLiquidationClusters: [''],
    onToggleJevSignals: [''],
    onToggleRenkoDimmed: [''],
    onToggleRenkoWicks: [''],
    onToggleWhaleMarkers: [''],
    onTogglePriceProjection: [''],
    onToggleWeekPathProjection: [''],
    onToggleWeekPathEnvelope: [''],
    onToggleRvwap: ['7D', '30D', '90D', '365D'],
    onToggleRvwapBands: ['7D', '30D', '90D'],
    setBotMode: ['sequential', 'bulk'],
    setLimitPriceEntryModeSelection: [''],
  }),
  'data-submit-action': Object.freeze({ modalConnect: [''] }),
  'data-enter-action': Object.freeze({ modalConnect: [''] }),
});

// Controls wired by direct listeners instead of delegated data attributes.
const DIRECT_CONTROL_IDS = Object.freeze([
  'colorPaletteResetAll',
  'colorTemplateSave',
  'colorTemplateLoad',
  'colorTemplateClear',
  'colorHexInput',
  'colorPaletteResetOne',
  'scaleOrders',
  'scaleLow',
  'scaleHigh',
  'twapMinutes',
  'twapRandomize',
  'drawingTextForm',
  'drawingTextInput',
  'drawingTextFontSize',
]);

// These paths may change account or exchange state. The CDP gate intercepts
// them before the request reaches the local server and records the attempted
// payload for contract assertions.
const MUTATING_API_PATHS = Object.freeze([
  '/api/bot/start',
  '/api/bot/stop',
  '/api/bulk-cancel',
  '/api/bulk-orders',
  '/api/cancel-order',
  '/api/clear-key',
  '/api/close-position',
  '/api/color-palette-templates',
  '/api/modify-order',
  '/api/order',
  '/api/schedule-cancel',
  '/api/set-key',
  '/api/set-leverage',
  '/api/trigger-order',
  '/api/twap-cancel',
  '/api/twap-order',
]);

// Dynamic controls are absent from the initial shell and are validated after
// their owning surface has rendered.
const DYNAMIC_ACTIONS = Object.freeze([
  'switchCoin',
  'addToWatchlist',
  'removeFromWatchlist',
  'addToHideList',
  'removeFromHideList',
  'domLadderPick',
  'showModifyModal',
  'cancelOid',
  'closePosition',
  'setTP',
  'setSL',
  'deployFillAction',
  'onToggleManualAnchoredVwapBands',
  'onChangeManualAnchoredVwapSigma',
]);

function actionVariantKey(attribute, action, arg = '') {
  return `${attribute}:${action}:${String(arg ?? '')}`;
}

function expectedStaticVariantKeys() {
  const keys = [];
  for (const [attribute, actions] of Object.entries(ACTION_VARIANTS)) {
    for (const [action, args] of Object.entries(actions)) {
      for (const arg of args) keys.push(actionVariantKey(attribute, action, arg));
    }
  }
  return keys.sort();
}

export {
  ACTION_ATTRIBUTES,
  ACTION_VARIANTS,
  DIRECT_CONTROL_IDS,
  DYNAMIC_ACTIONS,
  MUTATING_API_PATHS,
  actionVariantKey,
  expectedStaticVariantKeys,
};
