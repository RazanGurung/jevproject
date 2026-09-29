/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const overlayMock = vi.hoisted(() => {
  let callback = null;
  let anchorsCallback = null;
  let selectionCallback = null;
  let projectionCallback = null;
  let weekPathCallback = null;
  let anchors = [];
  let selected = null;
  let selectedPoint = { x: 40, y: 50 };
  let dragging = false;
  return {
    setOptions: vi.fn(),
    setPlacementActive: vi.fn((active) => callback?.(active)),
    setOnPlacementChange: vi.fn((next) => { callback = next; }),
    setOnAnchorsChange: vi.fn((next) => { anchorsCallback = next; }),
    setOnSelectionChange: vi.fn((next) => { selectionCallback = next; }),
    setOnViewChange: vi.fn(),
    getSelectedAnchor: vi.fn(() => selected),
    getSelectedPoint: vi.fn(() => selectedPoint),
    isDragging: vi.fn(() => dragging),
    setAnchorOptions: vi.fn((id, options = {}) => {
      anchors = anchors.map((anchor) => anchor.id === id ? { ...anchor, ...options } : anchor);
      if (selected?.id === id) selected = { ...selected, ...options };
      anchorsCallback?.(anchors);
      selectionCallback?.(selected);
    }),
    drawingOverlay: { setActiveTool: vi.fn() },
    projectionOverlay: { setOnStatusChange: vi.fn((next) => { projectionCallback = next; }) },
    weekPathOverlay: { setOnStatusChange: vi.fn((next) => { weekPathCallback = next; }) },
    emitProjection(status) { projectionCallback?.(status); },
    emitWeekPath(status) { weekPathCallback?.(status); },
    emitAnchors(next) {
      anchors = Array.isArray(next) ? next : [];
      anchorsCallback?.(anchors);
    },
    emitSelection(next, point = { x: 40, y: 50 }) {
      selected = next || null;
      selectedPoint = point;
      dragging = false;
      selectionCallback?.(selected);
    },
    reset() {
      callback = null;
      anchorsCallback = null;
      selectionCallback = null;
      projectionCallback = null;
      weekPathCallback = null;
      anchors = [];
      selected = null;
      selectedPoint = { x: 40, y: 50 };
      dragging = false;
      this.setOptions.mockClear();
      this.setPlacementActive.mockClear();
      this.setOnPlacementChange.mockClear();
      this.setOnAnchorsChange.mockClear();
      this.setOnSelectionChange.mockClear();
      this.setOnViewChange.mockClear();
      this.getSelectedAnchor.mockClear();
      this.getSelectedPoint.mockClear();
      this.isDragging.mockClear();
      this.setAnchorOptions.mockClear();
      this.drawingOverlay.setActiveTool.mockClear();
      this.projectionOverlay.setOnStatusChange.mockClear();
      this.weekPathOverlay.setOnStatusChange.mockClear();
    },
  };
});

const volumeProfileMock = vi.hoisted(() => ({
  setPeriod: vi.fn(),
  setLvnVisible: vi.fn(),
  setCandles: vi.fn(),
  applyTheme: vi.fn(),
  detach: vi.fn(),
  getDebugState: vi.fn(),
}));

const sessionVwapMock = vi.hoisted(() => ({
  setOptions: vi.fn(),
  setCandles: vi.fn(),
  updateLast: vi.fn(),
  applyTheme: vi.fn(),
  detach: vi.fn(),
  getDebugState: vi.fn(),
}));

const liquidationClustersMock = vi.hoisted(() => ({
  setOptions: vi.fn(),
  updateLiquidations: vi.fn(),
  applyTheme: vi.fn(),
  detach: vi.fn(),
  getDebugState: vi.fn(),
}));

const whaleMarkersMock = vi.hoisted(() => ({
  setOptions: vi.fn(),
  updateWhaleTrades: vi.fn(),
  applyTheme: vi.fn(),
  detach: vi.fn(),
  getDebugState: vi.fn(),
}));

