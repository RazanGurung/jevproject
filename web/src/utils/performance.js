function uiPerformanceEnabled() {
  return globalThis.__PEZ_PERF_ENABLED__ === true;
}

function markUiPerformance(name, detail = {}) {
  if (!uiPerformanceEnabled()) return;
  try {
    globalThis.performance?.mark?.(`pez:${name}`, { detail });
  } catch {
    // Diagnostics must never affect the trading UI.
  }
}

function recordUiAction(action, startedAt, detail = {}) {
  if (!uiPerformanceEnabled()) return;
  const endedAt = globalThis.performance?.now?.() ?? startedAt;
  const payload = {
    action: String(action || ''),
    durationMs: Math.max(0, endedAt - startedAt),
    ...detail,
  };
  markUiPerformance('action', payload);
  try {
    globalThis.dispatchEvent?.(new CustomEvent('pez:ui-action-metric', { detail: payload }));
  } catch {
    // CustomEvent is unavailable in some unit-test runtimes.
  }
}

export {
  markUiPerformance,
  recordUiAction,
  uiPerformanceEnabled,
};
