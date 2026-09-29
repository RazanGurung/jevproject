import { describe, expect, it, vi } from 'vitest';
import { createTopMoversService } from '../top-movers-service.js';

describe('createTopMoversService', () => {
  it('forwards the backend-ranked gainers/losers to applyMovers', async () => {
    const apiGet = vi.fn().mockResolvedValue({
      gainers: [{ coin: 'A', change: 5, oi: 100 }],
      losers: [{ coin: 'B', change: -3, oi: 90 }],
    });
    const applyMovers = vi.fn();
    const svc = createTopMoversService({ apiGet, applyMovers });

    const result = await svc.fetchTopMovers();

    expect(apiGet).toHaveBeenCalledWith('/api/market-movers');
    expect(applyMovers).toHaveBeenCalledTimes(1);
    const [gainers, losers] = applyMovers.mock.calls[0];
    expect(gainers.map((e) => e.coin)).toEqual(['A']);
    expect(losers.map((e) => e.coin)).toEqual(['B']);
    expect(result.gainers.map((e) => e.coin)).toEqual(['A']);
  });

  it('tolerates a malformed payload by applying empty rows', async () => {
    const apiGet = vi.fn().mockResolvedValue(null);
    const applyMovers = vi.fn();
    const svc = createTopMoversService({ apiGet, applyMovers });

    const result = await svc.fetchTopMovers();

    expect(applyMovers).toHaveBeenCalledWith([], []);
    expect(result).toEqual({ gainers: [], losers: [] });
  });

  it('swallows fetch errors and leaves rows untouched', async () => {
    const apiGet = vi.fn().mockRejectedValue(new Error('boom'));
    const applyMovers = vi.fn();
    const svc = createTopMoversService({ apiGet, applyMovers });

    const result = await svc.fetchTopMovers();

    expect(result).toBeNull();
    expect(applyMovers).not.toHaveBeenCalled();
  });

  it('start/stop polling uses injected timers', () => {
    const apiGet = vi.fn().mockResolvedValue([]);
    const setIntervalFn = vi.fn().mockReturnValue(42);
    const clearIntervalFn = vi.fn();
    const svc = createTopMoversService({ apiGet, setIntervalFn, clearIntervalFn });

    svc.startTopMoversPolling();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    svc.stopTopMoversPolling();
    expect(clearIntervalFn).toHaveBeenCalledWith(42);
  });

  it('retries quickly with backoff when startup returns empty data', async () => {
    const apiGet = vi.fn()
      .mockResolvedValueOnce({ gainers: [], losers: [] })
      .mockResolvedValueOnce({ gainers: [{ coin: 'BTC', change: 2.5 }], losers: [] });
    const applyMovers = vi.fn();
    const setTimeoutFn = vi.fn((cb) => { cb(); return 99; });
    const svc = createTopMoversService({ apiGet, applyMovers, setTimeoutFn });

    await svc.fetchTopMovers();

    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(applyMovers).toHaveBeenLastCalledWith([{ coin: 'BTC', change: 2.5 }], []);
  });

  it('retries quickly with backoff when early startup fetch throws', async () => {
    const apiGet = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ gainers: [{ coin: 'ETH', change: 3.1 }], losers: [] });
    const applyMovers = vi.fn();
    const setTimeoutFn = vi.fn((cb) => { cb(); return 99; });
    const svc = createTopMoversService({ apiGet, applyMovers, setTimeoutFn });

    await svc.fetchTopMovers();

    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(applyMovers).toHaveBeenCalledWith([{ coin: 'ETH', change: 3.1 }], []);
  });
});
