import { scheduleFrame } from '../utils/frame.js';

let pending = null;
let frameHandle = null;
let flushCount = 0;

function mark(name, detail) {
  try {
    performance.mark(name, detail === undefined ? undefined : { detail });
  } catch {
    // Performance marks are diagnostics only.
  }
}

function chartIsVisible() {
  const layout = document.getElementById('mainLayout');
  if (!layout?.classList.contains('is-mobile')) return true;
  return layout.dataset.mobileView === 'chart';
}

function bookIsVisible() {
  const layout = document.getElementById('mainLayout');
  if (!layout?.classList.contains('is-mobile')) return true;
  return layout.dataset.mobileView === 'book';
}

function mergeRequest(next = {}) {
  if (!pending) {
    pending = {
      chart: false,
      book: false,
      reason: '',
    };
  }
  pending.chart ||= next.chart === true;
  pending.book ||= next.book === true;
  if (next.reason) pending.reason = String(next.reason);
}

async function flushLayoutRender() {
  frameHandle = null;
  const request = pending;
  pending = null;
  if (!request) return;

  const flushId = ++flushCount;
  mark('pez:layout-flush-start', { id: flushId, ...request });

  // Module promises are normally already resolved because main.js owns these
  // modules. Promise.all still prevents three independent microtasks from
  // repainting the Book view at different times.
  if (request.book && bookIsVisible()) {
    const [trades, ladder] = await Promise.all([
      import('./trades.js'),
      import('./dom-ladder.js'),
    ]);
    trades.renderOrderFlow?.();
    ladder.renderDomLadder?.();
    trades.renderLiquidations?.();
  }

  // A hidden mobile chart needs no resize/re-level work. Lightweight Charts
  // will be refreshed when the Chart view becomes visible again.
  if (request.chart && chartIsVisible()) {
    const [levels, chart] = await Promise.all([
      import('../chart/chart-levels.js'),
      import('../chart/chart-render.js'),
    ]);
    levels.updateChartLevels?.();
    chart.scheduleChartRender?.();
  }

  mark('pez:layout-flush-end', { id: flushId, ...request });
}

function scheduleLayoutRender(request = {}) {
  mergeRequest(request);
  mark('pez:layout-request', request);
  if (frameHandle !== null) return;
  frameHandle = scheduleFrame(() => {
    void flushLayoutRender();
  });
}

function getLayoutSchedulerDebugState() {
  return {
    queued: frameHandle !== null,
    pending: pending ? { ...pending } : null,
    flushCount,
  };
}

function resetLayoutSchedulerForTests() {
  pending = null;
  frameHandle = null;
  flushCount = 0;
}

export {
  flushLayoutRender,
  getLayoutSchedulerDebugState,
  resetLayoutSchedulerForTests,
  scheduleLayoutRender,
};
