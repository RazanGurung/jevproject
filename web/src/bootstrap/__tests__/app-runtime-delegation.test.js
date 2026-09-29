import { describe, expect, it, vi } from 'vitest';

import { setupAppDelegation } from '../app-runtime.js';

describe('setupAppDelegation', () => {
  it('forwards compact side-submit and chart action handlers into delegated actions', () => {
    const setupActionDelegation = vi.fn();
    const deps = {
      setupActionDelegation,
      switchCoin: vi.fn(),
      toggleCoinDropdown: vi.fn(),
      toggleHide: vi.fn(),
      clearMessagesAndDrawings: vi.fn(),
      toggleMarketRadar: vi.fn(),
      setTimeframe: vi.fn(),
      switchTab: vi.fn(),
      showConnectModal: vi.fn(),
      handleWalletBtnClick: vi.fn(),
      closeAllPositions: vi.fn(),
      cancelAllOrders: vi.fn(),
      scheduleCancelUI: vi.fn(),
      updateLeverageFromSlider: vi.fn(),
      hideConnectModal: vi.fn(),
      modalConnect: vi.fn(),
      clearNewsConfigFromModal: vi.fn(),
      setOrderType: vi.fn(),
      setPlaybook: vi.fn(),
      updateScaleSummary: vi.fn(),
      setScaleTotal: vi.fn(),
      setLimitPriceEntryModeSelection: vi.fn(),
      onManualPriceInput: vi.fn(),
      onManualSizeInput: vi.fn(),
      onManualTpInput: vi.fn(),
      onManualSlInput: vi.fn(),
      setSide: vi.fn(),
      updateSummary: vi.fn(),
      previewOrder: vi.fn(),
      placeOrder: vi.fn(),
      placeOrderWithSide: vi.fn(),
      cancelActiveTwap: vi.fn(),
      hideConfirmModal: vi.fn(),
      markUserEditedPrice: vi.fn(),
      syncBotTotals: vi.fn(),
      restoreManualTicketMode: vi.fn(),
      updateDeploySizingSetting: vi.fn(),
      resetDeploySizingSettings: vi.fn(),
      armChartPricePick: vi.fn(),
      fitChartView: vi.fn(),
      jumpChartToLive: vi.fn(),
      onToggleRvwap: vi.fn(),
      onToggleRvwapBands: vi.fn(),
      onChangeCvdOscillatorLookback: vi.fn(),
      onChangeVolumeProfilePeriod: vi.fn(),
      onToggleVolumeProfileLvn: vi.fn(),
      onToggleManualAnchoredVwap: vi.fn(),
      onToggleManualAnchoredVwapBands: vi.fn(),
      onChangeManualAnchoredVwapSigma: vi.fn(),
      addManualAnchoredVwap: vi.fn(),
    };

    setupAppDelegation(deps);

    expect(setupActionDelegation).toHaveBeenCalledTimes(1);
    const actions = setupActionDelegation.mock.calls[0][0];
    expect(actions.placeOrderWithSide).toBe(deps.placeOrderWithSide);
    expect(actions.armChartPricePick).toBe(deps.armChartPricePick);
    expect(actions.fitChartView).toBe(deps.fitChartView);
    expect(actions.jumpChartToLive).toBe(deps.jumpChartToLive);
    expect(actions.clearMessagesAndDrawings).toBe(deps.clearMessagesAndDrawings);
    expect(actions.onToggleRvwap).toBe(deps.onToggleRvwap);
    expect(actions.onToggleRvwapBands).toBe(deps.onToggleRvwapBands);
    // The CVD-oscillator lookback select dispatches this delegated action; it
    // must be wired or the lookback dropdown silently does nothing.
    expect(actions.onChangeCvdOscillatorLookback).toBe(deps.onChangeCvdOscillatorLookback);
    expect(actions.onChangeVolumeProfilePeriod).toBe(deps.onChangeVolumeProfilePeriod);
    expect(actions.onToggleVolumeProfileLvn).toBe(deps.onToggleVolumeProfileLvn);
    expect(actions.onToggleManualAnchoredVwap).toBe(deps.onToggleManualAnchoredVwap);
    expect(actions.onToggleManualAnchoredVwapBands).toBe(deps.onToggleManualAnchoredVwapBands);
    expect(actions.onChangeManualAnchoredVwapSigma).toBe(deps.onChangeManualAnchoredVwapSigma);
    expect(actions.addManualAnchoredVwap).toBe(deps.addManualAnchoredVwap);
    expect(actions).not.toHaveProperty('onToggleAnchoredVwap');
    expect(actions).not.toHaveProperty('onToggleFairValueGaps');
    expect(actions).not.toHaveProperty('onChangeFairValueGapsFilter');
  });
});
