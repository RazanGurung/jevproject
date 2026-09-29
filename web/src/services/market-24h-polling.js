import { getDex, isBuilderPerpCoin } from '../utils/helpers.js';

function createMarket24hPollingService({
  apiGet,
  hlPost,
  fetchChartCandles,
  applyCoin24hChange = async () => {},
  scheduleRender = () => {},
  getNow = () => Date.now(),
  setIntervalFn = (cb, ms) => globalThis.setInterval(cb, ms),
  clearIntervalFn = (id) => globalThis.clearInterval(id),
} = {}) {
  let intervalId = null;

  async function fetch24hChanges() {
    try {
      const data = await apiGet('/api/24h-changes');
      let hasData = false;
      // Values may be plain change strings (legacy / candle fallback) or full
      // asset snapshots { change, dayNtlVlm, oi, funding, markPx }.
      for (const [coin, entry] of Object.entries(data || {})) {
        await applyCoin24hChange(coin, entry);
        hasData = true;
      }
      scheduleRender();
      if (hasData) return data;
    } catch (_error) {
      // Backend 24h cache unavailable, fetching directly
    }

    const coins = ['BTC', 'ETH', 'HYPE', 'xyz:SP500', 'xyz:XYZ100', 'xyz:CL', 'xyz:GOLD', 'xyz:SILVER', 'xyz:SPCX', 'xyz:NVDA', 'xyz:TSLA', 'xyz:AMD', 'xyz:INTC', 'xyz:MU', 'xyz:GOOGL', 'xyz:AMZN', 'xyz:AAPL', 'xyz:META', 'xyz:JPY'];
    const now = getNow();
    const startTime = now - 86400000;
    const fetchChange = async (coin) => {
      try {
        const body = { type: 'candleSnapshot', req: { coin, interval: '1h', startTime, endTime: now } };
        if (isBuilderPerpCoin(coin)) body.req.dex = getDex(coin);
        const data = fetchChartCandles
          ? await fetchChartCandles({ ...body.req, urgency: 'prefetch', background: true })
          : await hlPost(body, { background: true });
        if (data && data.length >= 2) {
          const first = parseFloat(data[0].c);
          const last = parseFloat(data[data.length - 1].c);
          if (first && last) {
            return { coin, change: ((last - first) / first * 100).toFixed(2) };
          }
        }
      } catch (_error) {}
      return { coin, change: null };
    };
    try {
      // Batch the fallback so it doesn't fire ~19 candle requests at once (a
      // burst that trips HL's per-IP limit); this path only runs when the
      // backend 24h cache is cold (e.g. right after startup).
      const FALLBACK_CONCURRENCY = 5;
      const results = [];
      for (let i = 0; i < coins.length; i += FALLBACK_CONCURRENCY) {
        const batch = coins.slice(i, i + FALLBACK_CONCURRENCY);
        results.push(...await Promise.all(batch.map(fetchChange)));
      }

      for (const result of results) {
        if (result.change !== null) {
          await applyCoin24hChange(result.coin, result.change);
        }
      }
      scheduleRender();
    } catch (e) {
      console.error('Fetch 24h fallback error:', e);
    }
  }

  function start24hPolling() {
    fetch24hChanges();
    intervalId = setIntervalFn(fetch24hChanges, 60000);
  }

  function stop24hPolling() {
    if (intervalId) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
  }

  return {
    fetch24hChanges,
    start24hPolling,
    stop24hPolling,
  };
}

export {
  createMarket24hPollingService,
};
