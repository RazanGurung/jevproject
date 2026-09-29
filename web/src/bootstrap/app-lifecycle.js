export function renderActiveBottomTab({
  getActiveTab,
  renderPositions,
  renderOrders,
  renderTrades,
  renderFills,
}) {
  const activeTab = getActiveTab();
  if (activeTab === 'positions') renderPositions();
  else if (activeTab === 'orders') renderOrders();
  else if (activeTab === 'trades') renderTrades();
  else if (activeTab === 'fills') renderFills();
}

export function createBeforeUnloadHandler({
  getBotModule,
  stopBotModule,
  clearPrivateKey,
  getAccountStreamSocket,
  clearAccountStreamSocket,
  disconnectAccountStream,
	getMarketStreamSocket,
	disconnectMarketStream,
  stop24hPolling,
  stopTopMoversPolling,
  stopMispricingPolling,
  stopPreloadHints,
  stopCvdAlertMonitor,
  stopNewsPolling,
}) {
  return function onBeforeUnload() {
    const botModule = getBotModule();
    if (botModule && stopBotModule) {
      stopBotModule(botModule);
    }

    clearPrivateKey();

    if (typeof disconnectAccountStream === 'function') {
      disconnectAccountStream();
    } else {
      const accountStreamSocket = getAccountStreamSocket?.();
      if (accountStreamSocket) {
        accountStreamSocket.close();
        clearAccountStreamSocket?.();
      }
    }

	if (getMarketStreamSocket?.()) {
	  disconnectMarketStream?.();
	}

    stop24hPolling();
    if (stopTopMoversPolling) stopTopMoversPolling();
    if (stopMispricingPolling) stopMispricingPolling();
    if (stopPreloadHints) stopPreloadHints();
    if (stopCvdAlertMonitor) stopCvdAlertMonitor();
    stopNewsPolling();
  };
}