vi.mock('../../chart/lightweight-chart.js', () => ({
  manualAnchoredVwapOverlay: overlayMock,
  sessionVwapOverlay: sessionVwapMock,
  drawingToolsOverlay: overlayMock.drawingOverlay,
  monthlyVolumeProfileOverlay: volumeProfileMock,
  liquidationClustersOverlay: liquidationClustersMock,
  whaleMarkersOverlay: whaleMarkersMock,
  priceProjectionOverlay: overlayMock.projectionOverlay,
  weekPathProjectionOverlay: overlayMock.weekPathOverlay,
  syncJevSignalLines: vi.fn(),
}));
vi.mock('../../chart/chart-render.js', () => ({ scheduleChartRender: vi.fn() }));
vi.mock('../../services/cvd-alert-monitor.js', () => ({
  isCvdAlertsMuted: () => false,
  setCvdAlertsMuted: vi.fn(),
}));

import { AppState } from '../../state/store.js';
import {
  addManualAnchoredVwap,
  initIndicatorUI,
  onToggleMonthlyVolumeProfile,
  onChangeVolumeProfilePeriod,
  onToggleVolumeProfileLvn,
  onToggleManualAnchoredVwap,
  onToggleSessionVwap,
  onToggleManualAnchoredVwapBands,
  onChangeManualAnchoredVwapSigma,
  onToggleLiquidationClusters,
  onToggleJevSignals,
  onToggleWhaleMarkers,
  onChangeWhaleMarkerMin,
  onToggleRvwap,
  onToggleRvwapBands,
  onTogglePriceProjection,
  onToggleWeekPathProjection,
  onToggleWeekPathEnvelope,
  onChangeCvdOscillatorLookback,
} from '../chart-indicator-ui.js';
import { resetPopoverControllerForTests } from '../popover-controller.js';

beforeEach(() => {
  overlayMock.reset();
  volumeProfileMock.setPeriod.mockClear();
  volumeProfileMock.setLvnVisible.mockClear();
  whaleMarkersMock.setOptions.mockClear();
  resetPopoverControllerForTests();
  document.body.innerHTML = `
    <button id="indicatorsToggleBtn"></button><div id="indicatorsPanel"></div>
    <input id="monthlyVolumeProfileCheck" type="checkbox"><input id="cvdAlertsCheck" type="checkbox">
    <select id="volumeProfilePeriodSelect"><option value="visible">Visible range</option><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option></select>
    <input id="volumeProfileLvnCheck" type="checkbox">
    <input id="liquidationClustersCheck" type="checkbox">
    <input id="jevSignalsCheck" type="checkbox">
    <input id="whaleMarkersCheck" type="checkbox">
    <select id="whaleMarkerMinSelect"><option value="100000">≥$100k</option><option value="250000">≥$250k</option><option value="500000">≥$500k</option><option value="1000000">≥$1M</option></select>
    <input id="rvwap7dCheck" type="checkbox"><input id="rvwap30dCheck" type="checkbox">
    <input id="rvwap90dCheck" type="checkbox"><input id="rvwap365dCheck" type="checkbox">
    <input id="rvwap7dBandsCheck" type="checkbox"><input id="rvwap30dBandsCheck" type="checkbox">
    <input id="rvwap90dBandsCheck" type="checkbox">
    <select id="cvdOscillatorLookbackSelect"><option value="30D">30D</option><option value="90D">90D</option></select>
    <div id="chartWrap"></div>
    <input id="manualAnchoredVwapCheck" type="checkbox">
    <input id="sessionVwapDailyCheck" type="checkbox">
    <input id="sessionVwapWeeklyCheck" type="checkbox">
    <input id="sessionVwapMonthlyCheck" type="checkbox">
    <input id="priceProjectionCheck" type="checkbox">
    <div id="priceProjectionStatus"></div>
    <input id="weekPathProjectionCheck" type="checkbox">
    <input id="weekPathEnvelopeCheck" type="checkbox" checked>
    <div id="weekPathProjectionStatus"></div>
    <button id="manualAnchoredVwapAddBtn"></button><span id="manualAnchoredVwapHint"></span>
  `;
  initIndicatorUI();
});

