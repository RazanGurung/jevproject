import { scheduleFrame } from '../utils/frame.js';
import {
  getBotModule,
  getBotRuntime,
  getBotStatusApplier,
  getBotStatusRefresher,
  getBotStrategyLoader,
} from '../state/strategy-host.js';

function scheduleCompatFlush(callback) {
  scheduleFrame(() => callback(), 0);
}

let pendingBotTradeUpdate = false;
let pendingBotTradeTarget = null;

function isLegacyBotRunning() {
  return getBotRuntime()?.running === true;
}

function hasLargeTrade(trades = []) {
  return Array.isArray(trades) && trades.some((trade) => {
    // Normalized entries (normalizeTradeBatch) carry the notional pre-computed;
    // raw relay trades remain accepted for compat callers.
    if (Number.isFinite(trade?.notional)) return trade.notional >= 50000;
    const px = parseFloat(trade?.px);
    const sz = parseFloat(trade?.sz);
    return Number.isFinite(px) && Number.isFinite(sz) && (px * sz) >= 50000;
  });
}

function scheduleLegacyBotTradeUpdate(trades = []) {
  const botModule = getBotModule();
  if (!botModule || typeof botModule.onTradeUpdate !== 'function') return false;
  if (!hasLargeTrade(trades)) return false;
  if (pendingBotTradeUpdate) return true;
  pendingBotTradeUpdate = true;
  pendingBotTradeTarget = botModule;
  scheduleCompatFlush(() => {
    pendingBotTradeUpdate = false;
    const target = pendingBotTradeTarget;
    pendingBotTradeTarget = null;
    target?.onTradeUpdate?.();
  });
  return true;
}

function applyBotStatusBridge(status) {
  getBotStatusApplier()?.(status);
}

export {
  applyBotStatusBridge,
  getBotModule,
  getBotStatusRefresher,
  getBotStrategyLoader,
  isLegacyBotRunning,
  scheduleLegacyBotTradeUpdate,
};
