/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requiredPoints,
  placementPoints,
  isDrawingType,
  isFreehandType,
  isPolylineType,
  pointToSegmentDistance,
  pointToRayDistance,
  pointToLineDistance,
  pointToRectDistance,
  pointToEllipseDistance,
  pointToCircleDistance,
  pointToQuadraticDistance,
  rayExit,
  serializeDrawings,
  deserializeDrawings,
  loadDrawings,
  saveDrawings,
  createDrawingToolsOverlay,
} from '../drawing-tools.js';

// Identity-mapped chart/series: pixel coords equal { time, price } so placement
// and hit-testing are predictable. timeToIndex/logicalToCoordinate compose to
// the identity, as do priceToCoordinate/coordinateToPrice.
function createMockChart() {
  const timeScale = {
    coordinateToTime: vi.fn((x) => x),
    coordinateToLogical: vi.fn((x) => x),
    timeToIndex: vi.fn((t) => t),
    logicalToCoordinate: vi.fn((l) => l),
  };
  return {
    timeScale: () => timeScale,
    applyOptions: vi.fn(),
  };
}

function createMockSeries() {
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

function createFakeTarget() {
  const context = {
    beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), quadraticCurveTo: vi.fn(), stroke: vi.fn(),
    strokeRect: vi.fn(), fillRect: vi.fn(), ellipse: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), fillText: vi.fn(),
    setLineDash: vi.fn(), save: vi.fn(), restore: vi.fn(),
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    font: '', textAlign: '', textBaseline: '',
  };
  return {
    context,
    useBitmapCoordinateSpace: (cb) => cb({
      context,
      horizontalPixelRatio: 1,
      verticalPixelRatio: 1,
      bitmapSize: { width: 800, height: 600 },
    }),
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('geometry helpers', () => {
  it('reports per-tool point counts', () => {
    expect(requiredPoints('horizontal')).toBe(1);
    expect(requiredPoints('vertical')).toBe(1);
    expect(requiredPoints('trendline')).toBe(2);
    expect(requiredPoints('curve')).toBe(3);
    expect(requiredPoints('channel')).toBe(3);
    expect(requiredPoints('fib')).toBe(2);
    expect(requiredPoints('measure')).toBe(2);
    expect(requiredPoints('text')).toBe(1);
    expect(requiredPoints('arrow')).toBe(2);
    expect(requiredPoints('extended')).toBe(2);
    expect(requiredPoints('hray')).toBe(1);
    expect(requiredPoints('arrowUp')).toBe(1);
    expect(requiredPoints('arrowDown')).toBe(1);
    expect(requiredPoints('nope')).toBe(0);
    expect(isDrawingType('box')).toBe(true);
    expect(isDrawingType('fib')).toBe(true);
    expect(isDrawingType('pencil')).toBe(true);
    expect(isDrawingType('zigzag')).toBe(true);
    expect(isDrawingType('nope')).toBe(false);
    // A zigzag is placed vertex-by-vertex; only a double-click commits it.
    expect(isPolylineType('zigzag')).toBe(true);
    expect(isPolylineType('pencil')).toBe(false);
    expect(placementPoints('zigzag')).toBe(Infinity);
    // Zigzag is click-to-vertex, not a press-drag freehand stroke.
    expect(isFreehandType('zigzag')).toBe(false);
    expect(isFreehandType('pencil')).toBe(true);
  });

  it('measures distance to an infinite line (unbounded both ways)', () => {
    expect(pointToLineDistance(5, 5, 0, 0, 10, 0)).toBeCloseTo(5);
    // Far past either endpoint is still on the line → ~0.
    expect(pointToLineDistance(100, 0, 0, 0, 10, 0)).toBeCloseTo(0);
    expect(pointToLineDistance(-100, 0, 0, 0, 10, 0)).toBeCloseTo(0);
  });

  it('measures point-to-segment distance', () => {
    expect(pointToSegmentDistance(5, 5, 0, 0, 10, 0)).toBeCloseTo(5);
    // Beyond the segment clamps to the nearer endpoint.
    expect(pointToSegmentDistance(20, 0, 0, 0, 10, 0)).toBeCloseTo(10);
  });

  it('treats a ray as unbounded past its second point', () => {
    // A point far past B is on the ray → distance ~0, unlike a segment.
    expect(pointToRayDistance(100, 0, 0, 0, 10, 0)).toBeCloseTo(0);
    expect(pointToSegmentDistance(100, 0, 0, 0, 10, 0)).toBeCloseTo(90);
  });

  it('measures distance to a rectangle outline', () => {
    // Inside the box, nearest edge is 2 away.
    expect(pointToRectDistance(2, 5, 0, 0, 10, 10)).toBeCloseTo(2);
    // On an edge → 0.
    expect(pointToRectDistance(0, 5, 0, 0, 10, 10)).toBeCloseTo(0);
  });

  it('measures distance to an ellipse outline', () => {
    // Center is ~min-radius away from the outline.
    expect(pointToEllipseDistance(5, 5, 0, 0, 10, 10)).toBeCloseTo(5);
    // On the outline (right vertex) → ~0.
    expect(pointToEllipseDistance(10, 5, 0, 0, 10, 10)).toBeCloseTo(0);
  });

  it('measures center-radius circles and quadratic curves', () => {
    expect(pointToCircleDistance(10, 5, 5, 5, 10, 5)).toBeCloseTo(0);
    expect(pointToCircleDistance(5, 5, 5, 5, 10, 5)).toBeCloseTo(5);
    const start = { x: 0, y: 0 };
    const end = { x: 10, y: 0 };
    const control = { x: 5, y: 10 };
    // Quadratic midpoint at t=.5 is (5,5).
    expect(pointToQuadraticDistance(5, 5, start, end, control)).toBeLessThan(0.1);
  });

  it('clips a ray to the rect bounds', () => {
    const exit = rayExit(0, 0, 1, 0, 800, 600);
    expect(exit.x).toBeCloseTo(800);
    expect(exit.y).toBeCloseTo(0);
  });
});

describe('serialization + store', () => {
  it('round-trips valid drawings', () => {
    const list = [
      { id: 'a', type: 'trendline', points: [{ time: 1, price: 2 }, { time: 3, price: 4 }], color: '#fff' },
    ];
    const back = deserializeDrawings(serializeDrawings(list));
    expect(back).toHaveLength(1);
    expect(back[0].type).toBe('trendline');
    expect(back[0].points).toEqual([{ time: 1, price: 2 }, { time: 3, price: 4 }]);
  });

  it('drops unknown types and incomplete point sets on load', () => {
    const json = JSON.stringify([
      { type: 'banana', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] }, // unknown
      { type: 'trendline', points: [{ time: 1, price: 1 }] }, // too few points
      { type: 'horizontal', points: [{ time: 1, price: 1 }] }, // valid
    ]);
    const back = deserializeDrawings(json);
    expect(back).toHaveLength(1);
    expect(back[0].type).toBe('horizontal');
  });

  it('round-trips a text label (with font size) and a variable-length pencil path', () => {
    const list = [
      { id: 't', type: 'text', points: [{ time: 1, price: 2 }], text: 'hi', fontSize: 20 },
      { id: 'p', type: 'pencil', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }, { time: 3, price: 1 }] },
    ];
    const back = deserializeDrawings(serializeDrawings(list));
    expect(back).toHaveLength(2);
    expect(back[0].text).toBe('hi');
    expect(back[0].fontSize).toBe(20);
    expect(back[1].type).toBe('pencil');
    expect(back[1].points).toHaveLength(3);
  });

  it('round-trips the center-radius circle geometry while accepting legacy circles', () => {
    const list = [
      { id: 'new', type: 'circle', geometry: 'centerRadius', points: [{ time: 5, price: 5 }, { time: 10, price: 5 }] },
      { id: 'old', type: 'circle', points: [{ time: 0, price: 0 }, { time: 10, price: 10 }] },
    ];
    const back = deserializeDrawings(serializeDrawings(list));
    expect(back[0].geometry).toBe('centerRadius');
    expect(back[1].geometry).toBeUndefined();
  });

  it('drops a pencil path with fewer than 2 points', () => {
    const json = JSON.stringify([{ type: 'pencil', points: [{ time: 1, price: 1 }] }]);
    expect(deserializeDrawings(json)).toHaveLength(0);
  });

  it('round-trips a variable-length zigzag and drops a 1-point one', () => {
    const list = [
      { id: 'z', type: 'zigzag', points: [{ time: 1, price: 1 }, { time: 2, price: 5 }, { time: 3, price: 2 }, { time: 4, price: 8 }] },
    ];
    const back = deserializeDrawings(serializeDrawings(list));
    expect(back).toHaveLength(1);
    expect(back[0].points).toHaveLength(4);
    const short = JSON.stringify([{ type: 'zigzag', points: [{ time: 1, price: 1 }] }]);
    expect(deserializeDrawings(short)).toHaveLength(0);
  });

  it('serializes and persists measure drawings like other drawing tools', () => {
    const list = [
      { id: 'm', type: 'measure', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] },
      { id: 'h', type: 'horizontal', points: [{ time: 1, price: 1 }] },
    ];
    const back = deserializeDrawings(serializeDrawings(list));
    expect(back).toHaveLength(2);
    expect(back[0].type).toBe('measure');
    expect(back[1].type).toBe('horizontal');
  });

  it('returns [] for malformed json', () => {
    expect(deserializeDrawings('{not json')).toEqual([]);
    expect(deserializeDrawings('')).toEqual([]);
  });

  it('persists drawings per coin in localStorage', () => {
    const btc = [{ id: 'a', type: 'horizontal', points: [{ time: 1, price: 100 }] }];
    saveDrawings('BTC', btc);
    expect(loadDrawings('BTC')).toHaveLength(1);
    expect(loadDrawings('ETH')).toHaveLength(0);
    expect(localStorage.getItem('pez:drawings:BTC')).toBeTruthy();
  });

  it('removes the key when saving an empty list', () => {
    saveDrawings('BTC', [{ id: 'a', type: 'horizontal', points: [{ time: 1, price: 1 }] }]);
    saveDrawings('BTC', []);
    expect(localStorage.getItem('pez:drawings:BTC')).toBeNull();
  });
});

