import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiPost = vi.fn();

vi.mock('../api.js', () => ({
  apiPost,
}));

describe('trading service order api lock extraction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates trigger-order locks from triggerPx when limitPx is absent', async () => {
    const { extractAcceptedOrderLocks } = await import('../trading-service-order-api.js');

    const locks = extractAcceptedOrderLocks(
      { accepted: true, oid: 999 },
      [{ coin: 'BTC', isBuy: false, sz: 250, triggerPx: 101500, reduceOnly: true, tpsl: 'tp' }]
    );

    expect(locks).toEqual([
      expect.objectContaining({
        oid: 999,
        coin: 'BTC',
        side: 'A',
        limitPx: 101500,
        triggerPx: 101500,
        reduceOnly: true,
        tpsl: 'tp',
      }),
    ]);
  });

  it('retries a transient single-order rejection once when enabled', async () => {
    vi.useFakeTimers();
    apiPost
      .mockResolvedValueOnce({ accepted: false, error: 'rate limit' })
      .mockResolvedValueOnce({ accepted: true, oid: 123 });

    const { submitOrderWithRetry } = await import('../trading-service-order-api.js');
    const request = submitOrderWithRetry({ coin: 'BTC' }, { allowRetry: true });
    await vi.runAllTimersAsync();
    const result = await request;

    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(result.confirmation).toEqual(expect.objectContaining({
      accepted: true,
      status: expect.objectContaining({ oid: 123 }),
    }));

    vi.useRealTimers();
  });

  it('does not replay a bulk 429 envelope', async () => {
    apiPost.mockResolvedValueOnce({ statuses: [{ accepted: false, error: '429 rate limit' }] });

    const { submitBulkOrdersWithConfirmation } = await import('../trading-service-order-api.js');
    const result = await submitBulkOrdersWithConfirmation({ orders: [{ coin: 'BTC' }] });

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(result.confirmation).toEqual(expect.objectContaining({
      acceptedCount: 0,
      ambiguous: true,
    }));
  });

  it('never replays an ambiguous transport failure', async () => {
    const error = Object.assign(new Error('upstream timeout'), { status: 502 });
    apiPost.mockRejectedValueOnce(error);

    const { submitOrderWithRetry } = await import('../trading-service-order-api.js');

    await expect(submitOrderWithRetry({ coin: 'BTC' }, { allowRetry: true })).rejects.toBe(error);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 200 envelope that marks the exchange outcome as ambiguous', async () => {
    apiPost.mockResolvedValueOnce({ accepted: false, error: 'http 429', ambiguous: true, cloid: '0xabc' });

    const { submitOrderWithRetry } = await import('../trading-service-order-api.js');
    const result = await submitOrderWithRetry({ coin: 'BTC' }, { allowRetry: true });

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(result.confirmation.ambiguous).toBe(true);
    expect(apiPost.mock.calls[0][1].cloid).toMatch(/^0x[a-f0-9]{32}$/);
  });

  it('does not treat a venue 400 as ambiguous', async () => {
    apiPost.mockResolvedValueOnce({
      accepted: false,
      error: 'http 400: Order must have minimum value of $10.',
      ambiguous: false,
    });

    const { submitOrderWithRetry } = await import('../trading-service-order-api.js');
    const result = await submitOrderWithRetry({ coin: 'BTC' }, { allowRetry: true });

    expect(result.confirmation.ambiguous).toBe(false);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});
