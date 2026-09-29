// PEZ$ Jev System One Service
// Interfaces with backend TypeSafe Jev endpoints (/api/jev/*).
// Keeps the API key completely anonymous on the backend.

import { apiGet, apiPost } from './api.js';
import { AppState, setActiveJevSignal } from '../state/store.js';
import { syncJevSignalLines } from '../chart/lightweight-chart.js';
export const JevState = {
  available: false,
  model: '',
  analyzing: false,
  fetchingSignal: false,
  selectedTimeframe: 'intraday', // 'scalp' | 'intraday' | 'swing'
  lastResult: null,
  lastSignal: null,
  signalsByTf: {},
  error: null,
};

let statusChecked = false;

/**
 * Checks if the backend has TypeSafe Jev configured and active.
 */
export async function checkJevStatus() {
  try {
    const res = await apiGet('/api/jev/status');
    JevState.available = !!res?.available;
    JevState.model = res?.model || '';
    statusChecked = true;
    updateJevUI();
    return JevState;
  } catch (err) {
    JevState.available = false;
    JevState.error = err?.message || 'Status check failed';
    updateJevUI();
    return JevState;
  }
}

/**
 * Sets the active trade horizon timeframe ('scalp', 'intraday', or 'swing').
 */
export function setTimeframe(tf) {
  const cleanTf = (tf || 'intraday').toLowerCase();
  JevState.selectedTimeframe = cleanTf;
  updateTfTabs();

  const targetCoin = AppState.trading.currentCoin || 'BTC';
  const cached = JevState.signalsByTf[cleanTf];
  if (cached && cached.coin === targetCoin && Date.now() - (cached.timestamp || 0) < 15000) {
    JevState.lastSignal = cached;
    updateJevSignalUI(cached);
  } else {
    fetchJevSignal(targetCoin, cleanTf).catch(() => {});
  }
}

export function mapTimeframeToHorizon(timeframe) {
  const tf = String(timeframe || '').trim().toLowerCase();
  switch (tf) {
    case '1m':
    case '3m':
    case '5m':
    case '15m':
    case '30m':
    case 'scalp':
      return 'scalp';
    case '1d':
    case '3d':
    case '1w':
    case 'swing':
      return 'swing';
    default:
      return 'intraday';
  }
}

export function onChartTimeframeChanged(newTimeframe) {
  const horizon = mapTimeframeToHorizon(newTimeframe);
  JevState.selectedTimeframe = horizon;
  updateTfTabs();
  const targetCoin = AppState.trading.currentCoin || 'BTC';
  const cached = JevState.signalsByTf[horizon];
  if (cached && cached.coin === targetCoin && Date.now() - (cached.timestamp || 0) < 60000) {
    JevState.lastSignal = cached;
    setActiveJevSignal(cached);
    updateJevSignalUI(cached);
  } else if (JevState.available) {
    fetchJevSignal(targetCoin, horizon).catch(() => {});
  }
}

if (typeof window !== 'undefined') {
  window.onChartTimeframeChanged = onChartTimeframeChanged;
}

const TF_LABELS = {
  scalp: 'SCALP 15m',
  intraday: 'INTRADAY 4h',
  swing: 'SWING 1d+',
};

let toxicCountdownSec = 0;
let toxicCountdownInterval = null;

export function clearToxicCountdown() {
  if (toxicCountdownInterval) {
    clearInterval(toxicCountdownInterval);
    toxicCountdownInterval = null;
  }
  toxicCountdownSec = 0;
}

export function startToxicCountdown(seconds, targetCoin) {
  clearToxicCountdown();
  toxicCountdownSec = Math.max(1, seconds);
  toxicCountdownInterval = setInterval(() => {
    toxicCountdownSec--;
    const countdownEl = document.getElementById('jevToxicCountdownText');
    if (countdownEl) {
      if (toxicCountdownSec > 0) {
        countdownEl.textContent = `TOXIC SWEEP HALT: ${toxicCountdownSec}s (STABILIZING)`;
      } else {
        countdownEl.textContent = '✓ ORDERBOOK STABILIZED · SCANNING...';
      }
    }
    if (toxicCountdownSec <= 0) {
      clearToxicCountdown();
      fetchJevSignal(targetCoin, JevState.selectedTimeframe).catch(() => {});
    }
  }, 1000);
}

