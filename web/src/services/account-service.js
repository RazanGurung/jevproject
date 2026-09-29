/**
 * Account service - enriched account synchronization and account-derived UI helpers
 */

import { AppState, filterSuppressedOrders, filterSuppressedPositions, setDefaultLeverageApplied, setExchangeLeverage } from '../state/store.js';
import { normalizeRestAccountState, setBackendOpenOrders, setBackendAssetPositions, setBackendAccountRisk, getAccountState, getOpenPositions, shouldApplyIncomingAccountSnapshot, shouldApplyIncomingOrderRevision, commitIncomingOrderRevision } from '../state/account-state.js';
import { getDefaultLeverageApplied, getExchangeLeverage, getWalletAddress } from '../state/account-selectors.js';
import { apiPost } from './api.js';
import { getManagedExchangePrivateKey } from './exchange-auth.js';
import { getMaxLeverage } from '../state/coin-meta.js';
import { getCurrentCoin } from '../state/trading-selectors.js';
import { scheduleRender } from '../render/scheduler.js';
import { getAccountMetrics } from './account-metrics.js';
import { updateBalanceDisplay, updateSizeSliderMax, setLastKnownAccountMetrics } from '../ui/account-ui.js';
import { syncLeverageControls } from '../ui/market-display.js';
import { isBuilderPerpCoin, sleep } from '../utils/helpers.js';

let accountFetchPending = null;
let accountFetchDebounceTimer = null;
let accountFetchDebounceForce = false;
const ACCOUNT_FETCH_DEBOUNCE_MS = 75;
const ACCOUNT_FETCH_RETRY_DELAYS_MS = [150, 400];
const ACCOUNT_FETCH_FAILURE_COOLDOWN_MS = 4000;
const ACCOUNT_FETCH_STALE_COOLDOWN_MS = 2000;
const ACCOUNT_FETCH_SUCCESS_COOLDOWN_MS = 1000;
let accountFetchCooldownUntil = 0;
let lastAccountFetchCompletedAt = 0;
let lastAccountFetchResult = null;

let accountFetchResolve = null;

function isRetryableAccountError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || '');
  return status === 429 || status >= 500 || /429|clearinghouseState|temporar|timeout/i.test(message);
}

function debouncedFetchAccount(force = false) {
  if (!force && Date.now() - lastAccountFetchCompletedAt < ACCOUNT_FETCH_SUCCESS_COOLDOWN_MS) {
    return;
  }
  accountFetchDebounceForce = accountFetchDebounceForce || force;
  if (accountFetchDebounceTimer) clearTimeout(accountFetchDebounceTimer);
  accountFetchDebounceTimer = setTimeout(() => {
    const shouldForce = accountFetchDebounceForce;
    accountFetchDebounceForce = false;
    accountFetchDebounceTimer = null;
    fetchAccount(shouldForce);
  }, ACCOUNT_FETCH_DEBOUNCE_MS);
}

async function fetchAccount(force = false) {
  const walletAddress = AppState.account.walletAddress;
  if (!walletAddress) return;

  if (!force && Date.now() < accountFetchCooldownUntil) {
    return null;
  }

  if (!force && lastAccountFetchResult && (Date.now() - lastAccountFetchCompletedAt) < ACCOUNT_FETCH_SUCCESS_COOLDOWN_MS) {
    return lastAccountFetchResult;
  }
  
  if (accountFetchPending) {
    return accountFetchPending;
  }

  accountFetchPending = (async () => {
    try {
      let d = null;
      let lastError = null;

      for (let attempt = 0; attempt <= ACCOUNT_FETCH_RETRY_DELAYS_MS.length; attempt++) {
        try {
          d = await apiPost('/api/account', { address: walletAddress, mainnet: true, force });
          if (d) break;
          console.warn('Fetch account: empty response body');
        } catch (e) {
          lastError = e;
          if (attempt >= ACCOUNT_FETCH_RETRY_DELAYS_MS.length || !isRetryableAccountError(e)) {
            throw e;
          }
          await sleep(ACCOUNT_FETCH_RETRY_DELAYS_MS[attempt]);
          continue;
        }
      }

      if (!d) {
        if (lastError) throw lastError;
        return null;
      }
      
      const spotBalance = parseFloat(d.state?.spotUSDC || 0);
      AppState.account.spotBalance = spotBalance;

      if (d.state) {
		if (d.stale === true) d.state.accountSnapshotStale = true;
        const prevAccountState = getAccountState();
		const applyAccountSnapshot = shouldApplyIncomingAccountSnapshot(d.state, prevAccountState);

        if (applyAccountSnapshot && d.state.assetPositions !== undefined) {
          d.state = setBackendAssetPositions(
            d.state,
            filterSuppressedPositions(d.state.assetPositions)
          );
        }
        if (applyAccountSnapshot) {
          d.state = setBackendAccountRisk(d.state, {
            marginSummary: d.state.marginSummary,
            crossMarginSummary: d.state.crossMarginSummary,
            riskSummary: d.state.riskSummary,
            withdrawable: d.state.withdrawable,
          });
        }

        // CRITICAL: Update openOrders from REST response (matches backup behavior)
        if (d.orders !== undefined && shouldApplyIncomingOrderRevision(d.orderRevision)) {
          const filteredOrders = filterSuppressedOrders(d.orders || []);
          const nextOrders = setBackendOpenOrders(filteredOrders, {
            stale: d.stale === true || d.ordersStale === true,
          });
          d.orders = nextOrders;
          commitIncomingOrderRevision(d.orderRevision);
        }

        if (applyAccountSnapshot) {
          d.state = normalizeRestAccountState(d.state, prevAccountState);
          AppState.account.state = d.state;
        } else {
          d.state = prevAccountState;
        }
      }

      const { accountValue, available } = getAccountMetrics(d.state);
      setLastKnownAccountMetrics(accountValue, available);
      
      updateBalanceDisplay();
      updateSizeSliderMax();
      scheduleRender();

      if (d.stale) {
        accountFetchCooldownUntil = Math.max(accountFetchCooldownUntil, Date.now() + ACCOUNT_FETCH_STALE_COOLDOWN_MS);
      }

      lastAccountFetchCompletedAt = Date.now();
      lastAccountFetchResult = d;
      
      return d;
    } catch (e) {
      console.error('Fetch account error:', e);
      if (isRetryableAccountError(e)) {
        accountFetchCooldownUntil = Date.now() + ACCOUNT_FETCH_FAILURE_COOLDOWN_MS;
      }
      lastAccountFetchResult = null;
      return null;
    } finally {
      accountFetchPending = null;
    }
  })();

  return accountFetchPending;
}

