function createChartRenderScheduler({
  requestAnimationFrameImpl = globalThis.requestAnimationFrame,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  now = () => performance.now(),
  throttleMs = 16,
  rafWatchdogMs = 120,
  onDraw,
} = {}) {
  let lastChartRenderTime = 0;
  let chartRenderQueued = false;
  let chartRenderRetryTimer = null;
  let rafWatchdogTimer = null;

  function clearWatchdog() {
    if (rafWatchdogTimer != null) {
      clearTimeoutImpl(rafWatchdogTimer);
      rafWatchdogTimer = null;
    }
  }

  function drawNow() {
    clearWatchdog();
    if (chartRenderRetryTimer) {
      clearTimeoutImpl(chartRenderRetryTimer);
      chartRenderRetryTimer = null;
    }
    chartRenderQueued = false;
    lastChartRenderTime = now();
    onDraw?.();
  }

  function requestDraw() {
    const request = typeof requestAnimationFrameImpl === 'function'
      ? requestAnimationFrameImpl
      : (cb) => setTimeoutImpl(cb, 0);
    request(() => {
      // A freeze/sleep can drop the rAF while a watchdog or flush already drew.
      if (!chartRenderQueued) return;
      drawNow();
    });
    clearWatchdog();
    if (rafWatchdogMs > 0) {
      rafWatchdogTimer = setTimeoutImpl(() => {
        rafWatchdogTimer = null;
        if (!chartRenderQueued) return;
        drawNow();
      }, rafWatchdogMs);
    }
  }

  function scheduleChartRender() {
    if (chartRenderQueued) return;
    chartRenderQueued = true;

    const remaining = throttleMs - (now() - lastChartRenderTime);
    if (remaining <= 0) {
      if (chartRenderRetryTimer) {
        clearTimeoutImpl(chartRenderRetryTimer);
        chartRenderRetryTimer = null;
      }
      requestDraw();
      return;
    }

    chartRenderRetryTimer = setTimeoutImpl(() => {
      chartRenderRetryTimer = null;
      requestDraw();
    }, remaining);
  }

  function flushChartRender() {
    drawNow();
  }

  return {
    scheduleChartRender,
    flushChartRender,
  };
}

export {
  createChartRenderScheduler,
};
