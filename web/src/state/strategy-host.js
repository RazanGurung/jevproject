/**
 * Strategy host seam: app code and strategies resolve chart/bot/manager deps
 * through this module. Stage 3 Slice B prefers explicitly injected module refs;
 * window.* remains a fallback for tests and late/optional publishers.
 */

function getHostWindow() {
  return globalThis.window || null;
}

function getHostValue(key) {
  return getHostWindow()?.[key] ?? null;
}

function getHostFunction(key) {
  const value = getHostValue(key);
  return typeof value === 'function' ? value : null;
}

/** @type {Record<string, unknown>} */
const hostDeps = {
  strategyHelpers: null,
  chartService: null,
  priceFeed: null,
  strategyManager: null,
  botModule: null,
  botRuntime: null,
  refreshBotStatus: null,
  applyBotStatus: null,
  loadBotStrategy: null,
  updateTotals: null,
  updateBotConfigFromInputs: null,
  onAccountStreamConnectionStateChange: null,
  botLog: null,
};

/**
 * Merge injected module/function refs. Called after strategy modules load and
 * after initBotUI so production does not rely on window name resolution.
 * Unknown keys are ignored. Pass null to clear a slot.
 */
function setStrategyHostDeps(deps = {}) {
  if (!deps || typeof deps !== 'object') return { ...hostDeps };
  for (const [key, value] of Object.entries(deps)) {
    if (Object.prototype.hasOwnProperty.call(hostDeps, key)) {
      hostDeps[key] = value;
    }
  }
  return { ...hostDeps };
}

function clearStrategyHostDeps() {
  for (const key of Object.keys(hostDeps)) {
    hostDeps[key] = null;
  }
}

function resolveDep(key, windowKey, { preferFunction = false } = {}) {
  const injected = hostDeps[key];
  if (injected != null) {
    if (preferFunction && typeof injected !== 'function') {
      // fall through to window
    } else {
      return injected;
    }
  }
  if (preferFunction) return getHostFunction(windowKey);
  return getHostValue(windowKey);
}

function getStrategyHelpers() {
  return resolveDep('strategyHelpers', 'StrategyHelpers');
}

function getChartService() {
  return resolveDep('chartService', 'ChartLayers');
}

function getPriceFeed() {
  return resolveDep('priceFeed', 'PriceFeed');
}

function getStrategyManager() {
  return resolveDep('strategyManager', 'StrategyManager');
}

function getBotModule() {
  return resolveDep('botModule', 'botModule');
}

function getBotRuntime() {
  return resolveDep('botRuntime', 'BOT');
}

function getBotStatusRefresher() {
  return resolveDep('refreshBotStatus', 'refreshBotStatus', { preferFunction: true });
}

function getBotStatusApplier() {
  return resolveDep('applyBotStatus', 'applyBotStatus', { preferFunction: true });
}

function getBotStrategyLoader() {
  return resolveDep('loadBotStrategy', 'loadBotStrategy', { preferFunction: true });
}

function getBotTotalsUpdater() {
  return resolveDep('updateTotals', 'updateTotals', { preferFunction: true });
}

function getBotConfigInputSyncer() {
  return resolveDep('updateBotConfigFromInputs', 'updateBotConfigFromInputs', { preferFunction: true });
}

function getAccountStreamConnectionStateHandler() {
  return resolveDep('onAccountStreamConnectionStateChange', 'onAccountStreamConnectionStateChange', {
    preferFunction: true,
  });
}

function getLogger() {
  const injected = hostDeps.botLog;
  if (typeof injected === 'function') return injected;
  return getHostFunction('botLog') || function(message, type) {
    console.log('[Strategy][' + (type || 'info') + '] ' + message);
  };
}

function persistStrategyState(strategyName, key, data) {
  const helpers = getStrategyHelpers();
  if (helpers?.saveStrategyState) {
    helpers.saveStrategyState(strategyName, key, data);
    return;
  }
  const storageKey = 'strat_' + strategyName + '_' + key;
  localStorage.setItem(storageKey, JSON.stringify(data));
}

function loadStrategyState(strategyName, key) {
  const helpers = getStrategyHelpers();
  if (helpers?.loadStrategyState) {
    return helpers.loadStrategyState(strategyName, key);
  }
  const storageKey = 'strat_' + strategyName + '_' + key;
  const raw = localStorage.getItem(storageKey);
  return raw ? JSON.parse(raw) : null;
}

function clearStrategyState(strategyName, key) {
  const helpers = getStrategyHelpers();
  if (helpers?.clearStrategyState) {
    helpers.clearStrategyState(strategyName, key);
    return;
  }
  if (key) {
    localStorage.removeItem('strat_' + strategyName + '_' + key);
    return;
  }
  const prefix = 'strat_' + strategyName + '_';
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const currentKey = localStorage.key(i);
    if (currentKey && currentKey.indexOf(prefix) === 0) {
      keysToRemove.push(currentKey);
    }
  }
  keysToRemove.forEach((currentKey) => localStorage.removeItem(currentKey));
}

function installStrategyHostBridge() {
  const hostWindow = getHostWindow();
  if (!hostWindow) return null;
  hostWindow.PezStrategyHost = {
    getStrategyHelpers,
    getChartService,
    getPriceFeed,
    getStrategyManager,
    getBotModule,
    getBotRuntime,
    getBotStatusRefresher,
    getBotStatusApplier,
    getBotStrategyLoader,
    getBotTotalsUpdater,
    getBotConfigInputSyncer,
    getAccountStreamConnectionStateHandler,
    getLogger,
    persistStrategyState,
    loadStrategyState,
    clearStrategyState,
  };
  return hostWindow.PezStrategyHost;
}

export {
  getStrategyHelpers,
  getChartService,
  getPriceFeed,
  getStrategyManager,
  getBotModule,
  getBotRuntime,
  getBotStatusRefresher,
  getBotStatusApplier,
  getBotStrategyLoader,
  getBotTotalsUpdater,
  getBotConfigInputSyncer,
  getAccountStreamConnectionStateHandler,
  getLogger,
  persistStrategyState,
  loadStrategyState,
  clearStrategyState,
  setStrategyHostDeps,
  clearStrategyHostDeps,
  installStrategyHostBridge,
};
