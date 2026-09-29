/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ETH around 3000 has a 0.1 effective tick (5 significant figures); the x5
// minimum produces a 0.5 grid.
// Spread is 1.0 so mid = 3000.5 sits exactly on a grid line: the center row is
// the empty level between best bid and best ask (deterministic, no float
// boundary), with asks above and bids below.
const BIDS = [
  { px: 3000, sz: 2 },
  { px: 2999.5, sz: 1 },
];
const ASKS = [
  { px: 3001, sz: 3 },
  { px: 3001.5, sz: 0.5 },
];

// Ingest through the real pipeline: normalizeTradeBatch (market-trades.js)
// parses/dedupes, ingestDomTrades consumes the normalized batch.
async function ingestDomTradesRaw(marketState, coin, trades, now) {
  const { normalizeTradeBatch } = await import('../../state/market-trades.js');
  const { ingestDomTrades } = await import('../../state/dom-ladder-state.js');
  ingestDomTrades(marketState, coin, normalizeTradeBatch(marketState, coin, trades, now));
}

async function renderWithBook({ coin = 'ETH', bookCoin = coin, bids = BIDS, asks = ASKS } = {}) {
  const { AppState } = await import('../../state/store.js');
  const { renderDomLadder, noteDomBookCoin } = await import('../dom-ladder.js');

  AppState.trading.currentCoin = coin;
  AppState.market.book = { bids, asks };
  noteDomBookCoin(bookCoin);
  renderDomLadder();
  return AppState;
}

function rowTexts(selector) {
  return Array.from(document.querySelectorAll(`#domLadderList ${selector}`)).map((el) => el.textContent);
}

// Automatic and manual scale are per coin; clear all held state between tests.
beforeEach(async () => {
  const { resetDomScaleState } = await import('../dom-ladder.js');
  const { AppState } = await import('../../state/store.js');
  resetDomScaleState();
  AppState.market.domTradeCache = new Map();
  AppState.market.tradeSeenKeys = new Map();
  AppState.market.domActivityVersion = (AppState.market.domActivityVersion || 0) + 1;
});

