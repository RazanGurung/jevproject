/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('transport metrics', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="statusDot"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks API success, rate limits, and dedup hits', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'ok' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'rate limit exceeded' }),
      });

    const sameRequest = deferred();
    const { apiPost, fetchWithDedup } = await import('../api.js');
    const { getTransportMetricsSnapshot, resetTransportMetricsForTests } = await import('../transport-metrics.js');
    resetTransportMetricsForTests();

    await apiPost('/api/test-ok', { ok: true });
    await expect(apiPost('/api/test-rate-limit', { ok: false })).rejects.toThrow(/429|rate limit/i);

    const fetchFn = vi.fn(() => sameRequest.promise);
    const dedupPromiseA = fetchWithDedup('same-key', fetchFn);
    const dedupPromiseB = fetchWithDedup('same-key', fetchFn);
    sameRequest.resolve('ok');
    await Promise.all([dedupPromiseA, dedupPromiseB]);

    const metrics = getTransportMetricsSnapshot();
    expect(metrics.api.requests).toBe(2);
    expect(metrics.api.successes).toBe(1);
    expect(metrics.api.errors).toBe(1);
    expect(metrics.api.rateLimits).toBe(1);
    expect(metrics.api.dedupHits).toBe(1);
    expect(metrics.api.byUrl['/api/test-ok']).toEqual(expect.objectContaining({
      requests: 1,
      successes: 1,
      errors: 0,
    }));
    expect(metrics.api.byUrl['/api/test-rate-limit']).toEqual(expect.objectContaining({
      requests: 1,
      errors: 1,
      rateLimits: 1,
      lastStatus: 429,
    }));
  });

  it('tracks stream reconnects and tab-resume recovery paths', async () => {
    class MockWebSocket {
      static instances = [];
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.CONNECTING;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        MockWebSocket.instances.push(this);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    global.WebSocket = MockWebSocket;
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({}),
    }));

    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0xabc';

    const { getTransportMetricsSnapshot, resetTransportMetricsForTests } = await import('../transport-metrics.js');
    resetTransportMetricsForTests();

    const { connectAccountStream, disconnectAccountStream } = await import('../../streams/account-stream.js');
    connectAccountStream();

    const socket = global.WebSocket.instances[0];
    socket.readyState = global.WebSocket.OPEN;
    socket.onopen?.();
    socket.onclose?.();

    const { createTabResumeRecoverer } = await import('../tab-resume.js');
    const recoverAfterTabResume = createTabResumeRecoverer({
      getNow: () => Date.now(),
      getWalletAddress: () => '0xabc',
      getAccountStreamSocket: () => ({ readyState: 2 }),
      getSocketClosedState: () => 2,
      restoreBackendSession: () => Promise.resolve(true),
      connectAccountStream: vi.fn(),
      fetchAccount: vi.fn(),
      refreshExchangeInfo: vi.fn(() => Promise.resolve()),
      ensureRadarNewsCoverage: vi.fn(() => Promise.resolve()),
      startNewsPolling: vi.fn(),
      requestFrame: (cb) => cb?.(),
      scheduleTimeout: (cb) => {
        cb?.();
        return 1;
      },
    });
    recoverAfterTabResume('focus');
    await Promise.resolve();
    await Promise.resolve();

    const metrics = getTransportMetricsSnapshot();
    expect(metrics.stream).toEqual(expect.objectContaining({
      connectAttempts: 1,
      connects: 1,
      reconnectSchedules: 1,
    }));
    expect(metrics.resume).toEqual(expect.objectContaining({
      events: 1,
      closedRecoveries: 1,
    }));

    disconnectAccountStream();
  });
});
