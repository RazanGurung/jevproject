import { loadActiveChartSession } from './chart-load-session.js';
import { candleCache } from '../state/store.js';
import { getActiveCandleRequestToken, setActiveCandleRequestToken, setUserEditedPrice } from '../state/trading-runtime.js';
import { findAssetCtx } from '../state/market-state.js';
import { pruneMarketCoinCaches } from '../state/market-trades.js';
import { getDesiredTradeCoins } from '../state/market-subscription-state.js';
import { noteDomBookCoin, pruneSpacingCache } from '../render/dom-ladder.js';
import { getCachedBook } from '../state/market-book.js';
import { getCurrentCoin } from '../state/trading-selectors.js';
import { rememberRecentCoin } from '../state/connection-health.js';
import { updateConnectionStatusUI } from '../streams/account-stream-ui.js';
import { closeCoinDropdown } from '../ui/control-surface.js';
import { getTicketFieldElements } from '../ui/ticket-fields.js';
import { markUiPerformance } from '../utils/performance.js';
import { isHip3Coin } from '../utils/helpers.js';
import {
  renderTopPrice,
  resetMarketStats,
  setActiveCoinTab,
  syncLeverageControls,
  updateChartTitle,
} from '../ui/market-display.js';
let activeCoinSwitchToken = 0;

function getCachedCoinSnapshot(deps, coin, timeframe) {
  const targetCandleCacheKey = `${coin}:${timeframe}`;
  const cachedCandles = candleCache.get(targetCandleCacheKey) || null;
  const cachedMid = parseFloat(deps.getAllMids()?.[coin] || 0);
  return { cachedCandles, cachedMid };
}

function resetCoinSwitchRuntimeCaches(deps) {
  deps.setBookVersion(0);
  // Per-coin trade/DOM caches accrete an entry for every coin ever streamed;
  // trim to the desired warm set (active + watchlist + recent coins — the
  // set whose rolling flow/DOM state should remain immediately available).
  const resolveKeepCoins = deps.getDesiredTradeCoins || getDesiredTradeCoins;
  const keepCoins = resolveKeepCoins({ activeCoin: getCurrentCoin() });
  pruneMarketCoinCaches(deps.AppState.market, keepCoins);
  pruneSpacingCache(keepCoins);
}

function syncCoinSwitchLeverage(deps, coin) {
  if (!deps.getEffectiveWalletAddress()) return;
  const maxLev = deps.getMaxLeverage(coin);
  syncLeverageControls(maxLev);
  deps.ensureMaxLeverageDefault(coin);
}

function syncCoinSwitchOrderState(deps, {
  coin,
  currentOrderType,
  is1mChart,
} = {}) {
  deps.clearScalePreview();

  if (currentOrderType === 'limit' && is1mChart) {
    deps.syncLimitPreviewLevels();
    deps.scheduleChartRender();
  }

  setUserEditedPrice(false);
}

function syncCoinSwitchChartCache(deps, {
  coin,
  cachedCandles,
  cachedMid,
} = {}) {
  // AppState is the sole market source of truth (Stage 3); no window mirrors.
  deps.resetMarketRuntimeState?.();
  if (cachedCandles) {
    deps.AppState.market.candles = cachedCandles;
  }
  const cachedBook = getCachedBook(deps.AppState.market, coin);
  if (cachedBook) {
    // Copy out rather than alias the cached entry: the ladder's book-identity
    // -keyed bucket memo needs a fresh object, and a later live tick mutating
    // AppState.market.book must not reach back into the cache.
    deps.AppState.market.book = { bids: [...cachedBook.bids], asks: [...cachedBook.asks] };
    noteDomBookCoin(coin);
  }
  deps.setLegacy('currentPrice', cachedMid > 0 ? cachedMid : 0);
  deps.updateChartLevels?.();
  // Prefer updateChart so default auto-fit re-aligns viewCount and re-fits the
  // overview. scheduleChartRender alone can leave the previous zoom window.
  if (typeof deps.updateChart === 'function') deps.updateChart();
  else deps.scheduleChartRender?.();
  return Boolean(cachedBook);
}

function syncCoinSwitchTicket(deps, {
  coin,
  cachedMid,
  currentOrderType,
} = {}) {
  const { priceInput } = getTicketFieldElements();
  if (!priceInput) return;

  if (cachedMid > 0 && currentOrderType === 'limit' && deps.AppState.ui.userEditedPrice !== true) {
    const autoPrice = deps.getAutoLimitPriceForSide(deps.getEffectiveCurrentSide());
    const resolvedPrice = autoPrice > 0 ? autoPrice : cachedMid;
    deps.applyTicketPrice(resolvedPrice, {
      userEdited: false,
      syncUi: false,
      clearDeployState: false,
      snapToTick: true,
    });
  } else {
    priceInput.value = '';
  }

  priceInput.placeholder = cachedMid > 0 ? deps.fmtPrice(cachedMid, coin) || String(cachedMid) : '—';
}

