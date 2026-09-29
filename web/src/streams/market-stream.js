/**
 * Market stream transport.
 *
 * Owns only the high-volume market/chart socket. Account state and execution
 * events use trading-stream (whose lifecycle module is account-stream.js).
 */

import { AppState } from '../state/store.js';
import {
  handleBook,
  handleTrades,
  handleMarketLiquidations,
  handleCandle,
  handleMids,
  subscribeMarket,
  resetMarketSubscriptions,
  beginMarketStreamEpoch,
  recoverActiveCandlesIfStale,
  recoverActiveCandlesAfterReconnect,
} from './market-ws.js';
import { createAuthenticatedWebSocket, resolveWebSocketUrl } from '../services/api.js';
import { getStreamClientId } from './client-id.js';
import { recordMarketRefresh, recordStreamEvent } from '../services/transport-metrics.js';
import { noteMarketTick, setMarketUpstreamConnected } from '../state/connection-health.js';
import { updateConnectionStatusUI } from './account-stream-ui.js';
import { ingestNewsStream } from '../services/news-service.js';
import { createEventIdDeduper } from './event-id-dedupe.js';

const HEARTBEAT_TIMEOUT_MS = 60000;
const HEARTBEAT_CHECK_INTERVAL_MS = 10000;
const WAKE_GAP_MS = 30000;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const REFRESH_SUPPRESS_MS = 2000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let lastMessageAt = Date.now();
let lastMarketPayloadAt = Date.now();
let lastHeartbeatTickAt = 0;
let lastConnectStartedAt = 0;
let intentionalDisconnect = false;
let activeUrl = '';
const processedMarketEventIds = createEventIdDeduper();

function resetProcessedMarketEvents() {
  // eventId is allocated by the current backend process. A server restart
  // resets that sequence, so carrying ids across downstream socket lifetimes
  // can misclassify fresh frames as duplicates until the old ids age out.
  // WebSocket delivery is ordered within one connection; keep dedupe scoped to
  // that connection and let domain-level trade/candle revisions handle replay.
  processedMarketEventIds.reset();
}

function setMarketConnectionState(state) {
  AppState.connection.marketState = state;
  if (state !== 'connected') {
    setMarketUpstreamConnected(false);
  }
  updateConnectionStatusUI(state);
}

function marketStreamUrl() {
  return resolveWebSocketUrl(`/api/market-stream?clientId=${encodeURIComponent(getStreamClientId())}`);
}

function seenEvent(eventId) {
  return processedMarketEventIds.seen(eventId);
}

const LIVE_MARKET_CHANNELS = new Set(['allMids', 'l2Book', 'trades', 'candle']);

const MARKET_HANDLERS = {
  allMids: (msg) => handleMids(msg.data),
  candle: (msg) => handleCandle(msg.data),
  l2Book: (msg) => handleBook(msg.data),
  trades: (msg) => handleTrades(msg.data, msg.coin || msg.data?.[0]?.coin || msg.data?.[0]?.s || '', { flow: msg._flow }),
  liquidations: (msg) => handleMarketLiquidations(msg.data),
  news: (msg) => ingestNewsStream(msg.data),
};

