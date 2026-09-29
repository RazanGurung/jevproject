/**
 * Orders rendering - open orders rendering, selection, and bulk actions
 */

import { AppState } from '../state/store.js';
import { getOpenOrderViewModels } from '../state/account-state.js';
import { fmtVol, fmtPrice } from '../utils/format.js';
import { escapeHtml } from '../utils/html.js';
import { getPaletteColor } from '../services/color-palette.js';

function useMobileCards() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(max-width: 767px)')?.matches || window.innerWidth <= 767;
}

function renderOpenOrders() {
  const walletAddress = AppState.account.walletAddress;
  const hideValues = AppState.ui.hideValues;
  const orders = getOpenOrderViewModels();

  const $ = id => document.getElementById(id);
  const bottomContent = $('bottomContent');
  if (!bottomContent) return;
  
  if (!orders.length) {
    bottomContent.innerHTML = '<div class="empty-state">' + (walletAddress ? 'No open orders' : 'Connect wallet to view orders') + '</div>';
    return;
  }

  if (useMobileCards()) {
    let html = `
      <div class="mobile-account-toolbar">
        <div class="mobile-account-toolbar-left">
          <label class="mobile-account-check">
            <input type="checkbox" id="selectAll" data-change-action="toggleSelectAll">
            <span>Select All</span>
          </label>
          <span id="selectedCount" class="mobile-account-card-subtitle">0 selected</span>
        </div>
        <button class="mobile-action-btn danger" data-action="bulkCancelSelected" data-pass-el="true">Cancel</button>
      </div>
      <div class="mobile-account-list">
    `;

    orders.forEach(({ order: o, isBuy, sideLabel, sizeUsd, type, price }) => {
      const sideClass = isBuy ? 'buy' : 'sell';
      const canModify = type === 'Limit';
      const coin = escapeHtml(o.coin);
      const oid = escapeHtml(o.oid);
      const side = escapeHtml(o.side);
      const size = escapeHtml(o.sz);
      const orderPrice = escapeHtml(price);
      const sideText = escapeHtml(sideLabel);
      const typeText = escapeHtml(type);

      html += `
        <div class="mobile-account-card" id="order-${oid}">
          <div class="mobile-account-card-head">
            <div>
              <div class="mobile-account-card-title" data-action="switchCoin" data-arg="${coin}" style="cursor:pointer;text-decoration:underline;">${coin}</div>
              <div class="mobile-account-card-subtitle">${sideText} ${typeText}</div>
            </div>
            <div class="mobile-account-badge ${sideClass}">${typeText}</div>
          </div>
          <div class="mobile-account-grid">
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Size</span>
              <span class="mobile-account-value">${hideValues ? '$xxxxx' : '$' + fmtVol(sizeUsd)}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Price</span>
              <span class="mobile-account-value">${fmtPrice(price, o.coin)}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Side</span>
              <span class="mobile-account-value" style="color:${getPaletteColor(isBuy ? 'bullish' : 'bearish')};">${sideText}</span>
            </div>
            <div class="mobile-account-kv">
              <span class="mobile-account-label">Select</span>
              <label class="mobile-account-check">
                <input type="checkbox" class="order-select" data-oid="${oid}" data-coin="${coin}" data-side="${side}" data-sz="${size}" data-px="${orderPrice}" data-isbuy="${isBuy}" data-reduceonly="${o.reduceOnly === true}" data-change-action="updateSelectedCount">
                <span>Queue</span>
              </label>
            </div>
          </div>
          <div class="mobile-account-actions">
            ${canModify
              ? `<button class="mobile-action-btn" data-action="showModifyModal" data-arg="${oid}" data-arg2="${coin}" data-arg3="${isBuy}" data-arg4="${size}" data-pass-value="false" data-arg5="${orderPrice}" data-arg6="${o.reduceOnly === true}">Modify</button>`
              : ''
            }
            <button class="mobile-action-btn danger" data-action="cancelOid" data-arg="${coin}" data-arg2="${oid}">Cancel</button>
          </div>
        </div>
      `;
    });

    html += '</div>';
    bottomContent.innerHTML = html;
    return;
  }

  let html = '<table class="data-table"><thead><tr><th><input type="checkbox" id="selectAll" data-change-action="toggleSelectAll"></th><th>Coin</th><th>Side</th><th>Size (USD)</th><th>Price</th><th>Type</th><th>Actions</th></tr></thead><tbody>';
  
  orders.forEach(({ order: o, isBuy, sideLabel, sizeUsd, type, price }) => {
    const col = getPaletteColor(isBuy ? 'bullish' : 'bearish');
    const canModify = type === 'Limit';
    const coin = escapeHtml(o.coin);
    const oid = escapeHtml(o.oid);
    const side = escapeHtml(o.side);
    const size = escapeHtml(o.sz);
    const orderPrice = escapeHtml(price);
    const sideText = escapeHtml(sideLabel);
    const typeText = escapeHtml(type);
    
    html += `<tr id="order-${oid}">
      <td><input type="checkbox" class="order-select" data-oid="${oid}" data-coin="${coin}" data-side="${side}" data-sz="${size}" data-px="${orderPrice}" data-isbuy="${isBuy}" data-reduceonly="${o.reduceOnly === true}" data-change-action="updateSelectedCount"></td>
      <td style="color:var(--text);cursor:pointer;text-decoration:underline;" data-action="switchCoin" data-arg="${coin}">${coin}</td>
      <td style="color:${col}">${sideText}</td>
      <td data-field="size" style="color:var(--text)">${hideValues ? '$xxxxx' : '$' + fmtVol(sizeUsd)}</td>
      <td data-field="price">${fmtPrice(price, o.coin)}</td>
      <td style="color:var(--text3)">${typeText}</td>
      <td style="display:flex;gap:4px;">
        ${canModify
          ? `<button data-action="showModifyModal" data-arg="${oid}" data-arg2="${coin}" data-arg3="${isBuy}" data-arg4="${size}" data-pass-value="false" data-arg5="${orderPrice}" data-arg6="${o.reduceOnly === true}" style="background:var(--blue);border:none;color:#fff;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:9px;font-family:var(--mono);font-weight:600;">Modify</button>`
          : ''
        }
        <button data-action="cancelOid" data-arg="${coin}" data-arg2="${oid}" style="background:var(--red2);border:none;color:#000;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:9px;font-family:var(--mono);font-weight:600;">Cancel</button>
      </td>
    </tr>`;
  });
  
  html += '</tbody></table>';
  html += `<div style="padding:8px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;">
    <button data-action="bulkCancelSelected" data-pass-el="true" style="background:var(--red2);border:none;color:#000;border-radius:3px;padding:6px 12px;cursor:pointer;font-size:10px;font-family:var(--mono);font-weight:600;">Cancel Selected</button>
    <span id="selectedCount" style="color:var(--text3);font-size:9px;">0 selected</span>
  </div>`;
  
  bottomContent.innerHTML = html;
}

