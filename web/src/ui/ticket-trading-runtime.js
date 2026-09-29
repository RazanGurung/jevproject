function createTicketTradingRuntime({
  loadTradingActions,
  requireKey,
  getElementById = (id) => document.getElementById(id),
  getEffectiveCurrentOrderType,
  getEffectiveCurrentTimeframe,
  getEffectiveCurrentSide,
  getLimitPriceEntryMode,
  getUserEditedPrice,
  setSide,
  readOrderTicketInput,
  updateSummary,
  updateTicketLayoutMode,
  getAutoLimitPriceForSide,
  previewLimitOrderOnChart,
  setChartPreviewLevels,
  requestChartRefresh,
  showToast,
  fetchOrderPreviewImpl,
  debouncedOrderPreviewImpl,
} = {}) {
  async function previewOrder() {
    if (!requireKey?.('Connect wallet first')) return;

    const currentOrderType = getEffectiveCurrentOrderType?.();
    const currentTimeframe = getEffectiveCurrentTimeframe?.();

    if (currentOrderType === 'scale') {
      const { placeScaleOrder } = await loadTradingActions();
      await placeScaleOrder?.();
      return;
    }

    if (currentOrderType === 'limit') {
      const sizeUsd = parseFloat(getElementById('sizeInput')?.value);
      const limitPx = parseFloat(getElementById('priceInput')?.value);
      previewLimitOrderOnChart?.({
        currentTimeframe,
        sizeUsd,
        limitPx,
        currentSide: getEffectiveCurrentSide?.(),
        setChartPreviewLevels,
        requestChartRefresh,
        showToast,
      });
    }
  }

  async function submitOrderFromTicket() {
    const { placeOrder } = await loadTradingActions();
    return placeOrder?.(
      readOrderTicketInput?.({ onSizeUsdChange: updateSummary }),
      { onAccepted: updateTicketLayoutMode, onSizeAdjusted: updateSummary }
    );
  }

  async function placeOrderWithSide(side, submitButtonEl = null) {
    const nextSide = side === 'sell' ? 'sell' : 'buy';
    const shouldUseSideSpecificAutoPrice = (
      getEffectiveCurrentOrderType?.() === 'limit'
      && getEffectiveCurrentTimeframe?.() === '1m'
      && getLimitPriceEntryMode?.() === 'auto'
      && !getUserEditedPrice?.()
    );

    setSide?.(nextSide);

    const ticketInput = readOrderTicketInput?.({
      onSizeUsdChange: updateSummary,
      submitButtonEl: submitButtonEl || undefined,
      rawLimitPrice: shouldUseSideSpecificAutoPrice
        ? (getAutoLimitPriceForSide?.(nextSide) || undefined)
        : undefined,
    });
    const { placeOrder } = await loadTradingActions();
    return placeOrder?.(ticketInput, {
      onAccepted: updateTicketLayoutMode,
      onSizeAdjusted: updateSummary,
    });
  }

  async function fetchOrderPreview() {
    return fetchOrderPreviewImpl?.(readOrderTicketInput?.());
  }

  function debouncedOrderPreview() {
    return debouncedOrderPreviewImpl?.(readOrderTicketInput);
  }

  return {
    debouncedOrderPreview,
    fetchOrderPreview,
    placeOrderWithSide,
    previewOrder,
    submitOrderFromTicket,
  };
}

export {
  createTicketTradingRuntime,
};
