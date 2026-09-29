import { setOrderType, setSide, updateSummary, updateTicketLayoutMode } from '../ui/tabs.js';
import { applyPlaybook } from './playbooks.js';
import { getCoinSwitcher, getOrderPreviewFetcher } from '../state/app-host.js';
import { AppState, setLastDeployedPlan } from '../state/store.js';
import { getAllMids } from '../state/market-selectors.js';
import { getCurrentCoin, getCurrentPrice } from '../state/trading-selectors.js';
import { showToast } from '../ui/toast.js';
import { fmtInputPrice } from '../utils/format.js';
import { getTicketFieldElements } from '../ui/ticket-fields.js';

export function deployTradePlan(plan) {
  if (!plan) return;

  const isPlanReady = () => {
    const { priceInput, sizeInput } = getTicketFieldElements();
    if (!priceInput || !sizeInput) return false;
    if (getCurrentCoin() !== plan.coin) return false;

    const livePrice = Number(getAllMids()?.[plan.coin] || (getCurrentCoin() === plan.coin ? getCurrentPrice() : 0));
    if (!Number.isFinite(livePrice) || livePrice <= 0) return false;

    return true;
  };

  const run = () => {
    if (!isPlanReady()) return false;
    const targetOrderType = plan.orderType || 'limit';
    const ticketTab = document.querySelector(`.type-tab[data-arg="${targetOrderType}"]`) || document.querySelector('.type-tab[data-arg="limit"]');
    setOrderType(targetOrderType, ticketTab);
    setSide(plan.side || 'buy');

    const {
      priceInput,
      sizeInput,
      sizeSlider,
      tpPctInput: tpInput,
      slPctInput: slInput,
    } = getTicketFieldElements();

    if (priceInput && Number.isFinite(plan.limitPx) && plan.limitPx > 0) {
      priceInput.value = fmtInputPrice(plan.limitPx, { decimals: 4 });
    }
    if (sizeInput && Number.isFinite(plan.sizeUsd)) sizeInput.value = String(plan.sizeUsd);
    if (sizeSlider && Number.isFinite(plan.sizeUsd)) sizeSlider.value = String(plan.sizeUsd);
    if (tpInput && Number.isFinite(plan.takeProfitPct)) tpInput.value = String(plan.takeProfitPct);
    if (slInput && Number.isFinite(plan.stopLossPct)) slInput.value = String(plan.stopLossPct);

    applyPlaybook(plan.playbook || 'Manual', {
      side: plan.side || 'buy',
      price: plan.limitPx,
      tpPct: plan.takeProfitPct,
      slPct: plan.stopLossPct,
      keepPrice: true,
    });

    updateSummary();
    setLastDeployedPlan({
      coin: plan.coin,
      side: plan.side || 'buy',
      orderType: targetOrderType,
      playbook: plan.playbook || 'Manual',
      limitPx: Number(plan.limitPx) || 0,
      sizeUsd: Number(plan.sizeUsd) || 0,
      takeProfitPct: Number(plan.takeProfitPct) || 0,
      stopLossPct: Number(plan.stopLossPct) || 0,
    });
    updateTicketLayoutMode();
    getOrderPreviewFetcher()?.();
    if (plan.toastMessage) {
      showToast(plan.toastMessage, false);
    }
    return true;
  };

  const runWhenReady = (attempts = 0) => {
    if (run()) return;
    if (attempts >= 16) return;
    requestAnimationFrame(() => runWhenReady(attempts + 1));
  };

  const switchCoin = getCoinSwitcher();
  if (getCurrentCoin() !== plan.coin && switchCoin) {
    switchCoin(plan.coin);
    requestAnimationFrame(() => runWhenReady());
    return;
  }

  runWhenReady();
}
