/**
 * Wallet service - wallet connect/disconnect and private key handling
 */

import { setLegacy } from '../state/legacy-globals.js';
import { AppState } from '../state/store.js';
import { getApiKey as getStoredApiKey, getWalletAddress } from '../state/account-selectors.js';
import { clearRecentFills, setLastTwapId, setTwapStatePayload } from '../state/account-state.js';
import { resetOrderState } from '../state/account-state-orders.js';
import { clearAllPreview } from '../state/preview-state.js';
import { getMaxLeverage } from '../state/coin-meta.js';
import { truncAddr } from '../utils/helpers.js';
import { apiGet, apiPost } from './api.js';
import { fetchRecentFills } from './fills-service.js';
import { connectAccountStream, disconnectAccountStream, disablePollingFallback, getAccountStreamSocket } from '../streams/account-stream.js';
import { fetchAccount, ensureMaxLeverageDefault, fetchExchangeLeverage } from './account-service.js';
import { refreshExchangeInfo } from './market-service.js';
import { scheduleRender } from '../render/scheduler.js';
import { renderPositions } from '../render/positions.js';
import { renderOpenOrders } from '../render/orders.js';
import { showToast } from '../ui/toast.js';
import { setWalletButtonLabel, showConnectedWallet, showDisconnectedWallet } from '../ui/wallet-connection-ui.js';
import { setUserEditedPrice } from '../state/trading-runtime.js';
import { getConnectModalOpener } from '../state/app-host.js';

let walletBtnClickedOnce = false;
const ACCOUNT_ADDRESS_STORAGE_KEY = 'pez_account_address';

