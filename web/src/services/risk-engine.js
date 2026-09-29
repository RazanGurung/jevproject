import { getAccountState, getOpenPositionCount, getPositionExposure, getOpenPositions } from '../state/account-state.js';
import { getMaxLeverage } from '../state/coin-meta.js';
import { getDeployNotionalFraction } from './deploy-config.js';
import { getAccountMetrics } from './account-metrics.js';
import { toNumber } from '../utils/helpers.js';

export function getRiskSnapshot(accountState = getAccountState()) {
  const { accountValue, available, used, utilization } = getAccountMetrics(accountState);
  const exposure = getPositionExposure(accountState);
  const positionCount = getOpenPositionCount(accountState);

  return {
    accountValue,
    available,
    used,
    utilization,
    exposure,
    positionCount,
  };
}

export function evaluateOrderRisk({ coin, side, sizeUsd, playbook }) {
  const snapshot = getRiskSnapshot();
  const existingPos = getOpenPositions().find((wrapper) => wrapper?.position?.coin === coin);
  const existingSide = existingPos ? (toNumber(existingPos.position.szi) > 0 ? 'buy' : 'sell') : null;
  const reducesExisting = existingSide && existingSide !== side;
  const maxLeverage = Math.max(1, Number(getMaxLeverage(coin) || 25));
  const maxNotional = snapshot.available > 0 ? snapshot.available * maxLeverage : snapshot.accountValue * maxLeverage;
  const riskMode = snapshot.utilization >= 0.9 ? 'locked' : snapshot.utilization >= 0.7 ? 'caution' : 'normal';
  const suggestedFraction = getDeployNotionalFraction(playbook || 'Pullback', riskMode);

  if (reducesExisting) {
    return {
      allowed: true,
      mode: 'reduce',
      message: 'Reduce/hedge action allowed',
      cappedSizeUsd: sizeUsd,
    };
  }

  if (!(snapshot.accountValue > 0) && !(snapshot.available > 0)) {
    return {
      allowed: true,
      mode: 'unknown',
      message: '',
      cappedSizeUsd: sizeUsd,
    };
  }

  if (snapshot.utilization >= 0.9) {
    return {
      allowed: false,
      mode: 'locked',
      message: 'Risk locked: exposure already too high for new entries.',
      cappedSizeUsd: 0,
    };
  }

  if (snapshot.positionCount >= 5) {
    return {
      allowed: false,
      mode: 'locked',
      message: 'Risk locked: maximum concurrent positions reached.',
      cappedSizeUsd: 0,
    };
  }

  if (maxNotional <= 0) {
    return {
      allowed: false,
      mode: 'locked',
      message: 'Risk locked: no leveraged buying power remains for new entries.',
      cappedSizeUsd: 0,
    };
  }

  if (sizeUsd > maxNotional) {
    return {
      allowed: true,
      mode: riskMode,
      message: `Order capped by available leveraged buying power at $${Math.round(maxNotional)}.`,
      cappedSizeUsd: Math.round(maxNotional),
    };
  }

  if (playbook === 'Fade' && snapshot.utilization >= 0.7) {
    return {
      allowed: false,
      mode: 'caution',
      message: 'Fade setups are blocked while the account is in caution mode.',
      cappedSizeUsd: 0,
    };
  }

  return {
    allowed: true,
    mode: riskMode,
    message: riskMode === 'caution'
      ? `Caution mode: deploy fits within remaining leveraged buying power at ${Math.round(suggestedFraction * 100)}%.`
      : 'Risk engine passed.',
    cappedSizeUsd: sizeUsd,
  };
}
