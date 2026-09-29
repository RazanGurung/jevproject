/**
 * Account state - canonical account selectors and merge helpers
 * 
 * Hyperliquid API Field Semantics:
 * - sz (orders): Coin amount (e.g., 0.00015 BTC), NOT USD. Multiply by limitPx to get USD value.
 * - limitPx: Price per coin unit
 * - sz (fills): USD value directly (different from orders!)
 * - position.sz: Coin amount for positions
 * - position.positionValue: USD value directly from backend
 */

import { AppState } from './store.js';
import { isHip3Coin } from '../utils/helpers.js';
import {
  reconcileIncomingOpenOrders,
  normalizeOrderOid,
  markRecentOrderPlacement,
  registerLockedOpenOrder,
  registerLockedOpenOrders,
  clearLockedOpenOrder,
  clearLockedOpenOrders,
  clearLockedOpenOrdersByCoin,
  removeOpenOrdersByOids,
  removeOpenOrdersByCoin,
  resetRecentOrderPlacementForTests,
  setOpenOrdersWithReconciliation,
} from './account-state-orders.js';

function normalizeBackendAssetPosition(wrapper) {
  const position = wrapper?.position;
  const coin = typeof position?.coin === 'string' ? position.coin : '';
  const szi = parseFloat(position?.szi);
  if (!coin || !Number.isFinite(szi)) return null;
  return {
    ...wrapper,
    position: {
      ...(position || {}),
      coin,
      szi: String(szi),
      entryPx: position?.entryPx ?? '0',
      markPx: position?.markPx ?? '0',
      unrealizedPnl: position?.unrealizedPnl ?? '0',
      liquidationPx: position?.liquidationPx ?? '0',
      positionValue: position?.positionValue ?? '0',
      marginUsed: position?.marginUsed ?? '0',
      returnOnEquity: position?.returnOnEquity ?? '0',
      maintenanceMargin: position?.maintenanceMargin ?? position?.maintMargin ?? '0',
    },
  };
}

function normalizeBackendAssetPositions(assetPositions) {
  if (!Array.isArray(assetPositions)) return [];
  return assetPositions
    .map((wrapper) => normalizeBackendAssetPosition(wrapper))
    .filter(Boolean);
}

function normalizeBackendMarginSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const normalized = { ...summary };
  if (normalized.accountValue !== undefined) normalized.accountValue = String(normalized.accountValue);
  if (normalized.totalMarginUsed !== undefined) normalized.totalMarginUsed = String(normalized.totalMarginUsed);
  if (normalized.availableMargin !== undefined) normalized.availableMargin = String(normalized.availableMargin);
  return withAvailableMargin(normalized);
}

function normalizeBackendRiskSummary(riskSummary, withdrawable) {
  if (!riskSummary || typeof riskSummary !== 'object') {
    return withdrawable !== undefined ? { withdrawable: String(withdrawable) } : {};
  }
  const normalized = { ...riskSummary };
  if (normalized.accountValue !== undefined) normalized.accountValue = String(normalized.accountValue);
  if (normalized.withdrawable !== undefined) normalized.withdrawable = String(normalized.withdrawable);
  if (normalized.availableMargin !== undefined) normalized.availableMargin = String(normalized.availableMargin);
  if (normalized.totalAvailable !== undefined) normalized.totalAvailable = String(normalized.totalAvailable);
  if (withdrawable !== undefined && normalized.withdrawable === undefined) {
    normalized.withdrawable = String(withdrawable);
  }
  return normalized;
}

function withAvailableMargin(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const accountValue = parseFloat(summary.accountValue);
  const totalMarginUsed = parseFloat(summary.totalMarginUsed);
  if (!Number.isFinite(accountValue) || !Number.isFinite(totalMarginUsed)) return summary;
  return {
    ...summary,
    availableMargin: Math.max(0, accountValue - totalMarginUsed).toFixed(8),
  };
}

