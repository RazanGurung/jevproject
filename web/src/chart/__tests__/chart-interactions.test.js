/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

function createPointerEvent(type, { pointerId = 1, pointerType = 'touch', clientX = 0, clientY = 0 } = {}) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'pointerId', { value: pointerId, configurable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType, configurable: true });
  return event;
}

describe('chart interactions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('claims an existing drawing press before the inner chart can arm native panning', async () => {
    document.body.innerHTML = '<div id="chartWrap"><canvas id="chartCanvas"></canvas></div>';
    const wrap = document.getElementById('chartWrap');
    const canvas = document.getElementById('chartCanvas');
    wrap.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 240 });
    const nativeMouseDown = vi.fn();
    canvas.addEventListener('mousedown', nativeMouseDown);

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'isPlacementActive').mockReturnValue(false);
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'onPointerDown').mockReturnValue(false);
    vi.spyOn(lightweightModule.drawingToolsOverlay, 'onToolPointerDown').mockReturnValue(false);
    vi.spyOn(lightweightModule.drawingToolsOverlay, 'isToolActive').mockReturnValue(false);
    const startDrawingDrag = vi.spyOn(lightweightModule.drawingToolsOverlay, 'onPointerDown').mockReturnValue(true);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());
    const event = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 70, clientY: 90,
    });
    canvas.dispatchEvent(event);

    expect(startDrawingDrag).toHaveBeenCalledWith(60, 70);
    expect(nativeMouseDown).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('claims manual-anchor and armed drawing presses before native chart panning', async () => {
    document.body.innerHTML = '<div id="chartWrap"><canvas id="chartCanvas"></canvas></div>';
    const wrap = document.getElementById('chartWrap');
    const canvas = document.getElementById('chartCanvas');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });
    const nativeMouseDown = vi.fn();
    canvas.addEventListener('mousedown', nativeMouseDown);

    const lightweightModule = await import('../lightweight-chart.js');
    const placementActive = vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'isPlacementActive');
    placementActive.mockReturnValue(true);
    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 40, clientY: 50,
    }));
    expect(nativeMouseDown).not.toHaveBeenCalled();

    placementActive.mockReturnValue(false);
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'onPointerDown').mockReturnValue(false);
    vi.spyOn(lightweightModule.drawingToolsOverlay, 'onToolPointerDown').mockReturnValue(false);
    vi.spyOn(lightweightModule.drawingToolsOverlay, 'isToolActive').mockReturnValue(true);
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 80, clientY: 90,
    }));
    expect(nativeMouseDown).not.toHaveBeenCalled();
  });

  it('leaves an unowned empty-space press to native chart navigation', async () => {
    document.body.innerHTML = '<div id="chartWrap"><canvas id="chartCanvas"></canvas></div>';
    const wrap = document.getElementById('chartWrap');
    const canvas = document.getElementById('chartCanvas');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });
    const nativeMouseDown = vi.fn();
    canvas.addEventListener('mousedown', nativeMouseDown);

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'isPlacementActive').mockReturnValue(false);
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'onPointerDown').mockReturnValue(false);
    vi.spyOn(lightweightModule.drawingToolsOverlay, 'onToolPointerDown').mockReturnValue(false);
    vi.spyOn(lightweightModule.drawingToolsOverlay, 'isToolActive').mockReturnValue(false);
    vi.spyOn(lightweightModule.drawingToolsOverlay, 'onPointerDown').mockReturnValue(false);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());
    const event = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 120, clientY: 80,
    });
    canvas.dispatchEvent(event);

    expect(nativeMouseDown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('marks the default viewport user-controlled on wheel zoom', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const onViewportInteraction = vi.fn();
    const { attachChartEvents } = await import('../chart-interactions.js');

    attachChartEvents(undefined, { onViewportInteraction });
    document.getElementById('chartWrap').dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      deltaY: -100,
    }));

    expect(onViewportInteraction).toHaveBeenCalledTimes(1);
  });

  it('applies a user-edited ticket price after picking from a lightweight chart click', async () => {
    document.body.innerHTML = `
      <div id="chartWrap"></div>
      <input id="priceInput" />
    `;

    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 240, configurable: true });
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '5m';
    AppState.market.candles = [{ c: '100' }];
    AppState.ui.userEditedPrice = false;

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockReturnValue(123.456);

    const { attachChartEvents } = await import('../chart-interactions.js');
    const scheduleChartRender = vi.fn();
    const priceInput = document.getElementById('priceInput');

    attachChartEvents(scheduleChartRender);
    wrap.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 120, clientY: 80 }));

    // applyTicketPrice uses snapToTick + trimTrailingZeros:false to display the
    // full tick precision for the coin (BTC → 2 decimals), so 123.456 rounds
    // to tick 123.5 and renders as '123.50'.
    expect(priceInput.value).toBe('123.50');
    expect(AppState.ui.userEditedPrice).toBe(true);
  });

  it('ignores plain chart clicks on 1m limit mode so auto-track stays authoritative', async () => {
    document.body.innerHTML = `
      <div id="chartWrap"></div>
      <input id="priceInput" value="74739" />
    `;

    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 240, configurable: true });
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.candles = [{ c: '100' }];
    AppState.ui.userEditedPrice = false;

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockReturnValue(123.456);

    const { attachChartEvents } = await import('../chart-interactions.js');
    const scheduleChartRender = vi.fn();
    const priceInput = document.getElementById('priceInput');

    attachChartEvents(scheduleChartRender);
    wrap.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 120, clientY: 80 }));

    expect(priceInput.value).toBe('74739');
    expect(AppState.ui.userEditedPrice).toBe(false);
  });

  it('does not interpret lower-pane clicks as candle-scale order prices', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div><input id="priceInput" value="" />';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '5m';
    AppState.market.candles = [{ c: '100' }];

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'getChart').mockReturnValue({
      paneSize: () => ({ width: 320, height: 60 }),
    });
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockReturnValue(123.45);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());
    wrap.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 120, clientY: 90 }));

    expect(document.getElementById('priceInput').value).toBe('');
    expect(lightweightModule.coordinateToPrice).not.toHaveBeenCalled();
  });

  it('does not vertically pan the candle price scale from a lower-pane drag', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const setVisibleRange = vi.fn();
    const setAutoScale = vi.fn();
    const priceScale = {
      width: () => 50,
      getVisibleRange: () => ({ from: 90, to: 110 }),
      setVisibleRange,
      setAutoScale,
    };
    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'getChart').mockReturnValue({
      paneSize: () => ({ width: 350, height: 60 }),
      timeScale: () => ({ height: () => 20 }),
    });
    vi.spyOn(lightweightModule, 'getCandleSeries').mockReturnValue({ priceScale: () => priceScale });
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockImplementation((y) => 110 - y / 10);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());
    wrap.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, button: 0, buttons: 1, clientX: 120, clientY: 100,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, buttons: 1, clientX: 120, clientY: 130,
    }));

    expect(lightweightModule.coordinateToPrice).not.toHaveBeenCalled();
    expect(setAutoScale).not.toHaveBeenCalled();
    expect(setVisibleRange).not.toHaveBeenCalled();
  });

  it('lets manual anchor placement consume a touch tap outside limit-order mode', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentOrderType = 'market';
    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'isPlacementActive').mockReturnValue(true);
    const place = vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'onClick').mockReturnValue(true);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());
    wrap.dispatchEvent(createPointerEvent('pointerdown', { clientX: 70, clientY: 80 }));
    wrap.dispatchEvent(createPointerEvent('pointerup', { clientX: 70, clientY: 80 }));

    expect(place).toHaveBeenCalledWith(70, 80);
  });

  it('does not discard an armed manual-anchor click after a late resize callback', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 240 });

    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
      }

      observe() {
        this.callback([]);
      }
    };

    try {
      const lightweightModule = await import('../lightweight-chart.js');
      vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'isPlacementActive').mockReturnValue(true);
      const place = vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'onClick').mockReturnValue(true);

      const { attachChartEvents } = await import('../chart-interactions.js');
      attachChartEvents(vi.fn());
      wrap.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: 70,
        clientY: 90,
      }));

      expect(place).toHaveBeenCalledWith(60, 70);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('routes touch drag gestures to an armed freehand drawing tool', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 240 });

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'isPlacementActive').mockReturnValue(false);
    vi.spyOn(lightweightModule.manualAnchoredVwapOverlay, 'onPointerDown').mockReturnValue(false);
    const start = vi.spyOn(lightweightModule.drawingToolsOverlay, 'onToolPointerDown').mockReturnValue(true);
    const move = vi.spyOn(lightweightModule.drawingToolsOverlay, 'onPointerMove').mockReturnValue(true);
    const finish = vi.spyOn(lightweightModule.drawingToolsOverlay, 'onPointerUp').mockReturnValue(true);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());
    wrap.dispatchEvent(createPointerEvent('pointerdown', { clientX: 40, clientY: 50 }));
    wrap.dispatchEvent(createPointerEvent('pointermove', { clientX: 60, clientY: 75 }));
    wrap.dispatchEvent(createPointerEvent('pointerup', { clientX: 60, clientY: 75 }));

    expect(start).toHaveBeenCalledWith(30, 30);
    expect(move).toHaveBeenCalledWith(50, 55);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('loads a limit price from mobile double tap', async () => {
    document.body.innerHTML = `
      <div id="chartWrap"></div>
      <input id="priceInput" value="" />
      <div id="chartTouchToolbar">
        <button id="chartTouchBuyBtn"></button>
        <button id="chartTouchSellBtn"></button>
        <div id="chartTouchHint"></div>
      </div>
    `;

    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 240, configurable: true });
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '5m';
    AppState.market.candles = [{ c: '100' }];

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockReturnValue(150.5);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());

    wrap.dispatchEvent(createPointerEvent('pointerdown', { clientX: 120, clientY: 80 }));
    wrap.dispatchEvent(createPointerEvent('pointerup', { clientX: 120, clientY: 80 }));
    expect(document.getElementById('priceInput').value).toBe('');

    wrap.dispatchEvent(createPointerEvent('pointerdown', { clientX: 120, clientY: 80 }));
    wrap.dispatchEvent(createPointerEvent('pointerup', { clientX: 120, clientY: 80 }));

    expect(document.getElementById('priceInput').value).toBe('150.50');
  });

  it('arms buy tap mode for mobile chart execution and disarms after pricing', async () => {
    document.body.innerHTML = `
      <div id="chartWrap"></div>
      <input id="priceInput" value="" />
      <button id="buyBtn" class="seg-btn"></button>
      <button id="sellBtn" class="seg-btn"></button>
      <button id="placeBtn" class="place-btn sell"></button>
      <div id="chartTouchToolbar">
        <button id="chartTouchBuyBtn"></button>
        <button id="chartTouchSellBtn"></button>
        <div id="chartTouchHint"></div>
      </div>
    `;

    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 240, configurable: true });
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '5m';
    AppState.trading.currentSide = 'sell';
    AppState.market.candles = [{ c: '100' }];

    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockReturnValue(201.5);

    const { attachChartEvents, armChartPricePick } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());

    armChartPricePick('buy');
    expect(AppState.ui.chartTouchMode).toBe('buy');

    wrap.dispatchEvent(createPointerEvent('pointerdown', { clientX: 140, clientY: 90 }));
    wrap.dispatchEvent(createPointerEvent('pointerup', { clientX: 140, clientY: 90 }));

    expect(AppState.trading.currentSide).toBe('buy');
    expect(AppState.ui.chartTouchMode).toBe('inspect');
    expect(document.getElementById('priceInput').value).toBe('201.50');
    expect(document.getElementById('chartTouchBuyBtn').getAttribute('aria-pressed')).toBe('false');
  });

  it('delegates fit and live actions to the lightweight chart timescale', async () => {
    document.body.innerHTML = `
      <div id="chartTouchToolbar">
        <button id="chartTouchBuyBtn"></button>
        <button id="chartTouchSellBtn"></button>
        <div id="chartTouchHint"></div>
      </div>
    `;

    const lightweightModule = await import('../lightweight-chart.js');
    const fitLightweightChartToCandles = vi
      .spyOn(lightweightModule, 'fitLightweightChartToCandles')
      .mockReturnValue(true);
    const scrollToRealTime = vi.fn();
    const scrollToPosition = vi.fn();
    const clearPending = vi.spyOn(lightweightModule, 'clearPendingVisibleRangeRequests');
    vi.spyOn(lightweightModule, 'getChart').mockReturnValue({
      timeScale() {
        return {
          scrollToRealTime,
          scrollToPosition,
          options: () => ({ rightOffset: 5 }),
        };
      },
    });

    const { fitChartView, jumpChartToLive } = await import('../chart-interactions.js');
    fitChartView();
    jumpChartToLive();

    expect(fitLightweightChartToCandles).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalled();
    expect(scrollToPosition).toHaveBeenCalledWith(5, false);
    expect(scrollToRealTime).not.toHaveBeenCalled();
  });

  it('recenters price scale on double click over the price axis', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const lightweightModule = await import('../lightweight-chart.js');
    const recenterSpy = vi.spyOn(lightweightModule, 'recenterPriceScale').mockImplementation(() => true);
    vi.spyOn(lightweightModule, 'getChart').mockReturnValue({
      paneSize: () => ({ width: 350, height: 200 }),
      timeScale: () => ({ height: () => 20 }),
    });
    vi.spyOn(lightweightModule, 'getCandleSeries').mockReturnValue({
      priceScale: () => ({ width: () => 50 }),
    });

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());

    // Double-click over the right price axis (x = 380 >= 400 - 50)
    wrap.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, cancelable: true, clientX: 380, clientY: 100,
    }));

    expect(recenterSpy).toHaveBeenCalledTimes(1);
  });

  it('reliably arms vertical pan when mousedown is in the bottom 50px of pane 0', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const setVisibleRange = vi.fn();
    const setAutoScale = vi.fn();
    const priceScale = {
      width: () => 50,
      getVisibleRange: () => ({ from: 100, to: 200 }),
      setVisibleRange,
      setAutoScale,
    };
    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'getChart').mockReturnValue({
      paneSize: () => ({ width: 350, height: 200 }),
      timeScale: () => ({ height: () => 20 }),
    });
    vi.spyOn(lightweightModule, 'getCandleSeries').mockReturnValue({ priceScale: () => priceScale });
    // yRel = 180 is within pane 0 (height 200), but yRel + 50 = 230 is out of bounds
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockImplementation((y) => {
      if (y < 0 || y > 200) return null;
      return 200 - (y / 200) * 100;
    });

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());

    wrap.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, button: 0, buttons: 1, clientX: 100, clientY: 180,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, buttons: 1, clientX: 100, clientY: 150,
    }));

    expect(setAutoScale).toHaveBeenCalledWith(false);
    expect(setVisibleRange).toHaveBeenCalled();
  });

  it('pans the price scale on single-touch vertical drag', async () => {
    document.body.innerHTML = '<div id="chartWrap"></div>';
    const wrap = document.getElementById('chartWrap');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240 });

    const setVisibleRange = vi.fn();
    const setAutoScale = vi.fn();
    const priceScale = {
      width: () => 50,
      getVisibleRange: () => ({ from: 100, to: 200 }),
      setVisibleRange,
      setAutoScale,
    };
    const lightweightModule = await import('../lightweight-chart.js');
    vi.spyOn(lightweightModule, 'getChart').mockReturnValue({
      paneSize: () => ({ width: 350, height: 200 }),
      timeScale: () => ({ height: () => 20 }),
    });
    vi.spyOn(lightweightModule, 'getCandleSeries').mockReturnValue({ priceScale: () => priceScale });
    vi.spyOn(lightweightModule, 'coordinateToPrice').mockImplementation((y) => 200 - (y / 200) * 100);

    const { attachChartEvents } = await import('../chart-interactions.js');
    attachChartEvents(vi.fn());

    wrap.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 }));
    wrap.dispatchEvent(createPointerEvent('pointermove', { pointerId: 1, clientX: 100, clientY: 140 }));

    expect(setAutoScale).toHaveBeenCalledWith(false);
    expect(setVisibleRange).toHaveBeenCalled();
  });
});
