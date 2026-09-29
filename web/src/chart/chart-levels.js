/**
 * Chart levels - chart-level extraction and redraw heuristics
 */

import { AppState, chartLevelCache, chartLevelHashes } from '../state/store.js';
import { getChartOrderLevels, getChartPositionLevels } from '../state/account-state.js';

const chartLevels = {
  positions: [],
  orders: [],
  liquidations: [],
  levels: []
};

function createEmptyCoinLevels() {
  return {
    positions: [],
    orders: [],
    liquidations: [],
    levels: []
  };
}

function cloneCoinLevels(levels = createEmptyCoinLevels()) {
  return {
    positions: Array.isArray(levels.positions) ? levels.positions.slice() : [],
    orders: Array.isArray(levels.orders) ? levels.orders.slice() : [],
    liquidations: Array.isArray(levels.liquidations) ? levels.liquidations.slice() : [],
    // Keep `levels` as a compatibility alias for liquidation lines.
    levels: Array.isArray(levels.liquidations) ? levels.liquidations.slice() : [],
  };
}

function setCurrentChartLevels(levels = createEmptyCoinLevels()) {
  chartLevels.positions = Array.isArray(levels.positions) ? levels.positions.slice() : [];
  chartLevels.orders = Array.isArray(levels.orders) ? levels.orders.slice() : [];
  chartLevels.liquidations = Array.isArray(levels.liquidations) ? levels.liquidations.slice() : [];
  chartLevels.levels = Array.isArray(levels.levels) ? levels.levels.slice() : [];
}

function buildChartLevelsByCoin() {
  const levelsByCoin = new Map();
  const openOrders = Array.isArray(AppState.account.openOrders) ? AppState.account.openOrders : [];
  const positionLevels = getChartPositionLevels();

  positionLevels.forEach((level) => {
    const coin = level?.coin;
    if (!coin) return;
    if (!levelsByCoin.has(coin)) levelsByCoin.set(coin, createEmptyCoinLevels());
    const bucket = levelsByCoin.get(coin);
    if (level.kind === 'position') {
      bucket.positions.push(level);
      return;
    }
    if (level.kind === 'liquidation') {
      bucket.liquidations.push(level);
      return;
    }
  });

  openOrders.forEach((order) => {
    const coin = order?.coin;
    if (!coin) return;
    if (!levelsByCoin.has(coin)) levelsByCoin.set(coin, createEmptyCoinLevels());
    levelsByCoin.get(coin).orders.push(order);
  });

  return levelsByCoin;
}

function updateChartLevels() {
  const currentCoin = AppState.trading.currentCoin;
  const levelsByCoin = buildChartLevelsByCoin();
  const nextCacheKeys = new Set(levelsByCoin.keys());
  nextCacheKeys.add(currentCoin);

  for (const cachedCoin of Array.from(chartLevelCache.keys())) {
    if (!nextCacheKeys.has(cachedCoin)) {
      chartLevelCache.delete(cachedCoin);
      chartLevelHashes.delete(cachedCoin);
    }
  }

  for (const coin of nextCacheKeys) {
    const bucket = levelsByCoin.get(coin) || createEmptyCoinLevels();
    const normalized = {
      positions: bucket.positions,
      orders: getChartOrderLevels(coin, bucket.orders),
      liquidations: bucket.liquidations,
      levels: bucket.liquidations,
    };
    chartLevelCache.set(coin, cloneCoinLevels(normalized));
  }

  setCurrentChartLevels(getCoinLevels(currentCoin));
}

function getCoinLevels(coin) {
  return chartLevelCache.get(coin) || createEmptyCoinLevels();
}

function hashChartLevels(coin) {
  const levels = getCoinLevels(coin);
  const parts = [];

  for (const p of levels.positions) {
    parts.push(`p:${p.coin || ''}:${p.side || ''}:${Number(p.price).toFixed(8)}`);
  }
  for (const o of levels.orders) {
    parts.push([
      'o',
      o.oid ?? '',
      o.side || '',
      o.tpsl || '',
      o.reduceOnly === true ? 'ro' : 'nr',
      Number(o.price).toFixed(8),
      Number.isFinite(Number(o.triggerPx)) ? Number(o.triggerPx).toFixed(8) : '',
    ].join(':'));
  }
  for (const l of levels.liquidations) {
    parts.push(`l:${l.coin || ''}:${l.side || ''}:${Number(l.price).toFixed(8)}`);
  }

  return parts.join('|');
}

function shouldRedrawChart(coin) {
  const newHash = hashChartLevels(coin);
  const oldHash = chartLevelHashes.get(coin);
  
  if (newHash !== oldHash) {
    chartLevelHashes.set(coin, newHash);
    return true;
  }
  return false;
}

function updateChartLevelsWithTracking() {
  updateChartLevels();
  return shouldRedrawChart(AppState.trading.currentCoin);
}

export {
  updateChartLevels,
  getCoinLevels,
  hashChartLevels,
  shouldRedrawChart,
  updateChartLevelsWithTracking,
  chartLevels
};
