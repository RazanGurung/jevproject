/**
 * Candle Overlay UI Controller
 *
 * Manages the header overlay dropdown menu and controls for:
 *   - Heikin Ashi candle canvas overlay
 *   - Renko bricks canvas overlay
 *   - Base candle appearance (Dimmed, Hidden, Normal)
 */

import {
  AppState,
  setCandleOverlayMode,
  setCandleOverlayBaseCandles,
  setCandleOverlayContrast,
  setCandleOverlayHeikinAshiOptions,
  setCandleOverlayRenkoOptions,
  setCandleOverlayPanelVisible,
} from '../state/store.js';
import { closePopover, isPopoverOpen, positionPopover, togglePopover } from './popover-controller.js';
import { candleOverlay } from '../chart/lightweight-chart.js';
import { applyThemeIfNeeded } from '../chart/lightweight-chart-core.js';
import { scheduleChartRender } from '../chart/chart-render.js';
import { selectClosedCandles } from '../state/market-candles.js';

function syncCandleOverlayButton() {
  const btn = document.getElementById('candleOverlayToggleBtn');
  if (!btn) return;
  const open = isPopoverOpen('candleOverlay');
  const mode = AppState.ui.candleOverlay?.mode || 'off';
  const hasOverlay = mode !== 'off';

  btn.classList.toggle('active', open || hasOverlay);
  btn.classList.toggle('has-overlay', hasOverlay);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');

  const label = document.getElementById('candleOverlayToggleLabel');
  if (label) {
    if (mode === 'heikin-ashi') {
      label.textContent = 'Overlay: HA';
    } else if (mode === 'renko') {
      label.textContent = 'Overlay: Renko';
    } else if (mode === 'both') {
      label.textContent = 'Overlay: Both';
    } else {
      label.textContent = 'Overlay';
    }
  }
}

function positionCandleOverlayPanel() {
  const panel = document.getElementById('candleOverlayPanel');
  const btn = document.getElementById('candleOverlayToggleBtn');
  if (!panel || !btn) return;
  positionPopover(panel, btn, { minWidth: 280, scrollable: true });
}

