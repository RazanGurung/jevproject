/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('chart session state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('drives legacy loading mirrors from the canonical chart session', async () => {
    const { AppState } = await import('../store.js');
    const { beginChartSession, completeChartSession } = await import('../chart-session.js');

    beginChartSession({ coin: 'BTC', timeframe: '1m', requestToken: 'req-1' });
    expect(AppState.ui.chartSession).toEqual(expect.objectContaining({
      status: 'loading',
      coin: 'BTC',
      timeframe: '1m',
      requestToken: 'req-1',
    }));
    expect(AppState.ui.isLoadingChart).toBe(true);

    completeChartSession({ coin: 'BTC', timeframe: '1m', requestToken: 'req-1' });
    expect(AppState.ui.chartSession).toEqual(expect.objectContaining({
      status: 'ready',
      message: '',
    }));
    expect(AppState.ui.isLoadingChart).toBe(false);
  });

  it('does not let tokenless callers short-circuit an in-flight REST snapshot', async () => {
    const { AppState } = await import('../store.js');
    const { beginChartSession, completeChartSession } = await import('../chart-session.js');

    beginChartSession({ coin: 'ETH', timeframe: '4h', requestToken: 'req-live' });
    // A live candle tick arrives while the REST snapshot is still in flight.
    const applied = completeChartSession({ coin: 'ETH', timeframe: '4h' });
    expect(applied).toBe(false);
    expect(AppState.ui.chartSession.status).toBe('loading');
    expect(AppState.ui.isLoadingChart).toBe(true);

    // The REST .then that owns the token can still complete the session.
    completeChartSession({ coin: 'ETH', timeframe: '4h', requestToken: 'req-live' });
    expect(AppState.ui.chartSession.status).toBe('ready');

    // Once loading is over, tokenless completions are allowed again (no-op on ready).
    expect(completeChartSession({ coin: 'ETH', timeframe: '4h' })).toBe(true);
  });

  it('surfaces a notice on hard fetch failure instead of leaving the chart stuck loading', async () => {
    const { AppState } = await import('../store.js');
    const { beginChartSession, failChartSession } = await import('../chart-session.js');

    beginChartSession({ coin: 'SOL', timeframe: '1h', requestToken: 'req-fail' });
    failChartSession({
      coin: 'SOL',
      timeframe: '1h',
      requestToken: 'req-fail',
      message: 'Chart unavailable',
    });
    expect(AppState.ui.chartSession).toEqual(expect.objectContaining({
      status: 'notice',
      message: 'Chart unavailable',
    }));
    expect(AppState.ui.isLoadingChart).toBe(false);
    expect(AppState.ui.chartNotice).toBe('Chart unavailable');
  });

  it('preserves chart notices when legacy loading setters complete a failed session', async () => {
    const { AppState, setIsLoadingChart } = await import('../store.js');
    const { beginChartSession, setChartSessionNotice } = await import('../chart-session.js');

    beginChartSession({ coin: 'BTC', timeframe: '5m', requestToken: 'req-2' });
    setChartSessionNotice('No chart data', { coin: 'BTC', timeframe: '5m', requestToken: 'req-2' });
    setIsLoadingChart(false);

    expect(AppState.ui.chartSession).toEqual(expect.objectContaining({
      status: 'notice',
      message: 'No chart data',
    }));
    expect(AppState.ui.isLoadingChart).toBe(false);
    expect(AppState.ui.chartNotice).toBe('No chart data');
  });
});

describe('setCvdOscillatorLookback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts at the 90D default', async () => {
    const { AppState } = await import('../store.js');
    expect(AppState.ui.cvdOscillatorLookback).toBe('90D');
  });

  it('accepts the 20D option added alongside 3D/10D/30D/90D', async () => {
    const { AppState, setCvdOscillatorLookback } = await import('../store.js');
    setCvdOscillatorLookback('20D');
    expect(AppState.ui.cvdOscillatorLookback).toBe('20D');
  });

  it('ignores an invalid label, leaving the prior value in place', async () => {
    const { AppState, setCvdOscillatorLookback } = await import('../store.js');
    setCvdOscillatorLookback('30D');
    setCvdOscillatorLookback('7D');
    expect(AppState.ui.cvdOscillatorLookback).toBe('30D');
  });
});

