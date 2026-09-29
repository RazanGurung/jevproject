/**
 * Tabs - Order ticket and tab input orchestration
 * Enhanced with full setSide/setOrderType from app.js monolith
 * Includes BOT mode, TWAP, scale, 1m auto-tracking, preview
 */

import { AppState, candleCache, setCurrentOrderType, setCurrentSide } from '../state/store.js';
import { getAccountState } from '../state/account-state.js';
import { getMobileChartActionBarSyncer } from '../state/app-host.js';
import { getAllMids, getBookData } from '../state/market-selectors.js';
import { getEffectiveCurrentCoin, getEffectiveCurrentOrderType, getEffectiveCurrentPrice, getEffectiveCurrentSide, getEffectiveCurrentTimeframe, getEffectiveWalletAddress } from '../state/effective-trading.js';
import { getLimitPriceEntryMode, getUserEditedPrice, setLimitAutoTrackForTimeframe, setLimitPriceEntryMode, setUserEditedPrice } from '../state/trading-runtime.js';
import { clearScalePreviewOrders, getChartPreviewLevels, setChartPreviewLevels } from '../state/preview-state.js';
import { scheduleChartRender } from '../chart/chart-render.js';
import { getAccountMetrics } from '../services/account-metrics.js';
import { applyPlaybook, getSelectedPlaybook } from '../services/playbooks.js';
import { getBotStrategyLoader } from '../services/runtime-compat.js';
import { requireKey } from '../services/wallet-service.js';
import { roundPriceToTick } from '../services/trading-service-helpers.js';
import { fmtInputPrice, fmtPrice } from '../utils/format.js';
import { showToast } from './toast.js';
import { clearDeployedTicketState as clearDeployedTicketStateImpl, handleManualTicketEdit, restoreManualTicketMode as restoreManualTicketModeImpl } from './ticket-manual-state.js';
import { buildLimitPreviewLevels as buildLimitPreviewLevelsForState } from './tabs-preview.js';
import { readOrderTicketInput } from './ticket-submit-state.js';
import { applyTicketSizeValue, resolvePresetSizeUsd } from './ticket-size-actions.js';
import { createTicketSizingRuntime } from './ticket-sizing-runtime.js';
import { refreshTicketSummary } from './ticket-summary-runtime.js';
import { createLimitAutoTrackController } from './ticket-limit-auto-track.js';
import { createTicketInputRuntime } from './ticket-input-runtime.js';
import { createTicketModeRuntime } from './ticket-mode-runtime.js';
import { createTimeframeSwitchRuntime } from './ticket-timeframe-runtime.js';
import { createTicketTradingRuntime } from './ticket-trading-runtime.js';
import {
  previewLimitOrderOnChart,
} from './ticket-chart-actions.js';
import {
  debouncedOrderPreview as debouncedOrderPreviewImpl,
  fetchOrderPreview as fetchOrderPreviewImpl,
  getActiveLeverage,
  hidePreviewRows,
  showPreview,
} from './ticket-order-preview-runtime.js';
import {
  maybeApplyAutoLimitPrice,
  reconcileOrderTypePreview,
  reconcileTimeframePreview,
} from './ticket-transitions.js';
import {
  applyOrderTypeFormLayout,
  applyOrderTypeTabButton,
  applyPreviewButtonVisibility,
  applySideButtonStyles,
  applyTimeframeTabButton,
  clearScaleFormFields,
} from './ticket-form-layout.js';

// Helper
const $ = id => document.getElementById(id);
let marketActionsPromise = null;
let tradingActionsPromise = null;

function syncMobileChartActionBar() {
  getMobileChartActionBarSyncer()?.();
}

function loadMarketActions() {
  if (!marketActionsPromise) {
    marketActionsPromise = import('../streams/market-ws.js');
  }
  return marketActionsPromise;
}

function loadTradingActions() {
  if (!tradingActionsPromise) {
    tradingActionsPromise = Promise.all([
      import('../services/trading-service.js'),
      import('../services/trading-service-scale.js'),
      import('../services/trading-service-twap.js'),
    ]).then(([tradingService, scaleService, twapService]) => ({
      ...scaleService,
      ...twapService,
      ...tradingService,
    }));
  }
  return tradingActionsPromise;
}

