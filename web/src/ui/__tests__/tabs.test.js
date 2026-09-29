/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    apiPost: vi.fn(),
  };
});

vi.mock('../../services/trading-service.js', () => ({
  placeOrder: vi.fn(),
}));

vi.mock('../../services/trading-service-scale.js', () => ({
  clearScalePreview: vi.fn(),
  placeScaleOrder: vi.fn(),
}));

vi.mock('../../services/trading-service-twap.js', () => ({
  cancelActiveTwap: vi.fn(),
  renderTwapStatus: vi.fn(),
}));

describe('syncLimitPreviewLevels', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <input id="sizeInput" value="250" />
      <button id="buyBtn"></button>
      <button id="sellBtn"></button>
      <button id="placeBtn"></button>
    `;

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';
    AppState.market.allMids = {};
    AppState.market.book = {
      bids: [
        { px: 99 }, { px: 98.5 }, { px: 98 }, { px: 97.5 }, { px: 97 }
      ],
      asks: [
        { px: 101 }, { px: 101.5 }, { px: 102 }, { px: 102.5 }, { px: 103 }
      ]
    };
    AppState.ui.chartPreviewLevels = [];

    window.currentCoin = 'BTC';
    window.currentPrice = 100;
    window.currentOrderType = 'limit';
    window.currentTimeframe = '1m';
    window.currentSide = 'buy';
    window.allMids = {};
    window.bookData = {
      bids: [
        { px: 99 }, { px: 98.5 }, { px: 98 }, { px: 97.5 }, { px: 97 }
      ],
      asks: [
        { px: 101 }, { px: 101.5 }, { px: 102 }, { px: 102.5 }, { px: 103 }
      ]
    };
  });

  it('creates persistent buy and sell preview lines for 1m limit mode', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';
    AppState.market.book = window.bookData;
    const { syncLimitPreviewLevels } = await import('../tabs.js');

    syncLimitPreviewLevels();

    expect(AppState.ui.chartPreviewLevels).toHaveLength(2);
    expect(AppState.ui.chartPreviewLevels).toEqual([
      expect.objectContaining({
        price: 97,
        isBuy: true,
        lineWidth: 2
      }),
      expect.objectContaining({
        price: 103,
        isBuy: false,
        lineWidth: 1.25
      })
    ]);
  });

  it('keeps both preview lines while emphasizing the active side', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'sell';
    AppState.market.book = window.bookData;
    const { syncLimitPreviewLevels } = await import('../tabs.js');

    window.currentSide = 'sell';
    syncLimitPreviewLevels();

    expect(AppState.ui.chartPreviewLevels).toHaveLength(2);
    expect(AppState.ui.chartPreviewLevels[0]).toEqual(expect.objectContaining({
      isBuy: true,
      lineWidth: 1.25
    }));
    expect(AppState.ui.chartPreviewLevels[1]).toEqual(expect.objectContaining({
      isBuy: false,
      lineWidth: 2
    }));
  });

  it('selects preview prices at the fixed preview depth when deeper book levels exist', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';
    const { syncLimitPreviewLevels } = await import('../tabs.js');

    window.bookData = {
      bids: Array.from({ length: 20 }, (_, i) => ({ px: 100 - (i + 1) })),
      asks: Array.from({ length: 20 }, (_, i) => ({ px: 100 + (i + 1) }))
    };
    AppState.market.book = window.bookData;

    syncLimitPreviewLevels();

    expect(AppState.ui.chartPreviewLevels).toHaveLength(2);
    expect(AppState.ui.chartPreviewLevels[0]).toEqual(expect.objectContaining({
      price: 80
    }));
    expect(AppState.ui.chartPreviewLevels[1]).toEqual(expect.objectContaining({
      price: 120
    }));
  });

  it('prefers the canonical live book snapshot over stale window book data', async () => {
    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';
    const { syncLimitPreviewLevels } = await import('../tabs.js');

    AppState.market.book = {
      bids: [{ px: 90 }, { px: 89 }, { px: 88 }, { px: 87 }, { px: 86 }],
      asks: [{ px: 110 }, { px: 111 }, { px: 112 }, { px: 113 }, { px: 114 }],
    };
    window.bookData = {
      bids: [{ px: 99 }, { px: 98.5 }, { px: 98 }, { px: 97.5 }, { px: 97 }],
      asks: [{ px: 101 }, { px: 101.5 }, { px: 102 }, { px: 102.5 }, { px: 103 }],
    };

    syncLimitPreviewLevels();

    expect(AppState.ui.chartPreviewLevels).toEqual([
      expect.objectContaining({ price: 86 }),
      expect.objectContaining({ price: 114 }),
    ]);
  });

  it('anchors limit preview estimates to the live book mid instead of any chart state', async () => {
    const { AppState } = await import('../../state/store.js');
    const { buildLimitPreviewLevels } = await import('../tabs-preview.js');

    AppState.trading.currentPrice = 100;
    AppState.market.book = {
      bids: [{ px: 99 }, { px: 98 }, { px: 97 }, { px: 96 }, { px: 95 }],
      asks: [{ px: 101 }, { px: 102 }, { px: 103 }, { px: 104 }, { px: 105 }],
    };

    const levels = buildLimitPreviewLevels({
      sizeUsd: 250,
      currentSide: 'buy',
      currentCoin: 'BTC',
      currentPrice: 999999,
    });

    expect(levels).toEqual([
      expect.objectContaining({ price: 95 }),
      expect.objectContaining({ price: 105 }),
    ]);
  });

  it('snaps 1m auto-preview levels to the active coin tick so preview lines match the tracked ticket price', async () => {
    const { AppState } = await import('../../state/store.js');
    const { buildLimitPreviewLevels } = await import('../tabs-preview.js');

    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 75756.75;
    AppState.market.book = {
      bids: [{ px: 75756.5 }, { px: 75756 }, { px: 75755.5 }, { px: 75755 }, { px: 75754.75 }],
      asks: [{ px: 75757 }, { px: 75757.5 }, { px: 75758 }, { px: 75758.5 }, { px: 75758.75 }],
    };

    const levels = buildLimitPreviewLevels({
      sizeUsd: 250,
      currentSide: 'buy',
      currentCoin: 'BTC',
      currentPrice: 75756.75,
    });

    expect(levels).toEqual([
      expect.objectContaining({ price: 75755, isBuy: true }),
      expect.objectContaining({ price: 75759, isBuy: false }),
    ]);
  });
});

describe('setOrderType', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div class="order-content"></div>
      <div id="deployAssistPanel"></div>
      <button class="type-tab" id="type-limit"></button>
      <button class="type-tab" id="type-twap"></button>
      <div id="priceGroup"></div>
      <div id="priceSizeGrid"></div>
      <div id="sizeGroup"></div>
      <div id="sizeSliderGroup"></div>
      <div id="scaleGroup"></div>
      <div id="twapGroup"></div>
      <div id="botGroup"></div>
      <div id="sideControl"></div>
      <div id="orderSummary"></div>
      <div id="twapStatusPanel"></div>
      <div id="twapStatusText"></div>
      <button id="cancelTwapBtn"></button>
    `;

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';
    AppState.ui.chartPreviewLevels = [];

    window.currentCoin = 'BTC';
    window.currentPrice = 100;
    window.currentOrderType = 'limit';
    window.currentTimeframe = '1m';
    window.currentSide = 'buy';
    window.loadBotStrategy = vi.fn();
  });

  it('switches to TWAP mode without relying on stale trading-service exports', async () => {
    const { setOrderType } = await import('../tabs.js');
    const { AppState } = await import('../../state/store.js');

    AppState.ui.userEditedPrice = true;

    setOrderType('twap', document.getElementById('type-twap'));
    await Promise.resolve();
    await Promise.resolve();

    expect(AppState.trading.currentOrderType).toBe('twap');
    expect(document.getElementById('twapGroup').style.display).toBe('');
    expect(AppState.ui.userEditedPrice).toBe(false);
  });

  it('rebuilds 1m auto-preview levels after preview state is cleared', async () => {
    document.body.innerHTML += `
      <button class="ctrl-btn" id="tf-1m"></button>
      <button id="previewBtn"></button>
      <input id="priceInput" />
      <input id="sizeInput" value="250" />
      <button id="buyBtn"></button>
      <button id="sellBtn"></button>
      <button id="placeBtn"></button>
      <div id="activePlaybookBadge"></div>
      <input id="sizeSlider" value="250" />
      <div id="sumValue"></div>
      <div id="sumAmount"></div>
      <div id="sumFee"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    AppState.market.book = {
      bids: [
        { px: 99 }, { px: 98.5 }, { px: 98 }, { px: 97.5 }, { px: 97 }
      ],
      asks: [
        { px: 101 }, { px: 101.5 }, { px: 102 }, { px: 102.5 }, { px: 103 }
      ]
    };
    const previewState = await import('../../chart/chart-preview-state.js');
    const { buildLimitPreviewLevels } = await import('../tabs-preview.js');

    window.currentTimeframe = '1m';
    AppState.ui.chartPreviewLevels = [{ price: 97, isBuy: true, label: 'BUY $250' }];

    previewState.clearChartPreviewLevels();
    expect(AppState.ui.chartPreviewLevels).toEqual([]);

    const rebuilt = buildLimitPreviewLevels({
      sizeUsd: 250,
      currentSide: 'buy',
      currentCoin: 'BTC',
      currentPrice: 100,
    });
    previewState.setChartPreviewLevels(rebuilt);

    expect(AppState.ui.chartPreviewLevels).toHaveLength(2);
    expect(AppState.ui.chartPreviewLevels[0]).toEqual(expect.objectContaining({ price: 97 }));
    expect(AppState.ui.chartPreviewLevels[1]).toEqual(expect.objectContaining({ price: 103 }));
  });

  it('resets canonical user-edited price state when entering 1m limit auto-tracking', async () => {
    document.body.innerHTML += `
      <button id="previewBtn"></button>
      <input id="priceInput" />
      <input id="sizeInput" value="250" />
      <button id="buyBtn"></button>
      <button id="sellBtn"></button>
      <button id="placeBtn"></button>
      <div id="activePlaybookBadge"></div>
      <input id="sizeSlider" value="250" />
      <div id="sumValue"></div>
      <div id="sumAmount"></div>
      <div id="sumFee"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    const { setOrderType } = await import('../tabs.js');

    AppState.ui.userEditedPrice = true;
    AppState.trading.currentOrderType = 'market';
    AppState.trading.currentTimeframe = '1m';
    AppState.market.book = {
      bids: [{ px: 99 }, { px: 98.5 }, { px: 98 }, { px: 97.5 }, { px: 97 }],
      asks: [{ px: 101 }, { px: 101.5 }, { px: 102 }, { px: 102.5 }, { px: 103 }],
    };

    setOrderType('limit', document.getElementById('type-limit'));

    expect(AppState.ui.userEditedPrice).toBe(false);
  });

});

