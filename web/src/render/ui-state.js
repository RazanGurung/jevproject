/**
 * UI state - low-level UI toggles and tab state helpers
 */

import { AppState, setHideValues } from '../state/store.js';
import { setDesiredMarketSubscription } from '../state/market-subscription-state.js';
import { getAccountTabCounts } from '../state/account-state.js';
import { renderFills } from './fills.js';
import { renderFundingTable } from './funding.js';
import { renderOpenOrders, renderOpenOrdersIncremental } from './orders.js';
import { renderPositions, renderPositionsIncremental } from './positions.js';
import { renderTrades } from './trades.js';
import { renderSignalRadar } from '../ui/signal-radar.js';
import { updateBalanceDisplay } from '../ui/account-ui.js';
import { fetchNewsConfig, startNewsPolling, stopNewsPolling } from '../services/news-service.js';
import { subscribeMarket } from '../streams/market-ws.js';
import { syncLayoutDensity, setMobileView } from '../ui/layout-density.js';
import { toggleMoversCollapsed } from '../ui/layout-prefs.js';

function toggleHide() {
  setHideValues(!AppState.ui.hideValues);
  
  const $ = id => document.getElementById(id);
  const btn = $('hideValuesBtn');
  if (btn) {
    const hidden = AppState.ui.hideValues;
    btn.textContent = hidden ? 'Show $' : 'Hide $';
    btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    btn.title = hidden ? 'Show account dollar values' : 'Hide account dollar values';
  }
  
  renderPositions();
  renderOpenOrders();
  updateBalanceDisplay();
}

function setMarketRadarState(visible) {
  AppState.ui.marketRadarVisible = visible === true;
  AppState.ui.marketRadarConnected = visible === true;
}

function toggleMarketRadar() {
  const nextVisible = AppState.ui.marketRadarVisible !== true;
  setMarketRadarState(nextVisible);
  setDesiredMarketSubscription();
  subscribeMarket().catch?.(() => {});
  renderSignalRadar();

  if (nextVisible) {
    fetchNewsConfig().catch((error) => {
      console.warn('News config fetch failed:', error);
    }).finally(() => {
      startNewsPolling();
      renderSignalRadar();
    });
  } else {
    stopNewsPolling();
  }

  // Lightweight Charts owns its container ResizeObserver. Avoid scheduling a
  // second full chart/overlay render for this grid-column change; the normal
  // live render lane refreshes overlays without blocking the toggle frame.
}

function setTradingPanelState(visible) {
  AppState.ui.tradingPanelVisible = visible === true;
  window.tradingPanelVisible = AppState.ui.tradingPanelVisible;

  const layoutEl = document.getElementById('mainLayout');
  if (layoutEl) layoutEl.classList.toggle('trading-hidden', !AppState.ui.tradingPanelVisible);

  const btn = document.getElementById('tradingToggleBtn');
  if (btn) {
    const on = AppState.ui.tradingPanelVisible;
    btn.classList.toggle('connected', on);
    btn.classList.toggle('disconnected', !on);
    btn.textContent = 'Trade';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Hide order entry & positions' : 'Show order entry & positions';
  }

}

function toggleTradingPanel() {
  const nextVisible = AppState.ui.tradingPanelVisible !== true;
  setTradingPanelState(nextVisible);
}

function setLiqPanelState(visible) {
  AppState.ui.liqPanelVisible = visible === true;
  window.liqPanelVisible = AppState.ui.liqPanelVisible;

  const layoutEl = document.getElementById('mainLayout');
  if (layoutEl) layoutEl.classList.toggle('liq-hidden', !AppState.ui.liqPanelVisible);

  const btn = document.getElementById('liqToggleBtn');
  if (btn) {
    const on = AppState.ui.liqPanelVisible;
    btn.classList.toggle('connected', on);
    btn.classList.toggle('disconnected', !on);
    btn.textContent = 'Liqs';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Hide liquidations, misprice and signal' : 'Show liquidations, misprice and signal';
  }
}

function toggleLiqPanel() {
  const nextVisible = AppState.ui.liqPanelVisible !== true;
  setLiqPanelState(nextVisible);
}

function switchTab(tabName) {
  const $ = id => document.getElementById(id);
  
  document.querySelectorAll('.bottom-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  if (tabName === 'positions') {
    renderPositionsIncremental();
  } else if (tabName === 'orders') {
    renderOpenOrdersIncremental();
  } else if (tabName === 'trades') {
    renderTrades();
  } else if (tabName === 'fills') {
    renderFills();
  } else if (tabName === 'funding') {
    renderFundingTable();
  }
  
}

function updateTabCounts() {
  const counts = getAccountTabCounts();
  
  const $ = id => document.getElementById(id);
  
  const posCount = $('positionsCount');
  const ordCount = $('ordersCount');
  
  if (posCount) posCount.textContent = `(${counts.positions})`;
  if (ordCount) ordCount.textContent = `(${counts.orders})`;
}

export {
  toggleHide,
  toggleMarketRadar,
  toggleTradingPanel,
  toggleLiqPanel,
  setLiqPanelState,
  switchTab,
  updateTabCounts,
  setMobileView,
  syncLayoutDensity,
  toggleMoversCollapsed,
};