function getPendingHip3CloseUntil(coin) {
  return Number(AppState.account.pendingHip3CloseUntilByCoin?.[coin] || 0);
}

// webData2 snapshots are main-dex only, so every stream tick omits xyz
// positions: carry them forward unchanged. Their exchange fields
// (liquidationPx, markPx, margin) stay fresh via the backend's dedicated
// xyzPositions poll channel, not via REST enrichment.
function preserveMissingHip3Positions(nextState, previousState = getAccountState()) {
  if (!nextState || !previousState) return nextState;

  const nextPositions = Array.isArray(nextState.assetPositions) ? nextState.assetPositions : null;
  const prevPositions = Array.isArray(previousState.assetPositions) ? previousState.assetPositions : [];
  if (!nextPositions || !prevPositions.length) return nextState;

  const nextHip3Coins = new Set(
    nextPositions
      .map((wrapper) => wrapper?.position?.coin)
      .filter((coin) => typeof coin === 'string' && isHip3Coin(coin))
  );

  const missingPrevHip3 = prevPositions.filter((wrapper) => {
    const coin = wrapper?.position?.coin;
    const pendingCloseUntil = getPendingHip3CloseUntil(coin);
    if (pendingCloseUntil > Date.now()) return false;
    return typeof coin === 'string' && isHip3Coin(coin) && !nextHip3Coins.has(coin);
  });

  if (!missingPrevHip3.length) return nextState;

  return {
    ...nextState,
    assetPositions: [...nextPositions, ...missingPrevHip3],
  };
}

function applyAccountContinuity(nextState, previousState = getAccountState()) {
  if (!nextState || typeof nextState !== 'object') return nextState;

  const finalized = {
    ...(previousState || {}),
    ...nextState,
  };

  finalized.marginSummary = withAvailableMargin(finalized.marginSummary);
  finalized.crossMarginSummary = withAvailableMargin(finalized.crossMarginSummary);

	if (!finalized.riskSummary || typeof finalized.riskSummary !== 'object') {
		finalized.riskSummary = {};
	}
	// A mode-detection/upstream timeout makes the backend label risk data
	// incomplete. In that case a synthetic zero is not authoritative: preserve
	// the last fresh collateral fields while the stale badge remains visible.
	// Fresh snapshots still apply a real exchange zero immediately.
	if (nextState.riskSummaryFresh === false && previousState?.riskSummary) {
		const previousRisk = previousState.riskSummary;
		const preserved = {};
		for (const key of ['availableMargin', 'withdrawable', 'totalAvailable']) {
			if (previousRisk[key] !== undefined) preserved[key] = previousRisk[key];
		}
		finalized.riskSummary = { ...finalized.riskSummary, ...preserved };
	}
	if (finalized.withdrawable !== undefined && finalized.riskSummary.withdrawable === undefined) {
    finalized.riskSummary.withdrawable = finalized.withdrawable;
  }

  return preserveMissingHip3Positions(finalized, previousState);
}

function normalizeStreamAccountState(data, previousState = getAccountState()) {
  if (!data || typeof data !== 'object') return null;

  const clearinghouseState = data.clearinghouseState && typeof data.clearinghouseState === 'object'
    ? data.clearinghouseState
    : null;

  const raw = clearinghouseState ? { ...clearinghouseState } : { ...data };
  const normalized = {
    ...(previousState || {}),
    ...raw,
  };

  if (data.spotState !== undefined) normalized.spotState = data.spotState;

  return applyAccountContinuity(normalized, previousState);
}

function normalizeRestAccountState(data, previousState = getAccountState()) {
  if (!data || typeof data !== 'object') return null;

  return applyAccountContinuity({
    ...(previousState || {}),
    ...data,
  }, previousState);
}

