import { AppState } from './store.js';
import { DEFAULT_TIMEFRAME } from '../chart/chart-history-requirements.js';

const CHART_SESSION_STATUS = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  NOTICE: 'notice',
};

function ensureChartSession() {
  if (!AppState.ui.chartSession || typeof AppState.ui.chartSession !== 'object') {
    AppState.ui.chartSession = {
      status: CHART_SESSION_STATUS.IDLE,
      message: '',
      coin: '',
      timeframe: '',
      requestToken: null,
      updatedAt: 0,
    };
  }
  return AppState.ui.chartSession;
}

function syncChartSessionMirrors() {
  const session = ensureChartSession();
  AppState.ui.isLoadingChart = session.status === CHART_SESSION_STATUS.LOADING;
  AppState.ui.chartNotice = session.status === CHART_SESSION_STATUS.NOTICE ? String(session.message || '') : '';
}

function matchesChartSession({ coin, timeframe, requestToken } = {}) {
  const session = ensureChartSession();
  if (coin !== undefined && coin !== session.coin) return false;
  if (timeframe !== undefined && timeframe !== session.timeframe) return false;
  if (requestToken !== undefined && requestToken !== session.requestToken) return false;
  return true;
}

function setChartSession(nextSession = {}) {
  const current = ensureChartSession();
  AppState.ui.chartSession = {
    ...current,
    ...nextSession,
    updatedAt: Date.now(),
  };
  syncChartSessionMirrors();
  return AppState.ui.chartSession;
}

function getChartSession() {
  return ensureChartSession();
}

function beginChartSession({
  coin = AppState.trading.currentCoin,
  timeframe = AppState.trading.currentTimeframe || DEFAULT_TIMEFRAME,
  requestToken = null,
  message = 'Loading...',
} = {}) {
  return setChartSession({
    status: CHART_SESSION_STATUS.LOADING,
    message,
    coin,
    timeframe,
    requestToken,
  });
}

function completeChartSession({ coin, timeframe, requestToken } = {}) {
  if (!matchesChartSession({ coin, timeframe, requestToken })) return false;
  const current = ensureChartSession();
  // Tokenless callers (live candle stream) must not short-circuit an in-flight
  // REST snapshot: the fetch's own .then/.catch owns the loading→ready
  // transition, otherwise a single live candle arriving mid-switch flashes the
  // chart to ready with just that one bar before the full history lands.
  if (
    requestToken === undefined
    && current.requestToken != null
    && current.status === CHART_SESSION_STATUS.LOADING
  ) {
    return false;
  }
  if (current.status === CHART_SESSION_STATUS.NOTICE) {
    syncChartSessionMirrors();
    return true;
  }
  setChartSession({
    status: CHART_SESSION_STATUS.READY,
    message: '',
  });
  return true;
}

function failChartSession({ coin, timeframe, requestToken, message } = {}) {
  if (!matchesChartSession({ coin, timeframe, requestToken })) return false;
  const current = ensureChartSession();
  if (current.status === CHART_SESSION_STATUS.NOTICE) {
    syncChartSessionMirrors();
    return true;
  }
  if (typeof message === 'string' && message) {
    setChartSession({
      status: CHART_SESSION_STATUS.NOTICE,
      message,
      coin: coin ?? current.coin,
      timeframe: timeframe ?? current.timeframe,
      requestToken: requestToken ?? current.requestToken,
    });
    return true;
  }
  setChartSession({
    status: current.coin || current.timeframe ? CHART_SESSION_STATUS.READY : CHART_SESSION_STATUS.IDLE,
    message: '',
  });
  return true;
}

function setChartSessionNotice(message, { coin, timeframe, requestToken } = {}) {
  const nextMessage = typeof message === 'string' ? message : '';
  const current = ensureChartSession();
  const hasSessionIdentity = Boolean(
    current.coin
    || current.timeframe
    || current.requestToken !== null
  );
  if ((coin !== undefined || timeframe !== undefined || requestToken !== undefined)
    && !matchesChartSession({ coin, timeframe, requestToken })
    && hasSessionIdentity) {
    return false;
  }
  if (!nextMessage) {
    return completeChartSession({ coin, timeframe, requestToken });
  }
  setChartSession({
    status: CHART_SESSION_STATUS.NOTICE,
    message: nextMessage,
    coin: coin ?? current.coin,
    timeframe: timeframe ?? current.timeframe,
    requestToken: requestToken ?? current.requestToken,
  });
  return true;
}

function setIsLoadingChart(val) {
  if (val) {
    beginChartSession();
    return;
  }
  failChartSession();
}

export {
  CHART_SESSION_STATUS,
  getChartSession,
  beginChartSession,
  completeChartSession,
  failChartSession,
  setChartSessionNotice,
  setIsLoadingChart,
  syncChartSessionMirrors,
};
