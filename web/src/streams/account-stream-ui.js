import { AppState } from '../state/store.js';
import { getConnectionChromeState, isTradingAllowed } from '../state/connection-health.js';
import { scheduleRender } from '../render/scheduler.js';
import { updateBalanceDisplay, updateSizeSliderMax } from '../ui/account-ui.js';
import { syncPriceConsumers } from '../ui/topbar.js';
import { renderTwapStatus } from '../services/trading-service-twap.js';
import { showToast } from '../ui/toast.js';
import { renderFills } from '../render/fills.js';
import { applyBotStatusBridge } from '../services/runtime-compat.js';

// Single connection indicator: the topbar status dot (below the gainers/
// losers rows, right of the view tools). The old fixed-position
// #connection-status dot in the window corner duplicated the same WS state
// and was removed.
export function updateConnectionStatusUI(_state) {
  const chrome = getConnectionChromeState();
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const statusPill = document.getElementById('statusPill');

  if (statusDot) {
    if (chrome.tone === 'live') {
      statusDot.style.background = 'var(--green)';
    } else if (chrome.tone === 'sync') {
      statusDot.style.background = 'var(--amber)';
    } else {
      statusDot.style.background = 'var(--red)';
    }
    statusDot.title = `WS: ${chrome.state}`;
  }
  if (statusLabel) statusLabel.textContent = chrome.label;
  if (statusPill) {
    statusPill.dataset.tone = chrome.tone;
    statusPill.title = `Connection: ${chrome.label}`;
  }

  const tradingAllowed = isTradingAllowed();
  ['placeBtn', 'buyBtn', 'sellBtn'].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    if (!tradingAllowed) {
      button.dataset.feedLocked = '1';
      button.disabled = true;
      if (id === 'placeBtn' && !button.dataset.feedLockLabel) {
        button.dataset.feedLockLabel = button.textContent || 'Place Order';
        button.textContent = 'Feed stale';
      }
    } else if (button.dataset.feedLocked === '1') {
      delete button.dataset.feedLocked;
      button.disabled = false;
      if (id === 'placeBtn' && button.dataset.feedLockLabel) {
        button.textContent = button.dataset.feedLockLabel;
        delete button.dataset.feedLockLabel;
      }
    }
  });
}

export function dispatchAccountStreamUiHints(result) {
  if (!result) return;

  switch (result.type) {
    case 'allMids':
      if (result.currentCoinUpdated) {
        syncPriceConsumers(result.currentCoinUpdated, AppState.trading.currentPrice, { refreshTopBar: true });
      }
      break;
    case 'candle':
      break;
    case 'bbo':
      if (result.matchesActive) {
        const spreadEl = document.getElementById('spread-indicator');
        if (spreadEl) {
          spreadEl.textContent = `Spread: ${result.spread.toFixed(2)} (${result.spreadBps.toFixed(1)} bps)`;
        }
      }
      break;
    case 'twapStates':
      renderTwapStatus();
      break;
    case 'webData2':
      updateBalanceDisplay();
      updateSizeSliderMax();
      scheduleRender();
      break;
    case 'xyzPositions':
	case 'builderPositions':
      // Backend xyz poll tick: positions (incl. liquidationPx) changed.
      scheduleRender();
      break;
    case 'orderResponse':
      if (result.error) {
        showToast('Order error: ' + result.error, true);
      }
      break;
    case 'orderUpdates':
      if (result.protectionError) {
        showToast(
          `TP/SL FAILED for ${result.protectionError.coin}: ${result.protectionError.error} — position is UNPROTECTED`,
          true,
        );
      }
      scheduleRender();
      break;
    case 'userFills':
      if (result.filledOids.length) {
        scheduleRender();
      }
      // Own liquidations surface as a toast here and a LIQ badge in the Fills
      // panel; the LIQS side panel is the market-wide feed, rendered elsewhere.
      if (result.ownLiquidations?.length) {
        result.ownLiquidations.forEach((fill) => {
          const liq = fill.liquidation || {};
          showToast(
            `⚠️ LIQUIDATED: ${fill.coin || ''} (${liq.method || 'liquidation'}) @ ${liq.markPx || fill.px || ''}`,
            true,
          );
        });
      }
      if (document.querySelector('.bottom-tab.active')?.dataset.tab === 'fills') {
        renderFills();
      }
      break;
    case 'botStatus':
      applyBotStatusBridge(result.status);
      break;
  }
}