function requestChartRefresh() {
  scheduleChartRender();
}

function resetUserEditedPrice() {
  setUserEditedPrice(false);
}

function applyTicketPrice(price, {
  userEdited = false,
  formatDecimals = null,
  syncUi = true,
  clearDeployState = userEdited,
  snapToTick = false,
  coin = getEffectiveCurrentCoin(),
} = {}) {
  const rawPrice = Number(price);
  const nextPrice = snapToTick ? roundPriceToTick(rawPrice, coin) : rawPrice;
  if (!Number.isFinite(nextPrice) || nextPrice <= 0) return false;

  const priceInput = $('priceInput');
  if (!priceInput) return false;

  if (clearDeployState) {
    clearDeployedTicketState({ keepPrice: true, keepTargets: true });
  }

  if (Number.isInteger(formatDecimals)) {
    priceInput.value = fmtInputPrice(nextPrice, { decimals: formatDecimals });
  } else if (snapToTick) {
    priceInput.value = fmtPrice(nextPrice, coin, { trimTrailingZeros: false });
  } else {
    priceInput.value = fmtInputPrice(nextPrice);
  }
  if (userEdited) {
    setUserEditedPrice(true);
    setTicketPriceEntryMode('manual');
  } else {
    resetUserEditedPrice();
    setTicketPriceEntryMode('auto');
  }

  if (syncUi) updateSummary();
  return true;
}

function updateTicketLayoutMode() {
  const orderContent = document.querySelector('.order-content');
  const deployAssistPanel = $('deployAssistPanel');
  if (!orderContent || !deployAssistPanel) return;

  const currentCoin = getEffectiveCurrentCoin();
  const currentOrderType = getEffectiveCurrentOrderType();
  const deployedPlan = AppState.trading.lastDeployedPlan;
  const showDeployAssist = Boolean(
    deployedPlan
    && deployedPlan.coin === currentCoin
    && currentOrderType === 'limit'
  );

  deployAssistPanel.style.display = showDeployAssist ? '' : 'none';
  orderContent.classList.toggle('compact-manual', !showDeployAssist);
  syncMobileChartActionBar();
}

function clearDeployedTicketState(options = {}) {
  clearDeployedTicketStateImpl({
    appState: AppState,
    options,
    applyPlaybook,
    getEffectiveCurrentSide,
    updateTicketLayoutMode,
  });
}

function restoreManualTicketMode() {
  restoreManualTicketModeImpl({
    appState: AppState,
    applyPlaybook,
    getEffectiveCurrentSide,
    updateTicketLayoutMode,
  });
}

function buildLimitPreviewLevels() {
  const sizeUsd = parseFloat($('sizeInput')?.value) || 0;
  const currentSide = getEffectiveCurrentSide();
  const currentCoin = getEffectiveCurrentCoin();
  return buildLimitPreviewLevelsForState({
    sizeUsd,
    currentSide,
    currentCoin,
    currentPrice: getEffectiveCurrentPrice(),
  });
}

function getAutoLimitPriceForSide(side = getEffectiveCurrentSide()) {
  const levels = buildLimitPreviewLevels();
  const target = levels.find((level) => level.isBuy === (side === 'buy'));
  return Number.isFinite(target?.price) ? target.price : 0;
}

function syncLimitPreviewLevels() {
  const currentOrderType = getEffectiveCurrentOrderType();
  const currentTimeframe = getEffectiveCurrentTimeframe();
  if (currentOrderType !== 'limit' || currentTimeframe !== '1m') return false;

  const nextLevels = buildLimitPreviewLevels();
  const prevLevels = getChartPreviewLevels();
  const sameLength = prevLevels.length === nextLevels.length;
  const unchanged = sameLength && prevLevels.every((prev, index) => {
    const next = nextLevels[index];
    return !!next
      && Math.abs((prev.price || 0) - (next.price || 0)) < 1e-9
      && prev.label === next.label
      && prev.isBuy === next.isBuy
      && (prev.lineWidth || 0) === (next.lineWidth || 0);
  });

  if (unchanged) return false;

  setChartPreviewLevels(nextLevels);
  return true;
}

