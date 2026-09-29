import { updateChartLevels } from '../chart/chart-levels.js';
import { scheduleChartRender } from '../chart/chart-render.js';
import { scheduleRender } from '../render/scheduler.js';

// Keep optimistic order/position mutations visually coherent by refreshing the
// derived chart levels first, then scheduling the account + chart renders.
function syncLocalTradingVisualState() {
  updateChartLevels();
  scheduleRender();
  scheduleChartRender();
}

export {
  syncLocalTradingVisualState,
};
