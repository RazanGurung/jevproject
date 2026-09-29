import { AppState } from '../state/store.js';
import { toNumber } from '../utils/helpers.js';

export function getAccountMetrics(accountState = AppState.account.state) {
  const risk = accountState?.riskSummary || {};

  let accountValue = toNumber(risk.accountValue);
  const available = toNumber(risk.availableMargin ?? risk.withdrawable ?? 0);

  // If the exchange omits accountValue but provides withdrawable, use it as a fallback.
  if (accountValue <= 0 && available > 0) {
    accountValue = available;
  }

  const used = Math.max(0, accountValue - available);
  const utilization = accountValue > 0 ? used / accountValue : 0;

  return {
    accountValue,
    available,
    used,
    utilization,
  };
}