function shouldApplyIncomingAccountSnapshot(data, previousState = getAccountState()) {
  const incoming = Number(data?.accountSnapshotAt || 0);
  const current = Number(previousState?.accountSnapshotAt || 0);
  return incoming <= 0 || current <= 0 || incoming >= current;
}

function setBackendAssetPositions(nextState, assetPositions) {
  if (!nextState || typeof nextState !== 'object') return nextState;
  return {
    ...nextState,
    assetPositions: normalizeBackendAssetPositions(assetPositions),
  };
}

function setBackendAccountRisk(nextState, {
  marginSummary,
  crossMarginSummary,
  riskSummary,
  withdrawable,
} = {}) {
  if (!nextState || typeof nextState !== 'object') return nextState;

  const normalizedMarginSummary = marginSummary !== undefined
    ? normalizeBackendMarginSummary(marginSummary)
    : nextState.marginSummary;
  const normalizedCrossMarginSummary = crossMarginSummary !== undefined
    ? normalizeBackendMarginSummary(crossMarginSummary)
    : nextState.crossMarginSummary;
  const normalizedWithdrawable = withdrawable !== undefined
    ? String(withdrawable)
    : nextState.withdrawable;
  const normalizedRiskSummary = riskSummary !== undefined || normalizedWithdrawable !== undefined
    ? normalizeBackendRiskSummary(riskSummary !== undefined ? riskSummary : nextState.riskSummary, normalizedWithdrawable)
    : nextState.riskSummary;

  return {
    ...nextState,
    marginSummary: normalizedMarginSummary,
    crossMarginSummary: normalizedCrossMarginSummary,
    withdrawable: normalizedWithdrawable,
    riskSummary: normalizedRiskSummary,
  };
}

function needsAccountEnrichment(data) {
  if (!data) return false;
  const risk = data.riskSummary || {};
  return !data.crossMarginSummary || risk.accountValue === undefined || risk.withdrawable === undefined;
}

function positionsChanged(nextState, previousState = getAccountState()) {
  const oldPos = previousState?.assetPositions || [];
  const newPos = nextState?.assetPositions || [];

  if (oldPos.length !== newPos.length) return true;

  for (let i = 0; i < newPos.length; i++) {
    const oldPosition = oldPos[i]?.position;
    const newPosition = newPos[i]?.position;
    if (!oldPosition || !newPosition) return true;
    if (oldPosition.coin !== newPosition.coin) return true;
    if (oldPosition.szi !== newPosition.szi) return true;
    if (oldPosition.unrealizedPnl !== newPosition.unrealizedPnl) return true;
  }
  return false;
}

function ordersChanged(nextOrders, previousOrders = getOpenOrders()) {
  const oldOrders = previousOrders || [];
  const newOrdersArr = nextOrders || [];

  if (oldOrders.length !== newOrdersArr.length) return true;

  for (let i = 0; i < oldOrders.length; i++) {
    if (oldOrders[i]?.oid !== newOrdersArr[i]?.oid) return true;
  }

  return false;
}

function getAccountState() {
  return AppState.account.state || null;
}

function getOpenOrders() {
  return AppState.account.openOrders || [];
}

function setOpenOrders(orders) {
  return setOpenOrdersWithReconciliation(orders);
}

function setBackendOpenOrders(orders, options = {}) {
  const nextOrders = reconcileIncomingOpenOrders(orders, getOpenOrders(), options);
  return setOpenOrders(nextOrders);
}

function getRecentFills() {
  return Array.isArray(AppState.account.fills) ? AppState.account.fills : [];
}

function setRecentFills(fills) {
  const nextFills = Array.isArray(fills) ? fills.slice(0, 100) : [];
  AppState.account.fills = nextFills;
  return nextFills;
}

