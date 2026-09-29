import { getApiToken } from '../services/api.js';

async function postMarketSubscription({
  payload,
  retryDelaysMs = [],
  fetchImpl = globalThis.fetch,
  resolveApiUrl,
  recordApiResult,
  sleep,
  signal,
} = {}) {
  const url = resolveApiUrl('/api/market-subscribe');
  const token = getApiToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      if (signal?.aborted) {
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });

      if (!response?.ok) {
        recordApiResult?.({
          url,
          status: response?.status || 0,
          ok: false,
          message: `market-subscribe failed: ${response?.status || 'unknown'}`,
        });
        if (response?.status >= 500 && attempt < retryDelaysMs.length) {
          await sleep?.(retryDelaysMs[attempt]);
          continue;
        }
        throw new Error(`market-subscribe failed: ${response?.status || 'unknown'}`);
      }

      recordApiResult?.({
        url,
        status: response.status,
        ok: true,
      });
      if (typeof response.json === 'function') {
        try {
          return await response.json();
        } catch (_) {
          // Older/local test adapters may return an empty successful response.
        }
      }
      return { ok: true };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        throw error;
      }
      const isLastAttempt = attempt >= retryDelaysMs.length;
      if (!isLastAttempt) {
        await sleep?.(retryDelaysMs[attempt]);
        if (signal?.aborted) {
          const abortErr = new Error('aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        continue;
      }
      throw error;
    }
  }

  return false;
}

export {
  postMarketSubscription,
};
