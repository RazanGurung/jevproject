/**
 * Drawing-tool toolbar glue — tools live in a single-row strip in the
 * funding/OI bar above the chart. Hidden by default; the header Draw button
 * toggles visibility. AppState.ui.activeDrawingTool is the source of truth for
 * the armed tool; the overlay drives it via onActiveToolChange.
 *
 * Tools stay armed after each placement (keep-drawing) until Off / Escape /
 * another tool is chosen.
 */

import { AppState, setActiveDrawingTool, setDrawingPanelVisible } from '../state/store.js';
import { drawingToolsOverlay, manualAnchoredVwapOverlay } from '../chart/lightweight-chart.js';
import { clearToasts } from './toast.js';

const TOOL_BUTTON_SELECTOR = '[data-action="selectDrawingTool"]';
const OFF_BUTTON_SELECTOR = '[data-action="clearDrawingTool"]';

function toolDisplayName(tool, selectedButton) {
  if (!selectedButton) return tool;
  const fromData = selectedButton.dataset.label?.trim();
  if (fromData) return fromData;
  const fromSpan = selectedButton.querySelector('.drawing-btn-label')?.textContent?.trim();
  if (fromSpan) return fromSpan;
  return selectedButton.title?.trim() || selectedButton.textContent?.trim() || tool;
}

function isStripOpen() {
  return AppState.ui.drawingPanelVisible === true;
}

function syncToggleButton() {
  const btn = document.getElementById('drawingToggleBtn');
  if (!btn) return;
  const open = isStripOpen();
  const tool = AppState.ui.activeDrawingTool;
  const selectedButton = tool
    ? document.querySelector(`${TOOL_BUTTON_SELECTOR}[data-arg="${tool}"]`)
    : null;
  const label = document.getElementById('drawingToggleLabel');
  btn.classList.toggle('active', open);
  btn.classList.toggle('tool-armed', tool != null);
  btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  if (label) label.textContent = tool ? `Draw: ${toolDisplayName(tool, selectedButton)}` : 'Draw';
}

function syncStripVisibility() {
  const open = isStripOpen();
  const bar = document.getElementById('chartDrawBar') || document.querySelector('.chart-draw-bar');
  const panel = document.getElementById('drawingToolsPanel');
  if (bar) bar.classList.toggle('tools-open', open);
  if (panel) {
    if (open) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  }
  setDrawingPanelVisible(open);
  syncToggleButton();
}

export function syncDrawingToolButtons() {
  const active = AppState.ui.activeDrawingTool;
  document.querySelectorAll(TOOL_BUTTON_SELECTOR).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.arg === active);
  });
  const offBtn = document.querySelector(OFF_BUTTON_SELECTOR);
  if (offBtn) {
    const off = active == null;
    offBtn.classList.toggle('active', off);
    offBtn.setAttribute('aria-pressed', off ? 'true' : 'false');
  }
  syncToggleButton();
}

export function toggleDrawingTools() {
  setDrawingPanelVisible(!isStripOpen());
  syncStripVisibility();
}

export function onSelectDrawingTool(tool) {
  const next = AppState.ui.activeDrawingTool === tool ? null : tool;
  // Placement modes are mutually exclusive. Otherwise an armed manual VWAP
  // anchor steals the first click while the newly selected drawing stays armed
  // and unexpectedly consumes the next one.
  if (next) manualAnchoredVwapOverlay.setPlacementActive(false);
  // The overlay fires onActiveToolChange, which updates the store + buttons.
  drawingToolsOverlay.setActiveTool(next);
  // Ensure the strip is visible when arming a tool from it.
  if (next && !isStripOpen()) {
    setDrawingPanelVisible(true);
    syncStripVisibility();
  } else {
    syncToggleButton();
  }
}

/** Explicit Off: disarm the active tool (pointer / select mode). */
export function onClearDrawingTool() {
  drawingToolsOverlay.setActiveTool(null);
  syncDrawingToolButtons();
}

export function onClearDrawings() {
  drawingToolsOverlay.clearAll();
  drawingToolsOverlay.setActiveTool(null);
  syncDrawingToolButtons();
}

export function onClearMessagesAndDrawings() {
  clearToasts();
  onClearDrawings();
}

export function initDrawingToolUI() {
  setActiveDrawingTool(null);
  setDrawingPanelVisible(AppState.ui.drawingPanelVisible ?? true);
  document.querySelectorAll('#drawingToolsPanel button').forEach((btn) => {
    btn.setAttribute('role', 'button');
  });
  drawingToolsOverlay.setOnActiveToolChange((tool) => {
    setActiveDrawingTool(tool);
    syncDrawingToolButtons();
  });
  syncStripVisibility();
  syncDrawingToolButtons();
}
