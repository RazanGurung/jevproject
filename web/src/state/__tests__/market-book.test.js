import { describe, expect, it } from 'vitest';

describe('market book cache helpers', () => {
  it('caches and retrieves a book per coin', async () => {
    const { ingestBook, getCachedBook } = await import('../market-book.js');
    const marketState = {};
    const book = { bids: [{ px: 100, sz: 1 }], asks: [{ px: 101, sz: 2 }] };

    ingestBook(marketState, 'BTC', book);

    expect(getCachedBook(marketState, 'BTC')).toBe(book);
  });

  it('returns null for an uncached coin', async () => {
    const { getCachedBook } = await import('../market-book.js');
    const marketState = {};

    expect(getCachedBook(marketState, 'ETH')).toBeNull();
  });

  it('overwrites the cached entry for a coin on repeated ingest', async () => {
    const { ingestBook, getCachedBook } = await import('../market-book.js');
    const marketState = {};
    const first = { bids: [], asks: [] };
    const second = { bids: [{ px: 100, sz: 1 }], asks: [] };

    ingestBook(marketState, 'BTC', first);
    ingestBook(marketState, 'BTC', second);

    expect(getCachedBook(marketState, 'BTC')).toBe(second);
  });

  it('caches independently for multiple coins', async () => {
    const { ingestBook, getCachedBook } = await import('../market-book.js');
    const marketState = {};
    const btcBook = { bids: [], asks: [] };
    const ethBook = { bids: [{ px: 3000, sz: 5 }], asks: [] };

    ingestBook(marketState, 'BTC', btcBook);
    ingestBook(marketState, 'ETH', ethBook);

    expect(getCachedBook(marketState, 'BTC')).toBe(btcBook);
    expect(getCachedBook(marketState, 'ETH')).toBe(ethBook);
  });
});
