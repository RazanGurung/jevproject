/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  apiGet,
}));

describe('execution-journal-service', () => {
  beforeEach(() => {
    vi.resetModules();
    apiGet.mockReset();
  });

  it('fetches journal executions with query parameters and caches result', async () => {
    const mockEntries = [
      { id: 'exec_1', coin: 'BTC', action: 'PLACE_ORDER', sz: 0.5, success: true },
      { id: 'exec_2', coin: 'BTC', action: 'CANCEL_ORDER', oid: 123, success: true },
    ];
    apiGet.mockResolvedValueOnce({ entries: mockEntries, count: 2 });

    const { fetchJournalExecutions, getCachedJournalEntries } = await import('../execution-journal-service.js');

    const result = await fetchJournalExecutions({ coin: 'BTC', limit: 50 });
    expect(apiGet).toHaveBeenCalledWith('/api/journal/executions?coin=BTC&limit=50');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('exec_1');
    expect(getCachedJournalEntries()).toEqual(mockEntries);
  });

  it('handles fetch execution errors gracefully by returning cached entries', async () => {
    apiGet.mockRejectedValueOnce(new Error('Network error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { fetchJournalExecutions } = await import('../execution-journal-service.js');
    const result = await fetchJournalExecutions({ coin: 'ETH' });

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fetches journal summary and caches result', async () => {
    const mockSummary = {
      totalEntries: 10,
      totalOrders: 8,
      totalCancels: 2,
      totalVolumeUsd: 50000,
      successRatePct: 90.0,
      avgLatencyMs: 25.5,
      avgSlippageBps: 1.2,
    };
    apiGet.mockResolvedValueOnce(mockSummary);

    const { fetchJournalSummary, getCachedJournalSummary } = await import('../execution-journal-service.js');

    const summary = await fetchJournalSummary();
    expect(apiGet).toHaveBeenCalledWith('/api/journal/summary');
    expect(summary.totalVolumeUsd).toBe(50000);
    expect(getCachedJournalSummary()).toEqual(mockSummary);
  });
});
