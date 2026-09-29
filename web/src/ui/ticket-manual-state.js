import { getTicketFieldElements } from './ticket-fields.js';

export function clearDeployedTicketState({
  appState,
  options = {},
  applyPlaybook,
  getEffectiveCurrentSide,
  updateTicketLayoutMode,
}) {
  if (appState.trading) {
    appState.trading.lastDeployedPlan = null;
  }

  if (!options.skipManualReset) {
    applyPlaybook('Manual', {
      side: getEffectiveCurrentSide(),
      keepPrice: options.keepPrice !== false,
      keepTargets: options.keepTargets !== false,
    });
  }

  updateTicketLayoutMode();
}

export function restoreManualTicketMode(deps) {
  clearDeployedTicketState({
    ...deps,
    options: {
      keepPrice: true,
      keepTargets: true,
    },
  });
}

export function handleManualTicketEdit({
  shouldIgnoreEdit,
  beforePriceWrite,
  beforeManualEdit,
  markUserEditedPrice = false,
  setUserEditedPrice,
  clearDeployedTicketState,
  updateSummary,
}) {
  if (typeof shouldIgnoreEdit === 'function' && shouldIgnoreEdit()) {
    updateSummary();
    return;
  }
  if (typeof beforePriceWrite === 'function') {
    const { priceInput } = getTicketFieldElements();
    beforePriceWrite(priceInput?.value ?? '');
  }
  if (typeof beforeManualEdit === 'function') {
    beforeManualEdit();
  }
  if (markUserEditedPrice) {
    setUserEditedPrice(true);
  }
  clearDeployedTicketState({ keepPrice: true, keepTargets: true });
  updateSummary();
}
