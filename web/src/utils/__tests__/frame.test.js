/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('frame utils', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses requestAnimationFrame when available', async () => {
    const requestAnimationFrameSpy = vi.fn(() => 7);
    globalThis.requestAnimationFrame = requestAnimationFrameSpy;

    const { scheduleFrame } = await import('../frame.js');
    const callback = vi.fn();
    const handle = scheduleFrame(callback);

    expect(handle).toBe(7);
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrameSpy).toHaveBeenCalledWith(callback);
  });

  it('falls back to setTimeout when requestAnimationFrame is unavailable', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(9);
    delete globalThis.requestAnimationFrame;

    const { scheduleFrame } = await import('../frame.js');
    const callback = vi.fn();
    const handle = scheduleFrame(callback, 23);

    expect(handle).toBe(9);
    expect(setTimeoutSpy).toHaveBeenCalledWith(callback, 23);

    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  it('runs at most one shared work unit per frame and skips cancelled work', async () => {
    const frames = [];
    globalThis.requestAnimationFrame = vi.fn((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { cancelFrameWork, scheduleFrameWork } = await import('../frame.js');
    const calls = [];

    const cancelled = scheduleFrameWork(() => calls.push('cancelled'));
    scheduleFrameWork(() => calls.push('first'));
    scheduleFrameWork(() => calls.push('second'));
    cancelFrameWork(cancelled);

    expect(frames).toHaveLength(1);
    frames.shift()();
    expect(calls).toEqual(['first']);
    expect(frames).toHaveLength(1);
    frames.shift()();
    expect(calls).toEqual(['first', 'second']);
    expect(frames).toHaveLength(0);
  });
});
