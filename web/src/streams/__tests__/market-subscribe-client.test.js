import { describe, expect, it, vi } from 'vitest';

describe('market subscribe client', () => {
  it('posts subscription payloads to the resolved api url', async () => {
    const { postMarketSubscription } = await import('../market-subscribe-client.js');
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const recordApiResult = vi.fn();

    await postMarketSubscription({
      payload: { clientId: 'abc', coin: 'BTC', interval: '1m', tradeCoins: ['BTC'] },
      fetchImpl,
      resolveApiUrl: (path) => `https://api.example.test${path}`,
      recordApiResult,
      sleep: vi.fn(),
    });


    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/api/market-subscribe',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      clientId: 'abc',
      coin: 'BTC',
      interval: '1m',
      tradeCoins: ['BTC'],
    });
    expect(recordApiResult).toHaveBeenCalledWith({
      url: 'https://api.example.test/api/market-subscribe',
      status: 200,
      ok: true,
    });
  });

  it('retries transient server failures before succeeding', async () => {
    const { postMarketSubscription } = await import('../market-subscribe-client.js');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await postMarketSubscription({
      payload: { clientId: 'abc', coin: 'BTC', interval: '1m', tradeCoins: ['BTC'] },
      retryDelaysMs: [250, 750],
      fetchImpl,
      resolveApiUrl: (path) => path,
      recordApiResult: vi.fn(),
      sleep,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 750);
  });

  it('returns the accepted coins and flow snapshots from a successful response', async () => {
    const { postMarketSubscription } = await import('../market-subscribe-client.js');
    const payload = {
      ok: true,
      acceptedTradeCoins: ['BTC', 'ETH'],
      flowSnapshots: { ETH: { buyVol: 12, sellVol: 8, sampleCount: 2 } },
    };

    const result = await postMarketSubscription({
      payload: { clientId: 'abc', coin: 'BTC', interval: '1m', tradeCoins: ['BTC', 'ETH'] },
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true, status: 200, json: vi.fn().mockResolvedValue(payload),
      }),
      resolveApiUrl: (path) => path,
      recordApiResult: vi.fn(),
      sleep: vi.fn(),
    });

    expect(result).toEqual(payload);
  });

  it('does not retry after abort', async () => {
    const { postMarketSubscription } = await import('../market-subscribe-client.js');
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(postMarketSubscription({
      payload: { clientId: 'abc', coin: 'BTC', interval: '1m', tradeCoins: ['BTC'] },
      retryDelaysMs: [250, 750],
      fetchImpl,
      resolveApiUrl: (path) => path,
      recordApiResult: vi.fn(),
      sleep,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws immediately on non-retryable failures', async () => {
    const { postMarketSubscription } = await import('../market-subscribe-client.js');

    await expect(postMarketSubscription({
      payload: { clientId: 'abc', coin: 'BTC', interval: '1m', tradeCoins: ['BTC'] },
      retryDelaysMs: [250, 750],
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 400 }),
      resolveApiUrl: (path) => path,
      recordApiResult: vi.fn(),
      sleep: vi.fn(),
    })).rejects.toThrow('market-subscribe failed: 400');
  });
});
