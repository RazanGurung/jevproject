/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

const TEST_LINE_SERIES = Symbol('LineSeries');

function createTrackedOverlay() {
  const pane = {
    setStretchFactor: vi.fn(),
    setPreserveEmptyPane: vi.fn(),
  };
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    getPane: vi.fn(() => pane),
    createPriceLine: vi.fn(),
  };
  const outlineSeries = {
    setData: vi.fn(),
    update: vi.fn(),
  };
  const resetSeries = {
    setData: vi.fn(),
    update: vi.fn(),
  };

  let addCount = 0;
  const addSeries = vi.fn(() => [series, outlineSeries, resetSeries][addCount++ % 3]);
  const removeSeries = vi.fn();

  const chart = { addSeries, removeSeries };
  return { chart, addSeries, removeSeries, series, outlineSeries, resetSeries, pane };
}

function lastSetData(series) {
  return series.setData.mock.calls.at(-1)?.[0] || [];
}

describe('CVD math', () => {
  it('computes delta from the open/close direction', async () => {
    const { CVD } = await import('../cvd.js');
    // Up bars contribute +volume.
    const upBar = CVD.calculate([
      { t: 1700000000, o: 100, h: 110, l: 90, c: 101, v: 50 },
    ]);
    expect(upBar[0].value).toBeCloseTo(50, 9);

    // Down bars contribute -volume.
    const downBar = CVD.calculate([
      { t: 1700000000, o: 100, h: 110, l: 90, c: 99, v: 50 },
    ]);
    expect(downBar[0].value).toBeCloseTo(-50, 9);

    // Doji bars contribute 0.
    const doji = CVD.calculate([
      { t: 1700000000, o: 100, h: 110, l: 90, c: 100, v: 50 },
    ]);
    expect(doji[0].value).toBeCloseTo(0, 9);
  });

  it('matches reference CVD close values for directional bars', async () => {
    const { CVD } = await import('../cvd.js');
    const t0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const bars = [
      { t: t0, o: 100, h: 110, l: 90, c: 101, v: 10 },
      { t: t0 + 3600, o: 101, h: 112, l: 95, c: 99, v: 4 },
      { t: t0 + 7200, o: 99, h: 105, l: 95, c: 99, v: 7 },
    ];
    // Golden close-series from lightweight-charts-indicators calculateCVD
    // (anchor 1D) on this fixture — keeps the parity pin without vendoring
    // the ~1.8MB reference bundle into the workspace.
    const referenceCloses = [10, 6, 6];
    const local = CVD.calculate(bars, { anchorTimeframe: '1D' }).map((row) => row.value);
    expect(local).toEqual(referenceCloses);
  });

  it('emits zero delta on doji or zero-volume bars', async () => {
    const { CVD } = await import('../cvd.js');
    const flat = CVD.calculate([
      { t: 1700000000, o: 100, h: 100, l: 100, c: 100, v: 50 },
      { t: 1700000900, o: 100, h: 110, l: 90, c: 105, v: 0 },
    ]);
    expect(flat[0].value).toBe(0);
    expect(flat[1].value).toBe(0);
  });

  it('accumulates intraday deltas into a running cumulative value', async () => {
    const { CVD } = await import('../cvd.js');
    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const rows = CVD.calculate([
      // up bar contributes +10
      { t: day0,         o: 100, h: 110, l: 90,  c: 101, v: 10 },
      // doji contributes 0
      { t: day0 +  3600, o: 110, h: 120, l: 100, c: 110, v: 10 },
      // down bar contributes -10
      { t: day0 +  7200, o: 110, h: 120, l: 100, c: 109, v: 10 },
    ]);
    expect(rows.map((r) => r.value)).toEqual([10, 10, 0]);
  });

  it('resets the running total at each UTC daily anchor', async () => {
    const { CVD } = await import('../cvd.js');
    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const day1 = Math.floor(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000);
    const rows = CVD.calculate([
      { t: day0,         o: 100, h: 110, l: 90,  c: 110, v: 20 }, // +20
      { t: day0 + 3600,  o: 110, h: 120, l: 100, c: 120, v: 5  }, // +5  → cum 25
      { t: day1,         o: 120, h: 130, l: 110, c: 130, v: 8  }, // anchor → cum 8
      { t: day1 + 3600,  o: 130, h: 140, l: 120, c: 129, v: 4  }, // -4 → cum 4
    ]);
    expect(rows[1].value).toBeCloseTo(25, 9);
    expect(rows[2].isAnchor).toBe(true);
    expect(rows[2].value).toBeCloseTo(8, 9);
    expect(rows[3].value).toBeCloseTo(4, 9);
  });

  it('resets weekly CVD at the canonical Monday 00:00 UTC boundary', async () => {
    const { CVD } = await import('../cvd.js');
    const monday00 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const monday13 = monday00 + 13 * 3600;
    const monday14 = monday00 + 14 * 3600;
    const monday15 = monday00 + 15 * 3600;

    const rows = CVD.calculate([
      { t: monday00, o: 100, h: 110, l: 90, c: 110, v: 10 },
      { t: monday13, o: 110, h: 120, l: 100, c: 120, v: 10 },
      { t: monday14, o: 120, h: 130, l: 110, c: 130, v: 8 },
      { t: monday15, o: 130, h: 140, l: 120, c: 120, v: 4 },
    ], { anchorTimeframe: '1W-MON14' });

    // CVD resets cumDelta to zero at the canonical week boundary. The current
    // bar's delta is included in the emitted value — no data is lost.
    expect(rows[0]).toEqual(expect.objectContaining({
      time: monday00,
      value: 10,
      isAnchor: true,
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      time: monday13,
      value: 20,
      isAnchor: false,
    }));
    expect(rows[2]).toEqual(expect.objectContaining({
      time: monday14,
      value: 28,
      isAnchor: false,
    }));
    expect(rows[3].value).toBeCloseTo(24, 9);
    expect(rows[3].isAnchor).toBe(false);
  });


  it('supports a custom one-shot anchor timestamp for manual or visible-range CVD', async () => {
    const { CVD } = await import('../cvd.js');
    const t0 = Math.floor(Date.UTC(2024, 0, 3, 0, 0, 0) / 1000);
    const rows = CVD.calculate([
      { t: t0, o: 100, h: 110, l: 90, c: 110, v: 10 },
      { t: t0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5 },
      { t: t0 + 7200, o: 120, h: 130, l: 110, c: 110, v: 4 },
    ], {
      anchorTimeframe: 'CUSTOM',
      anchorStartTime: t0 + 3600,
    });

    expect(rows[0]).toEqual({ time: t0, whitespace: true });
    expect(rows[1]).toEqual(expect.objectContaining({
      time: t0 + 3600,
      value: 5,
      isAnchor: true,
    }));
    expect(rows[2].value).toBeCloseTo(1, 9);
  });

  it('strips helper flags before Lightweight Charts setData', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: 'CUSTOM',
      anchorStartTime: Math.floor(Date.UTC(2024, 0, 3, 1, 0, 0) / 1000),
    });
    const t0 = Math.floor(Date.UTC(2024, 0, 3, 0, 0, 0) / 1000);
    overlay.setCandles([
      { t: t0, o: 100, h: 110, l: 90, c: 110, v: 10 },
      { t: t0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5 },
    ], 'BTC', '4h');

    const rows = lastSetData(series);
    expect(rows[0]).toEqual({ time: t0 });
    expect(rows[1]).toEqual(expect.objectContaining({
      time: t0 + 3600,
      value: 5,
    }));
    expect(rows[1]).not.toHaveProperty('isAnchor');
    expect(rows[1]).not.toHaveProperty('whitespace');
  });

  it('accumulates continuously with no reset in CONTINUOUS anchor mode', async () => {
    const { CVD } = await import('../cvd.js');
    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const day1 = Math.floor(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000);
    const rows = CVD.calculate([
      { t: day0,        o: 100, h: 110, l: 90,  c: 110, v: 20 }, // +20
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5  }, // +5  → 25
      { t: day1,        o: 120, h: 130, l: 110, c: 130, v: 8  }, // +8  → 33 (no daily reset)
      { t: day1 + 3600, o: 130, h: 140, l: 120, c: 129, v: 4  }, // -4  → 29
    ], { anchorTimeframe: 'CONTINUOUS' });

    expect(rows[0].isAnchor).toBe(true); // first bar only
    expect(rows[1].value).toBeCloseTo(25, 9);
    expect(rows[2].isAnchor).toBe(false); // day boundary does NOT reset
    expect(rows[2].value).toBeCloseTo(33, 9);
    expect(rows[3].value).toBeCloseTo(29, 9);
  });

  it('treats a same-timestamp re-ingest as a replay (idempotent)', async () => {
    const { CVD } = await import('../cvd.js');
    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const runner = CVD.createState({ anchorTimeframe: '1D' });

    runner.ingest({ t: day0, o: 100, h: 110, l: 90, c: 110, v: 10 }); // +10
    runner.ingest({ t: day0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5 }); // +5 → 15

    // Replay the last bar with a different close → should overwrite, not stack.
    const replayed = runner.ingest({ t: day0 + 3600, o: 110, h: 120, l: 100, c: 109, v: 5 });
    expect(replayed.value).toBeCloseTo(5, 9); // 10 + (-5)

    // And a fresh ingest after replay continues from the rolled-back state.
    const next = runner.ingest({ t: day0 + 7200, o: 100, h: 110, l: 90, c: 110, v: 2 });
    expect(next.value).toBeCloseTo(7, 9); // 5 + 2
  });

  it('rejects out-of-order bars older than the last ingested', async () => {
    const { CVD } = await import('../cvd.js');
    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const runner = CVD.createState();
    runner.ingest({ t: day0 + 3600, o: 100, h: 110, l: 90, c: 110, v: 10 });
    const stale = runner.ingest({ t: day0, o: 100, h: 110, l: 90, c: 110, v: 10 });
    expect(stale).toBeNull();
  });

  it('ignores the high/low range when classifying directional delta', async () => {
    const { CVD } = await import('../cvd.js');
    const insideRangeDown = CVD.calculate([
      // Close is above the midpoint but below open, matching upstream
      // open/close direction instead of CLV high/low placement.
      { t: 1700000000, o: 108, h: 110, l: 90, c: 101, v: 50 },
    ]);
    expect(insideRangeDown[0].value).toBeCloseTo(-50, 9);
  });

  it('honors a custom palette in createState', async () => {
    const { CVD } = await import('../cvd.js');
    const palette = { positive: '#0f0', negative: '#f00', neutral: '#888' };
    const rows = CVD.calculate(
      [
        { t: 1700000000, o: 100, h: 110, l: 90, c: 110, v: 10 }, // +
        { t: 1700000900, o: 110, h: 120, l: 100, c: 100, v: 10 }, // -
        { t: 1700001800, o: 100, h: 110, l: 90,  c: 100, v: 10 }, // 0
      ],
      { palette },
    );
    expect(rows[0].color).toBe('#0f0');
    expect(rows[1].color).toBe('#f00');
    expect(rows[2].color).toBe('#888');
  });
});