async function handleMarketMessage(rawData) {
  lastMessageAt = Date.now();
  try {
    const msg = JSON.parse(rawData);
    if (seenEvent(msg.eventId)) return;
    if (msg.type === 'ping' || msg.type === 'connected') return;
    if (msg.type === 'heartbeat') {
      updateConnectionStatusUI();
      return;
    }
    if (msg.type === 'upstream') {
      setMarketUpstreamConnected(msg.connected === true);
      updateConnectionStatusUI();
      return;
    }
    const handler = MARKET_HANDLERS[msg.channel];
    if (handler && msg.data) {
      const isSnapshot = msg.channel === 'allMids' && msg.data.snapshot === true;
      if (LIVE_MARKET_CHANNELS.has(msg.channel) && !isSnapshot) {
        lastMarketPayloadAt = Date.now();
        noteMarketTick();
        setMarketUpstreamConnected(true);
      }
      await handler(msg);
      updateConnectionStatusUI();
    }
  } catch (error) {
    console.error('Market stream parse error:', error);
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat() {
  clearHeartbeat();
  lastHeartbeatTickAt = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const tickGap = now - lastHeartbeatTickAt;
    lastHeartbeatTickAt = now;

    // A late tick in a visible tab means the machine slept while this page
    // remained foregrounded. Visibility/focus events do not fire in that
    // case, so force a same-bucket snapshot before recycling only the market
    // socket. Hidden-tab timer throttling is not a system-wake signal.
    if (tickGap > WAKE_GAP_MS && !globalThis.document?.hidden) {
      recordStreamEvent('marketWakeDetections');
      recoverActiveCandlesIfStale(now, { forceAuthoritative: true });
      reconnectAttempts = 0;
      refreshMarketStream('system-wake');
      Promise.resolve(import('../chart/chart-render.js'))
        .then(({ recoverChartSurfaceAfterResume }) => recoverChartSurfaceAfterResume?.())
        .catch(() => {});
      return;
    }

    if (now - lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
      recordStreamEvent('marketHeartbeatTimeouts');
      refreshMarketStream('heartbeat-timeout');
      return;
    }
    updateConnectionStatusUI();
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

function closeSocket(code = 1000, reason = 'normal') {
  const current = socket;
  socket = null;
  activeUrl = '';
  if (current) {
    try {
      if (typeof current.close === 'function') {
        current.close(code, reason);
      }
    } catch {}
  }
}

function connectMarketStream(reason = 'connect') {
  const url = marketStreamUrl();
  if (socket && activeUrl === url && (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN)) return;

  intentionalDisconnect = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  closeSocket(1000, reason);
  setMarketConnectionState('connecting');
  beginMarketStreamEpoch();
  lastConnectStartedAt = Date.now();

  const next = createAuthenticatedWebSocket(url);
  recordStreamEvent('marketConnectAttempts');
  resetProcessedMarketEvents();
  socket = next;
  activeUrl = url;
  lastMessageAt = Date.now();
  lastMarketPayloadAt = Date.now();
  startHeartbeat();

  next.onopen = () => {
    if (socket !== next) return;
    reconnectAttempts = 0;
    recordStreamEvent('marketConnects');
    setMarketConnectionState('connected');
    resetMarketSubscriptions();
    Promise.resolve(subscribeMarket()).catch(() => {});
    recoverActiveCandlesAfterReconnect();
    // Reconnect often drops mid-gesture pointerup; Draw/AVWAP can leave the
    // chart with handleScroll=false so pan/zoom feels dead until reload.
    Promise.resolve(import('../chart/lightweight-chart.js'))
      .then(({ releaseStuckChartGestures }) => releaseStuckChartGestures?.())
      .catch(() => {});
    if (Array.isArray(AppState.ui.rvwapLookbacks) && AppState.ui.rvwapLookbacks.length > 0) {
      Promise.resolve(import('../services/market-service.js'))
        .then(({ scheduleActiveRvwapHydration }) => scheduleActiveRvwapHydration?.(
          AppState.trading.currentCoin,
          { force: true },
        ))
        .catch(() => {});
    }
  };
  next.onmessage = (event) => {
    if (socket === next) handleMarketMessage(event.data);
  };
  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    activeUrl = '';
    clearHeartbeat();
    resetMarketSubscriptions();
    if (intentionalDisconnect) return;
    setMarketConnectionState('reconnecting');
    reconnectAttempts += 1;
    recordStreamEvent('reconnectSchedules');
    recordStreamEvent('marketReconnectSchedules');
    const delay = reconnectAttempts <= 1
      ? 0
      : Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    reconnectTimer = setTimeout(() => connectMarketStream(reason), delay);
  };
  next.onerror = () => {
    if (socket === next) {
      try { next.close(); } catch {}
    }
  };
}

function disconnectMarketStream(reason = 'client-disconnect') {
  intentionalDisconnect = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearHeartbeat();
  closeSocket(1000, reason);
  setMarketConnectionState('disconnected');
}

function refreshMarketStream(reason = 'refresh') {
  const readyState = socket?.readyState;
  if (
    (readyState === WS_CONNECTING || readyState === WS_OPEN)
    && Date.now() - lastConnectStartedAt < REFRESH_SUPPRESS_MS
  ) {
    recordStreamEvent('refreshSuppressed');
    return;
  }
  recordMarketRefresh(reason);
  disconnectMarketStream(reason);
  intentionalDisconnect = false;
  connectMarketStream(reason);
}

function resetMarketReconnectBackoff(reason = 'resume') {
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connectMarketStream(reason);
  }
}

function getMarketStreamSocket() { return socket; }
function getMarketStreamMessageAgeMs(now = Date.now()) { return Math.max(0, now - lastMarketPayloadAt); }

export {
  connectMarketStream,
  disconnectMarketStream,
  refreshMarketStream,
  resetMarketReconnectBackoff,
  getMarketStreamSocket,
  getMarketStreamMessageAgeMs,
};
