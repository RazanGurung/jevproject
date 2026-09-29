/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchChartCandles = vi.fn();

vi.mock('../chart-data.js', () => ({
  fetchChartCandles,
}));

describe('fetchHistoricalCandles', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchChartCandles.mockReset();
  });

  it('does not log canceled scrollback as an error', async () => {
    const err = new Error('/api/chart-candles 504: request canceled');
    err.status = 504;
    err.rawMessage = 'request canceled';
    fetchChartCandles.mockRejectedValue(err);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { fetchHistoricalCandles } = await import('../chart-candle-service.js');
    await expect(fetchHistoricalCandles({ coin: 'BTC', timeframe: '1h' })).resolves.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
