/**
 * Market mispricing rendering - compares the live Hyperliquid midpoint with
 * the Hyperliquid 1m close at the underlying venue's latest completed close.
 */

import { AppState } from '../state/store.js';
import { coinToTabId } from '../utils/helpers.js';
import { fmtPrice } from '../utils/format.js';
import { scheduleFrame } from '../utils/frame.js';
import { getPaletteColor } from '../services/color-palette.js';

const MIN_MISPRICING_PCT = 1;
const ROW_STYLE = 'padding:2px 4px;display:flex;justify-content:space-between;align-items:center;gap:4px;';
const COIN_STYLE = 'color:var(--text2);font-size:8px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
const BADGE_STYLE = 'color:#000;font-size:8px;font-weight:600;text-align:center;padding:1px 4px;border-radius:2px;width:52px;flex:0 0 auto;';

let mispricingRenderPending = false;

function buildMispricingRows(snapshot = [], allMids = {}) {
  return snapshot.map((entry) => {
    const markPx = parseFloat(entry.markPx) || 0;
    const closePx = parseFloat(entry.closePx) || 0;
    const liveMid = parseFloat(allMids?.[entry.coin]);
    const currentPx = Number.isFinite(liveMid) && liveMid > 0 ? liveMid : markPx;
    const dev = closePx > 0 ? ((currentPx - closePx) / closePx) * 100 : 0;
    return {
      coin: entry.coin,
      dex: entry.dex || '',
      exchange: entry.exchange || '',
      sessionState: entry.sessionState || 'closed',
      sessionCloseMs: Number(entry.sessionCloseMs) || 0,
      markPx,
      closePx,
      currentPx,
      dev,
    };
  })
    .filter((row) => row.currentPx > 0 && row.closePx > 0 && Math.abs(row.dev) >= MIN_MISPRICING_PCT)
    .sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
}

// Stable row nodes (DOM-ladder style): live mids re-render every frame, and
// rewriting innerHTML would cancel the browser title tooltip mid-hover.
function createMispricingRow() {
  const root = document.createElement('div');
  root.className = 'book-row';
  root.style.cssText = ROW_STYLE;

  const coin = document.createElement('span');
  coin.style.cssText = COIN_STYLE;

  const badge = document.createElement('span');
  badge.style.cssText = BADGE_STYLE;

  root.append(coin, badge);
  return { root, coin, badge };
}

function ensureMispricingRows(container, count) {
  let rows = container._mispriceRows;
  const poolOk = Array.isArray(rows)
    && rows[0]?.root?.isConnected
    && rows[0].root.parentElement === container;

  // Grow/shrink in place so live mid re-renders and threshold crossings don't
  // destroy nodes under an active browser title tooltip.
  if (!poolOk) {
    while (container.firstChild) container.removeChild(container.firstChild);
    rows = [];
  }
  while (rows.length > count) {
    const row = rows.pop();
    row.root.remove();
  }
  while (rows.length < count) {
    const row = createMispricingRow();
    container.appendChild(row.root);
    rows.push(row);
  }
  container._mispriceRows = rows;
  return rows;
}

function renderMispricing() {
  const container = document.getElementById('mispricingList');
  if (!container) return;

  const snapshot = Array.isArray(AppState.market.stockMispricing) ? AppState.market.stockMispricing : [];
  const rows = buildMispricingRows(snapshot, AppState.market.allMids);
  const upColor = getPaletteColor('bullish');
  const downColor = getPaletteColor('bearish');

  if (!rows.length) {
    container._mispriceRows = null;
    container.innerHTML = '<div class="empty-state" style="padding:4px;font-size:9px;">No tickers > 1% mispriced</div>';
    return;
  }
  const nodes = ensureMispricingRows(container, rows.length);
  rows.forEach((row, i) => {
    const node = nodes[i];
    const col = row.dev >= 0 ? upColor : downColor;
    const devStr = (row.dev >= 0 ? '+' : '') + row.dev.toFixed(2) + '%';
    const intensity = Math.min(1, Math.max(0.25, Math.abs(row.dev) / 10)).toFixed(2);
    const closeStr = fmtPrice(row.closePx, row.coin);
    const currentStr = fmtPrice(row.currentPx, row.coin);
    const venue = row.dex ? `${row.exchange}/${row.dex}` : row.exchange;
    // Multi-line title like the DOM ladder so hover detail stays readable.
    const title = [
      `${venue} ${row.sessionState}`.trim(),
      `session close ${closeStr} → current HL ${currentStr}`,
    ].filter(Boolean).join('\n');

    node.coin.textContent = coinToTabId(row.coin);
    node.badge.textContent = devStr;
    node.badge.style.background = col;
    node.badge.style.opacity = intensity;
    node.root.title = title;
  });
}

// allMids can arrive many times within one paint. Coalesce MISPRICE updates to
// one render per animation frame so threshold crossings and sorting stay live
// without turning every price message into a DOM rewrite.
function scheduleMispricingRender() {
  if (mispricingRenderPending) return;
  mispricingRenderPending = true;
  scheduleFrame(() => {
    mispricingRenderPending = false;
    renderMispricing();
  });
}

export {
  buildMispricingRows,
  renderMispricing,
  scheduleMispricingRender,
};
