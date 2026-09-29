import { WHALE_HALO_HALF_LIFE_MS, WHALE_NOTIONAL } from './market-trades.js';
import { priceKey } from './dom-ladder-state.js';

const COHORT_MERGE_MS = 5000;
const RESPONSE_TARGETS_MS = [15000, 60000];
const SAMPLE_EARLY_MS = 2000;
const SAMPLE_LATE_MS = 5000;
const MID_FRESH_MS = 2000;
const MAX_COHORTS_PER_COIN = 100;
const MAX_RECENT_WHALE_EVENTS = 400;
const WHALE_EVENT_MAX_AGE_MS = 20 * 60 * 1000;

function ensureWhaleRuntime(marketState) {
  if (!(marketState.whaleEventCache instanceof Map)) marketState.whaleEventCache = new Map();
  if (!(marketState.whaleResponseCache instanceof Map)) marketState.whaleResponseCache = new Map();
}

function spreadBpsFor(marketState, coin, executionPx) {
  const book = marketState.bookCache?.get(coin);
  const bid = Number(book?.bids?.[0]?.px);
  const ask = Number(book?.asks?.[0]?.px);
  if (!(bid > 0) || !(ask > bid) || !(executionPx > 0)) return 2;
  return Math.max(2, (ask - bid) / executionPx * 10000);
}

function ingestWhaleResponses(marketState, coin, normalized = []) {
  if (!marketState || !coin) return;
  ensureWhaleRuntime(marketState);
  const whales = normalized.filter((trade) => trade?.isWhale && Number.isFinite(trade.notional));
  if (!whales.length) return;

  const events = marketState.whaleEventCache.get(coin) || [];
  const cohorts = marketState.whaleResponseCache.get(coin) || [];
  whales.forEach((trade) => {
    events.push({
      tradeId: trade.tradeId,
      px: trade.px,
      notional: trade.notional,
      time: trade.time,
      side: trade.isBuy ? 'buy' : 'sell',
      major: !!trade.isMajorWhale,
    });

    const side = trade.isBuy ? 'buy' : 'sell';
    // Opposite-side prints may interleave without splitting a same-side burst.
    // Find the newest still-open cohort for this side rather than considering
    // only the last cohort of either side.
    const previous = cohorts.findLast((cohort) => (
      cohort.side === side
      && trade.time >= cohort.startedAt
      && trade.time - cohort.lastTradeAt <= COHORT_MERGE_MS
      && trade.time - cohort.startedAt <= COHORT_MERGE_MS
      && cohort.response60 === 'pending'
    ));
    if (previous) {
      const total = previous.totalNotional + trade.notional;
      previous.weightedExecutionPx = (
        previous.weightedExecutionPx * previous.totalNotional + trade.px * trade.notional
      ) / total;
      previous.totalNotional = total;
      previous.lastTradeAt = Math.max(previous.lastTradeAt, trade.time);
      previous.target15At = previous.lastTradeAt + RESPONSE_TARGETS_MS[0];
      previous.target60At = previous.lastTradeAt + RESPONSE_TARGETS_MS[1];
      previous.tradeIds.push(trade.tradeId);
      previous.priceKeys.add(priceKey(trade.px, coin));
      return;
    }

    cohorts.push({
      coin,
      side,
      startedAt: trade.time,
      lastTradeAt: trade.time,
      weightedExecutionPx: trade.px,
      totalNotional: trade.notional,
      thresholdBps: spreadBpsFor(marketState, coin, trade.px),
      target15At: trade.time + RESPONSE_TARGETS_MS[0],
      target60At: trade.time + RESPONSE_TARGETS_MS[1],
      response15: 'pending',
      response60: 'pending',
      tradeIds: [trade.tradeId],
      priceKeys: new Set([priceKey(trade.px, coin)]),
    });
  });
  marketState.whaleEventCache.set(coin, events.slice(-MAX_RECENT_WHALE_EVENTS));
  marketState.whaleResponseCache.set(coin, cohorts.slice(-MAX_COHORTS_PER_COIN));
}

function classifyResponse(cohort, mid) {
  const raw = (mid - cohort.weightedExecutionPx) / cohort.weightedExecutionPx;
  const adjusted = cohort.side === 'buy' ? raw : -raw;
  const threshold = cohort.thresholdBps / 10000;
  if (adjusted >= threshold) return { status: 'follow', returnPct: adjusted * 100 };
  if (adjusted <= -threshold) return { status: 'rejected', returnPct: adjusted * 100 };
  return { status: 'absorbed', returnPct: adjusted * 100 };
}

function foldCompletedResponse(marketState, cohort, result, now) {
  const activity = marketState.domTradeCache?.get(cohort.coin);
  if (activity instanceof Map) {
    cohort.priceKeys.forEach((key) => {
      const entry = activity.get(key);
      if (entry) entry.latestResponse = { ...result, time: now, side: cohort.side };
    });
    marketState.domActivityVersion = (marketState.domActivityVersion || 0) + 1;
  }
}

function sampleWhaleResponses(marketState, mids = {}, updatedAt = {}, now = Date.now()) {
  ensureWhaleRuntime(marketState);
  marketState.whaleResponseCache.forEach((cohorts, coin) => {
    const mid = Number(mids[coin]);
    const fresh = mid > 0 && now - Number(updatedAt[coin] || 0) <= MID_FRESH_MS;
    const unresolved = [];
    cohorts.forEach((cohort) => {
      for (const horizon of [15, 60]) {
        const field = `response${horizon}`;
        if (cohort[field] !== 'pending') continue;
        const target = cohort[`target${horizon}At`];
        if (fresh && now >= target - SAMPLE_EARLY_MS && now <= target + SAMPLE_LATE_MS) {
          cohort[field] = classifyResponse(cohort, mid);
        } else if (now > target + SAMPLE_LATE_MS) {
          cohort[field] = { status: 'unknown', returnPct: 0 };
        }
      }
      if (cohort.response60 !== 'pending') {
        foldCompletedResponse(marketState, cohort, cohort.response60, now);
      } else {
        unresolved.push(cohort);
      }
    });
    marketState.whaleResponseCache.set(coin, unresolved);
  });
}

function getDecayedWhaleEvents(marketState, coin, now = Date.now(), halfLifeMs = WHALE_HALO_HALF_LIFE_MS) {
  ensureWhaleRuntime(marketState);
  const events = marketState.whaleEventCache.get(coin) || [];
  const retained = events.filter((event) => now - event.time <= WHALE_EVENT_MAX_AGE_MS);
  if (retained.length !== events.length) marketState.whaleEventCache.set(coin, retained);
  return retained.map((event) => ({
    ...event,
    weightedNotional: event.notional * Math.exp(-Math.LN2 * Math.max(0, now - event.time) / halfLifeMs),
  })).filter((event) => event.weightedNotional >= Math.max(1, event.notional * 0.01));
}

export {
  WHALE_NOTIONAL,
  ingestWhaleResponses,
  sampleWhaleResponses,
  getDecayedWhaleEvents,
};
