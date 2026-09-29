// PEZ$ Bot UI Bridge - backend-owned runtime controller.
//
// Ported from the legacy classic-script web/bot.js to an ES module. Canonical
// state is now read via imports (AppState, selectors, api, account-stream)
// instead of window.* mirrors. Outward functions are still published on window
// for HTML data-action / tests; Stage 3 Slice B also injects them into
// strategy-host so production resolution does not depend on window names.

import { AppState } from '../state/store.js';
import { getApiKey, getExchangeLeverage } from '../state/account-selectors.js';
import { resolveApiUrl, getApiToken } from './api.js';
import { getAccountStreamSocket } from '../streams/account-stream.js';

let botStatusPollInterval = null;
let lastBotStatusAt = 0;

let BOT = {
  running: false,
  strategy: null,
  coin: null,
  config: { ordersPerSide: 8, orderSize: 15, bidSkew: 1.0, askSkew: 1.0, bulkMode: false },
  lastLogSeq: 0
};

function initBotUI() {
  // Preserve the legacy `window.BOT = window.BOT || {...}` semantics: adopt an
  // existing runtime object if one was already published, otherwise publish ours.
  if (window.BOT) {
    BOT = window.BOT;
  } else {
    window.BOT = BOT;
  }

  window.botToggle = botToggle;
  window.botStart = botStart;
  window.botStop = botStop;
  window.refreshBotStatus = refreshBotStatus;
  window.botLog = botLog;
  window.botUpdateUI = botUpdateUI;
  window.applyBotStatus = applyBotStatus;
  window.onAccountStreamConnectionStateChange = onAccountStreamConnectionStateChange;
  window.botGetConfig = function() { return BOT.config; };
  window.updateBotConfigFromInputs = updateBotConfigFromInputs;
  window.onBidSkewChange = onBidSkewChange;
  window.onAskSkewChange = onAskSkewChange;
  window.onBulkBidSkewChange = onBulkBidSkewChange;
  window.onBulkAskSkewChange = onBulkAskSkewChange;
  window.updateTotals = updateTotals;
  window.updateSkewDisplay = updateSkewDisplay;
  window.updateBulkSkewDisplay = updateBulkSkewDisplay;
  window.setBotMode = setBotMode;
  window.loadBotStrategy = loadBotStrategy;

  updateBotConfigFromInputs();
  updateSkewDisplay();
  updateTotals();
  initBotMode();
  botUpdateUI();
  const streaming = !!getAccountStreamSocket();
  updateBotLinkStatus(streaming ? 'streaming' : 'fallback');
  if (!streaming && getApiKey()) {
    ensureBotStatusPolling();
    updateBotLinkStatus('polling');
  }
  refreshBotStatus();
  botLog('Bot controller ready', 'success');
}

async function apiRequest(url, options) {
  options = options || {};
  var token = getApiToken();
  if (token) {
    options.headers = Object.assign({}, options.headers, { Authorization: 'Bearer ' + token });
  }
  var response = await fetch(resolveApiUrl(url), options);
  var text = await response.text();
  var data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }
  if (!response.ok) {
    var message = (data && (data.error || data.message)) || text || ('HTTP ' + response.status);
    throw new Error(message);
  }
  return data;
}

function getActiveLeverageForBot(coin) {
  var leverage = getExchangeLeverage(coin);
  if (Number.isFinite(leverage) && leverage > 0) return leverage;
  return 1;
}

function getAvailableMarginForBot() {
  var accountState = AppState.account.state || {};
  var risk = accountState.riskSummary || {};
  var ms = accountState.marginSummary || {};
  var cms = accountState.crossMarginSummary || {};

  var available = 0;
  if (risk.availableMargin !== undefined && risk.availableMargin !== null) {
    available = parseFloat(risk.availableMargin);
  } else if (risk.withdrawable !== undefined && risk.withdrawable !== null) {
    available = parseFloat(risk.withdrawable);
  } else if (accountState.withdrawable !== undefined && accountState.withdrawable !== null) {
    available = parseFloat(accountState.withdrawable);
  } else if (cms.accountValue !== undefined && cms.totalMarginUsed !== undefined) {
    available = Math.max(0, parseFloat(cms.accountValue || 0) - parseFloat(cms.totalMarginUsed || 0));
  } else if (ms.accountValue !== undefined && ms.totalMarginUsed !== undefined) {
    available = Math.max(0, parseFloat(ms.accountValue || 0) - parseFloat(ms.totalMarginUsed || 0));
  }

  if (!Number.isFinite(available) || available < 0) return 0;
  return available;
}