describe('RVWAP lookbacks', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('accepts 365D as a centerline-only preset', async () => {
    const {
      AppState,
      RVWAP_LOOKBACKS,
      RVWAP_BAND_LOOKBACKS,
      setRvwapLookbackVisible,
      setRvwapBandsVisible,
    } = await import('../store.js');

    expect(RVWAP_LOOKBACKS).toEqual(['7D', '30D', '90D', '365D']);
    expect(RVWAP_BAND_LOOKBACKS).toEqual(['7D', '30D', '90D']);
    expect(AppState.ui.rvwapLookbacks).toEqual(['30D']);

    setRvwapLookbackVisible('7D', false);
    setRvwapLookbackVisible('30D', false);
    setRvwapLookbackVisible('90D', false);
    setRvwapLookbackVisible('365D', false);
    setRvwapBandsVisible('30D', false);
    expect(AppState.ui.rvwapLookbacks).toEqual([]);

    setRvwapLookbackVisible('365D', true);
    expect(AppState.ui.rvwapLookbacks).toEqual(['365D']);

    setRvwapBandsVisible('365D', true);
    expect(AppState.ui.rvwapBandLookbacks).toEqual([]);
  });
});

describe('candle cache eviction', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('evicts least-recently-written entries: a re-written key survives a background fill', async () => {
    const { candleCache, setCandleCacheEntry, MAX_CANDLE_CACHE_ENTRIES } = await import('../store.js');
    candleCache.clear();

    // The active chart's series lands first (oldest insertion position).
    setCandleCacheEntry('BTC:2h', [{ t: 1 }]);

    // A background sweep fills the cache to one below the cap.
    for (let i = 0; i < MAX_CANDLE_CACHE_ENTRIES - 1; i++) {
      setCandleCacheEntry(`COIN${i}:4h`, [{ t: i }]);
    }
    expect(candleCache.size).toBe(MAX_CANDLE_CACHE_ENTRIES);

    // A live tick re-writes the active series (delete-then-set moves it to the
    // back of the insertion order), then the sweep pushes past the cap.
    setCandleCacheEntry('BTC:2h', [{ t: 2 }]);
    setCandleCacheEntry('NEW:4h', [{ t: 99 }]);

    expect(candleCache.size).toBe(MAX_CANDLE_CACHE_ENTRIES);
    expect(candleCache.has('BTC:2h')).toBe(true);
    // The least-recently-written background entry was evicted instead.
    expect(candleCache.has('COIN0:4h')).toBe(false);
  });

  it('without a touch, overflow evicts from the front of the insertion order', async () => {
    const { candleCache, setCandleCacheEntry, MAX_CANDLE_CACHE_ENTRIES } = await import('../store.js');
    candleCache.clear();

    for (let i = 0; i <= MAX_CANDLE_CACHE_ENTRIES; i++) {
      setCandleCacheEntry(`COIN${i}:1h`, [{ t: i }]);
    }

    expect(candleCache.size).toBe(MAX_CANDLE_CACHE_ENTRIES);
    expect(candleCache.has('COIN0:1h')).toBe(false);
    expect(candleCache.has(`COIN${MAX_CANDLE_CACHE_ENTRIES}:1h`)).toBe(true);
  });

  it('protects active display and dedicated RVWAP sources from cache pressure', async () => {
    const {
      AppState,
      candleCache,
      rvwapSourceCache,
      rvwapSourceMetaCache,
      setCandleCacheEntry,
      setRvwapSourceCacheEntry,
      MAX_CANDLE_CACHE_ENTRIES,
      MAX_RVWAP_SOURCE_CACHE_ENTRIES,
    } = await import('../store.js');
    candleCache.clear();
    rvwapSourceCache.clear();
    rvwapSourceMetaCache.clear();
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentTimeframe = '2h';
    AppState.ui.rvwapLookbacks = ['90D'];

    setCandleCacheEntry('BTC:2h', [{ t: 1 }]);
    for (let i = 0; i < MAX_CANDLE_CACHE_ENTRIES; i++) {
      setCandleCacheEntry(`BACKGROUND${i}:1h`, [{ t: i + 10 }]);
    }
    setRvwapSourceCacheEntry('BTC', [{ t: 2 }], { coin: 'BTC', complete: true });
    for (let i = 0; i < MAX_RVWAP_SOURCE_CACHE_ENTRIES; i++) {
      setRvwapSourceCacheEntry(
        `SOURCE${i}`,
        [{ t: i + 20 }],
        { coin: `SOURCE${i}`, complete: true },
      );
    }

    expect(candleCache.size).toBe(MAX_CANDLE_CACHE_ENTRIES);
    expect(candleCache.has('BTC:2h')).toBe(true);
    expect(candleCache.has('BACKGROUND0:1h')).toBe(false);
    expect(rvwapSourceCache.size).toBe(MAX_RVWAP_SOURCE_CACHE_ENTRIES);
    expect(rvwapSourceCache.has('BTC')).toBe(true);
    expect(rvwapSourceCache.has('SOURCE0')).toBe(false);
    expect(rvwapSourceMetaCache.has('BTC')).toBe(true);
    expect(rvwapSourceMetaCache.has('SOURCE0')).toBe(false);
  });
});