describe('submitOrderFromTicket', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="113.0493" />
      <input id="tpPctInput" value="4" />
      <input id="slPctInput" value="2" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Breakout</option></select>
      <button id="placeBtn">Place Order</button>
    `;
  });

  it('builds ticket input in the UI layer and passes it to the trading service', async () => {
    const tabsModule = await import('../tabs.js');
    const tradingServiceModule = await import('../../services/trading-service.js');

    await tabsModule.submitOrderFromTicket();

    expect(tradingServiceModule.placeOrder).toHaveBeenCalledTimes(1);
    expect(tradingServiceModule.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        sizeUsd: 680,
        rawLimitPrice: 113.0493,
        tpPct: 4,
        slPct: 2,
        selectedPlaybook: 'Breakout',
        submitButtonEl: document.getElementById('placeBtn'),
        syncSizeUsd: expect.any(Function),
      }),
      expect.objectContaining({
        onAccepted: expect.any(Function),
        onSizeAdjusted: expect.any(Function),
      })
    );
  });

  it('uses the tapped compact button and tapped-side 1m auto price when compact side submit is used', async () => {
    document.body.innerHTML = `
      <input id="sizeInput" value="680" />
      <input id="priceInput" value="97" />
      <input id="tpPctInput" value="4" />
      <input id="slPctInput" value="2" />
      <input id="sizeSlider" value="680" />
      <select id="playbookSelect"><option selected>Breakout</option></select>
      <button id="buyBtn"></button>
      <button id="sellBtn"></button>
      <button id="placeBtn">Place Order</button>
      <button id="compactSellBtn">Sell</button>
      <div id="activePlaybookBadge"></div>
      <div id="sumValue"></div>
      <div id="sumAmount"></div>
      <div id="sumFee"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '1m';
    AppState.trading.currentSide = 'buy';
    AppState.market.book = {
      bids: [{ px: 99 }, { px: 98.5 }, { px: 98 }, { px: 97.5 }, { px: 97 }],
      asks: [{ px: 101 }, { px: 101.5 }, { px: 102 }, { px: 102.5 }, { px: 103 }],
    };
    AppState.ui.limitPriceEntryMode = 'auto';
    AppState.ui.userEditedPrice = false;
    AppState.ui.chartPreviewLevels = [
      { price: 97, isBuy: true, lineWidth: 2 },
      { price: 103, isBuy: false, lineWidth: 1.25 },
    ];
    window.bookData = AppState.market.book;

    const tabsModule = await import('../tabs.js');
    const tradingServiceModule = await import('../../services/trading-service.js');
    const compactSellBtn = document.getElementById('compactSellBtn');

    await tabsModule.placeOrderWithSide('sell', compactSellBtn);

    expect(tradingServiceModule.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        rawLimitPrice: 103,
        submitButtonEl: compactSellBtn,
      }),
      expect.objectContaining({
        onAccepted: expect.any(Function),
        onSizeAdjusted: expect.any(Function),
      })
    );
    expect(AppState.trading.currentSide).toBe('sell');
  });
});

