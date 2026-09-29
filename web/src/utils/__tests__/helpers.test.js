import { describe, expect, it } from 'vitest';

import { coinToTabId, getDex, isBuilderPerpCoin, isHip3Coin } from '../helpers.js';

describe('HIP-3 helper wiring', () => {
	it('recognizes generic builder-perp prefixes without classifying them as xyz', () => {
		expect(isBuilderPerpCoin('vntl:BTC')).toBe(true);
		expect(isHip3Coin('vntl:BTC')).toBe(false);
		expect(getDex('vntl:BTC')).toBe('vntl');
	});
  it('maps curated xyz stock pairs to their topbar change elements', () => {
    expect(coinToTabId('xyz:GOOGL')).toBe('GOOGL');
    expect(coinToTabId('xyz:AMZN')).toBe('AMZN');
    expect(coinToTabId('xyz:AAPL')).toBe('AAPL');
    expect(coinToTabId('xyz:META')).toBe('META');
    expect(coinToTabId('xyz:JPY')).toBe('USDJPY');
  });

  it('extracts the xyz dex for the new stock pairs', () => {
    for (const coin of ['xyz:GOOGL', 'xyz:AMZN', 'xyz:AAPL', 'xyz:META']) {
      expect(isHip3Coin(coin)).toBe(true);
      expect(getDex(coin)).toBe('xyz');
    }
  });
});
