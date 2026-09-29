// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

describe('stream module contracts', () => {
  it('imports account stream UI without relying on trading-service facade exports', async () => {
    await expect(import('../account-stream-ui.js')).resolves.toBeTruthy();
  });

  it('imports market ws without relying on trading-service facade exports', async () => {
    await expect(import('../market-ws.js')).resolves.toBeTruthy();
  });
});