async function loadBotStrategy(name) {
  BOT.strategy = name;

  var strategyDefaults = {
    'rvwap-short-bollinger': { ordersPerSide: 16, orderSize: 15, bidSkew: 4, askSkew: 4 },
    'rvwap-bollinger': { ordersPerSide: 16, orderSize: 15, bidSkew: 4, askSkew: 4 },
    'jev-orderflow': { ordersPerSide: 12, orderSize: 15, bidSkew: 1.0, askSkew: 1.0 }
  };

  var defaults = strategyDefaults[name] || strategyDefaults['rvwap-short-bollinger'];

  var numOrdersEl = document.getElementById('botNumOrders');
  var orderSizeEl = document.getElementById('botOrderSize');
  var bidSkewEl = document.getElementById('bidSkew');
  var askSkewEl = document.getElementById('askSkew');

  if (numOrdersEl) numOrdersEl.value = defaults.ordersPerSide;
  if (orderSizeEl) orderSizeEl.value = defaults.orderSize;
  if (bidSkewEl) bidSkewEl.value = defaults.bidSkew;
  if (askSkewEl) askSkewEl.value = defaults.askSkew;

  updateBotConfigFromInputs();
  updateSkewDisplay();
  updateTotals();
  botLog('Strategy: ' + name, 'info');
}

function updateBotConfigFromInputs() {
  var bulkRadio = document.querySelector('input[name="botMode"]:checked');
  var bulkMode = bulkRadio ? bulkRadio.value === 'bulk' : false;
  BOT.config.bulkMode = bulkMode;

  if (bulkMode) {
    var bulkOrders = document.getElementById('bulkOrders');
    var bulkSize = document.getElementById('bulkSize');
    var bulkBidSkew = document.getElementById('bulkBidSkew');
    var bulkAskSkew = document.getElementById('bulkAskSkew');
    BOT.config.ordersPerSide = bulkOrders ? parseInt(bulkOrders.value, 10) || 16 : 16;
    BOT.config.orderSize = bulkSize ? parseFloat(bulkSize.value) || 62.5 : 62.5;
    BOT.config.bidSkew = bulkBidSkew ? parseFloat(bulkBidSkew.value) || 1.0 : 1.0;
    BOT.config.askSkew = bulkAskSkew ? parseFloat(bulkAskSkew.value) || 1.0 : 1.0;
  } else {
    var n = document.getElementById('botNumOrders');
    var s = document.getElementById('botOrderSize');
    var k = document.getElementById('bidSkew');
    var k2 = document.getElementById('askSkew');
    BOT.config.ordersPerSide = n ? parseInt(n.value, 10) || 16 : 16;
    BOT.config.orderSize = s ? parseFloat(s.value) || 15 : 15;
    BOT.config.bidSkew = k ? parseFloat(k.value) || 1.0 : 1.0;
    BOT.config.askSkew = k2 ? parseFloat(k2.value) || 1.0 : 1.0;
  }

  return BOT.config;
}

function syncSkewValue(value, sourceDisplayId, pairedInputId, pairedDisplayId) {
  var skew = parseFloat(value) || 1.0;
  var formatted = skew.toFixed(1);
  var sourceDisplay = document.getElementById(sourceDisplayId);
  if (sourceDisplay) sourceDisplay.textContent = formatted;
  var pairedInput = document.getElementById(pairedInputId);
  if (pairedInput) pairedInput.value = skew;
  var pairedDisplay = document.getElementById(pairedDisplayId);
  if (pairedDisplay) pairedDisplay.textContent = formatted;
  updateBotConfigFromInputs();
}

function onBidSkewChange(value) {
  syncSkewValue(value, 'bidSkewValue', 'bulkBidSkew', 'bulkBidSkewValue');
}

function onAskSkewChange(value) {
  syncSkewValue(value, 'askSkewValue', 'bulkAskSkew', 'bulkAskSkewValue');
}

function onBulkBidSkewChange(value) {
  syncSkewValue(value, 'bulkBidSkewValue', 'bidSkew', 'bidSkewValue');
}

