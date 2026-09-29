import { AppState, INDICATOR_STARTUP_DEFAULTS, RVWAP_LOOKBACKS, RVWAP_BAND_LOOKBACKS, SESSION_VWAP_PERIODS } from '../state/store.js';
import {
  setManualAnchoredVwapVisible as storeSetManualAnchoredVwapVisible,
  setManualAnchoredVwapPlacementActive as storeSetManualAnchoredVwapPlacementActive,
  setSessionVwapVisible as storeSetSessionVwapVisible,
  setRvwapLookbackVisible as storeSetRvwapLookbackVisible,
  setRvwapBandsVisible as storeSetRvwapBandsVisible,
  setPriceProjectionVisible as storeSetPriceProjectionVisible,
  setWeekPathProjectionVisible as storeSetWeekPathProjectionVisible,
  setWeekPathEnvelopeVisible as storeSetWeekPathEnvelopeVisible,
  setCvdOscillatorLookback as storeSetCvdOscillatorLookback,
  setMonthlyVolumeProfileVisible as storeSetMonthlyVolumeProfileVisible,
  setVolumeProfilePeriod as storeSetVolumeProfilePeriod,
  setVolumeProfileLvnVisible as storeSetVolumeProfileLvnVisible,
  setLiquidationClustersVisible as storeSetLiquidationClustersVisible,
  setWhaleMarkersVisible as storeSetWhaleMarkersVisible,
  setWhaleMarkerMinNotional as storeSetWhaleMarkerMinNotional,
  setIndicatorsPanelVisible as storeSetIndicatorsPanelVisible,
  setJevSignalsVisible as storeSetJevSignalsVisible,
} from '../state/store.js';
import { scheduleChartRender } from '../chart/chart-render.js';
import {
  drawingToolsOverlay,
  manualAnchoredVwapOverlay,
  sessionVwapOverlay,
  monthlyVolumeProfileOverlay,
  liquidationClustersOverlay,
  whaleMarkersOverlay,
  priceProjectionOverlay,
  weekPathProjectionOverlay,
  syncJevSignalLines,
} from '../chart/lightweight-chart.js';
import { JevState } from '../services/jev-service.js';
import { isCvdAlertsMuted, setCvdAlertsMuted } from '../services/cvd-alert-monitor.js';
import { closePopover, isPopoverOpen, positionPopover, togglePopover } from './popover-controller.js';
import { initAnchorEditor, syncAnchorEditor } from './chart-avwap-editor.js';

function syncIndicatorsPanelButton() {
  const btn = document.getElementById('indicatorsToggleBtn');
  if (!btn) return;
  const open = isPopoverOpen('indicators');
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function syncIndicatorsPanel() {
  const panel = document.getElementById('indicatorsPanel');
  if (!panel) return;
  if (!isPopoverOpen('indicators')) panel.style.display = 'none';
}

function positionIndicatorsPanel() {
  const panel = document.getElementById('indicatorsPanel');
  const btn = document.getElementById('indicatorsToggleBtn');
  if (!panel || !btn) return;
  positionPopover(panel, btn, { minWidth: 316, scrollable: true });
}

function syncCheckbox(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = value === true || value === 'true';
}

function syncCvdOscillatorLookbackSelect(value) {
  const el = document.getElementById('cvdOscillatorLookbackSelect');
  if (el) el.value = value || '90D';
}

function syncVolumeProfilePeriodSelect(value) {
  const el = document.getElementById('volumeProfilePeriodSelect');
  if (el) el.value = value || 'visible';
}

function syncWhaleMarkerMinSelect(value) {
  const el = document.getElementById('whaleMarkerMinSelect');
  if (el) el.value = String(value || 100000);
}

let priceProjectionStatus = { status: 'disabled' };
let weekPathProjectionStatus = { status: 'disabled' };

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '—';
}

function formatSignedPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const rounded = Math.round(numeric * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function formatMonthUtc(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  return date.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatProjectionHorizon(status) {
  const days = Number(status.horizonDays || status.horizon);
  if (!(days > 0) || !Number.isFinite(days)) return null;
  const remaining = status.originMode === 'remaining-horizon';
  const label = days >= 1
    ? `${Math.max(1, Math.round(days))}d`
    : `${Math.max(1, Math.round(days * 24))}h`;
  if (remaining) return `${label} left`;
  if (status.originMode === 'month-open-live') return `${label} from open`;
  return label;
}

function projectionUnavailableText(reason, status = {}) {
  if (reason === 'insufficient-history') {
    const days = Number(status.requiredSourceDays);
    if (Number.isFinite(days) && days > 0) {
      return `Unavailable · need ~${days}d of clean closed history`;
    }
    const bars = Number(status.requiredSourceCount);
    if (Number.isFinite(bars) && bars > 0) {
      return `Unavailable · need ~${bars} clean closed bars`;
    }
    return 'Unavailable · need more clean closed history';
  }
  if (reason === 'insufficient-calibration') {
    const minOrigins = Number(status.minCalibrationOrigins);
    const horizonDays = Number(status.horizonDays || status.horizon);
    if (Number.isFinite(minOrigins) && Number.isFinite(horizonDays) && horizonDays > 0) {
      return `Unavailable · need ≥${minOrigins} non-overlapping ${horizonDays}d month samples`;
    }
    return 'Unavailable · calibration sample too small for this month';
  }
  if (reason === 'insufficient-analogues') return 'Unavailable · no reliable analogues';
  if (reason === 'irregular-cadence') {
    return 'Unavailable · no usable trailing segment without gaps';
  }
  if (reason === 'invalid-source') return 'Unavailable · invalid candle history';
  if (reason === 'no-profile-months') {
    return 'Unavailable · no monthly profile months to pair';
  }
  if (reason === 'horizon-too-long-for-timeframe') {
    return 'Unavailable · use a higher timeframe for a full UTC month';
  }
  if (reason === 'horizon-too-short-for-timeframe') {
    return 'Unavailable · chart bar is longer than a UTC month';
  }
  if (reason === 'horizon-not-aligned-to-timeframe') {
    return 'Unavailable · this timeframe does not align to UTC months';
  }
  if (reason === 'invalid-horizon') return 'Unavailable · invalid month horizon';
  if (reason === 'week-complete' || reason === 'horizon-complete') {
    return 'Unavailable · 2-week horizon already closed on this bar';
  }
  if (reason === 'missing-week-open') return 'Unavailable · need the current week open in history';
  if (reason === 'unsupported-timeframe') return 'Unavailable · timeframe not supported';
  return 'Unavailable';
}

function syncPriceProjectionStatus() {
  const element = document.getElementById('priceProjectionStatus');
  if (!element) return;
  if (AppState.ui.priceProjectionVisible !== true || priceProjectionStatus.status === 'disabled') {
    element.textContent = 'Off';
    element.dataset.status = 'disabled';
    element.title = '';
    return;
  }
  if (priceProjectionStatus.status === 'ready') {
    const calibration = priceProjectionStatus.calibration || {};
    const evidence = String(
      priceProjectionStatus.evidenceStatus
      || priceProjectionStatus.model?.status
      || 'unvalidated',
    );
    const evidenceLabel = evidence.startsWith('validated')
      ? 'Frozen-test OK'
      : 'Research';
    const monthLabel = formatMonthUtc(priceProjectionStatus.monthStart);
    const monthCount = Number(
      priceProjectionStatus.drawnMonthCount ?? priceProjectionStatus.monthCount,
    );
    const parts = [
      evidenceLabel,
      monthLabel || null,
      formatProjectionHorizon(priceProjectionStatus),
      Number.isFinite(monthCount) && monthCount > 1
        ? `${monthCount} prior+live`
        : null,
      `UpFreq ${formatPercent(priceProjectionStatus.analogueUpFrequency)}`,
      `wESS ${Math.round(Number(priceProjectionStatus.weightEffectiveSampleSize) || 0)}`,
      `cESS ${Math.round(Number(priceProjectionStatus.clusterEffectiveSampleSize) || 0)}`,
      `MAE skill ${formatSignedPercent(calibration.maeSkillVsZero)}`,
      `BT50 ${formatPercent(calibration.coverage50)}`,
      `BT80 ${formatPercent(calibration.coverage80)}`,
    ].filter(Boolean);
    // When ACI-lite moves drawn factors off pre-ACI BT factors, surface it so
    // the chart fan is not mistaken for the BT coverage numbers.
    if (calibration.aciAdjusted === true) {
      const f50 = Number(calibration.factor50Drawn);
      const f80 = Number(calibration.factor80Drawn);
      const pre50 = Number(calibration.factor50PreAci);
      const pre80 = Number(calibration.factor80PreAci);
      const ratio50 = pre50 > 0 && Number.isFinite(f50) ? f50 / pre50 : 1;
      const ratio80 = pre80 > 0 && Number.isFinite(f80) ? f80 / pre80 : 1;
      const drawnRatio = Math.max(ratio50, ratio80);
      if (Number.isFinite(drawnRatio) && Math.abs(drawnRatio - 1) > 0.02) {
        parts.push(`drawn×${drawnRatio.toFixed(2)}`);
      } else {
        parts.push('drawn ACI');
      }
    }
    element.textContent = parts.join(' · ');
    element.dataset.status = 'ready';
    const btNote = 'BT50/BT80 are pre-ACI terminal coverage from non-overlapping month-length origins (same as offline promotion gates), not guaranteed probabilities.';
    element.title = evidence.startsWith('validated')
      ? `Occupancy map passed a frozen walk-forward coverage/Brier gate (research-only; not a trading-edge claim). Origin is the last close before this UTC month. Live month-to-date only reweights analogues. UpFreq is a weighted historical frequency, not a calibrated probability. ${btNote}`
      : `Unvalidated UTC-month occupancy map from this month's UTC open. Elapsed month-to-date squares stay faint; remaining-horizon squares stay at MAP color. UpFreq is a weighted historical frequency, not a probability forecast. ${btNote}`;
    return;
  }
  if (priceProjectionStatus.status === 'unavailable') {
    element.textContent = projectionUnavailableText(
      priceProjectionStatus.reason,
      priceProjectionStatus,
    );
    element.dataset.status = 'unavailable';
    const need = Number(priceProjectionStatus.requiredHistoryBarsApprox);
    element.title = Number.isFinite(need) && need > 0
      ? `Approximately ${need} clean bars of history required for this horizon.`
      : '';
    return;
  }
  element.textContent = 'Calculating from closed candles…';
  element.dataset.status = 'pending';
  element.title = '';
}

function syncWeekPathProjectionStatus() {
  const element = document.getElementById('weekPathProjectionStatus');
  if (!element) return;
  if (AppState.ui.weekPathProjectionVisible !== true || weekPathProjectionStatus.status === 'disabled') {
    element.textContent = 'Off';
    element.dataset.status = 'disabled';
    element.title = '';
    return;
  }
  if (weekPathProjectionStatus.status === 'ready') {
    const calibration = weekPathProjectionStatus.calibration || {};
    const evidence = String(
      weekPathProjectionStatus.evidenceStatus
      || weekPathProjectionStatus.model?.status
      || 'unvalidated',
    );
    const evidenceLabel = evidence.startsWith('validated')
      ? 'Frozen-test OK'
      : 'Research';
    const remDays = Number(weekPathProjectionStatus.remainingDays);
    const remBars = Number(weekPathProjectionStatus.remainingBars);
    const frac = Number(weekPathProjectionStatus.weekFractionElapsed);
    const parts = [
      evidenceLabel,
      Number.isFinite(remDays) && remDays > 0 ? `~${remDays}d left` : null,
      Number.isFinite(remBars) && remBars > 0 ? `${remBars} bars` : null,
      Number.isFinite(frac) ? `horizon ${Math.round(frac * 100)}%` : null,
      `UpFreq ${formatPercent(weekPathProjectionStatus.analogueUpFrequency)}`,
      `BT50 ${formatPercent(calibration.coverage50)}`,
      `BT80 ${formatPercent(calibration.coverage80)}`,
    ].filter(Boolean);
    if (calibration.aciAdjusted === true) {
      const f50 = Number(calibration.factor50Drawn);
      const f80 = Number(calibration.factor80Drawn);
      const pre50 = Number(calibration.factor50PreAci);
      const pre80 = Number(calibration.factor80PreAci);
      const ratio50 = pre50 > 0 && Number.isFinite(f50) ? f50 / pre50 : 1;
      const ratio80 = pre80 > 0 && Number.isFinite(f80) ? f80 / pre80 : 1;
      const drawnRatio = Math.max(ratio50, ratio80);
      if (Number.isFinite(drawnRatio) && Math.abs(drawnRatio - 1) > 0.02) {
        parts.push(`drawn×${drawnRatio.toFixed(2)}`);
      } else {
        parts.push('drawn ACI');
      }
    }
    element.textContent = parts.join(' · ');
    element.dataset.status = 'ready';
    const btNote = 'BT50/BT80 are pre-ACI terminal coverage for same remaining-length origins (research-only). Horizon is bars until Monday 00:00 UTC two weeks after the current ISO week start.';
    element.title = evidence.startsWith('validated')
      ? `2-week path bands passed a frozen walk-forward gate (not a trading-edge claim). ${btNote}`
      : `Unvalidated 2-week research path (remaining this week + next week). ${btNote}`;
    return;
  }
  if (weekPathProjectionStatus.status === 'unavailable') {
    element.textContent = projectionUnavailableText(
      weekPathProjectionStatus.reason,
      weekPathProjectionStatus,
    );
    element.dataset.status = 'unavailable';
    const need = Number(weekPathProjectionStatus.requiredHistoryBarsApprox);
    element.title = Number.isFinite(need) && need > 0
      ? `Approximately ${need} clean bars of history required for this 2-week path sample.`
      : '';
    return;
  }
  element.textContent = 'Calculating from closed candles…';
  element.dataset.status = 'pending';
  element.title = '';
}

// The CVD-alerts checkbox is "on" when alerts are enabled (i.e. not muted).
// Unlike the other indicator toggles, this state is persisted in localStorage.
function syncCvdAlertsCheckbox() {
  const el = document.getElementById('cvdAlertsCheck');
  if (el) el.checked = !isCvdAlertsMuted();
}

function syncAllControls() {
  syncCheckbox('manualAnchoredVwapCheck', AppState.ui.manualAnchoredVwapVisible);
  const addButton = document.getElementById('manualAnchoredVwapAddBtn');
  if (addButton) addButton.classList.toggle('tool-armed', AppState.ui.manualAnchoredVwapPlacementActive === true);
  const hint = document.getElementById('manualAnchoredVwapHint');
  if (hint) hint.textContent = AppState.ui.manualAnchoredVwapPlacementActive === true ? 'Click chart' : '';
  for (const period of SESSION_VWAP_PERIODS) {
    syncCheckbox(`sessionVwap${period.charAt(0).toUpperCase() + period.slice(1)}Check`, AppState.ui.sessionVwap?.[period]);
  }
  const enabledRvwaps = new Set(Array.isArray(AppState.ui.rvwapLookbacks) ? AppState.ui.rvwapLookbacks : []);
  const enabledRvwapBands = new Set(Array.isArray(AppState.ui.rvwapBandLookbacks) ? AppState.ui.rvwapBandLookbacks : []);
  for (const lookback of RVWAP_LOOKBACKS) {
    syncCheckbox(`rvwap${lookback.toLowerCase()}Check`, enabledRvwaps.has(lookback));
  }
  for (const lookback of RVWAP_BAND_LOOKBACKS) {
    syncCheckbox(`rvwap${lookback.toLowerCase()}BandsCheck`, enabledRvwapBands.has(lookback));
  }
  syncCheckbox('monthlyVolumeProfileCheck', AppState.ui.monthlyVolumeProfileVisible);
  syncVolumeProfilePeriodSelect(AppState.ui.volumeProfilePeriod);
  syncCheckbox('volumeProfileLvnCheck', AppState.ui.volumeProfileLvnVisible !== false);
  syncCheckbox('liquidationClustersCheck', AppState.ui.liquidationClustersVisible);
  syncCheckbox('whaleMarkersCheck', AppState.ui.whaleMarkersVisible);
  syncWhaleMarkerMinSelect(AppState.ui.whaleMarkerMinNotional);
  syncCheckbox('jevSignalsCheck', AppState.ui.jevSignalsVisible);
  syncCheckbox('priceProjectionCheck', AppState.ui.priceProjectionVisible);
  syncPriceProjectionStatus();
  syncCheckbox('weekPathProjectionCheck', AppState.ui.weekPathProjectionVisible);
  syncCheckbox('weekPathEnvelopeCheck', AppState.ui.weekPathEnvelopeVisible !== false);
  syncWeekPathProjectionStatus();
  syncCvdOscillatorLookbackSelect(AppState.ui.cvdOscillatorLookback);
  syncCvdAlertsCheckbox();
  syncIndicatorsPanelButton();
  syncIndicatorsPanel();
}

function scheduleReRender() {
  if ((AppState.market.candles || []).length) scheduleChartRender();
}

export function toggleIndicators(triggerEl) {
  const panel = document.getElementById('indicatorsPanel');
  const btn = triggerEl || document.getElementById('indicatorsToggleBtn');
  if (!panel || !btn) return;
  togglePopover({
    id: 'indicators',
    panel,
    trigger: btn,
    openClass: 'active',
    position: positionIndicatorsPanel,
    onOpen: () => storeSetIndicatorsPanelVisible(true),
    onClose: () => {
      storeSetIndicatorsPanelVisible(false);
      syncIndicatorsPanelButton();
    },
  });
  syncIndicatorsPanelButton();
}

export function onToggleManualAnchoredVwap(el) {
  storeSetManualAnchoredVwapVisible(el.checked);
  if (!el.checked) manualAnchoredVwapOverlay.setPlacementActive(false);
  scheduleReRender();
  syncAllControls();
}

export function onToggleSessionVwap(period, el) {
  storeSetSessionVwapVisible(period, el?.checked === true);
  scheduleReRender();
  syncAllControls();
}

export function onToggleManualAnchoredVwapBands(anchorId, el) {
  manualAnchoredVwapOverlay.setAnchorOptions?.(String(anchorId || ''), {
    bandsVisible: el?.checked === true,
  });
}

export function onChangeManualAnchoredVwapSigma(anchorId, el) {
  manualAnchoredVwapOverlay.setAnchorOptions?.(String(anchorId || ''), {
    sigma: el?.value,
  });
}

export function addManualAnchoredVwap() {
  // Manual-anchor placement and drawing placement both own the next chart
  // click, so explicitly disarm drawing mode before arming this one.
  drawingToolsOverlay.setActiveTool(null);
  storeSetManualAnchoredVwapVisible(true);
  manualAnchoredVwapOverlay.setOptions({ visible: true });
  manualAnchoredVwapOverlay.setPlacementActive(true);
  closePopover('indicators');
  scheduleReRender();
  syncAllControls();
}

export function onToggleMonthlyVolumeProfile(el) {
  storeSetMonthlyVolumeProfileVisible(el.checked);
  scheduleReRender();
}

export function onChangeVolumeProfilePeriod(el) {
  const period = ['monthly', 'quarterly'].includes(el?.value) ? el.value : 'visible';
  storeSetVolumeProfilePeriod(period);
  monthlyVolumeProfileOverlay?.setPeriod?.(period);
  scheduleReRender();
  syncAllControls();
}

export function onToggleVolumeProfileLvn(el) {
  storeSetVolumeProfileLvnVisible(el.checked);
  monthlyVolumeProfileOverlay?.setLvnVisible?.(el.checked);
  scheduleReRender();
  syncAllControls();
}

export function onToggleLiquidationClusters(el) {
  storeSetLiquidationClustersVisible(el.checked);
  scheduleReRender();
  syncAllControls();
}

export function onToggleJevSignals(el) {
  storeSetJevSignalsVisible(el.checked);
  const targetCoin = AppState.trading.currentCoin;
  const sig = JevState.lastSignal;
  syncJevSignalLines(el.checked && sig && sig.coin === targetCoin ? sig : null);
  scheduleReRender();
  syncAllControls();
}

export function onToggleWhaleMarkers(el) {
  storeSetWhaleMarkersVisible(el.checked);
  whaleMarkersOverlay?.setOptions?.({ visible: el.checked });
  scheduleReRender();
  syncAllControls();
}

export function onChangeWhaleMarkerMin(el) {
  const minNotional = Number(el?.value) || 100000;
  storeSetWhaleMarkerMinNotional(minNotional);
  whaleMarkersOverlay?.setOptions?.({ minNotional });
  scheduleReRender();
  syncAllControls();
}

export function onTogglePriceProjection(el) {
  storeSetPriceProjectionVisible(el.checked);
  priceProjectionStatus = el.checked ? { status: 'pending' } : { status: 'disabled' };
  scheduleReRender();
  syncAllControls();
}

export function onToggleWeekPathProjection(el) {
  storeSetWeekPathProjectionVisible(el.checked);
  weekPathProjectionStatus = el.checked ? { status: 'pending' } : { status: 'disabled' };
  scheduleReRender();
  syncAllControls();
}

export function onToggleWeekPathEnvelope(el) {
  storeSetWeekPathEnvelopeVisible(el.checked);
  if (AppState.ui.weekPathProjectionVisible === true) {
    weekPathProjectionStatus = { status: 'pending' };
  }
  scheduleReRender();
  syncAllControls();
}

export function onToggleRvwap(lookback, el) {
  storeSetRvwapLookbackVisible(lookback, el.checked);
  scheduleReRender();
  // Market session owns stream/service intent; UI only toggles AppState + paint.
  import('../services/market-session.js').then(async (session) => {
    await session.requestMarketSubscription();
    if (AppState.ui.rvwapLookbacks.length > 0) {
      await session.requestRvwapSource({ coin: AppState.trading.currentCoin });
    } else {
      const rvwap = await import('../services/rvwap-source-service.js');
      rvwap.cancelRvwapSourceRetries?.();
    }
  }).catch(() => {});
}

export function onToggleRvwapBands(lookback, el) {
  storeSetRvwapBandsVisible(lookback, el.checked);
  scheduleReRender();
}

export function onChangeCvdOscillatorLookback(el) {
  storeSetCvdOscillatorLookback(el.value);
  scheduleReRender();
}

// Checked = alerts enabled, so muted is the inverse. Persisted across reloads.
export function onToggleCvdAlerts(el) {
  setCvdAlertsMuted(!el.checked);
}

export function initIndicatorUI() {
  // Fixed startup state — indicator toggles are intentionally NOT persisted
  // across reloads. Every launch begins with manual Anchors visible and Monthly
  // volume profile visible. Bands / σ live on the selected chart origin, not
  // IND; each persisted anchor keeps its own settings, and new anchors start
  // with bands hidden at 2σ. Rolling VWAPs and their bands start disabled;
  // in-session toggles work but are forgotten on reload.
  storeSetManualAnchoredVwapVisible(INDICATOR_STARTUP_DEFAULTS.manualAnchoredVwapVisible);
  storeSetManualAnchoredVwapPlacementActive(false);
  for (const period of SESSION_VWAP_PERIODS) {
    storeSetSessionVwapVisible(period, INDICATOR_STARTUP_DEFAULTS.sessionVwap?.[period] === true);
  }
  for (const lookback of RVWAP_LOOKBACKS) storeSetRvwapLookbackVisible(lookback, false);
  for (const lookback of RVWAP_BAND_LOOKBACKS) storeSetRvwapBandsVisible(lookback, false);
  for (const lookback of INDICATOR_STARTUP_DEFAULTS.rvwapLookbacks) {
    storeSetRvwapLookbackVisible(lookback, true);
  }
  for (const lookback of INDICATOR_STARTUP_DEFAULTS.rvwapBandLookbacks) {
    storeSetRvwapBandsVisible(lookback, true);
  }
  storeSetCvdOscillatorLookback('90D');
  storeSetPriceProjectionVisible(INDICATOR_STARTUP_DEFAULTS.priceProjectionVisible);
  storeSetWeekPathProjectionVisible(INDICATOR_STARTUP_DEFAULTS.weekPathProjectionVisible);
  storeSetWeekPathEnvelopeVisible(INDICATOR_STARTUP_DEFAULTS.weekPathEnvelopeVisible !== false);
  storeSetMonthlyVolumeProfileVisible(INDICATOR_STARTUP_DEFAULTS.monthlyVolumeProfileVisible);
  storeSetVolumeProfilePeriod(INDICATOR_STARTUP_DEFAULTS.volumeProfilePeriod);
  monthlyVolumeProfileOverlay?.setPeriod?.(INDICATOR_STARTUP_DEFAULTS.volumeProfilePeriod);
  storeSetVolumeProfileLvnVisible(INDICATOR_STARTUP_DEFAULTS.volumeProfileLvnVisible);
  monthlyVolumeProfileOverlay?.setLvnVisible?.(INDICATOR_STARTUP_DEFAULTS.volumeProfileLvnVisible);
  storeSetLiquidationClustersVisible(INDICATOR_STARTUP_DEFAULTS.liquidationClustersVisible);
  storeSetWhaleMarkersVisible(INDICATOR_STARTUP_DEFAULTS.whaleMarkersVisible);
  storeSetWhaleMarkerMinNotional(INDICATOR_STARTUP_DEFAULTS.whaleMarkerMinNotional);
  storeSetJevSignalsVisible(INDICATOR_STARTUP_DEFAULTS.jevSignalsVisible);
  syncJevSignalLines(null);
  whaleMarkersOverlay?.setOptions?.({
    visible: INDICATOR_STARTUP_DEFAULTS.whaleMarkersVisible,
    minNotional: INDICATOR_STARTUP_DEFAULTS.whaleMarkerMinNotional,
  });
  storeSetIndicatorsPanelVisible(false);
  closePopover('indicators');

  manualAnchoredVwapOverlay.setOnPlacementChange((active) => {
    storeSetManualAnchoredVwapPlacementActive(active);
    syncAllControls();
  });
  manualAnchoredVwapOverlay.setOnAnchorsChange?.(() => {
    syncAnchorEditor();
  });
  initAnchorEditor();
  manualAnchoredVwapOverlay.setPlacementActive(false);
  priceProjectionStatus = { status: 'disabled' };
  priceProjectionOverlay.setOnStatusChange((status) => {
    priceProjectionStatus = status || { status: 'pending' };
    syncPriceProjectionStatus();
  });
  weekPathProjectionStatus = { status: 'disabled' };
  weekPathProjectionOverlay.setOnStatusChange((status) => {
    weekPathProjectionStatus = status || { status: 'pending' };
    syncWeekPathProjectionStatus();
  });

  syncAllControls();
}
