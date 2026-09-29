/**
 * Shared Lightweight Charts navigation options.
 *
 * Drawing tools and manual AVWAP disable pan/zoom while armed or dragging via
 * handleScroll/handleScale. Re-enabling must restore the full object form used
 * by the theme — boolean `true` is weaker and can leave a broken interaction
 * surface after a mid-gesture reconnect (lost pointerup).
 */

const ENABLED_HANDLE_SCROLL = Object.freeze({
  mouseWheel: true,
  pressedMouseMove: true,
  horzTouchDrag: true,
  vertTouchDrag: true,
});

const ENABLED_HANDLE_SCALE = Object.freeze({
  axisPressedMouseMove: true,
  axisDoubleClickReset: true,
  mouseWheel: true,
  pinch: true,
});

function chartNavigationOptions(enabled) {
  if (enabled) {
    return {
      handleScroll: { ...ENABLED_HANDLE_SCROLL },
      handleScale: { ...ENABLED_HANDLE_SCALE },
    };
  }
  return {
    handleScroll: false,
    handleScale: false,
  };
}

function applyChartNavigation(chart, enabled) {
  if (!chart || typeof chart.applyOptions !== 'function') return false;
  try {
    chart.applyOptions(chartNavigationOptions(enabled));
    return true;
  } catch {
    return false;
  }
}

export {
  ENABLED_HANDLE_SCROLL,
  ENABLED_HANDLE_SCALE,
  applyChartNavigation,
  chartNavigationOptions,
};
