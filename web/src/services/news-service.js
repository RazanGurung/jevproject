/**
 * News service - Market Radar news config and polling helpers
 */

import { AppState } from '../state/store.js';
import { apiGet } from './api.js';
import { scheduleSignalRadarRender } from '../ui/signal-radar.js';

let newsPollInterval = null;
let lastFetchedCoinsKey = '';
let lastNewsFetchAt = 0;
let lastNewsFailureAt = 0;
let lastNewsFailureKey = '';
let pendingNewsFetch = null;
let pendingNewsFetchKey = '';
const tickerNewsFetchedAt = new Map();
const NEWS_POLL_MS = 120000;
const NEWS_FETCH_MIN_INTERVAL_MS = 30000;
const NEWS_FETCH_FAILURE_COOLDOWN_MS = 30000;

function getRadarNewsCoins() {
  const coin = String(AppState.trading.currentCoin || '').trim();
  return coin ? [coin] : [];
}

function getCoinsKey(coins) {
  return Array.isArray(coins) ? coins.map((coin) => String(coin || '').trim()).filter(Boolean).sort().join(',') : '';
}

function applyNewsConfig(payload) {
  AppState.market.newsConfigured = payload?.configured !== false;
  AppState.market.newsProvider = payload?.provider || 'google-news-rss';
  AppState.market.newsSourceHealth = payload?.health || AppState.market.newsSourceHealth || {};
}

async function fetchNewsConfig() {
  const payload = await apiGet('/api/news-config');
  applyNewsConfig(payload);
  return payload;
}

function newsId(item) {
  return String(item?.id || [item?.headline, item?.source, item?.publishedAt].join('|'));
}

function newsTime(item) {
  const published = Date.parse(String(item?.publishedAt || ''));
  const ingested = Date.parse(String(item?.ingestedAt || ''));
  return Number.isFinite(published) ? published : (Number.isFinite(ingested) ? ingested : 0);
}

function mergeNewsList(existing = [], incoming = [], limit = 100) {
  const merged = new Map();
  [...existing, ...incoming].forEach((item) => {
    if (!item?.headline) return;
    const id = newsId(item);
    const previous = merged.get(id);
    if (!previous || newsTime(item) >= newsTime(previous)) merged.set(id, item);
  });
  return [...merged.values()].sort((left, right) => newsTime(right) - newsTime(left)).slice(0, limit);
}

function applyNewsPayload(payload = {}) {
  applyNewsConfig(payload);
  const byCoin = { ...(AppState.market.newsByCoin || {}) };
  Object.entries(payload?.items || {}).forEach(([coin, items]) => {
    byCoin[coin] = mergeNewsList(byCoin[coin], Array.isArray(items) ? items : [], 100);
  });
  const globalItems = Array.isArray(payload?.global) ? payload.global : [];
  AppState.market.newsItems = mergeNewsList(AppState.market.newsItems, globalItems, 500);
  AppState.market.newsByCoin = byCoin;
  return byCoin;
}

function ingestNewsStream(payload = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const byCoin = {};
  const globalItems = [];
  items.forEach((item) => {
    const coins = Array.isArray(item?.coins) ? item.coins : (item?.coin ? [item.coin] : []);
    if (item?.scope === 'global' || coins.length === 0) globalItems.push(item);
    coins.forEach((coin) => {
      if (!byCoin[coin]) byCoin[coin] = [];
      byCoin[coin].push(item);
    });
  });
  applyNewsPayload({ items: byCoin, global: globalItems });
  AppState.market.newsError = '';
  scheduleSignalRadarRender();
}

