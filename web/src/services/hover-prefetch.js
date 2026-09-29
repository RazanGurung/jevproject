/**
 * Hover Intent Pre-fetch Service
 *
 * Listens for mouseover on ticker buttons and links ([data-action="switchCoin"][data-arg])
 * with a 120ms debounce. If the cursor lingers over a candidate coin that is not the
 * currently active coin, it issues an idle background candle prefetch so the data is
 * already in memory by the time the user clicks.
 */

import { getCurrentCoin, getCurrentTimeframe } from '../state/trading-selectors.js';
import { DEFAULT_TIMEFRAME } from '../chart/chart-history-requirements.js';
import { requestChartCandles } from './market-session.js';

const DEFAULT_HOVER_DEBOUNCE_MS = 120;
const RECENT_PREFETCH_COOLDOWN_MS = 15000;

function createHoverPrefetchService({
  fetchFn = requestChartCandles,
  getActiveCoin = getCurrentCoin,
  getActiveTimeframe = getCurrentTimeframe,
  debounceMs = DEFAULT_HOVER_DEBOUNCE_MS,
  cooldownMs = RECENT_PREFETCH_COOLDOWN_MS,
  rootElement = typeof document !== 'undefined' ? document : null,
  setTimeoutFn = (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  nowFn = () => Date.now(),
} = {}) {
  let timer = null;
  let hoveredCoin = null;
  const recentPrefetches = new Map();

  function findCandidateCoin(target) {
    if (!(target instanceof Element)) return null;
    const btn = target.closest('[data-action="switchCoin"]');
    if (!btn) return null;
    const coin = String(btn.getAttribute('data-arg') || btn.getAttribute('data-coin') || '').trim();
    return coin || null;
  }

  function handleMouseOver(event) {
    const candidate = findCandidateCoin(event.target);
    if (!candidate) {
      cancelHover();
      return;
    }
    if (candidate === hoveredCoin) return;

    cancelHover();
    const current = getActiveCoin();
    if (candidate === current) return;

    const lastFetch = recentPrefetches.get(candidate);
    if (lastFetch && (nowFn() - lastFetch < cooldownMs)) return;

    hoveredCoin = candidate;
    timer = setTimeoutFn(() => {
      timer = null;
      const tf = getActiveTimeframe() || DEFAULT_TIMEFRAME;
      recentPrefetches.set(candidate, nowFn());
      Promise.resolve(fetchFn(candidate, tf, { background: true })).catch(() => {});
    }, debounceMs);
  }

  function cancelHover() {
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    hoveredCoin = null;
  }

  function handleMouseOut(event) {
    const toElement = event.relatedTarget;
    if (hoveredCoin && (!toElement || findCandidateCoin(toElement) !== hoveredCoin)) {
      cancelHover();
    }
  }

  function handleClick(event) {
    const candidate = findCandidateCoin(event.target);
    if (candidate) {
      cancelHover();
    }
  }

  let bound = false;
  function start() {
    if (bound || !rootElement) return;
    rootElement.addEventListener('mouseover', handleMouseOver, { passive: true });
    rootElement.addEventListener('mouseout', handleMouseOut, { passive: true });
    rootElement.addEventListener('click', handleClick, { passive: true });
    bound = true;
  }

  function stop() {
    if (!bound || !rootElement) return;
    cancelHover();
    rootElement.removeEventListener('mouseover', handleMouseOver);
    rootElement.removeEventListener('mouseout', handleMouseOut);
    rootElement.removeEventListener('click', handleClick);
    recentPrefetches.clear();
    bound = false;
  }

  return {
    start,
    stop,
    cancelHover,
    handleMouseOver,
    handleMouseOut,
    handleClick,
    _getRecentPrefetches: () => recentPrefetches,
  };
}

export {
  createHoverPrefetchService,
  DEFAULT_HOVER_DEBOUNCE_MS,
};
