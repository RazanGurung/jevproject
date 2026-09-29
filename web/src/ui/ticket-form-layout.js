/**
 * Ticket form layout helpers - DOM-only mechanics extracted from tabs.js so
 * the orchestrator (tabs.js) can stay a thin event/state binder. Each helper
 * touches a specific cluster of form elements (segmented buttons, type-tab
 * group, timeframe tab group, scale fields) and returns nothing.
 */

import { resetScaleForm } from './ticket-fields.js';

const $ = (id) => document.getElementById(id);

function setDisplay(element, display) {
  if (element) element.style.display = display;
}

function applySideButtonStyles(side) {
  const buyBtn = $('buyBtn');
  const sellBtn = $('sellBtn');
  const placeBtn = $('placeBtn');

  if (buyBtn) buyBtn.className = side === 'buy' ? 'seg-btn buy-active' : 'seg-btn';
  if (sellBtn) sellBtn.className = side === 'sell' ? 'seg-btn sell-active' : 'seg-btn';
  if (placeBtn) {
    placeBtn.className = `place-btn ${side}`;
    placeBtn.textContent = side === 'buy' ? 'Place Buy Order' : 'Place Sell Order';
  }
}

function applyOrderTypeTabButton(el) {
  document.querySelectorAll('.type-tab').forEach((tab) => tab.classList.remove('active'));
  if (el) el.classList.add('active');
}

function applyTimeframeTabButton(el) {
  document.querySelectorAll('.tf-group [data-action="setTimeframe"]')
    .forEach((tab) => tab.classList.remove('active'));
  if (el) el.classList.add('active');
}

function clearScaleFormFields() {
  resetScaleForm();
}

function applyOrderTypeFormLayout(type) {
  const hideSize = type === 'bot' || type === 'scale';
  const isBot = type === 'bot';
  const isScale = type === 'scale';

  setDisplay($('priceGroup'), type === 'limit' ? '' : 'none');
  setDisplay($('priceSizeGrid'), isScale ? 'none' : '');
  setDisplay($('sizeGroup'), hideSize ? 'none' : '');
  setDisplay($('sizeSliderGroup'), hideSize ? 'none' : '');
  setDisplay($('scaleGroup'), isScale ? '' : 'none');
  setDisplay($('twapGroup'), type === 'twap' ? '' : 'none');
  setDisplay($('botGroup'), isBot ? '' : 'none');
  setDisplay($('sideControl'), isBot ? 'none' : '');
  if ($('jevSignalBanner') && globalThis.window?.JevState?.available) {
    setDisplay($('jevSignalBanner'), isBot ? 'none' : '');
  }

  const summary = $('orderSummary');
  const actionButtons = summary?.nextElementSibling;
  setDisplay(summary, isBot || isScale ? 'none' : '');
  setDisplay(actionButtons, isBot ? 'none' : '');

  setDisplay($('tpslGroup'), type === 'limit' ? '' : 'none');
}

function applyPreviewButtonVisibility({ orderType, timeframe }) {
  const previewBtn = $('previewBtn');
  if (!previewBtn) return;
  const showForLimit = orderType === 'limit' && timeframe !== '1m';
  const showForScale = orderType === 'scale';
  previewBtn.style.display = (showForLimit || showForScale) ? '' : 'none';
}

export {
  applySideButtonStyles,
  applyOrderTypeTabButton,
  applyTimeframeTabButton,
  applyOrderTypeFormLayout,
  applyPreviewButtonVisibility,
  clearScaleFormFields,
};