function normalizeAccountAddress(addr) {
  const value = (addr || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : '';
}

function requireKey(msg = 'Load your private key first') {
  if (!getStoredApiKey()) {
    showToast('Error: ' + msg, true);
    return false;
  }
  return true;
}

function getApiKey() {
  const privateKey = getStoredApiKey();
  return privateKey === '__AUTO__' ? '__AUTO__' : privateKey;
}

async function restoreBackendSession() {
  const privateKey = getApiKey();
  const accountAddress = normalizeAccountAddress(getWalletAddress());
  if (!privateKey || !accountAddress) return false;

  try {
    await apiPost('/api/set-key', { privateKey, accountAddress });
    return true;
  } catch (e) {
    console.warn('restoreBackendSession failed:', e);
    return false;
  }
}

function kickOffPostConnectSync(currentCoin) {
  if (!getAccountStreamSocket()) {
    connectAccountStream();
  }

  fetchAccount(true)
    .catch((e) => {
      console.warn('post-connect fetchAccount failed:', e);
    })
    .finally(() => {
      Promise.resolve(ensureMaxLeverageDefault(currentCoin)).catch((e) => {
        console.warn('post-connect leverage sync failed:', e);
      });
      fetchRecentFills().catch(() => {});
    });

  Promise.resolve(refreshExchangeInfo(currentCoin, { includeActiveAssetData: false })).catch(() => {
    Promise.resolve(fetchExchangeLeverage(currentCoin, { applyUi: false })).catch(() => {});
  });

  scheduleRender();
}

async function deriveAndSaveAddress(pk, accountAddress = '') {
  try {
    const normalizedAccountAddress = normalizeAccountAddress(accountAddress);

    // First, cache the key on the backend to trigger user WebSocket
    let addressKey = pk;
    if (pk && pk !== '__AUTO__' && pk.length >= 64) {
      await apiPost('/api/set-key', { privateKey: pk, accountAddress: normalizedAccountAddress });
      addressKey = '__AUTO__';
    }

    const d = await apiPost('/api/key-address', { privateKey: addressKey });
    if (d.address) {
      const tradingAddress = normalizedAccountAddress || d.address;
      // The backend owns the signing key from this point forward. Keep only a
      // non-secret session marker in browser state; all trading requests use
      // the managed-key sentinel and the raw key is no longer globally
      // reachable after this function returns.
      setLegacy('privateKey', '__AUTO__');
      setLegacy('signerAddress', d.address);
      setLegacy('walletAddress', tradingAddress);
      try {
        if (normalizedAccountAddress) localStorage.setItem(ACCOUNT_ADDRESS_STORAGE_KEY, normalizedAccountAddress);
        else localStorage.removeItem(ACCOUNT_ADDRESS_STORAGE_KEY);
      } catch {}

      const maxLev = getMaxLeverage(AppState.trading.currentCoin);
      showConnectedWallet({
        walletLabel: truncAddr(tradingAddress),
        leverage: maxLev,
      });

      showToast('Connected — ' + truncAddr(tradingAddress), false);

      kickOffPostConnectSync(AppState.trading.currentCoin);

      return true;
    }
    return false;
  } catch(e) {
    console.error('Connect error:', e);
    return false;
  }
}

function clearKey() {
  disconnectAccountStream();
  disablePollingFallback();
  apiPost('/api/clear-key', {}).catch(() => {});
  setLegacy('privateKey', '');
  setLegacy('signerAddress', '');
  setLegacy('walletAddress', '');
  try { localStorage.removeItem(ACCOUNT_ADDRESS_STORAGE_KEY); } catch {}
  showDisconnectedWallet();
  setLegacy('accountState', null);
  setLegacy('openOrders', []);
  resetOrderState();
  clearRecentFills();
  setTwapStatePayload({});
  setLastTwapId(null);
  clearAllPreview();
  setUserEditedPrice(false);

  scheduleRender();
  renderPositions();
  renderOpenOrders();
}

function handleWalletBtnClick() {
  const addr = AppState.account.walletAddress;
  const openConnectModal = getConnectModalOpener();

  if (addr) {
    if (!walletBtnClickedOnce) {
      clearKey();
      showDisconnectedWallet({ hideLeverage: true });
      setWalletButtonLabel('DISCONNECTED');
      walletBtnClickedOnce = true;
      setTimeout(() => {
        walletBtnClickedOnce = false;
        setWalletButtonLabel('—');
      }, 3000);
    } else {
      openConnectModal?.();
      walletBtnClickedOnce = false;
    }
  } else {
    openConnectModal?.();
  }
}

async function autoLogin() {
  try {
    const d = await apiGet('/api/has-saved-key');
    if (d.hasSavedKey || d.hasKey) {
      const addrD = await apiPost('/api/key-address', { privateKey: '__AUTO__' });
      if (addrD.address) {
        let storedAccountAddress = '';
        try { storedAccountAddress = normalizeAccountAddress(localStorage.getItem(ACCOUNT_ADDRESS_STORAGE_KEY) || ''); } catch {}
        const tradingAddress = storedAccountAddress || addrD.address;

        try {
          await apiPost('/api/set-key', { privateKey: '__AUTO__', accountAddress: tradingAddress });
        } catch(e) {
          console.warn('set-key auto-login failed (non-critical):', e);
        }

        setLegacy('privateKey', '__AUTO__');
        setLegacy('signerAddress', addrD.address);
        setLegacy('walletAddress', tradingAddress);

        const maxLev = getMaxLeverage(AppState.trading.currentCoin);
        showConnectedWallet({
          walletLabel: truncAddr(tradingAddress) + ' (Auto)',
          leverage: maxLev,
        });

        showToast('Auto-connected: ' + truncAddr(tradingAddress), false);

        kickOffPostConnectSync(AppState.trading.currentCoin);

        return true;
      }
    }
  } catch (e) {
    console.error('Auto-login error:', e);
  }
  return false;
}

export {
  requireKey,
  getApiKey,
  restoreBackendSession,
  deriveAndSaveAddress,
  clearKey,
  handleWalletBtnClick,
  autoLogin,
  truncAddr,
  normalizeAccountAddress
};
