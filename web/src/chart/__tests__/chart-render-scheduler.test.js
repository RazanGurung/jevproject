import { describe, expect, it, vi } from 'vitest';

describe('chart render scheduler', () => {
  it('coalesces repeated render requests into one animation frame', async () => {
    const { createChartRenderScheduler } = await import('../chart-render-scheduler.js');
    const onDraw = vi.fn();
    const rafCallbacks = [];
    const scheduler = createChartRenderScheduler({
      requestAnimationFrameImpl: (cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      },
      setTimeoutImpl: vi.fn(),
      clearTimeoutImpl: vi.fn(),
      now: () => 100,
      throttleMs: 16,
      rafWatchdogMs: 0,
      onDraw,
    });

    scheduler.scheduleChartRender();
    scheduler.scheduleChartRender();

    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks[0]();
    expect(onDraw).toHaveBeenCalledTimes(1);
  });

  it('delays a render when the throttle window has not elapsed', async () => {
    const { createChartRenderScheduler } = await import('../chart-render-scheduler.js');
    const onDraw = vi.fn();
    const rafCallbacks = [];
    const timeoutCallbacks = [];
    let currentNow = 20;
    const scheduler = createChartRenderScheduler({
      requestAnimationFrameImpl: (cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      },
      setTimeoutImpl: (cb, delay) => {
        timeoutCallbacks.push({ cb, delay });
        return timeoutCallbacks.length;
      },
      clearTimeoutImpl: vi.fn(),
      now: () => currentNow,
      throttleMs: 16,
      rafWatchdogMs: 0,
      onDraw,
    });

    scheduler.scheduleChartRender();
    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks.shift()?.();
    expect(onDraw).toHaveBeenCalledTimes(1);

    currentNow = 30;
    scheduler.scheduleChartRender();

    expect(timeoutCallbacks).toHaveLength(1);
    expect(timeoutCallbacks[0].delay).toBe(6);
    timeoutCallbacks[0].cb();
    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks[0]();
    expect(onDraw).toHaveBeenCalledTimes(2);
  });

  it('flushes a queued render immediately after freeze or sleep', async () => {
    const { createChartRenderScheduler } = await import('../chart-render-scheduler.js');
    const onDraw = vi.fn();
    const scheduler = createChartRenderScheduler({
      requestAnimationFrameImpl: () => 1,
      setTimeoutImpl: vi.fn(),
      clearTimeoutImpl: vi.fn(),
      now: () => 100,
      throttleMs: 16,
      rafWatchdogMs: 120,
      onDraw,
    });

    scheduler.scheduleChartRender();
    expect(onDraw).not.toHaveBeenCalled();
    scheduler.flushChartRender();
    expect(onDraw).toHaveBeenCalledTimes(1);
    scheduler.flushChartRender();
    expect(onDraw).toHaveBeenCalledTimes(2);
  });

  it('draws through the rAF watchdog when the animation frame is dropped', async () => {
    const { createChartRenderScheduler } = await import('../chart-render-scheduler.js');
    const onDraw = vi.fn();
    const timeoutCallbacks = [];
    const scheduler = createChartRenderScheduler({
      requestAnimationFrameImpl: () => 1,
      setTimeoutImpl: (cb, delay) => {
        timeoutCallbacks.push({ cb, delay });
        return timeoutCallbacks.length;
      },
      clearTimeoutImpl: vi.fn(),
      now: () => 100,
      throttleMs: 16,
      rafWatchdogMs: 120,
      onDraw,
    });

    scheduler.scheduleChartRender();
    expect(onDraw).not.toHaveBeenCalled();
    expect(timeoutCallbacks).toHaveLength(1);
    expect(timeoutCallbacks[0].delay).toBe(120);
    timeoutCallbacks[0].cb();
    expect(onDraw).toHaveBeenCalledTimes(1);
  });
});