function onBulkAskSkewChange(value) {
  syncSkewValue(value, 'bulkAskSkewValue', 'askSkew', 'askSkewValue');
}

function updateTotals() {
  var numOrders = parseInt(document.getElementById('botNumOrders') && document.getElementById('botNumOrders').value, 10) || 16;
  var orderSize = parseFloat(document.getElementById('botOrderSize') && document.getElementById('botOrderSize').value) || 15;
  var seqTotal = document.getElementById('seqTotal');
  if (seqTotal) {
    seqTotal.textContent = '$' + (numOrders * 2 * orderSize).toFixed(0);
  }

  var bulkOrders = parseInt(document.getElementById('bulkOrders') && document.getElementById('bulkOrders').value, 10) || 16;
  var bulkSize = parseFloat(document.getElementById('bulkSize') && document.getElementById('bulkSize').value) || 62.5;
  var bulkTotalDisplay = document.getElementById('bulkTotalDisplay');
  if (bulkTotalDisplay) {
    bulkTotalDisplay.textContent = '$' + (bulkOrders * 2 * bulkSize).toFixed(0);
  }
}

function updateSkewDisplay() {
  var bidSkewEl = document.getElementById('bidSkew');
  var askSkewEl = document.getElementById('askSkew');
  var bidSkew = bidSkewEl ? parseFloat(bidSkewEl.value) : 1.0;
  var askSkew = askSkewEl ? parseFloat(askSkewEl.value) : 1.0;

  var bidValueEl = document.getElementById('bidSkewValue');
  var askValueEl = document.getElementById('askSkewValue');
  if (bidValueEl) bidValueEl.textContent = bidSkew.toFixed(1);
  if (askValueEl) askValueEl.textContent = askSkew.toFixed(1);

  var bulkBidSkewEl = document.getElementById('bulkBidSkew');
  var bulkAskSkewEl = document.getElementById('bulkAskSkew');
  if (bulkBidSkewEl) bulkBidSkewEl.value = bidSkew;
  if (bulkAskSkewEl) bulkAskSkewEl.value = askSkew;

  var bulkBidValueEl = document.getElementById('bulkBidSkewValue');
  var bulkAskValueEl = document.getElementById('bulkAskSkewValue');
  if (bulkBidValueEl) bulkBidValueEl.textContent = bidSkew.toFixed(1);
  if (bulkAskValueEl) bulkAskValueEl.textContent = askSkew.toFixed(1);

  updateBotConfigFromInputs();
}

function updateBulkSkewDisplay() {
  var bulkBidSkewEl = document.getElementById('bulkBidSkew');
  var bulkAskSkewEl = document.getElementById('bulkAskSkew');
  var bulkBidSkew = bulkBidSkewEl ? parseFloat(bulkBidSkewEl.value) : 1.0;
  var bulkAskSkew = bulkAskSkewEl ? parseFloat(bulkAskSkewEl.value) : 1.0;

  var bulkBidValueEl = document.getElementById('bulkBidSkewValue');
  var bulkAskValueEl = document.getElementById('bulkAskSkewValue');
  if (bulkBidValueEl) bulkBidValueEl.textContent = bulkBidSkew.toFixed(1);
  if (bulkAskValueEl) bulkAskValueEl.textContent = bulkAskSkew.toFixed(1);

  var seqBidSkewEl = document.getElementById('bidSkew');
  var seqAskSkewEl = document.getElementById('askSkew');
  if (seqBidSkewEl) seqBidSkewEl.value = bulkBidSkew;
  if (seqAskSkewEl) seqAskSkewEl.value = bulkAskSkew;

  var seqBidValueEl = document.getElementById('bidSkewValue');
  var seqAskValueEl = document.getElementById('askSkewValue');
  if (seqBidValueEl) seqBidValueEl.textContent = bulkBidSkew.toFixed(1);
  if (seqAskValueEl) seqAskValueEl.textContent = bulkAskSkew.toFixed(1);

  updateBotConfigFromInputs();
}

