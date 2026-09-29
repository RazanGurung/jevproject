import { recordApiDedupHit, recordApiResult } from './transport-metrics.js';
import { getApiBaseUrl, resolveApiUrl, resolveWebSocketUrl } from '../utils/api-resolver.js';
import { sleep } from '../utils/helpers.js';

/**
 * API service - centralized transport helpers
 */


const API_TOKEN_STORAGE_KEY = 'pez.apiToken';

// The API token is only required when the backend has PEZ_API_TOKEN set
// (any publicly reachable deployment). On localhost it is unset and these
// helpers are inert. A server-injected config value wins so a hosted page can
// be provisioned without per-browser entry; otherwise it falls back to a
// value the user stored locally.
function getApiToken() {
  const fromConfig = (typeof window !== 'undefined' && window.__PEZ_CONFIG__?.apiToken) || '';
  if (fromConfig) return String(fromConfig);
  try {
    return window.localStorage?.getItem(API_TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setApiToken(token) {
  const value = String(token || '').trim();
  try {
    if (value) window.localStorage?.setItem(API_TOKEN_STORAGE_KEY, value);
    else window.localStorage?.removeItem(API_TOKEN_STORAGE_KEY);
  } catch {}
  return value;
}

function createAuthenticatedWebSocket(url) {
  const token = getApiToken();
  if (!token) return new WebSocket(url);
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return new WebSocket(url, [`pez-token.${encoded}`]);
}

// Prompt the user for the token at most once per page load when a protected
// request is rejected. We never auto-retry the original request: re-sending a
// rejected order/cancel could double-submit, so the user re-triggers the action
// themselves after the token is stored.
let promptedForToken = false;
function promptForApiTokenOnce() {
  if (promptedForToken || typeof window === 'undefined' || typeof window.prompt !== 'function') return;
  promptedForToken = true;
  const entered = window.prompt('This server requires an API token (PEZ_API_TOKEN) for trading actions. Enter it to continue:');
  if (entered) setApiToken(entered);
}

const pendingRequests = new Map();
const TRANSIENT_API_RETRY_DELAYS_MS = [150, 400];

// Bound concurrent *background* candle loads (prefetch, radar regime and the
// 24h-change fallback). Uncapped, these fan out
// dozens of candleSnapshot requests at once and trip Hyperliquid's per-IP /info
// limit (429 → proxy 502). Only callers that pass `background: true` are gated;
// foreground chart loads pass straight through, so the chart the user is waiting
// on is never delayed by background work. A request holds its slot across retries.
const BG_CANDLE_MAX_CONCURRENCY = 3;
let bgInFlight = 0;
const bgWaiters = [];

function acquireBgSlot() {
  if (bgInFlight < BG_CANDLE_MAX_CONCURRENCY) {
    bgInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => bgWaiters.push(resolve));
}

function releaseBgSlot() {
  const next = bgWaiters.shift();
  if (next) next(); // hand the slot to a waiter; in-flight count unchanged
  else bgInFlight = Math.max(0, bgInFlight - 1);
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

function isTransientApiError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.rawMessage || error?.message || '');
  // 504 covers server-side candle deadline / lane wait; deadline-exceeded
  // messages often arrive as 502 with a Go net/http error string.
  return status === 429 || status === 500 || status === 502 || status === 504
    || /429|500|502|504|rate limit|timeout|deadline exceeded|bad gateway|upstream http|failed to fetch|network_io_suspended|networkerror|load failed/i.test(message);
}

// True when the failure is an intentional cancel (chart switch abort) rather
// than a transport fault the UI should surface.
function isCanceledRequestError(error, signal) {
  if (isAbortError(error, signal)) return true;
  const status = Number(error?.status || 0);
  const message = String(error?.rawMessage || error?.message || '');
  return status === 499 || (status === 504 && /request canceled/i.test(message));
}

// Background-lane circuit breaker: when this many consecutive background
// requests have failed transiently (a live throttle storm, not a per-request
// fluke), further background requests skip the retry delays — one attempt
// each — until any request succeeds again. The per-service cooldowns (radar
// sweep backoff, candle failure cooldowns) own the re-attempt pacing; retrying
// 502s inside a storm only feeds it. Foreground requests always keep their
// retries: the user is waiting on those.
const BG_BREAKER_THRESHOLD = 3;
let bgTransientFailureStreak = 0;

async function apiGet(url) {
  const resolvedUrl = resolveApiUrl(url);
  const headers = {};
  const token = getApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(resolvedUrl, { headers });
  if (!res.ok) {
    recordApiResult({ url: resolvedUrl, status: res.status, ok: false, message: `API GET failed: ${res.status}` });
    throw new Error(`API GET failed: ${res.status}`);
  }
  const data = await res.json();
  recordApiResult({ url: resolvedUrl, status: res.status, ok: true });
  return data;
}

async function apiJson(method, url, body, { signal } = {}) {
  const resolvedUrl = resolveApiUrl(url);
  const headers = { 'Content-Type': 'application/json' };
  const token = getApiToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(resolvedUrl, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    recordApiResult({ url: resolvedUrl, status: 401, ok: false, message: 'unauthorized' });
    promptForApiTokenOnce();
    const error = new Error(`${resolvedUrl} 401: unauthorized — set the API token, then retry the action`);
    error.status = 401;
    error.url = resolvedUrl;
    throw error;
  }
  const text = await res.text();
  let parsed;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const msg = parsed?.error || parsed?.message || text || `API ${method} failed: ${res.status}`;
    recordApiResult({ url: resolvedUrl, status: res.status, ok: false, message: msg });
    const error = new Error(`${resolvedUrl} ${res.status}: ${msg}`);
    error.status = res.status;
    error.url = resolvedUrl;
    error.body = parsed ?? text;
    error.rawMessage = msg;
    throw error;
  }
  if (!text) {
    recordApiResult({ url: resolvedUrl, status: res.status, ok: true });
    return null;
  }
  if (parsed !== null) {
    recordApiResult({ url: resolvedUrl, status: res.status, ok: true });
    return parsed;
  }
  recordApiResult({ url: resolvedUrl, status: res.status, ok: false, message: 'invalid JSON response' });
  const error = new Error(`${resolvedUrl} invalid JSON response`);
  error.url = resolvedUrl;
  throw error;
}

async function apiPost(url, body, { signal } = {}) {
  return apiJson('POST', url, body, { signal });
}

async function apiPut(url, body, { signal } = {}) {
  return apiJson('PUT', url, body, { signal });
}

// Pass background:true for multi-coin scanner traffic so it's concurrency-gated
// (see acquireBgSlot); foreground chart loads omit it and are never gated. Pass a
// `signal` (AbortSignal) to make a request cancellable — used so a superseded
// chart switch drops its in-flight load instead of running it to completion.

// Shared transient-retry ladder used by /api/hl and /api/chart-candles so a
// single cold-chart 502/timeout does not blank the visible series.
async function postWithTransientRetry(url, body, { background = false, signal } = {}) {
  if (background) await acquireBgSlot();
  const breakerOpen = background && bgTransientFailureStreak >= BG_BREAKER_THRESHOLD;
  const maxRetries = breakerOpen ? 0 : TRANSIENT_API_RETRY_DELAYS_MS.length;
  try {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await apiPost(url, body, { signal });
        bgTransientFailureStreak = 0; // any success closes the breaker
        return result;
      } catch (error) {
        lastError = error;
        // An abort is intentional — surface it immediately, never retry it.
        if (isCanceledRequestError(error, signal)) throw error;
        if (attempt >= maxRetries || !isTransientApiError(error)) {
          if (background && isTransientApiError(error)) bgTransientFailureStreak += 1;
          throw error;
        }
        await sleep(TRANSIENT_API_RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError || new Error(`${url} failed`);
  } finally {
    if (background) releaseBgSlot();
  }
}

async function hlPost(body, { background = false, signal } = {}) {
  return postWithTransientRetry('/api/hl', body, { background, signal });
}

async function chartCandlesPost(body, { background = false, signal } = {}) {
  return postWithTransientRetry('/api/chart-candles', body, { background, signal });
}

async function fetchWithDedup(key, fetchFn, { signal } = {}) {
  const existing = pendingRequests.get(key);
  if (existing && !existing.signal?.aborted && (!signal || existing.signal === signal)) {
    recordApiDedupHit();
    return existing.promise;
  }
  const promise = fetchFn();
  pendingRequests.set(key, { promise, signal });
  try {
    return await promise;
  } finally {
    if (pendingRequests.get(key)?.promise === promise) {
      pendingRequests.delete(key);
    }
  }
}

export {
  apiGet,
  apiPost,
  apiPut,
  getApiToken,
  setApiToken,
  createAuthenticatedWebSocket,
  getApiBaseUrl,
  hlPost,
  chartCandlesPost,
  fetchWithDedup,
  isTransientApiError,
  isCanceledRequestError,
  isAbortError,
  resolveApiUrl,
  resolveWebSocketUrl,
  sleep,
};