function prependRecentFills(fills) {
  const nextIncoming = Array.isArray(fills) ? fills : [];
  if (!nextIncoming.length) return getRecentFills();

  const existingFills = getRecentFills().slice();
  const seen = new Set(existingFills.map((fill) => `${fill.time || 0}:${fill.coin || ''}:${fill.px || fill.price || 0}:${fill.sz || fill.size || 0}:${fill.side || ''}`));
  nextIncoming.forEach((fill) => {
    const key = `${fill.time || 0}:${fill.coin || ''}:${fill.px || fill.price || 0}:${fill.sz || fill.size || 0}:${fill.side || ''}`;
    if (seen.has(key)) return;
    existingFills.unshift(fill);
    seen.add(key);
  });
  return setRecentFills(existingFills);
}

function clearRecentFills() {
  return setRecentFills([]);
}

function getTwapStatePayload() {
  const appPayload = AppState.account.twapStates;
  if (appPayload && typeof appPayload === 'object') return appPayload;
  return {};
}

function getTwapStatesSnapshot() {
  const states = getTwapStatePayload()?.states;
  return Array.isArray(states) ? states : [];
}

function setTwapStatePayload(payload) {
  const nextPayload = payload && typeof payload === 'object' ? payload : {};
  AppState.account.twapStates = nextPayload;
  return nextPayload;
}

function upsertPendingTwapState(twapId, statePatch) {
  const nextId = Number(twapId);
  if (!Number.isFinite(nextId)) return getTwapStatePayload();

  const existingPayload = getTwapStatePayload();
  const currentStates = getTwapStatesSnapshot()
    .filter((tuple) => Array.isArray(tuple) && Number(tuple[0]) !== nextId);

  currentStates.unshift([nextId, { ...(statePatch || {}) }]);
  return setTwapStatePayload({
    ...existingPayload,
    states: currentStates,
  });
}

function removeTwapState(twapId) {
  const nextId = Number(twapId);
  if (!Number.isFinite(nextId)) return getTwapStatePayload();

  const existingPayload = getTwapStatePayload();
  const currentStates = getTwapStatesSnapshot()
    .filter((tuple) => Number(tuple?.[0]) !== nextId);

  return setTwapStatePayload({
    ...existingPayload,
    states: currentStates,
  });
}

function getLastTwapId() {
  const appValue = Number(AppState.account.lastTwapId);
  if (Number.isFinite(appValue)) return appValue;
  return null;
}

function setLastTwapId(twapId) {
  const nextId = Number(twapId);
  const value = Number.isFinite(nextId) ? nextId : null;
  AppState.account.lastTwapId = value;
  return value;
}

function getAssetPositions(accountState = getAccountState()) {
  return Array.isArray(accountState?.assetPositions) ? accountState.assetPositions : [];
}

function getOpenPositions(accountState = getAccountState()) {
  return getAssetPositions(accountState).filter((wrapper) => Math.abs(parseFloat(wrapper?.position?.szi || 0)) > 0);
}

// NOTE: Intentionally uses Number() (strict coercion), NOT parseFloat. This is
// a deliberately different semantic from utils/helpers.toNumber and must not be
// merged into it: Number('12px') -> NaN -> 0 here, whereas the parseFloat
// helper would yield 12. Kept local on purpose.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRoePct(rawRoe) {
  if (!Number.isFinite(rawRoe) || rawRoe === 0) return null;
  return Math.abs(rawRoe) <= 5 ? rawRoe * 100 : rawRoe;
}

function getPositionRiskByCoin(accountState = getAccountState()) {
  const riskEntries = Array.isArray(accountState?.positionRisk) ? accountState.positionRisk : [];
  const byCoin = new Map();
  riskEntries.forEach((entry) => {
    if (typeof entry?.coin === 'string' && entry.coin) {
      byCoin.set(entry.coin, entry);
    }
  });
  return byCoin;
}

