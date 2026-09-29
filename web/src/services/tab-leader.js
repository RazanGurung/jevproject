/**
 * Tab leadership — elects a single "primary" tab among duplicate tabs of THIS
 * app (same origin) so they don't multiply background REST load (the 24h /
 * movers / mispricing / CVD-alert multi-coin scanners) onto Hyperliquid's shared
 * per-IP rate limit. Secondary tabs still work for viewing and live WS streaming;
 * they just don't run the heavy pollers. A separate Hyperliquid app in another
 * tab is a different origin and is completely unaffected by this.
 *
 * Mechanism: a localStorage "leader" record with a heartbeat. The leader renews
 * its timestamp on a tick; any tab whose record is missing/stale claims it. On
 * tab close the leader releases the record so another tab takes over within a
 * tick. localStorage is shared across same-origin tabs, so this needs no server.
 */
const LEADER_KEY = 'pez:tab-leader';
const HEARTBEAT_MS = 2000;
const STALE_MS = 6000; // > 2 missed heartbeats => previous leader is gone

function createTabLeadership({
  storage = (typeof globalThis !== 'undefined' && globalThis.localStorage) || null,
  now = () => Date.now(),
  setIntervalFn = (cb, ms) => globalThis.setInterval(cb, ms),
  addUnloadListener = (cb) => globalThis.addEventListener?.('beforeunload', cb),
  tabId = Math.random().toString(36).slice(2) + Date.now().toString(36),
} = {}) {
  let isLeader = false;
  let onChange = () => {};

  function read() {
    try {
      return JSON.parse(storage?.getItem(LEADER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function claim() {
    try {
      storage?.setItem(LEADER_KEY, JSON.stringify({ id: tabId, ts: now() }));
    } catch {
      // storage unavailable/full — fall through; tick() re-evaluates next time.
    }
  }

  function tick() {
    const cur = read();
    const fresh = cur && (now() - cur.ts) < STALE_MS;
    // Lead if the slot is vacant/stale, or it's already ours (renew the heartbeat).
    if (!fresh || cur.id === tabId) {
      claim();
      if (!isLeader) {
        isLeader = true;
        onChange(true);
      }
    } else if (isLeader) {
      // Another tab is the fresh leader (e.g. we lost a claim race) — step down.
      isLeader = false;
      onChange(false);
    }
  }

  function start(onLeadershipChange) {
    onChange = typeof onLeadershipChange === 'function' ? onLeadershipChange : () => {};
    tick();
    setIntervalFn(tick, HEARTBEAT_MS);
    addUnloadListener(() => {
      const cur = read();
      if (cur && cur.id === tabId) {
        try {
          storage?.removeItem(LEADER_KEY);
        } catch {
          // best effort — staleness will free the slot anyway
        }
      }
    });
    return () => isLeader;
  }

  return { start, tick, isLeaderNow: () => isLeader, tabId };
}

// Browser-wired entry point. Without localStorage (SSR/tests) the tab simply acts
// as the sole leader, so behaviour is unchanged outside a real multi-tab browser.
function startTabLeadership(onLeadershipChange) {
  if (typeof globalThis === 'undefined' || !globalThis.localStorage) {
    onLeadershipChange?.(true);
    return () => true;
  }
  return createTabLeadership().start(onLeadershipChange);
}

export { createTabLeadership, startTabLeadership };
