/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const AppState = {
  trading: {
    currentCoin: 'BTC',
  },
};

const getOpenOrders = vi.fn(() => []);
const modifyLimitPrice = vi.fn();
const modifyTriggerPrice = vi.fn();
const cancelOid = vi.fn();
const closePosition = vi.fn();

vi.mock('../../state/store.js', () => ({
  AppState,
}));

vi.mock('../../state/account-state.js', () => ({
  getOpenOrders,
}));

vi.mock('../../services/order-modify.js', () => ({
  modifyLimitPrice,
  modifyTriggerPrice,
}));

vi.mock('../../services/trading-service.js', () => ({
  cancelOid,
  closePosition,
}));

vi.mock('../../utils/format.js', () => ({
  fmtPrice: vi.fn((price) => String(price)),
}));

vi.mock('../../services/trading-service-helpers.js', () => ({
  roundPriceToTick: vi.fn((price) => price),
}));

describe('chart line labels', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="chartWrap"></div>';
    global.PointerEvent = global.PointerEvent || MouseEvent;
    const wrap = document.getElementById('chartWrap');
    Object.defineProperty(wrap, 'clientHeight', { value: 400, configurable: true });
    wrap.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      right: 400,
      bottom: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  it('anchors labels directly to their line locations, even when they overlap', async () => {
    const { createLineLabels } = await import('../chart-line-labels.js');
    const labels = createLineLabels({
      getContainer: () => document.getElementById('chartWrap'),
      priceToCoordinate: (price) => Number(price),
      coordinateToPrice: (y) => Number(y),
    });

    labels.syncOrderLabels([
      { oid: 1, coin: 'BTC', price: 100, side: 'B' },
      { oid: 2, coin: 'BTC', price: 110, side: 'A', tpsl: 'tp', reduceOnly: true },
      { oid: 3, coin: 'BTC', price: 90, side: 'A', tpsl: 'sl', reduceOnly: true },
      { oid: 4, coin: 'BTC', price: 120, side: 'B', triggerPx: 120 },
    ], 'BTC');
    labels.syncPositionLabels([
      { coin: 'BTC', price: 95, side: 'long' },
      { coin: 'BTC', price: 95, side: 'short' },
    ], 'BTC');

    const labelEls = Array.from(document.querySelectorAll('.chart-line-labels-overlay > div'))
      .filter((node) => node.querySelector('[data-role="kind"]'));
    const kindTexts = labelEls.map((node) => node.querySelector('[data-role="kind"]')?.textContent);
    const longLabel = labelEls.find((node) => node.querySelector('[data-role="kind"]')?.textContent === 'LONG');
    const shortLabel = labelEls.find((node) => node.querySelector('[data-role="kind"]')?.textContent === 'SHORT');
    const buyLabel = labelEls.find((node) => node.querySelector('[data-role="kind"]')?.textContent === 'BUY');
    const tpLabel = labelEls.find((node) => node.querySelector('[data-role="kind"]')?.textContent === 'TP');

    expect(kindTexts).toEqual(expect.arrayContaining(['BUY', 'TP', 'SL', 'LONG']));
    expect(kindTexts).toHaveLength(5);
    expect(longLabel?.style.top).toBe('95px');
    expect(shortLabel?.style.top).toBe('95px');
    expect(longLabel?.style.left).toBe('50%');
    expect(longLabel?.style.transform).toBe('translate(-50%, -50%)');
    expect(buyLabel?.style.left).toBe('2px');
    expect(buyLabel?.style.transform).toBe('translateY(-50%)');
    expect(tpLabel?.style.top).toBe('110px');
  });
});