describe('ticket sizing', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <input id="priceInput" value="100" />
      <input id="sizeInput" value="0" />
      <input id="sizeSlider" value="0" />
      <div id="activePlaybookBadge"></div>
      <div id="sumValue"></div>
      <div id="sumAmount"></div>
      <div id="sumFee"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    const { seedTradingState } = await import('../../test-utils/canonical-state.js');
    seedTradingState(AppState, {
      coin: 'BTC',
      price: 100,
      side: 'buy',
      walletAddress: '0xabc',
      leverageByCoin: { BTC: 5 },
    });
    AppState.account.state = {
      riskSummary: {
        accountValue: '1000',
        withdrawable: '400',
        availableMargin: '400',
      },
    };
    AppState.account.spotBalance = 100;
  });

  it('computes preset size through the extracted sizing path and updates the summary', async () => {
    const { setPreset } = await import('../tabs.js');

    setPreset('50%');

    expect(document.getElementById('sizeInput').value).toBe('1250');
    expect(document.getElementById('sizeSlider').value).toBe('1250');
    expect(document.getElementById('sumValue').textContent).toBe('$1250.00');
  });
});

describe('setTimeframe', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div class="order-content"></div>
      <div id="deployAssistPanel"></div>
      <button class="ctrl-btn" id="tf-1m"></button>
      <button id="previewBtn"></button>
      <input id="priceInput" value="123.45" />
      <input id="sizeInput" value="250" />
      <button id="buyBtn"></button>
      <button id="sellBtn"></button>
      <button id="placeBtn"></button>
      <div id="activePlaybookBadge"></div>
      <input id="sizeSlider" value="250" />
      <div id="sumValue"></div>
      <div id="sumAmount"></div>
      <div id="sumFee"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    AppState.trading.currentCoin = 'BTC';
    AppState.trading.currentPrice = 100;
    AppState.trading.currentOrderType = 'limit';
    AppState.trading.currentTimeframe = '5m';
    AppState.trading.currentSide = 'buy';
    AppState.market.book = {
      bids: [{ px: 99 }, { px: 98.5 }, { px: 98 }, { px: 97.5 }, { px: 97 }],
      asks: [{ px: 101 }, { px: 101.5 }, { px: 102 }, { px: 102.5 }, { px: 103 }],
    };
    AppState.ui.userEditedPrice = false;
    AppState.ui.chartPreviewLevels = [];

    window.currentCoin = 'BTC';
    window.currentPrice = 100;
    window.currentOrderType = 'limit';
    window.currentTimeframe = '5m';
    window.currentSide = 'buy';
    window.userEditedPrice = false;
    window.bookData = AppState.market.book;
  });

  it('reconnects the ticket price to the 1m auto-preview source immediately on timeframe switch', async () => {
    document.body.innerHTML += `
      <div id="compactLimitPriceStrip" hidden>
        <div id="compactLimitBuyPrice"></div>
        <div id="compactLimitSellPrice"></div>
        <span id="compactLimitBuyValue"></span>
        <span id="compactLimitSellValue"></span>
      </div>
    `;

    const { setTimeframe } = await import('../tabs.js');
    const { AppState } = await import('../../state/store.js');

    setTimeframe('1m', document.getElementById('tf-1m'));
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('priceInput').value).toBe('97.000');
    expect(AppState.ui.limitPriceEntryMode).toBe('auto');
    expect(AppState.ui.chartPreviewLevels).toEqual([
      expect.objectContaining({ price: 97, isBuy: true }),
      expect.objectContaining({ price: 103, isBuy: false }),
    ]);
    expect(document.getElementById('compactLimitPriceStrip').hidden).toBe(false);
    expect(document.getElementById('compactLimitBuyValue').textContent).toBe('97.000');
    expect(document.getElementById('compactLimitSellValue').textContent).toBe('103.00');
  });

  it('keeps 1m auto-track locked until the mode selector switches to manual', async () => {
    document.body.innerHTML += '<select id="priceModeSelect"><option value="auto">Auto</option><option value="manual">Manual</option></select>';

    const { setTimeframe, onManualPriceInput } = await import('../tabs.js');
    const { AppState } = await import('../../state/store.js');

    setTimeframe('1m', document.getElementById('tf-1m'));
    await Promise.resolve();
    await Promise.resolve();

    const priceInput = document.getElementById('priceInput');
    priceInput.value = '96.5';
    onManualPriceInput();

    expect(AppState.ui.limitPriceEntryMode).toBe('auto');
    expect(document.getElementById('priceModeSelect').value).toBe('auto');
  });

  it('lets the user switch 1m limit pricing between auto and manual explicitly', async () => {
    document.body.innerHTML += `
      <select id="priceModeSelect"><option value="auto">Auto</option><option value="manual">Manual</option></select>
      <div id="compactLimitPriceStrip" hidden>
        <div id="compactLimitBuyPrice"></div>
        <div id="compactLimitSellPrice"></div>
        <span id="compactLimitBuyValue"></span>
        <span id="compactLimitSellValue"></span>
      </div>
    `;

    const { setTimeframe, setLimitPriceEntryModeSelection } = await import('../tabs.js');
    const { AppState } = await import('../../state/store.js');

    setTimeframe('1m', document.getElementById('tf-1m'));
    await Promise.resolve();
    await Promise.resolve();

    expect(AppState.ui.limitPriceEntryMode).toBe('auto');
    expect(document.getElementById('compactLimitPriceStrip').hidden).toBe(false);
    setLimitPriceEntryModeSelection('manual');
    expect(AppState.ui.limitPriceEntryMode).toBe('manual');
    expect(AppState.ui.userEditedPrice).toBe(true);
    expect(document.getElementById('compactLimitPriceStrip').hidden).toBe(true);

    setLimitPriceEntryModeSelection('auto');
    expect(AppState.ui.limitPriceEntryMode).toBe('auto');
    expect(document.getElementById('priceInput').value).toBe('97.000');
    expect(document.getElementById('compactLimitPriceStrip').hidden).toBe(false);
  });

  it('keeps chart loading state in canonical AppState during timeframe fetches', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { t: 1, o: '100', h: '101', l: '99', c: '100', v: '10' },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      });

    const { setTimeframe } = await import('../tabs.js');
    const { AppState } = await import('../../state/store.js');

    setTimeframe('1m', document.getElementById('tf-1m'));
    expect(AppState.ui.isLoadingChart).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(AppState.ui.isLoadingChart).toBe(false);
  });

  it('clears stale preview lines when switching timeframe in market mode', async () => {
    const { setTimeframe } = await import('../tabs.js');
    const { AppState } = await import('../../state/store.js');

    AppState.trading.currentOrderType = 'market';
    window.currentOrderType = 'market';
    AppState.ui.chartPreviewLevels = [{ price: 97, isBuy: true }];

    setTimeframe('4h');

    expect(AppState.ui.chartPreviewLevels).toEqual([]);
  });
});