describe('rolling VWAP indicator controls', () => {
  it('starts with 30D enabled with bands, anchors enabled, without volume profile', () => {
    expect(AppState.ui.rvwapLookbacks).toEqual(['30D']);
    expect(document.getElementById('rvwap7dCheck').checked).toBe(false);
    expect(document.getElementById('rvwap30dCheck').checked).toBe(true);
    expect(document.getElementById('rvwap90dCheck').checked).toBe(false);
    expect(document.getElementById('rvwap365dCheck').checked).toBe(false);
    expect(AppState.ui.rvwapBandLookbacks).toEqual(['30D']);
    expect(document.getElementById('rvwap7dBandsCheck').checked).toBe(false);
    expect(document.getElementById('rvwap30dBandsCheck').checked).toBe(true);
    expect(document.getElementById('rvwap90dBandsCheck').checked).toBe(false);
    expect(document.getElementById('rvwap365dBandsCheck')).toBeNull();
    expect(AppState.ui.monthlyVolumeProfileVisible).toBe(false);
    expect(document.getElementById('monthlyVolumeProfileCheck').checked).toBe(false);
    expect(AppState.ui.volumeProfilePeriod).toBe('visible');
    expect(document.getElementById('volumeProfilePeriodSelect').value).toBe('visible');
    expect(AppState.ui.volumeProfileLvnVisible).toBe(true);
    expect(document.getElementById('volumeProfileLvnCheck').checked).toBe(true);
    expect(AppState.ui.cvdOscillatorLookback).toBe('90D');
    expect(document.getElementById('cvdOscillatorLookbackSelect').value).toBe('90D');
  });

  it('starts with volume profile period set to visible and toggles between visible, quarterly, and monthly', () => {
    expect(AppState.ui.volumeProfilePeriod).toBe('visible');
    expect(document.getElementById('volumeProfilePeriodSelect').value).toBe('visible');

    onChangeVolumeProfilePeriod({ value: 'monthly' });
    expect(AppState.ui.volumeProfilePeriod).toBe('monthly');
    expect(document.getElementById('volumeProfilePeriodSelect').value).toBe('monthly');
    expect(volumeProfileMock.setPeriod).toHaveBeenCalledWith('monthly');

    onChangeVolumeProfilePeriod({ value: 'quarterly' });
    expect(AppState.ui.volumeProfilePeriod).toBe('quarterly');
    expect(document.getElementById('volumeProfilePeriodSelect').value).toBe('quarterly');
    expect(volumeProfileMock.setPeriod).toHaveBeenCalledWith('quarterly');

    onChangeVolumeProfilePeriod({ value: 'visible' });
    expect(AppState.ui.volumeProfilePeriod).toBe('visible');
    expect(document.getElementById('volumeProfilePeriodSelect').value).toBe('visible');
    expect(volumeProfileMock.setPeriod).toHaveBeenCalledWith('visible');
  });

  it('toggles volume profile LVN boxes', () => {
    expect(AppState.ui.volumeProfileLvnVisible).toBe(true);
    expect(document.getElementById('volumeProfileLvnCheck').checked).toBe(true);

    onToggleVolumeProfileLvn({ checked: false });
    expect(AppState.ui.volumeProfileLvnVisible).toBe(false);
    expect(document.getElementById('volumeProfileLvnCheck').checked).toBe(false);
    expect(volumeProfileMock.setLvnVisible).toHaveBeenCalledWith(false);

    onToggleVolumeProfileLvn({ checked: true });
    expect(AppState.ui.volumeProfileLvnVisible).toBe(true);
    expect(document.getElementById('volumeProfileLvnCheck').checked).toBe(true);
    expect(volumeProfileMock.setLvnVisible).toHaveBeenCalledWith(true);
  });

  it('starts with Liquidation Clusters off and toggles it', () => {
    expect(AppState.ui.liquidationClustersVisible).toBe(false);
    expect(document.getElementById('liquidationClustersCheck').checked).toBe(false);

    onToggleLiquidationClusters({ checked: true });
    expect(AppState.ui.liquidationClustersVisible).toBe(true);
    expect(document.getElementById('liquidationClustersCheck').checked).toBe(true);

    onToggleLiquidationClusters({ checked: false });
    expect(AppState.ui.liquidationClustersVisible).toBe(false);
    expect(document.getElementById('liquidationClustersCheck').checked).toBe(false);
  });

  it('starts with Jev Signal Targets off and toggles it', () => {
    expect(AppState.ui.jevSignalsVisible).toBe(false);
    expect(document.getElementById('jevSignalsCheck').checked).toBe(false);

    onToggleJevSignals({ checked: true });
    expect(AppState.ui.jevSignalsVisible).toBe(true);
    expect(document.getElementById('jevSignalsCheck').checked).toBe(true);

    onToggleJevSignals({ checked: false });
    expect(AppState.ui.jevSignalsVisible).toBe(false);
    expect(document.getElementById('jevSignalsCheck').checked).toBe(false);
  });

  it('starts with Whale Markers off and toggles it and its min notional filter', () => {
    expect(AppState.ui.whaleMarkersVisible).toBe(false);
    expect(AppState.ui.whaleMarkerMinNotional).toBe(100000);
    expect(document.getElementById('whaleMarkersCheck').checked).toBe(false);
    expect(document.getElementById('whaleMarkerMinSelect').value).toBe('100000');

    onToggleWhaleMarkers({ checked: true });
    expect(AppState.ui.whaleMarkersVisible).toBe(true);
    expect(document.getElementById('whaleMarkersCheck').checked).toBe(true);
    expect(whaleMarkersMock.setOptions).toHaveBeenCalledWith({ visible: true });

    onChangeWhaleMarkerMin({ value: '500000' });
    expect(AppState.ui.whaleMarkerMinNotional).toBe(500000);
    expect(document.getElementById('whaleMarkerMinSelect').value).toBe('500000');
    expect(whaleMarkersMock.setOptions).toHaveBeenCalledWith({ minNotional: 500000 });

    onToggleWhaleMarkers({ checked: false });
    expect(AppState.ui.whaleMarkersVisible).toBe(false);
    expect(document.getElementById('whaleMarkersCheck').checked).toBe(false);
    expect(whaleMarkersMock.setOptions).toHaveBeenCalledWith({ visible: false });
  });

  it('persists selected CVD oscillator lookback on AppState', () => {
    onChangeCvdOscillatorLookback({ value: '30D' });
    expect(AppState.ui.cvdOscillatorLookback).toBe('30D');

    onChangeCvdOscillatorLookback({ value: '90D' });
    expect(AppState.ui.cvdOscillatorLookback).toBe('90D');
  });

  it('toggles several presets independently and supports hiding all of them', () => {
    onToggleRvwap('7D', { checked: false });
    onToggleRvwap('30D', { checked: false });
    onToggleRvwap('90D', { checked: false });
    onToggleRvwap('365D', { checked: false });
    expect(AppState.ui.rvwapLookbacks).toEqual([]);

    onToggleRvwap('7D', { checked: true });
    onToggleRvwap('90D', { checked: true });
    expect(AppState.ui.rvwapLookbacks).toEqual(['7D', '90D']);

    onToggleRvwap('7D', { checked: false });
    onToggleRvwap('90D', { checked: false });
    expect(AppState.ui.rvwapLookbacks).toEqual([]);
  });

  it('ignores unsupported lookbacks', () => {
    onToggleRvwap('14D', { checked: true });
    expect(AppState.ui.rvwapLookbacks).toEqual(['30D']);
  });

  it('toggles 365D independently and rejects a bands request for it', () => {
    onToggleRvwap('30D', { checked: false });
    onToggleRvwap('365D', { checked: true });
    expect(AppState.ui.rvwapLookbacks).toEqual(['365D']);

    onToggleRvwapBands('365D', { checked: true });
    expect(AppState.ui.rvwapBandLookbacks).toEqual(['30D']);

    onToggleRvwap('365D', { checked: false });
    expect(AppState.ui.rvwapLookbacks).toEqual([]);
  });

  it('remembers every preset band preference independently of line visibility', () => {
    onToggleRvwap('7D', { checked: false });
    onToggleRvwap('30D', { checked: false });
    onToggleRvwap('90D', { checked: false });
    onToggleRvwap('365D', { checked: false });
    expect(AppState.ui.rvwapLookbacks).toEqual([]);

    onToggleRvwapBands('7D', { checked: true });
    onToggleRvwapBands('30D', { checked: true });
    expect(AppState.ui.rvwapLookbacks).toEqual([]);
    expect(AppState.ui.rvwapBandLookbacks).toEqual(['7D', '30D']);

    onToggleRvwap('7D', { checked: true });
    expect(AppState.ui.rvwapLookbacks).toEqual(['7D']);
    expect(AppState.ui.rvwapBandLookbacks).toEqual(['7D', '30D']);

    onToggleRvwapBands('14D', { checked: true });
    expect(AppState.ui.rvwapBandLookbacks).toEqual(['7D', '30D']);
  });
});