describe('drawing overlay', () => {
  function makeOverlay() {
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createDrawingToolsOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
    });
    return { overlay, chart, series };
  }

  // Like makeOverlay, but the time scale has a finite data edge: coordinateToTime
  // is null for x outside [0, 100) (the future whitespace, or the left off-data),
  // and the series exposes its last two bars (interval 1, last index 99) so a
  // future time can be extrapolated — mirroring the live chart past the last bar.
  function makeFutureOverlay() {
    const timeScale = {
      coordinateToTime: vi.fn((x) => (x >= 0 && x < 100 ? x : null)),
      coordinateToLogical: vi.fn((x) => x),
      timeToIndex: vi.fn((t) => t),
      logicalToCoordinate: vi.fn((l) => l),
    };
    const chart = { timeScale: () => timeScale, applyOptions: vi.fn() };
    let captured = null;
    const series = {
      attachPrimitive: vi.fn((p) => { captured = p; }), detachPrimitive: vi.fn(),
      priceToCoordinate: vi.fn((p) => p), coordinateToPrice: vi.fn((y) => y),
      data: vi.fn(() => [{ time: 98 }, { time: 99 }]),
      getCaptured: () => captured,
    };
    const overlay = createDrawingToolsOverlay({ getChart: () => chart, getCandleSeries: () => series });
    return { overlay, chart, series };
  }

  it('attaches one primitive and detaches cleanly', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    expect(series.attachPrimitive).toHaveBeenCalledTimes(1);
    overlay.detach();
    expect(series.detachPrimitive).toHaveBeenCalledTimes(1);
  });

  it('places a 2-click trendline and keeps the tool armed for the next shape', () => {
    const { overlay, chart } = makeOverlay();
    const changes = [];
    overlay.setOnActiveToolChange((t) => changes.push(t));
    overlay.setCoin('BTC');

    overlay.setActiveTool('trendline');
    expect(overlay.isToolActive()).toBe(true);
    // Native scroll disabled while drawing.
    expect(chart.applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ handleScroll: false, handleScale: false }),
    );

    expect(overlay.onClick(10, 20)).toBe(true); // first point
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.onClick(30, 40)).toBe(true); // completes
    expect(overlay.getState().drawings).toHaveLength(1);
    // Keep-drawing: tool stays armed; scroll stays off until user turns it off.
    expect(overlay.isToolActive()).toBe(true);
    expect(overlay.getState().activeTool).toBe('trendline');
    expect(changes).toEqual(['trendline']);
    expect(chart.applyOptions).toHaveBeenLastCalledWith({ handleScroll: false, handleScale: false });

    // Second trendline without re-arming.
    overlay.onClick(5, 5);
    overlay.onClick(15, 15);
    expect(overlay.getState().drawings).toHaveLength(2);
    expect(overlay.isToolActive()).toBe(true);

    overlay.setActiveTool(null);
    expect(overlay.isToolActive()).toBe(false);
    expect(changes).toEqual(['trendline', null]);
    expect(chart.applyOptions).toHaveBeenLastCalledWith({
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
        mouseWheel: true,
        pinch: true,
      },
    });
  });

  it('restores pan after a stuck drag without an armed tool', () => {
    const { overlay, chart } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onToolPointerDown(10, 10);
    // Simulate reconnect without pointerup: tool disarmed externally but drag flag lingered.
    overlay.setActiveTool(null);
    chart.applyOptions.mockClear();
    expect(overlay.releaseStuckGestures()).toBe(true);
    expect(chart.applyOptions).toHaveBeenCalledWith(expect.objectContaining({
      handleScroll: expect.objectContaining({ pressedMouseMove: true }),
    }));
  });

  it('keeps pan locked when a draw tool remains intentionally armed', () => {
    const { overlay, chart } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('horizontal');
    chart.applyOptions.mockClear();
    expect(overlay.releaseStuckGestures()).toBe(false);
    expect(chart.applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ handleScroll: false, handleScale: false }),
    );
    expect(overlay.isToolActive()).toBe(true);
  });

  it('remembers scroll intent when chart is missing then reapplies on attach', () => {
    let chartRef = null;
    const series = {
      attachPrimitive: vi.fn((p) => { p.attached?.({ requestUpdate: vi.fn() }); }),
      detachPrimitive: vi.fn(),
      priceToCoordinate: (price) => Number(price),
      coordinateToPrice: (y) => Number(y),
    };
    const overlay = createDrawingToolsOverlay({
      getChart: () => chartRef,
      getCandleSeries: () => (chartRef ? series : null),
    });
    // No chart yet — should not throw; intent still stored.
    overlay.setActiveTool('trendline');
    chartRef = {
      applyOptions: vi.fn(),
      timeScale: () => ({
        coordinateToTime: () => 100,
        timeToCoordinate: () => 10,
        timeToIndex: () => 0,
        logicalToCoordinate: () => 10,
        options: () => ({ barSpacing: 6 }),
      }),
      paneSize: () => ({ height: 200 }),
    };
    overlay.setCoin('BTC');
    expect(chartRef.applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ handleScroll: false, handleScale: false }),
    );
  });

  it('places a 1-click horizontal and a 3-click channel while staying armed', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');

    overlay.setActiveTool('horizontal');
    overlay.onClick(5, 50);
    expect(overlay.getState().drawings).toHaveLength(1);
    expect(overlay.isToolActive()).toBe(true);
    overlay.onClick(8, 60);
    expect(overlay.getState().drawings).toHaveLength(2);

    overlay.setActiveTool('channel');
    overlay.onClick(1, 1);
    overlay.onClick(10, 5);
    expect(overlay.getState().drawings).toHaveLength(2);
    overlay.onClick(5, 20);
    expect(overlay.getState().drawings).toHaveLength(3);
    expect(overlay.isToolActive()).toBe(true);
  });

  it('places a center-first circle by drag and keeps the tool armed', () => {
    const { overlay, series } = makeOverlay();
    const changes = [];
    overlay.setOnActiveToolChange((tool) => changes.push(tool));
    overlay.setCoin('BTC');
    overlay.setActiveTool('circle');

    // Circle ignores the old click-click path.
    expect(overlay.onClick(10, 10)).toBe(true);
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.onToolPointerDown(10, 10)).toBe(true); // center
    overlay.onPointerMove(13, 14);                       // radius = 5
    overlay.onPointerUp();

    const circle = overlay.getState().drawings[0];
    expect(circle.geometry).toBe('centerRadius');
    expect(circle.points).toEqual([{ time: 10, price: 10 }, { time: 10, price: 15 }]);
    expect(loadDrawings('BTC')[0].geometry).toBe('centerRadius');
    expect(overlay.isToolActive()).toBe(true);
    expect(changes).toEqual(['circle']);

    const target = createFakeTarget();
    series.getCaptured().paneViews()[0].renderer().draw(target);
    expect(target.context.ellipse).toHaveBeenCalledWith(10, 10, 5, 5, 0, 0, Math.PI * 2);
  });

  it('keeps circle size stable between price and VWAP lines when zooming in time while scaling with price changes', () => {
    const { chart, series, overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('circle');

    // Place a circle with center (100, 200) and dragged radius 20
    overlay.onToolPointerDown(100, 200);
    overlay.onPointerMove(100, 220); // radius = 20
    overlay.onPointerUp();

    const initialCircle = overlay.getState().drawings[0];
    expect(initialCircle.points).toEqual([{ time: 100, price: 200 }, { time: 100, price: 220 }]);

    // Initial render: radius = 20 (dy = 20)
    const target1 = createFakeTarget();
    series.getCaptured().paneViews()[0].renderer().draw(target1);
    expect(target1.context.ellipse).toHaveBeenCalledWith(100, 200, 20, 20, 0, 0, Math.PI * 2);

    // Zooming timeScale horizontally 10x does NOT change circle size (stays locked between price/VWAP lines)
    chart.timeScale().logicalToCoordinate.mockImplementation((t) => t * 10);
    const targetHorizZoom = createFakeTarget();
    series.getCaptured().paneViews()[0].renderer().draw(targetHorizZoom);
    expect(targetHorizZoom.context.ellipse).toHaveBeenCalledWith(1000, 200, 20, 20, 0, 0, Math.PI * 2);

    // Zooming priceScale vertically 2x scales the circle with the price/VWAP lines
    series.priceToCoordinate.mockImplementation((p) => p * 2);
    const targetPriceZoom = createFakeTarget();
    series.getCaptured().paneViews()[0].renderer().draw(targetPriceZoom);
    expect(targetPriceZoom.context.ellipse).toHaveBeenCalledWith(1000, 400, 40, 40, 0, 0, Math.PI * 2);

    // Zooming priceScale out 0.5x compresses the circle with the compressed price/VWAP lines
    series.priceToCoordinate.mockImplementation((p) => p * 0.5);
    const targetPriceZoomOut = createFakeTarget();
    series.getCaptured().paneViews()[0].renderer().draw(targetPriceZoomOut);
    expect(targetPriceZoomOut.context.ellipse).toHaveBeenCalledWith(1000, 100, 10, 10, 0, 0, Math.PI * 2);
  });

  it('edits circle center and radius independently via handles and whole-drawing drag', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('circle');

    // Place circle at center (50, 50), radius 10
    overlay.onToolPointerDown(50, 50);
    overlay.onPointerMove(50, 60);
    overlay.onPointerUp();

    overlay.setActiveTool(null); // disarm
    expect(overlay.onClick(50, 40)).toBe(true); // select circle via circumference hit
    expect(overlay.hasSelection()).toBe(true);

    // Drag edge handle (index 1) to resize from radius 10 to radius 25
    expect(overlay.onPointerDown(50, 60)).toBe(true);
    overlay.onPointerMove(50, 75); // new radius = 25
    overlay.onPointerUp();
    expect(overlay.getState().drawings[0].points).toEqual([
      { time: 50, price: 50 },
      { time: 50, price: 75 },
    ]);

    // Drag center handle (index 0) to move center from (50, 50) to (80, 90)
    expect(overlay.onPointerDown(50, 50)).toBe(true);
    overlay.onPointerMove(80, 90);
    overlay.onPointerUp();
    expect(overlay.getState().drawings[0].points).toEqual([
      { time: 80, price: 90 },
      { time: 80, price: 115 }, // radius 25 preserved!
    ]);

    // Whole-drawing move: click right circumference vertex (not a handle) and drag by dx = +10, dy = +5
    expect(overlay.onPointerDown(80 + 25, 90)).toBe(true); // hit circumference, not handle
    overlay.onPointerMove(80 + 25 + 10, 90 + 5);
    overlay.onPointerUp();
    const moved = overlay.getState().drawings[0];
    expect(moved.points[0].time).toBe(moved.points[1].time); // time alignment maintained
    expect(Math.abs(moved.points[1].price - moved.points[0].price)).toBe(25); // price radius preserved
  });

  it('edits circle smoothly across multiple sub-bar steps remaining accurate to price and time like anchor VWAP', () => {
    const { chart, overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('circle');

    // Time scale where 1 bar = 10px (time 100 = 100px, 110 = 110px)
    chart.timeScale().coordinateToTime.mockImplementation((x) => Math.floor(x / 10) * 10);
    chart.timeScale().logicalToCoordinate.mockImplementation((t) => t);

    // Place circle at center (100, 200), radius 20
    overlay.onToolPointerDown(100, 200);
    overlay.onPointerMove(100, 220);
    overlay.onPointerUp();
    overlay.setActiveTool(null);

    // Click inside circle body (not circumference) to select it
    expect(overlay.onClick(105, 205)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);

    // Move whole circle across multiple tiny 1px sub-bar steps from (105, 205) to (125, 225)
    expect(overlay.onPointerDown(105, 205)).toBe(true);
    for (let step = 1; step <= 20; step++) {
      overlay.onPointerMove(105 + step, 205 + step * 1.25);
    }
    overlay.onPointerUp();

    const circle = overlay.getState().drawings[0];
    // Center must have moved from (100, 200) to (120, 225), accurate to price and time
    expect(circle.points[0]).toEqual({ time: 120, price: 225 });
    expect(circle.points[1].time).toBe(120);
    expect(Math.abs(circle.points[1].price - circle.points[0].price)).toBe(20);
  });

  it('drops a center-first circle when no usable radius was dragged but keeps the tool armed', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('circle');
    overlay.onToolPointerDown(10, 10);
    overlay.onPointerMove(11, 11);
    overlay.onPointerUp();
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.isToolActive()).toBe(true);
  });

  it('places a start/end/mid curve whose three anchors remain editable', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('curve');
    overlay.onClick(0, 0);   // start
    overlay.onClick(10, 0);  // end
    overlay.onClick(5, 10);  // bend/control

    const curve = overlay.getState().drawings[0];
    expect(curve.points).toEqual([
      { time: 0, price: 0 },
      { time: 10, price: 0 },
      { time: 5, price: 10 },
    ]);
    const target = createFakeTarget();
    series.getCaptured().paneViews()[0].renderer().draw(target);
    expect(target.context.quadraticCurveTo).toHaveBeenCalledWith(5, 20, 10, 0);

    // The rendered curve passes through the editable midpoint.
    overlay.setActiveTool(null);
    expect(overlay.onClick(5, 10)).toBe(true);
    expect(overlay.onPointerDown(5, 10)).toBe(true);
    overlay.onPointerMove(5, 20);
    overlay.onPointerUp();
    expect(overlay.getState().drawings[0].points[2]).toEqual({ time: 5, price: 20 });
    expect(loadDrawings('BTC')[0].points[2]).toEqual({ time: 5, price: 20 });
  });

  it('selects by click and deletes the selection, persisting', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(10, 20);
    overlay.onClick(30, 40);
    expect(loadDrawings('BTC')).toHaveLength(1);

    // Exit keep-drawing → a click on the line selects it.
    overlay.setActiveTool(null);
    expect(overlay.onClick(10, 20)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);

    expect(overlay.removeSelected()).toBe(true);
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(loadDrawings('BTC')).toHaveLength(0);
  });

  it('consumes an empty click that clears a drawing selection', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('horizontal');
    overlay.onClick(10, 20);
    overlay.setActiveTool(null);
    expect(overlay.onClick(10, 20)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);

    expect(overlay.onClick(10, 80)).toBe(true);
    expect(overlay.hasSelection()).toBe(false);
  });

  it('clears all drawings for the coin', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('horizontal');
    overlay.onClick(1, 10);
    overlay.onClick(1, 20); // keep-drawing places a second horizontal
    expect(overlay.getState().drawings).toHaveLength(2);

    overlay.clearAll();
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(loadDrawings('BTC')).toHaveLength(0);
  });

  it('renders hundreds of coexisting drawings in one primitive pass and remains interactive', () => {
    const drawings = Array.from({ length: 240 }, (_, index) => ({
      id: `line-${index}`,
      type: 'horizontal',
      points: [{ time: index + 1, price: index + 10 }],
    }));
    saveDrawings('BTC', drawings);
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');

    const target = createFakeTarget();
    expect(() => series.getCaptured().paneViews()[0].renderer().draw(target)).not.toThrow();
    expect(target.context.stroke).toHaveBeenCalledTimes(240);
    expect(overlay.getState().drawings).toHaveLength(240);

    // The last drawing remains selectable and a new drawing can still commit
    // after the dense render, proving earlier shapes do not block later input.
    expect(overlay.onClick(400, 249)).toBe(true);
    expect(overlay.getState().selectedId).toBe('line-239');
    overlay.setActiveTool('horizontal');
    expect(overlay.onClick(400, 300)).toBe(true);
    expect(overlay.getState().drawings).toHaveLength(241);
  });

  it('reloads persisted drawings when switching to a coin', () => {
    saveDrawings('SOL', [
      { id: 'x', type: 'box', points: [{ time: 1, price: 1 }, { time: 5, price: 5 }] },
    ]);
    const { overlay } = makeOverlay();
    overlay.setCoin('SOL');
    expect(overlay.getState().drawings).toHaveLength(1);
    expect(overlay.getState().drawings[0].type).toBe('box');
  });

  it('isolates drawings between coins on switch', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('horizontal');
    overlay.onClick(1, 10);
    expect(overlay.getState().drawings).toHaveLength(1);

    overlay.setCoin('ETH');
    expect(overlay.getState().drawings).toHaveLength(0);

    overlay.setCoin('BTC');
    expect(overlay.getState().drawings).toHaveLength(1);
  });

  it('cancel() aborts an in-progress tool and fires the change callback', () => {
    const { overlay } = makeOverlay();
    const changes = [];
    overlay.setOnActiveToolChange((t) => changes.push(t));
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(10, 20); // one point placed
    expect(overlay.cancel()).toBe('trendline');
    expect(overlay.isToolActive()).toBe(false);
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(changes).toEqual(['trendline', null]);
  });

  it('drags a whole drawing and persists the move', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(10, 20);
    overlay.onClick(30, 40);
    overlay.setActiveTool(null); // exit keep-drawing before select/drag

    // Grab the body and move it by (+5, +5).
    expect(overlay.onPointerDown(10, 20)).toBe(true);
    overlay.onPointerMove(15, 25);
    overlay.onPointerUp();

    const pts = overlay.getState().drawings[0].points;
    expect(pts[0]).toEqual({ time: 15, price: 25 });
    expect(pts[1]).toEqual({ time: 35, price: 45 });
    expect(loadDrawings('BTC')[0].points[0]).toEqual({ time: 15, price: 25 });
  });

  it('deletes the selected drawing via its on-canvas ✕ button', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(10, 20);
    overlay.onClick(30, 40);
    overlay.setActiveTool(null);
    overlay.onClick(10, 20); // select it

    // Render so the ✕ button's hit-rect is computed (top-right + offset).
    const primitive = series.getCaptured();
    primitive.paneViews()[0].renderer().draw(createFakeTarget());

    // Button sits at maxX+14, minY-14 => (44, 6) with identity mapping.
    expect(overlay.onClick(44, 6)).toBe(true);
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(loadDrawings('BTC')).toHaveLength(0);
  });

  it('deletes a drawing under the pointer via deleteAt (right-click)', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('horizontal');
    overlay.onClick(5, 50);
    expect(overlay.getState().drawings).toHaveLength(1);

    expect(overlay.deleteAt(99, 50)).toBe(true); // horizontal spans full width
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.deleteAt(1, 1)).toBe(false); // nothing there
  });

  it('places a long position from 2 clicks, deriving 5 levels at 1R/2R/3R', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('longPosition');

    overlay.onClick(10, 100);                 // entry @ 100
    expect(overlay.getState().drawings).toHaveLength(0);
    overlay.onClick(30, 90);                   // stop @ 90 (R = 10) → completes
    expect(overlay.isToolActive()).toBe(true);

    const d = overlay.getState().drawings[0];
    expect(d.type).toBe('longPosition');
    expect(d.points).toHaveLength(5);
    expect(d.points.map((p) => p.price)).toEqual([100, 90, 110, 120, 130]);
    // All levels anchor to the entry time; the box width is a forward projection.
    expect(d.points.every((p) => p.time === 10)).toBe(true);

    // Persists with all 5 points (passes the length === requiredPoints check).
    expect(loadDrawings('BTC')[0].points).toHaveLength(5);
  });

  it('places the entry in the future whitespace (first click past the last bar)', () => {
    // coordinateToTime returns null past x=100 (the future whitespace); the
    // series exposes its last two bars so a future time can be extrapolated.
    const timeScale = {
      coordinateToTime: vi.fn((x) => (x < 100 ? x : null)),
      coordinateToLogical: vi.fn((x) => x),
      timeToIndex: vi.fn((t) => t),
      logicalToCoordinate: vi.fn((l) => l),
    };
    const chart = { timeScale: () => timeScale, applyOptions: vi.fn() };
    const series = {
      attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
      priceToCoordinate: vi.fn((p) => p), coordinateToPrice: vi.fn((y) => y),
      data: vi.fn(() => [{ time: 98 }, { time: 99 }]), // interval 1, last index 99
    };
    const overlay = createDrawingToolsOverlay({ getChart: () => chart, getCandleSeries: () => series });
    overlay.setCoin('BTC');
    overlay.setActiveTool('longPosition');

    overlay.onClick(150, 100); // entry click in the future whitespace (x=150)
    expect(overlay.getState().drawings).toHaveLength(0); // accepted, awaiting stop
    overlay.onClick(160, 90);  // stop (price only)

    const d = overlay.getState().drawings[0];
    expect(d).toBeTruthy();
    expect(d.type).toBe('longPosition');
    // Entry time extrapolated: last bar (99) + (150 − 99) bars × interval (1).
    expect(d.points[0].time).toBe(150);
    expect(d.points.map((p) => p.price)).toEqual([100, 90, 110, 120, 130]);
  });

  it('projects the position box forward, right of the entry bar', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('longPosition');
    overlay.onClick(10, 100); // entry @ bar x=10
    overlay.onClick(10, 90);  // stop (price only)
    overlay.setActiveTool(null);

    // With identity mocks the box spans x ∈ [10, 10 + POSITION_WIDTH_BARS(30)].
    // A click on the entry line well to the right of the entry bar still selects,
    // which only holds because the box projects forward into the whitespace.
    expect(overlay.onClick(38, 100)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
  });

  it('mirrors take-profits below entry for a short position', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('shortPosition');
    overlay.onClick(10, 100);  // entry @ 100
    overlay.onClick(30, 110);  // stop @ 110 (R = 10)

    const prices = overlay.getState().drawings[0].points.map((p) => p.price);
    expect(prices).toEqual([100, 110, 90, 80, 70]); // TPs below entry
  });

  it('renders a position without throwing and draws labels', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('longPosition');
    overlay.onClick(10, 100);
    overlay.onClick(30, 90);

    const primitive = series.getCaptured();
    const target = createFakeTarget();
    expect(() => primitive.paneViews()[0].renderer().draw(target)).not.toThrow();
    expect(target.context.fillRect).toHaveBeenCalled(); // risk/reward zones
    expect(target.context.fillText).toHaveBeenCalled();  // level labels
  });

  it('drags a take-profit handle by price only, keeping its time', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('longPosition');
    overlay.onClick(10, 100);
    overlay.onClick(30, 90); // TP1 anchor = { time: 10, price: 110 } (stop x ignored)
    overlay.setActiveTool(null);

    // Select via a click on the entry line, then grab the TP1 handle. Handles sit
    // at the entry bar (left edge), so TP1's handle is at (10, 110).
    overlay.onClick(20, 100);
    expect(overlay.hasSelection()).toBe(true);
    expect(overlay.onPointerDown(10, 110)).toBe(true); // TP1 handle
    overlay.onPointerMove(40, 105);                     // drag to a new price (Y)
    overlay.onPointerUp();

    const tp1 = overlay.getState().drawings[0].points[2];
    expect(tp1.price).toBe(105); // price followed the cursor
    expect(tp1.time).toBe(10);   // time stayed pinned to the entry/box anchor
  });

  it('places a 1-click vertical line', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('vertical');
    overlay.onClick(40, 5);
    expect(overlay.getState().drawings).toHaveLength(1);
    expect(overlay.getState().drawings[0].type).toBe('vertical');
    overlay.setActiveTool(null);
    // Vertical spans full height: a click anywhere on its column selects it.
    expect(overlay.onClick(40, 300)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
  });

  it('places a 2-click fib and derives its level prices', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('fib');
    overlay.onClick(10, 100); // 1.0 anchor (price 100)
    expect(overlay.getState().drawings).toHaveLength(0);
    overlay.onClick(30, 200); // 0.0 anchor (price 200) → completes
    const d = overlay.getState().drawings[0];
    expect(d.type).toBe('fib');
    expect(d.points.map((p) => p.price)).toEqual([100, 200]);
    overlay.setActiveTool(null);
    // A click on the 0.5 level line (midpoint y between the anchors) selects it.
    expect(overlay.onClick(20, 150)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
  });

  it('captures a freehand pencil path on press-drag and stays armed for the next stroke', () => {
    const { overlay } = makeOverlay();
    const changes = [];
    overlay.setOnActiveToolChange((t) => changes.push(t));
    overlay.setCoin('BTC');
    overlay.setActiveTool('pencil');

    expect(overlay.onToolPointerDown(10, 10)).toBe(true);
    expect(overlay.isDragging()).toBe(true);
    overlay.onPointerMove(20, 15);
    overlay.onPointerMove(30, 25);
    overlay.onPointerUp();

    const drawings = overlay.getState().drawings;
    expect(drawings).toHaveLength(1);
    expect(drawings[0].type).toBe('pencil');
    expect(drawings[0].points.length).toBeGreaterThanOrEqual(3);
    expect(overlay.isToolActive()).toBe(true);
    expect(overlay.getState().activeTool).toBe('pencil');
    expect(changes).toEqual(['pencil']);
    expect(loadDrawings('BTC')).toHaveLength(1); // pencil persists

    // A second stroke commits another path without re-arming.
    overlay.onToolPointerDown(40, 40);
    overlay.onPointerMove(50, 45);
    overlay.onPointerMove(60, 55);
    overlay.onPointerUp();
    expect(overlay.getState().drawings).toHaveLength(2);
    expect(overlay.isToolActive()).toBe(true);
    expect(changes).toEqual(['pencil']);

    overlay.setActiveTool(null);
    expect(overlay.isToolActive()).toBe(false);
    expect(changes).toEqual(['pencil', null]);
  });

  it('discards a pencil stroke that never moved but keeps the tool armed', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('pencil');
    overlay.onToolPointerDown(10, 10);
    overlay.onPointerUp(); // no moves → single point → dropped
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.isToolActive()).toBe(true);
    expect(overlay.getState().activeTool).toBe('pencil');
  });

  it('stamps 1-click arrow markers with their sentiment colors', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');

    overlay.setActiveTool('arrowUp');
    overlay.onClick(20, 100);
    overlay.setActiveTool('arrowDown');
    overlay.onClick(40, 200);

    const [up, down] = overlay.getState().drawings;
    expect(up.type).toBe('arrowUp');
    expect(up.color).toBe('#22cce6');   // aqua, matches the bullish/TP palette
    expect(down.type).toBe('arrowDown');
    expect(down.color).toBe('#ff5050'); // red, matches the stop palette
    expect(overlay.isToolActive()).toBe(true);
    expect(loadDrawings('BTC')).toHaveLength(2);

    overlay.setActiveTool(null);
    // Hit-test: the down arrow's glyph sits above its anchor, the up arrow's below.
    expect(overlay.onClick(40, 190)).toBe(true); // inside the down glyph
    expect(overlay.hasSelection()).toBe(true);
    overlay.cancel();
    expect(overlay.onClick(20, 110)).toBe(true); // inside the up glyph
    expect(overlay.hasSelection()).toBe(true);
  });

  it('places a 2-click arrow and hit-tests its shaft like a trendline', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('arrow');
    overlay.onClick(10, 10);
    overlay.onClick(50, 10);
    const d = overlay.getState().drawings[0];
    expect(d.type).toBe('arrow');
    expect(overlay.isToolActive()).toBe(true);

    overlay.setActiveTool(null);
    expect(overlay.onClick(30, 10)).toBe(true); // on the shaft
    expect(overlay.hasSelection()).toBe(true);
    overlay.cancel();
    expect(overlay.onClick(80, 10)).toBe(false); // past the tip: no hit
  });

  it('extends an extended line beyond both endpoints for hit-testing', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('extended');
    overlay.onClick(10, 50);
    overlay.onClick(20, 50);
    expect(overlay.getState().drawings[0].type).toBe('extended');

    overlay.setActiveTool(null);
    // Hits far past either endpoint, where a trendline would miss.
    expect(overlay.onClick(400, 50)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
  });

  it('places a horizontal ray that extends right but not left of its anchor', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('hray');
    overlay.onClick(50, 30);
    expect(overlay.getState().drawings[0].type).toBe('hray');

    overlay.setActiveTool(null);
    expect(overlay.onClick(400, 30)).toBe(true); // to the right: on the ray
    expect(overlay.hasSelection()).toBe(true);
    overlay.cancel();
    expect(overlay.onClick(10, 30)).toBe(false); // left of the anchor: no hit
  });

  it('does not treat a zigzag mousedown as a freehand reset', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('zigzag');

    overlay.onClick(10, 10);
    // Production sends capture-phase mousedown through onToolPointerDown
    // before the click that places the next vertex.
    expect(overlay.onToolPointerDown(30, 40)).toBe(false);
    overlay.onClick(30, 40);
    expect(overlay.onToolPointerDown(50, 15)).toBe(false);
    overlay.onClick(50, 15);

    expect(overlay.getState().pending.points).toEqual([
      { time: 10, price: 10 },
      { time: 30, price: 40 },
      { time: 50, price: 15 },
    ]);
    expect(overlay.getState().drawings).toHaveLength(0);

    overlay.onClick(70, 45);
    overlay.onClick(71, 45);
    expect(overlay.onDblClick(71, 45)).toBe(true);
    expect(overlay.getState().drawings[0].points).toHaveLength(4);
  });

  it('builds a zigzag click-by-click and commits on double-click, deduping', () => {
    const { overlay } = makeOverlay();
    const changes = [];
    overlay.setOnActiveToolChange((t) => changes.push(t));
    overlay.setCoin('BTC');
    overlay.setActiveTool('zigzag');

    overlay.onClick(10, 10);
    overlay.onClick(30, 40);
    overlay.onClick(50, 15);
    expect(overlay.getState().drawings).toHaveLength(0); // never auto-commits
    expect(overlay.isToolActive()).toBe(true);

    // A dblclick is preceded by two click events at (nearly) the same spot.
    overlay.onClick(70, 45);
    overlay.onClick(71, 45);
    expect(overlay.onDblClick(71, 45)).toBe(true);

    const d = overlay.getState().drawings[0];
    expect(d.type).toBe('zigzag');
    // The duplicate trailing vertex from the double-click's second click is dropped.
    expect(d.points).toHaveLength(4);
    expect(d.points[3]).toEqual({ time: 70, price: 45 });
    expect(overlay.isToolActive()).toBe(true);
    expect(changes).toEqual(['zigzag']);
    expect(loadDrawings('BTC')).toHaveLength(1);

    overlay.setActiveTool(null);
    // Selects like a pencil: distance to any segment of the path.
    expect(overlay.onClick(20, 25)).toBe(true); // midpoint of the first segment
    expect(overlay.hasSelection()).toBe(true);
  });

  it('discards a zigzag double-clicked with fewer than 2 distinct points but keeps the tool armed', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('zigzag');
    overlay.onClick(10, 10);
    overlay.onClick(11, 10); // dblclick's second click, same spot
    expect(overlay.onDblClick(11, 10)).toBe(true);
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.isToolActive()).toBe(true);
  });

  it('cancels an in-progress zigzag via Escape without committing', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('zigzag');
    overlay.onClick(10, 10);
    overlay.onClick(30, 40);
    expect(overlay.cancel()).toBe('zigzag');
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(loadDrawings('BTC')).toHaveLength(0);
  });

  it('places a text label via dialog (text + font size) and skips cancel', async () => {
    const resolvers = [];
    const promptTextLabel = vi.fn(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const overlay = createDrawingToolsOverlay({
      getChart: () => ({ timeScale: () => ({
        coordinateToTime: (x) => x, coordinateToLogical: (x) => x,
        timeToIndex: (t) => t, logicalToCoordinate: (l) => l,
      }), applyOptions: vi.fn() }),
      getCandleSeries: () => ({
        attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
        priceToCoordinate: (p) => p, coordinateToPrice: (y) => y,
        data: () => [{ time: 0 }, { time: 1 }],
      }),
      promptTextLabel,
    });
    overlay.setCoin('BTC');
    overlay.setActiveTool('text');
    overlay.onClick(25, 25);
    expect(promptTextLabel).toHaveBeenCalledTimes(1);
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.isToolActive()).toBe(true);

    resolvers[0]({ text: '  note  ', fontSize: 20 });
    await Promise.resolve();
    await Promise.resolve();

    const d = overlay.getState().drawings[0];
    expect(d.type).toBe('text');
    expect(d.text).toBe('note');
    expect(d.fontSize).toBe(20);
    expect(loadDrawings('BTC')[0].fontSize).toBe(20);

    // Cancelled dialog → no extra commit, tool stays armed.
    overlay.onClick(40, 40);
    expect(promptTextLabel).toHaveBeenCalledTimes(2);
    resolvers[1](null);
    await Promise.resolve();
    await Promise.resolve();
    expect(overlay.getState().drawings).toHaveLength(1);
    expect(overlay.isToolActive()).toBe(true);
  });

  it('renders unlimited measure boxes and persists them per coin', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('measure');
    overlay.onClick(10, 100);
    overlay.onClick(30, 120);
    overlay.setActiveTool('measure');
    overlay.onClick(10, 50);
    overlay.onClick(30, 60);
    overlay.setActiveTool('measure');
    overlay.onClick(40, 80);
    overlay.onClick(60, 90);
    const measures = overlay.getState().drawings.filter((d) => d.type === 'measure');
    expect(measures).toHaveLength(3);
    expect(loadDrawings('BTC').filter((d) => d.type === 'measure')).toHaveLength(3);
  });

  it('extrapolates future times from the selected timeframe, not a gap between last bars', () => {
    const timeScale = {
      coordinateToTime: vi.fn((x) => (x >= 0 && x < 100 ? x : null)),
      coordinateToLogical: vi.fn((x) => x),
      timeToIndex: vi.fn((t) => t),
      logicalToCoordinate: vi.fn((l) => l),
    };
    const chart = { timeScale: () => timeScale, applyOptions: vi.fn() };
    const series = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      priceToCoordinate: vi.fn((p) => p),
      coordinateToPrice: vi.fn((y) => y),
      // A sparse last interval of 8h must not become the future bar step.
      data: vi.fn(() => [{ time: 91 }, { time: 99 }]),
    };
    const overlay = createDrawingToolsOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      getTimeframe: () => '2h',
    });
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(150, 100);
    overlay.onClick(160, 90);

    const d = overlay.getState().drawings[0];
    expect(d.points.map((p) => p.time)).toEqual([
      99 + (150 - 99) * (2 * 60 * 60),
      99 + (160 - 99) * (2 * 60 * 60),
    ]);

    // Reverse map (render / hit-test) must use the same 2h step, not the 8s gap.
    // Otherwise the drawing would place on 2h bars and reappear at a huge logical
    // index derived from last-two-candle delta.
    overlay.setActiveTool(null);
    expect(overlay.onClick(150, 100)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
    expect(timeScale.logicalToCoordinate).toHaveBeenCalledWith(150);
    expect(timeScale.logicalToCoordinate).toHaveBeenCalledWith(160);
  });

  it('uses last-two-bar gap for calendar 1M future placement and reverse mapping', () => {
    const timeScale = {
      coordinateToTime: vi.fn((x) => (x >= 0 && x < 100 ? x : null)),
      coordinateToLogical: vi.fn((x) => x),
      timeToIndex: vi.fn((t) => t),
      logicalToCoordinate: vi.fn((l) => l),
    };
    const chart = { timeScale: () => timeScale, applyOptions: vi.fn() };
    const series = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      priceToCoordinate: vi.fn((p) => p),
      coordinateToPrice: vi.fn((y) => y),
      data: vi.fn(() => [{ time: 91 }, { time: 99 }]),
    };
    const overlay = createDrawingToolsOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      getTimeframe: () => '1M',
    });
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(150, 100);
    overlay.onClick(160, 90);

    const d = overlay.getState().drawings[0];
    expect(d.points.map((p) => p.time)).toEqual([
      99 + (150 - 99) * 8,
      99 + (160 - 99) * 8,
    ]);
    overlay.setActiveTool(null);
    expect(overlay.onClick(150, 100)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
  });

  it('uses getBarTimes plus selected timeframe without calling series.data()', () => {
    const timeScale = {
      coordinateToTime: vi.fn((x) => (x >= 0 && x < 100 ? x : null)),
      coordinateToLogical: vi.fn((x) => x),
      timeToIndex: vi.fn((t) => t),
      logicalToCoordinate: vi.fn((l) => l),
    };
    const chart = { timeScale: () => timeScale, applyOptions: vi.fn() };
    const series = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      priceToCoordinate: vi.fn((p) => p),
      coordinateToPrice: vi.fn((y) => y),
      data: vi.fn(() => { throw new Error('series.data() must not be called'); }),
    };
    const overlay = createDrawingToolsOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      getTimeframe: () => '2h',
      getBarTimes: () => ({ last: 99, prev: 91 }),
    });
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(150, 100);
    overlay.onClick(160, 90);

    expect(series.data).not.toHaveBeenCalled();
    const d = overlay.getState().drawings[0];
    expect(d.points.map((p) => p.time)).toEqual([
      99 + (150 - 99) * (2 * 60 * 60),
      99 + (160 - 99) * (2 * 60 * 60),
    ]);
    overlay.setActiveTool(null);
    expect(overlay.onClick(150, 100)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
    expect(series.data).not.toHaveBeenCalled();
  });

  it('places a non-position drawing in the future whitespace (extrapolated times)', () => {
    const { overlay } = makeFutureOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');

    overlay.onClick(150, 100); // both clicks land past the last bar (x >= 100)
    expect(overlay.getState().drawings).toHaveLength(0);
    overlay.onClick(160, 90);

    const d = overlay.getState().drawings[0];
    expect(d.type).toBe('trendline');
    // Times extrapolated from the live edge (99) by the bar interval (1).
    expect(d.points.map((p) => p.time)).toEqual([150, 160]);
    expect(d.points.map((p) => p.price)).toEqual([100, 90]);
  });

  it('renders, hit-tests, and selects a future-anchored drawing', () => {
    const { overlay, series } = makeFutureOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(150, 100);
    overlay.onClick(160, 90);

    // Renders without throwing even though anchors sit past the last bar.
    const primitive = series.getCaptured();
    const target = createFakeTarget();
    expect(() => primitive.paneViews()[0].renderer().draw(target)).not.toThrow();
    expect(target.context.stroke).toHaveBeenCalled();

    overlay.setActiveTool(null);
    // A click on the future-anchored endpoint selects it (hit-test resolves px).
    expect(overlay.onClick(150, 100)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);
  });

  it('drags an endpoint from over-data into the future whitespace', () => {
    const { overlay } = makeFutureOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');
    overlay.onClick(10, 20); // historical anchors (x < 100)
    overlay.onClick(30, 40);

    overlay.setActiveTool(null);
    overlay.onClick(10, 20); // select
    expect(overlay.onPointerDown(10, 20)).toBe(true); // grab endpoint 0
    overlay.onPointerMove(150, 25); // drag it past the last bar
    overlay.onPointerUp();

    const p0 = overlay.getState().drawings[0].points[0];
    expect(p0.time).toBe(150); // extrapolated future time
    expect(p0.price).toBe(25);
  });

  it('swallows a left/off-data click while drawing (no future anchor)', () => {
    const { overlay } = makeFutureOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('trendline');

    // x = -5: coordinateToTime is null but barsFromEnd <= 0 → not the future.
    expect(overlay.onClick(-5, 50)).toBe(true); // handled (swallowed)
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(overlay.isToolActive()).toBe(true); // still awaiting a valid first point
  });

  it('round-trips a future-anchored drawing through serialize/deserialize', () => {
    const list = [
      { id: 'f', type: 'trendline', points: [{ time: 150, price: 100 }, { time: 160, price: 90 }], color: '#fff' },
    ];
    const back = deserializeDrawings(serializeDrawings(list));
    expect(back[0].points).toEqual([{ time: 150, price: 100 }, { time: 160, price: 90 }]);
  });

  it('renders every shape type without throwing', async () => {
    const promptTextLabel = vi.fn(async () => ({ text: 'label', fontSize: 16 }));
    const chart = createMockChart();
    let captured = null;
    const series = {
      attachPrimitive: vi.fn((p) => { captured = p; }),
      detachPrimitive: vi.fn(),
      priceToCoordinate: vi.fn((p) => p),
      coordinateToPrice: vi.fn((y) => y),
      data: vi.fn(() => [{ time: 0 }, { time: 1 }]),
      getCaptured: () => captured,
    };
    const overlay = createDrawingToolsOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      promptTextLabel,
    });
    overlay.setCoin('BTC');
    for (const [tool, clicks] of [
      ['trendline', [[1, 1], [5, 5]]],
      ['ray', [[1, 1], [3, 2]]],
      ['arrow', [[1, 1], [7, 3]]],
      ['extended', [[2, 2], [6, 4]]],
      ['hray', [[3, 7]]],
      ['horizontal', [[1, 9]]],
      ['vertical', [[4, 1]]],
      ['box', [[1, 1], [6, 6]]],
      ['curve', [[1, 1], [8, 4], [4, 9]]],
      ['channel', [[1, 1], [8, 4], [4, 9]]],
      ['fib', [[1, 1], [9, 9]]],
      ['measure', [[1, 1], [7, 8]]],
      ['text', [[3, 3]]],
      ['arrowUp', [[5, 8]]],
      ['arrowDown', [[6, 2]]],
    ]) {
      overlay.setActiveTool(tool);
      for (const [x, y] of clicks) overlay.onClick(x, y);
    }
    await Promise.resolve();
    await Promise.resolve();
    // Circle uses center-first press-drag placement.
    overlay.setActiveTool('circle');
    overlay.onToolPointerDown(10, 10);
    overlay.onPointerMove(16, 18);
    overlay.onPointerUp();
    // Freehand pencil via the press-drag path.
    overlay.setActiveTool('pencil');
    overlay.onToolPointerDown(2, 2);
    overlay.onPointerMove(5, 6);
    overlay.onPointerUp();
    // Polyline zigzag via clicks + double-click commit.
    overlay.setActiveTool('zigzag');
    overlay.onClick(1, 1);
    overlay.onClick(4, 8);
    overlay.onClick(8, 3);
    overlay.onDblClick(8, 3);

    const primitive = series.getCaptured();
    const target = createFakeTarget();
    expect(() => primitive.paneViews()[0].renderer().draw(target)).not.toThrow();
    expect(target.context.stroke).toHaveBeenCalled();
  });

  it('allows multiple measure boxes to be selected, resized, moved, and individually deleted', () => {
    const { overlay } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('measure');
    overlay.onClick(10, 20);
    overlay.onClick(50, 60); // box 1
    overlay.setActiveTool('measure');
    overlay.onClick(100, 120);
    overlay.onClick(150, 160); // box 2

    const state = overlay.getState();
    expect(state.drawings).toHaveLength(2);
    const box1Id = state.drawings[0].id;
    const box2Id = state.drawings[1].id;

    overlay.setActiveTool(null);

    // Select box 1
    expect(overlay.onClick(30, 40)).toBe(true);
    expect(overlay.getState().selectedId).toBe(box1Id);

    // Drag handle 1 of box 1 (at x=50, y=60)
    expect(overlay.onPointerDown(50, 60)).toBe(true);
    overlay.onPointerMove(70, 80);
    overlay.onPointerUp();
    const box1Updated = overlay.getState().drawings.find((d) => d.id === box1Id);
    expect(box1Updated.points[1]).toEqual({ time: 70, price: 80 });

    // Drag whole box 1
    expect(overlay.onPointerDown(30, 40)).toBe(true);
    overlay.onPointerMove(40, 50);
    overlay.onPointerUp();
    const box1Moved = overlay.getState().drawings.find((d) => d.id === box1Id);
    expect(box1Moved.points[0]).toEqual({ time: 20, price: 30 });

    // Delete box 1
    expect(overlay.removeSelected()).toBe(true);
    expect(overlay.getState().drawings).toHaveLength(1);
    expect(overlay.getState().drawings[0].id).toBe(box2Id);
    expect(loadDrawings('BTC')).toHaveLength(1);

    // Right-click delete box 2
    expect(overlay.deleteAt(120, 140)).toBe(true);
    expect(overlay.getState().drawings).toHaveLength(0);
    expect(loadDrawings('BTC')).toHaveLength(0);
  });

  it('highlights selected measure box with SELECTED_COLOR when rendered', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('measure');
    overlay.onClick(10, 20);
    overlay.onClick(50, 60);
    overlay.setActiveTool(null);

    // Select the measure box
    overlay.onClick(30, 40);
    expect(overlay.hasSelection()).toBe(true);

    const primitive = series.getCaptured();
    const target = createFakeTarget();
    let borderStrokeStyle = null;
    target.context.strokeRect.mockImplementation(() => {
      if (!borderStrokeStyle) borderStrokeStyle = target.context.strokeStyle;
    });
    primitive.paneViews()[0].renderer().draw(target);

    // Selected measure box border uses selected color #ffb547
    expect(target.context.strokeRect).toHaveBeenCalled();
    expect(borderStrokeStyle).toBe('#ffb547');
  });

  it('allows double-clicking an existing text drawing to edit its label and font size', async () => {
    let promptResolver = null;
    const promptTextLabel = vi.fn(() => new Promise((res) => { promptResolver = res; }));
    const chart = createMockChart();
    const series = createMockSeries();
    const overlay = createDrawingToolsOverlay({
      getChart: () => chart,
      getCandleSeries: () => series,
      promptTextLabel,
    });
    overlay.setCoin('BTC');
    overlay.setActiveTool('text');
    overlay.onClick(50, 100);
    promptResolver({ text: 'Initial note', fontSize: 14 });
    await Promise.resolve();
    await Promise.resolve();

    expect(overlay.getState().drawings).toHaveLength(1);
    expect(overlay.getState().drawings[0].text).toBe('Initial note');

    // Turn off drawing tool to be in pointer / select mode
    overlay.setActiveTool(null);

    // Double-click on the text drawing
    expect(overlay.onDblClick(55, 105)).toBe(true);
    expect(promptTextLabel).toHaveBeenCalledWith(expect.objectContaining({
      defaultText: 'Initial note',
      defaultFontSize: 14,
    }));

    promptResolver({ text: 'Edited note', fontSize: 20 });
    await Promise.resolve();
    await Promise.resolve();

    const d = overlay.getState().drawings[0];
    expect(d.text).toBe('Edited note');
    expect(d.fontSize).toBe(20);
    expect(loadDrawings('BTC')[0].text).toBe('Edited note');
  });

  it('correctly handles vertical channels on hit-test and rendering', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('channel');
    // Vertical line from (50, 10) to (50, 100), offset to (80, 50)
    overlay.onClick(50, 10);
    overlay.onClick(50, 100);
    overlay.onClick(80, 50);
    overlay.setActiveTool(null);

    // Hit-test near parallel line at x=80, y=50
    expect(overlay.onClick(80, 50)).toBe(true);
    expect(overlay.hasSelection()).toBe(true);

    const primitive = series.getCaptured();
    const target = createFakeTarget();
    expect(() => primitive.paneViews()[0].renderer().draw(target)).not.toThrow();
  });

  it('clamps delete button coordinates within canvas boundaries', () => {
    const { overlay, series } = makeOverlay();
    overlay.setCoin('BTC');
    overlay.setActiveTool('horizontal');
    // Top-right corner of an 800x600 canvas
    overlay.onClick(795, 2);
    overlay.setActiveTool(null);

    overlay.onClick(795, 2);
    expect(overlay.hasSelection()).toBe(true);

    const primitive = series.getCaptured();
    const target = createFakeTarget();
    primitive.paneViews()[0].renderer().draw(target);

    // arc is called for the delete button
    expect(target.context.arc).toHaveBeenCalled();
    const [arcX, arcY] = target.context.arc.mock.calls[0];
    // Check that button is clamped on screen (< 800 and > 0)
    expect(arcX).toBeLessThanOrEqual(800 - 9 - 2);
    expect(arcY).toBeGreaterThanOrEqual(9 + 2);
  });
});
