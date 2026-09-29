/**
 * Account stream - downstream WebSocket lifecycle only.
 * Parses raw messages and dispatches to stream handler for state updates.
 */

import { AppState, ConnectionState, setConnectionState, getConnectionState as getStoreConnectionState } from '../state/store.js';
import { getWalletAddress } from '../state/account-selectors.js';
import {
  handleBbo,
  handleActiveAssetCtx,
  handleTwapStates,
  handleWebData2,
  handleXyzPositions,
  handleBuilderPositions,
  handleOrderResponse,
  handleOrderUpdates,
  handleUserFills,
} from '../services/stream-handler.js';
import { createAuthenticatedWebSocket, resolveWebSocketUrl } from '../services/api.js';
import { fetchAccount } from '../services/account-service.js';
import { finishRecoveryOverlay } from '../services/recovery-overlay.js';
import { dispatchAccountStreamUiHints, updateConnectionStatusUI } from './account-stream-ui.js';
import { recordStreamEvent } from '../services/transport-metrics.js';
import { getAccountStreamConnectionStateHandler } from '../state/strategy-host.js';
import { createEventIdDeduper } from './event-id-dedupe.js';

let accountStreamSocket = null;
let lastMessageTimestamp = Date.now();
let lastHeartbeatTickAt = 0;
let heartbeatCheckInterval = null;
let reconnectAttempts = 0;
let usePolling = false;
let reconnectTimer = null;
let intentionalDisconnect = false;
let activeStreamUrl = '';
let lastConnectStartedAt = 0;
let lastOpenAt = 0;
const processedAccountEventIds = createEventIdDeduper();

function resetProcessedAccountEvents() {
  // The backend event sequence is process-local. Scope transport dedupe to one
  // socket so a backend restart (sequence restarting at 1) cannot suppress
  // fresh account/order/fill frames for up to five minutes.
  processedAccountEventIds.reset();
}

const HEARTBEAT_TIMEOUT_MS = 60000;
const HEARTBEAT_CHECK_INTERVAL_MS = 10000;
// A heartbeat tick arriving this late means timers were frozen (system sleep),
// not ordinary jitter. Mirrors the backend poller's wake-gap threshold.
const WAKE_GAP_MS = 30000;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
// Converging recovery triggers (wake tick, visibility handler, heartbeat) must
// not tear down a connection that was just (re)established.
const REFRESH_SUPPRESS_MS = 2000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;

