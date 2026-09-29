/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'pez:hide-list';

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

describe('hide list store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installMemoryLocalStorage();
  });

  it('adds, persists, and reflects hide-listed state', async () => {
    const { addToHideList, getHideList, isHideListed } = await import('../hide-list-store.js');

    addToHideList('BTC');
    addToHideList('xyz:EURUSD');

    expect(getHideList()).toEqual(['BTC', 'xyz:EURUSD']);
    expect(isHideListed('BTC')).toBe(true);
    expect(isHideListed('ETH')).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual(['BTC', 'xyz:EURUSD']);
  });

  it('de-duplicates and ignores empty coins', async () => {
    const { addToHideList, getHideList } = await import('../hide-list-store.js');

    addToHideList('BTC');
    addToHideList('BTC');
    addToHideList('');
    addToHideList(undefined);

    expect(getHideList()).toEqual(['BTC']);
  });

  it('removes coins and persists the change', async () => {
    const { addToHideList, removeFromHideList, getHideList } = await import('../hide-list-store.js');

    addToHideList('BTC');
    addToHideList('ETH');
    removeFromHideList('BTC');

    expect(getHideList()).toEqual(['ETH']);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual(['ETH']);
  });

  it('loads an existing list from localStorage on first access', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['SOL', 'BTC']));

    const { getHideList } = await import('../hide-list-store.js');

    expect(getHideList()).toEqual(['SOL', 'BTC']);
  });

  it('falls back to pez:hidelist key if present', async () => {
    window.localStorage.setItem('pez:hidelist', JSON.stringify(['AVAX', 'DOGE']));

    const { getHideList } = await import('../hide-list-store.js');

    expect(getHideList()).toEqual(['AVAX', 'DOGE']);
  });

  it('strips non-xyz HIP-3 builder markets from storage and rejects adds', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['BTC', 'para:AVGO', 'xyz:NVDA', 'vntl:BTC']));

    const { getHideList, addToHideList, isHideListed } = await import('../hide-list-store.js');

    expect(getHideList()).toEqual(['BTC', 'xyz:NVDA']);
    addToHideList('mkts:US500');
    addToHideList('para:AVGO');
    expect(getHideList()).toEqual(['BTC', 'xyz:NVDA']);
    expect(isHideListed('para:AVGO')).toBe(false);
  });

  it('falls back to an empty list when stored JSON is corrupt', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{not valid json');

    const { getHideList } = await import('../hide-list-store.js');

    expect(getHideList()).toEqual([]);
  });

  it('notifies subscribers on change', async () => {
    const { addToHideList, removeFromHideList, subscribeHideList } = await import('../hide-list-store.js');

    const calls = [];
    const unsubscribe = subscribeHideList(() => calls.push(1));

    addToHideList('BTC');
    removeFromHideList('BTC');
    expect(calls.length).toBe(2);

    unsubscribe();
    addToHideList('ETH');
    expect(calls.length).toBe(2);
  });

  it('returns a copy so callers cannot mutate internal state', async () => {
    const { addToHideList, getHideList } = await import('../hide-list-store.js');

    addToHideList('BTC');
    const list = getHideList();
    list.push('HACK');

    expect(getHideList()).toEqual(['BTC']);
  });
});
