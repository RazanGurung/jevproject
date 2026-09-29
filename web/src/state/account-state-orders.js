import { AppState, ConnectionState, getConnectionState as getStoreConnectionState } from './store.js';

const RECENT_ORDER_PLACEMENT_GRACE_MS = 4000;
const RECENT_NON_EMPTY_ORDERS_GRACE_MS = 2000;
const RECENT_ORDER_REMOVAL_GRACE_MS = 15000;

let recentOrderPlacementUntil = 0;
let recentNonEmptyOrdersUntil = 0;
const lockedOpenOrdersByOid = new Map();
const recentlyRemovedOrderOids = new Map();

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
  const explicit = String(order?.tpsl || getNestedTrigger(order)?.tpsl || getNestedTrigger(order)?.Tpsl || '').toLowerCase();
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
  if (/stop\s*loss|\bsl\b/.test(text)) return 'sl';
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

export function normalizeOrderOid(order) {
  const oid = Number(order?.oid || 0);
  return Number.isFinite(oid) && oid > 0 ? oid : null;
}

function resolveOrderPrice(order) {
  const triggerPx = parseFloat(getOrderTriggerPrice(order));
  const limitPx = parseFloat(order?.limitPx);
  const hasTriggerPrice = Number.isFinite(triggerPx) && triggerPx > 0;
  const hasLimitPrice = Number.isFinite(limitPx) && limitPx > 0;

  if ((inferOrderTpsl(order) || getOrderTriggerPrice(order) != null) && hasTriggerPrice) return triggerPx;
  if (hasLimitPrice) return limitPx;
  if (hasTriggerPrice) return triggerPx;
  return NaN;
}

export function normalizeLockedOrder(order) {
  const oid = normalizeOrderOid(order);
  const coin = typeof order?.coin === 'string' ? order.coin : '';
  const normalizedPrice = resolveOrderPrice(order);
  if (!oid || !coin || !Number.isFinite(normalizedPrice) || normalizedPrice <= 0) return null;
  return {
    ...order,
    oid,
    coin,
    limitPx: normalizedPrice,
    triggerPx: Number.isFinite(parseFloat(getOrderTriggerPrice(order))) ? parseFloat(getOrderTriggerPrice(order)) : undefined,
    side: order?.side === 'B' || order?.side === 'buy' ? 'B' : 'A',
    tpsl: inferOrderTpsl(order),
  };
}

export function normalizeBackendOpenOrder(order) {
  const normalized = normalizeLockedOrder(order);
  if (!normalized) return null;
  return {
    ...order,
    ...normalized,
    sz: parseFloat(order?.sz ?? order?.size ?? 0) || 0,
    timestamp: Number(order?.timestamp || order?.time || 0) || 0,
  };
}

export function normalizeBackendOpenOrders(orders) {
  if (!Array.isArray(orders)) return [];
  return orders.map((order) => normalizeBackendOpenOrder(order)).filter(Boolean);
}

function cleanupExpiredRemovedOrderOids() {
  const now = Date.now();
  for (const [oid, until] of recentlyRemovedOrderOids.entries()) {
    if (until <= now) recentlyRemovedOrderOids.delete(oid);
  }
}

function markRecentlyRemovedOrderOids(oids, ttlMs = RECENT_ORDER_REMOVAL_GRACE_MS) {
  cleanupExpiredRemovedOrderOids();
  const ttl = Math.max(0, Number(ttlMs) || 0);
  if (!ttl) return;
  const until = Date.now() + ttl;
  (Array.isArray(oids) ? oids : []).forEach((oid) => {
    const nextOid = Number(oid);
    if (!Number.isFinite(nextOid) || nextOid <= 0) return;
    recentlyRemovedOrderOids.set(nextOid, until);
  });
}

function clearRecentlyRemovedOrderOids(oids) {
  (Array.isArray(oids) ? oids : []).forEach((oid) => {
    const nextOid = Number(oid);
    if (!Number.isFinite(nextOid) || nextOid <= 0) return;
    recentlyRemovedOrderOids.delete(nextOid);
  });
}

function filterRecentlyRemovedOrders(orders) {
  cleanupExpiredRemovedOrderOids();
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const oid = normalizeOrderOid(order);
    return oid === null || !recentlyRemovedOrderOids.has(oid);
  });
}

function areAllOrdersRecentlyRemoved(orders) {
  cleanupExpiredRemovedOrderOids();
  const list = Array.isArray(orders) ? orders : [];
  if (!list.length) return false;
  let foundOid = false;
  for (const order of list) {
    const oid = normalizeOrderOid(order);
    if (oid === null) return false;
    foundOid = true;
    if (!recentlyRemovedOrderOids.has(oid)) return false;
  }
  return foundOid;
}

function getLockedOpenOrders() {
  return Array.from(lockedOpenOrdersByOid.values());
}

