import { syncLeverageControls } from './market-display.js';

const DEFAULT_PORTFOLIO_VALUE_TEXT = 'Portfolio Value: —';

function setDisplay(element, display) {
  if (element) element.style.display = display;
}

function setText(element, text) {
  if (element) element.textContent = text;
}

function getWalletConnectionElements() {
  return {
    walletDisconnected: document.getElementById('walletDisconnected'),
    walletConnected: document.getElementById('walletConnected'),
    leverageSliderContainer: document.getElementById('leverageSliderContainer'),
    walletAddrBtn: document.getElementById('walletAddrBtn'),
    equityDisplay: document.getElementById('equityDisplay'),
  };
}

function setWalletButtonLabel(label) {
  if (typeof label !== 'string') return;
  const { walletAddrBtn } = getWalletConnectionElements();
  setText(walletAddrBtn, label);
}

function showConnectedWallet({ walletLabel, leverage }) {
  const {
    walletDisconnected,
    walletConnected,
    leverageSliderContainer,
    equityDisplay,
  } = getWalletConnectionElements();

  setDisplay(walletDisconnected, 'none');
  setDisplay(walletConnected, 'flex');
  setDisplay(leverageSliderContainer, 'flex');
  setText(equityDisplay, DEFAULT_PORTFOLIO_VALUE_TEXT);

  setWalletButtonLabel(walletLabel);
  syncLeverageControls(leverage);
}

function showDisconnectedWallet({ hideLeverage = false } = {}) {
  const {
    walletDisconnected,
    walletConnected,
    leverageSliderContainer,
    equityDisplay,
  } = getWalletConnectionElements();

  setDisplay(walletDisconnected, 'flex');
  setDisplay(walletConnected, 'none');
  if (hideLeverage && leverageSliderContainer) {
    setDisplay(leverageSliderContainer, 'none');
  }
  setText(equityDisplay, DEFAULT_PORTFOLIO_VALUE_TEXT);
}

export {
  DEFAULT_PORTFOLIO_VALUE_TEXT,
  setWalletButtonLabel,
  showConnectedWallet,
  showDisconnectedWallet,
};
