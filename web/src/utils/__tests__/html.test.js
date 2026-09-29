import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../html.js';

describe('escapeHtml', () => {
  it('escapes text and quoted attribute boundaries without losing numbers', () => {
    expect(escapeHtml(`<img src=x onerror="trade()"> O'Reilly & 0`))
      .toBe('&lt;img src=x onerror=&quot;trade()&quot;&gt; O&#39;Reilly &amp; 0');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(null)).toBe('');
  });
});
