import { getRecentFills, setRecentFills } from '../state/account-state.js';
import { getWalletAddress } from '../state/account-selectors.js';
import { renderFills } from '../render/fills.js';
import { apiPost, isTransientApiError, sleep } from './api.js';

const FILLS_RETRY_DELAYS_MS = [250, 700];

let fillsFetchPending = null;

function isDeadlineError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.rawMessage || error?.message || '');
  return status === 504 || /deadline exceeded|context deadline|timed? ?out/i.test(message);
}

export async function fetchRecentFills() {
  const address = getWalletAddress();
  if (!address) return [];
  if (fillsFetchPending) return fillsFetchPending;

  fillsFetchPending = (async () => {
    try {
      let response = null;
      let lastError = null;
      for (let attempt = 0; attempt <= FILLS_RETRY_DELAYS_MS.length; attempt++) {
        try {
          response = await apiPost('/api/fills', { address, mainnet: true });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (
            attempt >= FILLS_RETRY_DELAYS_MS.length
            || isDeadlineError(error)
            || !isTransientApiError(error)
          ) {
            throw error;
          }
          await sleep(FILLS_RETRY_DELAYS_MS[attempt]);
        }
      }
      if (lastError) throw lastError;
      const fills = Array.isArray(response) ? response : (response?.fills || []);
      setRecentFills(fills);
      if (document.querySelector('.bottom-tab.active')?.dataset.tab === 'fills') {
        renderFills();
      }
      return getRecentFills();
    } catch (e) {
      const message = String(e?.message || '');
      if (!isDeadlineError(e) && !/invalid JSON response/i.test(message)) {
        console.error('fetchRecentFills error:', e);
      }
      return getRecentFills();
    } finally {
      fillsFetchPending = null;
    }
  })();

  return fillsFetchPending;
}
