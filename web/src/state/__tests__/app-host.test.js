/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('app host', () => {
  beforeEach(() => {
    vi.resetModules();
    window.showConnectModal = vi.fn();
    window.fetchOrderPreview = vi.fn();
    window.switchCoin = vi.fn();
    window.updateSizeSliderMax = vi.fn();
    window.syncMobileChartActionBar = vi.fn();
  });

  it('reads app callback host surfaces from the browser host', async () => {
    const {
      getCoinSwitcher,
      getConnectModalOpener,
      getMobileChartActionBarSyncer,
      getOrderPreviewFetcher,
      getSizeSliderMaxUpdater,
    } = await import('../app-host.js');

    expect(getConnectModalOpener()).toBe(window.showConnectModal);
    expect(getOrderPreviewFetcher()).toBe(window.fetchOrderPreview);
    expect(getCoinSwitcher()).toBe(window.switchCoin);
    expect(getSizeSliderMaxUpdater()).toBe(window.updateSizeSliderMax);
    expect(getMobileChartActionBarSyncer()).toBe(window.syncMobileChartActionBar);
  });

  it('installs the app host bridge', async () => {
    const { installAppHostBridge } = await import('../app-host.js');

    const host = installAppHostBridge();

    expect(host).toBe(window.PezAppHost);
    expect(host.getConnectModalOpener()).toBe(window.showConnectModal);
    expect(host.getOrderPreviewFetcher()).toBe(window.fetchOrderPreview);
    expect(host.getCoinSwitcher()).toBe(window.switchCoin);
    expect(host.getSizeSliderMaxUpdater()).toBe(window.updateSizeSliderMax);
    expect(host.getMobileChartActionBarSyncer()).toBe(window.syncMobileChartActionBar);
  });
});