const {
  updateLimitPriceEntryUi,
  setTicketPriceEntryMode,
  setLimitPriceEntryModeSelection,
  syncLimitAutoTrackState,
} = createLimitAutoTrackController({
  getElementById: $,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentTimeframe,
  getLimitPriceEntryMode,
  getEffectiveCurrentCoin,
  getAutoLimitPriceForSide,
  getEffectiveCurrentSide,
  setLimitPriceEntryMode,
  resetUserEditedPrice,
  setUserEditedPrice,
  syncLimitPreviewLevels,
  requestChartRefresh,
  getUserEditedPrice,
  applyTicketPrice,
});

const timeframeSwitchRuntime = createTimeframeSwitchRuntime({
  loadMarketActions,
  // Candle truth is backend-owned; market-session is the sole chart fetch intent path.
  fetchCandles: (...args) => import('../services/market-session.js').then((m) => m.requestChartCandles(...args)),
  applyTimeframeTabButton,
  reconcileTimeframePreview,
  clearScalePreview: () => loadTradingActions().then(({ clearScalePreview }) => clearScalePreview()),
  syncLimitPreviewLevels,
  syncLimitAutoTrackState,
  updateLimitPriceEntryUi,
  applyPreviewButtonVisibility,
  resetUserEditedPrice,
  getCachedCandles: (coin, timeframe) => candleCache.get(`${coin}:${timeframe}`),
});

let ticketInputRuntime = null;
let ticketSizingRuntime = null;

const ticketTradingRuntime = createTicketTradingRuntime({
  loadTradingActions,
  requireKey,
  getElementById: $,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentTimeframe,
  getEffectiveCurrentSide,
  getLimitPriceEntryMode,
  getUserEditedPrice,
  setSide: (side) => setSide(side),
  readOrderTicketInput,
  updateSummary: () => ticketInputRuntime?.updateSummary(),
  updateTicketLayoutMode,
  getAutoLimitPriceForSide,
  applyTicketPrice,
  applySideButtonStyles,
  syncMobileChartActionBar,
  previewLimitOrderOnChart,
  setChartPreviewLevels,
  requestChartRefresh,
  showToast,
  fetchOrderPreviewImpl,
  debouncedOrderPreviewImpl,
});

ticketInputRuntime = createTicketInputRuntime({
  getElementById: $,
  getEffectiveCurrentTimeframe,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentCoin,
  getEffectiveCurrentPrice,
  getLimitPriceEntryMode,
  getChartPreviewLevels,
  getAllMids,
  getSelectedPlaybook,
  refreshTicketSummary,
  updateLimitPriceEntryUi,
  updateTicketLayoutMode,
  syncLimitAutoTrackState,
  getDebouncedOrderPreview: () => debouncedOrderPreview,
  handleManualTicketEdit,
  setTicketPriceEntryMode,
  setUserEditedPrice,
  clearDeployedTicketState,
});

ticketSizingRuntime = createTicketSizingRuntime({
  getElementById: $,
  clearDeployedTicketState,
  getEffectiveWalletAddress,
  getAccountState,
  getSpotBalance: () => AppState.account.spotBalance || 0,
  getEffectiveCurrentCoin,
  getEffectiveCurrentSide,
  getAccountMetrics,
  getActiveLeverage,
  resolvePresetSizeUsd,
  applyTicketSizeValue,
  updateSummary: () => ticketInputRuntime?.updateSummary(),
  updateScaleSummary: () => ticketInputRuntime?.updateScaleSummary(),
  applyPlaybook,
});

