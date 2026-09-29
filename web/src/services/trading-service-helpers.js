import { getLastDeployedPlan } from '../state/trading-selectors.js';
import { getAllMids } from '../state/market-selectors.js';
import { getCurrentPrice } from '../state/trading-selectors.js';
import { getTickSize, getCoinDecimals } from '../state/coin-meta.js';
import { getAccountState } from '../state/account-state.js';
import { isHip3Coin } from '../utils/helpers.js';

// NOTE: Intentionally uses Number() (strict coercion), NOT parseFloat. This is
// a deliberately different semantic from utils/helpers.toNumber and must not be
// merged into it: Number('12px') -> NaN -> 0 here, whereas the parseFloat
// helper would yield 12. Kept local on purpose.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function approxEqual(a, b, epsilon = 1e-6) {
  return Math.abs(toNumber(a) - toNumber(b)) <= epsilon;
}

export function getTicketSource({ coin, side, orderType, playbook, sizeUsd, limitPx, tpPct, slPct }) {
  const plan = getLastDeployedPlan();
  if (!plan) return 'manual';
  if (plan.coin !== coin) return 'manual';
  if ((plan.side || 'buy') !== side) return 'manual';
  if ((plan.orderType || 'limit') !== orderType) return 'manual';
  if ((plan.playbook || 'Manual') !== (playbook || 'Manual')) return 'manual';
  if (!approxEqual(plan.sizeUsd, sizeUsd, 1e-4)) return 'manual';
  // The ticket price arrives wire-rounded; round the plan's raw price the
  // same way or signal attribution (and its risk gating) silently breaks for
  // plans whose price needs rounding.
  const planLimitPx = plan.limitPx > 0 ? roundPriceToTick(plan.limitPx, coin) : plan.limitPx;
  if (!approxEqual(planLimitPx, limitPx || 0, 1e-4)) return 'manual';
  if (!approxEqual(plan.takeProfitPct, tpPct || 0, 1e-4)) return 'manual';
  if (!approxEqual(plan.stopLossPct, slPct || 0, 1e-4)) return 'manual';
  return 'signal';
}

export function isClearlyStaleHip3ScaleRange(coin, low, high) {
  if (!isHip3Coin(coin)) return false;
  const currentPx = getCurrentPrice() || Number(getAllMids()[coin] || 0);
  if (!Number.isFinite(currentPx) || currentPx <= 0) return false;
  const minPx = Math.min(low, high);
  const maxPx = Math.max(low, high);
  return minPx < currentPx * 0.1 || maxPx > currentPx * 10;
}

export function roundPriceToTick(price, coin) {
  const tickSize = getTickSize(coin) || 0.001;
  const tickDecimals = getPriceFormatDecimals(coin);
  let rounded = Math.round(price / tickSize) * tickSize;
  if (tickDecimals > 0) {
    rounded = parseFloat(rounded.toFixed(tickDecimals));
  }
  return alignPriceWithWireRounding(rounded, coin);
}

// Mirrors backend normalizePerpPrice so a dragged label shows the price the
// exchange actually receives: integers stay exact; fractional prices take the
// stricter of 5 significant figures and 6-szDecimals places. Official HL
// tick/lot rule for all perps, not just HIP-3.
function alignPriceWithWireRounding(price, coin) {
  if (!Number.isFinite(price) || price <= 0) return price;
  if (price === Math.trunc(price)) return price;
  const maxDecimals = Math.max(0, 6 - (getCoinDecimals(coin) || 0));
  const sigDecimals = Math.max(0, 4 - Math.floor(Math.log10(Math.abs(price))));
  const decimals = Math.min(maxDecimals, sigDecimals);
  const scale = 10 ** decimals;
  return Math.round(price * scale) / scale;
}

export function getPriceFormatDecimals(coin) {
  const tickSize = getTickSize(coin) || 0.001;
  if (!Number.isFinite(tickSize) || tickSize <= 0 || tickSize >= 1) return 0;
  const tickString = tickSize.toString().toLowerCase();
  if (tickString.includes('e-')) {
    const exponent = Number.parseInt(tickString.split('e-')[1], 10);
    return Number.isFinite(exponent) ? exponent : 0;
  }
  return tickString.split('.')[1]?.length || 0;
}

export function wouldReducePosition(coin, side) {
  const accountState = getAccountState();
  const pos = accountState?.assetPositions?.find((entry) => entry.position.coin === coin);
  if (!pos) return false;
  const posSize = parseFloat(pos.position.szi);
  if (posSize === 0) return false;
  return (posSize < 0 && side === 'buy') || (posSize > 0 && side === 'sell');
}
