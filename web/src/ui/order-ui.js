/**
 * Order UI - Order modification, cancellation, and margin UI helpers
 * Extracted from main.js
 */

import { showToast } from './toast.js';
import { apiPost } from '../services/api.js';
import { notifySuccess } from '../services/action-feedback.js';
import { modifyLimitPrice } from '../services/order-modify.js';
import { buildCancelsFromOrders, bulkCancelOrders } from '../services/order-cancel.js';
import { requireKey } from '../services/wallet-service.js';
import { getManagedExchangePrivateKey } from '../services/exchange-auth.js';

function showError(error) {
  showToast('Error: ' + (error?.message || 'Unknown error'), true);
}

async function postWithManagedKey(path, body = {}) {
  return apiPost(path, {
    privateKey: getManagedExchangePrivateKey(),
    ...body,
    mainnet: true,
  });
}

function setButtonBusy(button, { text, disabled }) {
  if (!button) return;
  button.textContent = text;
  button.disabled = disabled;
}

export async function showModifyModal(oid, coin, isBuy, sz, px, reduceOnly = false) {
  const newPx = prompt('New price:', px);
  if (!newPx || isNaN(parseFloat(newPx))) return;

  const newSz = prompt('New size:', sz);
  if (!newSz || isNaN(parseFloat(newSz))) return;

  try {
    await modifyLimitPrice({
      oid,
      coin,
      isBuy,
      sz: parseFloat(newSz),
      limitPx: parseFloat(newPx),
      reduceOnly: reduceOnly === true,
    });
  } catch(e) {
    showError(e);
  }
}

export async function bulkCancelSelected(btnEl = null) {
  if (!requireKey()) return;

  const selected = document.querySelectorAll('.order-select:checked');
  if (!selected.length) {
    showToast('No orders selected', true);
    return;
  }

  const cancels = Array.from(selected).map(cb => ({
    coin: cb.dataset.coin,
    oid: parseInt(cb.dataset.oid)
  }));

  const btn = btnEl || document.activeElement;
  setButtonBusy(btn, { text: 'Canceling...', disabled: true });

  try {
    const d = await bulkCancelOrders({
      privateKey: getManagedExchangePrivateKey(),
      cancels,
      mainnet: true,
    });
    if (d.status === 'ok') {
      notifySuccess(`✓ ${cancels.length} orders cancelled`, { refreshAccount: true, refreshChart: true });
    } else if (d.status === 'partial') {
      showToast(`Partial cancel: ${d.cancelled}/${cancels.length} cancelled — ${d.error || 'some orders were not cancelled'}`, true);
    } else {
      showToast('Cancel failed: ' + (d.error || 'Unknown'), true);
    }
  } catch(e) {
    showError(e);
  } finally {
    setButtonBusy(btn, { text: 'Cancel Selected', disabled: false });
  }
}

export async function scheduleCancelUI() {
  if (!requireKey()) return;
  
  const confirmMsg = 'This will cancel ALL open orders after the specified time.\n\nEnter time in milliseconds from now (e.g., 60000 for 1 minute).\n\nLeave empty to CANCEL any existing scheduled cancel.';
  const timeInput = prompt(confirmMsg, '300000');

  let time = null;
  if (timeInput && timeInput.trim() !== '') {
    const ms = parseInt(timeInput);
    if (isNaN(ms) || ms < 0) {
      showToast('Error: Invalid time value', true);
      return;
    }
    const now = Date.now();
    time = now + ms;
  }

  try {
    const d = await postWithManagedKey('/api/schedule-cancel', { time });
    if (d.status === 'ok') {
      if (time === null) {
        showToast('✓ Scheduled cancel cancelled', false);
      } else {
        showToast(`✓ Orders will cancel at ${new Date(time).toLocaleTimeString()}`, false);
      }
    } else {
      showToast('Schedule cancel failed: ' + (d.error || 'Unknown error'), true);
    }
  } catch(e) {
    showError(e);
  }
}

export function hideConfirmModal(confirmed) {
  const modal = document.getElementById('confirmModal');
  if (modal) modal.classList.remove('show');
}
