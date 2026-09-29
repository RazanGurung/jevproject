import { getPaletteColor, hexToRgb } from '../services/color-palette.js';

export const DEFAULT_AVWAP_HEX = '#306eb5';
export const DEFAULT_RVWAP_RGB = '48, 110, 181';

export function rollingVwapColor(opacity = 1) {
  const rgb = hexToRgb(getPaletteColor('rvwap') || DEFAULT_AVWAP_HEX);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
}

export function rollingVwapBandColor(opacity = 1) {
  const rgb = hexToRgb(getPaletteColor('rvwapBand') || getPaletteColor('rvwap') || DEFAULT_AVWAP_HEX);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
}

export function rollingVwapBandHex() {
  return (getPaletteColor('rvwapBand') || getPaletteColor('rvwap') || DEFAULT_AVWAP_HEX).toLowerCase();
}

export function anchoredVwapHex() {
  return (getPaletteColor('avwap') || DEFAULT_AVWAP_HEX).toLowerCase();
}

export function anchoredVwapBandHex() {
  return (getPaletteColor('avwapBand') || getPaletteColor('avwap') || DEFAULT_AVWAP_HEX).toLowerCase();
}