function setBotMode(mode) {
  var bulkMode = mode === 'bulk';
  var seqSection = document.getElementById('seqSection');
  var bulkSection = document.getElementById('bulkSection');
  var modeSeq = document.getElementById('modeSeq');
  var modeBulk = document.getElementById('modeBulk');

  var bidSkew = parseFloat(document.getElementById('bidSkew') && document.getElementById('bidSkew').value) || 1.0;
  var askSkew = parseFloat(document.getElementById('askSkew') && document.getElementById('askSkew').value) || 1.0;

  if (bulkMode) {
    if (seqSection) seqSection.style.display = 'none';
    if (bulkSection) bulkSection.style.display = 'block';
    if (modeSeq) { modeSeq.style.background = 'var(--bg2)'; modeSeq.style.color = 'var(--text2)'; }
    if (modeBulk) { modeBulk.style.background = 'var(--green)'; modeBulk.style.color = '#000'; }

    var bulkBidSkew = document.getElementById('bulkBidSkew');
    var bulkAskSkew = document.getElementById('bulkAskSkew');
    if (bulkBidSkew) {
      bulkBidSkew.value = bidSkew;
      var bulkBidValue = document.getElementById('bulkBidSkewValue');
      if (bulkBidValue) bulkBidValue.textContent = bidSkew.toFixed(1);
    }
    if (bulkAskSkew) {
      bulkAskSkew.value = askSkew;
      var bulkAskValue = document.getElementById('bulkAskSkewValue');
      if (bulkAskValue) bulkAskValue.textContent = askSkew.toFixed(1);
    }
  } else {
    if (seqSection) seqSection.style.display = 'block';
    if (bulkSection) bulkSection.style.display = 'none';
    if (modeBulk) { modeBulk.style.background = 'var(--bg2)'; modeBulk.style.color = 'var(--text2)'; }
    if (modeSeq) { modeSeq.style.background = 'var(--green)'; modeSeq.style.color = '#000'; }

    var seqBidSkew = document.getElementById('bidSkew');
    var seqAskSkew = document.getElementById('askSkew');
    if (seqBidSkew) {
      seqBidSkew.value = bidSkew;
      var seqBidValue = document.getElementById('bidSkewValue');
      if (seqBidValue) seqBidValue.textContent = bidSkew.toFixed(1);
    }
    if (seqAskSkew) {
      seqAskSkew.value = askSkew;
      var seqAskValue = document.getElementById('askSkewValue');
      if (seqAskValue) seqAskValue.textContent = askSkew.toFixed(1);
    }
  }

  var radios = document.querySelectorAll('input[name="botMode"]');
  radios.forEach(function(r) {
    r.checked = r.value === mode;
  });

  updateBotConfigFromInputs();
  updateTotals();
  localStorage.setItem('botMode', mode);
}

function initBotMode() {
  var savedMode = localStorage.getItem('botMode') || 'sequential';
  setBotMode(savedMode);
}

