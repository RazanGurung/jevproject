import { applyTicketSummary, buildTicketSummary } from './ticket-summary.js';

function refreshTicketSummary({
  updateLimitPriceEntryUi,
  updateTicketLayoutMode,
  sizeInputValue,
  priceInputValue,
  currentCoin,
  currentPrice,
  allMids,
  selectedPlaybook,
  elements = {},
  shouldSyncLimitAutoTrack = false,
  syncLimitAutoTrackState,
  debouncedOrderPreview,
} = {}) {
  updateLimitPriceEntryUi?.();
  updateTicketLayoutMode?.();

  const summary = buildTicketSummary({
    sizeInputValue,
    priceInputValue,
    currentCoin,
    currentPrice,
    allMids,
    selectedPlaybook,
  });

  applyTicketSummary(summary, elements);

  if (shouldSyncLimitAutoTrack) {
    syncLimitAutoTrackState?.({ requestChartRefresh: true, syncUi: false });
  }

  debouncedOrderPreview?.();
  return summary;
}

export {
  refreshTicketSummary,
};
