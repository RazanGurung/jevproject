/**
 * Wallet modal - modal-level wallet connect UX
 */

import { deriveAndSaveAddress } from '../services/wallet-service.js';
import { fetchRadarNews, startNewsPolling } from '../services/news-service.js';
import { scheduleRender } from '../render/scheduler.js';
import { showToast } from './toast.js';
import { scheduleSignalRadarRender } from './signal-radar.js';

function showConnectModal() {
  const $ = id => document.getElementById(id);
  const modal = $('connectModal');
  const input = $('pkInput');
  const error = $('modalError');
  
  if (modal) modal.style.display = 'flex';
  if (input) input.value = '';
  if (error) error.style.display = 'none';
  
  setTimeout(() => {
    if (input) input.focus();
  }, 100);
}

function hideConnectModal() {
  const $ = id => document.getElementById(id);
  const modal = $('connectModal');
  const input = $('pkInput');
  const error = $('modalError');
  
  if (modal) modal.style.display = 'none';
  if (input) input.value = '';
  if (error) error.style.display = 'none';
}

async function modalConnect() {
  const $ = id => document.getElementById(id);
  const btn = $('modalConnectBtn');
  const err = $('modalError');
  const input = $('pkInput');
  
  if (!input) return;
  
  const pk = input.value.trim();
  if (!pk) {
    if (err) {
      err.textContent = 'Error: Enter a private key';
      err.style.display = 'block';
    }
    return;
  }
  
  if (btn) {
    btn.textContent = 'Connecting...';
    btn.disabled = true;
  }
  
  try {
    startNewsPolling();
    await fetchRadarNews().catch(() => {});

    let connected = false;
    if (pk) {
      connected = await deriveAndSaveAddress(pk);
    }

    if (pk && !connected) {
      if (err) {
        err.textContent = 'Error: Invalid hex private key';
        err.style.display = 'block';
      }
      return;
    }

    hideConnectModal();
    scheduleRender();
    scheduleSignalRadarRender();
  } catch(e) {
    if (err) {
      err.textContent = 'Error: ' + e.message;
      err.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.textContent = 'Save / Connect';
      btn.disabled = false;
    }
  }
}

async function clearNewsConfigFromModal() {
  showToast('Google News feed is always on', false);
}

export {
  showConnectModal,
  hideConnectModal,
  modalConnect,
  clearNewsConfigFromModal
};