describe('renderDomLadder (fixed price grid)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="domLadderList"></div>';
    document.body.classList.remove('classic-theme');
  });

  it('renders a fixed 25-row grid centered on mid with sizes bucketed per side', async () => {
    const AppState = await renderWithBook();
    AppState.ui.hideValues = false;
    (await import('../dom-ladder.js')).renderDomLadder();

    const prices = rowTexts('.dom-price');
    expect(prices).toHaveLength(25);
    expect(prices[0]).toBe('3006.5');   // top row = highest grid price
    expect(prices[12]).toBe('3000.5');  // center row on mid
    expect(prices[24]).toBe('2994.5');  // bottom row

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    // Ask sizes land above center, bids below; the spread level stays empty.
    expect(rows[10].children[0].textContent).toBe('0.500');   // ask 3001.5
    expect(rows[11].children[0].textContent).toBe('3.000');   // ask 3001
    expect(rows[12].children[0].textContent).toBe('');        // spread level (center)
    expect(rows[13].children[0].textContent).toBe('2.000');   // bid 3000
    expect(rows[14].children[0].textContent).toBe('1.000');   // bid 2999.5

    // Center row is marked with hairlines and carries the mid/spread tooltip.
    expect(rows[12].style.boxShadow).toBe('inset 0 1px 0 var(--border2), inset 0 -1px 0 var(--border2)');
    expect(rows[12].title).toContain('spread');
    expect(rows[12].querySelector('.dom-price b').style.fontSize).toBe('10px');
    expect(rows[12].querySelector('.dom-price b').style.fontWeight).toBe('700');
    expect(rows[11].querySelector('.dom-price b').style.fontSize).toBe('8px');
    expect(rows[11].querySelector('.dom-price b').style.fontWeight).toBe('400');
  });

  it('keeps row prices in place across book updates (fixed axis)', async () => {
    await renderWithBook();
    const before = rowTexts('.dom-price');

    // Sizes change, mid stays within the same bucket -> identical price axis.
    await renderWithBook({
      bids: [{ px: 3000, sz: 5 }, { px: 2999.5, sz: 4 }],
      asks: [{ px: 3001, sz: 1 }, { px: 3001.5, sz: 2 }],
    });
    expect(rowTexts('.dom-price')).toEqual(before);
  });

  it('holds the price axis while mid drifts within the recenter threshold', async () => {
    await renderWithBook();
    const before = rowTexts('.dom-price');

    // Book shifts up 3 buckets (mid 3000.5 -> 3002): the axis holds and the
    // mid marker walks up the fixed grid instead.
    await renderWithBook({
      bids: [{ px: 3001.5, sz: 2 }, { px: 3001, sz: 1 }],
      asks: [{ px: 3002.5, sz: 3 }, { px: 3003, sz: 0.5 }],
    });
    expect(rowTexts('.dom-price')).toEqual(before);

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[9].title).toContain('spread');       // mid row moved up 3
    expect(rows[12].title).not.toContain('spread');  // middle row is plain now
    expect(rows[9].querySelector('.dom-price b').style.fontSize).toBe('10px');
    expect(rows[9].querySelector('.dom-price b').style.fontWeight).toBe('700');
    expect(rows[12].querySelector('.dom-price b').style.fontSize).toBe('8px');
    expect(rows[12].querySelector('.dom-price b').style.fontWeight).toBe('400');
  });

  it('re-centers the grid once mid drifts beyond the threshold', async () => {
    await renderWithBook(); // anchors the grid on mid 3000.5
    // Mid jumps 7 buckets (> RECENTER_DRIFT_ROWS): the grid snaps back to
    // centered on the new mid.
    await renderWithBook({
      bids: [{ px: 3003.5, sz: 2 }, { px: 3003, sz: 1 }],
      asks: [{ px: 3004.5, sz: 3 }, { px: 3005, sz: 0.5 }],
    });

    expect(rowTexts('.dom-price')[12]).toBe('3004.0');
    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[12].title).toContain('spread');
  });

  it('damps the mid marker against bucket-boundary flutter', async () => {
    await renderWithBook(); // marker on 3000.5
    const before = rowTexts('.dom-price');

    // Mid nudges 0.6 buckets past the row edge (3000.5 -> 3000.8): within
    // hysteresis, the marker holds its row instead of flickering.
    await renderWithBook({
      bids: [{ px: 3000.3, sz: 2 }, { px: 2999.8, sz: 1 }],
      asks: [{ px: 3001.3, sz: 3 }, { px: 3001.8, sz: 0.5 }],
    });
    expect(rowTexts('.dom-price')).toEqual(before);
    let rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[12].title).toContain('spread');

    // A decisive move (a full bucket) flips it to the new row immediately.
    await renderWithBook({
      bids: [{ px: 3000.5, sz: 2 }, { px: 3000, sz: 1 }],
      asks: [{ px: 3001.5, sz: 3 }, { px: 3002, sz: 0.5 }],
    });
    rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[11].title).toContain('spread');
    expect(rows[12].title).not.toContain('spread');
  });

  it('shows resting depth on its true side even when the row position disagrees', async () => {
    // Marker held at 3000.5 by hysteresis while the inside market moved up:
    // best bid AND best ask both bucket one row above the marker. Positionally
    // that row is "ask side"; the side rule must resolve by actual size
    // (larger wins) instead of hiding the straddled depth.
    await renderWithBook();
    await renderWithBook({
      bids: [{ px: 3000.8, sz: 2 }, { px: 3000.3, sz: 1 }],
      asks: [{ px: 3000.85, sz: 3 }, { px: 3001.35, sz: 0.5 }],
    });

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[12].title).toContain('spread'); // marker held on 3000.5
    // Bucket 3001 holds bid 2 and ask 3 (both round to it): larger side wins.
    expect(rows[11].children[0].textContent).toBe('3.000');
  });

  it('shows the waiting state when the book is empty', async () => {
    await renderWithBook({ bids: [], asks: [] });
    expect(document.getElementById('domLadderList').innerHTML).toContain('Waiting for book');
  });

  it('shows the waiting state after a coin switch until the new book arrives', async () => {
    await renderWithBook({ coin: 'BTC', bookCoin: 'ETH' });
    expect(document.getElementById('domLadderList').innerHTML).toContain('Waiting for book');
  });

  it('keeps prices and sizes visible when hideValues is on', async () => {
    // hideValues protects account dollars and own trade sizes only — the
    // ladder is market data, so it renders identically either way.
    const AppState = await renderWithBook();
    AppState.ui.hideValues = true;
    (await import('../dom-ladder.js')).renderDomLadder();

    expect(rowTexts('.dom-price')).toContain('3001.0');
    expect(document.getElementById('domLadderList').textContent).toContain('3000');
    AppState.ui.hideValues = false;
  });

  it('shows session volume-at-price and tints only fresh prints', async () => {
    const { HIGHLIGHT_TTL_MS } = await import('../../state/dom-ladder-state.js');
    const AppState = await renderWithBook();
    AppState.ui.hideValues = false;

    const now = Date.now();
    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: now, px: '3000', sz: '1', side: 'B' },                        // fresh buy at best bid
      { time: now - HIGHLIGHT_TTL_MS - 1, px: '3001', sz: '2', side: 'A' }, // stale sell at ask
    ], now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    // Volume column: session totals remain visible after the highlight TTL...
    expect(rows[11].querySelector('.dom-vol').textContent).toBe('2.000');
    expect(rows[13].querySelector('.dom-vol').textContent).toBe('1.000');
    // Historical totals mirror the left resting-book visual treatment: same
    // inset/opacity and values toward the spine; historical direction remains
    // a buy/sell split gradient rather than collapsing to one solid side.
    const askDepth = rows[11].children[0].children[0];
    const askHistory = rows[11].querySelector('.dom-vol');
    const askHistoryBar = askHistory.children[0];
    expect(askHistory.style.textAlign).toBe('left');
    expect(askHistoryBar.style.top).toBe(askDepth.style.top);
    expect(askHistoryBar.style.bottom).toBe(askDepth.style.bottom);
    expect(askHistoryBar.style.opacity).toBe(askDepth.style.opacity);
    expect(askHistory.children[1].style.color).toBe(rows[11].children[0].children[1].style.color);
    expect(askHistoryBar.style.background.replace(/\s/g, '')).toContain('linear-gradient');
    expect(askHistoryBar.style.background.replace(/\s/g, '')).toContain('0%');
    const bidHistory = rows[13].querySelector('.dom-vol');
    expect(bidHistory.children[1].style.color).toBe(rows[13].children[0].children[1].style.color);
    // ...but only the fresh print tints its row, in the side-free grey flash
    // (jsdom re-spaces rgba()).
    expect(rows[13].style.background.replace(/\s/g, '')).toContain('rgba(154,164,178');
    expect(rows[11].style.background).not.toContain('rgba(');
  });

  it('keeps right-column volume after many later prints elsewhere (no DOM 500 window)', async () => {
    const { HIGHLIGHT_TTL_MS } = await import('../../state/dom-ladder-state.js');
    const AppState = await renderWithBook();
    AppState.ui.hideValues = false;
    // Anchor in the past so flash TTL has expired by render time.
    const now = Date.now();
    const anchorTime = now - HIGHLIGHT_TTL_MS * 3;

    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: anchorTime, px: '3000', sz: '1.25', side: 'B' },
    ], anchorTime);
    // Flood far prices; DOM is session-owned so the anchor must remain.
    const flood = [];
    for (let i = 1; i <= 520; i++) {
      flood.push({ time: anchorTime + i, px: String(4000 + i), sz: '1', side: 'A' });
    }
    await ingestDomTradesRaw(AppState.market, 'ETH', flood, now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[13].querySelector('.dom-vol').textContent).toBe('1.250');
    // Flash is time-only; the aged print no longer tints.
    expect(rows[13].style.background).not.toContain('rgba(');
  });
});

