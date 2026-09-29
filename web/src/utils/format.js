/**
 * Format utilities - number and display formatting helpers
 */

import { getCoinDecimals } from '../state/coin-meta.js';

function getHyperliquidPriceDecimals(n, coin) {
  const value = Number.parseFloat(n);
  if (!Number.isFinite(value) || value <= 0 || !coin) return null;

  const szDecimals = Number.parseInt(getCoinDecimals(coin), 10);
  if (!Number.isFinite(szDecimals)) return null;

  const maxDecimals = Math.max(0, 6 - szDecimals);
  const significantFigureDecimals = Math.max(0, 4 - Math.floor(Math.log10(Math.abs(value))));
  return Math.min(maxDecimals, significantFigureDecimals);
}

function fmtPrice(n, coin, options = {}) {
  if (n == null || isNaN(n)) return '—';
  const value = parseFloat(n);
  const decimals = getHyperliquidPriceDecimals(value, coin);
  const resolvedDecimals = Number.isInteger(decimals) ? decimals : 2;
  const scale = Math.pow(10, resolvedDecimals);
  const normalizedValue = Number.isInteger(decimals) ? Number(value.toPrecision(15)) : value;
  const rounded = Number.isInteger(decimals)
    ? Math.round(normalizedValue * scale) / scale
    : value;
  const formatted = rounded.toFixed(resolvedDecimals);
  const trimTrailingZeros = options.trimTrailingZeros ?? Number.isInteger(decimals);
  return trimTrailingZeros === false
    ? formatted
    : formatted.includes('.')
      ? formatted.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
      : formatted;
}

function fmtInputPrice(n, options = {}) {
  if (n == null || isNaN(n)) return '';
  const value = parseFloat(n);
  if (!Number.isFinite(value) || value <= 0) return '';

  const decimals = Number.isInteger(options.decimals)
    ? options.decimals
    : value >= 1000
      ? 2
      : value >= 1
        ? 4
        : 6;

  const formatted = value.toFixed(decimals);
  return options.trimTrailingZeros === false
    ? formatted
    : formatted.replace(/\.?0+$/, '');
}

// Compact volume notation (e.g. 1.23B, 4.56M, 7.89K). Shared by all volume formatters.
function compactVolume(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}

function fmtVol(n) {
  if (n == null || isNaN(n)) return '—';
  return compactVolume(n);
}

// Identical behavior to fmtVol; retained as a named export for existing callers.
const fmtVolAlways = fmtVol;

function fmtPct(n, hideValues = false) {
  if (hideValues) return 'xxxx%';
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + parseFloat(n).toFixed(2) + '%';
}

export {
  fmtPrice,
  getHyperliquidPriceDecimals,
  fmtInputPrice,
  fmtVol,
  fmtVolAlways,
  fmtPct,
};