function getPositionMetrics(positionWrapper, accountState = getAccountState(), allMids = AppState.market.allMids) {
  const position = positionWrapper?.position || {};
  const risk = getPositionRiskByCoin(accountState).get(position.coin) || null;

  const size = toNumber(position.szi);
  const entry = toNumber(position.entryPx);
  const liveMark = toNumber(position.markPx);
  const midMark = toNumber(allMids?.[position.coin]);
  const riskMark = toNumber(risk?.markPx);
  const mark = liveMark || midMark || riskMark || entry;

  const livePnl = toNumber(position.unrealizedPnl);
  const riskPnl = toNumber(risk?.unrealizedPnl);
  const pnl = (position.unrealizedPnl != null && position.unrealizedPnl !== '')
    ? livePnl
    : ((risk?.unrealizedPnl != null && risk.unrealizedPnl !== '') ? riskPnl : (size * (mark - entry)));

  const liveMarginUsed = toNumber(position.marginUsed);
  const riskInitialMargin = toNumber(risk?.initialMargin);
  const riskMarginUsed = toNumber(risk?.marginUsed);
  const marginUsed = liveMarginUsed || riskInitialMargin || riskMarginUsed;

  let roePct = null;
  if (marginUsed > 0) {
    roePct = (pnl / marginUsed) * 100;
  } else {
    roePct = normalizeRoePct(toNumber(position.returnOnEquity));
    if (roePct == null) roePct = normalizeRoePct(toNumber(risk?.returnOnEquity));
  }

  const positionValue = Math.abs(toNumber(position.positionValue)) || Math.abs(size * mark);
  const liqPrice = toNumber(position.liquidationPx) || toNumber(risk?.liquidationPx);
  const distToLiq = liqPrice > 0 && mark > 0
    ? (Math.abs(mark - liqPrice) / mark * 100)
    : toNumber(risk?.distanceToLiqPct);
  const maintMargin = toNumber(position.maintenanceMargin)
    || toNumber(position.maintMargin)
    || toNumber(risk?.maintenanceMargin)
    || (marginUsed > 0 ? marginUsed * 0.05 : 0);

  return {
    position,
    risk,
    size,
    entry,
    mark,
    pnl,
    marginUsed,
    roePct,
    positionValue,
    liqPrice,
    distToLiq,
    maintMargin,
  };
}

function getOpenPositionViewModels(accountState = getAccountState(), allMids = AppState.market.allMids) {
  return getOpenPositions(accountState).map((wrapper) => ({
    wrapper,
    metrics: getPositionMetrics(wrapper, accountState, allMids),
  }));
}

