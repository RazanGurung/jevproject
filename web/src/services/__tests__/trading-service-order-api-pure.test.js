/** @vitest-environment jsdom */

// Pure-logic coverage for trading-service-order-api that uses no module
// mocking, so it runs in the offline harness as well as local Vitest. The
// mock-based retry/network behavior lives in the sibling order-api test file.

import { describe, expect, it } from 'vitest';
import {
  isTransientLimitFailure,
  extractAcceptedOrderLocks,
  parseOrderConfirmation,
  formatApiError,
  getPartialFillShortfall,
  formatPartialFillShortfallMessage,
  getClosePositionResidual,
  formatClosePositionResidualMessage,
} from '../trading-service-order-api.js';

describe('isTransientLimitFailure', () => {
  it('treats 429 / 500 / 502 status codes as transient', () => {
    expect(isTransientLimitFailure('', { status: 429 })).toBe(true);
    expect(isTransientLimitFailure('', { status: 500 })).toBe(true);
    expect(isTransientLimitFailure('', { status: 502 })).toBe(true);
  });

  it('detects transient patterns in the message text', () => {
    expect(isTransientLimitFailure('rate limit exceeded')).toBe(true);
    expect(isTransientLimitFailure('exchange http 429')).toBe(true);
    expect(isTransientLimitFailure('upstream HTTP 502')).toBe(true);
  });

  it('does not treat ordinary rejections as transient', () => {
    expect(isTransientLimitFailure('insufficient margin')).toBe(false);
    expect(isTransientLimitFailure('', { status: 400 })).toBe(false);
    expect(isTransientLimitFailure('')).toBe(false);
  });
});

describe('parseOrderConfirmation', () => {
  it('reports accepted orders with no error', () => {
    const out = parseOrderConfirmation({ accepted: true, filled: { sz: 1 } });
    expect(out).toEqual(expect.objectContaining({ accepted: true, filled: { sz: 1 }, error: '' }));
  });

  it('reports rejected orders with the exchange error', () => {
    const out = parseOrderConfirmation({ accepted: false, error: 'insufficient margin' });
    expect(out).toEqual(expect.objectContaining({ accepted: false, filled: null, error: 'insufficient margin' }));
  });

  it('falls back to a default error when none is given', () => {
    const out = parseOrderConfirmation({});
    expect(out.accepted).toBe(false);
    expect(out.error).toBe('Order was not confirmed by exchange');
  });
});

describe('extractAcceptedOrderLocks', () => {
  it('builds a lock from a single accepted order using its limit price', () => {
    const locks = extractAcceptedOrderLocks(
      { accepted: true, oid: 500 },
      [{ coin: 'BTC', isBuy: true, sz: 1, limitPx: 100 }],
    );
    expect(locks).toEqual([
      expect.objectContaining({ oid: 500, coin: 'BTC', limitPx: 100, side: 'B' }),
    ]);
  });

  it('builds locks from a statuses array and de-dupes repeated oids', () => {
    const locks = extractAcceptedOrderLocks(
      { statuses: [{ accepted: true, oid: 1 }, { accepted: true, oid: 1 }, { accepted: false, oid: 2 }] },
      [{ coin: 'BTC', limitPx: 100 }, { coin: 'BTC', limitPx: 101 }, { coin: 'ETH', limitPx: 2000 }],
    );
    expect(locks.map((l) => l.oid)).toEqual([1]);
  });

  it('skips orders without a usable price', () => {
    const locks = extractAcceptedOrderLocks(
      { accepted: true, oid: 9 },
      [{ coin: 'BTC', sz: 1 }],
    );
    expect(locks).toEqual([]);
  });
});

describe('getPartialFillShortfall', () => {
  // Live case (June 12, 2026): $100 market buy of xyz:CL sized to 1.216
  // coins, IoC filled only 0.185 @ 82.215 (~$15) — must be flagged.
  it('flags an IoC fill far below the requested notional', () => {
    const out = getPartialFillShortfall({ totalSz: '0.185', avgPx: '82.215' }, 100);
    expect(out).not.toBeNull();
    expect(out.filledUsd).toBeCloseTo(15.21, 2);
    expect(out.requestedUsd).toBe(100);
    expect(out.residualUsd).toBeCloseTo(84.79, 2);
    expect(out.fillPct).toBeCloseTo(15.21, 1);
  });

  it('accepts a full fill with normal price drift inside the tolerance', () => {
    expect(getPartialFillShortfall({ totalSz: '1.212', avgPx: '82.436' }, 100)).toBeNull();
    expect(getPartialFillShortfall({ totalSz: '1', avgPx: '98' }, 100)).toBeNull();
  });

  it('returns null when fill or request data is unusable', () => {
    expect(getPartialFillShortfall(null, 100)).toBeNull();
    expect(getPartialFillShortfall({ totalSz: '?', avgPx: '?' }, 100)).toBeNull();
    expect(getPartialFillShortfall({ totalSz: '1', avgPx: '100' }, 0)).toBeNull();
    expect(getPartialFillShortfall({ totalSz: '1', avgPx: '100' }, NaN)).toBeNull();
  });

  it('formats a residual-aware toast message', () => {
    const out = getPartialFillShortfall({ totalSz: '0.185', avgPx: '82.215' }, 100);
    const msg = formatPartialFillShortfallMessage(out);
    expect(msg).toContain('Partial fill: $15.21 of $100.00');
    expect(msg).toContain('residual ~$84.79');
    expect(msg).toContain('IoC');
  });
});

describe('getClosePositionResidual', () => {
  it('returns residual fields when the backend marks partial', () => {
    const out = getClosePositionResidual({
      status: 'ok',
      partial: true,
      requestedSzCoin: 0.5,
      filledSzCoin: 0.12,
      residualSzCoin: 0.38,
      avgPx: 64000,
      cloid: '0xabc',
    });
    expect(out).toEqual({
      requestedSzCoin: 0.5,
      filledSzCoin: 0.12,
      residualSzCoin: 0.38,
      avgPx: 64000,
      cloid: '0xabc',
    });
    expect(formatClosePositionResidualMessage('BTC', out)).toContain('Partial close BTC');
    expect(formatClosePositionResidualMessage('BTC', out)).toContain('0.12 of 0.5');
  });

  it('ignores full closes and non-ok responses', () => {
    expect(getClosePositionResidual({ status: 'ok', partial: false, requestedSzCoin: 1, filledSzCoin: 1 })).toBeNull();
    expect(getClosePositionResidual({ status: 'error', partial: true })).toBeNull();
    expect(getClosePositionResidual(null)).toBeNull();
  });
});

describe('parseOrderConfirmation cloid', () => {
  it('forwards auto-generated cloid on accepted place', () => {
    const out = parseOrderConfirmation({ accepted: true, oid: 1, cloid: '0xdeadbeefdeadbeefdeadbeefdeadbeef' });
    expect(out.cloid).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeef');
  });
});

describe('formatApiError', () => {
  it('combines prefix, url, status, and message', () => {
    const msg = formatApiError('Order failed', { url: '/api/order', status: 500, rawMessage: 'boom' });
    expect(msg).toBe('Order failed: /api/order 500 boom');
  });

  it('handles a bare error object with only a message', () => {
    expect(formatApiError('Cancel failed', { message: 'nope' })).toBe('Cancel failed: nope');
  });

  it('falls back to Unknown error', () => {
    expect(formatApiError('X', {})).toBe('X: Unknown error');
  });
});
