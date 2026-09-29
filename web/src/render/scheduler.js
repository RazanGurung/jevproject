/**
 * Render scheduler - coordinates batched UI rendering
 */

import { AppState } from '../state/store.js';
import { renderPositions, renderPositionsIncremental } from './positions.js';
import { renderOpenOrders as renderOrders, renderOpenOrdersIncremental } from './orders.js';
import { renderTrades } from './trades.js';
import { renderFills } from './fills.js';
import { renderFundingTable } from './funding.js';
import { updateTabCounts } from './ui-state.js';
import { scheduleSignalRadarRender } from '../ui/signal-radar.js';
import { scheduleChartRender } from '../chart/chart-render.js';
import { updateChartLevelsWithTracking } from '../chart/chart-levels.js';
import { scheduleFrame } from '../utils/frame.js';

let renderBatchPending = false;
let renderBatchTimer = null;

function scheduleRender() {
  renderBatchPending = true;
  if (!renderBatchTimer) {
    renderBatchTimer = scheduleFrame(flushRenderBatch);
  }
}

function flushRenderBatch() {
  if (!renderBatchPending) {
    renderBatchTimer = null;
    return;
  }
  renderBatchPending = false;
  renderBatchTimer = null;

  const activeTab = document.querySelector('.bottom-tab.active');
  if (activeTab) {
    const tabName = activeTab.dataset.tab;
    if (tabName === 'positions') {
      renderPositionsIncremental();
    } else if (tabName === 'orders') {
      renderOpenOrdersIncremental();
    } else if (tabName === 'trades') {
      renderTrades();
    } else if (tabName === 'fills') {
      renderFills();
    }
  }
  
  updateTabCounts();
  scheduleSignalRadarRender();
  const chartLevelsChanged = updateChartLevelsWithTracking();
  if (chartLevelsChanged) {
    scheduleChartRender();
  }
}

export {
  scheduleRender,
  flushRenderBatch,
};