function botLog(message, type) {
  type = type || 'info';
  var colors = { info: '#0f0', success: '#0f0', error: '#f55', warning: '#ff0' };
  var prefixes = { info: '>', success: '✓', error: '✗', warning: '!' };
  var el = document.getElementById('botLogConsole');
  if (!el) return;
  var row = document.createElement('div');
  row.style.color = colors[type] || colors.info;
  row.textContent = (prefixes[type] || '>') + ' ' + message;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

function applyBotStatus(status) {
  status = status || {};
  lastBotStatusAt = Date.now();
  BOT.running = !!status.running;
  BOT.strategy = status.strategy || BOT.strategy;
  BOT.coin = status.coin || BOT.coin;
  if (status.config) {
    BOT.config = Object.assign({}, BOT.config, status.config);
  }
  if (Array.isArray(status.logs)) {
    status.logs.forEach(function(entry) {
      if (!entry || entry.seq <= BOT.lastLogSeq) return;
      BOT.lastLogSeq = entry.seq;
      botLog(entry.message, entry.type || 'info');
    });
  }
  botUpdateUI(status);
}

async function refreshBotStatus() {
  try {
    var status = await apiRequest('/api/bot/status');
    applyBotStatus(status);
  } catch (e) {
    if (BOT.running) {
      botLog('Bot status sync failed: ' + e.message, 'warning');
    }
  }
}

function ensureBotStatusPolling() {
  if (botStatusPollInterval) return;
  if (!getApiKey()) return;
  botStatusPollInterval = setInterval(refreshBotStatus, 3000);
  updateBotLinkStatus('polling');
}

function disableBotStatusPolling() {
  if (botStatusPollInterval) {
    clearInterval(botStatusPollInterval);
    botStatusPollInterval = null;
  }
}

function onAccountStreamConnectionStateChange(state) {
  if (state === 'connected') {
    disableBotStatusPolling();
    updateBotLinkStatus('streaming');
    return;
  }

  if (state === 'connecting' || state === 'reconnecting') {
    ensureBotStatusPolling();
    updateBotLinkStatus('reconnecting');
    return;
  }

  if (state === 'polling' || state === 'disconnected') {
    ensureBotStatusPolling();
    updateBotLinkStatus('polling');
  }
}

function updateBotLinkStatus(mode) {
  var el = document.getElementById('botLinkStatus');
  if (!el) return;
  var text = 'checking';
  var color = 'var(--text2)';
  if (mode === 'streaming') {
    text = 'live stream';
    color = 'var(--green)';
  } else if (mode === 'polling') {
    text = 'polling fallback';
    color = '#ffcc66';
  } else if (mode === 'reconnecting') {
    text = 'reconnecting';
    color = '#ffcc66';
  } else if (mode === 'fallback') {
    text = 'fallback ready';
    color = '#ffcc66';
  }
  el.textContent = text;
  el.style.color = color;
}

function botToggle() {
  if (BOT.running) return botStop();
  return botStart();
}

async function botStart() {
  if (BOT.running) {
    botLog('Already running', 'warning');
    return;
  }

  if (!AppState.trading.currentPrice || !getApiKey()) {
    botLog('No price or API key', 'error');
    return;
  }

  updateBotConfigFromInputs();

  var activeLeverage = getActiveLeverageForBot(AppState.trading.currentCoin);
  var availableMargin = getAvailableMarginForBot();
  var requestedNotional = (BOT.config.ordersPerSide || 0) * 2 * (BOT.config.orderSize || 0);
  var estimatedMaxNotional = availableMargin * activeLeverage * 0.95;

  if (!availableMargin || availableMargin <= 0) {
    botLog('No available margin', 'error');
    return;
  }

  if (requestedNotional > estimatedMaxNotional) {
    botLog('Requested $' + requestedNotional.toFixed(0) + ' exceeds max $' + estimatedMaxNotional.toFixed(0), 'error');
    return;
  }

  var selectedStrategy = (document.getElementById('botStrategy') || {}).value || BOT.strategy || 'rvwap-short-bollinger';
  BOT.strategy = selectedStrategy;
  BOT.coin = AppState.trading.currentCoin;

  botLog('Starting backend bot on ' + BOT.coin, 'info');

  try {
    var status = await apiRequest('/api/bot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategy: selectedStrategy,
        coin: BOT.coin,
        config: BOT.config
      })
    });
    applyBotStatus(status);
    disableBotStatusPolling();
  } catch (e) {
    botLog('Failed to start: ' + e.message, 'error');
    BOT.running = false;
    botUpdateUI();
    return;
  }

  refreshBotStatus();
}

async function botStop() {
  try {
    await apiRequest('/api/bot/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    botLog('Bot stopped', 'info');
  } catch (e) {
    botLog('Failed to stop: ' + e.message, 'error');
  }

  BOT.running = false;
  botUpdateUI();
  refreshBotStatus();
}

function botUpdateUI(status) {
  var btn = document.getElementById('botToggleBtn');
  if (btn) {
    btn.textContent = BOT.running ? 'STOP' : 'START';
    btn.style.background = BOT.running ? 'var(--red2)' : 'var(--green)';
  }

  var ordEl = document.getElementById('botOrdersDisplay');
  if (ordEl) {
    var orderCount = status && Array.isArray(status.orderIds) ? status.orderIds.length : 0;
    ordEl.textContent = orderCount + ' live';
  }

  var runtimeEl = document.getElementById('botRuntimeStatus');
  if (runtimeEl) {
    var stale = BOT.running && lastBotStatusAt && (Date.now() - lastBotStatusAt > 45000);
    runtimeEl.textContent = BOT.running ? (stale ? 'running (stale ui)' : 'running on server') : 'idle';
    runtimeEl.style.color = BOT.running ? (stale ? '#ffcc66' : 'var(--green)') : 'var(--text2)';
  }
}

function getBotRuntime() {
  return BOT;
}

export {
  initBotUI,
  getBotRuntime,
  refreshBotStatus,
  applyBotStatus,
  loadBotStrategy,
  updateTotals,
  updateBotConfigFromInputs,
  onAccountStreamConnectionStateChange,
  botLog,
};
