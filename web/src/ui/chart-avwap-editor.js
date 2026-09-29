/**
 * On-chart Bands / σ editor for the selected manual anchored VWAP.
 * Lives on chartWrap next to the origin marker so options can be changed
 * without reopening IND.
 */

import { manualAnchoredVwapOverlay } from '../chart/lightweight-chart.js';

const EDITOR_CLASS = 'avwap-anchor-editor';
const OFFSET_X = 18;
const OFFSET_Y = 16;

let editorEl = null;
let bandsInput = null;
let sigmaSelect = null;

function createEditor() {
  const root = document.createElement('div');
  root.className = EDITOR_CLASS;
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Anchored VWAP options');

  const bandsLabel = document.createElement('label');
  bandsLabel.className = 'avwap-anchor-editor-bands';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.changeAction = 'onToggleManualAnchoredVwapBands';
  input.dataset.passEl = 'true';
  bandsLabel.append('Bands ', input);

  const select = document.createElement('select');
  select.dataset.changeAction = 'onChangeManualAnchoredVwapSigma';
  select.dataset.passEl = 'true';
  select.setAttribute('aria-label', 'Standard deviation');
  for (const sigma of [1, 2, 3, 4]) {
    const option = document.createElement('option');
    option.value = String(sigma);
    option.textContent = `${sigma}σ`;
    select.appendChild(option);
  }

  root.append(bandsLabel, select);
  root.addEventListener('mousedown', (event) => event.stopPropagation());
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('click', (event) => event.stopPropagation());
  return { root, input, select };
}

function ensureEditor() {
  const wrap = document.getElementById('chartWrap');
  if (!wrap) return null;
  if (editorEl?.isConnected && editorEl.parentElement === wrap) return editorEl;
  const created = createEditor();
  editorEl = created.root;
  bandsInput = created.input;
  sigmaSelect = created.select;
  wrap.appendChild(editorEl);
  return editorEl;
}

function hideEditor() {
  if (editorEl) editorEl.style.display = 'none';
}

function positionEditor(point) {
  const wrap = document.getElementById('chartWrap');
  if (!wrap || !editorEl || !point) return;
  const width = editorEl.offsetWidth || 132;
  const height = editorEl.offsetHeight || 28;
  const maxLeft = Math.max(8, wrap.clientWidth - width - 8);
  const maxTop = Math.max(8, wrap.clientHeight - height - 8);
  const left = Math.min(maxLeft, Math.max(8, Number(point.x) + OFFSET_X));
  const top = Math.min(maxTop, Math.max(8, Number(point.y) + OFFSET_Y));
  editorEl.style.left = `${Math.round(left)}px`;
  editorEl.style.top = `${Math.round(top)}px`;
}

export function syncAnchorEditor() {
  const root = ensureEditor();
  if (!root) return;
  const selected = typeof manualAnchoredVwapOverlay.getSelectedAnchor === 'function'
    ? manualAnchoredVwapOverlay.getSelectedAnchor()
    : null;
  const dragging = manualAnchoredVwapOverlay.isDragging?.() === true;
  const point = typeof manualAnchoredVwapOverlay.getSelectedPoint === 'function'
    ? manualAnchoredVwapOverlay.getSelectedPoint()
    : null;
  if (!selected || dragging || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    hideEditor();
    return;
  }
  bandsInput.dataset.arg = selected.id;
  sigmaSelect.dataset.arg = selected.id;
  bandsInput.checked = selected.bandsVisible === true;
  sigmaSelect.value = String(selected.sigma || 2);
  root.style.display = 'flex';
  positionEditor(point);
}

export function repositionAnchorEditor() {
  if (!editorEl || editorEl.style.display === 'none') return;
  const point = typeof manualAnchoredVwapOverlay.getSelectedPoint === 'function'
    ? manualAnchoredVwapOverlay.getSelectedPoint()
    : null;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    hideEditor();
    return;
  }
  positionEditor(point);
}

export function initAnchorEditor() {
  ensureEditor();
  hideEditor();
  manualAnchoredVwapOverlay.setOnSelectionChange?.(syncAnchorEditor);
  manualAnchoredVwapOverlay.setOnViewChange?.(syncAnchorEditor);
  syncAnchorEditor();
}
