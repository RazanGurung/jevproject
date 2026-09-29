import { getAllMids, getBookData } from '../state/market-selectors.js';
import { roundPriceToTick } from '../services/trading-service-helpers.js';

const LIMIT_PREVIEW_BASE_DEPTH_INDEX = 4;
// Frozen at what the retired DEEP button's default (4x boost) produced, so the
// drag-to-place preview keeps snapping at the same book depth it always has.
const LIMIT_PREVIEW_DEPTH_MULTIPLIER = 4;

export function getLimitPreviewDepthIndex() {
  return (LIMIT_PREVIEW_BASE_DEPTH_INDEX + 1) * LIMIT_PREVIEW_DEPTH_MULTIPLIER - 1;
}

export function getBookMidPrice(bookData = {}, fallbackPrice = 0) {
  const bestBid = Number(bookData?.bids?.[0]?.px ?? bookData?.bids?.[0]?.price ?? 0);
  const bestAsk = Number(bookData?.asks?.[0]?.px ?? bookData?.asks?.[0]?.price ?? 0);
  if (Number.isFinite(bestBid) && bestBid > 0 && Number.isFinite(bestAsk) && bestAsk > 0) {
    return (bestBid + bestAsk) / 2;
  }
  const numericFallback = Number(fallbackPrice || 0);
  return Number.isFinite(numericFallback) && numericFallback > 0 ? numericFallback : 0;
}

export function getBookPreviewPrice(levels = [], fallbackPrice = 0) {
  const scaled = levels[getLimitPreviewDepthIndex()];
  const base = levels[LIMIT_PREVIEW_BASE_DEPTH_INDEX];
  const secondary = levels[2];
  const resolved = scaled?.px ?? scaled?.price ?? base?.px ?? base?.price ?? secondary?.px ?? secondary?.price ?? fallbackPrice;
  const numeric = parseFloat(resolved);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolveBookAlignedLimitPrice(side, bookData = {}, fallbackPrice = 0) {
  const isBuy = side === 'buy';
  const levels = isBuy ? (bookData?.bids || []) : (bookData?.asks || []);
  const midPrice = getBookMidPrice(bookData, fallbackPrice);
  const rawLevelPrice = getBookPreviewPrice(levels, midPrice);

  if (!(Number.isFinite(rawLevelPrice) && rawLevelPrice > 0)) {
    return midPrice;
  }
  if (!(Number.isFinite(midPrice) && midPrice > 0)) {
    return rawLevelPrice;
  }

  const offsetFromMid = Math.abs(rawLevelPrice - midPrice);
  if (!(Number.isFinite(offsetFromMid) && offsetFromMid > 0)) {
    return midPrice;
  }

  return isBuy ? (midPrice - offsetFromMid) : (midPrice + offsetFromMid);
}

export function buildLimitPreviewLevels({ sizeUsd, currentSide, currentCoin, currentPrice }) {
  const bookData = getBookData();
  const hasCanonicalBook = (
    (Array.isArray(bookData?.bids) && bookData.bids.length)
    || (Array.isArray(bookData?.asks) && bookData.asks.length)
  );
  const resolvedBookData = hasCanonicalBook ? bookData : { bids: [], asks: [] };
  const fallbackPrice = parseFloat(currentPrice)
    || parseFloat(getAllMids()?.[currentCoin])
    || 0;
  const buyPrice = roundPriceToTick(resolveBookAlignedLimitPrice('buy', resolvedBookData, fallbackPrice), currentCoin);
  const sellPrice = roundPriceToTick(resolveBookAlignedLimitPrice('sell', resolvedBookData, fallbackPrice), currentCoin);

  return [
    {
      price: buyPrice,
      isPreview: true,
      isBuy: true,
      lineWidth: currentSide === 'buy' ? 2 : 1.25,
      lineDash: []
    },
    {
      price: sellPrice,
      isPreview: true,
      isBuy: false,
      lineWidth: currentSide === 'sell' ? 2 : 1.25,
      lineDash: []
    }
  ].filter((level) => level.price > 0);
}
