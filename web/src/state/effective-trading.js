import { getWalletAddress } from './account-selectors.js';
import {
  getCurrentCoin,
  getCurrentOrderType,
  getCurrentPrice,
  getCurrentSide,
  getCurrentTimeframe,
} from './trading-selectors.js';

export function getEffectiveCurrentCoin() {
  return getCurrentCoin();
}

export function getEffectiveCurrentSide() {
  return getCurrentSide();
}

export function getEffectiveCurrentOrderType() {
  return getCurrentOrderType();
}

export function getEffectiveCurrentTimeframe() {
  return getCurrentTimeframe();
}

export function getEffectiveCurrentPrice() {
  return getCurrentPrice();
}

export function getEffectiveWalletAddress() {
  return getWalletAddress();
}
