/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingToolsRouter, CVD_TOOLS } from '../drawing-router.js';
import { loadDrawings } from '../drawing-tools.js';

// Identity-mapped chart/series (pixel === { time, price }). Three stacked panes:
// price on top, then the CVD histogram, then the CVD oscillator at the bottom.
// chartElement spans y ∈ [0, 1000]; the CVD band is y ∈ [600, 800] and the
// oscillator band is y ∈ [800, 1000]. Each pane's band is derived from its DOM
// element's position relative to the chart element, so a click at global y=850
// is pane-local y=50 on the oscillator series.
const CHART_H = 1000;
const CVD_H = 200;
const OSC_H = 200;
const CVD_TOP = CHART_H - OSC_H - CVD_H; // 600
const OSC_TOP = CHART_H - OSC_H;         // 800

function makeSeries() {
  let captured = null;
  return {
    attachPrimitive: vi.fn((p) => { captured = p; }),
    detachPrimitive: vi.fn(),
    priceToCoordinate: vi.fn((p) => p),
    coordinateToPrice: vi.fn((y) => y),
    data: vi.fn(() => [{ time: 1 }, { time: 2 }]),
    getCaptured: () => captured,
  };
}

// A lower-pane stub positioned at [top, top+height] relative to the chart
// element (whose top is 0), exposed via getHTMLElement().getBoundingClientRect().
function makePane(top, height) {
  return {
    getHeight: vi.fn(() => height),
    getHTMLElement: () => ({ getBoundingClientRect: () => ({ top, height }) }),
  };
}

function makeRouter() {
  const timeScale = {
    coordinateToTime: vi.fn((x) => x),
    coordinateToLogical: vi.fn((x) => x),
    timeToIndex: vi.fn((t) => t),
    logicalToCoordinate: vi.fn((l) => l),
    height: vi.fn(() => 0),
  };
  const cvdPane = makePane(CVD_TOP, CVD_H);
  const oscPane = makePane(OSC_TOP, OSC_H);
  const mainSeries = makeSeries();
  const cvdSeries = { ...makeSeries(), getPane: () => cvdPane };
  const oscSeries = { ...makeSeries(), getPane: () => oscPane };
  const chart = {
    timeScale: () => timeScale,
    applyOptions: vi.fn(),
    chartElement: () => ({ clientHeight: CHART_H, getBoundingClientRect: () => ({ top: 0, height: CHART_H }) }),
  };
  const router = createDrawingToolsRouter({
    getChart: () => chart,
    getMainSeries: () => mainSeries,
    getCvdSeries: () => cvdSeries,
    getOscillatorSeries: () => oscSeries,
  });
  return { router, mainSeries, cvdSeries, oscSeries };
}

beforeEach(() => localStorage.clear());

