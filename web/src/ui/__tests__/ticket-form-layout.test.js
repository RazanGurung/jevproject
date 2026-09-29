/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import { applyTimeframeTabButton } from '../ticket-form-layout.js';

describe('ticket form control-group state', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="radar" class="ctrl-btn active">Radar</button>
      <button id="draw" class="ctrl-btn active">Draw</button>
      <button id="dom" class="ctrl-btn active">×5</button>
      <div class="tf-group">
        <button id="tf1" class="ctrl-btn active" data-action="setTimeframe">1m</button>
        <button id="tf5" class="ctrl-btn" data-action="setTimeframe">5m</button>
      </div>
    `;
  });

  it('changes only the timeframe group active state', () => {
    applyTimeframeTabButton(document.getElementById('tf5'));

    expect(document.getElementById('tf1').classList.contains('active')).toBe(false);
    expect(document.getElementById('tf5').classList.contains('active')).toBe(true);
    expect(document.getElementById('radar').classList.contains('active')).toBe(true);
    expect(document.getElementById('draw').classList.contains('active')).toBe(true);
    expect(document.getElementById('dom').classList.contains('active')).toBe(true);
  });
});
