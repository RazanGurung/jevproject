/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHoverPrefetchService } from '../hover-prefetch.js';

describe('createHoverPrefetchService', () => {
  let rootElement;
  let fetchFn;
  let getActiveCoin;
  let getActiveTimeframe;
  let timerCallbacks;
  let timerId;

  beforeEach(() => {
    rootElement = document.createElement('div');
    document.body.appendChild(rootElement);
    fetchFn = vi.fn().mockResolvedValue([]);
    getActiveCoin = vi.fn().mockReturnValue('BTC');
    getActiveTimeframe = vi.fn().mockReturnValue('2h');
    timerCallbacks = new Map();
    timerId = 0;
  });

  afterEach(() => {
    rootElement.remove();
    vi.restoreAllMocks();
  });

  const fakeSetTimeout = (cb, ms) => {
    const id = ++timerId;
    timerCallbacks.set(id, cb);
    return id;
  };

  const fakeClearTimeout = (id) => {
    timerCallbacks.delete(id);
  };

  const runTimers = () => {
    const cbs = [...timerCallbacks.values()];
    timerCallbacks.clear();
    for (const cb of cbs) cb();
  };

  it('triggers background prefetch after debounce when hovering over switchCoin candidate', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'switchCoin');
    btn.setAttribute('data-arg', 'SOL');
    rootElement.appendChild(btn);

    const svc = createHoverPrefetchService({
      fetchFn,
      getActiveCoin,
      getActiveTimeframe,
      debounceMs: 120,
      rootElement,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });
    svc.start();

    // Trigger mouseover on btn
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(timerCallbacks.size).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();

    // Advance debounce timer
    runTimers();
    expect(fetchFn).toHaveBeenCalledWith('SOL', '2h', { background: true });
    svc.stop();
  });

  it('does not prefetch if hovering over the currently active coin', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'switchCoin');
    btn.setAttribute('data-arg', 'BTC'); // active coin is BTC
    rootElement.appendChild(btn);

    const svc = createHoverPrefetchService({
      fetchFn,
      getActiveCoin,
      getActiveTimeframe,
      rootElement,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });
    svc.start();

    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(timerCallbacks.size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    svc.stop();
  });

  it('cancels pending timer if mouseout fires before debounce', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'switchCoin');
    btn.setAttribute('data-arg', 'ETH');
    rootElement.appendChild(btn);

    const svc = createHoverPrefetchService({
      fetchFn,
      getActiveCoin,
      getActiveTimeframe,
      rootElement,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });
    svc.start();

    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(timerCallbacks.size).toBe(1);

    // Mouse leaves
    btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: rootElement }));
    expect(timerCallbacks.size).toBe(0);

    runTimers();
    expect(fetchFn).not.toHaveBeenCalled();
    svc.stop();
  });

  it('respects cooldown and does not repeat prefetch for same coin within cooldown window', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'switchCoin');
    btn.setAttribute('data-arg', 'SOL');
    rootElement.appendChild(btn);

    let currentTime = 10000;
    const nowFn = () => currentTime;

    const svc = createHoverPrefetchService({
      fetchFn,
      getActiveCoin,
      getActiveTimeframe,
      cooldownMs: 15000,
      rootElement,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
      nowFn,
    });
    svc.start();

    // First hover
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    runTimers();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Mouse leaves
    btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

    // Second hover 2 seconds later (within 15s cooldown)
    currentTime += 2000;
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(timerCallbacks.size).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Hover 16 seconds later (past cooldown)
    currentTime += 16000;
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(timerCallbacks.size).toBe(1);
    runTimers();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    svc.stop();
  });

  it('cancels timer on click', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'switchCoin');
    btn.setAttribute('data-arg', 'SOL');
    rootElement.appendChild(btn);

    const svc = createHoverPrefetchService({
      fetchFn,
      getActiveCoin,
      getActiveTimeframe,
      rootElement,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });
    svc.start();

    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(timerCallbacks.size).toBe(1);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(timerCallbacks.size).toBe(0);
    svc.stop();
  });

  it('recognizes data-coin fallback when data-arg is absent', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'switchCoin');
    btn.setAttribute('data-coin', 'AVAX');
    rootElement.appendChild(btn);

    const svc = createHoverPrefetchService({
      fetchFn,
      getActiveCoin,
      getActiveTimeframe,
      debounceMs: 120,
      rootElement,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
    });
    svc.start();

    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(timerCallbacks.size).toBe(1);
    runTimers();
    expect(fetchFn).toHaveBeenCalledWith('AVAX', '2h', { background: true });
    svc.stop();
  });
});