function renderCoinSwitchUi(deps, {
  coin,
  cachedMid,
} = {}) {
  renderTopPrice(cachedMid, coin, deps.fmtPrice);
  resetMarketStats();
  // Refresh the tab title even when the target has no cached mid. Leaving the
  // previous symbol in browser chrome is a misleading stale-selection signal.
  deps.updateTopBar();
  deps.syncActiveTradeState(coin, { requireCurrentEpoch: true });
  if (typeof deps.scheduleLayoutRender === 'function') {
    deps.scheduleLayoutRender({ book: true, reason: `symbol:${coin}` });
  } else {
    deps.renderLiquidations?.();
    deps.renderOrderFlow?.();
    deps.renderDomLadder?.();
  }
}

function setTicketSubmitButtonState(button, {
  disabled,
  text,
} = {}) {
  if (!button) return;
  button.disabled = disabled === true;
  if (typeof text === 'string') {
    button.textContent = text;
  }
}

function applyStandardCoinSubmitState(placeBtn) {
  setTicketSubmitButtonState(placeBtn, {
    disabled: false,
    text: 'Place Order',
  });
  updateConnectionStatusUI();
}

function refreshHip3TicketFromMarkPrice(deps, {
  coin,
  currentOrderType,
  is1mChart,
  markPx,
} = {}) {
  deps.AppState.market.allMids[coin] = markPx.toString();
  deps.setLegacy('currentPrice', markPx);

  const { priceInput: livePriceInput } = getTicketFieldElements();
  if (livePriceInput && currentOrderType === 'limit' && deps.AppState.ui.userEditedPrice !== true && !livePriceInput.value) {
    const autoPrice = deps.getAutoLimitPriceForSide(deps.getEffectiveCurrentSide());
    const resolvedPrice = autoPrice > 0 ? autoPrice : markPx;
    deps.applyTicketPrice(resolvedPrice, {
      userEdited: false,
      syncUi: false,
      clearDeployState: false,
      snapToTick: true,
    });
  }

  deps.updateTopBar();

  if (currentOrderType === 'limit' && is1mChart) {
    const changed = deps.syncLimitPreviewLevels();
    if (changed) deps.scheduleChartRender();
  }
}

function warmHip3CoinContext(deps, {
  coin,
  currentOrderType,
  is1mChart,
  isActiveCoinSwitch,
} = {}) {
  const { submitButton: placeBtn } = getTicketFieldElements();
  const origText = placeBtn?.dataset?.feedLockLabel
    || (placeBtn?.textContent && placeBtn.textContent !== 'Feed stale' && placeBtn.textContent !== 'Loading price...' ? placeBtn.textContent : 'Place Order');
  setTicketSubmitButtonState(placeBtn, {
    disabled: true,
    text: 'Loading price...',
  });

  const timeout = setTimeout(() => {
    if (!isActiveCoinSwitch()) return;
    setTicketSubmitButtonState(placeBtn, {
      disabled: false,
      text: placeBtn?.dataset?.feedLockLabel || origText,
    });
    updateConnectionStatusUI();
  }, 5000);

  (async () => {
    try {
      const dex = coin.split(':')[0].toLowerCase();
      const dedupKey = `xyzMeta:${dex}`;
      const meta = await deps.fetchWithDedup(dedupKey, () =>
        deps.hlPost({ type: 'metaAndAssetCtxs', dex })
      );
      if (!isActiveCoinSwitch()) return;

      const ctx = findAssetCtx(meta, coin);
      const markPx = parseFloat(ctx?.markPx || 0);
      if (markPx) {
        refreshHip3TicketFromMarkPrice(deps, {
          coin,
          currentOrderType,
          is1mChart,
          markPx,
        });
      }
    } catch (e) {
      console.error('xyz meta fetch failed:', e);
    } finally {
      if (!isActiveCoinSwitch()) return;
      clearTimeout(timeout);
      setTicketSubmitButtonState(placeBtn, {
        disabled: false,
        text: placeBtn?.dataset?.feedLockLabel || origText,
      });
      updateConnectionStatusUI();
    }
  })();
}

function syncCoinSwitchTransportIntent(deps, {
  coin,
  timeframe,
  requestToken,
} = {}) {
  deps.setDesiredMarketSubscription?.({
    coin,
    interval: timeframe,
  });
  if (typeof deps.scheduleSignalRadarRender === 'function') {
    deps.scheduleSignalRadarRender();
  } else {
    deps.renderSignalRadar();
  }
  deps.refreshTickerNews?.(coin).catch?.(() => {});

  deps.beginChartSession({
    coin,
    timeframe,
    requestToken,
  });
  // Clear historyLoadState so scroll-back re-fetches on the new coin
  deps.clearHistoryLoadState(coin, timeframe);
  loadActiveChartSession({
    coin,
    timeframe,
    requestToken,
    getActiveCandleRequestToken,
    fetchCandles: deps.fetchCandles,
    fetchOptions: {},
    subscribeMarket: deps.subscribeMarket,
    subscribeMode: 'beforeFetch',
    completeChartSession: deps.completeChartSession,
    failChartSession: deps.failChartSession,
    requestChartRefresh: deps.scheduleChartRender,
    updateChart: deps.updateChart,
    initChart: deps.initChart,
  });
}

