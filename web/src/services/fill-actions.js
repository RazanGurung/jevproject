import { deployTradePlan } from './deploy-plan.js';
import { getAllMids } from '../state/market-selectors.js';
import { getCurrentPrice } from '../state/trading-selectors.js';
import { toNumber } from '../utils/helpers.js';

function getMidPrice(coin, fallbackPrice = 0) {
  return toNumber(
    getAllMids()?.[coin]
    || fallbackPrice
    || getCurrentPrice()
    || 0
  );
}

function getBaseSize(fill) {
  const px = toNumber(fill.px || fill.price);
  const sz = Math.abs(toNumber(fill.sz || fill.size));
  const value = px > 0 && sz > 0 ? px * sz : 0;
  return Math.max(25, Math.round(value || Math.abs(toNumber(fill.closedPnl || 0)) * 4 || 100));
}

function getPlaybookDefaults(playbook) {
  if (playbook === 'Breakout') return { stopLossPct: 1.2, takeProfitPct: 2.8 };
  if (playbook === 'Hedge') return { stopLossPct: 0.7, takeProfitPct: 1.2 };
  return { stopLossPct: 1.0, takeProfitPct: 2.1 };
}

function buildPlan(fill, mode) {
  const coin = fill.coin || fill.symbol;
  const fillPrice = toNumber(fill.px || fill.price);
  const sideLabel = String(fill.side || fill.dir || '').toLowerCase();
  const originalSide = sideLabel.startsWith('s') ? 'sell' : 'buy';
  const playbook = mode === 'hedge' ? 'Hedge' : 'Pullback';
  const side = mode === 'hedge' ? (originalSide === 'buy' ? 'sell' : 'buy') : originalSide;
  const mid = getMidPrice(coin, fillPrice);
  const bias = mode === 'hedge' ? 0 : side === 'buy' ? -0.0005 : 0.0005;
  const { stopLossPct, takeProfitPct } = getPlaybookDefaults(playbook);

  return {
    coin,
    side,
    playbook,
    orderType: 'limit',
    sizeUsd: mode === 'hedge' ? Math.round(getBaseSize(fill) * 0.6) : getBaseSize(fill),
    limitPx: mid > 0 ? mid * (1 + bias) : fillPrice,
    stopLossPct,
    takeProfitPct,
  };
}

export function deployFillAction(encodedFill, mode = 'replay') {
  if (!encodedFill) return;

  let fill;
  try {
    fill = JSON.parse(decodeURIComponent(encodedFill));
  } catch {
    return;
  }

  const plan = buildPlan(fill, mode);
  const label = mode === 'hedge' ? 'Hedge deployed' : 'Replay deployed';
  deployTradePlan({
    ...plan,
    toastMessage: `${label}: ${plan.coin} ${plan.playbook} ${plan.side === 'buy' ? 'Long' : 'Short'}`,
  });
}
