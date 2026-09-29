import { describe, expect, it } from 'vitest';
import { applyTicketSummary, buildTicketSummary } from '../ticket-summary.js';

describe('ticket summary helpers', () => {
  it('builds summary values from explicit price input', () => {
    const summary = buildTicketSummary({
      sizeInputValue: '250',
      priceInputValue: '100',
      currentCoin: 'BTC',
      currentPrice: 105,
      allMids: { BTC: '105' },
      selectedPlaybook: 'Manual',
    });

    expect(summary).toEqual(expect.objectContaining({
      size: 250,
      price: 100,
      coinAmount: 2.5,
      fee: 0.1125,
      sizeText: '$250.00',
      amountText: '2.500000 BTC',
      feeText: '$0.1125',
      playbookLabel: 'Manual',
    }));
  });

  it('falls back to current mids and applies summary text to elements', () => {
    const sizeEl = { textContent: '' };
    const amountEl = { textContent: '' };
    const feeEl = { textContent: '' };
    const playbookBadge = { textContent: '' };
    const sizeSlider = { value: '' };

    const summary = buildTicketSummary({
      sizeInputValue: '250',
      priceInputValue: '',
      currentCoin: 'BTC',
      currentPrice: 0,
      allMids: { BTC: '125' },
      selectedPlaybook: 'Breakout',
    });

    applyTicketSummary(summary, {
      sizeEl,
      amountEl,
      feeEl,
      playbookBadge,
      sizeSlider,
    });

    expect(amountEl.textContent).toBe('2.000000 BTC');
    expect(feeEl.textContent).toBe('$0.1125');
    expect(playbookBadge.textContent).toBe('Breakout');
    expect(sizeSlider.value).toBe(250);
  });
});