describe('sessionVwap', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('toggles daily, weekly, and monthly session VWAP state correctly', async () => {
    const { AppState, setSessionVwapVisible } = await import('../store.js');
    expect(AppState.ui.sessionVwap).toEqual({ daily: false, weekly: false, monthly: false });

    setSessionVwapVisible('daily', true);
    expect(AppState.ui.sessionVwap.daily).toBe(true);
    expect(AppState.ui.sessionVwap.weekly).toBe(false);

    setSessionVwapVisible('weekly', true);
    expect(AppState.ui.sessionVwap.weekly).toBe(true);

    setSessionVwapVisible('monthly', 'true');
    expect(AppState.ui.sessionVwap.monthly).toBe(true);

    setSessionVwapVisible('daily', false);
    expect(AppState.ui.sessionVwap.daily).toBe(false);

    // Invalid period is safely ignored
    setSessionVwapVisible('invalid', true);
    expect(AppState.ui.sessionVwap.invalid).toBeUndefined();
  });
});

describe('volumeProfilePeriod and LVN state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts with volume profile period set to visible and LVN visible by default', async () => {
    const { AppState, INDICATOR_STARTUP_DEFAULTS } = await import('../store.js');
    expect(INDICATOR_STARTUP_DEFAULTS.volumeProfilePeriod).toBe('visible');
    expect(INDICATOR_STARTUP_DEFAULTS.volumeProfileLvnVisible).toBe(true);
    expect(AppState.ui.volumeProfilePeriod).toBe('visible');
    expect(AppState.ui.volumeProfileLvnVisible).toBe(true);
  });

  it('updates volume profile period and LVN visibility with setters', async () => {
    const { AppState, setVolumeProfilePeriod, setVolumeProfileLvnVisible } = await import('../store.js');
    setVolumeProfilePeriod('quarterly');
    expect(AppState.ui.volumeProfilePeriod).toBe('quarterly');

    setVolumeProfilePeriod('monthly');
    expect(AppState.ui.volumeProfilePeriod).toBe('monthly');

    setVolumeProfilePeriod('invalid');
    expect(AppState.ui.volumeProfilePeriod).toBe('visible');

    setVolumeProfileLvnVisible(false);
    expect(AppState.ui.volumeProfileLvnVisible).toBe(false);

    setVolumeProfileLvnVisible('true');
    expect(AppState.ui.volumeProfileLvnVisible).toBe(true);
  });
});