describe('price projection indicator controls', () => {
  it('starts disabled and reports UTC-month research status', () => {
    expect(AppState.ui.priceProjectionVisible).toBe(false);
    expect(document.getElementById('priceProjectionCheck').checked).toBe(false);
    expect(document.getElementById('priceProjectionHorizonSelect')).toBeNull();
    expect(document.getElementById('priceProjectionStatus').textContent).toBe('Off');

    onTogglePriceProjection({ checked: true });
    expect(AppState.ui.priceProjectionVisible).toBe(true);
    expect(document.getElementById('priceProjectionStatus').textContent)
      .toBe('Calculating from closed candles…');

    overlayMock.emitProjection({
      status: 'ready',
      evidenceStatus: 'unvalidated',
      monthCount: 4,
      monthStart: Date.UTC(2026, 7, 1) / 1000,
      horizonDays: 31,
      analogueUpFrequency: 0.61,
      weightEffectiveSampleSize: 27.8,
      clusterEffectiveSampleSize: 14.2,
      drawnMonthCount: 1,
      calibration: { coverage50: 0.48, coverage80: 0.79, maeSkillVsZero: -0.039 },
    });
    expect(document.getElementById('priceProjectionStatus').textContent)
      .toBe('Research · Aug 2026 · 31d · UpFreq 61% · wESS 28 · cESS 14 · MAE skill -4% · BT50 48% · BT80 79%');
    expect(document.getElementById('priceProjectionStatus').title)
      .toContain('Unvalidated UTC-month occupancy map');
    expect(document.getElementById('priceProjectionStatus').title)
      .toContain('UTC open');
    expect(document.getElementById('priceProjectionStatus').title)
      .toContain('Elapsed month-to-date squares stay faint');
    expect(document.getElementById('priceProjectionStatus').title)
      .not.toMatch(/Dashed line|Solid line/);

    overlayMock.emitProjection({
      status: 'ready',
      evidenceStatus: 'unvalidated',
      monthCount: 4,
      monthStart: Date.UTC(2026, 7, 1) / 1000,
      originMode: 'month-open-live',
      horizonDays: 31,
      analogueUpFrequency: 0.61,
      weightEffectiveSampleSize: 27.8,
      clusterEffectiveSampleSize: 14.2,
      calibration: { coverage50: 0.48, coverage80: 0.79, maeSkillVsZero: -0.039 },
    });
    expect(document.getElementById('priceProjectionStatus').textContent)
      .toContain('31d from open');

    overlayMock.emitProjection({
      status: 'ready',
      evidenceStatus: 'unvalidated',
      monthCount: 4,
      monthStart: Date.UTC(2026, 7, 1) / 1000,
      horizonDays: 31,
      analogueUpFrequency: 0.61,
      weightEffectiveSampleSize: 27.8,
      clusterEffectiveSampleSize: 14.2,
      calibration: {
        coverage50: 0.48,
        coverage80: 0.79,
        maeSkillVsZero: -0.039,
        aciAdjusted: true,
        factor50PreAci: 1,
        factor80PreAci: 1,
        factor50Drawn: 1.2,
        factor80Drawn: 1.15,
      },
    });
    expect(document.getElementById('priceProjectionStatus').textContent)
      .toContain('drawn×1.20');
  });
});

