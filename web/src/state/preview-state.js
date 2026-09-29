/**
 * Unified preview state surface.
 *
 * Preview state is split between two canonical slices:
 *
 *   AppState.ui.chartPreviewLevels  — horizontal lines drawn on the chart
 *                                     (used by limit/scale/TP-SL previews)
 *   AppState.ui.scalePreviewOrders  — concrete order rows the scale executor
 *                                     will submit when "Place" is clicked
 *
 * This module re-exports the per-slice accessors so callers have one import
 * site for preview ownership, and adds two cross-cutting helpers:
 *
 *   PREVIEW_TYPE   — explicit preview kinds for callers that need to label
 *                    line groups (LIMIT, SCALE, TPSL)
 *   clearAllPreview — atomic reset of every preview slice (used on coin
 *                     switch, logout, order-type change away from limit/scale)
 */

import {
  clearChartPreviewLevels,
  getChartPreviewLevels,
  setChartPreviewLevels,
} from '../chart/chart-preview-state.js';
import {
  clearScalePreviewOrders,
  getScalePreviewOrders,
  hasScalePreviewOrders,
  setScalePreviewOrders,
} from './scale-preview-state.js';

const PREVIEW_TYPE = Object.freeze({
  LIMIT: 'limit',
  SCALE: 'scale',
  TPSL: 'tpsl',
});

function clearAllPreview() {
  clearChartPreviewLevels();
  clearScalePreviewOrders();
}

export {
  PREVIEW_TYPE,
  clearAllPreview,
  clearChartPreviewLevels,
  clearScalePreviewOrders,
  getChartPreviewLevels,
  getScalePreviewOrders,
  hasScalePreviewOrders,
  setChartPreviewLevels,
  setScalePreviewOrders,
};
