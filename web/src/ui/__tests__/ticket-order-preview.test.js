import { describe, expect, it } from 'vitest';
import { applyOrderPreview, buildOrderPreviewRequest, hideOrderPreview } from '../ticket-order-preview.js';

describe('ticket order preview helpers', () => {
  it('builds the canonical preview request payload', () => {
    expect(buildOrderPreviewRequest({
      walletAddress: '0x123',
      currentCoin: 'BTC',
      currentSide: 'buy',
      size: 250,
      leverage: 20,
      limitPx: 50000,
      accountValue: 1000,
      available: 400,
    })).toEqual({
      address: '0x123',
      coin: 'BTC',
      isBuy: true,
      sizeUsd: 250,
      leverage: 20,
      limitPx: 50000,
      mainnet: true,
      accountValue: 1000,
      availableEquity: 400,
    });
  });

  it('applies and clears preview DOM state', () => {
    const previewMargin = { textContent: '' };
    const previewLiq = { textContent: '' };
    const previewDist = { textContent: '', style: {} };
    const previewMarginRow = { style: { display: 'none' } };
    const previewLiqRow = { style: { display: 'none' } };
    const previewDistRow = { style: { display: 'none' } };

    applyOrderPreview({
      initialMargin: 125.5,
      liquidationPx: 42000,
      distToLiqPct: 12.5,
    }, {
      previewMargin,
      previewLiq,
      previewDist,
      previewMarginRow,
      previewLiqRow,
      previewDistRow,
    }, {
      coin: 'BTC',
    });

    expect(previewMargin.textContent).toBe('$125.50');
    expect(previewLiq.textContent).toBe('$42000');
    expect(previewDist.textContent).toBe('12.5%');
    expect(previewMarginRow.style.display).toBe('');

    hideOrderPreview({ previewMarginRow, previewLiqRow, previewDistRow });

    expect(previewMarginRow.style.display).toBe('none');
    expect(previewLiqRow.style.display).toBe('none');
    expect(previewDistRow.style.display).toBe('none');
  });
});
