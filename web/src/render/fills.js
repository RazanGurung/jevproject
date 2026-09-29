import { AppState } from '../state/store.js';
import { getRecentFillViewModels } from '../state/account-state.js';
import { fmtPrice, fmtVol } from '../utils/format.js';
import { escapeHtml } from '../utils/html.js';

function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return date.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function groupTrades(rows) {
  const sorted = rows.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
  const groups = [];

  sorted.forEach((fill) => {
    const last = groups[groups.length - 1];
    const closeEnough = last
      && last.coin === fill.coin
      && last.side === fill.side
      && Math.abs((last.lastTime || 0) - (fill.time || 0)) <= 90 * 60 * 1000;

    if (!closeEnough) {
      groups.push({
        coin: fill.coin,
        side: fill.side,
        count: 1,
        size: fill.sz,
        fees: Math.abs(fill.fee),
        pnl: fill.pnl,
        firstTime: fill.time,
        lastTime: fill.time,
      });
      return;
    }

    last.count += 1;
    last.size += fill.sz;
    last.fees += Math.abs(fill.fee);
    last.pnl += fill.pnl;
    last.firstTime = Math.min(last.firstTime || fill.time, fill.time || last.firstTime || 0);
    last.lastTime = Math.max(last.lastTime || fill.time, fill.time || last.lastTime || 0);
  });

  return groups.slice(0, 10);
}

function getSummary(rows) {
  const totalPnl = rows.reduce((sum, fill) => sum + fill.pnl, 0);
  const realized = rows.filter((fill) => fill.pnl !== 0);
  const wins = realized.filter((fill) => fill.pnl > 0).length;
  const winRate = realized.length ? (wins / realized.length) * 100 : 0;
  const coinPnl = new Map();
  rows.forEach((fill) => {
    coinPnl.set(fill.coin, (coinPnl.get(fill.coin) || 0) + fill.pnl);
  });
  const leader = Array.from(coinPnl.entries()).sort((a, b) => b[1] - a[1])[0];
  return { totalPnl, winRate, leader };
}

export function renderFills() {
  const fills = AppState.account.fills || [];
  const walletAddress = AppState.account.walletAddress;
  const hideValues = AppState.ui.hideValues;
  const bottomContent = document.getElementById('bottomContent');
  if (!bottomContent) return;

  if (!fills.length) {
    bottomContent.innerHTML = `<div class="empty-state">${walletAddress ? 'No recent fills yet' : 'Connect wallet to view fills'}</div>`;
    return;
  }

  const rows = getRecentFillViewModels(fills, 80);
  const summary = getSummary(rows);
  const groups = groupTrades(rows);
  let html = `
    <div class="fills-summary">
      <div class="fills-summary-card">
        <span class="fills-summary-label">Net PnL</span>
        <span class="fills-summary-value" style="color:${summary.totalPnl >= 0 ? 'var(--green2)' : 'var(--red2)'};">${hideValues ? 'xxxx' : (summary.totalPnl >= 0 ? '+' : '') + '$' + summary.totalPnl.toFixed(2)}</span>
      </div>
      <div class="fills-summary-card">
        <span class="fills-summary-label">Win Rate</span>
        <span class="fills-summary-value">${summary.winRate.toFixed(0)}%</span>
      </div>
      <div class="fills-summary-card">
        <span class="fills-summary-label">Best Coin</span>
        <span class="fills-summary-value">${summary.leader ? `${escapeHtml(summary.leader[0])} ${hideValues ? 'xxxx' : `${summary.leader[1] >= 0 ? '+' : ''}$${summary.leader[1].toFixed(0)}`}` : '—'}</span>
      </div>
    </div>
  `;
  html += '<div class="fills-groups">';
  html += groups.length
    ? groups.map((group) => `
      <div class="fills-group-card">
        <div class="fills-group-head">
          <span class="fills-group-coin">${escapeHtml(group.coin)} ${escapeHtml(group.side)}</span>
          <span class="fills-group-pnl" style="color:${group.pnl >= 0 ? 'var(--green2)' : 'var(--red2)'};">${hideValues ? 'xxxx' : `${group.pnl >= 0 ? '+' : ''}$${group.pnl.toFixed(2)}`}</span>
        </div>
        <div class="fills-group-meta">
          <span>${group.count} fills</span>
          <span>${hideValues ? 'xxxx' : fmtVol(group.size)} size</span>
          <span>${hideValues ? 'xxxx' : '$' + group.fees.toFixed(2)} fees</span>
          <span>${fmtTime(group.lastTime)}</span>
        </div>
      </div>
    `).join('')
    : '<div class="signal-empty">No grouped trades yet.</div>';
  html += '</div>';
  html += '<table class="data-table"><thead><tr><th>Time</th><th>Coin</th><th>Side</th><th>Size</th><th>Price</th><th>Fee</th><th>PnL</th><th>Actions</th></tr></thead><tbody>';

  rows.forEach((fill) => {
    const sideColor = fill.side === 'Buy' ? 'var(--green2)' : fill.side === 'Sell' ? 'var(--red2)' : 'var(--text2)';
    const pnlColor = fill.pnl > 0 ? 'var(--green2)' : fill.pnl < 0 ? 'var(--red2)' : 'var(--text3)';
    const payload = encodeURIComponent(JSON.stringify(fill));
    const coin = escapeHtml(fill.coin);
    const side = escapeHtml(fill.side);
    // Forced liquidations (ground-truth `liquidation` tag on the fill) read
    // differently from a normal exit.
    const liqBadge = fill.liq
      ? `<span title="${escapeHtml(fill.liqMethod || 'liquidation')}" style="margin-left:4px;color:var(--red2);font-size:9px;font-weight:700;border:1px solid var(--red2);border-radius:2px;padding:0 3px;">LIQ</span>`
      : '';
    html += `<tr>
      <td style="color:var(--text3)">${fmtTime(fill.time)}</td>
      <td style="color:var(--text);cursor:pointer;text-decoration:underline;" data-action="switchCoin" data-arg="${coin}">${coin}${liqBadge}</td>
      <td style="color:${sideColor}">${side}</td>
      <td>${hideValues ? 'xxxx' : fmtVol(fill.sz)}</td>
      <td>${fmtPrice(fill.px, fill.coin)}</td>
      <td style="color:var(--text3)">${hideValues ? 'xxxx' : '$' + Math.abs(fill.fee).toFixed(2)}</td>
      <td style="color:${pnlColor}">${hideValues ? 'xxxx' : (fill.pnl >= 0 ? '+' : '') + '$' + fill.pnl.toFixed(2)}</td>
      <td style="display:flex;gap:4px;">
        <button class="fills-action-btn" data-action="deployFillAction" data-arg="${payload}" data-arg2="replay">Replay</button>
        <button class="fills-action-btn danger" data-action="deployFillAction" data-arg="${payload}" data-arg2="hedge">Hedge</button>
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  bottomContent.innerHTML = html;
}