export function mergeLockedOpenOrders(orders) {
  const nextOrders = Array.isArray(orders) ? orders.slice() : [];
  if (lockedOpenOrdersByOid.size === 0) return nextOrders;

  const presentOids = new Set(
    nextOrders.map((order) => normalizeOrderOid(order)).filter((oid) => oid !== null)
  );

  for (const lockedOrder of lockedOpenOrdersByOid.values()) {
    if (!presentOids.has(lockedOrder.oid)) nextOrders.push({ ...lockedOrder });
  }

  return nextOrders;
}

function shouldPreserveExistingOrders(nextOrders, prevOrders, options = {}) {
  if (nextOrders.length !== 0 || prevOrders.length === 0) return false;
  if (areAllOrdersRecentlyRemoved(prevOrders)) return false;
  if (recentOrderPlacementUntil > Date.now()) return true;
  if (recentNonEmptyOrdersUntil > Date.now()) return true;
  if (options.stale === true) return true;
  return getStoreConnectionState() !== ConnectionState.CONNECTED;
}

export function markRecentOrderPlacement(ttlMs = RECENT_ORDER_PLACEMENT_GRACE_MS) {
  recentOrderPlacementUntil = Math.max(recentOrderPlacementUntil, Date.now() + Math.max(0, Number(ttlMs) || 0));
}

export function setOpenOrdersWithReconciliation(orders) {
  const nextOrders = mergeLockedOpenOrders(Array.isArray(orders) ? orders : []);
  if (nextOrders.length > 0) {
    recentNonEmptyOrdersUntil = Math.max(recentNonEmptyOrdersUntil, Date.now() + RECENT_NON_EMPTY_ORDERS_GRACE_MS);
  }
  AppState.account.openOrders = nextOrders;
  return nextOrders;
}

export function reconcileIncomingOpenOrders(orders, previousOrders = AppState.account.openOrders || [], options = {}) {
  const nextOrders = filterRecentlyRemovedOrders(normalizeBackendOpenOrders(orders));
  const prevOrders = Array.isArray(previousOrders) ? previousOrders : [];
  if (shouldPreserveExistingOrders(nextOrders, prevOrders, options)) {
    return filterRecentlyRemovedOrders(prevOrders.slice());
  }
  return mergeLockedOpenOrders(nextOrders);
}

export function registerLockedOpenOrder(order) {
  const normalized = normalizeLockedOrder(order);
  if (!normalized) return getLockedOpenOrders();
  clearRecentlyRemovedOrderOids([normalized.oid]);
  lockedOpenOrdersByOid.set(normalized.oid, normalized);
  return setOpenOrdersWithReconciliation(AppState.account.openOrders || []);
}

export function registerLockedOpenOrders(orders) {
  if (!Array.isArray(orders) || !orders.length) return getLockedOpenOrders();
  let changed = false;
  orders.forEach((order) => {
    const normalized = normalizeLockedOrder(order);
    if (!normalized) return;
    clearRecentlyRemovedOrderOids([normalized.oid]);
    lockedOpenOrdersByOid.set(normalized.oid, normalized);
    changed = true;
  });
  return changed ? setOpenOrdersWithReconciliation(AppState.account.openOrders || []) : getLockedOpenOrders();
}

export function clearLockedOpenOrder(oid) {
  const nextOid = Number(oid);
  if (!Number.isFinite(nextOid) || nextOid <= 0) return false;
  return lockedOpenOrdersByOid.delete(nextOid);
}

export function clearLockedOpenOrders(oids) {
  let changed = false;
  (Array.isArray(oids) ? oids : []).forEach((oid) => {
    if (clearLockedOpenOrder(oid)) changed = true;
  });
  return changed;
}

export function clearLockedOpenOrdersByCoin(coin) {
  if (!coin) return false;
  let changed = false;
  for (const [oid, order] of lockedOpenOrdersByOid.entries()) {
    if (order?.coin !== coin) continue;
    lockedOpenOrdersByOid.delete(oid);
    changed = true;
  }
  return changed;
}

export function removeOpenOrdersByOids(oids) {
  markRecentlyRemovedOrderOids(oids);
  clearLockedOpenOrders(oids);
  const oidSet = new Set((Array.isArray(oids) ? oids : []).map((oid) => Number(oid)));
  const nextOrders = (AppState.account.openOrders || []).filter((order) => !oidSet.has(Number(order?.oid)));
  return setOpenOrdersWithReconciliation(nextOrders);
}

export function removeOpenOrdersByCoin(coin) {
  if (!coin) return AppState.account.openOrders || [];
  const removedOids = (AppState.account.openOrders || [])
    .filter((order) => order?.coin === coin)
    .map((order) => Number(order?.oid))
    .filter((oid) => Number.isFinite(oid) && oid > 0);
  markRecentlyRemovedOrderOids(removedOids);
  clearLockedOpenOrdersByCoin(coin);
  const nextOrders = (AppState.account.openOrders || []).filter((order) => order?.coin !== coin);
  return setOpenOrdersWithReconciliation(nextOrders);
}

export function resetOrderState() {
  recentOrderPlacementUntil = 0;
  recentNonEmptyOrdersUntil = 0;
  lockedOpenOrdersByOid.clear();
  recentlyRemovedOrderOids.clear();
}

export function resetRecentOrderPlacementForTests() {
  resetOrderState();
}
