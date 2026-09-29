/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('news service', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    global.fetch = vi.fn();
    const { AppState } = await import('../../state/store.js');
    AppState.market.newsConfigured = true;
    AppState.market.newsLoading = false;
    AppState.market.newsError = '';
    AppState.market.newsByCoin = {};
    AppState.trading.currentCoin = 'BTC';
    // Radar defaults to disconnected on boot; the fetch/cooldown paths under
    // test only run when the user has enabled radar.
    AppState.ui.marketRadarConnected = true;
  });

  it('deduplicates in-flight radar news fetches for the same coin set', async () => {
    let resolveFetch;
    global.fetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { fetchRadarNews } = await import('../news-service.js');

    const first = fetchRadarNews(['BTC']);
    const second = fetchRadarNews(['BTC']);

    expect(global.fetch).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        configured: true,
        provider: 'google-news-rss',
        items: { BTC: [{ headline: 'BTC moves', source: 'Test' }] },
      }),
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.BTC).toHaveLength(1);
    expect(secondResult).toStrictEqual(firstResult);
  });

  it('applies a cooldown after failed news fetches so rerenders do not refetch immediately', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: 'bad gateway' }),
    });

    const { ensureRadarNewsCoverage } = await import('../news-service.js');

    await expect(ensureRadarNewsCoverage()).rejects.toThrow('API GET failed: 502');
    await ensureRadarNewsCoverage().catch(() => {});

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('recurring poll ticks honor the freshness gate instead of forcing a refetch', async () => {
    vi.useFakeTimers();
    try {
      const okResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          configured: true,
          provider: 'google-news-rss',
          items: { BTC: [{ headline: 'BTC moves', source: 'Test' }] },
        }),
      };
      global.fetch.mockResolvedValue(okResponse);

      const { startNewsPolling, ensureRadarNewsCoverage, stopNewsPolling } = await import('../news-service.js');

      // Explicit start forces an immediate fetch.
      startNewsPolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // A render-triggered refresh lands 35s in (past the 15s min interval).
      await vi.advanceTimersByTimeAsync(35000);
      await ensureRadarNewsCoverage();
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // A short interval remains inside the 30s freshness gate.
      await vi.advanceTimersByTimeAsync(10000);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // The 120s reconciliation tick refreshes normally; streaming is the
      // primary path between snapshots.
      await vi.advanceTimersByTimeAsync(75000);
      expect(global.fetch).toHaveBeenCalledTimes(3);

      stopNewsPolling();
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges streamed global and coin news by stable id', async () => {
    const { AppState } = await import('../../state/store.js');
    const { ingestNewsStream } = await import('../news-service.js');
    const publishedAt = new Date().toISOString();
    ingestNewsStream({ items: [
      { id: 'global-1', headline: 'Macro event', scope: 'global', source: 'Official', publishedAt },
      { id: 'btc-1', headline: 'Bitcoin event', coins: ['BTC'], source: 'Desk', publishedAt },
    ] });
    ingestNewsStream({ items: [{ id: 'btc-1', headline: 'Bitcoin event', coins: ['BTC'], source: 'Desk', publishedAt }] });

    expect(AppState.market.newsItems.map((item) => item.id)).toEqual(['global-1']);
    expect(AppState.market.newsByCoin.BTC.map((item) => item.id)).toEqual(['btc-1']);
  });

  it('fetches only the newly selected ticker and schedules its repaint', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        configured: true,
        items: { ETH: [{ id: 'eth-1', headline: 'Ethereum update', source: 'Desk' }] },
      }),
    });
    const { refreshTickerNews } = await import('../news-service.js');

    await refreshTickerNews('ETH');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('coins=ETH');
  });

  it('reuses recent per-ticker news when rapid navigation returns to a coin', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        configured: true,
        items: { ETH: [{ id: 'eth-1', headline: 'Ethereum update', source: 'Desk' }] },
      }),
    });
    const { refreshTickerNews } = await import('../news-service.js');

    await refreshTickerNews('ETH');
    await refreshTickerNews('ETH');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
