/** @vitest-environment jsdom */

// Pure normalization coverage for order-cancel (no module mocking, runs in the
// offline harness + local Vitest). Network/side-effect paths are covered
// separately in the sibling order-cancel test file.

import { describe, expect, it } from 'vitest';
import { normalizeCancels, buildCancelsFromOrders } from '../order-cancel.js';

describe('normalizeCancels', () => {
  it('keeps valid cancels and coerces the oid to a number', () => {
    expect(normalizeCancels([{ coin: 'BTC', oid: '1234' }])).toEqual([{ coin: 'BTC', oid: 1234 }]);
  });

  it('drops cancels with a missing coin or a non-positive / non-numeric oid', () => {
    const out = normalizeCancels([
      { coin: 'BTC', oid: 1 },
      { oid: 2 },              // no coin
      { coin: 'ETH', oid: 0 }, // non-positive
      { coin: 'SOL', oid: -5 },
      { coin: 'XRP', oid: 'abc' },
    ]);
    expect(out).toEqual([{ coin: 'BTC', oid: 1 }]);
  });

  it('returns an empty array for missing / empty input', () => {
    expect(normalizeCancels()).toEqual([]);
    expect(normalizeCancels([])).toEqual([]);
  });
});

describe('buildCancelsFromOrders', () => {
  it('maps open orders to {coin, oid} cancels and filters invalid ones', () => {
    const out = buildCancelsFromOrders([
      { coin: 'BTC', oid: 10, limitPx: 100 },
      { coin: 'ETH', oid: 0 },   // invalid oid
      { oid: 11 },               // no coin
      { coin: 'SOL', oid: '12' },
    ]);
    expect(out).toEqual([
      { coin: 'BTC', oid: 10 },
      { coin: 'SOL', oid: 12 },
    ]);
  });
});
