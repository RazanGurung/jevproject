import { describe, expect, it } from 'vitest';

import { fmtInputPrice, fmtPrice, getHyperliquidPriceDecimals } from '../format.js';
import { getPriceFormatDecimals, roundPriceToTick } from '../../services/trading-service-helpers.js';

describe('fmtInputPrice', () => {
  it('formats ticket prices with adaptive precision and trimmed zeros', () => {
    expect(fmtInputPrice(1234.5)).toBe('1234.5');
    expect(fmtInputPrice(12.3456)).toBe('12.3456');
    expect(fmtInputPrice(0.0123456)).toBe('0.012346');
  });

  it('supports fixed decimal formatting when callers need stable precision', () => {
    expect(fmtInputPrice(100.5, { decimals: 4 })).toBe('100.5');
    expect(fmtInputPrice(100.5, { decimals: 4, trimTrailingZeros: false })).toBe('100.5000');
  });

  it('returns empty strings for invalid or non-positive values', () => {
    expect(fmtInputPrice(0)).toBe('');
    expect(fmtInputPrice(-1)).toBe('');
    expect(fmtInputPrice(null)).toBe('');
  });

  it('supports tick-sized rounding and precision for instruments like BTC', () => {
    expect(getPriceFormatDecimals('BTC')).toBe(1);
    expect(roundPriceToTick(123.456, 'BTC')).toBe(123.5);
  });

  it('formats display prices using Hyperliquid-style significant-figure precision', () => {
    expect(getHyperliquidPriceDecimals(75756.5, 'BTC')).toBe(0);
    expect(fmtPrice(75756.5, 'BTC')).toBe('75757');
    expect(fmtPrice(2567.35, 'ETH')).toBe('2567.4');
    expect(fmtPrice(95.25, 'xyz:CL')).toBe('95.25');
  });
});