function getAccountTabCounts(accountState = getAccountState(), openOrders = getOpenOrders()) {
  return {
    positions: getOpenPositions(accountState).length,
    orders: Array.isArray(openOrders) ? openOrders.length : 0,
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function getNestedTrigger(order) {
  return order?.orderType?.trigger
    || order?.orderType?.Trigger
    || order?.orderType?.t
    || order?.orderType?.T
    || null;
}

function inferOrderTpsl(order = {}) {
  const trigger = getNestedTrigger(order);
  const explicit = String(order?.tpsl || trigger?.tpsl || trigger?.Tpsl || '').toLowerCase();
  if (explicit === 'tp' || explicit === 'takeprofit' || explicit === 'take_profit') return 'tp';
  if (explicit === 'sl' || explicit === 'stoploss' || explicit === 'stop_loss') return 'sl';

  const text = [
    order?.orderType,
    order?.type,
    order?.triggerCondition,
    order?.origType,
    order?.name,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/take\s*profit|\btp\b/.test(text)) return 'tp';
  // HL orderType for stop-loss triggers is "Stop Market" / "Stop Limit" —
  // plain "stop loss" never appears, so match any standalone "stop" after
  // the take-profit check.
  if (/\bstop\b|\bsl\b/.test(text)) return 'sl';
  return '';
}

function getOrderTriggerPrice(order = {}) {
  const trigger = getNestedTrigger(order);
  return firstDefined(
    order?.triggerPx,
    order?.triggerPrice,
    order?.stopPx,
    order?.stopPrice,
    trigger?.triggerPx,
    trigger?.triggerPrice,
    trigger?.stopPx,
    trigger?.stopPrice,
  );
}

function getOrderDisplayPrice(order = {}) {
  const triggerPx = parseFloat(getOrderTriggerPrice(order));
  const limitPx = parseFloat(order?.limitPx);
  const hasTriggerPrice = Number.isFinite(triggerPx) && triggerPx > 0;
  const hasLimitPrice = Number.isFinite(limitPx) && limitPx > 0;

  if ((inferOrderTpsl(order) || getOrderTriggerPrice(order) != null) && hasTriggerPrice) return triggerPx;
  if (hasLimitPrice) return limitPx;
  if (hasTriggerPrice) return triggerPx;
  return 0;
}

function sortOrdersOutsideIn(orders = getOpenOrders()) {
  const getOrderPrice = getOrderDisplayPrice;
  return orders.slice().sort((a, b) => {
    const aSide = String(a.side || '').toLowerCase();
    const bSide = String(b.side || '').toLowerCase();
    const aIsBuy = aSide === 'b' || aSide === 'buy';
    const bIsBuy = bSide === 'b' || bSide === 'buy';
    if (aIsBuy && !bIsBuy) return -1;
    if (!aIsBuy && bIsBuy) return 1;
    if (!aIsBuy) return getOrderPrice(b) - getOrderPrice(a);
    return getOrderPrice(a) - getOrderPrice(b);
  });
}

function getOpenOrderViewModels(openOrders = getOpenOrders()) {
  return sortOrdersOutsideIn(openOrders).map((order) => {
    const side = String(order.side || '').toLowerCase();
    const isBuy = side === 'b' || side === 'buy';
    const price = getOrderDisplayPrice(order);
    const size = parseFloat(order.sz);
    const tpsl = inferOrderTpsl(order);
    const type = tpsl === 'tp' ? 'TP' : tpsl === 'sl' ? 'SL' : (getOrderTriggerPrice(order) && !tpsl ? 'Trigger' : 'Limit');
    return {
      order,
      isBuy,
      sideLabel: isBuy ? 'Buy' : 'Sell',
      sizeUsd: Math.round(size * price * 100) / 100,
      price,
      type,
    };
  });
}

function normalizeFill(fill) {
  const px = parseFloat(fill?.px || fill?.price || 0);
  const sz = Math.abs(parseFloat(fill?.sz || fill?.closedPnl || fill?.size || 0));
  const sideValue = String(fill?.side || fill?.dir || fill?.sideLabel || '').toLowerCase();
  const side = sideValue.startsWith('b') ? 'Buy' : sideValue.startsWith('s') ? 'Sell' : '—';
  return {
    coin: fill?.coin || fill?.symbol || '—',
    px,
    sz,
    side,
    time: fill?.time || fill?.timestamp || 0,
    fee: parseFloat(fill?.fee || 0),
    pnl: parseFloat(fill?.closedPnl || fill?.realizedPnl || 0),
    liq: !!fill?.liquidation,
    liqMethod: fill?.liquidation?.method || '',
  };
}

function getRecentFillViewModels(fills = getRecentFills(), limit = 80) {
  return fills.slice(0, limit).map(normalizeFill);
}

function getChartPositionLevels(accountState = getAccountState(), allMids = AppState.market.allMids) {
  return getOpenPositionViewModels(accountState, allMids).flatMap(({ metrics }) => {
    const isBuy = metrics.size > 0;
    const levels = [];
    // Liquidation price is the exchange's own number (position.liquidationPx
    // from clearinghouseState), never a local estimate. It refreshes on every
    // stream tick that carries the position; preserved HIP-3 positions
    // trigger an account refresh so a stale carry-over is short-lived.
    const exchangeLiqPrice = toNumber(metrics.position.liquidationPx);
    if (exchangeLiqPrice > 0) {
      levels.push({
        kind: 'liquidation',
        price: exchangeLiqPrice,
        side: isBuy ? 'short' : 'long',
        type: 'liquidation',
        coin: metrics.position.coin,
      });
    }
    levels.push({
      kind: 'position',
      price: metrics.entry,
      side: isBuy ? 'long' : 'short',
      type: 'position',
      size: metrics.positionValue,
      coin: metrics.position.coin,
      // Carried on the position level so the overlay label can show the liq
      // price even when the liq line itself is outside the visible range.
      liqPrice: exchangeLiqPrice > 0 ? exchangeLiqPrice : undefined,
    });
    return levels;
  });
}

function getChartOrderLevels(currentCoin = AppState.trading.currentCoin, openOrders = getOpenOrders()) {
  if (!Array.isArray(openOrders)) return [];
  return openOrders
    .filter((order) => order?.coin === currentCoin)
    .map((order) => ({
      coin: order.coin,
      price: getOrderDisplayPrice(order),
      triggerPx: Number.isFinite(parseFloat(getOrderTriggerPrice(order))) ? parseFloat(getOrderTriggerPrice(order)) : undefined,
      side: order.side === 'B' || order.side === 'buy' ? 'B' : 'A',
      type: 'order',
      oid: order.oid,
      tpsl: inferOrderTpsl(order),
      reduceOnly: order.reduceOnly === true,
    }))
    .filter((order) => Number.isFinite(order.price) && order.price > 0);
}

function getPositionExposure(accountState = getAccountState()) {
  return getOpenPositionViewModels(accountState).reduce((sum, { metrics }) => sum + metrics.positionValue, 0);
}

function getOpenPositionCount(accountState = getAccountState()) {
  return getOpenPositions(accountState).length;
}

function shouldApplyIncomingOrderRevision(incomingRevision) {
  const next = Number(incomingRevision || 0);
  if (!Number.isFinite(next) || next <= 0) return true;
  return next >= Number(AppState.account.lastOrderRevision || 0);
}

function commitIncomingOrderRevision(incomingRevision) {
  const next = Number(incomingRevision || 0);
  if (!Number.isFinite(next) || next <= 0) return;
  if (next >= Number(AppState.account.lastOrderRevision || 0)) {
    AppState.account.lastOrderRevision = next;
  }
}

export {
  normalizeStreamAccountState,
  normalizeRestAccountState,
  shouldApplyIncomingAccountSnapshot,
  setBackendAssetPositions,
  setBackendAccountRisk,
  needsAccountEnrichment,
  positionsChanged,
  ordersChanged,
  getAccountState,
  getOpenOrders,
  setOpenOrders,
  setBackendOpenOrders,
  markRecentOrderPlacement,
  reconcileIncomingOpenOrders,
  resetRecentOrderPlacementForTests,
  registerLockedOpenOrder,
  registerLockedOpenOrders,
  clearLockedOpenOrder,
  clearLockedOpenOrders,
  clearLockedOpenOrdersByCoin,
  removeOpenOrdersByOids,
  removeOpenOrdersByCoin,
  getRecentFills,
  setRecentFills,
  prependRecentFills,
  clearRecentFills,
  getTwapStatePayload,
  getTwapStatesSnapshot,
  setTwapStatePayload,
  upsertPendingTwapState,
  removeTwapState,
  getLastTwapId,
  setLastTwapId,
  getAssetPositions,
  getOpenPositions,
  getPositionMetrics,
  getOpenPositionViewModels,
  getAccountTabCounts,
  sortOrdersOutsideIn,
  getOpenOrderViewModels,
  getRecentFillViewModels,
  getChartPositionLevels,
  getChartOrderLevels,
  getPositionExposure,
  getOpenPositionCount,
  shouldApplyIncomingOrderRevision,
  commitIncomingOrderRevision,
};
