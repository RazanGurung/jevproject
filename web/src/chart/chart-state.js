/**
 * Chart state - chart-local mutable state
 */

let chartCanvas = null;
let chartCtx = null;
let viewStart = 0;
let viewCount = 80;
function initChartState() {
  const canvas = document.getElementById('chartCanvas');
  if (canvas) {
    chartCanvas = canvas;
    chartCtx = canvas.getContext('2d');
    window.chartCanvas = canvas;
    window.chartCtx = chartCtx;
  }
}

function setViewStart(start) {
  viewStart = start;
}

function getViewStart() {
  return viewStart;
}

function setViewCount(count) {
  viewCount = count;
}

function getViewCount() {
  return viewCount;
}

export {
  initChartState,
  setViewStart,
  getViewStart,
  setViewCount,
  getViewCount,
  chartCanvas,
  chartCtx,
  viewStart,
  viewCount,
};
