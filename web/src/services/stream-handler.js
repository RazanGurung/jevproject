/**
 * Stream handler - processes realtime messages and updates canonical AppState
 * Transport-agnostic: called by any stream transport (WS, polling)
 */

import { AppState, filterSuppressedOrders, filterSuppressedPositions } from '../state/store.js';
import { setLegacy } from '../state/legacy-globals.js';
import { getDex } from '../utils/helpers.js';
import { setActiveAssetCtx } from '../state/market-state.js';
import {
  getAccountState,
  getOpenOrders,
  normalizeStreamAccountState,
  needsAccountEnrichment,
  positionsChanged,
  ordersChanged,
  setBackendOpenOrders,
  setBackendAssetPositions,
  setBackendAccountRisk,
  prependRecentFills,
  setTwapStatePayload,
  clearLockedOpenOrders,
  removeOpenOrdersByOids,
  shouldApplyIncomingOrderRevision,
  commitIncomingOrderRevision,
} from '../state/account-state.js';

const ACCOUNT_ENRICHMENT_MIN_INTERVAL_MS = 250;
let lastAccountEnrichmentRequestAt = 0;

function isTerminalOrderStatus(status) {
  const text = String(
    status?.status
    || status?.orderStatus
    || status?.state
    || status?.type
    || status?.reason
    || ''
  ).toLowerCase();
  return /cancel|canceled|cancelled|filled|fill|closed|rejected|expired|deleted/.test(text);
}

function extractTerminalOrderOids(payload) {
  const entries = Array.isArray(payload)
    ? payload
    : [
      ...(Array.isArray(payload?.orderUpdates) ? payload.orderUpdates : []),
      ...(Array.isArray(payload?.statuses) ? payload.statuses : []),
      ...(Array.isArray(payload?.orders) ? payload.orders : []),
    ];

  const terminalOids = [];
  entries.forEach((entry) => {
    if (!entry || !isTerminalOrderStatus(entry)) return;
    const oid = Number(entry?.oid || entry?.order?.oid || entry?.resting?.oid || 0);
    if (Number.isFinite(oid) && oid > 0) terminalOids.push(oid);
  });
  return terminalOids;
}

function collectOrderUpdateEntries(payload) {
  if (Array.isArray(payload)) return payload;
  const entries = [
    ...(Array.isArray(payload?.orderUpdates) ? payload.orderUpdates : []),
    ...(Array.isArray(payload?.statuses) ? payload.statuses : []),
    ...(Array.isArray(payload?.orders) ? payload.orders : []),
  ];
  if (!entries.length && payload && typeof payload === 'object') return [payload];
  return entries;
}

function extractOpenOrderFromUpdate(entry) {
  if (!entry || isTerminalOrderStatus(entry)) return null;
  const source = entry.order || entry.resting || entry;
  const oid = Number(source?.oid || entry?.oid || 0);
  const coin = source?.coin || entry?.coin || '';
  const side = source?.side || entry?.side || '';
  const limitPx = source?.limitPx ?? entry?.limitPx;
  const triggerPx = source?.triggerPx ?? entry?.triggerPx;
  const sz = source?.sz ?? source?.size ?? entry?.sz ?? entry?.size;
  if (!Number.isFinite(oid) || oid <= 0 || !coin) return null;
  return {
    ...source,
    oid,
    coin,
    side,
    limitPx,
    triggerPx,
    sz,
    tpsl: source?.tpsl ?? entry?.tpsl ?? '',
    reduceOnly: source?.reduceOnly === true || entry?.reduceOnly === true,
    timestamp: source?.timestamp ?? source?.time ?? entry?.timestamp ?? entry?.time,
  };
}

function upsertOpenOrdersFromUpdates(payload) {
  const openUpdates = collectOrderUpdateEntries(payload)
    .map((entry) => extractOpenOrderFromUpdate(entry))
    .filter(Boolean);
  if (!openUpdates.length) return [];

  const updateOids = new Set(openUpdates.map((order) => Number(order.oid)));
  const existing = getOpenOrders().filter((order) => !updateOids.has(Number(order?.oid)));
  setBackendOpenOrders(existing.concat(openUpdates));
  return openUpdates;
}

/**
 * Request account enrichment through the service layer.
 * Throttled to prevent burst hammering.
 */
function requestAccountEnrichment() {
  const now = Date.now();
  if (now - lastAccountEnrichmentRequestAt < ACCOUNT_ENRICHMENT_MIN_INTERVAL_MS) {
    return false;
  }
  lastAccountEnrichmentRequestAt = now;
  return true;
}

/**
 * Handle incoming BBO (best bid/offer) data from the realtime stream.
 */
function handleBbo(bboData, coin) {
  if (!bboData || !coin) return null;
  if (!AppState.market.bboData) AppState.market.bboData = {};
  AppState.market.bboData[coin] = bboData;

  const spread = bboData.ask - bboData.bid;
  const spreadBps = spread > 0 ? (spread / bboData.ask) * 10000 : 0;

  return {
    coin,
    bid: bboData.bid,
    ask: bboData.ask,
    spread,
    spreadBps,
    matchesActive: coin === AppState.trading.currentCoin,
  };
}

