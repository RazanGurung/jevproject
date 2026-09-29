/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../toast.js', () => ({
  showToast: vi.fn()
}));

vi.mock('../../services/wallet-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  clearKey: vi.fn(),
  requireKey: vi.fn(() => '0x' + '1'.repeat(64)),
}));

vi.mock('../../services/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  apiPost: vi.fn(),
  hlPost: vi.fn(async () => []),
  fetchWithDedup: vi.fn((_key, fn) => fn()),
}));

describe('toggleCoinDropdown', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="coinTabs">
        <button class="coin-cat-btn" data-action="toggleCoinDropdown" data-arg="crypto">Crypto ▼</button>
        <button class="coin-cat-btn" data-action="toggleCoinDropdown" data-arg="indices">Indices ▼</button>
        <div id="coinDropdown" style="display:none;"></div>
      </div>
      <div id="outside"></div>
    `;
    window.__PEZ_COIN_DROPDOWN_HANDLERS__ = false;
    // Desktop width: align to trigger. Narrow (≤767) pins left to margin.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true, writable: true });

    const trigger = document.querySelector('[data-action="toggleCoinDropdown"]');
    trigger.getBoundingClientRect = () => ({
      left: 24,
      top: 16,
      right: 104,
      bottom: 40,
      width: 80,
      height: 24,
      x: 24,
      y: 16,
      toJSON: () => ({}),
    });

    const dropdown = document.getElementById('coinDropdown');
    Object.defineProperty(dropdown, 'offsetWidth', { get: () => 240, configurable: true });
    Object.defineProperty(dropdown, 'offsetHeight', { get: () => 180, configurable: true });
  });

  it('opens the other-tickers dropdown as a viewport-positioned surface', async () => {
    const { toggleCoinDropdown } = await import('../controls.js');
    const dropdown = document.getElementById('coinDropdown');
    const trigger = document.querySelector('[data-action="toggleCoinDropdown"]');

    toggleCoinDropdown();

    expect(dropdown.style.display).toBe('flex');
    expect(dropdown.dataset.open).toBe('true');
    expect(dropdown.style.position).toBe('fixed');
    expect(dropdown.style.left).toBe('24px');
    expect(dropdown.style.top).toBe('44px');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // Portaled to body so topbar overflow cannot clip it.
    expect(dropdown.parentElement).toBe(document.body);
  });

  it('closes the dropdown when clicking outside it', async () => {
    const { toggleCoinDropdown } = await import('../controls.js');
    const dropdown = document.getElementById('coinDropdown');

    toggleCoinDropdown();
    document.getElementById('outside').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(dropdown.style.display).toBe('none');
    expect(dropdown.dataset.open).toBe('false');
  });

  it('switches category triggers in place and closes on a repeated trigger', async () => {
    const { toggleCoinDropdown } = await import('../controls.js');
    const dropdown = document.getElementById('coinDropdown');
    const crypto = document.querySelector('[data-arg="crypto"]');
    const indices = document.querySelector('[data-arg="indices"]');

    toggleCoinDropdown('crypto');
    toggleCoinDropdown('indices');
    expect(dropdown.style.display).toBe('flex');
    expect(dropdown.dataset.category).toBe('indices');
    expect(crypto.getAttribute('aria-expanded')).toBe('false');
    expect(indices.getAttribute('aria-expanded')).toBe('true');

    toggleCoinDropdown('indices');
    expect(dropdown.style.display).toBe('none');
    expect(indices.getAttribute('aria-expanded')).toBe('false');
  });
});

function installMemoryLocalStorage() {
  const store = new Map();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(String(key), String(value)); },
      removeItem: (key) => { store.delete(key); },
      clear: () => { store.clear(); },
    },
  });
}

describe('watchlist dropdown', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Node 26's experimental localStorage is unavailable without --localstorage-file;
    // mirror the watchlist-store suite with an in-memory stub.
    installMemoryLocalStorage();
    document.body.innerHTML = `
      <div id="coinTabs">
        <button class="coin-cat-btn" data-action="toggleCoinDropdown" data-arg="watchlist">★ Watchlist ▼</button>
        <button class="coin-cat-btn" data-action="toggleCoinDropdown" data-arg="hidelist">⊘ Hide list ▼</button>
        <div id="coinDropdown" style="display:none;"></div>
        <div id="gainersRow"></div>
        <div id="losersRow"></div>
      </div>
    `;
    window.__PEZ_COIN_DROPDOWN_HANDLERS__ = false;
    Object.defineProperty(window, 'innerWidth', { value: 640, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 480, configurable: true, writable: true });
    document.querySelectorAll('[data-action="toggleCoinDropdown"]').forEach((trigger) => {
      trigger.getBoundingClientRect = () => ({ left: 24, top: 16, right: 104, bottom: 40, width: 80, height: 24, x: 24, y: 16, toJSON: () => ({}) });
    });
  });

  async function openWatchlist(allMids = { BTC: '1', ETH: '2', SOL: '3' }) {
    const { AppState } = await import('../../state/store.js');
    AppState.market.allMids = allMids;
    const controls = await import('../controls.js');
    controls.toggleCoinDropdown('watchlist');
    return controls;
  }

  it('renders favorites with switch + remove actions and excludes them from add-candidates', async () => {
    const { addToWatchlist } = await import('../../services/watchlist-store.js');
    addToWatchlist('BTC');

    await openWatchlist();
    const dropdown = document.getElementById('coinDropdown');

    // Search input present.
    expect(dropdown.querySelector('.coin-dropdown-search')).toBeTruthy();

    // Column header for the trading-trigger fields.
    expect(dropdown.querySelector('.watchlist-col-header')?.textContent).toMatch(/Price/);
    expect(dropdown.querySelector('.watchlist-col-header')?.textContent).toMatch(/Flow/);

    // Favorite row for BTC carries switchCoin + removeFromWatchlist + trigger columns.
    const favBtn = dropdown.querySelector('.watchlist-fav-btn[data-arg="BTC"]');
    expect(favBtn?.getAttribute('data-action')).toBe('switchCoin');
    expect(dropdown.querySelector('.watchlist-remove-btn[data-arg="BTC"]')?.getAttribute('data-action')).toBe('removeFromWatchlist');
    expect(favBtn?.querySelector('[data-wl="change"]')?.textContent).toBe('—');
    expect(favBtn?.querySelector('[data-wl="price"]')?.textContent).toBe('1');
    expect(favBtn?.querySelector('[data-wl="vol"]')?.textContent).toBe('—');
    expect(favBtn?.querySelector('[data-wl="oi"]')?.textContent).toBe('—');
    expect(favBtn?.querySelector('[data-wl="fund"]')?.textContent).toBe('—');
    expect(favBtn?.querySelector('[data-wl="flow"]')?.textContent).toBe('—');

    // Add-candidates exclude the already-watchlisted BTC.
    const candidateArgs = [...dropdown.querySelectorAll('#coinDropdownList [data-action="addToWatchlist"]')].map((el) => el.getAttribute('data-arg'));
    expect(candidateArgs).toContain('ETH');
    expect(candidateArgs).toContain('SOL');
    expect(candidateArgs).not.toContain('BTC');
  });

  it('shows an empty state when the watchlist has no markets', async () => {
    await openWatchlist();
    const dropdown = document.getElementById('coinDropdown');
    expect(dropdown.querySelector('.watchlist-favorites .coin-dropdown-empty')).toBeTruthy();
  });

  it('moves a coin into favorites when added while open', async () => {
    const controls = await openWatchlist();
    controls.addToWatchlist('ETH');

    const dropdown = document.getElementById('coinDropdown');
    expect(dropdown.querySelector('.watchlist-fav-btn[data-arg="ETH"]')).toBeTruthy();
    expect(dropdown.querySelector('#coinDropdownList [data-arg="ETH"]')).toBeFalsy();
  });

  it('groups favorites by type with section labels', async () => {
    const { addToWatchlist } = await import('../../services/watchlist-store.js');
    addToWatchlist('BTC');
    addToWatchlist('xyz:AAPL');
    addToWatchlist('SOL');

    // Open with both native perps and xyz synthetics in allMids.
    await openWatchlist({ BTC: '1', SOL: '3', 'xyz:AAPL': '4' });
    const dropdown = document.getElementById('coinDropdown');

    const labels = [...dropdown.querySelectorAll('.watchlist-group-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Crypto', 'Stocks']);

    // BTC and SOL are under Crypto, sorted alphabetically (BTC before SOL).
    // Groups sit after the sticky column header, so select by label text.
    const groups = [...dropdown.querySelectorAll('.watchlist-group')];
    const cryptoGroup = groups.find((g) => g.querySelector('.watchlist-group-label')?.textContent === 'Crypto');
    const stocksGroup = groups.find((g) => g.querySelector('.watchlist-group-label')?.textContent === 'Stocks');
    expect([...cryptoGroup.querySelectorAll('.watchlist-fav-btn')].map((b) => b.getAttribute('data-arg'))).toEqual(['BTC', 'SOL']);
    expect(stocksGroup.querySelector('.watchlist-fav-btn')?.getAttribute('data-arg')).toBe('xyz:AAPL');
  });

  it('live-updates a favorite\'s daily % when the 24h cache changes', async () => {
    const { addToWatchlist } = await import('../../services/watchlist-store.js');
    addToWatchlist('BTC');
    const controls = await openWatchlist();
    const dropdown = document.getElementById('coinDropdown');
    const span = () => dropdown.querySelector('.watchlist-fav-btn[data-arg="BTC"] [data-wl="change"]');

    // Starts as the em-dash fallback (no cached value yet).
    expect(span().textContent).toBe('—');

    const { setCoin24hChange } = await import('../../state/market-state.js');
    setCoin24hChange('BTC', '2.50');
    controls.updateCoinTabChange('BTC');
    expect(span().textContent).toBe('+2.50%');
    expect(span().classList.contains('pos')).toBe(true);

    setCoin24hChange('BTC', '-1.20');
    controls.updateCoinTabChange('BTC');
    expect(span().textContent).toBe('-1.20%');
    expect(span().classList.contains('neg')).toBe(true);
  });

  it('renders vol/OI/funding/flow trigger columns from snapshots and flow cache', async () => {
    const { addToWatchlist } = await import('../../services/watchlist-store.js');
    const { setAssetSnapshot } = await import('../../state/market-state.js');
    const { AppState } = await import('../../state/store.js');
    const { applyFlowSnapshot } = await import('../../state/market-trades.js');

    addToWatchlist('BTC');
    setAssetSnapshot('BTC', {
      change: '1.50',
      dayNtlVlm: 1_500_000_000,
      oi: 800_000_000,
      funding: 0.0125,
      markPx: 100_000,
    });
    applyFlowSnapshot(AppState.market, 'BTC', {
      buyVol: 75,
      sellVol: 25,
      sampleCount: 10,
      sampleCapacity: 500,
      revision: 1,
    });

    await openWatchlist({ BTC: '100250' });
    const favBtn = document.querySelector('.watchlist-fav-btn[data-arg="BTC"]');

    expect(favBtn.querySelector('[data-wl="change"]')?.textContent).toBe('+1.50%');
    expect(favBtn.querySelector('[data-wl="vol"]')?.textContent).toMatch(/B/);
    expect(favBtn.querySelector('[data-wl="oi"]')?.textContent).toMatch(/M/);
    expect(favBtn.querySelector('[data-wl="fund"]')?.textContent).toBe('+0.0125%');
    expect(favBtn.querySelector('[data-wl="fund"]')?.classList.contains('pos')).toBe(true);
    expect(favBtn.querySelector('[data-wl="flow"]')?.textContent).toBe('75%');
    expect(favBtn.querySelector('[data-wl="flow"]')?.classList.contains('pos')).toBe(true);
  });

  it('live-patches price and flow without rebuilding the dropdown', async () => {
    const { addToWatchlist } = await import('../../services/watchlist-store.js');
    const { AppState } = await import('../../state/store.js');
    const { applyFlowSnapshot } = await import('../../state/market-trades.js');

    addToWatchlist('BTC');
    const controls = await openWatchlist({ BTC: '100' });
    const dropdown = document.getElementById('coinDropdown');
    const favBtn = dropdown.querySelector('.watchlist-fav-btn[data-arg="BTC"]');
    const priceEl = favBtn.querySelector('[data-wl="price"]');
    const flowEl = favBtn.querySelector('[data-wl="flow"]');

    expect(priceEl.textContent).toBe('100');
    expect(flowEl.textContent).toBe('—');

    AppState.market.allMids.BTC = '105.5';
    applyFlowSnapshot(AppState.market, 'BTC', {
      buyVol: 40,
      sellVol: 60,
      sampleCount: 5,
      sampleCapacity: 500,
      revision: 2,
    });
    controls.refreshOpenWatchlistMetrics();

    expect(priceEl.textContent).toBe('105.5');
    expect(flowEl.textContent).toBe('40%');
    expect(flowEl.classList.contains('neg')).toBe(true);
    // Dropdown identity preserved (no full re-render).
    expect(dropdown.querySelector('.watchlist-fav-btn[data-arg="BTC"]')).toBe(favBtn);
  });

  it('sorts favorites by column headers (24h gains/losers, then pair A-Z)', async () => {
    const { addToWatchlist } = await import('../../services/watchlist-store.js');
    const { setAssetSnapshot } = await import('../../state/market-state.js');

    addToWatchlist('BTC');
    addToWatchlist('ETH');
    addToWatchlist('SOL');
    setAssetSnapshot('BTC', { change: '1.00' });
    setAssetSnapshot('ETH', { change: '5.00' });
    setAssetSnapshot('SOL', { change: '-3.00' });

    await openWatchlist({ BTC: '100', ETH: '200', SOL: '50' });
    const dropdown = document.getElementById('coinDropdown');
    const order = () => [...dropdown.querySelectorAll('.watchlist-fav-btn')].map((b) => b.getAttribute('data-arg'));

    // Default pair sort (A→Z within crypto group).
    expect(order()).toEqual(['BTC', 'ETH', 'SOL']);
    expect(dropdown.querySelector('[data-wl-sort="sym"]')?.getAttribute('aria-sort')).toBe('ascending');

    // 24h first click → desc (biggest gains first); flattens category groups.
    dropdown.querySelector('[data-wl-sort="chg"]').click();
    expect(order()).toEqual(['ETH', 'BTC', 'SOL']);
    expect(dropdown.querySelector('[data-wl-sort="chg"]')?.getAttribute('aria-sort')).toBe('descending');
    expect(dropdown.querySelector('[data-wl-sort="chg"]')?.textContent).toMatch(/▼/);

    // Second click → asc (biggest losers first).
    dropdown.querySelector('[data-wl-sort="chg"]').click();
    expect(order()).toEqual(['SOL', 'BTC', 'ETH']);
    expect(dropdown.querySelector('[data-wl-sort="chg"]')?.getAttribute('aria-sort')).toBe('ascending');

    // Pair restores A→Z (and category grouping).
    dropdown.querySelector('[data-wl-sort="sym"]').click();
    expect(order()).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('renders hide list with switch + remove actions and excludes hidden coins from candidates and movers', async () => {
    const { addToHideList } = await import('../../services/hide-list-store.js');
    addToHideList('BTC');

    const { AppState } = await import('../../state/store.js');
    AppState.market.allMids = { BTC: '1', ETH: '2', SOL: '3' };
    const controls = await import('../controls.js');
    controls.toggleCoinDropdown('hidelist');

    const dropdown = document.getElementById('coinDropdown');
    expect(dropdown.dataset.category).toBe('hidelist');
    expect(dropdown.querySelector('.coin-dropdown-search')?.placeholder).toMatch(/Search to hide/);

    // Row for BTC in hide list
    const hideBtn = dropdown.querySelector('.watchlist-fav-btn[data-arg="BTC"]');
    expect(hideBtn?.getAttribute('data-action')).toBe('switchCoin');
    expect(dropdown.querySelector('.watchlist-remove-btn[data-arg="BTC"]')?.getAttribute('data-action')).toBe('removeFromHideList');

    // Add candidates exclude BTC
    const candidates = [...dropdown.querySelectorAll('#coinDropdownList [data-action="addToHideList"]')].map((el) => el.getAttribute('data-arg'));
    expect(candidates).toContain('ETH');
    expect(candidates).not.toContain('BTC');

    // renderMoverRows filters out BTC from top movers
    controls.renderMoverRows(
      [{ coin: 'BTC', change: 10 }, { coin: 'ETH', change: 5 }],
      [{ coin: 'SOL', change: -3 }]
    );
    const gainersButtons = [...document.querySelectorAll('#gainersRow button')].map((b) => b.getAttribute('data-arg'));
    const losersButtons = [...document.querySelectorAll('#losersRow button')].map((b) => b.getAttribute('data-arg'));
    expect(gainersButtons).toEqual(['ETH']);
    expect(gainersButtons).not.toContain('BTC');
    expect(losersButtons).toEqual(['SOL']);
  });

  it('shows empty state for hide list when no coins are hidden', async () => {
    const controls = await import('../controls.js');
    controls.toggleCoinDropdown('hidelist');
    const dropdown = document.getElementById('coinDropdown');
    expect(dropdown.querySelector('.watchlist-favorites .coin-dropdown-empty')?.textContent).toMatch(/No hidden markets/);
  });
});
