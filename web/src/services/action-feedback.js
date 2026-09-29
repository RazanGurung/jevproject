import { scheduleChartRender } from '../chart/chart-render.js';
import { debouncedFetchAccount } from './account-service.js';
import { showToast } from '../ui/toast.js';

function requestAccountEnrichment() {
  debouncedFetchAccount();
}

function requestAuthoritativeAccountRefresh() {
  debouncedFetchAccount(true);
}

function notifySuccess(message, { refreshAccount = false, refreshChart = false } = {}) {
  showToast(message, false);
  if (refreshAccount) requestAuthoritativeAccountRefresh();
  if (refreshChart) scheduleChartRender();
}

export {
  requestAccountEnrichment,
  requestAuthoritativeAccountRefresh,
  notifySuccess,
};