describe('ladder interactivity', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="domLadderList"></div>';
    document.body.classList.remove('classic-theme');
  });

  it('exposes each row as a delegated price-pick action carrying its grid price', async () => {
    await renderWithBook();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[13].getAttribute('data-action')).toBe('domLadderPick');
    expect(Number(rows[13].dataset.arg)).toBeCloseTo(3000);   // best bid row
    expect(Number(rows[11].dataset.arg)).toBeCloseTo(3001); // best ask row
  });

  it('keeps automatic grouping local to live depth, not retained trade extremes', async () => {
    const AppState = await renderWithBook();
    const now = Date.now();
    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: now, px: '3070', sz: '1', side: 'A' },
    ], now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const held = rowTexts('.dom-price');
    expect(Number(held[0]) - Number(held[1])).toBeCloseTo(0.5, 9);

    await renderWithBook({
      coin: 'SOL',
      bids: [{ px: 150, sz: 2 }, { px: 149.99, sz: 1 }],
      asks: [{ px: 150.02, sz: 3 }, { px: 150.03, sz: 0.5 }],
    });
    const solPrices = rowTexts('.dom-price');
    expect(Number(solPrices[0]) - Number(solPrices[1])).toBeCloseTo(0.05, 9);
  });

  it('zooms by dragging the price spine and resets to AUTO on double-click', async () => {
    const { getDomScaleDebugState, renderDomLadder } = await import('../dom-ladder.js');
    await renderWithBook();
    const price = document.querySelector('#domLadderList .dom-price');
    const pointer = (type, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        pointerId: { value: 7 }, clientY: { value: y }, button: { value: 0 },
      });
      return event;
    };
    price.dispatchEvent(pointer('pointerdown', 100));
    window.dispatchEvent(pointer('pointermove', 140));
    window.dispatchEvent(pointer('pointerup', 140));
    renderDomLadder();

    expect(getDomScaleDebugState('ETH')).toEqual(expect.objectContaining({ multiplier: 20, bias: 2 }));
    let prices = rowTexts('.dom-price');
    expect(Number(prices[0]) - Number(prices[1])).toBeCloseTo(2, 9);

    await renderWithBook({
      coin: 'SOL',
      bids: [{ px: 150, sz: 2 }],
      asks: [{ px: 150.02, sz: 3 }],
    });
    expect(getDomScaleDebugState('SOL')).toEqual(expect.objectContaining({ multiplier: 5, bias: 0 }));
    await renderWithBook();
    expect(getDomScaleDebugState('ETH')).toEqual(expect.objectContaining({ multiplier: 20, bias: 2 }));

    price.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    renderDomLadder();
    expect(getDomScaleDebugState('ETH')).toEqual(expect.objectContaining({ multiplier: 5, bias: 0 }));
    prices = rowTexts('.dom-price');
    expect(Number(prices[0]) - Number(prices[1])).toBeCloseTo(0.5, 9);
  });
});