/**
 * Handle incoming activeAssetCtx data from the realtime stream.
 */
function handleActiveAssetCtx(coin, ctxData) {
  if (!coin || !ctxData) return null;
  setActiveAssetCtx(coin, ctxData);
  return { coin, ctx: ctxData };
}

/**
 * Handle incoming TWAP state data from the realtime stream.
 */
function handleTwapStates(twapData) {
  if (!twapData || typeof twapData !== 'object') return null;
  const payload = setTwapStatePayload(twapData);
  return { payload };
}

/**
 * Handle incoming aggregate account data from the realtime stream.
 * Supports both Hyperliquid `webData2` and `webData3` channel labels.
 * Returns a dispatch hint for UI refresh.
 */
function handleWebData2(data) {
  if (!data || typeof data !== 'object') return null;

  let backendOrderSnapshot;
  const previousAccountState = getAccountState();
  const previousOpenOrders = getOpenOrders();
  const shouldApplyOrders = shouldApplyIncomingOrderRevision(data.orderRevision);

  if (data.orders !== undefined && shouldApplyOrders) {
    const filteredOrders = filterSuppressedOrders(data.orders || []);
    backendOrderSnapshot = setBackendOpenOrders(filteredOrders);
    commitIncomingOrderRevision(data.orderRevision);
  }

  let normalizedData = normalizeStreamAccountState(data, previousAccountState);

  const incomingSnapshotAt = Number(data.accountSnapshotAt || 0);
  const currentSnapshotAt = Number(previousAccountState?.accountSnapshotAt || 0);
  const olderAccountSnapshot = incomingSnapshotAt > 0
    && currentSnapshotAt > 0
    && incomingSnapshotAt < currentSnapshotAt;

  if (olderAccountSnapshot && normalizedData) {
    for (const key of [
      'assetPositions', 'marginSummary', 'crossMarginSummary', 'withdrawable',
      'riskSummary', 'spotState', 'spotUSDC', 'positionRisk', 'builderDexStates',
	  'builderDexFreshness',
      'accountMode', 'accountModeSource', 'riskSummaryFresh', 'accountSnapshotAt',
	  'accountSnapshotStale',
    ]) {
      if (previousAccountState?.[key] !== undefined) {
        normalizedData[key] = previousAccountState[key];
      } else {
        delete normalizedData[key];
      }
    }
  }

  if (normalizedData?.assetPositions !== undefined) {
    normalizedData = setBackendAssetPositions(
      normalizedData,
      filterSuppressedPositions(normalizedData.assetPositions)
    );
  }

  if (normalizedData && (
    normalizedData.marginSummary !== undefined
    || normalizedData.crossMarginSummary !== undefined
    || normalizedData.riskSummary !== undefined
    || normalizedData.withdrawable !== undefined
  )) {
    normalizedData = setBackendAccountRisk(normalizedData, {
      marginSummary: normalizedData.marginSummary,
      crossMarginSummary: normalizedData.crossMarginSummary,
      riskSummary: normalizedData.riskSummary,
      withdrawable: normalizedData.withdrawable,
    });
  }

  if (normalizedData?.orders !== undefined && shouldApplyOrders) {
    normalizedData.orders = backendOrderSnapshot !== undefined
      ? backendOrderSnapshot
      : setBackendOpenOrders(filterSuppressedOrders(normalizedData.orders || []));
  } else if (normalizedData?.orders !== undefined) {
    normalizedData.orders = previousOpenOrders;
  }

  if (normalizedData && (
    normalizedData.assetPositions !== undefined
    || normalizedData.orders !== undefined
    || normalizedData.marginSummary !== undefined
    || normalizedData.crossMarginSummary !== undefined
    || normalizedData.riskSummary?.accountValue !== undefined
    || normalizedData.riskSummary?.withdrawable !== undefined
    || normalizedData.withdrawable !== undefined
    || normalizedData.spotState !== undefined
  )) {
    const posChanged = positionsChanged(normalizedData, previousAccountState);
    const ordChanged = shouldApplyOrders && normalizedData.orders !== undefined
      ? ordersChanged(normalizedData.orders, previousOpenOrders)
      : false;

    if (normalizedData.spotState && normalizedData.spotState.balances) {
      for (const bal of normalizedData.spotState.balances) {
        if (bal.coin === 'USDC') {
          const total = parseFloat(bal.total || 0);
          const hold = parseFloat(bal.hold || 0);
          normalizedData.spotUSDC = (total - hold).toString();
          AppState.account.spotBalance = total - hold;
          break;
        }
      }
    }

    // Write canonical state through the compatibility bridge once.
    setLegacy('accountState', normalizedData);

    const needsEnrichment = posChanged || ordChanged || needsAccountEnrichment(normalizedData);
    const shouldEnrich = needsEnrichment ? requestAccountEnrichment() : false;

    return {
      type: 'webData2',
      posChanged,
      ordChanged,
      needsEnrichment,
      shouldEnrich,
    };
  }

  return { type: 'webData2', posChanged: false, ordChanged: false, needsEnrichment: false, shouldEnrich: false };
}

