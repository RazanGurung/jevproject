import { AppState } from '../state/store.js';
import { syncPreviewLines } from './lightweight-chart.js';

function getChartPreviewLevels() {
  return Array.isArray(AppState.ui.chartPreviewLevels) ? AppState.ui.chartPreviewLevels : [];
}

function setChartPreviewLevels(levels) {
  const nextLevels = Array.isArray(levels) ? levels : [];
  AppState.ui.chartPreviewLevels = nextLevels;
  syncPreviewLines(nextLevels);
  return nextLevels;
}

function clearChartPreviewLevels() {
  return setChartPreviewLevels([]);
}

export {
  getChartPreviewLevels,
  setChartPreviewLevels,
  clearChartPreviewLevels,
};
