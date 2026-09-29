import { getMaxLeverage } from '../state/coin-meta.js';
import { getCurrentCoin } from '../state/trading-selectors.js';
import { getLeverageControlElements } from './control-surface.js';

function getMarketDisplayName(coin) {
  return String(coin || '').includes(':') ? String(coin).split(':')[1] : String(coin || '');
}

function renderTopPrice(price, coin, fmtPrice) {
  const topPrice = document.getElementById('topPrice');
  if (!topPrice) return;
  topPrice.textContent = price > 0 ? (fmtPrice?.(price, coin) || String(price)) : '—';
}

function updateDocumentTitle(coin, price, fmtPrice) {
  const pair = getMarketDisplayName(coin);
  if (!pair) return;
  const formatted = price > 0 ? (fmtPrice?.(price, pair) || String(price)) : '';
  document.title = formatted ? `${pair} $${formatted}` : pair;
}

function resetMarketStats() {
  const fundingVal = document.getElementById('fundingVal');
  if (fundingVal) fundingVal.textContent = '—';
  const oiVal = document.getElementById('oiVal');
  if (oiVal) oiVal.textContent = '—';
}

function setActiveCoinTab(coin, coinToTabId) {
  document.querySelectorAll('.coin-tab.active').forEach((tab) => tab.classList.remove('active'));
  const tabId = coinToTabId?.(coin);
  const tabEl = tabId ? document.getElementById('tab-' + tabId) : null;
  if (tabEl) tabEl.classList.add('active');
}

function updateChartTitle(coin) {
  const chartTitle = document.getElementById('chartTitle');
  if (!chartTitle) return;
  chartTitle.textContent = getMarketDisplayName(coin);
}

function syncLeverageControls(leverage, coin = getCurrentCoin()) {
  if (!Number.isFinite(leverage) || leverage <= 0) return;
  const maxLev = parseInt(getMaxLeverage(coin), 10) || leverage;
  const current = Math.min(Math.max(1, Math.round(leverage)), maxLev);
  const { slider, sliderValue, exchangeValue } = getLeverageControlElements();
  if (slider) {
    slider.min = '1';
    slider.max = String(maxLev);
    slider.value = String(current);
  }
  if (sliderValue) sliderValue.textContent = current + 'x';
  if (exchangeValue) exchangeValue.textContent = current + 'x';
}

export {
  getMarketDisplayName,
  renderTopPrice,
  updateDocumentTitle,
  resetMarketStats,
  setActiveCoinTab,
  updateChartTitle,
  syncLeverageControls,
};
