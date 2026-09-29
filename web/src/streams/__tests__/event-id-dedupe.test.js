import { describe, expect, it } from 'vitest';

import { createEventIdDeduper } from '../event-id-dedupe.js';

describe('connection event-id dedupe', () => {
  it('dedupes retained ids and accepts them again after reset', () => {
    const deduper = createEventIdDeduper(2);

    expect(deduper.seen(1)).toBe(false);
    expect(deduper.seen(1)).toBe(true);
    deduper.reset();
    expect(deduper.seen(1)).toBe(false);
  });

  it('strictly bounds retained ids by evicting the oldest', () => {
    const deduper = createEventIdDeduper(2);

    expect(deduper.seen(1)).toBe(false);
    expect(deduper.seen(2)).toBe(false);
    expect(deduper.seen(3)).toBe(false);
    expect(deduper.seen(1)).toBe(false);
    expect(deduper.seen(3)).toBe(true);
  });

  it('does not retain absent or reserved zero ids', () => {
    const deduper = createEventIdDeduper();

    expect(deduper.seen(undefined)).toBe(false);
    expect(deduper.seen(0)).toBe(false);
    expect(deduper.seen('0')).toBe(false);
  });
});