function renderOpenOrdersIncremental() {
  const walletAddress = AppState.account.walletAddress;
  const orders = getOpenOrderViewModels();

  const $ = id => document.getElementById(id);
  const bottomContent = $('bottomContent');
  if (!bottomContent) return;

  if (useMobileCards()) {
    renderOpenOrders();
    return;
  }

  if (!orders.length) {
    renderOpenOrdersEmpty();
    return;
  }

  // Quick update of existing rows
  const existingRows = bottomContent.querySelectorAll('tbody tr');
  if (existingRows.length === 0) {
    renderOpenOrders();
    return;
  }

  // If orders changed, re-render completely
  if (existingRows.length !== orders.length) {
    renderOpenOrders();
    return;
  }

  // Fall back to a full re-render when any row identity or display-critical field changed.
  const requiresFullRerender = orders.some(({ order: o, isBuy, type, price }, idx) => {
    const row = existingRows[idx];
    if (!row) return true;
    const checkbox = row.querySelector('.order-select');
    if (!checkbox) return true;
    return String(checkbox.dataset.oid || '') !== String(o.oid || '')
      || String(checkbox.dataset.coin || '') !== String(o.coin || '')
      || String(checkbox.dataset.side || '') !== String(o.side || '')
      || String(checkbox.dataset.px || '') !== String(price)
      || String(checkbox.dataset.isbuy || '') !== String(isBuy)
      || row.querySelector('[data-field="price"]')?.textContent !== fmtPrice(price, o.coin)
      || row.querySelector('td:nth-child(6)')?.textContent !== type;
  });

  if (requiresFullRerender) {
    renderOpenOrders();
    return;
  }

  // Update value-only cells in place when the row signature is unchanged.
  orders.forEach(({ sizeUsd }, idx) => {
    const row = existingRows[idx];
    if (row) {
      const sizeCell = row.querySelector('[data-field="size"]');
      if (sizeCell) {
        sizeCell.textContent = AppState.ui.hideValues ? '$xxxxx' : '$' + fmtVol(sizeUsd);
      }
    }
  });
}

function toggleSelectAll() {
  const master = document.getElementById('selectAll');
  if (!master) return;
  
  document.querySelectorAll('.order-select').forEach(cb => cb.checked = master.checked);
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = document.querySelectorAll('.order-select:checked').length;
  const el = document.getElementById('selectedCount');
  if (el) el.textContent = `${count} selected`;
}

function renderOpenOrdersEmpty() {
  const $ = id => document.getElementById(id);
  const walletAddress = AppState.account.walletAddress;
  const bottomContent = $('bottomContent');
  if (bottomContent) {
    bottomContent.innerHTML = '<div class="empty-state">' + (walletAddress ? 'No open orders' : 'Connect wallet to view orders') + '</div>';
  }
}

export {
  renderOpenOrders,
  renderOpenOrdersIncremental,
  toggleSelectAll,
  updateSelectedCount,
  renderOpenOrdersEmpty
};
