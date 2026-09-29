/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import { AppState } from '../store.js';
import {
  normalizeOrderOid,
  normalizeLockedOrder,
  normalizeBackendOpenOrder,
  normalizeBackendOpenOrders,
  mergeLockedOpenOrders,
  registerLockedOpenOrder,
  clearLockedOpenOrder,
  clearLockedOpenOrdersByCoin,
  removeOpenOrdersByOids,
  removeOpenOrdersByCoin,
  reconcileIncomingOpenOrders,
  resetOrderState,
} from '../account-state-orders.js';

beforeEach(() => {
  resetOrderState();
  AppState.account.openOrders = [];
});

describe('normalizeOrderOid', () => {
  it('accepts a positive numeric oid', () => {
    expect(normalizeOrderOid({ oid: 1234 })).toBe(1234);
    expect(normalizeOrderOid({ oid: '5678' })).toBe(5678);
  });

  it('rejects zero, negative, missing, and non-numeric oids', () => {
    expect(normalizeOrderOid({ oid: 0 })).toBeNull();
    expect(normalizeOrderOid({ oid: -1 })).toBeNull();
    expect(normalizeOrderOid({})).toBeNull();
    expect(normalizeOrderOid({ oid: 'abc' })).toBeNull();
    expect(normalizeOrderOid(null)).toBeNull();
  });
});

describe('normalizeLockedOrder', () => {
  it('normalizes a plain limit order', () => {
    const out = normalizeLockedOrder({ oid: 10, coin: 'BTC', limitPx: 100, side: 'buy' });
    expect(out).toEqual(expect.objectContaining({ oid: 10, coin: 'BTC', limitPx: 100, side: 'B' }));
  });

  it('prefers the trigger price for a stop order and infers tpsl', () => {
    const out = normalizeLockedOrder({ oid: 11, coin: 'ETH', triggerPx: 2500, tpsl: 'sl' });
    expect(out).toEqual(expect.objectContaining({
      oid: 11, coin: 'ETH', limitPx: 2500, triggerPx: 2500, side: 'A', tpsl: 'sl',
    }));
  });

  it('returns null when oid, coin, or a usable price is missing', () => {
    expect(normalizeLockedOrder({ coin: 'BTC', limitPx: 100 })).toBeNull();
    expect(normalizeLockedOrder({ oid: 1, limitPx: 100 })).toBeNull();
    expect(normalizeLockedOrder({ oid: 1, coin: 'BTC' })).toBeNull();
    expect(normalizeLockedOrder({ oid: 1, coin: 'BTC', limitPx: 0 })).toBeNull();
  });
});

describe('normalizeBackendOpenOrder(s)', () => {
  it('adds coerced sz and timestamp', () => {
    const out = normalizeBackendOpenOrder({ oid: 1, coin: 'BTC', limitPx: 100, sz: '3', timestamp: 50 });
    expect(out).toEqual(expect.objectContaining({ oid: 1, coin: 'BTC', limitPx: 100, sz: 3, timestamp: 50 }));
  });

  it('filters out invalid orders from a batch', () => {
    const out = normalizeBackendOpenOrders([
      { oid: 1, coin: 'BTC', limitPx: 100 },
      { oid: 0, coin: 'BTC', limitPx: 100 }, // invalid oid
      null,
      { oid: 2, coin: 'ETH', limitPx: 2000 },
    ]);
    expect(out.map((o) => o.oid)).toEqual([1, 2]);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeBackendOpenOrders(null)).toEqual([]);
    expect(normalizeBackendOpenOrders(undefined)).toEqual([]);
  });
});

describe('locked open order lifecycle', () => {
  it('registers a locked order and surfaces it via merge', () => {
    registerLockedOpenOrder({ oid: 42, coin: 'BTC', limitPx: 100 });
    const merged = mergeLockedOpenOrders([]);
    expect(merged.map((o) => o.oid)).toContain(42);
    expect(AppState.account.openOrders.map((o) => o.oid)).toContain(42);
  });

  it('does not duplicate a locked order already present in the incoming list', () => {
    registerLockedOpenOrder({ oid: 42, coin: 'BTC', limitPx: 100 });
    const merged = mergeLockedOpenOrders([{ oid: 42, coin: 'BTC', limitPx: 100 }]);
    expect(merged.filter((o) => Number(o.oid) === 42)).toHaveLength(1);
  });

  it('clearLockedOpenOrder stops the order from being re-merged', () => {
    registerLockedOpenOrder({ oid: 42, coin: 'BTC', limitPx: 100 });
    expect(clearLockedOpenOrder(42)).toBe(true);
    expect(mergeLockedOpenOrders([]).map((o) => o.oid)).not.toContain(42);
  });

  it('clearLockedOpenOrdersByCoin clears only the matching coin', () => {
    registerLockedOpenOrder({ oid: 1, coin: 'BTC', limitPx: 100 });
    registerLockedOpenOrder({ oid: 2, coin: 'ETH', limitPx: 2000 });
    expect(clearLockedOpenOrdersByCoin('BTC')).toBe(true);
    const merged = mergeLockedOpenOrders([]);
    expect(merged.map((o) => o.oid)).toEqual([2]);
  });
});

describe('removal + reconciliation grace window', () => {
  it('removeOpenOrdersByOids drops the order from open orders', () => {
    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', limitPx: 100 },
      { oid: 2, coin: 'ETH', limitPx: 2000 },
    ];
    const next = removeOpenOrdersByOids([1]);
    expect(next.map((o) => o.oid)).toEqual([2]);
  });

  it('a freshly removed oid is filtered back out of incoming exchange data', () => {
    AppState.account.openOrders = [{ oid: 1, coin: 'BTC', limitPx: 100 }];
    removeOpenOrdersByOids([1]);
    // The exchange snapshot still lists oid 1 (stale) - it must stay removed.
    const reconciled = reconcileIncomingOpenOrders(
      [{ oid: 1, coin: 'BTC', limitPx: 100 }],
      [],
    );
    expect(reconciled.map((o) => o.oid)).not.toContain(1);
  });

  it('removeOpenOrdersByCoin drops every order for that coin', () => {
    AppState.account.openOrders = [
      { oid: 1, coin: 'BTC', limitPx: 100 },
      { oid: 2, coin: 'BTC', limitPx: 101 },
      { oid: 3, coin: 'ETH', limitPx: 2000 },
    ];
    const next = removeOpenOrdersByCoin('BTC');
    expect(next.map((o) => o.oid)).toEqual([3]);
  });

  it('reconcileIncomingOpenOrders normalizes and passes through fresh orders', () => {
    const reconciled = reconcileIncomingOpenOrders(
      [{ oid: 5, coin: 'SOL', limitPx: 150, sz: '2' }],
      [],
    );
    expect(reconciled.map((o) => o.oid)).toEqual([5]);
    expect(reconciled[0].sz).toBe(2);
  });
});
