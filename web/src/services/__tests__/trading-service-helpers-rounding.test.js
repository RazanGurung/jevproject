/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTickSize = vi.fn();
const getCoinDecimals = vi.fn();

vi.mock('../../state/coin-meta.js', () => ({
  getTickSize,
  getCoinDecimals,
}));

vi.mock('../../state/trading-selectors.js', () => ({
  getLastDeployedPlan: vi.fn(() => null),
  getCurrentPrice: vi.fn(() => 0),
}));

vi.mock('../../state/market-selectors.js', () => ({
  getAllMids: vi.fn(() => ({})),
}));

// roundPriceToTick must mirror backend normalizePerpPrice so the price shown
// on a dragged chart label equals the price sent to the exchange.
describe('roundPriceToTick backend parity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('applies tick rounding then the 5-significant-figure cap', async () => {
    getTickSize.mockReturnValue(0.5);
    getCoinDecimals.mockReturnValue(3);
    const { roundPriceToTick } = await import('../trading-service-helpers.js');

    // 50000.3 → tick 50000.5 → 5 sig figs 50001 (matches Go math.Round)
    expect(roundPriceToTick(50000.3, 'BTC')).toBe(50001);
    // Already wire-valid prices pass through unchanged.
    expect(roundPriceToTick(50000, 'BTC')).toBe(50000);
  });

  it('caps sub-dollar prices at 5 significant figures', async () => {
    getTickSize.mockReturnValue(0.000001);
    getCoinDecimals.mockReturnValue(0);
    const { roundPriceToTick } = await import('../trading-service-helpers.js');

    expect(roundPriceToTick(0.1234567, 'DOGE')).toBe(0.12346);
  });

  it('applies the (6 - szDecimals) max-decimals rule for all perps', async () => {
    getTickSize.mockReturnValue(0.0001);
    getCoinDecimals.mockReturnValue(3);
    const { roundPriceToTick } = await import('../trading-service-helpers.js');

    expect(roundPriceToTick(1.23456, 'xyz:ABC')).toBe(1.235);
    expect(roundPriceToTick(1.23456, 'ETH')).toBe(1.235);
  });

  it('preserves integer prices and applies 6-szDecimals on cheap standard perps', async () => {
    getTickSize.mockReturnValue(1);
    getCoinDecimals.mockReturnValue(2);
    const { roundPriceToTick } = await import('../trading-service-helpers.js');
    expect(roundPriceToTick(123456, 'BTC')).toBe(123456);

    getTickSize.mockReturnValue(0.000001);
    getCoinDecimals.mockReturnValue(1);
    expect(roundPriceToTick(0.012345, 'DOGE')).toBe(0.01235);
  });
});
