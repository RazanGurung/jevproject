/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('stream client id', () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });

  it('reuses the stored id on reload navigation', async () => {
    window.sessionStorage.setItem('pez_stream_client_id', 'reload-id');
    vi.spyOn(window.performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }]);

    const { getStreamClientId } = await import('../client-id.js');

    expect(getStreamClientId()).toBe('reload-id');
  });

  it('replaces a copied session id on fresh navigate loads', async () => {
    window.sessionStorage.setItem('pez_stream_client_id', 'copied-id');
    vi.spyOn(window.performance, 'getEntriesByType').mockReturnValue([{ type: 'navigate' }]);

    const { getStreamClientId } = await import('../client-id.js');
    const nextId = getStreamClientId();

    expect(nextId).not.toBe('copied-id');
    expect(window.sessionStorage.getItem('pez_stream_client_id')).toBe(nextId);
  });
});