function updateConnectionStatus(state) {
  // Single owner: store.setConnectionState → AppState.connection.tradingState.
  setConnectionState(state);
  updateConnectionStatusUI(state);
  getAccountStreamConnectionStateHandler()?.(state);

  if (state === ConnectionState.CONNECTED) {
    reconnectAttempts = 0;
    if (usePolling) {
      disablePollingFallback();
    }
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function getScopedStreamUrl() {
  const scopedAccount = encodeURIComponent(getWalletAddress());
  if (!scopedAccount) return '';
  const params = [];
  if (scopedAccount) params.push(`account=${scopedAccount}`);
  return resolveWebSocketUrl(`/api/trading-stream?${params.join('&')}`);
}

function closeSocket(code = 1000, reason = 'normal') {
  if (accountStreamSocket) {
    try {
      if (typeof accountStreamSocket.close === 'function') {
        accountStreamSocket.close(code, reason);
      }
    } catch {}
  }
  accountStreamSocket = null;
  activeStreamUrl = '';
}

function clearSocketReference() {
  accountStreamSocket = null;
  activeStreamUrl = '';
}

function trackProcessedEvent(eventId) {
  return processedAccountEventIds.seen(eventId);
}

function handleWebDataMessage(msg) {
  const result = handleWebData2(msg.data);
  if (result) dispatchAccountStreamUiHints(result);
}

// Channel → handler for trading-stream messages. A message carries one channel,
// so a single lookup replaces the old sequential if-chain; every entry is
// invoked only when msg.data is present.
const CHANNEL_HANDLERS = {
  bbo: (msg) => {
    if (!msg.data.data) return;
    const result = handleBbo(msg.data.data, msg.data.coin);
    if (result) dispatchAccountStreamUiHints(result);
  },
  activeAssetCtx: (msg) => handleActiveAssetCtx(msg.data.coin, msg.data.data),
  twapStates: (msg) => {
    const result = handleTwapStates(msg.data);
    if (result) dispatchAccountStreamUiHints(result);
  },
  webData2: handleWebDataMessage,
  webData3: handleWebDataMessage,
  xyzPositions: (msg) => {
    const result = handleXyzPositions(msg.data);
    if (result) dispatchAccountStreamUiHints(result);
  },
  builderPositions: (msg) => {
    const result = handleBuilderPositions(msg.data);
    if (result) dispatchAccountStreamUiHints(result);
  },
  orderUpdates: (msg) => {
    dispatchAccountStreamUiHints(handleOrderUpdates(msg.data));
  },
  userFills: async (msg) => {
    const fills = Array.isArray(msg.data) ? msg.data : (msg.data.fills || []);
    // Snapshot replays arrive on every resubscribe; they carry historical fills
    // and must not re-fire the liquidation alert.
    const isSnapshot = !Array.isArray(msg.data) && msg.data.isSnapshot === true;
    if (fills.length) {
      const result = await handleUserFills(fills, { isSnapshot });
      if (result) dispatchAccountStreamUiHints(result);
    }
  },
  botStatus: (msg) => dispatchAccountStreamUiHints({ type: 'botStatus', status: msg.data }),
};

async function handleIncomingMessage(rawData) {
  lastMessageTimestamp = Date.now();
  finishRecoveryOverlay();

  try {
    const msg = JSON.parse(rawData);
    if (trackProcessedEvent(msg.eventId)) return;

    if (msg.type === 'ping' || msg.type === 'heartbeat' || msg.type === 'connected') {
      return;
    }

    const handler = CHANNEL_HANDLERS[msg.channel];
    if (handler && msg.data) {
      await handler(msg);
    }

    // orderResponse is type-keyed (no channel), the one non-channel event.
    if (msg.type === 'orderResponse') {
      dispatchAccountStreamUiHints(handleOrderResponse(msg.status, msg.error));
    }
  } catch (err) {
    console.error('Account stream parse error:', err);
  }
}

function connectAccountStream(reason = 'connect') {
  recordStreamEvent('connectAttempts');
  intentionalDisconnect = false;
  const streamUrl = getScopedStreamUrl();
  if (!streamUrl) return;
  const connectionState = getStoreConnectionState();

  if (
    accountStreamSocket &&
    activeStreamUrl === streamUrl &&
    (
      connectionState === ConnectionState.CONNECTING ||
      connectionState === ConnectionState.CONNECTED ||
      connectionState === ConnectionState.RECONNECTING
    )
  ) {
    const readyState = accountStreamSocket.readyState;
    if (readyState === WS_CONNECTING || readyState === WS_OPEN) {
      return;
    }
  }

  clearReconnectTimer();
  closeSocket(1000, reason);

  setConnectionState(ConnectionState.CONNECTING);
  updateConnectionStatus('connecting');

  lastConnectStartedAt = Date.now();
  const socket = createAuthenticatedWebSocket(streamUrl);
  resetProcessedAccountEvents();
  accountStreamSocket = socket;
  activeStreamUrl = streamUrl;
  lastMessageTimestamp = Date.now();

  socket.onopen = () => {
    if (accountStreamSocket !== socket) return;
    recordStreamEvent('connects');
    setConnectionState(ConnectionState.CONNECTED);
    reconnectAttempts = 0;
    updateConnectionStatus('connected');
    lastOpenAt = Date.now();
    finishRecoveryOverlay();
  };

  socket.onmessage = async (event) => {
    if (accountStreamSocket !== socket) return;
    await handleIncomingMessage(event.data);
  };

  socket.onclose = () => {
    if (accountStreamSocket !== socket) return;
    stopHeartbeatMonitor();
    if (intentionalDisconnect) return;
    setConnectionState(ConnectionState.RECONNECTING);
    updateConnectionStatus('reconnecting');
    clearSocketReference();
    reconnectAttempts++;
    recordStreamEvent('reconnectSchedules');
    const delay = reconnectAttempts <= 1
      ? 0
      : Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    reconnectTimer = setTimeout(() => connectAccountStream(reason), delay);
  };

  socket.onerror = () => {
    if (accountStreamSocket !== socket) return;
    if (socket.readyState === WS_CLOSING) return;
    try {
      socket.close();
    } catch {}
  };

  startHeartbeatMonitor();
}

function disconnectAccountStream(reason = 'client-disconnect') {
  intentionalDisconnect = true;
  clearReconnectTimer();
  closeSocket(1000, reason);
  stopHeartbeatMonitor();
}

function stopHeartbeatMonitor() {
  if (heartbeatCheckInterval) {
    clearInterval(heartbeatCheckInterval);
    heartbeatCheckInterval = null;
  }
}

function refreshAccountStream(reason = 'refresh') {
  const readyState = accountStreamSocket?.readyState;
  if (
    (readyState === WS_CONNECTING || readyState === WS_OPEN) &&
    Date.now() - lastConnectStartedAt < REFRESH_SUPPRESS_MS
  ) {
    recordStreamEvent('refreshSuppressed');
    return;
  }
  recordStreamEvent('refreshes');
  disconnectAccountStream();
  intentionalDisconnect = false;
  connectAccountStream(reason);
}

function resetReconnectBackoff(reason = 'resume') {
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearReconnectTimer();
    recordStreamEvent('fastReconnects');
    connectAccountStream(reason);
  }
}

function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  lastHeartbeatTickAt = Date.now();

  heartbeatCheckInterval = setInterval(() => {
    const now = Date.now();
    const tickGap = now - lastHeartbeatTickAt;
    lastHeartbeatTickAt = now;

    // A foreground tab never sees >30s between ticks unless timers were frozen
    // by a system sleep — no visibility event fires in that case, so this is
    // the only wake signal. Hidden-tab gaps are just throttling: skip, and let
    // the staleness check below / tab-resume on refocus handle recovery.
    if (tickGap > WAKE_GAP_MS && !globalThis.document?.hidden) {
      recordStreamEvent('wakeDetections');
      reconnectAttempts = 0;
      refreshAccountStream('system-wake');
      Promise.resolve(fetchAccount(false)).catch(() => {});
      return;
    }

    const elapsed = now - lastMessageTimestamp;
    if (elapsed > HEARTBEAT_TIMEOUT_MS) {
      recordStreamEvent('heartbeatTimeouts');
      refreshAccountStream('heartbeat-timeout');
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

let pollingInterval = null;

function disablePollingFallback() {
  recordStreamEvent('pollingDisabled');
  usePolling = false;
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function getConnectionState() {
  return getStoreConnectionState();
}

function getLastMessageAgeMs(now = Date.now()) {
  return Math.max(0, now - lastMessageTimestamp);
}

function getAccountStreamSocket() {
  return accountStreamSocket;
}

export {
  connectAccountStream,
  disconnectAccountStream,
  refreshAccountStream,
  resetReconnectBackoff,
  updateConnectionStatus,
  startHeartbeatMonitor,
  disablePollingFallback,
  getConnectionState,
  getAccountStreamSocket,
  getLastMessageAgeMs,
};
