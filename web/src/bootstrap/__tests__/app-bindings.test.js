import { describe, expect, it, vi } from 'vitest';

import { createGroupedWindowBindings, createWindowBindingGroups } from '../app-bindings.js';

function createBindingDeps() {
  return new Proxy({}, {
    get(_target, prop) {
      return String(prop);
    },
  });
}

describe('app bindings', () => {
  it('groups legacy window bindings by compat surface', () => {
    const groups = createWindowBindingGroups(createBindingDeps());

    expect(groups.core.fmtPrice).toBe('fmtPrice');
    expect(groups.account.fetchAccount).toBe('fetchAccount');
    expect(groups.market.fetchCandles).toBe('fetchCandles');
    expect(groups.chart.initChart).toBe('initChart');
    expect(groups.ticket.placeOrder).toBe('placeOrder');
    expect(groups.orders.cancelAllOrders).toBe('cancelAllOrders');
    expect(groups.controls.toggleCoinDropdown).toBe('toggleCoinDropdown');
    expect(groups.signals.renderSignalRadar).toBe('renderSignalRadar');
  });

  it('builds grouped window bindings with compat auth helpers from app state', () => {
    const showToast = vi.fn();
    const bindings = createGroupedWindowBindings({
      appState: { account: { privateKey: '' } },
      showToast,
      groups: {
        core: { fmtPrice: 'fmtPrice' },
        controls: { showToast },
      },
    });

    expect(bindings.getApiKey()).toBe('');
    expect(bindings.requireKey()).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Error: Load your private key first', true);
    // Pure format helpers stay module-scoped; not dumped on window by default.
    expect(bindings.fmtPrice).toBeUndefined();
  });

  it('can still include core utils when explicitly requested', () => {
    const bindings = createGroupedWindowBindings({
      appState: { account: { privateKey: 'k' } },
      groups: {
        core: { fmtPrice: 'fmtPrice' },
      },
      includeCoreUtils: true,
    });
    expect(bindings.fmtPrice).toBe('fmtPrice');
  });
});