describe('2-week path projection indicator controls', () => {
  it('starts off with envelope default on', () => {
    expect(AppState.ui.weekPathProjectionVisible).toBe(false);
    expect(AppState.ui.weekPathEnvelopeVisible).toBe(true);
    expect(document.getElementById('weekPathProjectionCheck').checked).toBe(false);
    expect(document.getElementById('weekPathEnvelopeCheck').checked).toBe(true);
    expect(document.getElementById('weekPathProjectionStatus').textContent).toBe('Off');

    onToggleWeekPathProjection({ checked: true });
    expect(AppState.ui.weekPathProjectionVisible).toBe(true);
    expect(document.getElementById('weekPathProjectionStatus').textContent)
      .toBe('Calculating from closed candles…');

    overlayMock.emitWeekPath({
      status: 'ready',
      evidenceStatus: 'unvalidated',
      remainingDays: 10,
      remainingBars: 120,
      weekFractionElapsed: 0.29,
      analogueUpFrequency: 0.52,
      calibration: { coverage50: 0.49, coverage80: 0.81 },
    });
    expect(document.getElementById('weekPathProjectionStatus').textContent)
      .toContain('Research');
    expect(document.getElementById('weekPathProjectionStatus').textContent)
      .toContain('~10d left');
    expect(document.getElementById('weekPathProjectionStatus').textContent)
      .toContain('horizon 29%');
    expect(document.getElementById('weekPathProjectionStatus').textContent)
      .toContain('BT50 49%');
    expect(document.getElementById('weekPathProjectionStatus').title)
      .toContain('two weeks');

    onToggleWeekPathEnvelope({ checked: false });
    expect(AppState.ui.weekPathEnvelopeVisible).toBe(false);
  });
});

