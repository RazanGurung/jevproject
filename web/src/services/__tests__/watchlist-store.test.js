/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'pez:watchlist';

function installMemoryLocalStorage() {
  const store = new Map();
  const memoryStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage,
  });
}

describe('watchlist store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installMemoryLocalStorage();
  });

  it('adds, persists, and reflects watchlisted state', async () => {
    const { addToWatchlist, getWatchlist, isWatchlisted } = await import('../watchlist-store.js');

    addToWatchlist('BTC');
    addToWatchlist('xyz:EURUSD');

    expect(getWatchlist()).toEqual(['BTC', 'xyz:EURUSD']);
    expect(isWatchlisted('BTC')).toBe(true);
    expect(isWatchlisted('ETH')).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual(['BTC', 'xyz:EURUSD']);
  });

  it('de-duplicates and ignores empty coins', async () => {
    const { addToWatchlist, getWatchlist } = await import('../watchlist-store.js');

    addToWatchlist('BTC');
    addToWatchlist('BTC');
    addToWatchlist('');
    addToWatchlist(undefined);

    expect(getWatchlist()).toEqual(['BTC']);
  });

  it('removes coins and persists the change', async () => {
    const { addToWatchlist, removeFromWatchlist, getWatchlist } = await import('../watchlist-store.js');

    addToWatchlist('BTC');
    addToWatchlist('ETH');
    removeFromWatchlist('BTC');

    expect(getWatchlist()).toEqual(['ETH']);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual(['ETH']);
  });

  it('loads an existing list from localStorage on first access', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['SOL', 'BTC']));

    const { getWatchlist } = await import('../watchlist-store.js');

    expect(getWatchlist()).toEqual(['SOL', 'BTC']);
  });

  it('strips non-xyz HIP-3 builder markets from storage and rejects adds', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['BTC', 'para:AVGO', 'xyz:NVDA', 'vntl:BTC']));

    const { getWatchlist, addToWatchlist, isWatchlisted } = await import('../watchlist-store.js');

    expect(getWatchlist()).toEqual(['BTC', 'xyz:NVDA']);
    addToWatchlist('mkts:US500');
    addToWatchlist('para:AVGO');
    expect(getWatchlist()).toEqual(['BTC', 'xyz:NVDA']);
    expect(isWatchlisted('para:AVGO')).toBe(false);
  });

  it('falls back to an empty list when stored JSON is corrupt', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{not valid json');

    const { getWatchlist } = await import('../watchlist-store.js');

    expect(getWatchlist()).toEqual([]);
  });

  it('returns a copy so callers cannot mutate internal state', async () => {
    const { addToWatchlist, getWatchlist } = await import('../watchlist-store.js');

    addToWatchlist('BTC');
    const list = getWatchlist();
    list.push('HACK');

    expect(getWatchlist()).toEqual(['BTC']);
  });
});
