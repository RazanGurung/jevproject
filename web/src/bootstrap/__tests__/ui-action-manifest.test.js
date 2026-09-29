import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACTION_ATTRIBUTES,
  DIRECT_CONTROL_IDS,
  actionVariantKey,
  expectedStaticVariantKeys,
} from '../ui-action-manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(resolve(here, '../../../index.html'), 'utf8');

function shellVariantKeys() {
  const keys = [];
  for (const attribute of ACTION_ATTRIBUTES) {
    const pattern = new RegExp(`<[^>]+${attribute}="([^"]+)"[^>]*>`, 'g');
    for (const match of shell.matchAll(pattern)) {
      const tag = match[0];
      const arg = tag.match(/data-arg="([^"]*)"/)?.[1] || '';
      keys.push(actionVariantKey(attribute, match[1], arg));
    }
  }
  return [...new Set(keys)].sort();
}

describe('UI action performance contract', () => {
  it('classifies every static delegated action and argument variant', () => {
    expect(shellVariantKeys()).toEqual(expectedStaticVariantKeys());
  });

  it('keeps directly-bound controls in the shell', () => {
    for (const id of DIRECT_CONTROL_IDS) {
      expect(shell).toContain(`id="${id}"`);
    }
  });
});
