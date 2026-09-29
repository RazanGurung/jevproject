import { apiPost } from './api.js';
import { requireKey } from './wallet-service.js';
import { notifySuccess } from './action-feedback.js';
import { getWalletAddress } from '../state/account-selectors.js';
import { getCurrentCoin, getCurrentOrderType, getCurrentSide } from '../state/trading-selectors.js';
import { getTwapStatesSnapshot, getLastTwapId, removeTwapState, setLastTwapId, upsertPendingTwapState } from '../state/account-state.js';
import { showToast } from '../ui/toast.js';
import { getManagedExchangePrivateKey } from './exchange-auth.js';

function parseTwapTuple(tuple) {
  if (!Array.isArray(tuple) || tuple.length < 2) return null;
  const twapId = Number(tuple[0]);
  const state = tuple[1] || {};
  if (!Number.isFinite(twapId) || !state || typeof state !== 'object') return null;
  return { twapId, state };
}

function findTwapById(twapId) {
  const nextId = Number(twapId);
  if (!Number.isFinite(nextId) || nextId <= 0) return null;
  for (const tuple of getTwapStatesSnapshot()) {
    const parsed = parseTwapTuple(tuple);
    if (!parsed) continue;
    if (parsed.twapId === nextId) return parsed;
  }
  return null;
}

function setButtonState(button, { disabled, text }) {
  if (!button) return;
  button.disabled = disabled;
  button.textContent = text;
}

export function findActiveTwapForCoin(coin = getCurrentCoin()) {
  for (const tuple of getTwapStatesSnapshot()) {
    const parsed = parseTwapTuple(tuple);
    if (!parsed) continue;
    if (parsed.state.coin === coin) return parsed;
  }
  return null;
}

export function renderTwapStatus() {
  const panel = document.getElementById('twapStatusPanel');
  const statusEl = document.getElementById('twapStatusText');
  const cancelBtn = document.getElementById('cancelTwapBtn');
  if (!panel || !statusEl || !cancelBtn) return;

  panel.style.display = getCurrentOrderType() === 'twap' ? '' : 'none';

  const active = findActiveTwapForCoin();
  if (!active) {
    statusEl.textContent = 'No active TWAP for this coin';
    cancelBtn.style.display = 'none';
    cancelBtn.disabled = true;
    cancelBtn.removeAttribute('data-arg');
    return;
  }

  const { twapId, state } = active;
  if (state.pending) {
    statusEl.textContent = `#${twapId} ${String(state.side || '').toUpperCase()} ${state.coin} | TWAP accepted, waiting for live state...`;
    cancelBtn.style.display = '';
    cancelBtn.disabled = false;
    cancelBtn.dataset.arg = String(twapId);
    return;
  }

  const side = state.side || (state.isBuy ? 'buy' : 'sell');
  const executedSz = Number(state.executedSz || 0);
  const totalSz = Number(state.sz || 0);
  const executedNtl = Number(state.executedNtl || 0);
  const pct = totalSz > 0 ? (executedSz / totalSz) * 100 : 0;
  const started = Number(state.timestamp || 0);
  const startedLabel = started > 0 ? new Date(started).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

  statusEl.textContent = `#${twapId} ${String(side).toUpperCase()} ${state.coin} | ${executedSz.toFixed(4)}/${totalSz.toFixed(4)} filled (${pct.toFixed(1)}%) | $${executedNtl.toFixed(2)} executed | ${state.minutes || 0}m | ${state.randomize ? 'random' : 'fixed'} | start ${startedLabel}`;
  cancelBtn.style.display = '';
  cancelBtn.disabled = false;
  cancelBtn.dataset.arg = String(twapId);
}

export async function placeTwapOrder(sizeUsd) {
  const $ = id => document.getElementById(id);
  const requestCoin = getCurrentCoin();
  const requestSide = getCurrentSide();
  const requestIsBuy = requestSide === 'buy';
  const walletAddress = getWalletAddress();
  const minutes = parseInt($('twapMinutes')?.value) || 10;
  const randomize = $('twapRandomize')?.value === 'true';
  const reduceOnly = $('reduceOnlyCheck')?.checked;

  const btn = $('placeBtn');
  const origText = btn?.textContent || 'Place Order';
  setButtonState(btn, { disabled: true, text: 'Placing TWAP...' });
  const t0 = performance.now();

  try {
    const d = await apiPost('/api/twap-order', {
      privateKey: getManagedExchangePrivateKey(),
      coin: requestCoin,
      isBuy: requestIsBuy,
      sz: sizeUsd,
      limitPx: 0,
      minutes,
      randomize,
      reduceOnly,
      mainnet: true,
    });

    const ms = Math.round(performance.now() - t0);
    const twapResponse = d?.response || null;
    const twapStatus = twapResponse?.data?.status;
    const twapError = twapStatus?.error || d?.error || null;
    const twapId = twapStatus?.running?.twapId || null;

    if (d.status === 'ok' && !twapError) {
      if (twapId) setLastTwapId(twapId);
      if (twapResponse?.data?.status?.running) {
        upsertPendingTwapState(twapId, {
          coin: requestCoin,
          side: requestSide,
          pending: true,
          minutes,
          reduceOnly: !!reduceOnly,
          randomize,
          timestamp: Date.now(),
          user: walletAddress,
        });
      }
      renderTwapStatus();
      notifySuccess(twapId ? `✓ TWAP order ${twapId} placed — ${ms}ms` : `✓ TWAP order placed — ${ms}ms`, { refreshAccount: true });
      return true;
    } else {
      showToast(`TWAP failed: ${twapError || 'Unknown error'}`, true);
      return false;
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, true);
    return false;
  } finally {
    setButtonState(btn, { disabled: false, text: origText });
  }
}

export async function cancelActiveTwap(twapId) {
  if (!requireKey()) return;

  const explicitTwapId = Number(twapId);
  const active = explicitTwapId > 0
    ? (findTwapById(explicitTwapId) || { twapId: explicitTwapId, state: { coin: getCurrentCoin() } })
    : findActiveTwapForCoin();
  if (!active?.twapId) {
    showToast('No active TWAP for this coin', true);
    return;
  }

  const btn = document.getElementById('cancelTwapBtn');
  const origText = btn?.textContent || 'Cancel TWAP';
  setButtonState(btn, { disabled: true, text: 'Cancelling...' });

  try {
    const d = await apiPost('/api/twap-cancel', {
      privateKey: getManagedExchangePrivateKey(),
      coin: active.state?.coin || getCurrentCoin(),
      twapId: active.twapId,
      mainnet: true,
    });

    const status = d?.response?.data?.status;
    const err = typeof status === 'object' ? status?.error : d?.error;
    if (d?.status === 'ok' && !err) {
      removeTwapState(active.twapId);
      if (getLastTwapId() === active.twapId) setLastTwapId(null);
      renderTwapStatus();
      showToast(`✓ TWAP ${active.twapId} cancelled`, false);
    } else {
      showToast(`TWAP cancel failed: ${err || 'Unknown error'}`, true);
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, true);
  } finally {
    setButtonState(btn, { disabled: false, text: origText });
  }
}
