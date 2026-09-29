/**
 * Positions rendering - positions table rendering
 */

import { AppState } from '../state/store.js';
import { getAccountState, getOpenPositionViewModels } from '../state/account-state.js';
import { isHip3Coin } from '../utils/helpers.js';
import { fmtVol, fmtPrice } from '../utils/format.js';
import { escapeHtml } from '../utils/html.js';

function useMobileCards() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(max-width: 767px)')?.matches || window.innerWidth <= 767;
}

function renderPositions() {
  const accountState = getAccountState();
  const walletAddress = AppState.account.walletAddress;
  const hideValues = AppState.ui.hideValues;
  
  const $ = id => document.getElementById(id);
  const bottomContent = $('bottomContent');
  if (!bottomContent) return;
  
  if (!accountState || !accountState.assetPositions) {
    bottomContent.innerHTML = '<div class="empty-state">' + (walletAddress ? 'No open positions' : 'Connect wallet to view positions') + '</div>';
    return;
  }
  
  const positions = getOpenPositionViewModels(accountState);
  if (!positions.length) {
    bottomContent.innerHTML = '<div class="empty-state">No open positions</div>';
    return;
  }

  if (useMobileCards()) {
    let html = '<div class="mobile-account-list">';

    positions.forEach(({ metrics }) => {
      const { position: pos, size, entry, mark, pnl, marginUsed, roePct, positionValue, liqPrice, distToLiq, maintMargin } = metrics;
      const side = size > 0 ? 'Long' : 'Short';
      const sideClass = size > 0 ? 'long' : 'short';
      const isBuy = size > 0;
      const isHip3 = isHip3Coin(pos.coin);
      const pnlCol = pnl >= 0 ? 'var(--green2)' : 'var(--red2)';
      const distCol = distToLiq < 10 ? 'var(--red2)' : distToLiq < 20 ? 'var(--amber)' : 'var(--text2)';
      const coin = escapeHtml(pos.coin);
      const coinLabel = escapeHtml(pos.coin + (isHip3 ? '*' : ''));
      const positionSize = Math.abs(size);
      const positionSzi = size;

      html += `
        <div class="mobile-account-card">
          <div class="mobile-account-card-head">
            <div>
              <div class="mobile-account-card-title" data-action="switchCoin" data-arg="${coin}" style="cursor:pointer;text-decoration:underline;">${coinLabel}</div>
              <div class="mobile-account-card-subtitle">${side} position</div>
            </div>
            <div class="mobile-account-badge ${sideClass}">${roePct != null ? roePct.toFixed(2) + '% ROE' : side}</div>
          </div>
          <div class="mobile-account-grid">
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Size</span>
              <span class="mobile-account-value">${hideValues ? '$xxxxx' : '$' + fmtVol(positionValue)}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">PnL</span>
              <span class="mobile-account-value" style="color:${pnlCol};">${pnl >= 0 ? '+' : ''}${hideValues ? '$xxxxx' : '$' + pnl.toFixed(2)}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Entry</span>
              <span class="mobile-account-value">${fmtPrice(entry, pos.coin)}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Mark</span>
              <span class="mobile-account-value">${fmtPrice(mark, pos.coin)}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Liquidation</span>
              <span class="mobile-account-value">${liqPrice > 0 ? fmtPrice(liqPrice, pos.coin) : '—'}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Dist</span>
              <span class="mobile-account-value" style="color:${distCol};">${distToLiq > 0 ? distToLiq.toFixed(1) + '%' : '—'}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Margin</span>
              <span class="mobile-account-value">${hideValues ? '$xxxxx' : '$' + marginUsed.toFixed(2)}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Maint</span>
              <span class="mobile-account-value">${hideValues ? '$xxxxx' : '$' + maintMargin.toFixed(2)}</span>
            </div>
          </div>
          <div class="mobile-account-actions">
            <button class="mobile-action-btn muted" data-action="closePosition" data-arg="${coin}" data-arg2="0.25" data-arg3="${positionSzi}" data-pass-el="true">25%</button>
            <button class="mobile-action-btn muted" data-action="closePosition" data-arg="${coin}" data-arg2="0.5" data-arg3="${positionSzi}" data-pass-el="true">50%</button>
            <button class="mobile-action-btn muted" data-action="closePosition" data-arg="${coin}" data-arg2="0.75" data-arg3="${positionSzi}" data-pass-el="true">75%</button>
            <button class="mobile-action-btn danger" data-action="closePosition" data-arg="${coin}" data-arg2="1" data-arg3="${positionSzi}" data-pass-el="true">Close</button>
            <button class="mobile-action-btn primary" data-action="setTP" data-arg="${coin}" data-arg2="${isBuy}" data-arg3="${positionSize}" data-arg4="${entry}">TP</button>
            <button class="mobile-action-btn" data-action="setSL" data-arg="${coin}" data-arg2="${isBuy}" data-arg3="${positionSize}" data-arg4="${entry}">SL</button>
          </div>
        </div>
      `;
    });

    html += '</div>';
    bottomContent.innerHTML = html;
    return;
  }
  
  let html = '<table class="data-table"><thead><tr><th>Coin</th><th>Side</th><th>Size (USD)</th><th>Entry</th><th>Mark</th><th>PnL</th><th>ROE%</th><th>Margin</th><th>Maint</th><th>Dist%</th><th>Liquidation</th><th>Actions</th></tr></thead><tbody>';
  
  positions.forEach(({ metrics }) => {
    const { position: pos, size, entry, mark, pnl, marginUsed, roePct, positionValue, liqPrice, distToLiq, maintMargin } = metrics;
    const side = size > 0 ? 'Long' : 'Short';
    const col = size > 0 ? 'var(--text)' : 'var(--text2)';
    const sizeUsd = positionValue;
    const isBuy = size > 0;
    const isHip3 = isHip3Coin(pos.coin);
    const pnlCol = pnl >= 0 ? 'var(--text)' : 'var(--text2)';
    
    const distCol = distToLiq < 10 ? 'var(--red2)' : distToLiq < 20 ? 'var(--yellow)' : 'var(--text3)';
    const coin = escapeHtml(pos.coin);
    const coinLabel = escapeHtml(pos.coin + (isHip3 ? '*' : ''));
    
    html += `<tr data-coin="${coin}" data-isbuy="${isBuy}" data-size="${size}" data-entry="${entry}">
      <td style="color:var(--text);font-weight:500;cursor:pointer;text-decoration:underline;" data-action="switchCoin" data-arg="${coin}">${coinLabel}</td>
      <td style="color:${col}">${side}</td>
      <td data-field="size" style="color:var(--text)">${hideValues ? '$xxxxx' : '$' + fmtVol(sizeUsd)}</td>
      <td>${fmtPrice(entry, pos.coin)}</td>
      <td data-field="mark">${fmtPrice(mark, pos.coin)}</td>
      <td data-field="pnl" style="color:${pnlCol}">${pnl >= 0 ? '+' : ''}${hideValues ? '$xxxxx' : '$' + pnl.toFixed(2)}</td>
      <td data-field="roe" style="color:${pnlCol}">${roePct != null ? roePct.toFixed(2) + '%' : '—'}</td>
      <td style="color:var(--text3)">${hideValues ? '$xxxxx' : '$' + marginUsed.toFixed(2)}</td>
      <td style="color:var(--text3)">${hideValues ? '$xxxxx' : '$' + maintMargin.toFixed(2)}</td>
      <td style="color:${distCol}">${distToLiq > 0 ? distToLiq.toFixed(1) + '%' : '—'}</td>
      <td style="color:var(--text3)">${liqPrice > 0 ? fmtPrice(liqPrice, pos.coin) : '—'}</td>
      <td style="display:flex;flex-direction:column;gap:2px;min-width:180px;">
        <div style="display:flex;gap:2px;">
          <button data-action="closePosition" data-arg="${coin}" data-arg2="0.25" data-arg3="${size}" data-pass-el="true" style="background:#666;border:none;color:#fff;border-radius:2px;padding:2px 4px;cursor:pointer;font-size:8px;font-family:var(--mono);">25%</button>
          <button data-action="closePosition" data-arg="${coin}" data-arg2="0.5" data-arg3="${size}" data-pass-el="true" style="background:#666;border:none;color:#fff;border-radius:2px;padding:2px 4px;cursor:pointer;font-size:8px;font-family:var(--mono);">50%</button>
          <button data-action="closePosition" data-arg="${coin}" data-arg2="0.75" data-arg3="${size}" data-pass-el="true" style="background:#666;border:none;color:#fff;border-radius:2px;padding:2px 4px;cursor:pointer;font-size:8px;font-family:var(--mono);">75%</button>
          <button data-action="closePosition" data-arg="${coin}" data-arg2="1" data-arg3="${size}" data-pass-el="true" style="background:var(--red2);border:none;color:#000;border-radius:2px;padding:2px 6px;cursor:pointer;font-size:8px;font-family:var(--mono);font-weight:600;">Close</button>
        </div>
        <div style="display:flex;gap:2px;">
          <button data-action="setTP" data-arg="${coin}" data-arg2="${isBuy}" data-arg3="${Math.abs(size)}" data-arg4="${entry}" style="background:var(--green2);border:none;color:#000;border-radius:2px;padding:2px 6px;cursor:pointer;font-size:8px;font-family:var(--mono);font-weight:600;">TP</button>
          <button data-action="setSL" data-arg="${coin}" data-arg2="${isBuy}" data-arg3="${Math.abs(size)}" data-arg4="${entry}" style="background:#cc6666;border:none;color:#000;border-radius:2px;padding:2px 6px;cursor:pointer;font-size:8px;font-family:var(--mono);font-weight:600;">SL</button>
        </div>
      </td>
    </tr>`;
  });
  
  html += '</tbody></table>';
  bottomContent.innerHTML = html;
}

