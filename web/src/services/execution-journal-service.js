import { apiGet } from './api.js';

let cachedSummary = null;
let cachedEntries = [];

/**
 * Fetches recent order and execution audit records from the backend immutable journal.
 * @param {Object} options
 * @param {string} [options.coin] - Filter by coin symbol (e.g. "BTC")
 * @param {string} [options.action] - Filter by action (e.g. "PLACE_ORDER", "CANCEL_ORDER")
 * @param {number} [options.limit=100] - Max entries to retrieve
 * @returns {Promise<Array>} List of execution journal entries (newest first)
 */
export async function fetchJournalExecutions({ coin = '', action = '', limit = 100 } = {}) {
  const params = new URLSearchParams();
  if (coin) params.set('coin', coin);
  if (action) params.set('action', action);
  if (limit) params.set('limit', String(limit));

  const query = params.toString();
  const url = `/api/journal/executions${query ? `?${query}` : ''}`;
  try {
    const res = await apiGet(url);
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    cachedEntries = entries;
    return entries;
  } catch (err) {
    console.warn('[Journal] Failed to fetch executions:', err);
    return cachedEntries;
  }
}

/**
 * Fetches aggregated execution quality and volume statistics from the backend journal.
 * @returns {Promise<Object|null>} Summary metrics (total volume, fill rate, slippage, latency)
 */
export async function fetchJournalSummary() {
  try {
    const res = await apiGet('/api/journal/summary');
    cachedSummary = res || null;
    return cachedSummary;
  } catch (err) {
    console.warn('[Journal] Failed to fetch summary:', err);
    return cachedSummary;
  }
}

export function getCachedJournalEntries() {
  return cachedEntries;
}

export function getCachedJournalSummary() {
  return cachedSummary;
}
