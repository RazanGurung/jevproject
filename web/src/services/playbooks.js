import { getAllMids } from '../state/market-selectors.js';
import { getCurrentPrice, getCurrentCoin, getCurrentSide } from '../state/trading-selectors.js';
import { fmtInputPrice } from '../utils/format.js';
import { getTicketFieldElements } from '../ui/ticket-fields.js';

export const PLAYBOOKS = {
  Manual: {
    label: 'Manual',
    description: 'Plain limit order ticket. No automatic price, TP, or SL biasing.',
    tpPct: null,
    slPct: null,
    priceBias: 0,
    manual: true,
  },
  Breakout: {
    label: 'Breakout',
    description: 'Momentum entry with wider target and cleaner invalidation.',
    tpPct: 2.8,
    slPct: 1.2,
    priceBias: 0.0015,
  },
  Pullback: {
    label: 'Pullback',
    description: 'Join trend on retrace with moderate stop and target.',
    tpPct: 2.1,
    slPct: 1.0,
    priceBias: -0.0005,
  },
  Fade: {
    label: 'Fade',
    description: 'Smaller counter-move trade with tighter stop.',
    tpPct: 1.8,
    slPct: 0.9,
    priceBias: -0.0008,
  },
  Hedge: {
    label: 'Hedge',
    description: 'Protective size with faster exit profile.',
    tpPct: 1.2,
    slPct: 0.7,
    priceBias: 0,
  },
};

function getPlaybookPrice(coin) {
  return parseFloat(
    getAllMids()?.[coin]
    || getCurrentPrice()
    || 0
  );
}

function syncTicketAfterPlaybookChange() {
  import('../ui/tabs.js')
    .then(({ updateSummary, fetchOrderPreview }) => {
      updateSummary();
      fetchOrderPreview();
    })
    .catch(() => {});
}

export function getSelectedPlaybook() {
  const value = getTicketFieldElements().playbookSelect?.value || 'Manual';
  return PLAYBOOKS[value] ? value : 'Manual';
}

export function applyPlaybook(playbookName, options = {}) {
  const playbook = PLAYBOOKS[playbookName] || PLAYBOOKS.Manual;
  const side = options.side || getCurrentSide() || 'buy';
  const price = Number(options.price || getPlaybookPrice(getCurrentCoin()) || 0);
  const {
    tpPctInput: tpInput,
    slPctInput: slInput,
    playbookSelect,
    playbookHint,
    priceInput,
  } = getTicketFieldElements();

  if (playbookSelect) playbookSelect.value = playbookName;
  if (tpInput && !options.keepTargets) tpInput.value = playbook.manual ? '' : String(options.tpPct ?? playbook.tpPct);
  if (slInput && !options.keepTargets) slInput.value = playbook.manual ? '' : String(options.slPct ?? playbook.slPct);
  if (playbookHint) playbookHint.textContent = playbook.description;

  if (priceInput && !options.keepPrice && price > 0 && !playbook.manual) {
    const signedBias = side === 'buy' ? playbook.priceBias : -playbook.priceBias;
    const adjusted = price * (1 + signedBias);
    priceInput.value = fmtInputPrice(adjusted, { decimals: 4 });
  }

  syncTicketAfterPlaybookChange();
}
