/**
 * Market subscription controller.
 *
 * Owns the dedupe-key bookkeeping that decides whether a `subscribeMarket`
 * call should hit the backend or short-circuit. Pulled out of
 * `streams/market-ws.js` so the stream module's subscribe path becomes a
 * thin transport adapter instead of carrying its own intent state.
 *
 * The controller is stateful: each instance tracks the last accepted
 * subscription key. Callers compute a key for the desired subscription via
 * `nextKey({...})` and pass it to `shouldSubscribe(key)`; if it returns
 * true the caller performs the network work and then `commit(key)`.
 */


function buildSubscriptionKey({ clientId, coin = '', interval = '', tradeCoins = [], indicatorIntervals = [] } = {}) {
  // Sort membership lists so a pure re-order (mover re-rank, map iteration)
  // does not look like a new subscription. Payload order remains caller-owned
  // for admission priority; only the dedupe key is order-insensitive.
  const sortedTradeCoins = Array.from(tradeCoins || []).filter(Boolean).slice().sort();
  const sortedIndicators = Array.from(indicatorIntervals || []).filter(Boolean).slice().sort();
  return JSON.stringify({
    clientId,
    coin,
    interval,
    tradeCoins: sortedTradeCoins,
    indicatorIntervals: sortedIndicators,
  });
}

function createMarketSubscriptionController() {
  let lastAcceptedKey = '';
  let pendingKey = '';

  function shouldSubscribe(key) {
    return key !== lastAcceptedKey && key !== pendingKey;
  }

  function begin(key) {
    pendingKey = key;
  }

  function commit(key) {
    lastAcceptedKey = key;
    if (pendingKey === key) pendingKey = '';
  }

  function fail(key) {
    if (pendingKey === key) pendingKey = '';
  }

  function reset() {
    lastAcceptedKey = '';
    pendingKey = '';
  }

  return {
    buildSubscriptionKey,
    shouldSubscribe,
    begin,
    commit,
    fail,
    reset,
    get lastKey() {
      return lastAcceptedKey;
    },
    get activeKey() {
      return pendingKey;
    },
  };
}

export {
  buildSubscriptionKey,
  createMarketSubscriptionController,
};