function renderPositionsIncremental() {
  const accountState = getAccountState();
  const walletAddress = AppState.account.walletAddress;
  const hideValues = AppState.ui.hideValues;
  
  const $ = id => document.getElementById(id);
  const container = $('bottomContent');
  if (!container) return;
  
  const positions = getOpenPositionViewModels(accountState);

  if (useMobileCards()) {
    renderPositions();
    return;
  }
  
  if (!positions.length) {
    container.innerHTML = '<div class="empty-state">' + (walletAddress ? 'No open positions' : 'Connect wallet to view positions') + '</div>';
    return;
  }
  
  // Value-only updates are safe only while row identity and every field baked
  // into the action buttons remain unchanged.
  const existingRows = container.querySelectorAll('tbody tr');
  if (existingRows.length === 0) {
    renderPositions();
    return;
  }

  if (existingRows.length !== positions.length) {
    renderPositions();
    return;
  }

  const requiresFullRerender = positions.some(({ metrics }, idx) => {
    const row = existingRows[idx];
    const { position, size, entry } = metrics;
    if (!row) return true;
    return String(row.dataset.coin || '') !== String(position.coin || '')
      || String(row.dataset.isbuy || '') !== String(size > 0)
      || String(row.dataset.size || '') !== String(size)
      || String(row.dataset.entry || '') !== String(entry);
  });

  if (requiresFullRerender) {
    renderPositions();
    return;
  }
  
  positions.forEach(({ metrics }, idx) => {
    const { mark, pnl, roePct, positionValue } = metrics;
    const sizeUsd = positionValue;
    const pnlCol = pnl >= 0 ? 'var(--text)' : 'var(--text2)';
    
    const row = existingRows[idx];
    if (row) {
      const pnlCell = row.querySelector('[data-field="pnl"]');
      const roeCell = row.querySelector('[data-field="roe"]');
      const sizeCell = row.querySelector('[data-field="size"]');
      const markCell = row.querySelector('[data-field="mark"]');
      
      if (pnlCell) {
        pnlCell.textContent = (pnl >= 0 ? '+' : '') + (hideValues ? '$xxxxx' : '$' + pnl.toFixed(2));
        pnlCell.style.color = pnlCol;
      }
      if (roeCell) {
        roeCell.textContent = roePct != null ? roePct.toFixed(2) + '%' : '—';
        roeCell.style.color = pnlCol;
      }
      if (sizeCell) sizeCell.textContent = hideValues ? '$xxxxx' : '$' + fmtVol(sizeUsd);
      if (markCell) markCell.textContent = fmtPrice(mark, metrics.position.coin);
    }
  });
}

export {
  renderPositions,
  renderPositionsIncremental,
};