export function createSwitchCoin(deps) {
  let lastRequestedCoin = null;

  return function switchCoin(coin) {
    // The first call initializes the default pair. Subsequent clicks on the
    // already-requested pair should only dismiss the picker; restarting the
    // chart session here creates a visible loading flash and needless traffic.
    const chartSession = deps.AppState?.ui?.chartSession;
    const alreadyOwnsReadyChart = chartSession?.status === 'ready' && chartSession.coin === coin;
    if (getCurrentCoin() === coin && (coin === lastRequestedCoin || alreadyOwnsReadyChart)) {
      closeCoinDropdown();
      return false;
    }
    lastRequestedCoin = coin;
    rememberRecentCoin(coin);

    markUiPerformance('symbol-switch-start', {
      coin,
      previousCoin: getCurrentCoin(),
      timeframe: deps.getEffectiveCurrentTimeframe(),
    });

    const coinSwitchToken = ++activeCoinSwitchToken;
    const currentTimeframe = deps.getEffectiveCurrentTimeframe();
    const candleRequestToken = Date.now() + Math.random();
    const { cachedCandles, cachedMid } = getCachedCoinSnapshot(deps, coin, currentTimeframe);
    setActiveCandleRequestToken(candleRequestToken);
    const isActiveCoinSwitch = () => (
      activeCoinSwitchToken === coinSwitchToken &&
      getCurrentCoin() === coin
    );

    deps.cancelPendingRenders?.();
    deps.setLegacy('currentCoin', coin);
    // Hydrate the dedicated 4h RVWAP source as soon as the pair is current,
    // before the first cached paint, so a warm source can attach with candles.
    deps.scheduleActiveRvwapHydration?.(coin);
    deps.updateTicketLayoutMode();
    syncCoinSwitchLeverage(deps, coin);
    resetCoinSwitchRuntimeCaches(deps);

    const currentOrderType = deps.getEffectiveCurrentOrderType();
    const is1mChart = deps.getEffectiveCurrentTimeframe() === '1m';
    syncCoinSwitchOrderState(deps, { coin, currentOrderType, is1mChart });

    closeCoinDropdown();
    setActiveCoinTab(coin, deps.coinToTabId);
    updateChartTitle(coin);
    deps.updateSizeSliderMax();
    deps.scheduleRender();
    deps.renderTwapStatus();
    // Re-arm default auto-fit before painting cached candles so the first
    // draw of the new pair is a full-history overview, not the prior zoom.
    deps.clearHistoryLoadState?.(coin, currentTimeframe);
    const restoredBook = syncCoinSwitchChartCache(deps, { coin, cachedCandles, cachedMid });
    syncCoinSwitchTicket(deps, { coin, cachedMid, currentOrderType });
    renderCoinSwitchUi(deps, { coin, cachedMid });
    if (typeof window !== 'undefined' && typeof window.fetchJevSignal === 'function' && window.JevState?.available) {
      window.fetchJevSignal(coin).catch(() => {});
    }
    markUiPerformance('symbol-switch-commit', {
      coin,
      timeframe: currentTimeframe,
      cachedCandles: Array.isArray(cachedCandles) ? cachedCandles.length : 0,
      cachedBook: restoredBook,
    });

    const isHip3 = isHip3Coin(coin);
    const { submitButton: placeBtn } = getTicketFieldElements();
    if (!isHip3) applyStandardCoinSubmitState(placeBtn);
    if (isHip3) {
      warmHip3CoinContext(deps, {
        coin,
        currentOrderType,
        is1mChart,
        isActiveCoinSwitch,
      });
    }

    syncCoinSwitchTransportIntent(deps, {
      coin,
      timeframe: currentTimeframe,
      requestToken: candleRequestToken,
    });
    if (!restoredBook && typeof deps.fetchL2Snapshot === 'function') {
      setTimeout(() => {
        if (!isActiveCoinSwitch()) return;
        const book = deps.AppState.market.book || {};
        if (book.bids?.length && book.asks?.length) return;
        deps.fetchL2Snapshot(coin, { shouldApply: isActiveCoinSwitch }).catch?.(() => {});
      }, 250);
    }
    deps.refreshExchangeInfo(coin, { includeActiveAssetData: !deps.getEffectiveWalletAddress() });

    // Warm the new coin's neighbouring timeframes on idle so flipping
    // timeframes on it is instant. No-ops if a newer switch supersedes us.
    deps.prefetchAdjacentTimeframes?.({ coin, timeframe: currentTimeframe });
    return true;
  };
}
