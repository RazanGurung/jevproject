/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiPost = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  apiPost,
  sleep: vi.fn(async () => {}),
}));

vi.mock('../../render/fills.js', () => ({
  renderFills: vi.fn(),
}));

describe('fetchRecentFills', () => {
  beforeEach(async () => {
    vi.resetModules();
    apiPost.mockReset();
    const { AppState } = await import('../../state/store.js');
    AppState.account.walletAddress = '0xabc';
    AppState.account.recentFills = [];
  });

  it('does not retry a deadline and stays quiet', async () => {
    const err = new Error('/api/fills 500: context deadline exceeded');
    err.status = 500;
    err.rawMessage = 'context deadline exceeded';
    apiPost.mockRejectedValue(err);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { fetchRecentFills } = await import('../fills-service.js');
    await expect(fetchRecentFills()).resolves.toEqual([]);
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('single-flights overlapping fetches', async () => {
    let resolvePost;
    apiPost.mockImplementation(() => new Promise((resolve) => {
      resolvePost = resolve;
    }));

    const { fetchRecentFills } = await import('../fills-service.js');
    const first = fetchRecentFills();
    const second = fetchRecentFills();
    resolvePost([{ tid: 1 }]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ tid: 1 }],
      [{ tid: 1 }],
    ]);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});