describe('fetchOrderPreview', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <input id="sizeInput" value="250" />
      <input id="priceInput" value="100" />
      <div id="previewMarginRow"></div>
      <div id="previewLiqRow"></div>
      <div id="previewDistRow"></div>
      <div id="previewMargin"></div>
      <div id="previewLiq"></div>
      <div id="previewDist"></div>
    `;

    const { AppState } = await import('../../state/store.js');
    const { seedTradingState } = await import('../../test-utils/canonical-state.js');
    seedTradingState(AppState, {
      coin: 'BTC',
      price: 100,
      side: 'buy',
      walletAddress: '0xabc',
      leverageByCoin: { BTC: 7 },
    });
    AppState.account.state = {
      riskSummary: {
        accountValue: '1000',
        withdrawable: '800',
        availableMargin: '800',
      },
    };

    // Mirror is intentionally stale to confirm canonical state wins.
    window.exchangeLeverageByCoin = { BTC: 3 };
  });

  it('uses canonical leverage instead of stale window leverage', async () => {
    const { apiPost } = await import('../../services/api.js');
    apiPost.mockResolvedValue({ liquidationPx: 80, initialMargin: 35 });

    const { fetchOrderPreview } = await import('../tabs.js');
    await fetchOrderPreview();

    expect(apiPost).toHaveBeenCalledWith('/api/order-preview', expect.objectContaining({
      leverage: 7,
    }));
  });

  it('builds preview input in the UI layer before calling the runtime fetch', async () => {
    const previewRuntime = await import('../ticket-order-preview-runtime.js');
    const spy = vi.spyOn(previewRuntime, 'fetchOrderPreview').mockResolvedValue(undefined);

    const { fetchOrderPreview } = await import('../tabs.js');
    await fetchOrderPreview();

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      sizeUsd: 250,
      rawLimitPrice: 100,
    }));
  });
});