/**
 * Handle incoming orderResponse data from the realtime stream.
 */
function handleOrderResponse(status, error) {
  if (status === 'ok') {
    return { type: 'orderResponse', shouldEnrich: false };
  }
  return { type: 'orderResponse', error, shouldEnrich: false };
}

/**
 * Handle the backend xyz position poll. Builder-dex positions have no
 * upstream websocket stream (webData2 is main-dex only), so the backend
 * polls clearinghouseState?dex=xyz and pushes changes here. Replaces only
 * the xyz: slice of assetPositions, keeping main-dex positions intact.
 */
function handleXyzPositions(data) {
	return handleBuilderPositions({ ...data, dex: 'xyz' }, 'xyzPositions');
}

function handleBuilderPositions(data, resultType = 'builderPositions') {
  const incoming = Array.isArray(data?.assetPositions) ? data.assetPositions : null;
  const dex = String(data?.dex || '').toLowerCase();
  if (!incoming || !dex) return null;

  const previousState = getAccountState() || {};
  const otherDexes = (Array.isArray(previousState.assetPositions) ? previousState.assetPositions : [])
    .filter((wrapper) => getDex(String(wrapper?.position?.coin || '')) !== dex);
  const filtered = filterSuppressedPositions(incoming);

  const nextState = setBackendAssetPositions(
    { ...previousState },
    [...otherDexes, ...filtered],
  );
	nextState.builderDexFreshness = {
	  ...(previousState.builderDexFreshness || {}),
	  [dex]: {
		asOf: Number(data?.asOf || Date.now()),
		fresh: data?.fresh !== false,
	  },
	};
  setLegacy('accountState', nextState);

  return { type: resultType, dex, count: filtered.length };
}

/**
 * Extract a backend TP/SL protection failure from an orderUpdates payload.
 * The backend publishes { protectionError: { coin, error } } when an async
 * TP/SL attach fails — a filled position is sitting unprotected, so this must
 * surface loudly instead of being silently ignored.
 */
function extractProtectionError(payload) {
  const raw = payload?.protectionError;
  if (!raw || typeof raw !== 'object') return null;
  const coin = String(raw.coin || '');
  const error = String(raw.error || 'unknown error');
  console.error(`TP/SL protection failed to attach for ${coin}: ${error}`);
  return { coin, error };
}

/**
 * Handle incoming orderUpdates data from the realtime stream.
 */
function handleOrderUpdates(data) {
  const terminalOids = extractTerminalOrderOids(data);
  if (terminalOids.length) {
    clearLockedOpenOrders(terminalOids);
	removeOpenOrdersByOids(terminalOids);
  }
	const upsertedOrders = upsertOpenOrdersFromUpdates(data);
  return {
    type: 'orderUpdates',
    terminalOids,
	// Apply the backend's explicit delta immediately for rendering; the
	// following revisioned canonical snapshot remains authoritative.
	upsertedOrders,
    protectionError: extractProtectionError(data),
    shouldEnrich: false,
  };
}

/**
 * Handle incoming userFills data from the realtime stream.
 */
async function handleUserFills(fills, { isSnapshot = false } = {}) {
  if (!Array.isArray(fills) || !fills.length) return null;

  prependRecentFills(fills);

  // Fills only release optimistic locks; they must not remove open orders.
  // A fill carries no terminal status, so removing here made a partially
  // filled order vanish for the suppression window even though it still
  // rests. Full fills arrive as terminal orderUpdates (handleOrderUpdates).
  const filledOids = new Set(
    fills
      .map((fill) => Number(fill?.oid || 0))
      .filter((oid) => Number.isFinite(oid) && oid > 0)
  );
  if (filledOids.size) {
    clearLockedOpenOrders(Array.from(filledOids));
  }

  // Ground-truth own liquidations: Hyperliquid tags the liquidated user's own
  // fill with a `liquidation` object. A liquidation batch also includes the
  // liquidators' legs, so match liquidatedUser to this wallet. Snapshot replays
  // are skipped so a reconnect doesn't re-alert historical liquidations.
  const wallet = String(AppState.account.walletAddress || '').toLowerCase();
  const ownLiquidations = (isSnapshot || !wallet) ? [] : fills.filter(
    (fill) => fill?.liquidation
      && String(fill.liquidation.liquidatedUser || '').toLowerCase() === wallet,
  );

  return {
    type: 'userFills',
    fills,
    filledOids: Array.from(filledOids),
    ownLiquidations,
    shouldEnrich: false,
  };
}

export {
  handleBbo,
  handleActiveAssetCtx,
  handleTwapStates,
  handleWebData2,
  handleXyzPositions,
  handleBuilderPositions,
  handleOrderResponse,
  handleOrderUpdates,
  handleUserFills,
};