describe('local automatic DOM grouping', () => {
  it('selects the smallest 1-2-5 step that fits the nearest ten levels', async () => {
    const { computeLocalAutoMultiplier } = await import('../dom-ladder.js');
    expect(computeLocalAutoMultiplier({
      baseSpacing: 0.1, rowsPerSide: 12, mid: 3000,
      bids: [{ px: 2999 }], asks: [{ px: 3060 }],
    })).toBe(50);
  });

  it('ignores depth beyond the tenth level and keeps the x5 trading floor', async () => {
    const { computeLocalAutoMultiplier } = await import('../dom-ladder.js');
    const asks = Array.from({ length: 10 }, (_, index) => ({ px: 3000.1 + index * 0.1 }));
    asks.push({ px: 4000 });
    expect(computeLocalAutoMultiplier({
      baseSpacing: 0.1, rowsPerSide: 12, mid: 3000, bids: [], asks,
    })).toBe(5);
  });

  it('maps drag distance and direction onto discrete zoom steps', async () => {
    const { dragStepDelta } = await import('../dom-ladder.js');
    expect(dragStepDelta(4)).toBe(0);
    expect(dragStepDelta(5)).toBe(1);
    expect(dragStepDelta(40)).toBe(2);
    expect(dragStepDelta(-40)).toBe(-2);
  });
});

