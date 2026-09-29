import { describe, expect, it } from 'vitest';
import { createTabLeadership } from '../tab-leader.js';

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// Drive ticks manually (no real timers) with a shared clock + storage so two
// "tabs" coordinate exactly as same-origin browser tabs would.
function makeTab(storage, clock, id) {
  const changes = [];
  const ctrl = createTabLeadership({
    storage,
    now: () => clock.t,
    setIntervalFn: () => 0, // manual ticks in the test
    addUnloadListener: () => {},
    tabId: id,
  });
  ctrl.start((isLeader) => changes.push(isLeader));
  return { ctrl, changes };
}

describe('tab leadership', () => {
  it('elects the first tab as leader and keeps the second passive', () => {
    const storage = makeStorage();
    const clock = { t: 1000 };
    const a = makeTab(storage, clock, 'A'); // start() ran one tick -> A leads
    const b = makeTab(storage, clock, 'B'); // start() ran one tick -> B sees A fresh

    expect(a.ctrl.isLeaderNow()).toBe(true);
    expect(b.ctrl.isLeaderNow()).toBe(false);
    expect(a.changes).toEqual([true]);
    expect(b.changes).toEqual([]); // never became leader -> no change emitted
  });

  it('promotes the second tab when the leader goes stale (closed)', () => {
    const storage = makeStorage();
    const clock = { t: 1000 };
    const a = makeTab(storage, clock, 'A');
    const b = makeTab(storage, clock, 'B');
    expect(b.ctrl.isLeaderNow()).toBe(false);

    // A "closes": stops renewing. Advance past the stale window and tick B.
    clock.t += 7000;
    b.ctrl.tick();

    expect(b.ctrl.isLeaderNow()).toBe(true);
    expect(b.changes).toEqual([true]);
  });

  it('renews its own heartbeat without re-emitting leadership', () => {
    const storage = makeStorage();
    const clock = { t: 1000 };
    const a = makeTab(storage, clock, 'A');
    clock.t += 2000;
    a.ctrl.tick();
    clock.t += 2000;
    a.ctrl.tick();
    expect(a.ctrl.isLeaderNow()).toBe(true);
    expect(a.changes).toEqual([true]); // only the initial transition, no churn
  });
});
