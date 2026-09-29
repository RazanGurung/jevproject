/**
 * Canonical state setup helpers for tests.
 *
 * Stage 3 Slice C: seed AppState only — app code no longer dual-writes
 * trading/market mirrors onto window.*.
 *
 * Usage:
 *
 *   import { seedTradingState, seedBookSnapshot } from '../../test-utils/canonical-state.js';
 *
 *   beforeEach(async () => {
 *     vi.resetModules();
 *     const { AppState } = await import('../../state/store.js');
 *     seedTradingState(AppState, { coin: 'BTC', price: 100, side: 'buy' });
 *     seedBookSnapshot(AppState, { bids: [...], asks: [...] });
 *   });
 */

function seedTradingState(AppState, {
  coin = 'BTC',
  price = 100,
  side = 'buy',
  orderType = 'limit',
  timeframe = '1m',
  leverageByCoin = null,
  walletAddress = '',
} = {}) {
  AppState.trading.currentCoin = coin;
  AppState.trading.currentPrice = price;
  AppState.trading.currentSide = side;
  AppState.trading.currentOrderType = orderType;
  AppState.trading.currentTimeframe = timeframe;
  if (walletAddress) AppState.account.walletAddress = walletAddress;
  if (leverageByCoin) AppState.account.exchangeLeverageByCoin = { ...leverageByCoin };
}

function seedBookSnapshot(AppState, { bids = [], asks = [] } = {}) {
  AppState.market.book = { bids, asks };
}

function seedPreviewLevels(AppState, levels = []) {
  AppState.ui.chartPreviewLevels = Array.isArray(levels) ? levels : [];
}

function clearLegacyTradingMirrors() {
  if (typeof window === 'undefined') return;
  delete window.currentCoin;
  delete window.currentPrice;
  delete window.currentSide;
  delete window.currentOrderType;
  delete window.currentTimeframe;
  delete window.exchangeLeverageByCoin;
  delete window.bookData;
}

export {
  seedTradingState,
  seedBookSnapshot,
  seedPreviewLevels,
  clearLegacyTradingMirrors,
};
