import { describe, expect, it } from 'vitest';

describe('api service', () => {
  it('can be imported without browser globals', async () => {
    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;

    try {
      delete globalThis.window;
      delete globalThis.document;

      const api = await import('../api.js');
      expect(api.resolveApiUrl('/api/hl')).toBe('/api/hl');
			expect(api.resolveWebSocketUrl('/api/trading-stream')).toBe('/api/trading-stream');
    } finally {
      if (priorWindow === undefined) delete globalThis.window;
      else globalThis.window = priorWindow;

      if (priorDocument === undefined) delete globalThis.document;
      else globalThis.document = priorDocument;
    }
  });
});

describe('background-lane circuit breaker', () => {
  const fail502 = () => Promise.resolve({
    ok: false,
    status: 502,
    text: async () => JSON.stringify({ error: 'upstream HTTP 429' }),
  });
  const ok200 = () => Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{ t: 1 }]),
  });

  it('skips retries after consecutive background transient failures, closes on success', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    global.fetch = vi.fn(fail502);
    const { hlPost } = await import('../api.js');

    // Three background requests fail through the full retry ladder
    // (1 attempt + 2 retries each), opening the breaker.
    for (let i = 0; i < 3; i++) {
      await expect(hlPost({ type: 'candleSnapshot' }, { background: true })).rejects.toThrow();
    }
    expect(global.fetch).toHaveBeenCalledTimes(9);

    // Breaker open: the next background request makes exactly one attempt.
    await expect(hlPost({ type: 'candleSnapshot' }, { background: true })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(10);

    // Foreground requests keep their retries even while the breaker is open.
    await expect(hlPost({ type: 'candleSnapshot' })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(13);

    // A success closes the breaker; background retries come back.
    global.fetch.mockImplementationOnce(ok200);
    await hlPost({ type: 'candleSnapshot' }, { background: true });
    global.fetch.mockImplementation(fail502);
    await expect(hlPost({ type: 'candleSnapshot' }, { background: true })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(17); // 13 + 1 success + 3 attempts
  });

  it('retries chart-candles when the tab network is suspended', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const suspended = Object.assign(new TypeError('Failed to fetch'), {
      message: 'Failed to fetch',
    });
    global.fetch = vi.fn()
      .mockRejectedValueOnce(suspended)
      .mockImplementationOnce(ok200);
    const { chartCandlesPost } = await import('../api.js');

    const rows = await chartCandlesPost({ coin: 'BTC', interval: '2h', startTime: 1, endTime: 2 });
    expect(rows).toEqual([{ t: 1 }]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries chart-candles on 502 the same way as hlPost', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    global.fetch = vi.fn()
      .mockImplementationOnce(fail502)
      .mockImplementationOnce(ok200);
    const { chartCandlesPost } = await import('../api.js');

    const rows = await chartCandlesPost({ coin: 'BTC', interval: '2h', startTime: 1, endTime: 2 });
    expect(rows).toEqual([{ t: 1 }]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(global.fetch.mock.calls[0][0])).toContain('/api/chart-candles');
  });

  it('does not retry intentional cancels', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    global.fetch = vi.fn(() => Promise.reject(abortErr));
    const { chartCandlesPost, isCanceledRequestError } = await import('../api.js');
    const controller = new AbortController();
    controller.abort();

    await expect(chartCandlesPost({ coin: 'BTC', interval: '2h' }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(isCanceledRequestError({ status: 504, rawMessage: 'request canceled' })).toBe(true);
  });

  it('sends the API token on GET requests', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    globalThis.window = {
      localStorage: {
        getItem: () => 'secret-token',
        setItem: () => {},
        removeItem: () => {},
      },
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hasKey: false }),
    }));
    const { apiGet } = await import('../api.js');
    await apiGet('/api/has-saved-key');
    expect(global.fetch).toHaveBeenCalledWith('/api/has-saved-key', {
      headers: { Authorization: 'Bearer secret-token' },
    });
  });
});

describe('fetchWithDedup abort identity', () => {
  it('does not join an aborted in-flight promise', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const { fetchWithDedup } = await import('../api.js');
    const firstController = new AbortController();
    let resolveFirst;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const firstCall = fetchWithDedup('candles:BTC:2h', () => first, { signal: firstController.signal });
    firstController.abort();
    const second = fetchWithDedup('candles:BTC:2h', () => Promise.resolve('fresh'), { signal: new AbortController().signal });
    resolveFirst('stale');
    await expect(firstCall).resolves.toBe('stale');
    await expect(second).resolves.toBe('fresh');
  });
});
