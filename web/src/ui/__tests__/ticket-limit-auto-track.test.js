/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

describe('ticket limit auto track controller', () => {
  it('shows compact auto-track prices only in 1m limit auto mode', async () => {
    document.body.innerHTML = `
      <input id="priceInput" value="97.000" />
      <select id="priceModeSelect">
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      </select>
      <div id="compactLimitPriceStrip" hidden>
        <div id="compactLimitBuyPrice"></div>
        <div id="compactLimitSellPrice"></div>
        <span id="compactLimitBuyValue"></span>
        <span id="compactLimitSellValue"></span>
      </div>
    `;

    const { createLimitAutoTrackController } = await import('../ticket-limit-auto-track.js');
    const controller = createLimitAutoTrackController({
      getEffectiveCurrentOrderType: () => 'limit',
      getEffectiveCurrentTimeframe: () => '1m',
      getLimitPriceEntryMode: () => 'auto',
      getEffectiveCurrentCoin: () => 'BTC',
      getAutoLimitPriceForSide: (side) => side === 'buy' ? 97 : 103,
      getEffectiveCurrentSide: () => 'buy',
      setLimitPriceEntryMode: vi.fn((mode) => mode),
      resetUserEditedPrice: vi.fn(),
      setUserEditedPrice: vi.fn(),
      syncLimitPreviewLevels: vi.fn(() => false),
      requestChartRefresh: vi.fn(),
      getUserEditedPrice: () => false,
      applyTicketPrice: vi.fn(() => false),
      updateSummary: vi.fn(),
    });

    controller.updateLimitPriceEntryUi();

    expect(document.getElementById('priceInput').readOnly).toBe(true);
    expect(document.getElementById('priceModeSelect').style.display).toBe('');
    expect(document.getElementById('compactLimitPriceStrip').hidden).toBe(false);
    expect(document.getElementById('compactLimitBuyValue').textContent).toBe('97.000');
    expect(document.getElementById('compactLimitSellValue').textContent).toBe('103.00');
  });

  it('switches back to auto mode through the shared sync path', async () => {
    document.body.innerHTML = '<input id="priceInput" value="96.5" />';

    const { createLimitAutoTrackController } = await import('../ticket-limit-auto-track.js');
    const resetUserEditedPrice = vi.fn();
    const setLimitPriceEntryMode = vi.fn((mode) => mode);
    const syncLimitPreviewLevels = vi.fn(() => true);
    const requestChartRefresh = vi.fn();
    const applyTicketPrice = vi.fn(() => true);

    const controller = createLimitAutoTrackController({
      getEffectiveCurrentOrderType: () => 'limit',
      getEffectiveCurrentTimeframe: () => '1m',
      getLimitPriceEntryMode: () => 'auto',
      getEffectiveCurrentCoin: () => 'BTC',
      getAutoLimitPriceForSide: () => 97,
      getEffectiveCurrentSide: () => 'buy',
      setLimitPriceEntryMode,
      resetUserEditedPrice,
      setUserEditedPrice: vi.fn(),
      syncLimitPreviewLevels,
      requestChartRefresh,
      getUserEditedPrice: () => false,
      applyTicketPrice,
      updateSummary: vi.fn(),
    });

    controller.setLimitPriceEntryModeSelection('auto');

    expect(resetUserEditedPrice).toHaveBeenCalledTimes(1);
    expect(syncLimitPreviewLevels).toHaveBeenCalledTimes(1);
    expect(requestChartRefresh).toHaveBeenCalledTimes(1);
    expect(applyTicketPrice).toHaveBeenCalledWith(97, {
      userEdited: false,
      syncUi: true,
      clearDeployState: false,
      snapToTick: true,
    });
  });
});