const ticketModeRuntime = createTicketModeRuntime({
  clearDeployedTicketState,
  setCurrentSide,
  applySideButtonStyles,
  getEffectiveCurrentOrderType,
  getEffectiveCurrentTimeframe,
  getChartPreviewLevels,
  loadTradingActions,
  clearScalePreviewOrders,
  syncLimitPreviewLevels,
  requestChartRefresh,
  maybeApplyAutoLimitPrice: (nextSide) => maybeApplyAutoLimitPrice({
    currentOrderType: getEffectiveCurrentOrderType(),
    side: nextSide,
    priceInput: $('priceInput'),
    bookData: getBookData(),
    getAutoLimitPriceForSide,
    applyTicketPrice,
  }),
  updateSummary: () => ticketInputRuntime?.updateSummary(),
  syncMobileChartActionBar,
  setCurrentOrderType,
  clearScaleFormFields,
  applyOrderTypeTabButton,
  applyOrderTypeFormLayout,
  getBotStrategyLoader,
  applyPreviewButtonVisibility,
  reconcileOrderTypePreview,
  setLimitAutoTrackForTimeframe,
  resetUserEditedPrice,
  getPriceInput: () => $('priceInput'),
  getEffectiveCurrentSide,
  getAutoLimitPriceForSide,
  applyTicketPrice,
  syncLimitAutoTrackState,
  updateLimitPriceEntryUi,
});

/**
 * Set trading side (buy/sell)
 * Full implementation from app.js with preview updates
 */
function setSide(side) {
  return ticketModeRuntime.setSide(side);
}

/**
 * Set order type (limit/market/scale/twap/bot)
 * Full implementation from app.js with all mode handling
 */
function setOrderType(type, el) {
  return ticketModeRuntime.setOrderType(type, el);
}

/**
 * Preview order on chart
 */
async function previewOrder() {
  return ticketTradingRuntime.previewOrder();
}

async function submitOrderFromTicket() {
  return ticketTradingRuntime.submitOrderFromTicket();
}

async function placeOrderWithSide(side, submitButtonEl = null) {
  return ticketTradingRuntime.placeOrderWithSide(side, submitButtonEl);
}

async function fetchOrderPreview() {
  return ticketTradingRuntime.fetchOrderPreview();
}

function debouncedOrderPreview() {
  return ticketTradingRuntime.debouncedOrderPreview();
}

/**
 * Set timeframe (1m/5m/15m/etc)
 */
function setTimeframe(tf, el) {
  const started = timeframeSwitchRuntime.setTimeframe(tf, el);
  if (!started) return;
  syncMobileChartActionBar();
}

/**
 * Set position size preset (25%/50%/75%/100%)
 */
function setPreset(pct) {
  return ticketSizingRuntime?.setPreset(pct);
}

/**
 * Set size from input
 */
function setSize(val) {
  return ticketSizingRuntime?.setSize(val);
}

/**
 * Set scale total from input/slider
 */
function setScaleTotal(val) {
  return ticketSizingRuntime?.setScaleTotal(val);
}

/**
 * Update order summary display
 */
function updateSummary() {
  return ticketInputRuntime?.updateSummary();
}

function setPlaybook(playbookName, elOrValue) {
  return ticketSizingRuntime?.setPlaybook(playbookName, elOrValue);
}

/**
 * Update scale summary display - syncs slider to input value
 */
function updateScaleSummary() {
  return ticketInputRuntime?.updateScaleSummary();
}

function onManualPriceInput() {
  return ticketInputRuntime?.onManualPriceInput();
}

function onManualSizeInput() {
  return ticketInputRuntime?.onManualSizeInput();
}

function onManualTpInput() {
  return ticketInputRuntime?.onManualTpInput();
}

function onManualSlInput() {
  return ticketInputRuntime?.onManualSlInput();
}

export { debouncedOrderPreview, fetchOrderPreview, hidePreviewRows, showPreview };

export {
  applyTicketPrice,
  setSide,
  setOrderType,
  setPlaybook,
  setTimeframe,
  setPreset,
  setSize,
  setScaleTotal,
  restoreManualTicketMode,
  onManualPriceInput,
  onManualSizeInput,
  onManualTpInput,
  onManualSlInput,
  updateSummary,
  updateTicketLayoutMode,
  updateScaleSummary,
  previewOrder,
  submitOrderFromTicket,
  placeOrderWithSide,
  setLimitPriceEntryModeSelection,
  getAutoLimitPriceForSide,
  syncLimitPreviewLevels,
  syncLimitAutoTrackState
};
