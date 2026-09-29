function getTicketFieldElements() {
  return {
    priceInput: document.getElementById('priceInput'),
    sizeInput: document.getElementById('sizeInput'),
    sizeSlider: document.getElementById('sizeSlider'),
    tpPctInput: document.getElementById('tpPctInput'),
    slPctInput: document.getElementById('slPctInput'),
    playbookSelect: document.getElementById('playbookSelect'),
    playbookHint: document.getElementById('playbookHint'),
    submitButton: document.getElementById('placeBtn'),
  };
}

function getScaleFieldElements() {
  return {
    scaleTotal: document.getElementById('scaleTotal'),
    scaleOrders: document.getElementById('scaleOrders'),
    scaleHigh: document.getElementById('scaleHigh'),
    scaleLow: document.getElementById('scaleLow'),
  };
}

function readScaleForm() {
  const {
    scaleTotal,
    scaleOrders,
    scaleHigh,
    scaleLow,
  } = getScaleFieldElements();
  return {
    total: parseFloat(scaleTotal?.value || '0'),
    numOrders: parseInt(scaleOrders?.value || '0', 10),
    high: parseFloat(scaleHigh?.value || '0'),
    low: parseFloat(scaleLow?.value || '0'),
  };
}

function resetScaleForm() {
  const {
    scaleTotal,
    scaleOrders,
    scaleHigh,
    scaleLow,
  } = getScaleFieldElements();
  if (scaleTotal) scaleTotal.value = '';
  if (scaleOrders) scaleOrders.value = '5';
  if (scaleHigh) scaleHigh.value = '';
  if (scaleLow) scaleLow.value = '';
}

function resetTicketRiskFields() {
  const { sizeInput, priceInput, tpPctInput, slPctInput } = getTicketFieldElements();
  if (sizeInput) sizeInput.value = '';
  if (priceInput) priceInput.value = '';
  if (tpPctInput) tpPctInput.value = '';
  if (slPctInput) slPctInput.value = '';
}

export {
  getTicketFieldElements,
  getScaleFieldElements,
  readScaleForm,
  resetScaleForm,
  resetTicketRiskFields,
};
