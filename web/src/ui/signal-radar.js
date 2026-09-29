import { AppState } from '../state/store.js';
import { escapeHtml } from '../utils/html.js';

const $ = (id) => document.getElementById(id);
const RADAR_RENDER_MIN_INTERVAL_MS = 120;
const UNIFIED_NEWS_LIMIT = 100;
const MAX_VISIBLE_NEWS_AGE_MS = 72 * 60 * 60 * 1000;

let signalRadarFrame = null;
let lastRadarRenderAt = 0;
let lastFeedMarkup = '';

function isMarketRadarVisible() {
  return AppState.ui.marketRadarVisible === true;
}

function isMarketRadarConnected() {
  return AppState.ui.marketRadarConnected === true;
}

function syncMarketRadarChrome() {
  const layoutEl = $('mainLayout');
  const toggleBtn = $('marketRadarToggleBtn');
  const isVisible = isMarketRadarVisible();
  const isConnected = isMarketRadarConnected();
  if (layoutEl) layoutEl.classList.toggle('radar-hidden', !isVisible);
  if (!toggleBtn) return;
  toggleBtn.classList.toggle('connected', isConnected);
  toggleBtn.classList.toggle('disconnected', !isConnected);
  toggleBtn.textContent = 'News';
  toggleBtn.setAttribute('aria-pressed', isConnected ? 'true' : 'false');
  toggleBtn.title = isConnected ? 'Hide and disconnect live news' : 'Show and connect live news';
}

function fmtNewsAge(timestamp) {
  const value = Date.parse(String(timestamp || ''));
  if (!Number.isFinite(value)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getNewsTimestamp(item) {
  const published = Date.parse(String(item?.publishedAt || ''));
  const ingested = Date.parse(String(item?.ingestedAt || ''));
  return Number.isFinite(published) ? published : (Number.isFinite(ingested) ? ingested : 0);
}

function getNewsId(item) {
  return String(item?.id || [item?.headline, item?.source, item?.publishedAt].join('|'));
}

function getNewsCoins(item, fallbackCoin = '') {
  const values = Array.isArray(item?.coins) ? item.coins : [item?.coin || fallbackCoin];
  return [...new Set(values.map((coin) => String(coin || '').trim()).filter(Boolean))];
}

function collectTickerNews(coin) {
  const collected = (AppState.market.newsByCoin?.[coin] || [])
    .map((item) => ({ ...item, coins: getNewsCoins(item, coin) }));

  const unique = new Map();
  collected.forEach((item) => {
    if (!item?.headline) return;
    const id = getNewsId(item);
    const previous = unique.get(id);
    if (!previous || getNewsTimestamp(item) > getNewsTimestamp(previous)) unique.set(id, item);
  });

  return [...unique.values()]
    .filter((item) => {
      const timestamp = getNewsTimestamp(item);
      return timestamp > 0 && (Date.now() - timestamp) <= MAX_VISIBLE_NEWS_AGE_MS;
    })
    .sort((left, right) => getNewsTimestamp(right) - getNewsTimestamp(left))
    .slice(0, UNIFIED_NEWS_LIMIT);
}

function renderSentimentTag(item) {
  const sentiment = Number(item?.sentiment || 0);
  if (sentiment > 0.05) return '<span class="signal-tape-sentiment bull">BULL</span>';
  if (sentiment < -0.05) return '<span class="signal-tape-sentiment bear">BEAR</span>';
  return '';
}

function renderUnifiedNewsFeed() {
  const el = $('signalNewsFeed');
  if (!el) return;
  const coin = String(AppState.trading.currentCoin || '').trim();
  const titleEl = $('marketNewsTitle');
  if (titleEl) titleEl.textContent = coin ? `Market News · ${coin}` : 'Market News';
  const items = coin ? collectTickerNews(coin) : [];

  let markup = '';
  if (!AppState.market.newsConfigured) {
    markup = '<div class="signal-tape-empty">News feed unavailable.</div>';
  } else if (!items.length && AppState.market.newsLoading) {
    markup = `<div class="signal-tape-empty">Loading the latest ${escapeHtml(coin)} news…</div>`;
  } else if (!items.length && AppState.market.newsError) {
    markup = `<div class="signal-tape-empty">${escapeHtml(AppState.market.newsError)}</div>`;
  } else if (!items.length) {
    markup = `<div class="signal-tape-empty">No market-moving ${escapeHtml(coin)} news published in the last 72 hours.</div>`;
  } else {
    markup = items.map((item) => {
      const href = typeof item.url === 'string' && /^https?:\/\//.test(item.url) ? item.url : '';
      const headline = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.headline)}</a>`
        : `<span>${escapeHtml(item.headline)}</span>`;
      return `<article class="signal-tape-item"><div class="signal-tape-item-head"><span class="signal-tape-time">${escapeHtml(fmtNewsAge(item.publishedAt || item.ingestedAt))}</span>${renderSentimentTag(item)}</div><div class="signal-tape-headline">${headline}</div></article>`;
    }).join('');
  }

  if (markup !== lastFeedMarkup) {
    const scrollTop = el.scrollTop;
    el.innerHTML = markup;
    el.scrollTop = scrollTop;
    lastFeedMarkup = markup;
  }
}

export function renderSignalRadar() {
  syncMarketRadarChrome();
  renderUnifiedNewsFeed();
}

export function scheduleSignalRadarRender() {
  if (signalRadarFrame) return;
  const delay = Math.max(0, RADAR_RENDER_MIN_INTERVAL_MS - (Date.now() - lastRadarRenderAt));
  signalRadarFrame = window.setTimeout(() => {
    signalRadarFrame = null;
    requestAnimationFrame(() => {
      lastRadarRenderAt = Date.now();
      renderSignalRadar();
    });
  }, delay);
}