describe('manual anchored VWAP indicator controls', () => {
  it('starts visible with anchors enabled, without IND bands or sigma controls', () => {
    expect(AppState.ui.manualAnchoredVwapVisible).toBe(true);
    expect(document.getElementById('manualAnchoredVwapCheck').checked).toBe(true);
    expect(document.getElementById('manualAnchoredVwapList')).toBeNull();
    expect(document.getElementById('manualAnchoredVwapBandsCheck')).toBeNull();
    expect(document.getElementById('manualAnchoredVwapSigmaSelect')).toBeNull();
  });

  it('arms one placement, enables visibility, and reflects completion', () => {
    addManualAnchoredVwap();
    expect(overlayMock.drawingOverlay.setActiveTool).toHaveBeenCalledWith(null);
    expect(AppState.ui.manualAnchoredVwapVisible).toBe(true);
    expect(AppState.ui.manualAnchoredVwapPlacementActive).toBe(true);
    expect(document.getElementById('manualAnchoredVwapAddBtn').classList.contains('tool-armed')).toBe(true);
    expect(document.getElementById('manualAnchoredVwapHint').textContent).toBe('Click chart');

    overlayMock.setPlacementActive(false);
    expect(AppState.ui.manualAnchoredVwapPlacementActive).toBe(false);
    expect(document.getElementById('manualAnchoredVwapHint').textContent).toBe('');
  });

  it('does not record persisted anchors in IND; bands and sigma stay on the chart origin', () => {
    overlayMock.emitAnchors([
      { id: 'avwap_a', time: Date.UTC(2026, 7, 25, 14, 0) / 1000, bandsVisible: false, sigma: 2 },
      { id: 'avwap_b', time: Date.UTC(2026, 7, 25, 16, 30) / 1000, bandsVisible: true, sigma: 3 },
    ]);
    expect(document.querySelectorAll('.avwap-row')).toHaveLength(0);
    expect(document.getElementById('manualAnchoredVwapList')).toBeNull();
    expect(document.getElementById('manualAnchoredVwapBandsCheck-avwap_a')).toBeNull();
    expect(document.getElementById('manualAnchoredVwapSigmaSelect-avwap_a')).toBeNull();

    onToggleManualAnchoredVwap({ checked: true });
    onToggleManualAnchoredVwapBands('avwap_a', { checked: true });
    onChangeManualAnchoredVwapSigma('avwap_b', { value: '1' });
    expect(AppState.ui.manualAnchoredVwapVisible).toBe(true);
    expect(overlayMock.setAnchorOptions).toHaveBeenCalledWith('avwap_a', { bandsVisible: true });
    expect(overlayMock.setAnchorOptions).toHaveBeenCalledWith('avwap_b', { sigma: '1' });
  });

  it('shows Bands and sigma next to the selected origin marker', () => {
    overlayMock.emitSelection({
      id: 'avwap_a',
      time: Date.UTC(2026, 7, 25, 14, 0) / 1000,
      bandsVisible: false,
      sigma: 2,
    });
    const editor = document.querySelector('.avwap-anchor-editor');
    expect(editor).toBeTruthy();
    expect(editor.style.display).toBe('flex');
    const bands = editor.querySelector('[data-change-action="onToggleManualAnchoredVwapBands"]');
    const sigma = editor.querySelector('[data-change-action="onChangeManualAnchoredVwapSigma"]');
    expect(bands.checked).toBe(false);
    expect(bands.dataset.arg).toBe('avwap_a');
    expect(sigma.value).toBe('2');

    const options = Array.from(sigma.querySelectorAll('option')).map((opt) => opt.value);
    expect(options).toEqual(['1', '2', '3', '4']);

    onToggleManualAnchoredVwapBands('avwap_a', { checked: true });
    onChangeManualAnchoredVwapSigma('avwap_a', { value: '3' });
    expect(bands.checked).toBe(true);
    expect(sigma.value).toBe('3');

    onChangeManualAnchoredVwapSigma('avwap_a', { value: '4' });
    expect(sigma.value).toBe('4');

    overlayMock.emitSelection(null);
    expect(editor.style.display).toBe('none');
  });
});

