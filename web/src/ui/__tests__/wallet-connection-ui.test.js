/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncLeverageControls = vi.fn();

vi.mock('../market-display.js', () => ({
  syncLeverageControls,
}));

describe('wallet connection ui', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `
      <div id="walletDisconnected" style="display:flex"></div>
      <div id="walletConnected" style="display:none"></div>
      <div id="leverageSliderContainer" style="display:none"></div>
      <button id="walletAddrBtn">—</button>
      <div id="equityDisplay"></div>
    `;
  });

  it('renders the connected wallet state through the ui adapter', async () => {
    const { showConnectedWallet } = await import('../wallet-connection-ui.js');

    showConnectedWallet({ walletLabel: '0x1234', leverage: 7 });

    expect(document.getElementById('walletDisconnected')?.style.display).toBe('none');
    expect(document.getElementById('walletConnected')?.style.display).toBe('flex');
    expect(document.getElementById('leverageSliderContainer')?.style.display).toBe('flex');
    expect(document.getElementById('walletAddrBtn')?.textContent).toBe('0x1234');
    expect(document.getElementById('equityDisplay')?.textContent).toBe('Portfolio Value: —');
    expect(syncLeverageControls).toHaveBeenCalledWith(7);
  });

  it('renders the disconnected wallet state and can hide leverage controls', async () => {
    const { setWalletButtonLabel, showDisconnectedWallet } = await import('../wallet-connection-ui.js');

    setWalletButtonLabel('DISCONNECTED');
    showDisconnectedWallet({ hideLeverage: true });

    expect(document.getElementById('walletDisconnected')?.style.display).toBe('flex');
    expect(document.getElementById('walletConnected')?.style.display).toBe('none');
    expect(document.getElementById('leverageSliderContainer')?.style.display).toBe('none');
    expect(document.getElementById('walletAddrBtn')?.textContent).toBe('DISCONNECTED');
    expect(document.getElementById('equityDisplay')?.textContent).toBe('Portfolio Value: —');
  });
});