describe('trade flash weighting and whale markers', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="domLadderList"></div>';
    document.body.classList.remove('classic-theme');
  });

  function flashAlpha(row) {
    const m = row.style.background.replace(/\s/g, '').match(/rgba\(154,164,178,([\d.]+)\)/);
    return m ? parseFloat(m[1]) : 0;
  }

  it('flashes whale-sized prints brighter than dust', async () => {
    const { ingestDomTrades } = await import('../../state/dom-ladder-state.js');
    const AppState = await renderWithBook();

    const now = Date.now();
    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: now, px: '3001.5', sz: '5', side: 'A' },     // ~$15k whale at the outer ask
      { time: now, px: '2999.5', sz: '0.01', side: 'B' },  // ~$30 dust at the second bid
    ], now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    const whaleAlpha = flashAlpha(rows[10]); // 3001.5
    const dustAlpha = flashAlpha(rows[14]);  // 2999.5
    expect(whaleAlpha).toBeGreaterThan(dustAlpha);
    expect(dustAlpha).toBeGreaterThan(0); // dust still shimmers, just faintly
  });

  it('flash follows the flat TTL regardless of print size, but the whale marker stays sticky', async () => {
    const { ingestDomTrades, HIGHLIGHT_TTL_MS } = await import('../../state/dom-ladder-state.js');
    const AppState = await renderWithBook();

    // Both prints aged past the (flat) standard TTL.
    const stale = Date.now() - HIGHLIGHT_TTL_MS - 500;
    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: stale, px: '3005', sz: '50', side: 'A' },     // ~$150k whale sell
      { time: stale, px: '2997.5', sz: '0.01', side: 'B' }, // dust
    ], stale);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    const whaleRow = rows[3];  // 3005
    const dustRow = rows[18];  // 2997.5
    expect(flashAlpha(whaleRow)).toBe(0); // flash fade finished, same TTL as dust
    expect(flashAlpha(dustRow)).toBe(0);

    // Whale marker doesn't decay with age; dust rows never get one.
    const dot = whaleRow.querySelector('.dom-whale');
    expect(parseFloat(dot.style.opacity)).toBeGreaterThan(0);
    // Sell whale marker sits on the right side.
    expect(parseFloat(dot.style.right) + parseFloat(dot.style.width) / 2).toBe(5.5);
    expect(dot.style.left).toBe('');
    expect(dustRow.querySelector('.dom-whale').style.opacity).toBe('0');
  });

  it('keeps the whale marker at full opacity long after the print (sticky, no decay)', async () => {
    const { ingestDomTrades } = await import('../../state/dom-ladder-state.js');
    const AppState = await renderWithBook();

    const old = Date.now() - 61_000; // long past the old (now-removed) fade windows
    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: old, px: '3004.5', sz: '50', side: 'A' },
    ], old);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    const row = rows[4]; // 3004.5 — ~$150k sell
    // The marker doesn't fade with age — only the grey flash background does.
    const dot = row.querySelector('.dom-whale');
    expect(parseFloat(dot.style.opacity)).toBeGreaterThan(0.4);
    expect(flashAlpha(row)).toBe(0);
    // Sell marker on the right.
    expect(parseFloat(dot.style.right) + parseFloat(dot.style.width) / 2).toBe(5.5);
    expect(dot.style.left).toBe('');
  });

  it('sizes and colors the whale marker by the row\'s dominant print', async () => {
    const { ingestDomTrades } = await import('../../state/dom-ladder-state.js');
    const AppState = await renderWithBook();
    document.body.classList.add('classic-theme');

    // Different sizes verify that the dominant rolling print owns the marker.
    const now = Date.now();
    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: now, px: '3003', sz: '40', side: 'B' },   // ~$120k whale buy
      { time: now, px: '2996', sz: '400', side: 'A' },  // ~$1.2m bigger whale sell
    ], now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    const smallerDot = rows[7].querySelector('.dom-whale');   // 3003, ~$120k buy
    const biggerDot = rows[21].querySelector('.dom-whale');   // 2996, ~$1.2m sell

    expect(smallerDot.style.color).toBe('rgb(34, 204, 230)'); // buy color
    expect(biggerDot.style.color).toBe('rgb(255, 80, 80)');   // sell color
    expect(parseFloat(biggerDot.style.width)).toBeGreaterThan(parseFloat(smallerDot.style.width));

    // Buy marker on the left, sell marker on the right. Different square sizes
    // share the same center within their mirrored 15px marker lanes.
    expect(parseFloat(smallerDot.style.left) + parseFloat(smallerDot.style.width) / 2).toBe(5.5);
    expect(smallerDot.style.right).toBe('');
    expect(parseFloat(biggerDot.style.right) + parseFloat(biggerDot.style.width) / 2).toBe(5.5);
    expect(biggerDot.style.left).toBe('');

    // Opacity scales logarithmically through $5m rather than saturating at $500k.
    expect(parseFloat(biggerDot.style.opacity)).toBeGreaterThan(parseFloat(smallerDot.style.opacity));
  });

  it('reveals five cumulative concentric-square stages through the $5m maximum', async () => {
    const AppState = await renderWithBook();
    document.body.classList.add('classic-theme');
    const now = Date.now();
    const prints = [
      { px: 3004.5, notional: 150000, side: 'B', row: 4, stages: 1, size: '3px' },
      { px: 3003.5, notional: 300000, side: 'B', row: 6, stages: 2, size: '6px' },
      { px: 3002.5, notional: 750000, side: 'B', row: 8, stages: 3, size: '9px' },
      { px: 2998.5, notional: 1500000, side: 'A', row: 16, stages: 4, size: '12px' },
      { px: 2997.5, notional: 5500000, side: 'A', row: 18, stages: 5, size: '15px' },
    ];
    await ingestDomTradesRaw(AppState.market, 'ETH', prints.map((print) => ({
      time: now,
      px: String(print.px),
      sz: String(print.notional / print.px),
      side: print.side,
    })), now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    prints.forEach((print) => {
      const marker = rows[print.row].querySelector('.dom-whale');
      const visibleStages = Array.from(marker.querySelectorAll('[data-whale-stage]'))
        .filter((stage) => stage.style.display !== 'none');
      expect(visibleStages).toHaveLength(print.stages);
      expect(marker.style.width).toBe(print.size);
      expect(marker.style.height).toBe(print.size);
      const edgeOffset = parseFloat(print.side === 'B' ? marker.style.left : marker.style.right);
      expect(edgeOffset + parseFloat(marker.style.width) / 2).toBe(5.5);
    });
    expect(rows[18].querySelector('.dom-whale').style.opacity).toBe('1');
    expect(rows[18].querySelector('[data-whale-stage="4"]').style.borderRadius).toBe('');
  });

  it('colors a persistent major-whale ring from the major print side', async () => {
    const coin = 'xyz:GOLD';
    const AppState = await renderWithBook({ coin });
    document.body.classList.add('classic-theme');
    const now = Date.now();
    await ingestDomTradesRaw(AppState.market, coin, [
      { time: now, px: '3004', sz: '100', side: 'A' }, // ~$300k major sell
    ], now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    const dot = rows[5].querySelector('.dom-whale');
    expect(dot.style.color).toBe('rgb(255, 80, 80)');
    expect(dot.style.boxShadow).toContain('#ff5050');
  });

  it('carries rolling whale volume and largest-print detail in the row tooltip', async () => {
    const { ingestDomTrades } = await import('../../state/dom-ladder-state.js');
    const AppState = await renderWithBook();
    AppState.ui.hideValues = false;

    const now = Date.now();
    await ingestDomTradesRaw(AppState.market, 'ETH', [
      { time: now - 5000, px: '3003.5', sz: '50', side: 'B' }, // $150k whale buy
      { time: now, px: '3003.5', sz: '1', side: 'A' },        // $3k sell
    ], now);
    (await import('../dom-ladder.js')).renderDomLadder();

    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    const title = rows[6].title; // 3003.5
    expect(title).toContain('Whales $150.2K buy / $0 sell');
    expect(title).toContain('Largest $150.2K buy');
    expect(title.split('\n')).toHaveLength(2);

    // Rolling detail is market data — hideValues leaves it intact.
    AppState.ui.hideValues = true;
    (await import('../dom-ladder.js')).renderDomLadder();
    const hidden = Array.from(document.querySelectorAll('#domLadderList .book-row'))[6].title;
    expect(hidden).toContain('Whales $150.2K buy / $0 sell');
    AppState.ui.hideValues = false;
  });
});

