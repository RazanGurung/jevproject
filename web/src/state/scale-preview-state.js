import { AppState } from './store.js';

function getScalePreviewOrders() {
  return Array.isArray(AppState.ui.scalePreviewOrders) ? AppState.ui.scalePreviewOrders : null;
}

function setScalePreviewOrders(orders) {
  const nextOrders = Array.isArray(orders) ? orders : null;
  AppState.ui.scalePreviewOrders = nextOrders;
  return nextOrders;
}

function clearScalePreviewOrders() {
  return setScalePreviewOrders(null);
}

function hasScalePreviewOrders() {
  const orders = getScalePreviewOrders();
  return Array.isArray(orders) && orders.length > 0;
}

export {
  clearScalePreviewOrders,
  getScalePreviewOrders,
  hasScalePreviewOrders,
  setScalePreviewOrders,
};
