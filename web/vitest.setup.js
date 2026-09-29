/**
 * Node 26 exposes experimental Web Storage that is inert unless
 * --localstorage-file is set. That shadows jsdom's storage and leaves
 * window.localStorage / sessionStorage undefined in browser suites.
 * Provide an in-memory Storage implementation for the test environment.
 */
function createMemoryStorage() {
  let map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      const k = String(key);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map = new Map();
    },
  };
}

function installStorage(target) {
  if (!target) return;
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  try {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      enumerable: true,
      value: local,
    });
    Object.defineProperty(target, 'sessionStorage', {
      configurable: true,
      enumerable: true,
      value: session,
    });
  } catch {
    target.localStorage = local;
    target.sessionStorage = session;
  }
}

installStorage(globalThis);
if (typeof window !== 'undefined') {
  installStorage(window);
}
