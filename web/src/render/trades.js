/**
 * Trades rendering - trade-related visual updates
 */

import { AppState } from '../state/store.js';
import { fmtPrice, fmtVol } from '../utils/format.js';
import { coinToTabId } from '../utils/helpers.js';
import { colorWithAlpha, getPaletteColor } from '../services/color-palette.js';
import { scheduleFrame } from '../utils/frame.js';

let liquidationsRenderPending = false;

// Highlight intensity for a print's dollar value, used by the DOM ladder's
// trade flash: sqrt ramp so brightness grades across the whole dust->whale
// range (~0.08 floor for tiny prints, ~0.32 at $10k, saturated at $100k) —
// a linear ramp from the $5k+ chip-list era floored everything under ~$24k
// at the same brightness.
function tradeIntensity(val) {
  return Math.min(1, Math.max(0.08, Math.sqrt((parseFloat(val) || 0) / 100000)));
}

function renderTrades() {
  const trades = AppState.market.trades || [];
  const currentCoin = AppState.trading.currentCoin;

  const $ = id => document.getElementById(id);
  const container = $('bottomContent');
  if (!container) return;

  if (!trades.length) {
    container.innerHTML = '<div class="empty-state">Waiting for trades...</div>';
    return;
  }

  let html = '<table class="data-table"><thead><tr><th>Price</th><th>Size</th><th>Side</th><th>Time</th></tr></thead><tbody>';
  trades.slice(0, 40).forEach(t => {
    if (!t || !t.px || !t.sz) return;
    const isBuy = t.side === 'B' || t.side === 'buy';
    const col = getPaletteColor(isBuy ? 'bullish' : 'bearish');
    const time = t.time ? new Date(t.time).toLocaleTimeString('en-US', { hour12: false }) : '—';
    html += `<tr>
      <td style="color:${col}">${fmtPrice(t.px, currentCoin)}</td>
      <td>${parseFloat(t.sz).toFixed(4)}</td>
      <td style="color:${col}">${isBuy ? 'Buy' : 'Sell'}</td>
      <td style="color:var(--text3)">${time}</td>
    </tr>`;
  });
  container.innerHTML = html + '</tbody></table>';
}

// getLiquidationRows reads the backend's market-wide liquidation feed (Bybit,
// + QuickNode when configured), buffered in AppState.market.marketLiquidations.
function getLiquidationRows() {
  const wallet = String(AppState.account.walletAddress || '').toLowerCase();
  const market = Array.isArray(AppState.market.marketLiquidations) ? AppState.market.marketLiquidations : [];
  return market.slice(0, 100).map((t) => ({
    coin: t.coin || '—',
    side: String(t.side || '').toLowerCase().startsWith('b') ? 'buy' : 'sell',
    px: parseFloat(t.px) || 0,
    sz: parseFloat(t.sz) || 0,
    value: t.value || (parseFloat(t.px) * parseFloat(t.sz)) || 0,
    time: t.time || 0,
    method: t.method || '',
    mine: !!t.user && String(t.user).toLowerCase() === wallet,
  }));
}

const LIQ_ROW_STYLE = 'padding:2px 4px;display:flex;justify-content:space-between;align-items:center;gap:4px;';
const LIQ_COIN_STYLE = 'color:var(--text2);font-size:8px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
const LIQ_BADGE_STYLE = 'color:#000;font-size:8px;font-weight:600;text-align:center;padding:1px 4px;border-radius:2px;width:52px;flex:0 0 auto;';
const LIQ_BACK_STYLE = 'color:var(--text3);font-weight:700;letter-spacing:0.3px;';
const LIQ_MINE_STYLE = 'color:var(--amber);font-weight:700;';

// Stable row nodes so browser title tooltips survive re-renders (same approach
// as the DOM ladder). Full innerHTML rewrites cancel hover mid-display.
function createLiqRow() {
  const root = document.createElement('div');
  root.className = 'book-row';
  root.style.cssText = LIQ_ROW_STYLE;

  const coinWrap = document.createElement('span');
  coinWrap.style.cssText = LIQ_COIN_STYLE;

  const back = document.createElement('span');
  back.style.cssText = LIQ_BACK_STYLE;
  back.textContent = 'BACK ';
  back.hidden = true;

  const name = document.createElement('span');

  const mine = document.createElement('span');
  mine.style.cssText = LIQ_MINE_STYLE;
  mine.textContent = ' •';
  mine.hidden = true;

  coinWrap.append(back, name, mine);

  const badge = document.createElement('span');
  badge.style.cssText = LIQ_BADGE_STYLE;

  root.append(coinWrap, badge);
  return { root, back, name, mine, badge };
}