/**
 * Synchronizes active styling and edge indicator dots on timeframe tabs.
 */
function updateTfTabs() {
  const bar = document.getElementById('jevTfSelectorBar');
  if (!bar) return;
  const currentTf = JevState.selectedTimeframe || 'intraday';
  const targetCoin = AppState.trading.currentCoin || 'BTC';
  const buttons = bar.querySelectorAll('.jev-tf-btn');
  buttons.forEach((btn) => {
    const tf = btn.dataset.tf;
    if (tf === currentTf) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }

    const cachedSig = JevState.signalsByTf[tf];
    let edgeClass = 'edge-none';
    let edgeTitle = 'No signal cached';
    if (cachedSig && cachedSig.coin === targetCoin) {
      const act = (cachedSig.action || 'HOLD').toUpperCase();
      const conv = cachedSig.conviction || 0;
      if (cachedSig.isToxicHalted || (cachedSig.reason && cachedSig.reason.includes('Toxic flow'))) {
        edgeClass = 'edge-toxic';
        edgeTitle = 'Toxic flow tripwire active';
      } else if (act !== 'HOLD' && conv >= 0.70) {
        edgeClass = 'edge-strong';
        edgeTitle = `${act} (${Math.round(conv * 100)}% conviction)`;
      } else if (act !== 'HOLD' && conv >= 0.55) {
        edgeClass = 'edge-moderate';
        edgeTitle = `${act} (${Math.round(conv * 100)}% conviction)`;
      } else {
        edgeClass = 'edge-neutral';
        edgeTitle = 'HOLD / Neutral flow';
      }
    }

    const baseLabel = TF_LABELS[tf] || (tf ? tf.toUpperCase() : '');
    btn.innerHTML = `${baseLabel} <span class="jev-tf-edge-dot ${edgeClass}" title="${edgeTitle}"></span>`;
  });
}

/**
 * Requests Jev System One evaluation of the specified or active coin.
 */
export async function analyzeWithJev(coin) {
  const targetCoin = coin || AppState.trading.currentCoin || 'BTC';
  JevState.analyzing = true;
  JevState.error = null;
  updateJevUI();

  try {
    const result = await apiPost('/api/jev/analyze', { coin: targetCoin });
    JevState.lastResult = result;
    JevState.analyzing = false;
    updateJevUI();
    return result;
  } catch (err) {
    JevState.analyzing = false;
    JevState.error = err?.message || 'Analysis failed';
    updateJevUI();
    throw err;
  }
}

/**
 * Requests Jev System One actionable trade signal (BUY/SELL/HOLD, entry, TP, SL)
 * calibrated for the specified timeframe ('scalp', 'intraday', or 'swing').
 */
export async function fetchJevSignal(coin, timeframe) {
  const targetCoin = coin || AppState.trading.currentCoin || 'BTC';
  const tf = timeframe || JevState.selectedTimeframe || 'intraday';
  JevState.selectedTimeframe = tf;
  JevState.fetchingSignal = true;
  updateJevSignalUI();

  try {
    const signal = await apiGet(`/api/jev/signal?coin=${encodeURIComponent(targetCoin)}&timeframe=${encodeURIComponent(tf)}`);
    JevState.lastSignal = signal;
    JevState.signalsByTf[tf] = signal;
    if (signal && signal.coin === AppState.trading.currentCoin) {
      setActiveJevSignal(signal);
    }
    JevState.fetchingSignal = false;
    updateJevSignalUI(signal);
    return signal;
  } catch (err) {
    JevState.fetchingSignal = false;
    updateJevSignalUI();
    throw err;
  }
}

function formatSignalPrice(num) {
  if (!num || !Number.isFinite(num) || num <= 0) return '—';
  if (num >= 1000) return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  if (num >= 1) return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function formatCompactVPPrice(num) {
  if (!num || !Number.isFinite(num) || num <= 0) return '—';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 10000) return '$' + (num / 1000).toFixed(1) + 'K';
  if (num >= 1000) return '$' + (num / 1000).toFixed(2) + 'K';
  if (num >= 100) return '$' + num.toFixed(1);
  if (num >= 1) return '$' + num.toFixed(2);
  return '$' + num.toFixed(4);
}

