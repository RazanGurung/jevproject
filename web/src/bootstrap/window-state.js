/**
 * Stage 3 Slice C: do not dual-write AppState onto window.
 * Only install host-facing function globals and chart canvas placeholders
 * that production still resolves by name.
 */
export function initializeWindowState(_AppState) {
  if (typeof window === 'undefined') return;
  // Chart load session still resolves canvas via window when present.
  if (window.chartCanvas === undefined) window.chartCanvas = null;
  if (window.chartCtx === undefined) window.chartCtx = null;
}

export function installRuntimeGlobals({
  switchCoin,
  syncMobileChartActionBar,
} = {}) {
  if (typeof window === 'undefined') return;
  if (typeof switchCoin === 'function') {
    window.switchCoin = switchCoin;
  }
  if (typeof syncMobileChartActionBar === 'function') {
    window.syncMobileChartActionBar = syncMobileChartActionBar;
  }
}