function ensureLiqRows(container, count) {
  let nodes = container._liqRows;
  const poolOk = Array.isArray(nodes)
    && nodes[0]?.root?.isConnected
    && nodes[0].root.parentElement === container;

  // Grow/shrink in place. Full rebuilds (on every new liq) tear down nodes and
  // cancel the browser title tooltip mid-hover — same problem as MISPRICE/DOM.
  if (!poolOk) {
    while (container.firstChild) container.removeChild(container.firstChild);
    nodes = [];
  }
  while (nodes.length > count) {
    const row = nodes.pop();
    row.root.remove();
  }
  while (nodes.length < count) {
    const row = createLiqRow();
    container.appendChild(row.root);
    nodes.push(row);
  }
  container._liqRows = nodes;
  return nodes;
}

function fmtLiqVol(n) {
  n = parseFloat(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function renderLiquidations() {
  const rows = getLiquidationRows();
  const hideValues = AppState.ui.hideValues;

  const $ = id => document.getElementById(id);
  const liqContainer = $('liquidationsList');
  if (!liqContainer) return;

  if (!rows.length) {
    liqContainer._liqRows = null;
    liqContainer.innerHTML = '<div class="empty-state" style="padding:4px;font-size:9px;">No liquidations</div>';
    return;
  }
  const buyColor = getPaletteColor('bullish');
  const sellColor = getPaletteColor('bearish');
  const nodes = ensureLiqRows(liqContainer, rows.length);

  rows.forEach((t, i) => {
    // The forced trade direction: a sell liquidates a long, a buy liquidates a short.
    const isBuy = t.side === 'buy';
    const val = t.value || (t.sz * t.px);
    const liqColor = isBuy ? buyColor : sellColor;
    // Match MISPRICE: two cells only (ticker + badge). Time/detail live in the
    // tooltip so the narrow liq column has room for longer tickers. xyz: coins
    // use the same display labels as MISPRICE (coinToTabId) so the prefix
    // never eats the narrow column.
    const displayCoin = coinToTabId(t.coin);
    const timeStr = t.time ? new Date(t.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const sizeStr = fmtLiqVol(val);
    const intensity = Math.min(1, Math.max(0.2, val / 100000)).toFixed(2);
    const method = t.method || 'liquidation';
    const forced = isBuy ? 'shorts liquidated' : 'longs liquidated';
    const pxStr = t.px > 0 ? String(t.px) : '';
    // Multi-line title like DOM / MISPRICE so hover detail stays readable.
    const title = [
      `${displayCoin} · ${method}`,
      [forced, hideValues && t.mine ? null : `$${sizeStr}`, pxStr ? `@ ${pxStr}` : ''].filter(Boolean).join(' · '),
      timeStr,
    ].filter(Boolean).join('\n');

    const node = nodes[i];
    node.back.hidden = t.method !== 'backstop';
    node.name.textContent = displayCoin;
    node.mine.hidden = !t.mine;
    node.badge.textContent = hideValues && t.mine ? 'xxxx' : '$' + sizeStr;
    node.badge.style.background = liqColor;
    node.badge.style.opacity = intensity;
    node.root.title = title;
  });
}

// Liquidation batches can arrive in bursts; coalesce to one paint per frame so
// the panel does not steal main-thread time from candle/book work mid-burst.
function scheduleLiquidationsRender() {
  if (liquidationsRenderPending) return;
  liquidationsRenderPending = true;
  scheduleFrame(() => {
    liquidationsRenderPending = false;
    renderLiquidations();
  });
}

// renderOrderFlow — two aligned DOM-header meters using the same rolling logic:
// ALL valid taker prints and independently sampled WHALE-threshold prints.
// Meter fills are intentionally softer than their labels so the compact bars
// remain secondary to the dollar readouts.
function renderOrderFlow() {
  const buyEl = document.getElementById('domFlowBuy');
  const barEl = document.getElementById('domFlowBar');
  const sellEl = document.getElementById('domFlowSell');
  const whaleBuyEl = document.getElementById('domWhaleFlowBuy');
  const whaleBarEl = document.getElementById('domWhaleFlowBar');
  const whaleSellEl = document.getElementById('domWhaleFlowSell');
  if (!buyEl || !barEl || !sellEl || !whaleBuyEl || !whaleBarEl || !whaleSellEl) return;

  const orderFlow = AppState.market.orderFlow || { buyVol: 0, sellVol: 0, trades: [] };
  const whaleFlow = AppState.market.largeTradeFlow || { buyVol: 0, sellVol: 0 };
  const buyColor = getPaletteColor('bullish');
  const sellColor = getPaletteColor('bearish');
  const meterBuyColor = colorWithAlpha(getPaletteColor('bullish'), 0.50);
  const meterSellColor = colorWithAlpha(getPaletteColor('bearish'), 0.50);

  const buyVol = orderFlow.buyVol || 0;
  const sellVol = orderFlow.sellVol || 0;
  const whaleBuy = whaleFlow.buyVol || 0;
  const whaleSell = whaleFlow.sellVol || 0;
  const sampleCount = Math.max(0, Number(orderFlow.sampleCount) || 0);
  const sampleCapacity = Math.max(1, Number(orderFlow.sampleCapacity) || 500);
  const whaleSampleCount = Math.max(0, Number(whaleFlow.sampleCount) || 0);
  const whaleSampleCapacity = Math.max(1, Number(whaleFlow.sampleCapacity) || 500);
  const flowMeta = AppState.market.flowMetaCache?.get(AppState.trading.currentCoin) || {};
  const whaleThreshold = Math.max(0, Number(flowMeta.whaleFlowThresholdUsd) || 100000);
  const total = buyVol + sellVol;
  const buyPct = total > 0 ? (buyVol / total * 100) : 50;

  const fmtVolAlways = (n) => {
    n = parseFloat(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toFixed(0);
  };

  if (sampleCount === 0) {
    buyEl.textContent = 'WARM';
    sellEl.textContent = `0/${sampleCapacity}`;
    whaleBuyEl.textContent = '—';
    whaleSellEl.textContent = '—';
    buyEl.style.color = 'var(--text3)';
    sellEl.style.color = 'var(--text3)';
    whaleBuyEl.style.color = 'var(--text3)';
    whaleSellEl.style.color = 'var(--text3)';
    barEl.style.background = 'var(--bg3)';
    whaleBarEl.style.background = 'var(--bg3)';
    const warmingTitle = `Warming ${AppState.trading.currentCoin} public flow · 0/${sampleCapacity} prints`;
    barEl.title = warmingTitle;
    whaleBarEl.title = warmingTitle;
    barEl.setAttribute('aria-label', warmingTitle);
    whaleBarEl.setAttribute('aria-label', warmingTitle);
    return;
  }

  buyEl.textContent = '$' + fmtVolAlways(buyVol);
  buyEl.style.color = buyColor;
  sellEl.textContent = '$' + fmtVolAlways(sellVol);
  sellEl.style.color = sellColor;
  const whaleTotal = whaleBuy + whaleSell;
  const whaleBuyPct = whaleTotal > 0 ? whaleBuy / whaleTotal * 100 : 50;
  barEl.style.background = total > 0
    ? `linear-gradient(to right, ${meterBuyColor} ${buyPct.toFixed(1)}%, ${meterSellColor} ${buyPct.toFixed(1)}%)`
    : 'var(--bg3)';
  whaleBuyEl.textContent = '$' + fmtVolAlways(whaleBuy);
  whaleBuyEl.style.color = buyColor;
  whaleSellEl.textContent = '$' + fmtVolAlways(whaleSell);
  whaleSellEl.style.color = sellColor;
  whaleBarEl.style.background = whaleTotal > 0
    ? `linear-gradient(to right, ${meterBuyColor} ${whaleBuyPct.toFixed(1)}%, ${meterSellColor} ${whaleBuyPct.toFixed(1)}%)`
    : 'var(--bg3)';
  const thresholdLabel = `$${fmtVolAlways(whaleThreshold)}`;
  barEl.title = `ALL rolling flow ${buyPct.toFixed(0)}% buy · $${fmtVolAlways(total)} · ${sampleCount}/${sampleCapacity} latest valid prints`;
  whaleBarEl.title = `WHALE rolling flow ${whaleBuyPct.toFixed(0)}% buy · $${fmtVolAlways(whaleTotal)} · ${whaleSampleCount}/${whaleSampleCapacity} latest prints ≥ ${thresholdLabel}`;
  barEl.setAttribute('aria-label', `Latest ${sampleCount} valid prints: ${buyPct.toFixed(0)} percent buy, $${fmtVolAlways(total)} total`);
  whaleBarEl.setAttribute('aria-label', `Latest ${whaleSampleCount} prints at least ${thresholdLabel}: ${whaleBuyPct.toFixed(0)} percent buy, $${fmtVolAlways(whaleTotal)} total`);

}

export {
  renderTrades,
  renderLiquidations,
  scheduleLiquidationsRender,
  tradeIntensity,
  renderOrderFlow,
};