describe('bucket memoization', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="domLadderList"></div>';
    document.body.classList.remove('classic-theme');
  });

  it('re-buckets only when the book object or trade activity actually changes', async () => {
    const { AppState } = await import('../../state/store.js');
    const { renderDomLadder } = await import('../dom-ladder.js');
    // Fresh coin so earlier tests' ETH activity doesn't bleed into the vol column.
    await renderWithBook({ coin: 'LTC' });
    const rows = () => Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows()[13].children[0].textContent).toBe('2.000'); // bid 3000

    // In-place mutation without replacing the book object: the identity-keyed
    // memo intentionally reuses the old buckets. This never happens on the real
    // write path — setMarketBookSnapshot always replaces the object — it is the
    // contract that makes trade-tick and fade repaints skip re-bucketing.
    AppState.market.book.bids[0].sz = 9;
    renderDomLadder();
    expect(rows()[13].children[0].textContent).toBe('2.000');

    // A replaced book object (the real write path) re-buckets immediately.
    AppState.market.book = {
      bids: [{ px: 3000, sz: 9 }, { px: 2999.5, sz: 1 }],
      asks: AppState.market.book.asks,
    };
    renderDomLadder();
    expect(rows()[13].children[0].textContent).toBe('9.000');

    // New trade activity (version bump) refreshes the volume column without a
    // book change.
    const now = Date.now();
    await ingestDomTradesRaw(AppState.market, 'LTC', [{ time: now, px: '3000', sz: '1', side: 'B' }], now);
    renderDomLadder();
    expect(rows()[13].querySelector('.dom-vol').textContent).toBe('1.000');
  });
});

