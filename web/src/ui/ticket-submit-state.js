import { getTicketFieldElements } from './ticket-fields.js';

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readOrderTicketInput(overrides = {}) {
  const {
    sizeInput: sizeInputEl,
    sizeSlider: sizeSliderEl,
    priceInput: priceInputEl,
    tpPctInput: tpPctInputEl,
    slPctInput: slPctInputEl,
    playbookSelect: playbookSelectEl,
    submitButton: defaultSubmitButtonEl,
  } = getTicketFieldElements();
  const submitButtonEl = overrides.submitButtonEl ?? defaultSubmitButtonEl;
  const rawLimitPrice = parseOptionalNumber(overrides.rawLimitPrice);
  const tpPct = overrides.tpPct !== undefined
    ? parseOptionalNumber(overrides.tpPct)
    : parseOptionalNumber(tpPctInputEl?.value);
  const slPct = overrides.slPct !== undefined
    ? parseOptionalNumber(overrides.slPct)
    : parseOptionalNumber(slPctInputEl?.value);
  const selectedPlaybook = typeof overrides.selectedPlaybook === 'string' && overrides.selectedPlaybook
    ? overrides.selectedPlaybook
    : (playbookSelectEl?.value || 'Manual');
  const resolvedSizeUsd = parseOptionalNumber(overrides.sizeUsd);
  const fallbackLimitPrice = parseOptionalNumber(priceInputEl?.value);
  const defaultSizeUsdChange = typeof overrides.onSizeUsdChange === 'function'
    ? overrides.onSizeUsdChange
    : null;

  return {
    sizeUsd: resolvedSizeUsd ?? parseOptionalNumber(sizeInputEl?.value) ?? 0,
    rawLimitPrice: rawLimitPrice ?? fallbackLimitPrice ?? 0,
    tpPct,
    slPct,
    selectedPlaybook,
    submitButtonEl,
    syncSizeUsd(nextSize, { onChange } = {}) {
      if (sizeInputEl) sizeInputEl.value = String(nextSize);
      if (sizeSliderEl) sizeSliderEl.value = String(nextSize);
      const changeHandler = typeof onChange === 'function' ? onChange : defaultSizeUsdChange;
      if (typeof changeHandler === 'function') changeHandler();
    },
  };
}

export {
  readOrderTicketInput,
};
