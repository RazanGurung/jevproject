import { describe, it, expect, vi } from 'vitest';
import { createPreloadHintService } from '../preload-hint-service.js';

function manualTimers() {
  let timeoutCb = null;
  let intervalCb = null;
  return {
    setTimeoutFn: (cb) => { timeoutCb = cb; return 1; },
    clearTimeoutFn: () => { timeoutCb = null; },
    setIntervalFn: (cb) => { intervalCb = cb; return 2; },
    clearIntervalFn: () => { intervalCb = null; },
    fireTimeout: () => timeoutCb && timeoutCb(),
    fireInterval: () => intervalCb && intervalCb(),
    hasInterval: () => intervalCb !== null,
  };
}

describe('createPreloadHintService', () => {
  it('posts the watchlist after the start delay and on keep-alive', async () => {
    const t = manualTimers();
    const apiPost = vi.fn().mockResolvedValue({});
    const svc = createPreloadHintService({
      apiPost,
      getWatchlist: () => ['BTC', 'xyz:AAPL'],
      subscribeWatchlist: () => () => {},
      ...t,
    });

    svc.startPreloadHints();
    expect(apiPost).not.toHaveBeenCalled(); // waits for the delay

    t.fireTimeout();
    expect(apiPost).toHaveBeenCalledWith('/api/preload-hint', { watchlist: ['BTC', 'xyz:AAPL'] });

    t.fireInterval();
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('re-posts immediately when the watchlist changes', () => {
    const t = manualTimers();
    const apiPost = vi.fn().mockResolvedValue({});
    let changeCb = null;
    const svc = createPreloadHintService({
      apiPost,
      getWatchlist: () => ['SOL'],
      subscribeWatchlist: (cb) => { changeCb = cb; return () => { changeCb = null; }; },
      ...t,
    });

    svc.startPreloadHints();
    changeCb(); // watchlist edited
    expect(apiPost).toHaveBeenCalledWith('/api/preload-hint', { watchlist: ['SOL'] });
  });

  it('stops the keep-alive and unsubscribes on stop', () => {
    const t = manualTimers();
    const apiPost = vi.fn().mockResolvedValue({});
    const unsubscribe = vi.fn();
    const svc = createPreloadHintService({
      apiPost,
      getWatchlist: () => [],
      subscribeWatchlist: () => unsubscribe,
      ...t,
    });

    svc.startPreloadHints();
    t.fireTimeout();
    svc.stopPreloadHints();
    expect(unsubscribe).toHaveBeenCalled();
    expect(t.hasInterval()).toBe(false);
  });

  it('swallows POST failures', async () => {
    const t = manualTimers();
    const apiPost = vi.fn().mockRejectedValue(new Error('network'));
    const svc = createPreloadHintService({
      apiPost,
      getWatchlist: () => ['BTC'],
      subscribeWatchlist: () => () => {},
      ...t,
    });
    svc.startPreloadHints();
    await expect(svc.postWatchlist()).resolves.toBeUndefined();
  });

  it('hydrates the exact accepted coin identities and caps the posted list', async () => {
    const t = manualTimers();
    const watchlist = Array.from({ length: 55 }, (_, i) => `COIN${i}`);
    const apiPost = vi.fn().mockResolvedValue({
      accepted: 2,
      acceptedCoins: ['COIN1', 'COIN49'],
    });
    const onAcceptedWatchlist = vi.fn();
    const svc = createPreloadHintService({
      apiPost,
      getWatchlist: () => watchlist,
      subscribeWatchlist: () => () => {},
      onAcceptedWatchlist,
      ...t,
    });

    await svc.postWatchlist();

    expect(apiPost).toHaveBeenCalledWith('/api/preload-hint', {
      watchlist: watchlist.slice(0, 50),
    });
    expect(onAcceptedWatchlist).toHaveBeenCalledWith(['COIN1', 'COIN49']);
  });

  it('notifies hydration ownership when the primary-tab service stops', () => {
    const t = manualTimers();
    const onStop = vi.fn();
    const svc = createPreloadHintService({
      apiPost: vi.fn().mockResolvedValue({}),
      getWatchlist: () => [],
      subscribeWatchlist: () => () => {},
      onStop,
      ...t,
    });

    svc.startPreloadHints();
    svc.stopPreloadHints();

    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
