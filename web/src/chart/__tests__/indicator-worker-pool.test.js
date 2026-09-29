/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateVolumeProfilesAsync,
  calculateHeikinAshiAsync,
  calculateRenkoBricksAsync,
  getIndicatorWorkerStats,
  terminateIndicatorWorker,
} from '../indicator-worker-pool.js';
import {
  computeVolumeProfilesPure,
  computeHeikinAshiPure,
  computeRenkoBricksPure,
} from '../indicator-worker-code.js';

const sampleCandles = [
  { t: 1700000000, o: 100, h: 105, l: 95, c: 102, v: 50 },
  { t: 1700003600, o: 102, h: 108, l: 101, c: 107, v: 75 },
  { t: 1700007200, o: 107, h: 110, l: 104, c: 105, v: 60 },
  { t: 1700010800, o: 105, h: 106, l: 98, c: 99, v: 90 },
  { t: 1700014400, o: 99, h: 103, l: 97, c: 101, v: 40 },
  { t: 1700018000, o: 101, h: 104, l: 100, c: 103, v: 55 },
];

describe('indicator-worker pure calculations', () => {
  it('computes volume profiles with correct structure', () => {
    const profiles = computeVolumeProfilesPure(sampleCandles, { bins: 10, minBars: 3 });
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.length).toBeGreaterThan(0);
    const p = profiles[0];
    expect(p).toHaveProperty('pocPrice');
    expect(p).toHaveProperty('lo');
    expect(p).toHaveProperty('hi');
    expect(p).toHaveProperty('bins');
    expect(p.bins.length).toBeGreaterThan(0);
    expect(p.hi).toBeGreaterThanOrEqual(p.lo);
  });

  it('computes canonical Heikin Ashi series', () => {
    const ha = computeHeikinAshiPure(sampleCandles);
    expect(ha).toHaveLength(sampleCandles.length);
    expect(ha[0].time).toBe(1700000000);
    // First bar haOpen = (100 + 102) / 2 = 101
    expect(ha[0].open).toBe(101);
    // First bar haClose = (100 + 105 + 95 + 102) / 4 = 100.5
    expect(ha[0].close).toBe(100.5);
    expect(ha[0].high).toBe(105);
    expect(ha[0].low).toBe(95);
  });

  it('computes Renko bricks with fixed brick size', () => {
    const renko = computeRenkoBricksPure(sampleCandles, { brickMode: 'fixed', fixedSize: 2 });
    expect(renko).toHaveProperty('bricks');
    expect(renko).toHaveProperty('brickSize', 2);
    expect(renko.bricks.length).toBeGreaterThan(0);
    for (const b of renko.bricks) {
      expect(Math.abs(b.close - b.open)).toBeCloseTo(2, 4);
    }
  });
});

describe('indicator-worker-pool asynchronous execution', () => {
  beforeEach(() => {
    terminateIndicatorWorker();
  });

  it('falls back to synchronous execution in environments without native Worker', async () => {
    const profiles = await calculateVolumeProfilesAsync(sampleCandles, { bins: 10, minBars: 3 });
    expect(profiles).not.toBeNull();
    expect(profiles.length).toBeGreaterThan(0);

    const stats = getIndicatorWorkerStats();
    expect(stats.totalJobs).toBeGreaterThan(0);
    expect(stats.fallbackJobs).toBeGreaterThan(0);
  });

  it('computes Heikin Ashi asynchronously', async () => {
    const ha = await calculateHeikinAshiAsync(sampleCandles);
    expect(ha).toHaveLength(sampleCandles.length);
    expect(ha[1].open).toBeDefined();
    expect(ha[1].close).toBeDefined();
  });

  it('computes Renko bricks asynchronously', async () => {
    const renko = await calculateRenkoBricksAsync(sampleCandles, { brickMode: 'fixed', fixedSize: 2 });
    expect(renko.bricks).toBeDefined();
    expect(renko.brickSize).toBe(2);
  });

  it('terminates worker cleanly', () => {
    terminateIndicatorWorker();
    const stats = getIndicatorWorkerStats();
    expect(stats.workerActive).toBe(false);
  });
});
