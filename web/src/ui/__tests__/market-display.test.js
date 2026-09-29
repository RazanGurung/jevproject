/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

describe('syncLeverageControls', () => {
  beforeEach(async () => {
    document.body.innerHTML = `
      <input id="leverageSlider" type="range" min="1" max="10" value="10">
      <span id="leverageSliderValue"></span>
      <span id="leverageExchangeValue"></span>
    `;
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
  });

  it('keeps the slider range at ticker max when current leverage is lower', async () => {
    const { syncLeverageControls } = await import('../market-display.js');
    syncLeverageControls(5, 'BTC');

    const slider = document.getElementById('leverageSlider');
    expect(slider.max).toBe('40');
    expect(slider.value).toBe('5');
    expect(document.getElementById('leverageSliderValue').textContent).toBe('5x');
    expect(document.getElementById('leverageExchangeValue').textContent).toBe('5x');
  });
});