describe('CVD overlay wiring', () => {
  it('stays unattached on 1w and 1M timeframes', async () => {
    const { addSeries, chart } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    overlay.setCandles([
      { t: 1713132000, o: 100, h: 110, l: 90, c: 110, v: 10 },
      { t: 1713218400, o: 110, h: 120, l: 100, c: 120, v: 12 },
    ], 'BTC', '1w');
    overlay.setCandles([
      { t: 1713132000, o: 100, h: 110, l: 90, c: 110, v: 10 },
    ], 'BTC', '1M');

    expect(addSeries).not.toHaveBeenCalled();
  });

  it('attaches CVD value, outline, and neutral zero-reset marker series in pane index 1', async () => {
    const { addSeries, chart, series, outlineSeries, resetSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const HistogramSeries = Symbol('HistogramSeries');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries,
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    overlay.setCandles([
      { t: 1713132000, o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: 1713135600, o: 110, h: 120, l: 100, c: 100, v: 10 },
      { t: 1713139200, o: 100, h: 105, l: 90, c: 95, v: 5 },
    ], 'BTC', '4h');

    expect(addSeries).toHaveBeenCalledTimes(3);
    const [seriesType, options, paneIndex] = addSeries.mock.calls[0];
    expect(seriesType).toBe(HistogramSeries);
    expect(paneIndex).toBe(1);
    expect(options.priceScaleId).toBe('cvd');
    expect(options.priceLineVisible).toBe(false);

    const [outlineType, outlineOptions, outlinePaneIndex] = addSeries.mock.calls[1];
    expect(outlineType).toBe(TEST_LINE_SERIES);
    expect(outlinePaneIndex).toBe(1);
    expect(outlineOptions).toEqual(expect.objectContaining({
      priceScaleId: 'cvd',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }));
    expect(outlineOptions.autoscaleInfoProvider()).toBeNull();

    const [resetType, resetOptions, resetPaneIndex] = addSeries.mock.calls[2];
    expect(resetType).toBe(TEST_LINE_SERIES);
    expect(resetPaneIndex).toBe(1);
    expect(resetOptions).toEqual(expect.objectContaining({
      priceScaleId: 'cvd',
      lineVisible: false,
      pointMarkersVisible: false,
      pointMarkersRadius: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }));
    expect(resetOptions.autoscaleInfoProvider()).toBeNull();

    const histogramRows = lastSetData(series);
    const outlinedRows = lastSetData(outlineSeries);
    expect(outlinedRows.map(({ time, value }) => ({ time, value }))).toEqual(
      histogramRows.map(({ time, value }) => ({ time, value })),
    );
    for (const row of histogramRows) {
      expect(row).not.toHaveProperty('isAnchor');
      expect(row).not.toHaveProperty('whitespace');
    }
    expect(outlinedRows.map((row) => row.color)).toEqual([
      'rgba(34,204,230,0.900)',
      'rgba(120,130,140,0.75)',
      'rgba(255,80,80,0.900)',
    ]);

    expect(lastSetData(resetSeries)).toEqual([
      expect.objectContaining({ time: 1713132000, value: 0 }),
      expect.objectContaining({ time: 1713139200, value: 0 }),
    ]);

    // Reset visibility is a neutral point series, not a persistent price line.
    expect(series.createPriceLine).not.toHaveBeenCalled();

    // The pane is scaled symmetrically around zero so the zero line stays centered.
    const symmetric = options.autoscaleInfoProvider(() => ({
      priceRange: { minValue: -3, maxValue: 12 },
      margins: { above: 0, below: 0 },
    }));
    expect(symmetric.priceRange).toEqual({ minValue: -12, maxValue: 12 });
  });

  it('defaults rendered CVD to the canonical Monday 00:00 UTC boundary', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
    });

    const monday00 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const monday14 = monday00 + 14 * 3600;
    overlay.setCandles([
      { t: monday00, o: 100, h: 110, l: 90, c: 110, v: 10 },
      { t: monday14, o: 110, h: 120, l: 100, c: 120, v: 5 },
    ], 'BTC', '4h');

    const rows = lastSetData(series);
    expect(rows[0]).toEqual(expect.objectContaining({
      time: monday00,
      value: 10,
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      time: monday14,
      value: 15,
    }));
    expect(rows[0]).not.toHaveProperty('isAnchor');
    expect(rows[1]).not.toHaveProperty('isAnchor');
    expect(overlay.getDebugState()).toEqual(expect.objectContaining({
      attached: true,
      rowCount: 2,
      lastTime: monday14,
      lastValue: 15,
      lastIsAnchor: false,
      resetCount: 1,
      lastResetTime: monday00,
      baselineVisible: true,
      anchorTimeframe: '1W-MON00',
      anchorStartTime: 0,
    }));
  });

  it('accepts the legacy weekly anchor alias but reports the canonical contract', async () => {
    const { chart, resetSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1W-MON14',
    });
    const monday00 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    overlay.setCandles([
      { t: monday00, o: 100, h: 110, l: 90, c: 110, v: 7 },
    ], 'BTC', '4h');

    expect(lastSetData(resetSeries)).toEqual([
      expect.objectContaining({ time: monday00, value: 0 }),
    ]);
    expect(overlay.getDebugState().anchorTimeframe).toBe('1W-MON00');
  });

  it('plots a zero marker on each observed UTC-week reset without dropping anchor flow', async () => {
    const { chart, series, resetSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
    });
    const sunday = Math.floor(Date.UTC(2023, 11, 31, 20, 0, 0) / 1000);
    const monday = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const nextMonday = monday + 7 * 86400;
    overlay.setCandles([
      { t: sunday, o: 100, c: 101, v: 2, cvdDelta: 2 },
      { t: monday, o: 101, c: 102, v: 7, cvdDelta: 7 },
      { t: monday + 3600, o: 102, c: 101, v: 3, cvdDelta: -3 },
      { t: nextMonday, o: 101, c: 103, v: 11, cvdDelta: 11 },
    ], 'BTC', '1h');

    expect(lastSetData(resetSeries).map(({ time, value }) => ({ time, value }))).toEqual([
      { time: sunday, value: 0 },
      { time: monday, value: 0 },
      { time: nextMonday, value: 0 },
    ]);
    const values = lastSetData(series);
    expect(values[1].value).toBe(7);
    expect(values[3].value).toBe(11);
    expect(overlay.getDebugState()).toEqual(expect.objectContaining({
      resetCount: 3,
      lastResetTime: nextMonday,
      baselineVisible: true,
    }));
  });

  it('uses the first available candle as the reset marker when a week is sparse', async () => {
    const { chart, resetSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
    });
    const wednesday = Math.floor(Date.UTC(2024, 0, 3, 8, 0, 0) / 1000);
    const nextTuesday = Math.floor(Date.UTC(2024, 0, 9, 8, 0, 0) / 1000);
    overlay.setCandles([
      { t: wednesday, o: 100, c: 101, v: 2 },
      { t: nextTuesday, o: 101, c: 102, v: 3 },
    ], 'xyz:SKHX', '1d');

    expect(lastSetData(resetSeries).map((row) => row.time)).toEqual([wednesday, nextTuesday]);
  });

  it('replays a same-time reset candle without duplicating marker state', async () => {
    const { chart, resetSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
    });
    const monday = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    overlay.setCandles([{ t: monday, o: 100, c: 101, v: 2 }], 'BTC', '1h');
    overlay.updateLast([{ t: monday, o: 100, c: 102, v: 9 }], 'BTC', '1h');

    expect(resetSeries.update).toHaveBeenCalledWith(expect.objectContaining({
      time: monday,
      value: 0,
    }));
    expect(overlay.getDebugState().resetCount).toBe(1);
  });


  it('visually boosts anchor reset bars without changing their value', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const day1 = Math.floor(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000);
    overlay.setCandles([
      { t: day0, o: 100, h: 110, l: 90, c: 110, v: 10 },
      { t: day1, o: 100, h: 110, l: 90, c: 110, v: 10 },
    ], 'BTC', '4h');

    const rows = lastSetData(series);
    const alphaOf = (color) => Number(color.match(/,([\d.]+)\)$/)[1]);
    expect(rows[0].value).toBe(10);
    expect(rows[1].value).toBe(10);
    expect(rows[0]).not.toHaveProperty('isAnchor');
    expect(rows[1]).not.toHaveProperty('isAnchor');
    // Anchor bars get the base histogram alpha plus the boost.
    expect(alphaOf(rows[1].color)).toBeCloseTo(0.45 + 0.08, 3);
  });

  it('feeds cumulative-delta rows with per-bar colors into the histogram', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    overlay.setCandles([
      { t: day0,        o: 100, h: 110, l: 90,  c: 110, v: 10 }, // +10
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 100, v: 10 }, // -10 → 0
    ], 'BTC', '4h');

    const rows = lastSetData(series);
    expect(rows).toHaveLength(2);
    expect(rows[0].time).toBe(day0);
    expect(rows[0].value).toBeCloseTo(10, 9);
    expect(rows[0].color).toMatch(/rgba\(/);
    expect(rows[1].value).toBeCloseTo(0, 9);
    expect(rows[1].color).not.toBe(rows[0].color); // sign flipped
  });

  it('dedupes and sorts candles before feeding the runner', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const t0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const t1 = t0 + 3600;
    overlay.setCandles([
      // duplicate t0 with different close — last one should win
      { t: t0, o: 100, h: 110, l: 90,  c: 100, v: 10 },
      { t: t1, o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: t0, o: 100, h: 110, l: 90,  c: 110, v: 10 },
    ], 'BTC', '4h');

    const rows = lastSetData(series);
    expect(rows.map((r) => r.time)).toEqual([t0, t1]);
    expect(rows[0].value).toBeCloseTo(10, 9);
    expect(rows[1].value).toBeCloseTo(20, 9);
  });

  it('renders CVD from supplied candle data without source', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    overlay.setCandles([
      { t: day0, o: 100, h: 110, l: 90, c: 90, v: 100 },
    ], 'BTC', '4h');

    const rows = lastSetData(series);
    expect(rows[0]).toEqual(expect.objectContaining({
      time: day0,
      value: -100,
    }));
  });

  it('detaches and reattaches when timeframe goes from 4h → 1w → 4h', async () => {
    const { addSeries, removeSeries, chart } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const candles = [
      { t: 1713132000, o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: 1713135600, o: 110, h: 120, l: 100, c: 100, v: 12 },
    ];

    overlay.setCandles(candles, 'BTC', '4h');
    expect(addSeries).toHaveBeenCalledTimes(3);

    overlay.setCandles(candles, 'BTC', '1w');
    expect(removeSeries).toHaveBeenCalledTimes(3);

    overlay.setCandles(candles, 'BTC', '4h');
    expect(addSeries).toHaveBeenCalledTimes(6);
  });

  it('detaches old series and reattaches fresh ones on coin change', async () => {
    const { addSeries, removeSeries, chart } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const candles = [
      { t: 1713132000, o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: 1713135600, o: 110, h: 120, l: 100, c: 100, v: 12 },
    ];

    overlay.setCandles(candles, 'BTC', '4h');
    expect(addSeries).toHaveBeenCalledTimes(3);

    overlay.setCandles(candles, 'ETH', '4h');
    expect(removeSeries).toHaveBeenCalledTimes(3);
    expect(addSeries).toHaveBeenCalledTimes(6);
  });

  it('does not leak cumulative or reset-marker state across repeated coin and timeframe churn', async () => {
    const { chart, series, resetSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
    });
    const monday = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const btc = [{ t: monday, o: 100, c: 101, v: 5, cvdDelta: 5 }];
    const eth = [{ t: monday + 7 * 86400, o: 200, c: 199, v: 9, cvdDelta: -9 }];

    overlay.setCandles(btc, 'BTC', '4h');
    overlay.setCandles(eth, 'ETH', '4h');
    overlay.setCandles(eth, 'ETH', '1w');
    overlay.setCandles(btc, 'BTC', '4h');
    overlay.setCandles(eth, 'ETH', '4h');
    overlay.setCandles(btc, 'BTC', '4h');

    expect(lastSetData(series)[0].value).toBe(5);
    expect(lastSetData(resetSeries)).toEqual([
      expect.objectContaining({ time: monday, value: 0 }),
    ]);
    expect(overlay.getDebugState()).toEqual(expect.objectContaining({
      resetCount: 1,
      lastResetTime: monday,
    }));
  });

  it('updates the rendered CVD tail when the latest exchange bar changes', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    const candles = [
      { t: day0,        o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 110, v: 5  },
    ];
    overlay.setCandles(candles, 'BTC', '4h');

    // Replay the last bar with a different close. The exchange's current
    // bucket is authoritative, so the visible tail must update in place.
    const replayCandles = [
      candles[0],
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 100, v: 5 },
    ];
    overlay.updateLast(replayCandles, 'BTC', '4h');
    expect(series.update).toHaveBeenCalledWith(expect.objectContaining({
      time: day0 + 3600,
      value: 5,
    }));
    expect(series.setData).toHaveBeenCalledTimes(1);
  });

  it('falls back to setCandles when updateLast hits a stale (coin, timeframe)', async () => {
    const { addSeries, chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const candles = [
      { t: 1713132000, o: 100, h: 110, l: 90,  c: 110, v: 10 },
    ];

    // No prior setCandles for this pair → updateLast should defer to a full
    // pass and call setData, not update.
    overlay.updateLast(candles, 'BTC', '4h');
    expect(addSeries).toHaveBeenCalledTimes(3);
    expect(series.setData).toHaveBeenCalled();
    expect(series.update).not.toHaveBeenCalled();
  });

  it('locks the initial pane stretch once and never reasserts it on subsequent syncs', async () => {
    const { chart, pane } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const candles = [
      { t: 1713132000, o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: 1713135600, o: 110, h: 120, l: 100, c: 100, v: 12 },
    ];

    overlay.setCandles(candles, 'BTC', '4h');
    expect(pane.setStretchFactor).toHaveBeenCalledTimes(1);
    const initialStretch = pane.setStretchFactor.mock.calls[0][0];
    expect(initialStretch).toBeGreaterThan(0);

    // Subsequent syncs (live updates, redraws) must not touch stretch — the
    // user may have dragged the separator and that drag must persist.
    overlay.setCandles(candles, 'BTC', '4h');
    overlay.updateLast(candles, 'BTC', '4h');
    overlay.setCandles(candles, 'BTC', '4h');
    expect(pane.setStretchFactor).toHaveBeenCalledTimes(1);
  });

  it('does not reset stretch on coin/timeframe-driven detach + reattach', async () => {
    const { chart, pane } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const candles = [
      { t: 1713132000, o: 100, h: 110, l: 90,  c: 110, v: 10 },
    ];

    overlay.setCandles(candles, 'BTC', '4h');
    expect(pane.setStretchFactor).toHaveBeenCalledTimes(1);

    // Coin change forces detach/reattach. Stretch must NOT be re-applied —
    // preserveEmptyPane keeps the user-dragged size alive.
    overlay.setCandles(candles, 'ETH', '4h');
    expect(pane.setStretchFactor).toHaveBeenCalledTimes(1);

    // Suppress (1w) then re-enable (4h): same rule.
    overlay.setCandles(candles, 'ETH', '1w');
    overlay.setCandles(candles, 'ETH', '4h');
    expect(pane.setStretchFactor).toHaveBeenCalledTimes(1);
  });

  it('uses the codebase blue/red palette regardless of theme', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);

    document.body.classList.remove('classic-theme');
    overlay.setCandles([
      { t: day0,        o: 100, h: 110, l: 90,  c: 110, v: 10 }, // +10 → blue
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 100, v: 10 }, // -10 → red
      { t: day0 + 7200, o: 100, h: 110, l: 100, c: 100, v: 30 }, //   0 → neutral
      { t: day0 + 10800, o: 110, h: 120, l: 100, c: 100, v: 1 }, //  -1 → red
    ], 'BTC', '4h');
    const defaultRows = lastSetData(series);
    expect(defaultRows[0].color).toMatch(/^rgba\(34,204,230,/);
    expect(defaultRows[3].color).toMatch(/^rgba\(255,80,80,/);

    document.body.classList.add('classic-theme');
    overlay.setCandles([
      { t: day0,        o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 100, v: 10 },
      { t: day0 + 7200, o: 100, h: 110, l: 100, c: 100, v: 30 },
      { t: day0 + 10800, o: 110, h: 120, l: 100, c: 100, v: 1 },
    ], 'BTC', '4h');
    const classicRows = lastSetData(series);
    expect(classicRows[0].color).toBe(defaultRows[0].color);
    expect(classicRows[3].color).toBe(defaultRows[3].color);

    document.body.classList.remove('classic-theme');
  });

  it('keeps bar alpha stable across different CVD magnitudes', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const day0 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);
    overlay.setCandles([
      { t: day0,        o: 100, h: 110, l: 90,  c: 110, v: 1   },
      { t: day0 + 3600, o: 100, h: 110, l: 90,  c: 110, v: 1   },
      { t: day0 + 7200, o: 110, h: 120, l: 100, c: 120, v: 99  },
    ], 'BTC', '4h');

    const rows = lastSetData(series);
    const alphaOf = (color) => Number(color.match(/,([\d.]+)\)$/)[1]);
    const smallAlpha = alphaOf(rows[1].color);
    const peakAlpha = alphaOf(rows[2].color);

    expect(peakAlpha).toBe(smallAlpha);
    expect(peakAlpha).toBeCloseTo(0.45, 3);
  });

  it('updates incrementally when only the current bucket CVD changes', async () => {
    const { chart, series, outlineSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const day0 = Math.floor(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000);
    const candles = [
      { t: day0,        o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5 },
    ];
    overlay.setCandles(candles, 'BTC', '4h');
    series.setData.mockClear();
    outlineSeries.setData.mockClear();

    overlay.updateLast([
      candles[0],
      { t: day0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 90 },
    ], 'BTC', '4h');

    expect(series.setData).not.toHaveBeenCalled();
    expect(series.update).toHaveBeenCalledWith(expect.objectContaining({
      time: day0 + 3600,
      value: 100,
    }));
    expect(series.update.mock.calls[0][0]).not.toHaveProperty('isAnchor');
    expect(series.update.mock.calls[0][0]).not.toHaveProperty('whitespace');
    expect(outlineSeries.setData).not.toHaveBeenCalled();
    expect(outlineSeries.update).toHaveBeenCalledWith(expect.objectContaining({
      time: day0 + 3600,
      value: 100,
    }));
  });

  it('removes an extra tail bar when an authoritative snapshot no longer contains it', async () => {
    const { chart, series, outlineSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const t0 = Math.floor(Date.UTC(2024, 0, 2, 0, 0, 0) / 1000);
    const candles = [
      { t: t0,      o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: t0 + 60, o: 110, h: 120, l: 100, c: 120, v: 5 },
    ];
    const projected = [
      ...candles,
      { t: t0 + 120, o: 120, h: 121, l: 120, c: 121, v: '0' },
    ];

    overlay.setCandles(candles, 'BTC', '1m');
    overlay.updateLast(projected, 'BTC', '1m');
    const projectedRow = series.update.mock.calls.at(-1)[0];
    const projectedOutline = outlineSeries.update.mock.calls.at(-1)[0];
    expect(projectedRow.time).toBe(t0 + 120);
    expect(projectedOutline).toEqual(expect.objectContaining({
      time: projectedRow.time,
      value: projectedRow.value,
    }));

    series.update.mockClear();
    series.setData.mockClear();
    outlineSeries.update.mockClear();
    outlineSeries.setData.mockClear();
    overlay.setCandles(candles, 'BTC', '1m');

    expect(series.setData).toHaveBeenCalledTimes(1);
    expect(series.update).not.toHaveBeenCalled();
    expect(lastSetData(series)).toHaveLength(2);
    expect(outlineSeries.setData).toHaveBeenCalledTimes(1);
    expect(outlineSeries.update).not.toHaveBeenCalled();
  });

  it('prefers the server cvdDelta over the directional fallback, per bar', async () => {
    const { CVD } = await import('../cvd.js');
    const t0 = Math.floor(Date.UTC(2024, 0, 3, 0, 0, 0) / 1000);
    const rows = CVD.calculate([
      // Server-enriched: composite delta wins over the +10 directional read.
      { t: t0,        o: 100, h: 110, l: 90,  c: 110, v: 10, cvdDelta: 3 },
      // Nil delta: falls back to the display-timeframe directional (+5).
      { t: t0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5, cvdDelta: null },
      // Enriched again: mixing continues within the same cumsum.
      { t: t0 + 7200, o: 120, h: 130, l: 110, c: 130, v: 8, cvdDelta: -2 },
    ], { anchorTimeframe: '1D' });
    expect(rows.map((r) => r.value)).toEqual([3, 8, 6]);
  });

  it('uses a server cvdDelta of 0 as zero, not as a missing value', async () => {
    const { CVD } = await import('../cvd.js');
    const t0 = Math.floor(Date.UTC(2024, 0, 3, 0, 0, 0) / 1000);
    const rows = CVD.calculate([
      // Directional fallback would read +10; the server's 0 must win.
      { t: t0, o: 100, h: 110, l: 90, c: 110, v: 10, cvdDelta: 0 },
    ], { anchorTimeframe: '1D' });
    expect(rows[0].value).toBe(0);
  });

  it('recomputes a same-time replay from the pre-bar state when the server delta changes', async () => {
    const { CVD } = await import('../cvd.js');
    const t0 = Math.floor(Date.UTC(2024, 0, 3, 0, 0, 0) / 1000);
    const runner = CVD.createState({ anchorTimeframe: '1D' });
    runner.ingest({ t: t0, o: 100, h: 110, l: 90, c: 110, v: 10, cvdDelta: 5 });
    runner.ingest({ t: t0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5, cvdDelta: 3 });
    // Live tick revises the same bucket's composite delta: overwrite, not stack.
    const replayed = runner.ingest({ t: t0 + 3600, o: 110, h: 120, l: 100, c: 121, v: 6, cvdDelta: 7 });
    expect(replayed.value).toBeCloseTo(12, 9); // 5 + 7
    // A tick that loses the delta (annotation declined) falls back cleanly.
    const fallback = runner.ingest({ t: t0 + 3600, o: 110, h: 120, l: 100, c: 108, v: 6 });
    expect(fallback.value).toBeCloseTo(-1, 9); // 5 + (-6)
  });

  it('resets the weekly anchor at the same wall-clock bar on every timeframe', async () => {
    const { CVD } = await import('../cvd.js');
    const sunday00 = Math.floor(Date.UTC(2023, 11, 31, 0, 0, 0) / 1000);
    const monday00 = Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000);

    // Server-enriched bars carrying 1 unit of composite delta per hour, so
    // every timeframe describes the same flow.
    const mkBars = (startS, stepS, count) => Array.from({ length: count }, (_, i) => ({
      t: startS + i * stepS,
      o: 100, h: 110, l: 90, c: 101, v: 1,
      cvdDelta: stepS / 3600,
    }));

    const series = {
      '1h': CVD.calculate(mkBars(sunday00, 3600, 48), { anchorTimeframe: '1W-MON14' }),
      '4h': CVD.calculate(mkBars(sunday00, 4 * 3600, 12), { anchorTimeframe: '1W-MON14' }),
      '1d': CVD.calculate(mkBars(sunday00, 24 * 3600, 2), { anchorTimeframe: '1W-MON14' }),
    };
    for (const [tf, rows] of Object.entries(series)) {
      // The only reset after the series head is the week boundary, and it
      // lands on the Monday 00:00 UTC bar on every timeframe.
      const anchors = rows.filter((r, i) => i > 0 && r.isAnchor);
      expect(anchors.map((r) => r.time), tf).toEqual([monday00]);
      // End-of-Monday cumulative is identical across timeframes: 24 units.
      expect(rows.at(-1).value, tf).toBeCloseTo(24, 9);
    }
  });

  it('pins the known cross-timeframe divergence of a custom mid-bar anchor', async () => {
    const { CVD } = await import('../cvd.js');
    const noon = Math.floor(Date.UTC(2024, 0, 3, 12, 0, 0) / 1000);
    const anchor14 = noon + 2 * 3600;

    const mkBars = (startS, stepS, count) => Array.from({ length: count }, (_, i) => ({
      t: startS + i * stepS,
      o: 100, h: 110, l: 90, c: 101, v: 1,
      cvdDelta: stepS / 3600,
    }));

    // 1h chart starts summing at the 14:00 bar; the 4h chart's first bar at
    // or after the anchor opens at 16:00, silently dropping the 14:00-16:00
    // flow. By 20:00 the two cumulatives differ by exactly those 2 units.
    const oneH = CVD.calculate(mkBars(noon, 3600, 8), {
      anchorTimeframe: 'CUSTOM', anchorStartTime: anchor14,
    });
    const fourH = CVD.calculate(mkBars(noon, 4 * 3600, 2), {
      anchorTimeframe: 'CUSTOM', anchorStartTime: anchor14,
    });

    expect(oneH.at(-1).value).toBeCloseTo(6, 9);  // 14:00..19:00 inclusive
    expect(fourH.at(-1).value).toBeCloseTo(4, 9); // 16:00 bar only
    expect(oneH.at(-1).value - fourH.at(-1).value).toBeCloseTo(2, 9);
  });

  it('rebuilds CVD rows when the overlay anchor changes', async () => {
    const { chart, series } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
      anchorTimeframe: '1D',
    });

    const t0 = Math.floor(Date.UTC(2024, 0, 3, 0, 0, 0) / 1000);
    const candles = [
      { t: t0,        o: 100, h: 110, l: 90,  c: 110, v: 10 },
      { t: t0 + 3600, o: 110, h: 120, l: 100, c: 120, v: 5 },
    ];

    overlay.setCandles(candles, 'BTC', '4h');
    expect(lastSetData(series)[0].value).toBeCloseTo(10, 9);
    overlay.setAnchor({ anchorTimeframe: 'CUSTOM', anchorStartTime: t0 + 3600 });

    const rebuiltRows = lastSetData(series);
    expect(rebuiltRows[0]).toEqual({ time: t0 });
    expect(rebuiltRows[1]).toEqual(expect.objectContaining({
      time: t0 + 3600,
      value: 5,
    }));
    expect(rebuiltRows[1]).not.toHaveProperty('isAnchor');
    expect(rebuiltRows[1]).not.toHaveProperty('whitespace');
  });

  it('rebuilds anchored CVD and weekly reset markers when a recovery fixes an interior delta without changing the span', async () => {
    const { chart, series, resetSeries } = createTrackedOverlay();
    const { createCvdOverlay } = await import('../cvd-indicators.js');
    const overlay = createCvdOverlay({
      getChart: () => chart,
      HistogramSeries: Symbol('HistogramSeries'),
      LineSeries: TEST_LINE_SERIES,
    });
    const t0 = Math.floor(Date.UTC(2024, 0, 3, 0, 0, 0) / 1000);
    const stale = [
      { t: t0, o: 100, h: 101, l: 99, c: 101, v: 10, cvdDelta: 2 },
      { t: t0 + 7200, o: 101, h: 102, l: 100, c: 102, v: 10, cvdDelta: null },
      { t: t0 + 14400, o: 102, h: 103, l: 101, c: 103, v: 10, cvdDelta: 3 },
    ];
    const repaired = stale.map((bar, index) => index === 1 ? { ...bar, cvdDelta: -4 } : bar);

    overlay.setCandles(stale, 'BTC', '2h', 10);
    const staleRows = lastSetData(series);
    overlay.setCandles(repaired, 'BTC', '2h', 11);
    const repairedRows = lastSetData(series);

    expect(series.setData).toHaveBeenCalledTimes(2);
    expect(resetSeries.setData).toHaveBeenCalledTimes(2);
    expect(lastSetData(resetSeries)).toEqual([
      expect.objectContaining({ time: t0, value: 0 }),
    ]);
    expect(repairedRows).toHaveLength(staleRows.length);
    expect(repairedRows.at(-1).value).toBeCloseTo(1, 9); // 2 - 4 + 3
    expect(repairedRows.at(-1).value).not.toBe(staleRows.at(-1).value);
  });

});
