/** @vitest-environment jsdom */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  JevState,
  checkJevStatus,
  analyzeWithJev,
  alignTicketWithJev,
  fetchJevSignal,
  executeJevSignal,
  updateJevSignalUI,
  auditPreTradeWithJev,
  classifyNewsWithJev,
  evaluateMispricingWithJev,
  initJevUI,
  setTimeframe,
} from '../jev-service.js';
import * as api from '../api.js';

describe('Jev Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = `
      <div id="jevAuditGroup">
        <span id="jevStatusBadge" class="hidden">JEV AI</span>
        <button type="button" id="jevAnalyzeBtn">JEV AUDIT</button>
        <div id="jevResultPanel"></div>
      </div>
      <div class="book-stack-section" id="jevSignalSection">
        <button type="button" id="jevSignalRefreshBtn">↻</button>
        <div class="jev-tf-selector-bar" id="jevTfSelectorBar" role="tablist">
          <button type="button" class="jev-tf-btn" data-tf="scalp">SCALP 15m</button>
          <button type="button" class="jev-tf-btn active" data-tf="intraday">INTRADAY 4h</button>
          <button type="button" class="jev-tf-btn" data-tf="swing">SWING 1d+</button>
        </div>
        <div id="jevSignalWindow" class="jev-signal-window scroll-fill"></div>
      </div>
      <button type="button" class="btn btn-sm jev-ticket-fill-btn hidden" id="jevTicketFillBtn" disabled>
        ⚡ FILL JEV TICKET
      </button>
      <button type="button" id="buyBtn"></button>
      <button type="button" id="sellBtn"></button>
      <select id="priceModeSelect">
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      </select>
      <input type="text" id="priceInput" value="" />
      <input type="text" id="tpPctInput" value="" />
      <input type="text" id="slPctInput" value="" />
      <input type="text" id="price" value="" />
    `;
    JevState.available = false;
    JevState.model = '';
    JevState.analyzing = false;
    JevState.fetchingSignal = false;
    JevState.selectedTimeframe = 'intraday';
    JevState.signalsByTf = {};
    JevState.lastResult = null;
    JevState.lastSignal = null;
    JevState.error = null;
  });

  it('updates state and DOM when Jev is available', async () => {
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce({
      available: true,
      model: 'jev-latest',
    });

    const state = await checkJevStatus();
    expect(state.available).toBe(true);
    expect(state.model).toBe('jev-latest');

    const badge = document.getElementById('jevStatusBadge');
    expect(badge.classList.contains('hidden')).toBe(false);
    expect(badge.textContent).toBe('JEV (jev-latest)');
  });

  it('handles status check failure gracefully', async () => {
    vi.spyOn(api, 'apiGet').mockRejectedValueOnce(new Error('Network error'));

    const state = await checkJevStatus();
    expect(state.available).toBe(false);
    expect(state.error).toBe('Network error');

    const badge = document.getElementById('jevStatusBadge');
    expect(badge.classList.contains('hidden')).toBe(true);
  });

  it('performs live coin analysis and renders decision result', async () => {
    const mockAnalysis = {
      coin: 'BTC',
      midPrice: 80000,
      direction: 'bullish',
      directionConfidence: 0.92,
      confidenceScore: 4.5,
      bookImbalance: 0.45,
      spreadBps: 0.12,
      toxicFlowRisk: 0.15,
      suggestedAction: 'enter_long',
      suggestedLimitPrice: 80001,
    };
    vi.spyOn(api, 'apiPost').mockResolvedValueOnce(mockAnalysis);

    const result = await analyzeWithJev('BTC');
    expect(result.direction).toBe('bullish');
    expect(JevState.lastResult).toEqual(mockAnalysis);

    const resultPanel = document.getElementById('jevResultPanel');
    expect(resultPanel.innerHTML).toContain('BULLISH (92%)');
    expect(resultPanel.innerHTML).toContain('OFI: <b>+0.45</b>');
    expect(resultPanel.innerHTML).toContain('Toxic Risk: <b class="text-green">15%</b>');
  });

  it('aligns order ticket side and limit price with Jev decision', () => {
    const buyBtn = document.getElementById('buyBtn');
    const priceInput = document.getElementById('priceInput') || document.getElementById('price');
    let buyClicked = false;
    buyBtn.addEventListener('click', () => { buyClicked = true; });

    const aligned = alignTicketWithJev({
      direction: 'bullish',
      suggestedLimitPrice: 81250,
    });

    expect(aligned).toBe(true);
    expect(buyClicked).toBe(true);
    expect(priceInput.value).toBe('81250');
  });

  it('dispatches pre-trade audit, news classification, and mispricing evaluation', async () => {
    vi.spyOn(api, 'apiPost')
      .mockResolvedValueOnce({ approved: true, slippageRisk: 'acceptable' })
      .mockResolvedValueOnce({ direction: 'bullish', isCatalyst: true })
      .mockResolvedValueOnce({ verdict: 'mean_reverting_noise', recommended: 'fade_arbitrage' });

    const audit = await auditPreTradeWithJev('BTC', true, 5000);
    expect(audit.approved).toBe(true);

    const news = await classifyNewsWithJev('Federal Reserve cuts interest rates');
    expect(news.direction).toBe('bullish');

    const misprice = await evaluateMispricingWithJev('xyz:SP500', 5520, 5550, -0.54);
    expect(misprice.verdict).toBe('mean_reverting_noise');
  });

  it('binds click handler in initJevUI', async () => {
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce({ available: true, model: 'jev-latest' });
    vi.spyOn(api, 'apiPost').mockResolvedValueOnce({ direction: 'neutral' });

    initJevUI();
    const btn = document.getElementById('jevAnalyzeBtn');
    expect(btn._jevBound).toBe(true);

    btn.click();
    expect(api.apiPost).toHaveBeenCalledWith('/api/jev/analyze', { coin: 'BTC' });
  });

  it('fetches real-time trade signal and updates the 3rd window and ticket button DOM', async () => {
    const mockSignal = {
      coin: 'BTC',
      action: 'BUY',
      conviction: 0.85,
      score: 4.2,
      midPrice: 65000,
      entryPrice: 64995,
      takeProfitPrice: 65645,
      stopLossPrice: 64670,
      takeProfitPct: 1.0,
      stopLossPct: 0.5,
      riskRewardRatio: 2.0,
      toxicRisk: 0.05,
      spreadBps: 0.15,
      bookImbalance: 0.38,
      reason: 'OFI positive (+0.38) with strong bid support ($1200K depth).',
      timestamp: Date.now(),
      model: 'jev-1.13.0',
    };
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce(mockSignal);
    JevState.available = true;

    const signal = await fetchJevSignal('BTC');
    expect(signal.action).toBe('BUY');
    expect(JevState.lastSignal).toEqual(mockSignal);

    const actionEl = document.getElementById('jevSignalAction');
    expect(actionEl.textContent).toBe('BUY');
    expect(actionEl.classList.contains('buy')).toBe(true);

    const entryEl = document.getElementById('jevSignalEntry');
    expect(entryEl.textContent).toContain('64,995');

    const tpEl = document.getElementById('jevSignalTP');
    expect(tpEl.textContent).toContain('65,645');

    const slEl = document.getElementById('jevSignalSL');
    expect(slEl.textContent).toContain('64,670');

    const convEl = document.getElementById('jevSignalConv');
    expect(convEl.textContent).toContain('85%');

    const modelEl = document.getElementById('jevSignalModel');
    expect(modelEl.textContent).toBe('jev-1.13.0');

    const ticketFillBtn = document.getElementById('jevTicketFillBtn');
    expect(ticketFillBtn.textContent).toContain('BUY @ $64,995');
    expect(ticketFillBtn.disabled).toBe(false);
  });

  it('executes trade signal with 1-click: populates side, manual mode, entry, TP, and SL', () => {
    const buyBtn = document.getElementById('buyBtn');
    const priceModeSelect = document.getElementById('priceModeSelect');
    const priceInput = document.getElementById('priceInput');
    const tpInput = document.getElementById('tpPctInput');
    const slInput = document.getElementById('slPctInput');

    let buyClicked = false;
    buyBtn.addEventListener('click', () => { buyClicked = true; });

    const signal = {
      action: 'BUY',
      entryPrice: 64995,
      takeProfitPct: 1.2,
      stopLossPct: 0.6,
    };

    const executed = executeJevSignal(signal);
    expect(executed).toBe(true);
    expect(buyClicked).toBe(true);
    expect(priceModeSelect.value).toBe('manual');
    expect(priceInput.value).toBe('64995');
    expect(tpInput.value).toBe('1.2');
    expect(slInput.value).toBe('0.6');
  });

  it('refuses to execute when signal action is HOLD', () => {
    const executed = executeJevSignal({ action: 'HOLD' });
    expect(executed).toBe(false);
  });

  it('renders neutral placeholder prices and ATR brackets when signal action is HOLD', async () => {
    const mockHoldSignal = {
      coin: 'BTC',
      action: 'HOLD',
      conviction: 0.35,
      score: 1.5,
      midPrice: 85804.5,
      entryPrice: 0,
      takeProfitPrice: 0,
      stopLossPrice: 0,
      takeProfitPct: 1.22,
      stopLossPct: 0.61,
      riskRewardRatio: 2.0,
      toxicRisk: 0.71,
      spreadBps: 0.1,
      bookImbalance: -0.82,
      reason: '[INTRADAY] Gate 7: Long suppressed at Yearly Volume Profile resistance',
      timestamp: Date.now(),
      model: 'jev-1.13.0',
    };
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce(mockHoldSignal);
    JevState.available = true;

    const signal = await fetchJevSignal('BTC');
    expect(signal.action).toBe('HOLD');

    const entryEl = document.getElementById('jevSignalEntry');
    expect(entryEl.textContent.trim()).toBe('—');

    const tpEl = document.getElementById('jevSignalTP');
    expect(tpEl.textContent.trim()).toBe('—');

    const slEl = document.getElementById('jevSignalSL');
    expect(slEl.textContent.trim()).toBe('—');
  });

  it('switches timeframe, requests signal with timeframe param, and updates duration badge', async () => {
    const mockScalpSignal = {
      coin: 'BTC',
      action: 'BUY',
      timeframe: 'scalp',
      estimatedDuration: '15m – 45m (Quick Scalp)',
      conviction: 0.88,
      score: 4.4,
      midPrice: 80000,
      entryPrice: 80000,
      takeProfitPrice: 80400,
      stopLossPrice: 79800,
      takeProfitPct: 0.5,
      stopLossPct: 0.25,
      riskRewardRatio: 2.0,
      toxicRisk: 0.1,
      spreadBps: 0.1,
      bookImbalance: 0.42,
      reason: 'Top-of-book depth heavily skewed bid-side.',
      timestamp: Date.now(),
      model: 'jev-1.13.0',
    };

    vi.spyOn(api, 'apiGet').mockResolvedValueOnce(mockScalpSignal);
    JevState.available = true;

    setTimeframe('scalp');

    expect(JevState.selectedTimeframe).toBe('scalp');
    const scalpBtn = document.querySelector('.jev-tf-btn[data-tf="scalp"]');
    const intradayBtn = document.querySelector('.jev-tf-btn[data-tf="intraday"]');
    expect(scalpBtn.classList.contains('active')).toBe(true);
    expect(intradayBtn.classList.contains('active')).toBe(false);

    expect(api.apiGet).toHaveBeenCalledWith('/api/jev/signal?coin=BTC&timeframe=scalp');

    // Wait microtask for promise resolution
    await Promise.resolve();

    const durationEl = document.getElementById('jevSignalDuration');
    expect(durationEl.textContent).toContain('15m – 45m (Quick Scalp)');
    const horizonEl = document.getElementById('jevSignalHorizon');
    expect(horizonEl.textContent).toBe('SCALP');

    const ticketFillBtn = document.getElementById('jevTicketFillBtn');
    expect(ticketFillBtn.textContent).toContain('SCALP BUY @ $80,000');
  });

  it('uses cached signal when switching back to recently fetched timeframe', async () => {
    const now = Date.now();
    JevState.available = true;
    JevState.signalsByTf['swing'] = {
      coin: 'BTC',
      action: 'BUY',
      timeframe: 'swing',
      estimatedDuration: '1d – 5d (Intra-Month Swing)',
      entryPrice: 79500,
      takeProfitPct: 4.2,
      stopLossPct: 2.0,
      timestamp: now,
    };

    const getSpy = vi.spyOn(api, 'apiGet');
    setTimeframe('swing');

    expect(JevState.selectedTimeframe).toBe('swing');
    expect(getSpy).not.toHaveBeenCalled();
    expect(JevState.lastSignal.estimatedDuration).toBe('1d – 5d (Intra-Month Swing)');
  });

  it('binds timeframe selector bar clicks in initJevUI', () => {
    initJevUI();
    const swingBtn = document.querySelector('.jev-tf-btn[data-tf="swing"]');
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce({
      coin: 'BTC',
      action: 'HOLD',
      timeframe: 'swing',
    });

    swingBtn.click();
    expect(JevState.selectedTimeframe).toBe('swing');
  });

  it('renders counter-trend badge and updates ticket button with COUNTER-TREND prefix for range high short', async () => {
    const mockCounterTrendSignal = {
      coin: 'BTC',
      action: 'SELL',
      timeframe: 'intraday',
      signalType: 'counter_trend',
      marketEnvironment: 'range',
      conviction: 0.74,
      score: 3.8,
      midPrice: 65400,
      entryPrice: 65450,
      takeProfitPrice: 65000,
      stopLossPrice: 65650,
      takeProfitPct: 0.69,
      stopLossPct: 0.31,
      riskRewardRatio: 2.2,
      toxicRisk: 0.12,
      spreadBps: 0.2,
      bookImbalance: 0.35,
      reason: '[INTRADAY] Range High Rejection (Counter-Trend Short): price tested VAH without institutional breakout conviction',
      timestamp: Date.now(),
      model: 'jev-1.13.0',
    };
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce(mockCounterTrendSignal);
    JevState.available = true;

    const signal = await fetchJevSignal('BTC', 'intraday');
    expect(signal.signalType).toBe('counter_trend');
    expect(signal.marketEnvironment).toBe('range');

    const typeBadge = document.getElementById('jevSignalTypeBadge');
    expect(typeBadge).not.toBeNull();
    expect(typeBadge.textContent).toBe('COUNTER-TREND');
    expect(typeBadge.classList.contains('counter-trend')).toBe(true);

    const envBadge = document.getElementById('jevMarketEnvBadge');
    expect(envBadge).not.toBeNull();
    expect(envBadge.textContent).toBe('RANGE');
    expect(envBadge.classList.contains('range')).toBe(true);

    const ticketFillBtn = document.getElementById('jevTicketFillBtn');
    expect(ticketFillBtn.textContent).toContain('COUNTER-TREND SELL @ $65,450');
    expect(ticketFillBtn.classList.contains('sell')).toBe(true);
  });

  it('renders trend badge and standard ticket button for trend breakout signal', async () => {
    const mockTrendSignal = {
      coin: 'BTC',
      action: 'BUY',
      timeframe: 'intraday',
      signalType: 'trend',
      marketEnvironment: 'trend',
      conviction: 0.86,
      score: 4.3,
      midPrice: 65000,
      entryPrice: 64995,
      takeProfitPrice: 65650,
      stopLossPrice: 64670,
      takeProfitPct: 1.0,
      stopLossPct: 0.5,
      riskRewardRatio: 2.0,
      toxicRisk: 0.08,
      spreadBps: 0.15,
      bookImbalance: 0.45,
      reason: 'Bullish orderflow aligned with macro uptrend',
      timestamp: Date.now(),
      model: 'jev-1.13.0',
    };
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce(mockTrendSignal);
    JevState.available = true;

    const signal = await fetchJevSignal('BTC', 'intraday');
    expect(signal.signalType).toBe('trend');
    expect(signal.marketEnvironment).toBe('trend');

    const typeBadge = document.getElementById('jevSignalTypeBadge');
    expect(typeBadge).not.toBeNull();
    expect(typeBadge.textContent).toBe('TREND');
    expect(typeBadge.classList.contains('trend')).toBe(true);

    const envBadge = document.getElementById('jevMarketEnvBadge');
    expect(envBadge).not.toBeNull();
    expect(envBadge.textContent).toBe('TREND');
    expect(envBadge.classList.contains('trend')).toBe(true);

    const ticketFillBtn = document.getElementById('jevTicketFillBtn');
    expect(ticketFillBtn.textContent).toContain('INTRADAY BUY @ $64,995');
    expect(ticketFillBtn.textContent).not.toContain('COUNTER-TREND');
  });

  it('renders Volume Profile and TWAP context strip when profile levels are present', async () => {
    const mockVPSignal = {
      coin: 'BTC',
      action: 'BUY',
      timeframe: 'intraday',
      signalType: 'trend',
      marketEnvironment: 'range',
      conviction: 0.85,
      score: 4.2,
      midPrice: 86500,
      entryPrice: 86490,
      takeProfitPrice: 87500,
      stopLossPrice: 85900,
      profileHorizon: 'monthly',
      vah: 80100,
      poc: 77900,
      val: 76300,
      distFromTwapPct: 10.5,
      timestamp: Date.now(),
      model: 'jev-1.13.0',
    };
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce(mockVPSignal);
    JevState.available = true;

    await fetchJevSignal('BTC', 'intraday');

    const vpRow = document.getElementById('jevSignalVPRow');
    expect(vpRow).not.toBeNull();
    expect(vpRow.textContent).toContain('30D VP:');
    expect(vpRow.textContent).toContain('VAL');
    expect(vpRow.textContent).toContain('$76.3K');
    expect(vpRow.textContent).toContain('POC');
    expect(vpRow.textContent).toContain('$77.9K');
    expect(vpRow.textContent).toContain('VAH');
    expect(vpRow.textContent).toContain('$80.1K');
    expect(vpRow.textContent).toContain('+10.5% TWAP');
  });
  it('renders toxic halt countdown pill when signal is toxic halted', async () => {
    const mockToxicSignal = {
      coin: 'BTC',
      timeframe: 'scalp',
      action: 'HOLD',
      toxicRisk: 0.49,
      isToxicHalted: true,
      toxicHaltRemainingSeconds: 12,
      reason: '[SCALP] Toxic flow tripwire active (49% > 35% limit); adverse sweep detected.',
      timestamp: Date.now(),
    };
    vi.spyOn(api, 'apiGet').mockResolvedValueOnce(mockToxicSignal);
    JevState.available = true;

    await fetchJevSignal('BTC', 'scalp');

    const pill = document.getElementById('jevToxicHaltPill');
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('TOXIC SWEEP HALT: 12s');
  });

  it('renders timeframe edge dots reflecting conviction and toxic state', async () => {
    JevState.available = true;
    const bar = document.getElementById('jevTfSelectorBar');
    expect(bar).not.toBeNull();

    // Cache a strong buy on intraday and toxic on scalp
    JevState.signalsByTf = {
      intraday: { coin: 'BTC', action: 'BUY', conviction: 0.82 },
      scalp: { coin: 'BTC', action: 'HOLD', isToxicHalted: true },
    };
    updateJevSignalUI();

    const intradayBtn = bar.querySelector('[data-tf="intraday"]');
    const scalpBtn = bar.querySelector('[data-tf="scalp"]');
    expect(intradayBtn.innerHTML).toContain('edge-strong');
    expect(scalpBtn.innerHTML).toContain('edge-toxic');
  });
});

