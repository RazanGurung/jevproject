import { clamp } from '../utils/helpers.js';

const DEPLOY_SIZING_STORAGE_KEY = 'pez.deploySizing.v1';

const DEFAULT_DEPLOY_SIZING = {
  playbooks: {
    Breakout: 0.35,
    Pullback: 0.3,
    Fade: 0.18,
    Hedge: 0.22,
  },
  riskMultipliers: {
    normal: 1,
    caution: 0.65,
    locked: 0,
  },
};

function getDefaultDeploySizingSettings() {
  return sanitizeSettings(DEFAULT_DEPLOY_SIZING);
}

function rerenderDeploySizingSurfaces() {
  renderDeploySizingControls();
}

function finalizeDeploySizingSettings(settings) {
  const sanitized = sanitizeSettings(settings);
  rerenderDeploySizingSurfaces();
  return sanitized;
}

function sanitizeSettings(raw = {}) {
  const playbooks = raw.playbooks || {};
  const riskMultipliers = raw.riskMultipliers || {};
  return {
    playbooks: {
      Breakout: clamp(Number(playbooks.Breakout ?? DEFAULT_DEPLOY_SIZING.playbooks.Breakout) || DEFAULT_DEPLOY_SIZING.playbooks.Breakout, 0.05, 0.5),
      Pullback: clamp(Number(playbooks.Pullback ?? DEFAULT_DEPLOY_SIZING.playbooks.Pullback) || DEFAULT_DEPLOY_SIZING.playbooks.Pullback, 0.05, 0.5),
      Fade: clamp(Number(playbooks.Fade ?? DEFAULT_DEPLOY_SIZING.playbooks.Fade) || DEFAULT_DEPLOY_SIZING.playbooks.Fade, 0.05, 0.5),
      Hedge: clamp(Number(playbooks.Hedge ?? DEFAULT_DEPLOY_SIZING.playbooks.Hedge) || DEFAULT_DEPLOY_SIZING.playbooks.Hedge, 0.05, 0.5),
    },
    riskMultipliers: {
      normal: clamp(Number(riskMultipliers.normal ?? DEFAULT_DEPLOY_SIZING.riskMultipliers.normal) || DEFAULT_DEPLOY_SIZING.riskMultipliers.normal, 0, 1.5),
      caution: clamp(Number(riskMultipliers.caution ?? DEFAULT_DEPLOY_SIZING.riskMultipliers.caution) || DEFAULT_DEPLOY_SIZING.riskMultipliers.caution, 0, 1.5),
      locked: 0,
    },
  };
}

export function getDeploySizingSettings() {
  try {
    const stored = window.localStorage?.getItem(DEPLOY_SIZING_STORAGE_KEY);
    if (!stored) return getDefaultDeploySizingSettings();
    return sanitizeSettings(JSON.parse(stored));
  } catch (_) {
    return getDefaultDeploySizingSettings();
  }
}

function persist(settings) {
  const sanitized = sanitizeSettings(settings);
  try {
    window.localStorage?.setItem(DEPLOY_SIZING_STORAGE_KEY, JSON.stringify(sanitized));
  } catch (_) {
    return finalizeDeploySizingSettings(sanitized);
  }
  return finalizeDeploySizingSettings(sanitized);
}

export function getDeployNotionalFraction(playbook, riskMode = 'normal') {
  const settings = getDeploySizingSettings();
  const base = settings.playbooks[playbook] ?? settings.playbooks.Pullback;
  const multiplier = settings.riskMultipliers[riskMode] ?? settings.riskMultipliers.normal;
  return clamp(base * multiplier, 0, 0.5);
}

export function updateDeploySizingSetting(kind, key, rawValue) {
  const settings = getDeploySizingSettings();
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue)) return settings;

  if (kind === 'playbook') {
    settings.playbooks[key] = numericValue / 100;
  } else if (kind === 'risk') {
    settings.riskMultipliers[key] = numericValue / 100;
  }

  return persist(settings);
}

export function resetDeploySizingSettings() {
  try {
    window.localStorage?.removeItem(DEPLOY_SIZING_STORAGE_KEY);
  } catch (_) {
    return finalizeDeploySizingSettings(DEFAULT_DEPLOY_SIZING);
  }
  return finalizeDeploySizingSettings(DEFAULT_DEPLOY_SIZING);
}

export function renderDeploySizingControls() {
  const settings = getDeploySizingSettings();
  const mapping = {
    deployFractionBreakout: settings.playbooks.Breakout,
    deployFractionPullback: settings.playbooks.Pullback,
    deployFractionFade: settings.playbooks.Fade,
    deployFractionHedge: settings.playbooks.Hedge,
    deployRiskNormal: settings.riskMultipliers.normal,
    deployRiskCaution: settings.riskMultipliers.caution,
  };

  Object.entries(mapping).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input) input.value = String(Math.round(value * 100));
  });
}
