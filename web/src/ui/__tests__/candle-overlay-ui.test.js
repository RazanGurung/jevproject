/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const overlayMock = vi.hoisted(() => {
  let opts = {};
  return {
    setOptions: vi.fn((next) => { opts = { ...opts, ...next }; }),
    setCandles: vi.fn(),
    detach: vi.fn(),
    getOptions: () => opts,
    reset() {
      opts = {};
      this.setOptions.mockClear();
      this.setCandles.mockClear();
      this.detach.mockClear();
    },
  };
});

vi.mock('../../chart/lightweight-chart.js', () => ({
  candleOverlay: overlayMock,
}));

const coreMock = vi.hoisted(() => ({
  applyThemeIfNeeded: vi.fn(),
}));

vi.mock('../../chart/lightweight-chart-core.js', () => ({
  applyThemeIfNeeded: coreMock.applyThemeIfNeeded,
}));

const renderMock = vi.hoisted(() => ({
  scheduleChartRender: vi.fn(),
}));

vi.mock('../../chart/chart-render.js', () => ({
  scheduleChartRender: renderMock.scheduleChartRender,
}));

import {
  initCandleOverlayUI,
  toggleCandleOverlay,
  onToggleDimAllOverlays,
  selectCandleOverlayMode,
  onChangeCandleOverlayBaseCandles,
  onInputCandleOverlayContrast,
  onChangeCandleOverlayContrast,
  onToggleHeikinAshiDimmed,
  onInputHeikinAshiOpacity,
  onChangeHeikinAshiOpacity,
  onToggleHeikinAshiWicks,
  onToggleRenkoDimmed,
  onInputRenkoOpacity,
  onChangeRenkoOpacity,
  onChangeRenkoBrickMode,
  onInputRenkoFixedSize,
  onToggleRenkoWicks,
  syncCandleOverlayUI,
} from '../candle-overlay-ui.js';
import { AppState, INDICATOR_STARTUP_DEFAULTS, setCandleOverlayMode } from '../../state/store.js';

