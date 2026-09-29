/**
 * Account UI - DOM mutations for balance display and size slider
 * Pure UI layer: reads from AppState, updates DOM only
 */

import { AppState } from '../state/store.js';
import { getAccountState } from '../state/account-state.js';
import { getExchangeLeverage } from '../state/account-selectors.js';
import { getAccountMetrics } from '../services/account-metrics.js';
import { getMaxLeverage } from '../state/coin-meta.js';

const $ = id => document.getElementById(id);

// Last-known values are retained only for compatibility/diagnostics. Canonical
// state continuity handles missing snapshots; an authoritative zero must never
// be replaced with an earlier positive value.
let lastKnownAccountValue = 0;
let lastKnownAvailableBalance = 0;

function setLastKnownAccountMetrics(accountValue, availableBalance) {
  if (Number.isFinite(accountValue) && accountValue > 0) {
    lastKnownAccountValue = accountValue;
  }
  if (Number.isFinite(availableBalance) && availableBalance > 0) {
    lastKnownAvailableBalance = availableBalance;
  }
}

function updateBalanceDisplay() {
  const accountState = getAccountState();
  const hideValues = AppState.ui.hideValues;

  if (!accountState) {
    if ($('equityDisplay')) $('equityDisplay').textContent = 'Portfolio Value: $0.00';
    if ($('spotDisplay')) $('spotDisplay').textContent = 'Avail.: $0.00';
    return;
  }

  if (hideValues) {
    if ($('equityDisplay')) $('equityDisplay').textContent = 'Portfolio Value: $xxxxx';
    if ($('spotDisplay')) $('spotDisplay').textContent = 'Avail.: $xxxxx';
    return;
  }

  const { accountValue: totalEquity, available: availableBalance } = getAccountMetrics(accountState);
	const stale = accountState.accountSnapshotStale === true || accountState.riskSummaryFresh === false;

  // Cache fresh values for fallback
  if (totalEquity > 0) lastKnownAccountValue = totalEquity;
  if (availableBalance > 0) lastKnownAvailableBalance = availableBalance;

  const fmt = (n) => {
    n = parseFloat(n) || 0;
    if (isNaN(n) || !isFinite(n)) n = 0;
    return n > 0 ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '$0.00';
  };

  if ($('equityDisplay')) {
    $('equityDisplay').textContent = 'Portfolio Value: ' + fmt(totalEquity);
    $('equityDisplay').classList.toggle('stale', stale);
    $('equityDisplay').title = stale ? 'Last known account value; account snapshot is incomplete or stale.' : '';
  }
  if ($('spotDisplay')) {
    $('spotDisplay').textContent = 'Avail.: ' + fmt(availableBalance);
    $('spotDisplay').classList.toggle('stale', stale);
    $('spotDisplay').title = stale ? 'Last known free collateral; account snapshot is incomplete or stale.' : '';
  }
}

function updateSizeSliderMax() {
  const accountState = getAccountState();
  const currentCoin = AppState.trading.currentCoin;

  if (!accountState) {
    const slider = $('sizeSlider');
    if (slider) slider.max = 10000;
    return;
  }

  const exchangeLev = getActiveExchangeLeverage(currentCoin);
  const configuredLev = exchangeLev || getMaxLeverage(currentCoin);

  const { available } = getAccountMetrics(accountState);
  const maxSize = available * configuredLev;
  const sliderMax = Math.max(10, Math.round(maxSize));

  const slider = $('sizeSlider');
  if (slider) {
    slider.max = sliderMax;
    slider.step = Math.max(1, Math.round(sliderMax / 100));
  }

  const scaleSlider = $('scaleTotalSlider');
  if (scaleSlider) {
    scaleSlider.max = sliderMax;
    scaleSlider.step = Math.max(1, Math.round(sliderMax / 100));
  }
}

function getActiveExchangeLeverage(coin) {
  return getExchangeLeverage(coin);
}

export {
  updateBalanceDisplay,
  updateSizeSliderMax,
  setLastKnownAccountMetrics,
};