export function syncCandleOverlayUI() {
  const overlay = AppState.ui.candleOverlay || {};
  const mode = overlay.mode || 'off';
  const baseCandles = overlay.baseCandles || 'dimmed';
  const heikinAshi = overlay.heikinAshi || {};
  const renko = overlay.renko || {};

  // 1. Mode radio buttons
  document.querySelectorAll('.candle-overlay-mode-btn').forEach((btn) => {
    const isSelected = btn.dataset.arg === mode;
    btn.classList.toggle('active', isSelected);
    btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
  });

  // 2. Base candles radios & contrast slider
  const dimmedRadio = document.getElementById('candleBaseDimmedRadio');
  const hiddenRadio = document.getElementById('candleBaseHiddenRadio');
  const normalRadio = document.getElementById('candleBaseNormalRadio');
  if (dimmedRadio) dimmedRadio.checked = baseCandles === 'dimmed';
  if (hiddenRadio) hiddenRadio.checked = baseCandles === 'hidden';
  if (normalRadio) normalRadio.checked = baseCandles === 'normal';

  const contrastSlider = document.getElementById('candleOverlayContrastSlider');
  const contrastVal = document.getElementById('candleOverlayContrastVal');
  const contrastRow = document.getElementById('candleOverlayContrastRow');
  const contrastPct = Math.round((Number(overlay.contrast) || 0.5) * 100);
  if (contrastSlider) contrastSlider.value = String(contrastPct);
  if (contrastVal) contrastVal.textContent = `${contrastPct}%`;
  if (contrastRow) {
    contrastRow.style.opacity = baseCandles === 'dimmed' ? '1' : '0.45';
  }

  // 3. Subsections visibility
  const haSection = document.getElementById('heikinAshiSettingsSection');
  const renkoSection = document.getElementById('renkoSettingsSection');
  const baseSection = document.getElementById('candleOverlayBaseCandlesSection');

  if (haSection) haSection.style.display = (mode === 'heikin-ashi' || mode === 'both') ? '' : 'none';
  if (renkoSection) renkoSection.style.display = (mode === 'renko' || mode === 'both') ? '' : 'none';
  if (baseSection) baseSection.style.display = mode !== 'off' ? '' : 'none';

  // 4. Heikin Ashi options
  const haDimmedCheck = document.getElementById('heikinAshiDimmedCheck');
  if (haDimmedCheck) haDimmedCheck.checked = heikinAshi.dimmed === true;

  const haOpacitySlider = document.getElementById('heikinAshiOpacitySlider');
  const haOpacityVal = document.getElementById('heikinAshiOpacityVal');
  const haDimmedRow = document.getElementById('heikinAshiDimmedRow');
  const haOpacityPct = Math.round((Number(heikinAshi.opacity) || 0.5) * 100);
  if (haOpacitySlider) haOpacitySlider.value = String(haOpacityPct);
  if (haOpacityVal) haOpacityVal.textContent = `${haOpacityPct}%`;
  if (haDimmedRow) {
    haDimmedRow.style.opacity = heikinAshi.dimmed ? '1' : '0.45';
  }

  const haWicksCheck = document.getElementById('heikinAshiWicksCheck');
  if (haWicksCheck) haWicksCheck.checked = heikinAshi.showWicks !== false;

  // 5. Renko options
  const renkoDimmedCheck = document.getElementById('renkoDimmedCheck');
  if (renkoDimmedCheck) renkoDimmedCheck.checked = renko.dimmed === true;

  const renkoOpacitySlider = document.getElementById('renkoOpacitySlider');
  const renkoOpacityVal = document.getElementById('renkoOpacityVal');
  const renkoDimmedRow = document.getElementById('renkoDimmedRow');
  const renkoOpacityPct = Math.round((Number(renko.opacity) || 0.5) * 100);
  if (renkoOpacitySlider) renkoOpacitySlider.value = String(renkoOpacityPct);
  if (renkoOpacityVal) renkoOpacityVal.textContent = `${renkoOpacityPct}%`;
  if (renkoDimmedRow) {
    renkoDimmedRow.style.opacity = renko.dimmed ? '1' : '0.45';
  }

  const renkoModeSelect = document.getElementById('renkoBrickModeSelect');
  if (renkoModeSelect) {
    if (renko.brickMode === 'percent') {
      const pct = Number(renko.percent) || 0.25;
      const targetVal = `${pct}%`;
      let matched = false;
      if (renkoModeSelect.options) {
        for (const opt of renkoModeSelect.options) {
          if (opt.value === targetVal || Number.parseFloat(opt.value) === pct) {
            renkoModeSelect.value = opt.value;
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        renkoModeSelect.value = targetVal;
      }
    } else {
      renkoModeSelect.value = renko.brickMode || 'atr';
    }
  }

  const renkoFixedRow = document.getElementById('renkoFixedSizeRow');
  if (renkoFixedRow) renkoFixedRow.style.display = renko.brickMode === 'fixed' ? '' : 'none';

  const renkoFixedInput = document.getElementById('renkoFixedSizeInput');
  if (renkoFixedInput && renko.fixedSize > 0) renkoFixedInput.value = String(renko.fixedSize);

  const renkoWicksCheck = document.getElementById('renkoWicksCheck');
  if (renkoWicksCheck) renkoWicksCheck.checked = renko.showWicks === true;

  // 6. Dim all button
  const dimAllBtn = document.getElementById('candleOverlayDimAllBtn');
  if (dimAllBtn) {
    const allDimmed = baseCandles === 'dimmed' && heikinAshi.dimmed === true && renko.dimmed === true;
    dimAllBtn.classList.toggle('active', allDimmed);
    dimAllBtn.textContent = allDimmed ? 'Undim all' : 'Dim all';
  }

  syncCandleOverlayButton();
}

function scheduleReRender() {
  applyThemeIfNeeded();
  if ((AppState.market.candles || []).length) {
    scheduleChartRender();
  }
}

export function toggleCandleOverlay(triggerEl) {
  const panel = document.getElementById('candleOverlayPanel');
  const btn = triggerEl || document.getElementById('candleOverlayToggleBtn');
  if (!panel || !btn) return;
  togglePopover({
    id: 'candleOverlay',
    panel,
    trigger: btn,
    openClass: 'active',
    position: positionCandleOverlayPanel,
    onOpen: () => setCandleOverlayPanelVisible(true),
    onClose: () => {
      setCandleOverlayPanelVisible(false);
      syncCandleOverlayButton();
    },
  });
  syncCandleOverlayButton();
}

export function selectCandleOverlayMode(mode) {
  const nextMode = String(mode || 'off');
  setCandleOverlayMode(nextMode);
  if (nextMode !== 'off') {
    const currentBase = AppState.ui.candleOverlay.baseCandles || 'dimmed';
    const currentContrast = AppState.ui.candleOverlay.contrast || 0.5;
    const candles = AppState.market.candles || [];
    const coin = AppState.trading.currentCoin || '';
    const timeframe = AppState.trading.currentTimeframe || '';
    candleOverlay.setOptions({
      mode: nextMode,
      baseCandles: currentBase,
      contrast: currentContrast,
      heikinAshi: AppState.ui.candleOverlay.heikinAshi,
      renko: AppState.ui.candleOverlay.renko,
    });
    if (candles.length) {
      const closedCandles = selectClosedCandles(candles, timeframe);
      candleOverlay.setCandles(candles, coin, timeframe, { closedCandles });
    }
  } else {
    candleOverlay.setOptions({ mode: nextMode });
    candleOverlay.detach();
  }
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onChangeCandleOverlayBaseCandles(arg, el) {
  const val = el?.value || arg || 'dimmed';
  setCandleOverlayBaseCandles(val);
  candleOverlay.setOptions({ baseCandles: val, contrast: AppState.ui.candleOverlay.contrast });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onInputCandleOverlayContrast(el) {
  const raw = Number(el?.value || 50);
  const contrast = Math.max(0.05, Math.min(1.0, raw / 100));
  setCandleOverlayContrast(contrast);
  if (AppState.ui.candleOverlay.baseCandles !== 'dimmed') {
    setCandleOverlayBaseCandles('dimmed');
  }
  candleOverlay.setOptions({ baseCandles: 'dimmed', contrast });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onChangeCandleOverlayContrast(el) {
  onInputCandleOverlayContrast(el);
}

export function onToggleHeikinAshiDimmed(el) {
  const dimmed = el?.checked === true;
  setCandleOverlayHeikinAshiOptions({ dimmed });
  candleOverlay.setOptions({ heikinAshi: { dimmed } });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onInputHeikinAshiOpacity(el) {
  const raw = Number(el?.value || 50);
  const opacity = Math.max(0.05, Math.min(1.0, raw / 100));
  setCandleOverlayHeikinAshiOptions({ opacity, dimmed: true });
  candleOverlay.setOptions({ heikinAshi: { opacity, dimmed: true } });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onChangeHeikinAshiOpacity(el) {
  onInputHeikinAshiOpacity(el);
}

export function onToggleHeikinAshiWicks(el) {
  const showWicks = el?.checked !== false;
  setCandleOverlayHeikinAshiOptions({ showWicks });
  candleOverlay.setOptions({ heikinAshi: { showWicks } });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onToggleRenkoDimmed(el) {
  const dimmed = el?.checked === true;
  setCandleOverlayRenkoOptions({ dimmed });
  candleOverlay.setOptions({ renko: { dimmed } });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onInputRenkoOpacity(el) {
  const raw = Number(el?.value || 50);
  const opacity = Math.max(0.05, Math.min(1.0, raw / 100));
  setCandleOverlayRenkoOptions({ opacity, dimmed: true });
  candleOverlay.setOptions({ renko: { opacity, dimmed: true } });
  scheduleReRender();
  syncCandleOverlayUIIX();
}

export function onChangeRenkoOpacity(el) {
  onInputRenkoOpacity(el);
}

function syncCandleOverlayUIIX() {
  syncCandleOverlayUI();
}

export function onChangeRenkoBrickMode(el) {
  const raw = el?.value || 'atr';
  let brickMode = 'atr';
  let percent = 0.25;

  if (raw === 'fixed') {
    brickMode = 'fixed';
  } else if (raw.endsWith('%')) {
    brickMode = 'percent';
    percent = Number.parseFloat(raw) || 0.25;
  } else {
    brickMode = 'atr';
  }

  setCandleOverlayRenkoOptions({ brickMode, percent });
  candleOverlay.setOptions({ renko: { brickMode, percent } });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onInputRenkoFixedSize(el) {
  const val = Number.parseFloat(el?.value || '0');
  const fixedSize = Number.isFinite(val) && val > 0 ? val : 0;
  setCandleOverlayRenkoOptions({ fixedSize, brickMode: 'fixed' });
  candleOverlay.setOptions({ renko: { fixedSize, brickMode: 'fixed' } });
  scheduleReRender();
}

export function onToggleRenkoWicks(el) {
  const showWicks = el?.checked !== false;
  setCandleOverlayRenkoOptions({ showWicks });
  candleOverlay.setOptions({ renko: { showWicks } });
  scheduleReRender();
  syncCandleOverlayUI();
}

export function onToggleDimAllOverlays() {
  const currentBase = AppState.ui.candleOverlay.baseCandles || 'dimmed';
  const haDimmed = AppState.ui.candleOverlay.heikinAshi?.dimmed === true;
  const renkoDimmed = AppState.ui.candleOverlay.renko?.dimmed === true;
  const allDimmed = currentBase === 'dimmed' && haDimmed && renkoDimmed;

  if (allDimmed) {
    setCandleOverlayBaseCandles('normal');
    setCandleOverlayHeikinAshiOptions({ dimmed: false });
    setCandleOverlayRenkoOptions({ dimmed: false });
    candleOverlay.setOptions({
      baseCandles: 'normal',
      heikinAshi: { dimmed: false },
      renko: { dimmed: false },
    });
  } else {
    setCandleOverlayBaseCandles('dimmed');
    setCandleOverlayHeikinAshiOptions({ dimmed: true });
    setCandleOverlayRenkoOptions({ dimmed: true });
    candleOverlay.setOptions({
      baseCandles: 'dimmed',
      heikinAshi: { dimmed: true },
      renko: { dimmed: true },
    });
  }
  scheduleReRender();
  syncCandleOverlayUI();
}

export function initCandleOverlayUI() {
  syncCandleOverlayUI();
}