describe('candle-overlay-ui', () => {
  beforeEach(() => {
    overlayMock.reset();
    coreMock.applyThemeIfNeeded.mockClear();
    renderMock.scheduleChartRender.mockClear();
    AppState.ui.candleOverlay = {
      mode: 'off',
      baseCandles: INDICATOR_STARTUP_DEFAULTS.candleOverlay.baseCandles,
      contrast: INDICATOR_STARTUP_DEFAULTS.candleOverlay.contrast,
      heikinAshi: { ...INDICATOR_STARTUP_DEFAULTS.candleOverlay.heikinAshi },
      renko: { ...INDICATOR_STARTUP_DEFAULTS.candleOverlay.renko },
    };
    setCandleOverlayMode('off');

    document.body.innerHTML = `
      <button class="ctrl-btn" id="candleOverlayToggleBtn" data-action="toggleCandleOverlay" aria-expanded="false">
        <span id="candleOverlayToggleLabel">Overlay</span>
      </button>

      <div id="candleOverlayPanel" style="display:none;">
        <button type="button" class="ctrl-btn candle-overlay-dim-all-btn" id="candleOverlayDimAllBtn" data-action="onToggleDimAllOverlays">Dim all</button>
        <div class="candle-overlay-mode-selector">
          <button type="button" class="candle-overlay-mode-btn active" data-action="selectCandleOverlayMode" data-arg="off">Off</button>
          <button type="button" class="candle-overlay-mode-btn" data-action="selectCandleOverlayMode" data-arg="heikin-ashi">Heikin Ashi</button>
          <button type="button" class="candle-overlay-mode-btn" data-action="selectCandleOverlayMode" data-arg="renko">Renko</button>
          <button type="button" class="candle-overlay-mode-btn" data-action="selectCandleOverlayMode" data-arg="both">Both</button>
        </div>

        <section id="candleOverlayBaseCandlesSection" style="display:none;">
          <input type="radio" id="candleBaseDimmedRadio" name="candleBaseAppearance" value="dimmed" checked>
          <div id="candleOverlayContrastRow">
            <input type="range" id="candleOverlayContrastSlider" min="10" max="80" step="5" value="50">
            <span id="candleOverlayContrastVal">50%</span>
          </div>
          <input type="radio" id="candleBaseHiddenRadio" name="candleBaseAppearance" value="hidden">
          <input type="radio" id="candleBaseNormalRadio" name="candleBaseAppearance" value="normal">
        </section>

        <section id="heikinAshiSettingsSection" style="display:none;">
          <input type="checkbox" id="heikinAshiDimmedCheck">
          <div id="heikinAshiDimmedRow">
            <input type="range" id="heikinAshiOpacitySlider" min="10" max="80" step="5" value="50">
            <span id="heikinAshiOpacityVal">50%</span>
          </div>
          <input type="checkbox" id="heikinAshiWicksCheck" checked>
        </section>

        <section id="renkoSettingsSection" style="display:none;">
          <input type="checkbox" id="renkoDimmedCheck" checked>
          <div id="renkoDimmedRow">
            <input type="range" id="renkoOpacitySlider" min="10" max="80" step="5" value="50">
            <span id="renkoOpacityVal">50%</span>
          </div>
          <select id="renkoBrickModeSelect">
            <option value="atr">Auto (ATR 14)</option>
            <option value="0.1%">0.1%</option>
            <option value="0.25%">0.25%</option>
            <option value="0.5%">0.5%</option>
            <option value="1.0%">1.0%</option>
            <option value="fixed">Fixed USD</option>
          </select>
          <div id="renkoFixedSizeRow" style="display:none;">
            <input type="number" id="renkoFixedSizeInput">
          </div>
          <input type="checkbox" id="renkoWicksCheck">
        </section>
      </div>
    `;
  });

  it('initializes with default off state and syncs button label', () => {
    initCandleOverlayUI();
    const label = document.getElementById('candleOverlayToggleLabel');
    expect(label.textContent).toBe('Overlay');
    expect(document.getElementById('candleOverlayToggleBtn').classList.contains('has-overlay')).toBe(false);
  });

  it('switches to heikin-ashi mode and updates UI and overlay options', () => {
    selectCandleOverlayMode('heikin-ashi');

    expect(AppState.ui.candleOverlay.mode).toBe('heikin-ashi');
    expect(AppState.ui.candleOverlay.baseCandles).toBe('dimmed');
    expect(overlayMock.setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'heikin-ashi', baseCandles: 'dimmed', contrast: 0.5 }),
    );

    const label = document.getElementById('candleOverlayToggleLabel');
    expect(label.textContent).toBe('Overlay: HA');

    const btn = document.getElementById('candleOverlayToggleBtn');
    expect(btn.classList.contains('has-overlay')).toBe(true);

    const haSection = document.getElementById('heikinAshiSettingsSection');
    const renkoSection = document.getElementById('renkoSettingsSection');
    const baseSection = document.getElementById('candleOverlayBaseCandlesSection');
    expect(haSection.style.display).toBe('');
    expect(renkoSection.style.display).toBe('none');
    expect(baseSection.style.display).toBe('');

    expect(coreMock.applyThemeIfNeeded).toHaveBeenCalled();
  });

  it('switches to renko mode and updates UI and overlay options', () => {
    selectCandleOverlayMode('renko');

    expect(AppState.ui.candleOverlay.mode).toBe('renko');
    expect(AppState.ui.candleOverlay.baseCandles).toBe('dimmed');
    expect(overlayMock.setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'renko', baseCandles: 'dimmed', contrast: 0.5 }),
    );

    const label = document.getElementById('candleOverlayToggleLabel');
    expect(label.textContent).toBe('Overlay: Renko');

    const btn = document.getElementById('candleOverlayToggleBtn');
    expect(btn.classList.contains('has-overlay')).toBe(true);

    const haSection = document.getElementById('heikinAshiSettingsSection');
    const renkoSection = document.getElementById('renkoSettingsSection');
    expect(haSection.style.display).toBe('none');
    expect(renkoSection.style.display).toBe('');
  });

  it('switches to both mode and displays both Heikin Ashi and Renko sections', () => {
    selectCandleOverlayMode('both');

    expect(AppState.ui.candleOverlay.mode).toBe('both');
    expect(AppState.ui.candleOverlay.baseCandles).toBe('dimmed');
    expect(overlayMock.setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'both', baseCandles: 'dimmed', contrast: 0.5 }),
    );

    const label = document.getElementById('candleOverlayToggleLabel');
    expect(label.textContent).toBe('Overlay: Both');

    const btn = document.getElementById('candleOverlayToggleBtn');
    expect(btn.classList.contains('has-overlay')).toBe(true);

    const haSection = document.getElementById('heikinAshiSettingsSection');
    const renkoSection = document.getElementById('renkoSettingsSection');
    const baseSection = document.getElementById('candleOverlayBaseCandlesSection');
    expect(haSection.style.display).toBe('');
    expect(renkoSection.style.display).toBe('');
    expect(baseSection.style.display).toBe('');
  });

  it('toggles base candle appearance between dimmed, hidden, normal', () => {
    selectCandleOverlayMode('heikin-ashi');

    onChangeCandleOverlayBaseCandles('hidden', { value: 'hidden' });
    expect(AppState.ui.candleOverlay.baseCandles).toBe('hidden');
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ baseCandles: 'hidden', contrast: 0.5 });

    const hiddenRadio = document.getElementById('candleBaseHiddenRadio');
    expect(hiddenRadio.checked).toBe(true);

    onChangeCandleOverlayBaseCandles('normal', { value: 'normal' });
    expect(AppState.ui.candleOverlay.baseCandles).toBe('normal');
  });

  it('adjusts candle overlay contrast and updates theme and slider badge', () => {
    selectCandleOverlayMode('heikin-ashi');

    onInputCandleOverlayContrast({ value: '50' });
    expect(AppState.ui.candleOverlay.contrast).toBe(0.5);
    expect(AppState.ui.candleOverlay.baseCandles).toBe('dimmed');
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ baseCandles: 'dimmed', contrast: 0.5 });

    const valBadge = document.getElementById('candleOverlayContrastVal');
    expect(valBadge.textContent).toBe('50%');

    const slider = document.getElementById('candleOverlayContrastSlider');
    expect(slider.value).toBe('50');

    onChangeCandleOverlayContrast({ value: '25' });
    expect(AppState.ui.candleOverlay.contrast).toBe(0.25);
    expect(valBadge.textContent).toBe('25%');
  });

  it('toggles Heikin Ashi dimmed state and opacity slider', () => {
    selectCandleOverlayMode('both');

    onToggleHeikinAshiDimmed({ checked: true });
    expect(AppState.ui.candleOverlay.heikinAshi.dimmed).toBe(true);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ heikinAshi: { dimmed: true } });

    onInputHeikinAshiOpacity({ value: '35' });
    expect(AppState.ui.candleOverlay.heikinAshi.opacity).toBe(0.35);
    expect(AppState.ui.candleOverlay.heikinAshi.dimmed).toBe(true);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ heikinAshi: { opacity: 0.35, dimmed: true } });

    const valBadge = document.getElementById('heikinAshiOpacityVal');
    expect(valBadge.textContent).toBe('35%');

    onToggleHeikinAshiDimmed({ checked: false });
    expect(AppState.ui.candleOverlay.heikinAshi.dimmed).toBe(false);
  });

  it('toggles Renko dimmed state and opacity slider', () => {
    selectCandleOverlayMode('both');

    onToggleRenkoDimmed({ checked: true });
    expect(AppState.ui.candleOverlay.renko.dimmed).toBe(true);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ renko: { dimmed: true } });

    onInputRenkoOpacity({ value: '40' });
    expect(AppState.ui.candleOverlay.renko.opacity).toBe(0.4);
    expect(AppState.ui.candleOverlay.renko.dimmed).toBe(true);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ renko: { opacity: 0.4, dimmed: true } });

    const valBadge = document.getElementById('renkoOpacityVal');
    expect(valBadge.textContent).toBe('40%');

    onToggleRenkoDimmed({ checked: false });
    expect(AppState.ui.candleOverlay.renko.dimmed).toBe(false);
  });

  it('toggles dim all overlays at once', () => {
    selectCandleOverlayMode('both');
    // Initially base is dimmed, HA not dimmed, Renko dimmed by default
    expect(AppState.ui.candleOverlay.heikinAshi.dimmed).toBe(false);
    expect(AppState.ui.candleOverlay.renko.dimmed).toBe(true);

    onToggleDimAllOverlays();
    expect(AppState.ui.candleOverlay.baseCandles).toBe('dimmed');
    expect(AppState.ui.candleOverlay.heikinAshi.dimmed).toBe(true);
    expect(AppState.ui.candleOverlay.renko.dimmed).toBe(true);

    const dimAllBtn = document.getElementById('candleOverlayDimAllBtn');
    expect(dimAllBtn.classList.contains('active')).toBe(true);
    expect(dimAllBtn.textContent).toBe('Undim all');

    // Click again: un-dims all
    onToggleDimAllOverlays();
    expect(AppState.ui.candleOverlay.baseCandles).toBe('normal');
    expect(AppState.ui.candleOverlay.heikinAshi.dimmed).toBe(false);
    expect(AppState.ui.candleOverlay.renko.dimmed).toBe(false);
    expect(dimAllBtn.classList.contains('active')).toBe(false);
    expect(dimAllBtn.textContent).toBe('Dim all');
  });

  it('updates Heikin Ashi wicks option', () => {
    selectCandleOverlayMode('heikin-ashi');

    onToggleHeikinAshiWicks({ checked: false });
    expect(AppState.ui.candleOverlay.heikinAshi.showWicks).toBe(false);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ heikinAshi: { showWicks: false } });

    onToggleHeikinAshiWicks({ checked: true });
    expect(AppState.ui.candleOverlay.heikinAshi.showWicks).toBe(true);
  });

  it('updates Renko brick mode and displays fixed input when mode is fixed', () => {
    selectCandleOverlayMode('renko');

    onChangeRenkoBrickMode({ value: '0.25%' });
    expect(AppState.ui.candleOverlay.renko.brickMode).toBe('percent');
    expect(AppState.ui.candleOverlay.renko.percent).toBe(0.25);

    const fixedRow = document.getElementById('renkoFixedSizeRow');
    expect(fixedRow.style.display).toBe('none');

    onChangeRenkoBrickMode({ value: 'fixed' });
    expect(AppState.ui.candleOverlay.renko.brickMode).toBe('fixed');
    expect(fixedRow.style.display).toBe('');

    onInputRenkoFixedSize({ value: '50' });
    expect(AppState.ui.candleOverlay.renko.fixedSize).toBe(50);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ renko: { fixedSize: 50, brickMode: 'fixed' } });
  });

  it('updates Renko wicks option', () => {
    selectCandleOverlayMode('renko');

    onToggleRenkoWicks({ checked: true });
    expect(AppState.ui.candleOverlay.renko.showWicks).toBe(true);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ renko: { showWicks: true } });

    onToggleRenkoWicks({ checked: false });
    expect(AppState.ui.candleOverlay.renko.showWicks).toBe(false);
    expect(overlayMock.setOptions).toHaveBeenCalledWith({ renko: { showWicks: false } });
  });

  it('opens and closes popover via toggleCandleOverlay', () => {
    const btn = document.getElementById('candleOverlayToggleBtn');
    toggleCandleOverlay(btn);
    expect(AppState.ui.candleOverlayPanelVisible).toBe(true);
    expect(btn.classList.contains('active')).toBe(true);

    toggleCandleOverlay(btn);
    expect(AppState.ui.candleOverlayPanelVisible).toBe(false);
  });

  it('correctly selects matching option in renkoBrickModeSelect for percent mode', () => {
    selectCandleOverlayMode('renko');
    onChangeRenkoBrickMode({ value: '0.5%' });

    expect(AppState.ui.candleOverlay.renko.brickMode).toBe('percent');
    expect(AppState.ui.candleOverlay.renko.percent).toBe(0.5);

    const select = document.getElementById('renkoBrickModeSelect');
    expect(select.value).toBe('0.5%');

    // Test 1.0% option matching
    onChangeRenkoBrickMode({ value: '1.0%' });
    expect(AppState.ui.candleOverlay.renko.brickMode).toBe('percent');
    expect(AppState.ui.candleOverlay.renko.percent).toBe(1.0);
    expect(select.value).toBe('1.0%');
  });
});
