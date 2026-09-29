let runtimePromise = null;
let idleHandle = null;

function loadOptionalTradingRuntime() {
  if (!runtimePromise) {
    runtimePromise = import('./optional-trading-runtime.js')
      .then((module) => {
        module.initOptionalTradingRuntime();
        return module;
      })
      .catch((error) => {
        runtimePromise = null;
        console.error('Optional trading runtime failed to load:', error);
        throw error;
      });
  }
  return runtimePromise;
}

function scheduleOptionalTradingRuntime() {
  if (runtimePromise || idleHandle !== null) return;
  const start = () => {
    idleHandle = null;
    loadOptionalTradingRuntime().catch(() => {});
  };
  if (typeof globalThis.requestIdleCallback === 'function') {
    idleHandle = globalThis.requestIdleCallback(start, { timeout: 1_500 });
  } else {
    idleHandle = globalThis.setTimeout(start, 250);
  }
}

function invokeOptionalBotAction(name, ...args) {
  return loadOptionalTradingRuntime().then((module) => module.invokeBotAction(name, args));
}

export {
  invokeOptionalBotAction,
  loadOptionalTradingRuntime,
  scheduleOptionalTradingRuntime,
};
