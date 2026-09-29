import { AppState, ConnectionState } from './store.js';

export const MARKET_TICK_STALE_MS = 15000;

export function noteMarketTick(now = Date.now()) {
  AppState.connection.marketLastTickAt = now;
}

export function setMarketUpstreamConnected(connected) {
  AppState.connection.marketUpstreamConnected = connected === true;
  if (!AppState.connection.marketUpstreamConnected) {
    AppState.connection.marketLastTickAt = 0;
  }
}

export function getMarketTickAgeMs(now = Date.now()) {
  const ts = Number(AppState.connection.marketLastTickAt || 0);
  if (!Number.isFinite(ts) || ts <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - ts);
}

export function isMarketFeedLive(now = Date.now()) {
  const state = AppState.connection.marketState;
  const upstream = AppState.connection.marketUpstreamConnected === true;
  if (state !== ConnectionState.CONNECTED && state !== 'connected') return false;
  if (!upstream) return false;
  return getMarketTickAgeMs(now) <= MARKET_TICK_STALE_MS;
}

export function isTradingAllowed(now = Date.now()) {
  return isMarketFeedLive(now);
}

export function getConnectionChromeState(now = Date.now()) {
  const tradingState = AppState.connection.tradingState || ConnectionState.DISCONNECTED;
  const marketState = AppState.connection.marketState || ConnectionState.DISCONNECTED;
  const live = isMarketFeedLive(now);
  const marketConnecting = marketState === ConnectionState.CONNECTING
    || marketState === ConnectionState.RECONNECTING
    || tradingState === ConnectionState.CONNECTING
    || tradingState === ConnectionState.RECONNECTING;
  if (live && (tradingState === ConnectionState.CONNECTED || tradingState === ConnectionState.DISCONNECTED || tradingState === ConnectionState.POLLING)) {
    return { label: 'Live', tone: 'live', state: 'connected' };
  }
  if (marketConnecting || !live && marketState === ConnectionState.CONNECTED) {
    return { label: 'Sync', tone: 'sync', state: 'reconnecting' };
  }
  return { label: 'Offline', tone: 'offline', state: 'disconnected' };
}

export function rememberRecentCoin(coin) {
  const value = typeof coin === 'string' ? coin.trim() : '';
  if (!value) return;
  const current = Array.isArray(AppState.trading.recentCoins) ? AppState.trading.recentCoins : [];
  AppState.trading.recentCoins = [value, ...current.filter((entry) => entry !== value)].slice(0, 5);
}
