import { AppState } from './store.js';

function setUserEditedPrice(value) {
  const nextValue = value === true;
  AppState.ui.userEditedPrice = nextValue;
  return nextValue;
}

function setLimitPriceEntryMode(mode) {
  const nextMode = mode === 'manual' ? 'manual' : 'auto';
  AppState.ui.limitPriceEntryMode = nextMode;
  return nextMode;
}

function getLimitPriceEntryMode() {
  return AppState.ui.limitPriceEntryMode === 'manual' ? 'manual' : 'auto';
}

function getUserEditedPrice() {
  return AppState.ui.userEditedPrice === true;
}

function setLimitPriceAutoTrack(value) {
  const nextValue = value !== false;
  AppState.ui.limitPriceAutoTrack = nextValue;
  return nextValue;
}

function isLimitPriceAutoTrackEnabled() {
  return AppState.ui.limitPriceAutoTrack !== false;
}

function setLimitPreviewAutoTrack(value) {
  const nextValue = value !== false;
  AppState.ui.limitPreviewAutoTrack = nextValue;
  return nextValue;
}

function isLimitPreviewAutoTrackEnabled() {
  return AppState.ui.limitPreviewAutoTrack !== false;
}

function setLimitAutoTrackForTimeframe(timeframe) {
  const enabled = timeframe === '1m';
  setLimitPriceAutoTrack(enabled);
  setLimitPreviewAutoTrack(enabled);
  return enabled;
}

function setActiveCandleRequestToken(token) {
  AppState.ui.activeCandleRequestToken = token ?? null;
  return AppState.ui.activeCandleRequestToken;
}

function getActiveCandleRequestToken() {
  return AppState.ui.activeCandleRequestToken ?? null;
}

export {
  getActiveCandleRequestToken,
  getLimitPriceEntryMode,
  getUserEditedPrice,
  isLimitPreviewAutoTrackEnabled,
  isLimitPriceAutoTrackEnabled,
  setActiveCandleRequestToken,
  setLimitAutoTrackForTimeframe,
  setLimitPriceEntryMode,
  setLimitPreviewAutoTrack,
  setLimitPriceAutoTrack,
  setUserEditedPrice,
};
