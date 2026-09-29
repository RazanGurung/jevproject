import { closePopover } from './popover-controller.js';

function getLeverageControlElements() {
  return {
    slider: document.getElementById('leverageSlider'),
    sliderValue: document.getElementById('leverageSliderValue'),
    exchangeValue: document.getElementById('leverageExchangeValue'),
  };
}

function getDisplayedLeverageValue(fallback = 0) {
  const { exchangeValue, sliderValue } = getLeverageControlElements();
  return parseFloat(exchangeValue?.textContent || sliderValue?.textContent) || fallback;
}

function getCoinDropdownElements(category) {
  const dropdown = document.getElementById('coinDropdown');
  const cat = category || dropdown?.dataset.category || '';
  const trigger = cat
    ? document.querySelector(`[data-action="toggleCoinDropdown"][data-arg="${cat}"]`)
    : document.querySelector('[data-action="toggleCoinDropdown"]');
  return { dropdown, trigger };
}

function closeCoinDropdown() {
  closePopover('markets');
}

export {
  closeCoinDropdown,
  getCoinDropdownElements,
  getDisplayedLeverageValue,
  getLeverageControlElements,
};
