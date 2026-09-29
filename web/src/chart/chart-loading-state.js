import { resolveAppFloorColor } from './lightweight-chart-theme.js';

function getChartOverlayState({
  candles = [],
  chartSession = {},
  legacyLoadingFlag = false,
  hasChartLevels = false,
  fallbackNotice = '',
} = {}) {
  const showLoadingState = candles.length === 0 && (
    chartSession.status === 'loading' || legacyLoadingFlag === true
  );
  const chartNotice = !showLoadingState && candles.length === 0
    ? String(chartSession.status === 'notice' ? chartSession.message : (fallbackNotice || ''))
    : '';
  const shouldShowOverlay = showLoadingState || !!chartNotice || (!candles.length && !hasChartLevels);

  return {
    chartNotice,
    overlayText: showLoadingState ? 'Loading...' : (chartNotice || 'Loading...'),
    shouldShowOverlay,
    showLoadingState,
  };
}

function drawChartLoadingState(ctx, W, H, {
  overlayOnly = false,
  text = 'Loading...',
} = {}) {
  if (!overlayOnly) {
    ctx.fillStyle = resolveAppFloorColor();
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(W / 2 - 44, H / 2 - 14, 88, 24);
  }
  ctx.fillStyle = '#555555';
  ctx.font = '12px IBM Plex Mono';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2);
}

export {
  drawChartLoadingState,
  getChartOverlayState,
};
