import { AppState } from '../state/store.js';
import { isLimitPreviewAutoTrackEnabled } from '../state/trading-runtime.js';
import { scheduleChartRender } from '../chart/chart-render.js';
import { renderOrderFlow } from '../render/trades.js';
import { renderDomLadder } from '../render/dom-ladder.js';
import { syncLimitAutoTrackState } from '../ui/tabs.js';
import { scheduleFrame } from '../utils/frame.js';

let watchlistMetricsRenderPending = false;
let renderContext = 0;
let hudFlowPending = false;
let hudLadderPending = false;
let hudScheduled = false;
let hudFlowCoin = '';

function cancelPendingRenders() {
  renderContext++;
  watchlistMetricsRenderPending = false;
  hudFlowPending = false;
  hudLadderPending = false;
  hudScheduled = false;
}

function scheduleHudParts(coin, { flow = false, ladder = false } = {}) {
  if (flow) {
    if (coin !== AppState.trading.currentCoin) return;
    hudFlowPending = true;
    hudFlowCoin = coin;
  }
  if (ladder) hudLadderPending = true;
  if (hudScheduled) return;
  const ctx = renderContext;
  hudScheduled = true;
  scheduleFrame(() => {
    hudScheduled = false;
    // Generation check first: a cancelled frame must not consume flags a
    // newer schedule already queued after cancelPendingRenders.
    if (ctx !== renderContext) return;
    const wantFlow = hudFlowPending;
    const wantLadder = hudLadderPending;
    const flowCoin = hudFlowCoin;
    hudFlowPending = false;
    hudLadderPending = false;
    if (wantFlow && flowCoin === AppState.trading.currentCoin) renderOrderFlow();
    if (wantLadder) renderDomLadder();
  });
}

function scheduleActiveTradePanelsRender(coin) {
  scheduleHudParts(coin, { flow: true, ladder: true });
}

function scheduleLiveDomLadderRender() {
  scheduleHudParts(AppState.trading.currentCoin, { ladder: true });
}

// Coalesce live price/flow patches onto the open watchlist dropdown. Mids and
// trade flow arrive many times per second; one rAF keeps the trigger columns
// fresh without rewriting the whole panel (and stealing search focus).
function scheduleWatchlistMetricsRender() {
  if (watchlistMetricsRenderPending) return;
  const dropdown = typeof document !== 'undefined' ? document.getElementById('coinDropdown') : null;
  if (!dropdown || dropdown.dataset.open !== 'true' || dropdown.dataset.category !== 'watchlist') {
    return;
  }
  const ctx = renderContext;
  watchlistMetricsRenderPending = true;
  scheduleFrame(async () => {
    watchlistMetricsRenderPending = false;
    if (ctx !== renderContext) return;
    try {
      const { refreshOpenWatchlistMetrics } = await import('../ui/controls.js');
      refreshOpenWatchlistMetrics();
    } catch {
      // Controls chunk may not be ready during early boot; next tick retries.
    }
  });
}

function refreshLimitPreviewTracking() {
  if (!isLimitPreviewAutoTrackEnabled()) return;
  if (AppState.trading.currentTimeframe !== '1m') return;
  if (AppState.trading.currentOrderType !== 'limit') return;
  if (syncLimitAutoTrackState({ requestChartRefresh: false, syncUi: true })) {
    scheduleChartRender();
  }
}

// Book ticks already refresh the native live price line via applyCurrentPrice.
// Full chart overlay (strategy layers, order/position lines) repaints on
// candle/order/position changes and when limit auto-track moves preview levels.
// Scheduling drawChart on every L2 frame was the main mid-market jank source.
function scheduleOrderbookRender() {
  // Intentionally empty coalescing hook retained for call-site stability and
  // cancelPendingRenders generation bumps on coin switch. Limit auto-track is
  // owned by refreshLimitPreviewTracking on the same book path.
}

export {
  cancelPendingRenders,
  refreshLimitPreviewTracking,
  scheduleActiveTradePanelsRender,
  scheduleLiveDomLadderRender,
  scheduleOrderbookRender,
  scheduleWatchlistMetricsRender,
};