/**
 * 1-Click execution of Jev Trade Signal onto the Order Ticket:
 * Sets Side (Buy/Sell), Mode (Manual), Limit Entry Price, Take Profit %, and Stop Loss %.
 */
export function executeJevSignal(signal) {
  const sig = signal || JevState.lastSignal;
  if (!sig || !sig.action || sig.action === 'HOLD') {
    return false;
  }

  // 1. Set Side
  const isBuy = sig.action.toUpperCase() === 'BUY';
  const targetBtnId = isBuy ? 'buyBtn' : 'sellBtn';
  const sideBtn = document.getElementById(targetBtnId);
  if (sideBtn && typeof sideBtn.click === 'function') {
    sideBtn.click();
  } else if (typeof window !== 'undefined' && typeof window.setSide === 'function') {
    window.setSide(isBuy ? 'buy' : 'sell');
  }

  // 2. Set Price Mode to Manual so auto-tracking does not overwrite entry price
  const priceModeSelect = document.getElementById('priceModeSelect');
  if (priceModeSelect) {
    priceModeSelect.value = 'manual';
    priceModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof window !== 'undefined' && typeof window.setLimitPriceEntryModeSelection === 'function') {
    window.setLimitPriceEntryModeSelection('manual');
  }

  // 3. Set Entry Price
  if (sig.entryPrice > 0) {
    const priceInput = document.getElementById('priceInput') || document.getElementById('price');
    if (priceInput) {
      priceInput.value = sig.entryPrice;
      priceInput.dispatchEvent(new Event('input', { bubbles: true }));
      priceInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // 4. Set Take Profit %
  if (sig.takeProfitPct > 0) {
    const tpInput = document.getElementById('tpPctInput');
    if (tpInput) {
      tpInput.value = sig.takeProfitPct;
      tpInput.dispatchEvent(new Event('input', { bubbles: true }));
      tpInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // 5. Set Stop Loss %
  if (sig.stopLossPct > 0) {
    const slInput = document.getElementById('slPctInput');
    if (slInput) {
      slInput.value = sig.stopLossPct;
      slInput.dispatchEvent(new Event('input', { bubbles: true }));
      slInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // 6. Recalculate summary / preview if available
  if (typeof window !== 'undefined' && typeof window.updateSummary === 'function') {
    window.updateSummary();
  }

  // 7. Visual Confirmation on the Execute Buttons
  const buttonsToFlash = [
    document.getElementById('jevTicketFillBtn'),
    document.getElementById('jevExecuteSignalBtn')
  ].filter(Boolean);

  buttonsToFlash.forEach((btn) => {
    const originalText = btn.textContent;
    btn.classList.add('prepared');
    btn.textContent = '✓ TICKET PREPARED (ENTRY, TP & SL)';
    setTimeout(() => {
      btn.classList.remove('prepared');
      btn.textContent = originalText;
    }, 2500);
  });

  return true;
}

/**
 * Updates DOM elements in the Jev Signal Window (3rd window in LIQS column)
 * and the 1-Click Fill Button in the Trade Window.
 */
export function updateJevSignalUI(signal) {
  const windowEl = document.getElementById('jevSignalWindow');
  const sectionEl = document.getElementById('jevSignalSection');
  const ticketFillBtn = document.getElementById('jevTicketFillBtn');
  const refreshBtn = document.getElementById('jevSignalRefreshBtn');

  if (refreshBtn) {
    refreshBtn.disabled = JevState.fetchingSignal;
  }

  updateTfTabs();

  if (!JevState.available) {
    if (sectionEl) sectionEl.classList.add('hidden');
    if (ticketFillBtn) ticketFillBtn.classList.add('hidden');
    return;
  }

  if (sectionEl) sectionEl.classList.remove('hidden');

  const sig = signal || JevState.lastSignal;
  const targetCoin = sig?.coin || AppState.trading.currentCoin || 'BTC';
  const currentTf = (sig?.timeframe || JevState.selectedTimeframe || 'intraday').toUpperCase();

  // 1. Update 3rd Window in LIQS + MISPRICE column
  if (windowEl) {
    if (!sig && JevState.fetchingSignal) {
      windowEl.innerHTML = `
        <div class="jev-window-empty">
          <span class="jev-spark-icon">⚡</span>
          <span>Analyzing ${targetCoin} [${currentTf}] orderbook & flow...</span>
        </div>
      `;
    } else if (!sig) {
      windowEl.innerHTML = `
        <div class="jev-window-empty">
          <span class="jev-spark-icon">⚡</span>
          <span>No active [${currentTf}] signal for ${targetCoin}</span>
          <button type="button" class="btn btn-sm jev-execute-signal-btn" id="jevScanNowBtn">SCAN NOW</button>
        </div>
      `;
      const scanBtn = windowEl.querySelector('#jevScanNowBtn');
      if (scanBtn) {
        scanBtn.addEventListener('click', () => fetchJevSignal(targetCoin, JevState.selectedTimeframe).catch(() => {}));
      }
    } else {
      const act = (sig.action || 'HOLD').toUpperCase();
      const convPct = Math.round((sig.conviction || 0) * 100);
      const toxicPct = Math.round((sig.toxicRisk || 0) * 100);
      const ofiVal = sig.bookImbalance || 0;
      const ofiSign = ofiVal > 0 ? '+' : '';
      const ofiClass = ofiVal > 0 ? 'text-green' : ofiVal < 0 ? 'text-red' : 'text-neutral';

      const isHold = act === 'HOLD';
      const isBuy = act === 'BUY';
      const isSell = act === 'SELL';
      const isHalted = Boolean(sig.isToxicHalted || (sig.reason && sig.reason.includes('Toxic flow')));
      const initialCountdown = sig.toxicHaltRemainingSeconds || 15;
      if (isHalted) {
        startToxicCountdown(initialCountdown, targetCoin);
      } else {
        clearToxicCountdown();
      }
      const rawSignalType = sig.signalType || 'trend';
      const rawMarketEnv = sig.marketEnvironment || 'range';
      const signalType = rawSignalType.toUpperCase().replace('_', '-');
      const marketEnv = rawMarketEnv.toUpperCase();

      const tpLabel = isBuy
        ? `TP (+${sig.takeProfitPct || 1.0}%)`
        : isSell
        ? `TP (-${sig.takeProfitPct || 1.0}%)`
        : `TP (${sig.takeProfitPct ? sig.takeProfitPct.toFixed(2) : '1.00'}% ATR)`;

      const slLabel = isBuy
        ? `SL (-${sig.stopLossPct || 0.5}%)`
        : isSell
        ? `SL (+${sig.stopLossPct || 0.5}%)`
        : `SL (${sig.stopLossPct ? sig.stopLossPct.toFixed(2) : '0.50'}% ATR)`;

      const hasVP = Boolean(sig.vah && sig.val && sig.vah > sig.val);
      const vpHoz = (sig.profileHorizon || (currentTf === 'swing' ? 'quarterly' : 'monthly')).toLowerCase();
      const vpHozLabel = vpHoz === 'quarterly' ? 'Quarterly' : 'Monthly';
      const vpHozDays = vpHoz === 'quarterly' ? '90D' : '30D';
      const twapDist = sig.distFromTwapPct !== undefined ? sig.distFromTwapPct : (sig.distFrom365dPct !== undefined ? sig.distFrom365dPct : 0);
      const twapSign = twapDist >= 0 ? '+' : '';
      const twapColorClass = twapDist >= 6.0 ? 'text-red' : (twapDist <= -6.0 ? 'text-green' : '');

      windowEl.innerHTML = `
        <div class="jev-window-card">
          <div class="jev-window-toprow">
            <div class="jev-window-coin-badge">
              <span class="jev-window-coin" id="jevSignalCoin">${sig.coin || targetCoin}</span>
              <span id="jevSignalAction" class="jev-signal-action ${act.toLowerCase()}">${act}</span>
              ${!isHold ? `<span id="jevSignalTypeBadge" class="jev-signal-type-badge ${rawSignalType.toLowerCase().replace('_', '-')}">${signalType}</span>` : ''}
              ${!isHold ? `<span id="jevMarketEnvBadge" class="jev-market-env-badge ${rawMarketEnv.toLowerCase()}">${marketEnv}</span>` : ''}
            </div>
            <span class="jev-window-conviction" id="jevSignalConv">Conv: <b>${convPct}%</b> (${sig.score?.toFixed(1) || '3.0'}/5)</span>
          </div>

          <div class="jev-window-duration-row">
            <span class="jev-duration-badge" id="jevSignalDuration">⏱ ${sig.estimatedDuration || '2h – 8h (Session Intraday)'}</span>
            <span class="jev-duration-horizon" id="jevSignalHorizon">${currentTf}</span>
          </div>

          ${hasVP ? `
          <div class="jev-window-vp-row" id="jevSignalVPRow">
            <span class="jev-vp-label" title="${vpHozLabel} (${vpHozDays}) Volume Profile Structure">${vpHozDays} VP:</span>
            <span title="Value Area Low: ${formatSignalPrice(sig.val)}">VAL <b>${formatCompactVPPrice(sig.val)}</b></span>
            <span class="jev-vp-sep">·</span>
            <span title="Point of Control: ${formatSignalPrice(sig.poc)}">POC <b>${formatCompactVPPrice(sig.poc)}</b></span>
            <span class="jev-vp-sep">·</span>
            <span title="Value Area High: ${formatSignalPrice(sig.vah)}">VAH <b>${formatCompactVPPrice(sig.vah)}</b></span>
            <span class="jev-vp-twap ${twapColorClass}" title="Distance from ${vpHozDays} TWAP">(${twapSign}${twapDist.toFixed(1)}% TWAP)</span>
          </div>` : ''}

          <div class="jev-window-metrics-grid">
            <div class="jev-metric-card">
              <span class="jev-metric-label">Mid Price</span>
              <span class="jev-metric-value" id="jevSignalMid">${formatSignalPrice(sig.midPrice)}</span>
            </div>
            <div class="jev-metric-card">
              <span class="jev-metric-label">Limit Entry</span>
              <span class="jev-metric-value" id="jevSignalEntry">${isHold ? '—' : formatSignalPrice(sig.entryPrice)}</span>
            </div>
            <div class="jev-metric-card">
              <span class="jev-metric-label">${tpLabel}</span>
              <span class="jev-metric-value ${isHold ? 'text-neutral' : 'text-green'}" id="jevSignalTP">${isHold ? '—' : formatSignalPrice(sig.takeProfitPrice)}</span>
            </div>
            <div class="jev-metric-card">
              <span class="jev-metric-label">${slLabel}</span>
              <span class="jev-metric-value ${isHold ? 'text-neutral' : 'text-red'}" id="jevSignalSL">${isHold ? '—' : formatSignalPrice(sig.stopLossPrice)}</span>
            </div>
          </div>

          <div class="jev-window-stats-row">
            <span title="Order Flow Imbalance">OFI: <b class="${ofiClass}">${ofiSign}${ofiVal.toFixed(2)}</b></span>
            <span title="Spread">Spread: <b>${sig.spreadBps?.toFixed(1) || '0.0'} bps</b></span>
            <span title="Risk to Reward">R:R: <b>${sig.riskRewardRatio?.toFixed(1) || '2.0'}:1</b></span>
            <span title="Toxic sweep risk">Toxic: <b class="${toxicPct > 40 ? 'text-red' : 'text-green'}">${toxicPct}%</b></span>
          </div>

          ${isHalted ? `
          <div class="jev-toxic-halt-pill" id="jevToxicHaltPill">
            <span class="jev-toxic-icon">⚠️</span>
            <span id="jevToxicCountdownText">TOXIC SWEEP HALT: ${initialCountdown}s (STABILIZING)</span>
          </div>` : ''}

          <div class="jev-window-reason-card" id="jevSignalReason">${sig.reason || 'Order flow analyzed.'}</div>
          <div class="jev-window-footer">
            <span class="jev-window-model" id="jevSignalModel">${sig.model || 'jev-1.13.0'}${sig.visibilityLevel ? ' · ' + sig.visibilityLevel.toUpperCase() : ''}${sig.cacheReused ? ' · CACHED' : ''}</span>
            <span class="jev-window-time">${new Date(sig.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          </div>
        </div>
      `;
    }
  }

  // 2. Update 1-Click Fill Button in the Trade Window (Order Ticket)
  if (ticketFillBtn) {
    ticketFillBtn.classList.remove('hidden');
    if (!sig) {
      ticketFillBtn.textContent = JevState.fetchingSignal ? `⚡ JEV: SCANNING ${currentTf}...` : '⚡ FILL JEV TICKET';
      ticketFillBtn.className = 'btn btn-sm jev-ticket-fill-btn hold';
      ticketFillBtn.disabled = true;
    } else {
      const act = (sig.action || 'HOLD').toUpperCase();
      const tfTag = currentTf;
      const typeTag = sig.signalType === 'counter_trend' ? 'COUNTER-TREND ' : '';
      if (act === 'BUY') {
        ticketFillBtn.textContent = `⚡ FILL JEV TICKET (${tfTag} ${typeTag}BUY @ ${formatSignalPrice(sig.entryPrice)})`;
        ticketFillBtn.className = 'btn btn-sm jev-ticket-fill-btn buy';
        ticketFillBtn.disabled = false;
      } else if (act === 'SELL') {
        ticketFillBtn.textContent = `⚡ FILL JEV TICKET (${tfTag} ${typeTag}SELL @ ${formatSignalPrice(sig.entryPrice)})`;
        ticketFillBtn.className = 'btn btn-sm jev-ticket-fill-btn sell';
        ticketFillBtn.disabled = false;
      } else {
        ticketFillBtn.textContent = `⚡ JEV: HOLD (${tfTag} NO EDGE)`;
        ticketFillBtn.className = 'btn btn-sm jev-ticket-fill-btn hold';
        ticketFillBtn.disabled = true;
      }
    }
  }

  // 3. Sync On-Chart Jev Bracket Projection Rays (gated by indicator toggle)
  try {
    const shouldShow = AppState.ui.jevSignalsVisible && sig && sig.coin === targetCoin;
    syncJevSignalLines(shouldShow ? sig : null);
  } catch {}
}

/**
 * Aligns the order ticket side and limit price with Jev's recommended decision.
 */
export function alignTicketWithJev(result) {
  const res = result || JevState.lastResult;
  if (!res) return false;

  // Align side
  if (res.direction === 'bullish') {
    const buyBtn = document.getElementById('buyBtn');
    if (buyBtn && typeof buyBtn.click === 'function') buyBtn.click();
  } else if (res.direction === 'bearish') {
    const sellBtn = document.getElementById('sellBtn');
    if (sellBtn && typeof sellBtn.click === 'function') sellBtn.click();
  }

  // Align price if limit price is available
  if (res.suggestedLimitPrice > 0) {
    const priceInput = document.getElementById('priceInput') || document.getElementById('price');
    if (priceInput) {
      priceInput.value = res.suggestedLimitPrice;
      priceInput.dispatchEvent(new Event('input', { bubbles: true }));
      priceInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  return true;
}

/**
 * Updates DOM elements associated with Jev AI Copilot.
 */
function updateJevUI() {
  const badge = document.getElementById('jevStatusBadge');
  const resultPanel = document.getElementById('jevResultPanel');
  const analyzeBtn = document.getElementById('jevAnalyzeBtn');

  if (badge) {
    if (!JevState.available) {
      badge.classList.add('hidden');
    } else {
      badge.classList.remove('hidden');
      badge.textContent = JevState.model ? `JEV (${JevState.model})` : 'JEV AI';
    }
  }

  if (analyzeBtn) {
    analyzeBtn.disabled = JevState.analyzing || !JevState.available;
    analyzeBtn.textContent = JevState.analyzing ? 'ANALYZING...' : 'JEV AUDIT';
  }

  if (resultPanel && JevState.lastResult) {
    const r = JevState.lastResult;
    const dirClass = r.direction === 'bullish' ? 'text-green' : r.direction === 'bearish' ? 'text-red' : 'text-neutral';
    const confPct = Math.round((r.directionConfidence || 0) * 100);
    const toxicPct = Math.round((r.toxicFlowRisk || 0) * 100);

    resultPanel.innerHTML = `
      <div class="jev-result-row">
        <span class="jev-badge ${dirClass}">${r.direction.toUpperCase()} (${confPct}%)</span>
        <span class="jev-score">Conviction: ${r.confidenceScore?.toFixed(1) || '3.0'}/5</span>
      </div>
      <div class="jev-result-details">
        <span>OFI: <b>${r.bookImbalance > 0 ? '+' : ''}${r.bookImbalance?.toFixed(2) || '0.00'}</b></span>
        <span>Spread: <b>${r.spreadBps?.toFixed(1) || '0.0'} bps</b></span>
        <span>Toxic Risk: <b class="${toxicPct > 50 ? 'text-red' : 'text-green'}">${toxicPct}%</b></span>
      </div>
      <button type="button" class="btn btn-sm jev-align-btn" id="jevAlignTicketBtn">ALIGN TICKET</button>
    `;

    const alignBtn = document.getElementById('jevAlignTicketBtn');
    if (alignBtn) {
      alignBtn.onclick = () => alignTicketWithJev(r);
    }
  }

  updateJevSignalUI(JevState.lastSignal);
}

/**
 * Initializes Jev Copilot UI bindings and triggers initial status check.
 */
export function initJevUI() {
  const analyzeBtn = document.getElementById('jevAnalyzeBtn');
  if (analyzeBtn && !analyzeBtn._jevBound) {
    analyzeBtn._jevBound = true;
    analyzeBtn.addEventListener('click', () => {
      analyzeWithJev().catch((err) => {
        console.error('Jev audit error:', err);
      });
    });
  }

  const refreshBtn = document.getElementById('jevSignalRefreshBtn');
  if (refreshBtn && !refreshBtn._jevBound) {
    refreshBtn._jevBound = true;
    refreshBtn.addEventListener('click', () => {
      fetchJevSignal().catch((err) => {
        console.error('Jev signal fetch failed:', err);
      });
    });
  }

  const execBtn = document.getElementById('jevExecuteSignalBtn');
  if (execBtn && !execBtn._jevBound) {
    execBtn._jevBound = true;
    execBtn.addEventListener('click', () => {
      executeJevSignal();
    });
  }

  const ticketFillBtn = document.getElementById('jevTicketFillBtn');
  if (ticketFillBtn && !ticketFillBtn._jevBound) {
    ticketFillBtn._jevBound = true;
    ticketFillBtn.addEventListener('click', () => {
      executeJevSignal();
    });
  }

  const tfBar = document.getElementById('jevTfSelectorBar');
  if (tfBar && !tfBar._jevBound) {
    tfBar._jevBound = true;
    tfBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.jev-tf-btn');
      if (btn && btn.dataset.tf) {
        setTimeframe(btn.dataset.tf);
      }
    });
  }

  checkJevStatus().then((st) => {
    if (st && st.available) {
      fetchJevSignal().catch(() => {});
    }
  });
}

/**
 * Evaluates market slippage and adverse flow risk before order dispatch.
 */
export async function auditPreTradeWithJev(coin, isBuy, sizeUsd) {
  return apiPost('/api/jev/pre-trade-audit', { coin, isBuy, sizeUsd });
}

/**
 * Classifies headline sentiment using Jev System One semantic engine.
 */
export async function classifyNewsWithJev(headline) {
  return apiPost('/api/jev/classify-news', { headline });
}

/**
 * Evaluates synthetic asset deviation for arbitrage vs informed repricing.
 */
export async function evaluateMispricingWithJev(coin, markPrice, referenceClose, deviationPct) {
  return apiPost('/api/jev/evaluate-mispricing', { coin, markPrice, referenceClose, deviationPct });
}

// Publish window helpers for DOM data-action integration
if (typeof window !== 'undefined') {
  window.checkJevStatus = checkJevStatus;
  window.initJevUI = initJevUI;
  window.setTimeframe = setTimeframe;
  window.analyzeWithJev = analyzeWithJev;
  window.alignTicketWithJev = alignTicketWithJev;
  window.fetchJevSignal = fetchJevSignal;
  window.executeJevSignal = executeJevSignal;
  window.updateJevSignalUI = updateJevSignalUI;
  window.auditPreTradeWithJev = auditPreTradeWithJev;
  window.classifyNewsWithJev = classifyNewsWithJev;
  window.evaluateMispricingWithJev = evaluateMispricingWithJev;
  window.JevState = JevState;
}
