function getHostWindow() {
  return globalThis.window || null;
}

function getHostFunction(key) {
  const value = getHostWindow()?.[key];
  return typeof value === 'function' ? value : null;
}

function getConnectModalOpener() {
  return getHostFunction('showConnectModal');
}

function getOrderPreviewFetcher() {
  return getHostFunction('fetchOrderPreview');
}

function getCoinSwitcher() {
  return getHostFunction('switchCoin');
}

function getSizeSliderMaxUpdater() {
  return getHostFunction('updateSizeSliderMax');
}

function getMobileChartActionBarSyncer() {
  return getHostFunction('syncMobileChartActionBar');
}

function installAppHostBridge() {
  const hostWindow = getHostWindow();
  if (!hostWindow) return null;
  hostWindow.PezAppHost = {
    getConnectModalOpener,
    getOrderPreviewFetcher,
    getCoinSwitcher,
    getSizeSliderMaxUpdater,
    getMobileChartActionBarSyncer,
  };
  return hostWindow.PezAppHost;
}

export {
  getConnectModalOpener,
  getOrderPreviewFetcher,
  getCoinSwitcher,
  getSizeSliderMaxUpdater,
  getMobileChartActionBarSyncer,
  installAppHostBridge,
};