async function fetchRadarNews(coins = getRadarNewsCoins()) {
  if (AppState.ui.marketRadarConnected !== true) {
    return AppState.market.newsByCoin || {};
  }
  const normalizedCoins = Array.isArray(coins)
    ? coins.map((coin) => String(coin || '').trim()).filter(Boolean)
    : [];
  const key = getCoinsKey(normalizedCoins);
  if (!AppState.market.newsConfigured || !normalizedCoins.length) {
    AppState.market.newsByCoin = {};
    AppState.market.newsLoading = false;
    AppState.market.newsError = '';
    lastFetchedCoinsKey = '';
    return {};
  }

  if (pendingNewsFetch && pendingNewsFetchKey === key) {
    return pendingNewsFetch;
  }

  const params = new URLSearchParams();
  params.set('coins', normalizedCoins.join(','));
  params.set('includeGlobal', 'true');
  AppState.market.newsLoading = true;
  AppState.market.newsError = '';
  pendingNewsFetchKey = key;
  pendingNewsFetch = (async () => {
    try {
      const payload = await apiGet(`/api/news?${params.toString()}`);
      applyNewsPayload(payload);
      AppState.market.newsLoading = false;
      AppState.market.newsError = payload?.error || '';
      lastFetchedCoinsKey = key;
      lastNewsFetchAt = Date.now();
      normalizedCoins.forEach((coin) => tickerNewsFetchedAt.set(coin, lastNewsFetchAt));
      lastNewsFailureAt = 0;
      lastNewsFailureKey = '';
      return AppState.market.newsByCoin;
    } catch (error) {
      AppState.market.newsLoading = false;
      AppState.market.newsError = error?.message || 'Latest news unavailable';
      lastNewsFailureAt = Date.now();
      lastNewsFailureKey = key;
      console.warn('Radar news fetch failed:', error);
      throw error;
    } finally {
      pendingNewsFetch = null;
      pendingNewsFetchKey = '';
    }
  })();
  return pendingNewsFetch;
}

async function ensureRadarNewsCoverage(options = {}) {
  if (AppState.ui.marketRadarConnected !== true) return AppState.market.newsByCoin || {};
  if (!AppState.market.newsConfigured) return {};
  const coins = getRadarNewsCoins();
  if (!coins.length) return {};

  const key = getCoinsKey(coins);
  const now = Date.now();
  const force = options.force === true;
  const inFailureCooldown = lastNewsFailureKey === key && (now - lastNewsFailureAt) < NEWS_FETCH_FAILURE_COOLDOWN_MS;
  const needsFetch = force
    || key !== lastFetchedCoinsKey
    || !Object.keys(AppState.market.newsByCoin || {}).length
    || (now - lastNewsFetchAt) >= NEWS_FETCH_MIN_INTERVAL_MS;

  if (inFailureCooldown) return AppState.market.newsByCoin;
  if (!needsFetch) return AppState.market.newsByCoin;
  return fetchRadarNews(coins);
}

async function refreshTickerNews(coin) {
  const normalizedCoin = String(coin || '').trim();
  if (!normalizedCoin || AppState.ui.marketRadarConnected !== true) return AppState.market.newsByCoin || {};
  const fetchedAt = tickerNewsFetchedAt.get(normalizedCoin) || 0;
  if (Array.isArray(AppState.market.newsByCoin?.[normalizedCoin])
    && Date.now() - fetchedAt < NEWS_FETCH_MIN_INTERVAL_MS) {
    scheduleSignalRadarRender();
    return AppState.market.newsByCoin;
  }
  try {
    return await fetchRadarNews([normalizedCoin]);
  } finally {
    scheduleSignalRadarRender();
  }
}

function stopNewsPolling() {
  if (newsPollInterval) {
    clearInterval(newsPollInterval);
    newsPollInterval = null;
  }
}

function startNewsPolling() {
  stopNewsPolling();
  if (AppState.ui.marketRadarConnected !== true) return;
  if (!AppState.market.newsConfigured) return;
  ensureRadarNewsCoverage({ force: true })
    .catch(() => {})
    .finally(() => {
      scheduleSignalRadarRender();
    });
  // Recurring ticks go through the freshness gate un-forced: the 45s cadence
  // still clears NEWS_FETCH_MIN_INTERVAL_MS every tick, but a failing fetch
  // now honors NEWS_FETCH_FAILURE_COOLDOWN_MS instead of retrying blindly.
  // Only the explicit (re)start above forces an immediate fetch.
  newsPollInterval = setInterval(() => {
    ensureRadarNewsCoverage()
      .catch(() => {})
      .finally(() => {
        scheduleSignalRadarRender();
      });
  }, NEWS_POLL_MS);
}

export {
  fetchNewsConfig,
  fetchRadarNews,
  ingestNewsStream,
  refreshTickerNews,
  ensureRadarNewsCoverage,
  startNewsPolling,
  stopNewsPolling
};