describe('dynamic row count', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="domLadderList"></div>';
    document.body.classList.remove('classic-theme');
  });

  it('derives the row count from the container height (jsdom floor stays 25)', async () => {
    const container = document.getElementById('domLadderList');
    // 600px tall at 12px rows -> 24 per side, 49 rows.
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    await renderWithBook();

    const prices = rowTexts('.dom-price');
    expect(prices).toHaveLength(49);
    expect(prices[24]).toBe('3000.5'); // mid stays the middle row
    expect(prices[0]).toBe('3012.5');  // 24 buckets above mid
  });

  it('scales the recenter drift allowance with the ladder height', async () => {
    const container = document.getElementById('domLadderList');
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    await renderWithBook(); // 24 per side -> drift allowance 17 buckets
    const before = rowTexts('.dom-price');

    // A 7-bucket drift recenters the short 25-row ladder but must hold here:
    // the marker walks up the taller fixed grid instead.
    const drift = (d) => ({
      bids: [{ px: 3000 + d, sz: 2 }, { px: 2999.5 + d, sz: 1 }],
      asks: [{ px: 3001 + d, sz: 3 }, { px: 3001.5 + d, sz: 0.5 }],
    });
    await renderWithBook(drift(3.5));
    expect(rowTexts('.dom-price')).toEqual(before);
    let rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[17].title).toContain('spread'); // mid row moved up 7

    // Drifting past the allowance (19 > 24-7) snaps the grid onto the new mid.
    await renderWithBook(drift(9.5));
    expect(rowTexts('.dom-price')[24]).toBe('3010.0');
    rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[24].title).toContain('spread');
  });
});

describe('fadeFallbackDelay', () => {
  it('runs fast while a flash fades and not at all when idle (the dot no longer needs a fallback cadence)', async () => {
    const { fadeFallbackDelay } = await import('../dom-ladder.js');
    expect(fadeFallbackDelay(true)).toBe(150);
    expect(fadeFallbackDelay(false)).toBe(0);
  });
});

describe('computeGridSpacing', () => {
  it('derives the effective 5-sig-fig tick from mid, immune to book-density noise', async () => {
    const { computeGridSpacing } = await import('../dom-ladder.js');
    const now = 2_000_000;
    // SOL at ~$150 quotes in 0.01 steps (5 significant figures) despite the
    // 0.001 nominal tick. Whether adjacent levels sit 1, 2, or 4 effective
    // ticks apart, the spacing stays 0.01 — the median-gap derivation this
    // replaces flip-flopped 0.01 <-> 0.025 here (no 20 in the snap multiples),
    // breathing the whole ladder 2.5x at the x10 view.
    const bookWithGap = (gap) => ({
      bids: [{ px: 150, sz: 1 }, { px: 150 - gap, sz: 1 }, { px: 150 - 2 * gap, sz: 1 }],
      asks: [{ px: 150.01, sz: 1 }, { px: 150.01 + gap, sz: 1 }, { px: 150.01 + 2 * gap, sz: 1 }],
    });
    [0.01, 0.02, 0.01, 0.04].forEach((gap, i) => {
      const { bids, asks } = bookWithGap(gap);
      expect(computeGridSpacing('SOL', bids, asks, now + i * 100)).toBeCloseTo(0.01, 9);
    });
  });

  it('adopts a decade-crossing effective tick only once it persists', async () => {
    const { computeGridSpacing } = await import('../dom-ladder.js');
    const now = 3_000_000;
    const bookAt = (px) => ({
      bids: [{ px, sz: 1 }, { px: px - 0.01, sz: 1 }],
      asks: [{ px: px + 0.01, sz: 1 }, { px: px + 0.02, sz: 1 }],
    });
    // Seed the held 0.01 spacing at ~$150, then dip under $100 (effective tick
    // 0.001): the smaller spacing is only adopted after the hold window.
    const seeded = bookAt(150);
    expect(computeGridSpacing('SOL', seeded.bids, seeded.asks, now - 100)).toBeCloseTo(0.01, 9);
    // Held at 0.01 from ~$150; mid dipping under $100 (effective tick 0.001)
    // is a candidate first, adopted only after the hold window.
    const { bids, asks } = bookAt(99.5);
    expect(computeGridSpacing('SOL', bids, asks, now)).toBeCloseTo(0.01, 9);
    expect(computeGridSpacing('SOL', bids, asks, now + 1000)).toBeCloseTo(0.01, 9);
    expect(computeGridSpacing('SOL', bids, asks, now + 3000)).toBeCloseTo(0.001, 9);
    // Restore the held spacing for any later SOL test.
    const back = bookAt(150);
    computeGridSpacing('SOL', back.bids, back.asks, now + 4000);
    computeGridSpacing('SOL', back.bids, back.asks, now + 10000);
  });

  it('falls back to the snapped median level gap when mid cannot resolve a tick', async () => {
    const { computeGridSpacing } = await import('../dom-ladder.js');
    const now = 4_000_000;
    // One-sided book -> no mid -> effective tick unresolved. Default tick is
    // 0.001; levels 0.02 apart snap to the 20-tick multiple (exactly 0.02,
    // not the old 25-tick 0.025 overshoot).
    const bids = [{ px: 5, sz: 1 }, { px: 4.98, sz: 1 }, { px: 4.96, sz: 1 }];
    expect(computeGridSpacing('FAKECOIN', bids, [], now)).toBeCloseTo(0.02, 9);
  });
});

