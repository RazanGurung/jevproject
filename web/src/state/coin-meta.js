/**
 * Coin metadata - coin decimal, tick size, and leverage defaults
 */

import { apiGet } from '../services/api.js';
import { isHip3Coin } from '../utils/helpers.js';

let COIN_DECIMALS = {};
let REMOTE_MAX_LEVERAGE = {};

let TICK_SIZES = {
  'BTC': 0.5, 'ETH': 0.05, 'SOL': 0.001, 'HYPE': 0.01,
  'AVAX': 0.01, 'LINK': 0.001, 'XRP': 0.0001, 'DOGE': 0.00001,
  'ARB': 0.001, 'OP': 0.001, 'MATIC': 0.0001, 'ATOM': 0.001,
  'NEAR': 0.001, 'APT': 0.001, 'TIA': 0.01, 'INJ': 0.01,
  'SUI': 0.0001, 'WIF': 0.001, 'FLOKI': 0.000001, 'BONK': 0.000001,
  'SEI': 0.001, 'DOT': 0.001, 'UNI': 0.001, 'LTC': 0.01,
  'BCH': 0.01, 'RUNE': 0.001, 'FET': 0.001, 'TAO': 0.01,
  'ADA': 0.0001, 'PEPE': 0.00000001,
  'xyz:GOLD': 0.1, 'xyz:SILVER': 0.01, 'xyz:CL': 0.01, 'xyz:XYZ100': 1.0,
  'xyz:NVDA': 0.01, 'xyz:TSLA': 0.01, 'xyz:SP500': 0.1, 'xyz:JPY': 0.001,
  'xyz:GOOGL': 0.01, 'xyz:AMZN': 0.01, 'xyz:AAPL': 0.01, 'xyz:META': 0.01
};

let MAX_LEVERAGE = {
  'BTC': 40, 'ETH': 25, 'SOL': 20, 'XRP': 40, 'HYPE': 40,
  'INJ': 30, 'DOGE': 30, 'AVAX': 30, 'LINK': 30, 'ARB': 30,
  'ADA': 30, 'DOT': 30, 'UNI': 30, 'LTC': 30, 'BCH': 30,
  'MATIC': 30, 'ATOM': 30, 'NEAR': 30, 'SUI': 20, 'APT': 20,
  'OP': 20, 'TIA': 20, 'TAO': 20, 'SEI': 20, 'RUNE': 20, 'FET': 20,
  'PEPE': 12, 'FLOKI': 12, 'BONK': 12, 'BOME': 12, 'WIF': 12,
  'xyz:GOLD': 50, 'xyz:SILVER': 50, 'xyz:CL': 50, 'xyz:XYZ100': 50,
  'xyz:SP500': 50, 'xyz:NVDA': 20, 'xyz:TSLA': 20, 'xyz:JPY': 50,
  'xyz:GOOGL': 20, 'xyz:AMZN': 20, 'xyz:AAPL': 20, 'xyz:META': 20,
  'DEFAULT': 25
};

const OFFICIAL_MAX_LEVERAGE_OVERRIDES = {
  'xyz:CL': 20,
};

const XYZ_FALLBACK_MAX_LEVERAGE = 20;

async function loadCoinMeta() {
  try {
    const d = await apiGet('/api/coin-meta');
    COIN_DECIMALS = d.szDecimals || {};
    TICK_SIZES = { ...TICK_SIZES, ...(d.tickSizes || {}) };
    REMOTE_MAX_LEVERAGE = d.maxLeverage || {};
    MAX_LEVERAGE = { ...MAX_LEVERAGE, ...REMOTE_MAX_LEVERAGE };
  } catch(e) {
    console.error('Failed to load coin meta:', e);
    COIN_DECIMALS = {'BTC': 5, 'ETH': 4, 'SOL': 2};
  }
}

function getCoinDecimals(coin) {
  return COIN_DECIMALS[coin] || 3;
}

function getTickSize(coin) {
  return TICK_SIZES[coin] || 0.001;
}

function getMaxLeverage(coin) {
  if (!coin) return MAX_LEVERAGE.DEFAULT;
  if (OFFICIAL_MAX_LEVERAGE_OVERRIDES[coin]) return OFFICIAL_MAX_LEVERAGE_OVERRIDES[coin];

  const remote = parseInt(REMOTE_MAX_LEVERAGE[coin], 10);
  if (Number.isFinite(remote) && remote > 0) return remote;

  if (isHip3Coin(coin)) return XYZ_FALLBACK_MAX_LEVERAGE;

  return MAX_LEVERAGE[coin] || MAX_LEVERAGE.DEFAULT;
}

function getCoinMeta() {
  return { COIN_DECIMALS, TICK_SIZES, MAX_LEVERAGE, REMOTE_MAX_LEVERAGE };
}

export {
  loadCoinMeta,
  getCoinDecimals,
  getTickSize,
  getMaxLeverage,
  getCoinMeta,
  COIN_DECIMALS,
  TICK_SIZES,
  MAX_LEVERAGE
};