describe('drawing-tools router', () => {
  it('restricts the CVD pane to lines & shapes (no fib/measure/positions)', () => {
    expect(CVD_TOOLS.has('trendline')).toBe(true);
    expect(CVD_TOOLS.has('curve')).toBe(true);
    expect(CVD_TOOLS.has('pencil')).toBe(true);
    expect(CVD_TOOLS.has('fib')).toBe(false);
    expect(CVD_TOOLS.has('measure')).toBe(false);
    expect(CVD_TOOLS.has('longPosition')).toBe(false);
  });

  it('places a price-pane drawing when the click is above the CVD band', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('trendline');
    router.onClick(10, 100); // y=100 → price pane
    router.onClick(30, 150);
    expect(router._overlays.main.getState().drawings).toHaveLength(1);
    expect(router._overlays.cvd.getState().drawings).toHaveLength(0);
    expect(router.isToolActive()).toBe(true);
  });

  it('routes a click in the (middle) CVD band to the CVD overlay with pane-local Y', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    router.onClick(20, CVD_TOP + 50); // global y=650 → cvd-local y=50
    const cvdDrawings = router._overlays.cvd.getState().drawings;
    expect(cvdDrawings).toHaveLength(1);
    expect(cvdDrawings[0].points[0].price).toBe(50); // translated to pane-local
    expect(router._overlays.main.getState().drawings).toHaveLength(0);
    expect(router._overlays.oscillator.getState().drawings).toHaveLength(0);
  });

  it('keeps a multi-click placement locked to the pane it began in', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('trendline');
    router.onClick(10, 100);             // first point on price pane
    router.onClick(30, CVD_TOP + 20);    // cursor wandered into CVD band
    // Both points landed on the price overlay; nothing on CVD.
    expect(router._overlays.main.getState().drawings).toHaveLength(1);
    expect(router._overlays.cvd.getState().drawings).toHaveLength(0);
  });

  it('commits a zigzag via double-click on the pane the placement locked to', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('zigzag');
    router.onClick(10, CVD_TOP + 20);   // placement starts (and locks) on CVD
    router.onClick(30, CVD_TOP + 60);
    router.onClick(50, CVD_TOP + 30);
    // Double-click in the price pane's band still commits on the locked CVD pane.
    expect(router.onDblClick(50, 100)).toBe(true);
    expect(router._overlays.cvd.getState().drawings).toHaveLength(1);
    expect(router._overlays.cvd.getState().drawings[0].type).toBe('zigzag');
    expect(router._overlays.main.getState().drawings).toHaveLength(0);
    expect(router.isToolActive()).toBe(true);
  });

  it('persists CVD drawings under a separate :cvd storage key', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    router.onClick(5, CVD_TOP + 30);
    expect(loadDrawings('BTC', ':cvd')).toHaveLength(1); // cvd key
    expect(loadDrawings('BTC')).toHaveLength(0);         // price key untouched
  });

  it('ignores price-only tools on the CVD pane but allows them on price', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    // Fib is not a CVD tool: clicks in the CVD band create nothing there.
    router.setActiveTool('fib');
    router.onClick(10, CVD_TOP + 40);
    router.onClick(30, CVD_TOP + 60);
    expect(router._overlays.cvd.getState().drawings).toHaveLength(0);
    // The price overlay still accepts fib (the CVD pane just declined it).
    router.setActiveTool('fib');
    router.onClick(10, 100);
    router.onClick(30, 200);
    expect(router._overlays.main.getState().drawings.some((d) => d.type === 'fib')).toBe(true);
  });

  it('reports a single active-tool change and keeps it armed after completion', () => {
    const { router } = makeRouter();
    const changes = [];
    router.setOnActiveToolChange((t) => changes.push(t));
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    router.onClick(5, 50); // completes immediately (1-click)
    expect(changes).toEqual(['horizontal']);
    expect(router.isToolActive()).toBe(true);

    router.setActiveTool(null);
    expect(changes).toEqual(['horizontal', null]);
    expect(router.isToolActive()).toBe(false);
  });

  it('routes a click in the oscillator band to the oscillator overlay with pane-local Y', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    router.onClick(20, OSC_TOP + 50); // global y=850 → oscillator-local y=50
    const oscDrawings = router._overlays.oscillator.getState().drawings;
    expect(oscDrawings).toHaveLength(1);
    expect(oscDrawings[0].points[0].price).toBe(50); // translated to pane-local
    expect(router._overlays.cvd.getState().drawings).toHaveLength(0);
    expect(router._overlays.main.getState().drawings).toHaveLength(0);
  });

  it('clears a lower-pane selection from another pane and consumes that click', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    router.onClick(20, OSC_TOP + 50);
    router.setActiveTool(null);
    expect(router.onClick(20, OSC_TOP + 50)).toBe(true);
    expect(router.hasSelection()).toBe(true);

    expect(router.onClick(20, 100)).toBe(true);
    expect(router.hasSelection()).toBe(false);
  });

  it('does not treat chart-axis space below the lower panes as price drawing space', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    expect(router.onClick(20, CHART_H + 10)).toBe(false);
    expect(router._overlays.main.getState().drawings).toHaveLength(0);
    expect(router._overlays.cvd.getState().drawings).toHaveLength(0);
    expect(router._overlays.oscillator.getState().drawings).toHaveLength(0);
    expect(router.isToolActive()).toBe(true);
  });

  it('persists oscillator drawings under a separate :osc storage key', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    router.onClick(5, OSC_TOP + 30);
    expect(loadDrawings('BTC', ':osc')).toHaveLength(1); // oscillator key
    expect(loadDrawings('BTC', ':cvd')).toHaveLength(0); // cvd key untouched
    expect(loadDrawings('BTC')).toHaveLength(0);         // price key untouched
  });

  it('captures a freehand stroke in the pane it started in', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('pencil');
    expect(router.onToolPointerDown(10, CVD_TOP + 10)).toBe(true);
    expect(router.isDragging()).toBe(true);
    router.onPointerMove(20, CVD_TOP + 30);
    router.onPointerMove(30, CVD_TOP + 20);
    router.onPointerUp();
    expect(router._overlays.cvd.getState().drawings).toHaveLength(1);
    expect(router._overlays.cvd.getState().drawings[0].type).toBe('pencil');
    expect(router._overlays.main.getState().drawings).toHaveLength(0);
  });

  it('places a center-first circle by drag in the CVD pane', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('circle');
    expect(router.onToolPointerDown(20, CVD_TOP + 50)).toBe(true);
    router.onPointerMove(30, CVD_TOP + 50);
    router.onPointerUp();
    const drawing = router._overlays.cvd.getState().drawings[0];
    expect(drawing.type).toBe('circle');
    expect(drawing.geometry).toBe('centerRadius');
    expect(drawing.points).toEqual([
      { time: 20, price: 50 },
      { time: 20, price: 60 },
    ]);
  });

  it('selects, drags, and deletes an oscillator-pane drawing in pane-local coordinates', () => {
    const { router } = makeRouter();
    router.setCoin('BTC');
    router.setActiveTool('horizontal');
    router.onClick(20, OSC_TOP + 50);
    router.setActiveTool(null);

    expect(router.onPointerDown(20, OSC_TOP + 50)).toBe(true);
    router.onPointerMove(20, OSC_TOP + 70);
    router.onPointerUp();
    expect(router._overlays.oscillator.getState().drawings[0].points[0].price).toBe(70);

    expect(router.deleteAt(20, OSC_TOP + 70)).toBe(true);
    expect(router._overlays.oscillator.getState().drawings).toHaveLength(0);
  });
});
