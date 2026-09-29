import { syncLimitAutoTrackMode } from './ticket-mode-actions.js';
import { fmtPrice } from '../utils/format.js';

function createLimitAutoTrackController({
  getElementById = (id) => document.getElementById(id),
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
} = {}) {
  function updateCompactLimitPriceStrip() {
    const strip = getElementById('compactLimitPriceStrip');
    const buyPill = getElementById('compactLimitBuyPrice');
    const sellPill = getElementById('compactLimitSellPrice');
    const buyValue = getElementById('compactLimitBuyValue');
    const sellValue = getElementById('compactLimitSellValue');
    if (!strip || !buyPill || !sellPill || !buyValue || !sellValue) return;

    const isAuto1mLimitContext = (
      getEffectiveCurrentOrderType?.() === 'limit'
      && getEffectiveCurrentTimeframe?.() === '1m'
      && getLimitPriceEntryMode?.() === 'auto'
    );
    strip.hidden = !isAuto1mLimitContext;

    if (!isAuto1mLimitContext) {
      buyValue.textContent = '—';
      sellValue.textContent = '—';
      buyPill.dataset.active = 'false';
      sellPill.dataset.active = 'false';
      return;
    }

    const coin = getEffectiveCurrentCoin?.();
    const buyPrice = getAutoLimitPriceForSide?.('buy');
    const sellPrice = getAutoLimitPriceForSide?.('sell');
    buyValue.textContent = buyPrice > 0 ? fmtPrice(buyPrice, coin, { trimTrailingZeros: false }) : '—';
    sellValue.textContent = sellPrice > 0 ? fmtPrice(sellPrice, coin, { trimTrailingZeros: false }) : '—';
    buyPill.dataset.active = String(getEffectiveCurrentSide?.() === 'buy');
    sellPill.dataset.active = String(getEffectiveCurrentSide?.() === 'sell');
  }

  function updateLimitPriceEntryUi(mode = getLimitPriceEntryMode?.()) {
    const resolvedMode = mode === 'manual' ? 'manual' : 'auto';
    const isAutoTrackingContext = getEffectiveCurrentOrderType?.() === 'limit'
      && getEffectiveCurrentTimeframe?.() === '1m';
    const modeSelect = getElementById('priceModeSelect');
    const priceInput = getElementById('priceInput');
    const displayMode = isAutoTrackingContext ? resolvedMode : 'manual';

    if (priceInput) {
      priceInput.dataset.priceMode = displayMode;
      priceInput.title = displayMode === 'auto'
        ? 'Auto-tracked from the 1m orderbook estimate'
        : 'Manual price entry';
      priceInput.readOnly = isAutoTrackingContext && displayMode === 'auto';
    }

    if (modeSelect) {
      modeSelect.value = displayMode;
      modeSelect.dataset.mode = displayMode;
      modeSelect.style.display = isAutoTrackingContext ? '' : 'none';
      modeSelect.disabled = !isAutoTrackingContext;
      modeSelect.title = isAutoTrackingContext
        ? 'Select whether the 1m limit price follows the estimate or stays manual'
        : 'Manual price entry';
    }

    updateCompactLimitPriceStrip();
  }

  function setTicketPriceEntryMode(mode) {
    const nextMode = setLimitPriceEntryMode?.(mode);
    updateLimitPriceEntryUi(nextMode);
    return nextMode;
  }

  function syncLimitAutoTrackState({
    requestChartRefresh: shouldRefreshChart = false,
    syncUi = false,
  } = {}) {
    return syncLimitAutoTrackMode({
      updateLimitPriceEntryUi,
      currentOrderType: getEffectiveCurrentOrderType?.(),
      currentTimeframe: getEffectiveCurrentTimeframe?.(),
      syncLimitPreviewLevels,
      requestChartRefresh: shouldRefreshChart,
      requestChartRefreshFn: requestChartRefresh,
      getLimitPriceEntryMode,
      getUserEditedPrice,
      setTicketPriceEntryMode,
      getAutoLimitPriceForSide,
      priceInputValue: getElementById('priceInput')?.value || '',
      applyTicketPrice,
      syncUi,
    });
  }

  function setLimitPriceEntryModeSelection(mode) {
    const nextMode = mode === 'manual' ? 'manual' : 'auto';
    setTicketPriceEntryMode(nextMode);

    if (nextMode === 'auto') {
      resetUserEditedPrice?.();
      syncLimitAutoTrackState({ requestChartRefresh: true, syncUi: true });
      return;
    }

    setUserEditedPrice?.(true);
    updateLimitPriceEntryUi('manual');
  }

  return {
    setLimitPriceEntryModeSelection,
    setTicketPriceEntryMode,
    syncLimitAutoTrackState,
    updateCompactLimitPriceStrip,
    updateLimitPriceEntryUi,
  };
}

export {
  createLimitAutoTrackController,
};