describe('session VWAP indicator controls', () => {
  it('starts with session VWAPs disabled by default', () => {
    expect(AppState.ui.sessionVwap).toEqual({ daily: false, weekly: false, monthly: false });
    expect(document.getElementById('sessionVwapDailyCheck').checked).toBe(false);
    expect(document.getElementById('sessionVwapWeeklyCheck').checked).toBe(false);
    expect(document.getElementById('sessionVwapMonthlyCheck').checked).toBe(false);
  });

  it('updates AppState and checkboxes when toggled', () => {
    onToggleSessionVwap('daily', { checked: true });
    expect(AppState.ui.sessionVwap.daily).toBe(true);
    expect(document.getElementById('sessionVwapDailyCheck').checked).toBe(true);

    onToggleSessionVwap('weekly', { checked: true });
    expect(AppState.ui.sessionVwap.weekly).toBe(true);
    expect(document.getElementById('sessionVwapWeeklyCheck').checked).toBe(true);

    onToggleSessionVwap('monthly', { checked: true });
    expect(AppState.ui.sessionVwap.monthly).toBe(true);
    expect(document.getElementById('sessionVwapMonthlyCheck').checked).toBe(true);

    onToggleSessionVwap('daily', { checked: false });
    expect(AppState.ui.sessionVwap.daily).toBe(false);
    expect(document.getElementById('sessionVwapDailyCheck').checked).toBe(false);
  });
});