describe('spacingDecimals', () => {
  it('counts the decimals needed to print the grid step exactly', async () => {
    const { spacingDecimals } = await import('../dom-ladder.js');
    expect(spacingDecimals(1)).toBe(0);
    expect(spacingDecimals(0.1)).toBe(1);
    expect(spacingDecimals(0.02)).toBe(2);
    expect(spacingDecimals(0.05)).toBe(2);
    expect(spacingDecimals(2.5)).toBe(1);        // BTC-style 0.5 tick at x5
    expect(spacingDecimals(0.1 + 0.2)).toBe(1);  // float noise is not decimals
    expect(spacingDecimals(1e-8)).toBe(8);       // PEPE-scale ticks
  });
});

describe('resolveDomMid (real-time mid price)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="domLadderList"></div>';
  });

  it('prioritizes live allMids over resting book mid to eliminate display lag', async () => {
    const { resolveDomMid } = await import('../dom-ladder.js');
    const { AppState } = await import('../../state/store.js');
    const bids = [{ px: 3000, sz: 2 }];
    const asks = [{ px: 3001, sz: 3 }];

    // Fallback when allMids has not published
    AppState.market.allMids = {};
    expect(resolveDomMid('ETH', bids, asks)).toBe(3000.5);

    // Prioritizes live exchange allMids even when book snapshot is resting
    AppState.market.allMids = { ETH: '3002.5' };
    expect(resolveDomMid('ETH', bids, asks)).toBe(3002.5);
    AppState.market.allMids = {};
  });

  it('updates mid marker from allMids even when resting book depth has not updated', async () => {
    const { renderDomLadder } = await import('../dom-ladder.js');
    const AppState = await renderWithBook();
    const rows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(rows[12].title).toContain('spread'); // 3000.5 is center

    // allMids updates with 3002 (3 buckets higher) while resting book is unchanged
    AppState.market.allMids = { ETH: '3002' };
    renderDomLadder();

    const updatedRows = Array.from(document.querySelectorAll('#domLadderList .book-row'));
    expect(updatedRows[9].title).toContain('spread'); // marker walked up to 3002
    expect(updatedRows[12].title).not.toContain('spread');
    AppState.market.allMids = {};
  });
});

// Kept last: resetModules gives every module fresh state, so this exercises
// the true load-time default without disturbing the suites above.
describe('default adaptive multiplier', () => {
  it('loads at the x5 view', async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="domLadderList"></div>';
    const { AppState } = await import('../../state/store.js');
    const { renderDomLadder, noteDomBookCoin } = await import('../dom-ladder.js');
    AppState.trading.currentCoin = 'ETH';
    AppState.market.book = { bids: BIDS, asks: ASKS };
    noteDomBookCoin('ETH');
    renderDomLadder();

    // Rows step 0.5 — the automatic minimum is 5x the 0.1 effective tick.
    const prices = rowTexts('.dom-price');
    expect(Number(prices[0]) - Number(prices[1])).toBeCloseTo(0.5, 9);
  });
});
