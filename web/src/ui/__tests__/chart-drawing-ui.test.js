/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const drawingMock = vi.hoisted(() => {
  let onChange = null;
  return {
    overlay: {
      setOnActiveToolChange: vi.fn((cb) => { onChange = cb; }),
      setActiveTool: vi.fn((tool) => onChange?.(tool)),
      clearAll: vi.fn(),
    },
    manualOverlay: {
      setPlacementActive: vi.fn(),
    },
    reset() {
      onChange = null;
      this.overlay.setOnActiveToolChange.mockClear();
      this.overlay.setActiveTool.mockClear();
      this.overlay.clearAll.mockClear();
      this.manualOverlay.setPlacementActive.mockClear();
    },
  };
});

vi.mock('../../chart/lightweight-chart.js', () => ({
  drawingToolsOverlay: drawingMock.overlay,
  manualAnchoredVwapOverlay: drawingMock.manualOverlay,
}));

const { clearToasts } = vi.hoisted(() => ({
  clearToasts: vi.fn(),
}));
vi.mock('../toast.js', () => ({
  clearToasts,
}));

import {
  initDrawingToolUI,
  onClearDrawingTool,
  onClearMessagesAndDrawings,
  onSelectDrawingTool,
  toggleDrawingTools,
} from '../chart-drawing-ui.js';

beforeEach(() => {
  drawingMock.reset();
  document.body.innerHTML = `
    <button id="drawingToggleBtn" aria-pressed="false"><span id="drawingToggleLabel">Draw</span></button>
    <div class="funding-bar chart-draw-bar" id="chartDrawBar">
      <div class="drawing-toolbar" id="drawingToolsPanel" hidden>
        <button class="drawing-btn drawing-btn-off" data-action="clearDrawingTool" data-label="Off">Off</button>
        <button class="drawing-btn" data-action="selectDrawingTool" data-arg="trendline" data-label="Trend line">Trend line</button>
        <button class="drawing-btn" data-action="selectDrawingTool" data-arg="box" data-label="Box">Box</button>
      </div>
      <div class="funding-meta">
        <span class="funding-val" id="fundingVal">—</span>
        <span class="funding-oi">OI <span id="oiVal">—</span></span>
      </div>
    </div>
  `;
  initDrawingToolUI();
});

describe('drawing toolbar strip', () => {
  it('shows tools by default and hides them when Draw is toggled', () => {
    const bar = document.getElementById('chartDrawBar');
    const panel = document.getElementById('drawingToolsPanel');
    const trigger = document.getElementById('drawingToggleBtn');

    expect(bar.classList.contains('tools-open')).toBe(true);
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(trigger.classList.contains('active')).toBe(true);

    toggleDrawingTools();
    expect(bar.classList.contains('tools-open')).toBe(false);
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(trigger.classList.contains('active')).toBe(false);
    expect(trigger.getAttribute('aria-pressed')).toBe('false');

    toggleDrawingTools();
    expect(bar.classList.contains('tools-open')).toBe(true);
    expect(panel.hasAttribute('hidden')).toBe(false);
  });

  it('arms a tool and labels the Draw trigger', () => {
    onSelectDrawingTool('trendline');
    expect(drawingMock.manualOverlay.setPlacementActive).toHaveBeenCalledWith(false);
    expect(document.querySelector('[data-arg="trendline"]').classList.contains('active')).toBe(true);
    expect(document.getElementById('drawingToggleBtn').classList.contains('tool-armed')).toBe(true);
    expect(document.getElementById('drawingToggleLabel').textContent).toBe('Draw: Trend line');
  });

  it('turns drawing off from the Off control', () => {
    onSelectDrawingTool('trendline');
    onClearDrawingTool();
    expect(drawingMock.overlay.setActiveTool).toHaveBeenLastCalledWith(null);
    expect(document.querySelector('[data-action="clearDrawingTool"]').classList.contains('active')).toBe(true);
    expect(document.getElementById('drawingToggleLabel').textContent).toBe('Draw');
  });

  it('clears messages and every chart drawing from the shared topbar action', () => {
    onClearMessagesAndDrawings();

    expect(clearToasts).toHaveBeenCalledTimes(1);
    expect(drawingMock.overlay.clearAll).toHaveBeenCalledTimes(1);
    expect(drawingMock.overlay.setActiveTool).toHaveBeenCalledWith(null);
  });
});