function applyExchangeLeverageToUI(coin, leverage) {
  if (!Number.isFinite(leverage) || leverage <= 0) return;
  setExchangeLeverage(coin, leverage);
  if (coin === getCurrentCoin()) {
    syncLeverageControls(leverage, coin);
    updateSizeSliderMax();
  }
}

function getActiveExchangeLeverage(coin) {
  return getExchangeLeverage(coin);
}

function coinHasOpenPosition(coin) {
  return getOpenPositions().some((row) => row?.position?.coin === coin);
}

async function writeExchangeLeverage(coin, leverage) {
  const d = await apiPost('/api/set-leverage', {
    privateKey: getManagedExchangePrivateKey(),
    coin,
    leverage,
    isCross: !isBuilderPerpCoin(coin),
    mainnet: true,
  });
  return d?.status === 'ok';
}

async function ensureMaxLeverageDefault(coin, force = false) {
  const walletAddress = getWalletAddress();
  if (!coin || !walletAddress) return null;

  const maxLev = parseInt(getMaxLeverage(coin), 10) || 20;
  if (!force && getDefaultLeverageApplied(coin) === maxLev) {
    applyExchangeLeverageToUI(coin, maxLev);
    return maxLev;
  }

  await fetchExchangeLeverage(coin, { applyUi: false });
  const current = getActiveExchangeLeverage(coin);
  if (coinHasOpenPosition(coin)) {
    applyExchangeLeverageToUI(coin, current || maxLev);
    return current || maxLev;
  }
  if (current === maxLev) {
    setDefaultLeverageApplied(coin, maxLev);
    applyExchangeLeverageToUI(coin, maxLev);
    return maxLev;
  }

  try {
    if (await writeExchangeLeverage(coin, maxLev)) {
      setDefaultLeverageApplied(coin, maxLev);
      applyExchangeLeverageToUI(coin, maxLev);
      return maxLev;
    }
  } catch (e) {
    console.warn('ensureMaxLeverageDefault write failed:', e);
  }

  const fallback = current || maxLev;
  applyExchangeLeverageToUI(coin, fallback);
  return fallback;
}

async function fetchExchangeLeverage(coin, { applyUi = true } = {}) {
  try {
    const walletAddress = getWalletAddress();
    if (!walletAddress) return;
    const d = await apiPost('/api/active-asset-data', { coin: coin, address: walletAddress, mainnet: true });
    const leverage = parseInt(d?.leverage, 10);
    if (Number.isFinite(leverage) && leverage > 0) {
      if (applyUi) applyExchangeLeverageToUI(coin, leverage);
      else setExchangeLeverage(coin, leverage);
    }
  } catch (e) {
    // Silent fail
  }
}

export {
  debouncedFetchAccount,
  fetchAccount,
  updateBalanceDisplay,
  updateSizeSliderMax,
  fetchExchangeLeverage,
  ensureMaxLeverageDefault,
  applyExchangeLeverageToUI,
  ACCOUNT_FETCH_DEBOUNCE_MS,
  ACCOUNT_FETCH_SUCCESS_COOLDOWN_MS
};
