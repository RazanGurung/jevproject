import { describe, expect, it, vi } from 'vitest';

import { createCvdAlertMonitor } from '../cvd-alert-monitor.js';

// Harness driving the monitor with a scripted oscillator value. Each tick()
// advances the last-bar time (so the skip-recompute guard doesn't block);
// sameBar() reuses the current bar time.
function makeHarness() {
  let coins = ['BTC'];
  let value = 0;
  let barTime = 1000;
  let muted = false;
  let connected = true;
  const alerts = [];
  const fetchSpy = vi.fn(async (requested) => ({
    readings: requested.map((coin) => ({ coin, barTime, value })),
  }));

  const monitor = createCvdAlertMonitor({
    getMoverCoins: () => coins,
    fetchReadings: fetchSpy,
    onAlert: (alert) => alerts.push(alert),
    isMuted: () => muted,
    getIsConnected: () => connected,
  });

  return {
    monitor,
    alerts,
    fetchSpy,
    setCoins(next) { coins = next; },
    setMuted(next) { muted = next; },
    setConnected(next) { connected = next; },
    async tick(v) { value = v; barTime += 1000; await monitor.checkMovers(); },
    async sameBar(v) { value = v; await monitor.checkMovers(); },
  };
}

describe('cvd alert monitor', () => {
  it('uses one backend read-model request for the monitored set', async () => {
    const alerts = [];
    let barTime = 1000;
    let value = 0.5;
    const fetchReadings = vi.fn(async (coins) => ({
      readings: coins.map((coin) => ({ coin, barTime, value })),
    }));
    const monitor = createCvdAlertMonitor({
      getMoverCoins: () => ['BTC', 'ETH', 'BTC'],
      fetchReadings,
      onAlert: (alert) => alerts.push(alert),
      isMuted: () => false,
      getIsConnected: () => true,
    });

    await monitor.checkMovers();
    expect(fetchReadings).toHaveBeenCalledTimes(1);
    expect(fetchReadings.mock.calls[0][0]).toEqual(['BTC', 'ETH']);

    barTime += 3600;
    value = 0.99;
    await monitor.checkMovers();
    expect(fetchReadings).toHaveBeenCalledTimes(2);
    expect(alerts).toEqual([
      { coin: 'BTC', direction: 'up', value: 0.99 },
      { coin: 'ETH', direction: 'up', value: 0.99 },
    ]);
  });

  it('scans more than 40 monitored coins in ordered sequential batches', async () => {
    const coins = Array.from({ length: 45 }, (_, index) => `COIN${index}`);
    let barTime = 1000;
    let value = 0.5;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const alerts = [];
    const fetchReadings = vi.fn(async (requested) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      return { readings: requested.map((coin) => ({ coin, barTime, value })) };
    });
    const monitor = createCvdAlertMonitor({
      getMoverCoins: () => coins,
      fetchReadings,
      onAlert: (alert) => alerts.push(alert),
      isMuted: () => false,
      getIsConnected: () => true,
    });

    await monitor.checkMovers();
    expect(fetchReadings.mock.calls.map(([batch]) => batch.length)).toEqual([40, 5]);
    expect(fetchReadings.mock.calls[0][0]).toEqual(coins.slice(0, 40));
    expect(fetchReadings.mock.calls[1][0]).toEqual(coins.slice(40));
    expect(maxActiveRequests).toBe(1);

    barTime += 3600;
    value = 0.99;
    await monitor.checkMovers();
    expect(fetchReadings.mock.calls.map(([batch]) => batch.length)).toEqual([40, 5, 40, 5]);
    expect(alerts.map((alert) => alert.coin)).toEqual(coins);
  });

  it('reuses an in-flight scan and permits a fresh scan after it settles', async () => {
    let resolveFirst;
    const fetchReadings = vi.fn(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    const monitor = createCvdAlertMonitor({
      getMoverCoins: () => ['BTC'],
      fetchReadings,
      getIsConnected: () => true,
    });

    const first = monitor.checkMovers();
    const overlapping = monitor.checkMovers();
    expect(fetchReadings).toHaveBeenCalledTimes(1);

    resolveFirst({ readings: [{ coin: 'BTC', barTime: 1000, value: 0.5 }] });
    await Promise.all([first, overlapping]);

    fetchReadings.mockResolvedValueOnce({ readings: [{ coin: 'BTC', barTime: 2000, value: 0.6 }] });
    await monitor.checkMovers();
    expect(fetchReadings).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight guard after a failed scan so the next tick can retry', async () => {
    const fetchReadings = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ readings: [{ coin: 'BTC', barTime: 1000, value: 0.5 }] });
    const monitor = createCvdAlertMonitor({
      getMoverCoins: () => ['BTC'],
      fetchReadings,
      getIsConnected: () => true,
    });

    await expect(monitor.checkMovers()).rejects.toThrow('temporary failure');
    await expect(monitor.checkMovers()).resolves.toBeUndefined();
    expect(fetchReadings).toHaveBeenCalledTimes(2);
  });

  it('fires once on an up-cross at +0.98 and not again while it stays above', async () => {
    const h = makeHarness();
    await h.tick(0.5);   // first finite reading → baseline only
    expect(h.alerts).toHaveLength(0);

    await h.tick(0.99);  // crosses +0.98
    expect(h.alerts).toEqual([{ coin: 'BTC', direction: 'up', value: 0.99 }]);

    await h.tick(0.995); // still above → no re-fire
    expect(h.alerts).toHaveLength(1);
  });

  it('re-arms only after pulling back inside +0.50, then fires again', async () => {
    const h = makeHarness();
    await h.tick(0.5);
    await h.tick(0.99);
    expect(h.alerts).toHaveLength(1);

    await h.tick(0.7);   // inside hysteresis band but not re-armed yet
    await h.tick(0.99);
    expect(h.alerts).toHaveLength(1); // no re-arm above 0.50, so no new fire

    await h.tick(0.3);   // drops below 0.50 → re-arms
    await h.tick(0.99);
    expect(h.alerts).toHaveLength(2);
  });

  it('handles the -0.98 down-cross symmetrically', async () => {
    const h = makeHarness();
    await h.tick(-0.5);
    await h.tick(-0.99);
    expect(h.alerts).toEqual([{ coin: 'BTC', direction: 'down', value: -0.99 }]);

    await h.tick(-0.995);
    expect(h.alerts).toHaveLength(1);

    await h.tick(-0.3);  // re-arm
    await h.tick(-0.99);
    expect(h.alerts).toHaveLength(2);
  });

  it('does not fire for a coin already beyond ±0.98 on first observation', async () => {
    const h = makeHarness();
    await h.tick(0.99);  // first ever reading is already extreme → baseline, no fire
    expect(h.alerts).toHaveLength(0);

    await h.tick(0.995);
    expect(h.alerts).toHaveLength(0);

    await h.tick(0.3);   // re-enters band → re-arms
    await h.tick(0.99);  // genuine cross observed while watching
    expect(h.alerts).toHaveLength(1);
  });

  it('prunes state for coins that drop off the mover list', async () => {
    const h = makeHarness();
    await h.tick(0.5);   // BTC baseline armed

    h.setCoins([]);      // BTC leaves the list
    await h.tick(0.99);  // BTC pruned, not processed
    expect(h.alerts).toHaveLength(0);

    h.setCoins(['BTC']); // re-appears; first reading is already extreme
    await h.tick(0.99);  // fresh baseline suppresses the fire (proves prune reset state)
    expect(h.alerts).toHaveLength(0);
  });

  it('does not reapply a reading when the confirmed bar has not advanced', async () => {
    const h = makeHarness();
    await h.tick(0.5);

    await h.sameBar(0.99); // same confirmed bar → ignored despite a changed value
    expect(h.alerts).toHaveLength(0);

    await h.tick(0.99); // the same value on the next confirmed bar is a crossing
    expect(h.alerts).toHaveLength(1);
  });

  it('advances crossing state while muted but suppresses the alert (no replay on unmute)', async () => {
    const h = makeHarness();
    h.setMuted(true);
    await h.tick(0.5);
    await h.tick(0.99);  // crosses while muted → state advances, no alert
    expect(h.alerts).toHaveLength(0);

    h.setMuted(false);
    await h.tick(0.995); // already disarmed during mute → no replay
    expect(h.alerts).toHaveLength(0);

    await h.tick(0.3);   // re-arm
    await h.tick(0.99);  // fresh cross while unmuted → fires
    expect(h.alerts).toHaveLength(1);
  });

  it('does nothing while disconnected', async () => {
    const h = makeHarness();
    h.setConnected(false);
    await h.tick(0.99);
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(h.alerts).toHaveLength(0);
  });
});
