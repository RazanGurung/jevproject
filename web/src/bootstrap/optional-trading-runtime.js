import { setStrategyHostDeps } from '../state/strategy-host.js';
import {
  applyBotStatus,
  botLog,
  getBotRuntime,
  initBotUI,
  loadBotStrategy,
  onAccountStreamConnectionStateChange,
  refreshBotStatus,
  updateBotConfigFromInputs,
  updateTotals,
} from '../services/bot.js';
import { PriceFeed } from '../strategies/price-feed.js';
import { initJevUI } from '../services/jev-service.js';

let initialized = false;

function initOptionalTradingRuntime() {
  if (initialized) return;
  initialized = true;

  setStrategyHostDeps({
    priceFeed: PriceFeed,
  });
  initBotUI();
  initJevUI();
  setStrategyHostDeps({
    botRuntime: getBotRuntime(),
    refreshBotStatus,
    applyBotStatus,
    loadBotStrategy,
    updateTotals,
    updateBotConfigFromInputs,
    onAccountStreamConnectionStateChange,
    botLog,
  });
}

function invokeBotAction(name, args = []) {
  initOptionalTradingRuntime();
  const action = globalThis.window?.[name];
  if (typeof action !== 'function') {
    throw new Error(`Optional bot action unavailable: ${name}`);
  }
  return action(...args);
}

export {
  initOptionalTradingRuntime,
  invokeBotAction,
};
