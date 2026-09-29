/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../chart/lightweight-chart.js', () => ({
  syncLivePriceLine: vi.fn(),
  syncProjectedLiveCandle: vi.fn(),
  invalidateLivePriceLine: vi.fn(),
  getLivePriceLineAgeMs: vi.fn(() => 0),
}));

vi.mock('../../ui/topbar.js', () => ({
  syncPriceConsumers: vi.fn(),
}));

describe('market price runtime', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    document.title = 'PEZ';
    document.body.innerHTML = '<input id="priceInput" />';

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 0;
    AppState.market.allMids = {};
    AppState.market.book = { bids: [], asks: [] };
    AppState.market.candles = [{ o: '100', c: '101' }];
  });

  it('applies current price through one runtime helper for the active coin', async () => {
    const { AppState } = await import('../../state/store.js');
    const { applyCurrentPrice } = await import('../market-price-runtime.js');
    const lightweightChartModule = await import('../../chart/lightweight-chart.js');
    const topbarModule = await import('../../ui/topbar.js');

    applyCurrentPrice('BTC', 105);

    expect(AppState.trading.currentPrice).toBe(105);
    expect(AppState.market.allMids.BTC).toBe('105');
    expect(lightweightChartModule.syncLivePriceLine).toHaveBeenCalledWith(105, 100);
    expect(lightweightChartModule.syncProjectedLiveCandle).toHaveBeenCalledWith({
      price: 105,
      candles: AppState.market.candles,
      coin: 'BTC',
      timeframe: AppState.trading.currentTimeframe,
    });
    expect(topbarModule.syncPriceConsumers).toHaveBeenCalledWith('BTC', 105, {
      refreshTopBar: true,
    });
    // Document title is owned by the throttled topbar path; live line updates
    // remain immediate on every tick.
    expect(lightweightChartModule.syncLivePriceLine).toHaveBeenCalled();
  });

  it('repairs active price from L2 when mids are missing', async () => {
    const { AppState } = await import('../../state/store.js');
    const { updatePriceFromL2 } = await import('../market-price-runtime.js');

    AppState.market.book = {
      bids: [{ px: 100 }],
      asks: [{ px: 102 }],
    };

    const onSummaryUpdate = vi.fn();
    const onRefreshLimitPreviewTracking = vi.fn();
    const changed = updatePriceFromL2({
      onSummaryUpdate,
      onRefreshLimitPreviewTracking,
    });

    expect(changed).toBe(true);
    expect(AppState.trading.currentPrice).toBe(101);
    expect(onSummaryUpdate).toHaveBeenCalledTimes(1);
    expect(onRefreshLimitPreviewTracking).toHaveBeenCalledTimes(1);
  });

  it('records an inactive coin mid without overwriting the active price mirror', async () => {
    const { AppState } = await import('../../state/store.js');
    const { applyCurrentPrice } = await import('../market-price-runtime.js');
    const lightweightChartModule = await import('../../chart/lightweight-chart.js');

    AppState.trading.currentPrice = 105;
    applyCurrentPrice('ETH', 3200);

    expect(AppState.market.allMids.ETH).toBe('3200');
    expect(AppState.trading.currentPrice).toBe(105);
    expect(document.title).toBe('PEZ');
    expect(lightweightChartModule.syncLivePriceLine).not.toHaveBeenCalled();
    expect(lightweightChartModule.syncProjectedLiveCandle).not.toHaveBeenCalled();
  });

  it('invalidates a stale lightweight live-price line through one helper', async () => {
    const { maybeInvalidateStaleLivePriceLine } = await import('../market-price-runtime.js');
    const lightweightChartModule = await import('../../chart/lightweight-chart.js');

    lightweightChartModule.getLivePriceLineAgeMs.mockReturnValue(50001);

    maybeInvalidateStaleLivePriceLine(30000);

    expect(lightweightChartModule.invalidateLivePriceLine).toHaveBeenCalledTimes(1);
  });
});
