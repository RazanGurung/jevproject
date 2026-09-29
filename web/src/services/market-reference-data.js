const EXCHANGE_INFO_DEDUP_WINDOW_MS = 15000;
const VWAP_CACHE_TTL_MS = 30000;
const FUNDING_LOOKBACK_MS = 28800000;
const DEFAULT_FUNDING_COINS = ['BTC', 'ETH', 'SOL', 'ARB', 'HYPE', 'AVAX', 'DOGE', 'LINK'];

function resolveSettledValue(result) {
  return result?.status === 'fulfilled' ? result.value : null;
}

function buildFundingHistoryRequest(coin, startTime) {
  return {
    type: 'fundingHistory',
    coin,
    startTime,
  };
}

function getFundingRatePercent(history = []) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const last = history[history.length - 1];
  const fundingRate = parseFloat(last?.fundingRate);
  return Number.isFinite(fundingRate) ? fundingRate * 100 : null;
}

function createMarketReferenceDataService({
  getCurrentCoin = () => '',
  getWalletAddress = () => '',
  getDex,
  hlPost,
  fetchWithDedup,
  apiPost,
  fetchChartCandles,
  updateExchangeHtml = () => {},
  applyVwapResult = () => {},
  getNow = () => Date.now(),
} = {}) {
  const exchangeInfoResultCache = new Map();
  const vwapResultCache = new Map();

  async function refreshExchangeInfo(coin = getCurrentCoin(), options = {}) {
    const targetCoin = coin || getCurrentCoin();
    if (!targetCoin) return null;
    const includeActiveAssetData = options.includeActiveAssetData !== false;
    const walletAddress = getWalletAddress() || '';
    const requestBucket = Math.floor(getNow() / EXCHANGE_INFO_DEDUP_WINDOW_MS);
    const cacheKey = `exchangeInfo:${targetCoin}:${includeActiveAssetData ? walletAddress : 'public'}`;
    const cachedResult = exchangeInfoResultCache.get(cacheKey);
    if (cachedResult?.bucket === requestBucket) {
      updateExchangeHtml(targetCoin, cachedResult.value.meta, cachedResult.value.funding, cachedResult.value.activeAssetData);
      return cachedResult.value;
    }

    const dex = getDex(targetCoin);
    const metaBody = dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' };
    const fundingEndTime = getNow();
    const hourMs = 3_600_000;
    const fundingStartTime = Math.floor((fundingEndTime - 86400000) / hourMs) * hourMs;
    const fundingBody = { type: 'fundingHistory', coin: targetCoin, startTime: fundingStartTime };
    const metaDedupKey = `exchangeInfo:meta:${dex || 'main'}:${requestBucket}`;
    const fundingDedupKey = `exchangeInfo:funding:${targetCoin}:${requestBucket}`;
    const activeAssetDedupKey = `exchangeInfo:active:${targetCoin}:${walletAddress}:${requestBucket}`;

    // Kick funding immediately so it overlaps with meta, but do not let a slow
    // fundingHistory (weight 20 + per-item) delay mark/OI/leverage chrome on
    // coin switch. Official HL rates make that secondary path expensive under
    // navigation churn; progressive paint keeps the primary fields snappy.
    const metaPromise = fetchWithDedup(metaDedupKey, () => hlPost(metaBody));
    const fundingPromise = fetchWithDedup(fundingDedupKey, () => hlPost(fundingBody));
    const activePromise = includeActiveAssetData && walletAddress
      ? fetchWithDedup(activeAssetDedupKey, () => apiPost('/api/active-asset-data', { coin: targetCoin, address: walletAddress, mainnet: true }))
      : Promise.resolve(null);

    const [metaResult, activeResult] = await Promise.allSettled([metaPromise, activePromise]);
    const meta = resolveSettledValue(metaResult);
    const activeAssetData = resolveSettledValue(activeResult);
    // Early paint: funding null leaves the prior funding cell until the second pass
    // (or the 24h-changes snapshot already on AppState).
    updateExchangeHtml(targetCoin, meta, null, activeAssetData);

    const fundingResult = await Promise.allSettled([fundingPromise]).then((rows) => rows[0]);
    const funding = resolveSettledValue(fundingResult);
    const result = { meta, funding, activeAssetData, targetCoin };

    exchangeInfoResultCache.set(cacheKey, {
      bucket: requestBucket,
      value: result,
    });

    updateExchangeHtml(targetCoin, meta, funding, activeAssetData);
    return result;
  }

  async function fetchMeta() {
    return refreshExchangeInfo(getCurrentCoin());
  }

  async function fetchVWAP(coin, interval) {
    const targetCoin = coin || getCurrentCoin();
    if (!targetCoin) return null;

    const now = getNow();
    const vwapPeriod = 3 * 24 * 60 * 60 * 1000;
    const stdDevPeriod = 15 * 24 * 60 * 60 * 1000;
    const startTime = now - stdDevPeriod;
    const targetInterval = interval || '15m';
    const cacheKey = `${targetCoin}:${targetInterval}`;
    const cachedResult = vwapResultCache.get(cacheKey);
    if (cachedResult && (now - cachedResult.fetchedAt) < VWAP_CACHE_TTL_MS) {
      applyVwapResult(cachedResult.result);
      return cachedResult.result;
    }

    try {
      const body = {
        type: 'candleSnapshot',
        req: { coin: targetCoin, interval: targetInterval, startTime, endTime: now },
      };

      const dex = typeof getDex === 'function' ? getDex(targetCoin) : null;
      if (dex) {
        body.req.dex = dex;
      }

      const data = await fetchWithDedup(`vwap:${cacheKey}`, () => (
        fetchChartCandles
          ? fetchChartCandles({ ...body.req, urgency: 'prefetch', background: true })
          : hlPost(body, { background: true })
      ));
      if (!Array.isArray(data) || data.length === 0) return null;

      const vwapStart = now - vwapPeriod;
      let cumVP = 0;
      let cumV = 0;
      const vwapPrices = [];

      for (let i = 0; i < data.length; i++) {
        const candle = data[i];
        const high = parseFloat(candle.h);
        const low = parseFloat(candle.l);
        const close = parseFloat(candle.c);
        const volume = parseFloat(candle.v || 0);
        if (!high || !low || !close) continue;

        const candleTime = candle.t || (startTime + i * 900000);
        const typicalPrice = (high + low + close) / 3;
        vwapPrices.push(typicalPrice);

        if (candleTime >= vwapStart) {
          cumVP += typicalPrice * volume;
          cumV += volume;
        }
      }

      if (cumV === 0 || vwapPrices.length === 0) return null;

      const vwap = cumVP / cumV;
      let sumSqDiff = 0;
      for (const price of vwapPrices) {
        const diff = price - vwap;
        sumSqDiff += diff * diff;
      }
      const stdDev = Math.sqrt(sumSqDiff / vwapPrices.length);

      const result = { vwap, stdDev };
      vwapResultCache.set(cacheKey, { result, fetchedAt: now });
      applyVwapResult(result);
      return result;
    } catch (e) {
      console.error('Fetch VWAP error:', e);
      return null;
    }
  }

  async function fetchFunding(coin) {
    try {
      const hourMs = 3_600_000;
      const fundingStartTime = Math.floor((getNow() - FUNDING_LOOKBACK_MS) / hourMs) * hourMs;
      const fetchFundingHistory = async (targetCoin) => {
        const data = await hlPost(buildFundingHistoryRequest(targetCoin, fundingStartTime));
        return Array.isArray(data) ? data : null;
      };

      if (coin) {
        return fetchFundingHistory(coin);
      }

      const results = await Promise.all(DEFAULT_FUNDING_COINS.map((targetCoin) => fetchFundingHistory(targetCoin)));

      const fundingRates = {};
      DEFAULT_FUNDING_COINS.forEach((targetCoin, index) => {
        const fundingRate = getFundingRatePercent(results[index]);
        if (fundingRate !== null) {
          fundingRates[targetCoin] = fundingRate;
        }
      });

      return fundingRates;
    } catch (e) {
      console.error('Fetch funding error:', e);
      return null;
    }
  }

  return {
    fetchFunding,
    fetchMeta,
    fetchVWAP,
    refreshExchangeInfo,
  };
}

export {
  createMarketReferenceDataService,
};
