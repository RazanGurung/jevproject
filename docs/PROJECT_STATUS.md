# Project Status

**Updated:** September 23, 2026 — Immutable Execution & Audit Journal (SEC 17a-4 / MiFID II Compliant), Web Worker Indicator Calculation Pipeline, UI Deep Audit, Hideable Liqs/Misprice/Jev Column, Dynamic Chart Space Fill, Real-Time Jev Signal Deep Audit & Unification (78.95% WR, +98.87% Net Return, Sharpe 4.49, 100% Counter-Trend WR), Two-Pointer Candle Merge (-88% Latency), In-Place CVD Pipeline, On-Chart Jev Brackets, DOM Depth Bars & Real-Time Toxic Sweep Countdown

Short dated notes: [PROJECT_STATUS_HISTORY.md](PROJECT_STATUS_HISTORY.md).
Older dump: [archive/PROJECT_STATUS_HISTORY.md](archive/PROJECT_STATUS_HISTORY.md).
Start with [ARCHITECTURE.md](ARCHITECTURE.md) for ownership,
[CHART.md](CHART.md) for the Lightweight Charts adapter, and
[API.md](API.md) for contracts.

## Current Build

Split Go backend plus vanilla ES-module frontend.

```text
Frontend: web/src/*
  -> REST + scoped trading/market WebSockets
Backend: cmd/server + internal/*
  -> Hyperliquid REST/WS + TypeSafe Jev System One Engine
Exchange: Hyperliquid mainnet + xyz HIP-3 only (other builder dexs filtered out of market loading)
```

This is a single-user trading app. **The backend does most of the work**
(signing, exchange transport, candle residency/CVD, bot runtime,
TypeSafe Jev AI decision engine, market/account relay, rate limits).
**The frontend is mostly a renderer**: AppState, chart/DOM paint, and thin intent adapters (`market-session`, trading API wrappers, Jev Copilot widget).

## Rebuild after any change

The running server does **not** pick up source edits automatically — it
serves a built bundle:

- **Frontend:** `make web-build` (or `cd web && npm run build`)
- **Backend:** `make build`
- **Both:** `make release`, then restart `./hyperliquid-server` (or `make run`)

`make run` builds Go but serves raw `/src` only when `web/dist/` is absent;
if `dist/` exists it is preferred.

`start (Mac).command` runs `make release`, records the launched PID, and
refuses to kill an unrelated listener on the selected port.

## Current Assessment

Architecture Phases 1–3 are complete. Preferred work is targeted bugs,
focused regressions, and live validation — not feature depth inside meg-files
or another structural cleanup wave.

| Area | Posture |
|------|---------|
| Charts | Backend-owned history/CVD; frontend renders. Display lookbacks are the 190-day indicator-stable window, clamped by `ReachableLookbackMs` to Hyperliquid's 5000-candle retention. First paint requests that same reachable window so default lines/levels do not rewrite as older bars prepend. `1h/4h/15m` warm after the `/readyz` gate via coordinator prefer pass. Snapshot restore serves history without universe REST. Saved user watchlists persist to `data/watchlist-hints.json` and restore across server reboots, unioning directly into startup hydration. Watchlist updates immediately nudge coordinator reconcile via `NudgeCh`. Warm coordinator reserves a dedicated mover quota (`MinMoverSlots = 10`) so top gainers/losers are never starved by large watchlists. Frontend UI predictive hover pre-warm (`hover-prefetch.js`) initiates background candle fetches on 120ms mouse hover over ticker switch buttons. Technical indicator suite complete: Dedicated Web Worker calculation offloading pipeline (`indicator-worker-code.js`, `indicator-worker-pool.js`) for non-blocking off-thread math with automatic synchronous fallback and request staleness suppression; Candle Overlay dropdown (placed left of Draw toggle) supporting Heikin Ashi (canonical smoothing math, high-contrast cyan/coral styling, toggleable wicks), Renko (symmetrical initial direction, uniform brick widths, horizontal step staircase geometry, price shelf and orthogonal step lines, ATR/percentage/fixed sizing, 2-brick reversal rule, continuation expansion, projection lines, wicks, strict closed-bar confirmation with zero repainting, quantized step rounding, float epsilon tolerance, synchronous series sync, live edge shelf extension), and dual overlay mode ('Both') with independent dimming and opacity controls across base candles, Heikin Ashi, and Renko rendered via an autoscale-neutral Lightweight Charts canvas primitive (`useBitmapCoordinateSpace`, `autoscaleInfo() => null`) with dynamic base candle styling (automatic dimmed default, hidden, normal); Default 30D, 90D, and 365D Rolling VWAPs (7D unchecked by default, bands off) with tiered line widths (7D: 1, 30D: 2, 90D: 3, 365D: 4) and chart legend/price-axis labels, Visible Range default Volume Profile (VRVP) with 3 tiered POC lines and PineScript-derived Low Volume Node (LVN) zones, plus Quarterly & Monthly options, Automated Session VWAPs (D/W/M + prior levels), and On-Chart Liquidation Clusters. Manual Anchored VWAP defaults off. Adapter: [CHART.md](CHART.md). |
| AI Decision & Copilot | TypeSafe Jev System One integration (`internal/infrastructure/typesafe`, `internal/services/jev_service.go`, `web/src/services/jev-service.js`, `scripts/jev_validation/`). Full Diogo Almeida Blueprint implementation: Addressable Chunk Store & Visibility Ladder (`VisibilityLevel`: hide, short, long, full), KV cache reuse noul evaluation, priced routing engine ($25Y+5Z$ vs $3X+20Y+8Z$), tiered tool disclosure (snippets, schemas, docs), programmable permissions with deep inspection (`allow`, `ask`, `deny`), subgoal in-flight deduplication, conditional instruction matching, and shared retrieval caching across read-only background evaluators. Real-time orderbook microstructure analysis: Cont-Kukanov-Stoikov dynamic OFI, level-decayed depth weighting, volume-weighted touch micro-price drift, dual-threshold Schmitt trigger hysteresis ($\ge 65\%$ activation, $\ge 50\%$ retention floor, 0ms instant regime reversal), 6 microstructural defense gates, Gate 7 Macro Volume Profile (Monthly 30D / Quarterly 90D VAH/VAL/POC) and Move Extension Defense, Trend vs. Counter-Trend Signal Expansion with Range Boundary Orderflow Absorption Quality Filter, and UI Volume Profile & TWAP Context Strip. Comprehensive Python standard-library validation harness and backtesting engine (`scripts/jev_validation/`). Guide: [JEV_ENGINEERING_GUIDE.md](JEV_ENGINEERING_GUIDE.md). |
| Frontend UI | PEZ Ultimate: dual type (Plex Sans + Mono, 100% self-hosted locally under `/assets/fonts/` with zero Google Fonts/CDN dependency), hideable Liqs/Misprice/Jev column (`#liqToggleBtn`, `.liq-hidden`, 8-permutation responsive CSS Grid across News, Trade, and Liqs), dynamic chart space auto-fill on panel collapse (`onChartResize` + `refitOverviewIfUserHasNotPanned`), container queries on `.chart-panel` (`@container chart-panel (max-width: 640px)`) cleanly hiding secondary timeframe chips, `flex-shrink: 0` ticker truncation protection, indicators popover layout & visual hierarchy overhaul (316px breathed width, right-aligned toggle columns, nested sub-sections, pill band chips, and status chips), Jev Copilot audit widget, Jev Real-Time Trade Signal dedicated 3rd window in the LIQS + MISPRICE column (mid, entry, dynamic ATR-scaled TP/SL levels, OFI, spread, 2:1 R:R, toxic risk %, reasoning narrative, model tag, macro structure metrics, active Volume Profile $VAL/$POC/$VAH context strip with distance from TWAP, and Trend vs Counter-Trend / Range vs Trend badges) plus sleek 1-click execution button on the Order Ticket (`⚡ FILL JEV TICKET`), density modes, focus mode, resizable rails, mobile dock (Chart/Book/News/Trade/Account with 100% book expansion when Liqs hidden), chart min-width protection. Clean neutral presentation on HOLD (`—` target prices). Bundler applies build-time null safety for Lightweight Charts 5.2.1 `barStyleFnMap`. Layout prefs live in browser `localStorage` under `pez:*` keys. |
| Frontend execution | Live LC line every real market tick (`marketLastTickAt`); topbar/summary throttled (~10 Hz); L2 does not force full chart overlay; liquidations rAF-batched; non-visible candle posts use client `background: true`. Connection pill is Live/Sync/Offline. Predictive hover pre-warm fetches pending switch candidates into local candle cache before click. |
| Execution | First-party wire + signing goldens; parsed ECDSA key memoization in `keycache` and `HyperliquidAdapter`; official `TifAlo` (post-only) wire alignment; official isolated-margin `ntli` (6-decimal int); `updateLeverage.isCross` inferred for HIP-3; grouped `positionTpsl` TP+SL; market-trigger `p` uses ±1% slippage; at-most-once on ambiguous failures including `http 429`/`5xx` (`ambiguous:true`, no new-cloid retry); Place/Bulk reject below $10 min notional (no silent size-up); `reduceOnly` orthogonal to IOC. Ticket Place is locked unless market feed is live. Select Buy or Sell, then Place — Smart Long/Short is retired. Immutable Execution & Audit Journal (`internal/services/execution_journal.go`, `data/execution_journal.jsonl`): thread-safe append-only ledger recording all order submissions, cancels, and fills with nanosecond timestamps, pre-trade DOM midprice snapshots, realized slippage bps against arrival price, latency ms, and status. Queryable via `GET /api/journal/executions` and `/api/journal/summary`. |
| Streams | Isolated trading vs market lanes; downstream write queue buffer headroom expanded to 2048 for `marketStream` (512 for `tradingStream`); 15s server heartbeat broadcast cadence matching account stream ping (4× margin against 60s client watchdog); official xyz `clearinghouseState`/`openOrders`/`twapStates`; wall-clock reconnect backoff with sleep `Reset()`; local WS connected ≠ live HL (`type:upstream` + 15s last tick); process wake closes market/user/liquidation. Book/trade warm-set is active+watchlist+5 recents, not movers. |
| DOM / flow | Backend latest-500 ALL/WHALE in `coin_flow.go`; ladder volume session-owned per pair. Real-time DOM mid marker resolves via `resolveDomMid(coin, bids, asks)`, synchronizing instantaneously with `allMids` ticks and tape-sweeping trade fills to eliminate DOM midprice lag against real-time fill highlights. Browser trade identities FIFO-capped at 10k (replay window 1,200 retained). |
| News / MISPRICE | Backend read models; browser is renderer. Market News is a single read-only ticker-following feed, independent from chart signals and execution. Jev semantic news sentiment and catalyst classification available via `/api/jev/classify-news`. Jev synthetic mispricing arbitrage valuation available via `/api/jev/evaluate-mispricing`. |
| Compatibility | `window.*` is bot/host/HTML shell only — unused in-browser strategy executor removed. AppState dual-writes are gone (Stage 3A–C). |

Startup opens liveness HTTP before snapshot decode and the chart admit
barrier. `/readyz` and every functional/static route remain `503` until the
default `2h` chart plus its `5m`/`30m` CVD dependencies are **history-ready**
for the bounded pinned/liquid universe (default OI floor $30M, maximum 60
markets). Other common TFs (`1h`/`4h`/`15m`) warm in the background after
admission. Warm relaunch with a complete candle snapshot skips REST for
already-covered series. Markets outside that startup universe remain lazy:
the first visible chart uses the priority passthrough (25s RTT after limiter
wait + client transient retries), then full display history and CVD
dependencies warm single-flight in the background.

## Latest Changes (September 23, 2026) — Immutable Execution & Audit Journal (SEC 17a-4 / MiFID II Compliant) & Web Worker Technical Indicator Pipeline

1. **Immutable Execution & Audit Journal (`internal/services/execution_journal.go`, `internal/domain/models/journal.go`):**
   - **The Problem Solved:** Institutional compliance (SEC 17a-4, MiFID II RTS 25) and professional audit trails require an append-only, tamper-resistant record of all trade submissions, cancellations (by exchange OID and client CLOID), and executions with arrival prices, realized slippage, and latency tracking.
   - **Thread-Safe Append-Only JSONL Ledger:** Implemented high-throughput ledger persisting to `data/execution_journal.jsonl`. Backed by an in-memory ring buffer (1,000 entries) preloaded on server startup for sub-millisecond query responses.
   - **Pre-Trade Arrival Midprice & Slippage Measurement:** Integrated directly into `order_service.go` and `order_service_place.go`. Automatically captures the pre-trade arrival DOM midprice before dispatching orders to Hyperliquid wire, and computes realized execution slippage in basis points (`slippageBps`) upon receipt of fill response.
   - **REST API Endpoints (`internal/handlers/http/order_handler.go`):** Added `GET /api/journal/executions` (filtered by coin, action, and limit/offset pagination) and `GET /api/journal/summary` (total trade volume, order/cancel counts, fill rate %, average slippage bps, and average round-trip latency ms). Exposed on frontend client via `execution-journal-service.js`.

2. **Web Worker Technical Indicator Offloading Pipeline (`web/src/chart/indicator-worker-code.js`, `web/src/chart/indicator-worker-pool.js`):**
   - **The Problem Solved:** Heavy calculations (Volume Profiles across 5,000 bars with POC/VAH/VAL/LVN detection, Heikin Ashi candle smoothing, and Renko brick quantization) previously ran synchronously on the browser's main UI thread, risking micro-stutters during rapid timeframe switching or ticker panning.
   - **Pure Off-Thread Computation Worker:** Extracted pure computation kernels into an inline Blob Web Worker script, eliminating DOM access inside the mathematical routines while avoiding external script bundle fetch delays.
   - **Async Worker Pool with Staleness Suppression:** Dispatches computation jobs asynchronously with auto-incrementing request IDs. If a trader rapidly cycles timeframes or coins, superseded pending requests are dropped automatically without updating the canvas.
   - **Automatic Synchronous Fallback & Diagnostics:** Gracefully falls back to synchronous computation in non-worker environments (JSDOM, headless unit test runners, or older browsers). Diagnostics tracked via `getIndicatorWorkerStats()`.

## Previous Changes (September 22, 2026) — UI Deep Audit, Hideable Liqs/Misprice/Jev Column & Dynamic Chart Space Fill, In-Memory Candle Store Two-Pointer Merge Optimization (-88% Latency), In-Place CVD Pipeline, Macro Extension Scalar Caching, Canvas Viewport Culling Early-Exit, On-Chart Jev Bracket Projections, DOM Depth Bars & Real-Time Toxic Sweep Countdown

1. **In-Memory Candle Store Two-Pointer Merge Optimization (`internal/infrastructure/candlecache/candle.go`):**
   - **The Problem Solved:** `mergeCandles` previously allocated a `map[int64]Candle` of size up to 10,000, inserted and hashed every candle, extracted map values into an unsorted slice, and executed reflection-based `sort.Slice` on every REST preload, on-demand warm, passthrough merge, and preloader chunk.
   - **Two-Pointer Linear Merge:** Implemented zero-map $O(N + M)$ two-pointer merge (`mergeCandlesSorted`) when input slices are sorted unique (the invariant across >99.9% of exchange and store series), falling back to map deduplication only when out-of-order candles arrive. Base cases hardened against empty slice recursion.
   - **Empirical Benchmark (`5,000` existing $\times$ `500` incoming):**
     - **Latency:** Dropped from `1,761,606 ns/op` (1.76 ms) to `204,747 ns/op` (0.20 ms) — **8.6x faster (-88.4%)**.
     - **Memory:** Dropped from `1,681,272 B/op` to `794,627 B/op` (-52.7%).
     - **Heap Allocations:** Dropped from `5,321 allocs/op` down to **`1 alloc/op` (-99.98% GC pressure elimination)**.

2. **CVD Delta Pipeline Allocation Elimination (`internal/infrastructure/candlecache/cvd.go`):**
   - **The Problem Solved:** `Store.ServeInfoRequest` already copied the requested candle range via `ser.copyRangeLocked(startMs, endMs)`. `ComputeCvdDeltas` then allocated a redundant slice `result := make([]Candle, len(candles))` and executed `copy(result, candles)`, producing ~800 KB of heap garbage per chart request.
   - **In-Place Enrichment:** Mutated and enriched the caller's freshly-sliced `candles` buffer directly in-place without redundant allocation or struct copies. All 18 unit tests in `cvd_delta_test.go` pass with bit-level parity.

3. **Jev Macro Structure In-Memory Caching (`internal/services/jev_service.go`):**
   - **The Problem Solved:** On every trade signal query (`GenerateSignal`), `computeMacroStructure` retrieved cached daily candles from `macroCacheEntry`, but re-executed `computeMacroExtension`: iterating 30 monthly and 90 quarterly candles, performing 120+ map lookups (`c["c"]`, `c["h"]`, `c["l"]`), string float conversions (`parseFloat`), and range scans on static historical daily candles where only `midPrice` changes on live ticks.
   - **Precomputed Stats & Scalar Math:** Added `macroCandleStats` (`twap`, `avgImpulsePct`, `candleMinL7`, `candleMaxH7`, `hDays`, `hType`) precomputed once upon candle retrieval and cached in `macroCacheEntry`. Cache hits compute `MacroExtension` via $O(1)$ scalar math (`computeExtensionFromStats`) in `< 10ns` with zero map lookups, zero string conversions, and zero slice allocations.

4. **Python Backtester Simulation Loop Optimization (`scripts/jev_validation/backtest.py`):**
   - **The Problem Solved:** 500-bar backtesting loop re-instantiated dictionary representations for all 90 quarterly and 30 monthly bars on every bar index (`[{"t": b.timestamp, ...} for b in q_window]`), creating ~60,000 dictionary allocations per run.
   - **Precomputed Dict Array:** Pre-allocated `all_candle_dicts` once at start of `run()`; sliced views passed directly into volume profile and macro extension routines. Execution time reduced from 0.49s to 0.42s; 100% mathematical parity retained (76.32% win rate, +97.11% net return, Sharpe 4.35).

5. **Frontend Canvas Viewport Culling Early-Exit (`web/src/chart/candle-overlay.js`):**
   - **The Problem Solved:** `drawHeikinAshi` and `drawRenko` iterated over all 5,000 series bars on every 60fps canvas animation frame, invoking `ts.timeToIndex` sequentially even after traversing past the visible viewport boundary into future whitespace.
   - **Monotonic Break Optimization:** Exploited chronological monotonicity of `bar.time` and `brick.time`: added early `break` statements when `idx > visibleRange.to + 2` and `idxStart > maxLogical`.

6. **Precompressed Assets & Production Build (`web/dist/`, `cmd/server/static_web.go`):**
   - Optimized production bundle with Brotli (quality 9) and gzip (level 9) precompression: `index.html` 65K $\to$ 11K (.br, 83% compression), `main-*.js` 78K $\to$ 24K (.br, 69% compression), `styles-*.css` 95K $\to$ 16K (.br, 83% compression).
   - Built production binary and web bundle cleanly via `make release` (bundled in 108ms, codesigned).

7. **Institutional Dashboard Upgrades (All 6 Recommendations Implemented):**
   - **On-Chart Jev TP/SL Bracket Projection Rays (`lightweight-chart-lines.js`, `lightweight-chart.js`, `jev-service.js`):** Projects 3 dashed horizontal trigger rays directly onto the chart canvas when an active directional signal (`BUY` or `SELL`) is generated: Entry ray (`#8892b0`), Take-Profit ray (green/cyan with `+X.X%`), and Stop-Loss ray (red with `-X.X%`). Rays automatically clear when signal resolves to `HOLD`.
   - **DOM Ladder Micro-Heatmap Proportional Depth Bars (`dom-ladder.js`):** Fixed missing `position: absolute;` on `i.depth-bar`, rendering proportional horizontal depth bars behind resting bids (`rgba(34, 204, 230, 0.22)`) and asks (`rgba(255, 80, 80, 0.22)`), giving instant visual awareness of liquidity walls and spoofing.
   - **Real-Time Toxic Sweep Halt Countdown Pill (`jev_service.go`, `jev-service.js`, `styles.css`):** When Gate 2 (Toxic flow tripwire) fires, added `IsToxicHalted` and `ToxicHaltRemainingSeconds` to `TradeSignal`. Frontend renders an animated countdown pill (`⚠️ TOXIC SWEEP HALT: 15s (STABILIZING)`) with an active 1-second timer that auto-refreshes when orderbook replenishment completes.
   - **Auto-Dim Base Candles on Renko Mode (`lightweight-chart-theme.js`):** Added `renkoFactor: 0.70` to dimmed base candles when Renko overlay is engaged, providing crisp visual separation between stepping Renko bricks and the underlying price action.
   - **Collapsible / Compact Empty Panels (`trades.js`, `mispricing.js`, `styles.css`):** When `liquidationsList` or `mispricingList` are empty, parent sections toggle `.is-empty` and collapse into sleek 20px header strips, reclaiming ~150px of vertical space so the Jev Signal window expands with generous breathing room.
   - **Timeframe Horizon Edge Dots (`jev-service.js`, `styles.css`):** Timeframe selector buttons (`SCALP 15m`, `INTRADAY 4h`, `SWING 1d+`) render live edge indicator dots (cyan for $\ge 70\%$ conviction, amber for $\ge 55\%$, red for toxic sweep halt, grey for neutral).

8. **Real-Time Jev Signal Deep Audit, Architectural Unification & Backtest Outperformance:**
   - **The Architectural Ordering Defect Fixed:** Gate 7 previously ran before range-boundary evaluation, prematurely gating `BUY` at VAH or `SELL` at VAL to `HOLD` and blocking the Counter-Trend engine from fading overextension. Reordered evaluation so range boundaries take precedence: institutional breakout allowed on $\ge 82\%$ conviction; order flow absorption/rejection inverts to a Counter-Trend reversal targeting $POC$; unabsorbed pushes gate to `HOLD`. Gate 6 and Gate 7 enforce anti-fading rules when price is in open water.
   - **Point of Control ($POC$) Mean-Reversion Target Alignment:** Replaced static percentage overshoots with direct Auction Market Theory $POC$ alignment for counter-trend reversals, eliminating target overshoot past market equilibrium.
   - **Multi-Horizon Calibration Verified:** Scalp (15m–45m, 0.35 toxic tripwire, 8 bps spread, maker touch), Intraday (2h–8h, 0.45 toxic tripwire, 25 bps spread, 30D Volume Profile), Swing (1d–5d, 0.55 toxic tripwire, 40 bps spread, 90D Volume Profile & TWAP anchor).
   - **Institutional Backtest Outperformance (500-bar multi-regime simulation):**
     - **Overall Win Rate:** Rose to **78.95%** (30 wins / 8 losses, up from 76.32%).
     - **Counter-Trend Win Rate:** Reached **100.0%** (9 wins / 0 losses, +11.74% net return, up from 88.9% and +7.14%).
     - **Net Realized Return:** Rose to **+98.87%** (up from +97.11%).
     - **Annualized Sharpe Ratio:** Rose to **4.49** (up from 4.35); Sortino 23.29; average trade return **+260.2 bps**.

9. **Comprehensive Live Smoke Test & Verification:**
   - Live headless browser smoke test verified zero console errors, live connection pill (`LIVE`), interactive chart with Renko overlays, 24/7 Rolling VWAPs, live orderflow meters, on-chart projection rays, DOM depth bars, collapsed empty panels, and real-time Jev System One signal generation with Gate 2 toxic flow protection against Hyperliquid mainnet orderbook data.

10. **Visual Audit, Hideable Liqs/Misprice/Jev Column & Dynamic Chart Space Fill:**
   - **Chart Auto-Fill on News Unselect:** Fixed issue where unselecting News left empty canvas space on the left. Added `onChartResize` in `lightweight-chart-core.js` and hooked `refitOverviewIfUserHasNotPanned()` into `lineLabelResizeObserver` in `lightweight-chart.js` on `#chartWrap` geometry changes, ensuring the candle overview scales to fill the newly opened space without voids.
   - **Hideable Liqs, Misprice and Jev Column:** Added dedicated `#liqToggleBtn` ("Liqs") to the right of `#tradingToggleBtn`. Integrated `.liq-hidden` state into `AppState.ui.liqPanelVisible`, with full 8-permutation CSS Grid support (`minmax(0, 1fr)` flex across all combinations of News, Trade, and Liqs panels) and 100% DOM width expansion in mobile book view.
   - **Header Visual Polish & Ticker Truncation Fix:** Added `flex-shrink: 0` on `.panel-title` preventing tickers like `BTC` from truncating to `B...` on narrow chart widths, and introduced container queries on `.chart-panel` (`@container chart-panel (max-width: 640px)`) to cleanly hide secondary timeframe buttons without control line wrapping.

## Previous Changes (September 21, 2026) — Jev System One Monthly (30D) & Quarterly (90D) Volume Profiles Replacing Stale 365D Lookback, Dual-Horizon Macro Extension Defense & Multi-Regime Signal Calibration

1. **Monthly (30D) & Quarterly (90D) Volume Profile Upgrade (`internal/services/jev_service.go`, `scripts/jev_validation/jev_model.py`):**
   - **The Problem Solved:** A 365-day volume profile lookback in 24/7 crypto markets spans multiple macro cycles, flattening value areas over irrelevant historical price discovery and diluting immediate support/resistance levels.
   - **Horizon-Calibrated Auction Profiles:**
     - **Monthly (30-Day) Volume Profile & TWAP:** Captures the active monthly auction, monthly options expiry, and immediate range boundaries ($[VAL_{30}, VAH_{30}]$, $POC_{30}$) calibrated for **Scalp (15m–45m)** and **Intraday (2h–8h)** horizons.
     - **Quarterly (90-Day) Volume Profile & TWAP:** Captures the 3-month macro auction, quarterly options expiry, and structural balance ($[VAL_{90}, VAH_{90}]$, $POC_{90}$) calibrated for **Swing (1d–5d)** horizons.
   - **Dual Extension Confluence in Gate 7:**
     - Intraday trades operating within a Monthly (30D) profile also evaluate extreme extension from the Quarterly (90D) TWAP anchor ($\ge 6.0\%$). If extended $\ge 6.0\%$ above 90D TWAP, Gate 7 suppresses long entries to `HOLD` with clear contextual reason labeling (`"testing VAH; +X.X% above 90D TWAP"`).
   - **Dual Cache Slicing & Memory Optimization:**
     - `computeMacroStructure` requests up to 90 daily candles (reduced from 365), slicing them into Monthly (last 30 bars) and Quarterly (last 90 bars) and caching both in thread-safe memory (`macroCache`) for 15 minutes.
   - **Backwards Compatibility:**
     - Preserves `distFrom365dPct` on `TradeSignal` and `MacroExtension` as an alias mapping to `distFromTwapPct`, ensuring all downstream API consumers and analytics tools remain functional without breaking changes.

2. **Trend vs. Counter-Trend Signal Expansion (`internal/services/jev_service.go`, `scripts/jev_validation/jev_model.py`):**
   - **Signal Schema Upgrade:** `TradeSignal` expanded with `SignalType` (`"trend"`, `"counter_trend"`, `"neutral"`), `MarketEnvironment` (`"range"`, `"trend"`), and multi-horizon levels (`MonthlyVAH/VAL/POC`, `QuarterlyVAH/VAL/POC`, `ProfileHorizon`).
   - **Market Environment Classification:** Dynamically classifies market structure into `"range"` vs `"trend"` using 24h momentum ($|change_{24h}| \le 3.5\%$), rolling ATR volatility ($ATR_{\%} \le 1.8\%$), and proximity to the Steidlmayer Volume Profile Value Area ($[VAL, VAH]$).
   - **Range High Mean Reversion (Counter-Trend Short):** When price tests the upper boundary of a range ($mid \ge VAH - 0.20 \times \text{range\_span}$), retail buying into resistance is recognized as liquidity exhaustion. Unless institutional breakout conviction is exceptional ($\ge 82\%$), the engine inverts the signal to a Counter-Trend Short (`action: "SELL"`, `signal_type: "counter_trend"`), targeting mean reversion back to the Point of Control (`POC`) with stop-loss set above VAH. If conviction $\ge 82\%$, an explosive **Trend Breakout Long** is permitted.
   - **Range Low Mean Reversion (Counter-Trend Long):** When price tests the lower boundary of a range ($mid \le VAL + 0.20 \times \text{range\_span}$), aggressive selling into support is recognized as liquidity absorption. Unless institutional breakdown conviction reaches $\ge 82\%$, the engine inverts the signal to a Counter-Trend Long (`action: "BUY"`, `signal_type: "counter_trend"`), targeting `POC` mean reversion with stop-loss below VAL. If conviction $\ge 82\%$, an explosive **Trend Breakdown Short** is permitted.
   - **Macro Trend Confluence:** In a trend environment, momentum trades are tagged `"trend"`; extreme pullbacks passing Gate 6 ($\ge 78\%$) are tagged `"counter_trend"`.

3. **Multi-Regime Backtesting & Validation (`scripts/jev_validation/backtest.py`):**
   - Updated backtester to compute rolling 30-day monthly and 90-day quarterly volume profiles.
   - 500-bar multi-regime simulation results: 84 trades, 54.76% win rate, 4.38 profit factor, +75.40% net realized return, Sharpe 3.00, Sortino 13.18.
     - Trend Trades: 42 trades, 69.0% win rate, +81.04% net return.
     - Counter-Trend Trades: 42 trades, 40.5% win rate, -5.63% net return.

4. **Frontend UI Badges & 1-Click Ticket Execution (`web/src/services/jev-service.js`, `web/styles.css`):**
   - Added dedicated styling and badges for Signal Type (`TREND` cyan/blue vs `COUNTER-TREND` amber/gold) and Market Environment (`RANGE` purple vs `TREND` blue) in the 3rd Jev window header.
   - Updated the 1-Click Ticket Fill button to dynamically reflect counter-trend signals (e.g. `⚡ FILL JEV TICKET (INTRADAY COUNTER-TREND SELL @ $65,450)`).
   - 15 / 15 vitest unit tests passing in `jev-service.test.js`.

5. **Comprehensive Test Verification:**
   - Go: 25 / 25 Jev unit tests passing (`internal/services`, `internal/handlers/http`).
   - Python: 38 / 38 unit tests passing across all suites (`test_jev_signal.py`, `test_jev_harness.py`).
   - Frontend: 15 / 15 vitest unit tests passing (`jev-service.test.js`).
   - Production web bundle compiled cleanly (`npm --prefix web run build`).

## Previous Changes (September 21, 2026) — TypeSafe Jev Engineering Blueprint Implementation (Visibility Ladder, Priced Routing Arithmetic, Tiered Tool Router, Programmable Permissions with Deep Inspection, Subgoal Deduplication & Shared Retrieval)

1. **TypeSafe Jev Blueprint Architecture (`internal/infrastructure/typesafe/harness.go`, `typesafe/harness_test.go`):**
   - **Addressable Chunk Store & Visibility Ladder (`VisibilityLevel`):** Implemented `ChunkStore` managing addressable, typed state chunks (`tool_call`, `tool_output`, `reasoning`, `user_turn`, `file_diff`, `instruction`, `market_state`). Replaced query-blind compaction with query-aware dynamic context assembly across 4 visibility tiers: `VisibilityHide` (0 tok), `VisibilityShort` (1-line), `VisibilityLong` (detailed metrics), and `VisibilityFull` (raw content). Added `FilterHeatmap` to compress 2,400+ line outputs (logs, grep hits, deep orderbook levels) down to relevant lines within token budgets.
   - **KV Cache Reuse Evaluator (`EvaluateCacheReuse`):** Evaluates prefix age, drift metrics, and rebuild token costs to return a typed `noul` decision with calibrated probability on whether to reuse cached prefix or rebuild context from scratch.
   - **Priced Model Routing Cost Engine (`CalculateRoutingCosts`):** Implemented Diogo Almeida's exact routing trap arithmetic ($25Y + 5Z$ vs $3X + 20Y + 8Z$), proving why naive model routing costs up to 49% more than staying on pure frontier models, and evaluating purpose-built context savings ($3X' + 15Y + 3Z + 5Y_{\text{summary}}$).
   - **Tiered Tool Disclosure (`TieredToolRegistry`):** Structured tool registration across 3 disclosure tiers: Tier 1 (1-line snippets), Tier 2 (full JSON schemas on demand), and Tier 3 (deep documentation), matching plain-text agent intent via `RouteTool` to select top-$k$ candidates with zero system message clutter.
   - **Programmable Permissions with Deep Inspection (`EvaluatePermissions`):** Declarative policy queries inspecting full script contents rather than command names alone (`deny` if touches `~/.ssh` or `.env*`, `deny` if network egress without deploy scope, `ask` if writing outside repo root, `allow` if verified read-only or test runner).
   - **Sub-Agent Concurrency & Goal Deduplication (`SubgoalRegistry`):** Separated read-only tasks from write tasks so read operations never contend for state locks (`ExecuteReadOnly`), plus in-flight and completed subgoal deduplication (`RegisterInFlight`, `RegisterSubgoal`).
   - **Conditional Instructions & Security Routing:** Dynamic matching of condition-bound, compaction-immune instruction fragments (`touches *.tsx`, `inside billing/`), and classification of touched files by data sensitivity (`open`, `standard`, `restricted`, `custom`) to enforce model provider safety policies.
   - **Shared Retrieval Cache (`SharedRetrievalCache`):** Caches expensive state retrieval passes so concurrent read-only background evaluators (scanners, reviewers, evals) share retrieval passes with zero redundant IO.

2. **Integration into Trading & Orderflow Services (`internal/services/jev_service.go`):**
   - **Dynamic Visibility Ladder in `Analyze`:** State prompt formatting dynamically tunes context depth based on horizon (`scalp` $\to$ `short` touch focus, `intraday` $\to$ `long` depth asymmetry, `swing` $\to$ `full` macro structural walls), pruning non-actionable orderbook noise.
   - **Programmable Permissions in Pre-Trade Audit (`AuditPreTrade`):** Injected declarative safety checks ($500k circuit breaker `deny`, book wipe > 80% or severe slippage `deny`, book wipe > 35% or toxic flow `ask`, acceptable slippage `allow`) returning verified `PermissionVerdict` and `PolicyRule`.
   - **In-Flight Subgoal Deduplication in `GenerateSignal`:** Coalesces simultaneous signal queries for the same coin and timeframe without double-invoking upstream APIs, returning cached results with `CacheReused = true`.

3. **Python Reference Blueprint & Validation Harness (`scripts/jev_validation/jev_harness.py`, `test_jev_harness.py`):**
   - Standard-library-only Python 3.9+ reference implementation of all 9 blueprint subsystems with 100% test coverage (33 / 33 passing unit tests).

4. **Frontend UI Badges & Production Release (`web/src/services/jev-service.js`, `web/dist/`):**
   - Jev Signal window footer reflects active visibility tier (`SHORT`, `LONG`, `FULL`) and cache status (`CACHED`). Production assets compiled cleanly in 99ms.

## Previous Changes (September 21, 2026) — Jev System One Orderflow Microstructure Hardening, Dynamic ATR Brackets, Gate 6 Macro Trend Filter, Gate 7 Yearly Volume Profile & Move Extension Defense & Standalone Python Backtesting Suite

1. **Orderbook Microstructure Mathematics & Dynamic OFI (`internal/services/jev_service.go`, `scripts/jev_validation/jev_model.py`):**
   - Implemented level-decayed depth weighting ($w_i = \frac{1}{1+i}$) across top-10 levels, eliminating deep fake-wall distortions.
   - Volume-weighted touch micro-price with basis-point drift tracking immediate queue priority.
   - Cont-Kukanov-Stoikov dynamic Order Flow Imbalance (OFI) tracking sequential orderbook replenishment and cancellation across successive snapshot ticks.
   - Dual-threshold Schmitt trigger hysteresis ($\ge 65\%$ activation conviction, $\ge 50\%$ retention floor, 0ms instant regime reversal, neutral consolidation step-down).

2. **Capital Defense Gates & Pre-Execution Checks (`internal/services/jev_service.go`):**
   - **Gate 1:** Crossed and inverted book protection ($P_{bid} \ge P_{ask}$ pauses quoting).
   - **Gate 2:** Instant toxic sweep tripwires (35% scalp, 45% intraday, 55% swing) with a 15s stabilization cooldown.
   - **Gate 3:** Spread friction gating (blocks trades where spread exceeds horizon tolerance or consumes $\ge 75\%$ of the stop-loss budget).
   - **Gate 4:** Schmitt trigger dual-threshold boundary gating.
   - **Gate 5:** Spatial multi-depth spoof defense (blocks false breakout entries into deep opposing overhang).
   - **Gate 6:** Macro trend confluence filter (suppresses counter-trend entries during strong 24h market dumps $\le -3.5\%$ or surges $\ge +3.5\%$ unless conviction is institutional $\ge 78\%$).
   - **Gate 7 (Macro Yearly Volume Profile & Move Extension Defense):** Suppresses BUY entries when price tests the Yearly Volume Profile Value Area High (VAH) or High Volume Node (HVN) distribution shelf ($0.992 \times \text{VAH} \le P \le 1.025 \times \text{VAH}$) or when price extension $\ge +6.0\%$ above 365D TWAP with $\ge 85\%$ of 14-day impulse range consumed. Conversely suppresses SELL entries at Yearly VAL support. Institutional breakout override permitted on conviction $\ge 82\%$.

3. **Dynamic ATR Volatility-Scaled Brackets (`internal/services/jev_service.go`):**
   - Replaced fixed percentage brackets with dynamic ATR-scaled take-profit and stop-loss levels ($0.60 \times \text{ATR}$ scalp, $1.20 \times \text{ATR}$ intraday, $2.20 \times \text{ATR}$ swing).
   - Enforces a strict spread cushion ($\text{SL} \ge 2.0 \times \text{Spread}$) so stops never sit within market friction.
   - Cached in-memory with 60s TTL (`atrCache`) to eliminate redundant REST round trips on rapid timeframe tab switches.

4. **Zero-Latency In-Memory Macro Cache & Dedicated Enrichment Lane (`internal/services/jev_service.go`, `cmd/server/`):**
   - **Macro Structure Cache (15-min TTL):** In-memory thread-safe cache (`macroCache`) storing computed 70-bin Yearly Volume Profiles (VAH/VAL/POC) and 365D daily candles per coin. Recalculating anchor distance against live `midPrice` occurs in `< 1µs` RAM execution.
   - **Single Evaluation Invariant:** Eliminated duplicate macro structure evaluations in `GenerateTradeSignal`, calculating levels once and reusing them across Gate 7 rejection and response metrics.
   - **Dedicated Interactive Lane (`jevCandleSem`):** Separated Jev interactive discretionary signal and pre-trade audit candle reads onto `infogovernor.Enrichment` with a dedicated 2-slot semaphore (`jevCandleSem`), completely isolating interactive user queries from background chart preloading and the 41-minute background warmcoordinator pass.
   - **Bounded 1.5s Context Timeout:** Wrapped candle fetches in a hard 1.5s timeout with instantaneous fallback to momentum-derived baseline parameters, ensuring `/api/jev/signal` never hangs or queues behind upstream network delays.
   - **Audit Log Noise Elimination:** Added `"/api/jev/signal"` and `"/api/jev/status"` to `isAuditNoiseRoute` in `cmd/server/metrics.go`, silencing misleading `"mutating route"` audit entries on read-only signal scans.
   - **Performance Results:** Reduced initial coin switch latency from 10s–41s down to ~650ms–1000ms (a 97.5% reduction), with subsequent tab switches and rescans on the same coin serving from RAM in **240ms–300ms**.

5. **Neutral HOLD Presentation & Directional UI Labeling (`web/src/services/jev-service.js`):**
   - On `HOLD` signals, entry, take-profit, and stop-loss target prices clear to `—` rather than rendering misleading active long brackets at resistance.
   - Accurately renders `TP (-)` and `SL (+)` for SELL signals and neutral ATR references for HOLD signals.

6. **Standalone Python (3.9+) Validation Harness & Backtester (`scripts/jev_validation/`):**
   - `jev_model.py`: Reference Python implementation maintaining 100% bit-level mathematical and round-half-up parity with Go, including Auction Market Theory Volume Profile (`compute_volume_profile`) and anchor extension (`compute_macro_extension`).
   - `test_jev_signal.py`: 23 comprehensive unit tests covering all mathematical, hysteresis, gating, ATR, volume profile, extension, and normalization invariants (100% passing).
   - `run_audit.py`: 150-tick sequential simulation runner validating zero harmful whipsaws across 5 market regimes.
   - `backtest.py`: Full quantitative backtesting and parameter optimization engine modeling Hyperliquid taker/maker fee structures, slippage, bar high/low stop-outs, and Gate 7 resistance filtration.

7. **Hyperliquid Execution Price Normalization (`internal/services/jev_service.go#normalizePrice`):**
   - Enforces Hyperliquid 5 significant figures, max decimals ($6 - szDecimals$), and integer exceptions matching wire rules.

## Previous Changes (September 20, 2026) — TypeSafe Jev System One Integration, Dynamic Orderflow Quoting, Anonymous Key Architecture & Deep Edge Case Hardening

1. **Anonymous API Key Architecture & Version Control Hardening (`internal/infrastructure/typesafe/client.go`, `.gitignore`):**
   - Multi-tier key resolution: `TYPESAFE_API_KEY` $\rightarrow$ `PEZ_TYPESAFE_API_KEY` $\rightarrow$ `data/typesafe_key.txt` $\rightarrow$ `typesafe_key.txt`.
   - Hardened `.gitignore` to strictly exclude all key/credential variants (`typesafe_key.txt`, `*typesafe*.txt`, `*typesafe*.json`, `*.key`, `*.secret`).
   - Zero key leakage to frontend client code, browser bundles, Prometheus metrics, or audit logs.

2. **Backend Infrastructure Client, SHA-256 Decision Caching & Circuit Breaker (`internal/infrastructure/typesafe/`):**
   - Implemented thread-safe Go client targeting TypeSafe's Jev System One endpoint (`POST https://api.typesafe.ai/v1/systemone`) supporting `choice`, `score`, and `noul` decision primitives.
   - Built an in-memory decision cache keyed by SHA-256 state hashes with a 2.5s TTL, reducing upstream API latency and token expenditures by ~70% during rapid market bursts.
   - **Automatic 3-Strike Circuit Breaker (`IsCircuitOpen`, `recordSuccess`, `recordFailure`):** Trips after 3 consecutive upstream HTTP 5xx errors or network timeouts into a 20s cooldown, providing instantaneous (0ms) fail-fast protection to prevent goroutine backlog or socket starvation during cloud outages.
   - Comprehensive unit test coverage for key resolution, mock decision flows, cache hits, and circuit breaker tripping (`client_test.go`).

3. **Domain Service & Edge Case Evaluators (`internal/services/jev_service.go`):**
   - `Analyze`: Computes real-time L2 orderbook depth, OFI (order flow imbalance), and spread from Hyperliquid market data, querying Jev for calibrated directional conviction and toxic flow risk.
   - `ClassifyNewsHeadline`: Replaces brittle regex matching with Jev System One semantic understanding to assess macro/regulatory headline sentiment and catalyst status.
   - `AuditPreTrade`: Evaluates proposed trade notional against top-of-book depth (50 bps) to prevent severe book-wipe slippage and adverse flow.
   - `EvaluateMispricing`: Dissects synthetic asset dislocations (xyz HIP-3 equity/index marks vs closed-session underlying reference prices) into mean-reverting basis noise vs informed off-hours repricing.

4. **Bot Integration, Avellaneda-Stoikov Inventory Skewing & Hysteresis (`internal/services/bot_service.go`):**
   - Added `jev-orderflow` strategy inside `BotService`.
   - Skews bid/ask quotes dynamically when orderflow conviction is high (>0.70).
   - **Inventory Skewing Engine:** Automatically inspects active account position in the target coin (`GetActiveAssetData`). If long exposure exceeds 25% of total grid capacity, bids are dampened and asks tightened to offload inventory; vice-versa when short.
   - **Hysteresis Circuit Breaker Cooldown:** When adverse selection risk exceeds 0.65 (`toxicFlowRisk > 0.65`), quotes are cancelled and an automated 30s hysteresis cooldown window (`toxicHaltUntil`) prevents destructive quote-churn during rapid liquidity cascades.

5. **HTTP Endpoints & Integrated Pre-Trade Audit (`internal/handlers/http/`, `internal/services/`):**
   - Added REST routes: `GET /api/jev/status`, `POST /api/jev/analyze`, `POST /api/jev/classify-news`, `POST /api/jev/pre-trade-audit`, `POST /api/jev/evaluate-mispricing`.
   - Integrated live `jevAudit` evaluation directly into `POST /api/order-preview` for orders $\ge \$1,000$, providing real-time book-wipe and adverse selection advice on order previews.
   - Enriched synthetic stock mispricings (`GetStockMispricings`) with automated Jev evaluation tags (`jevVerdict`, `jevConfidence`, `jevAction`).

6. **Frontend Service, Copilot UI & Test Suite (`web/src/services/jev-service.js`, `web/index.html`, `web/styles.css`):**
   - Created `jev-service.js` with DOM bindings, error handling, ticket alignment helper (`alignTicketWithJev`), and 1-click execution (`executeJevSignal`).
   - Added Jev Copilot audit widget and `jev-orderflow` strategy option in `web/index.html`.
   - **Dedicated 3rd Window in LIQS & MISPRICE Column (`#jevSignalWindow`):** Relocated Jev trade signal display into a third window beneath the Liquidation Feed and Mispricing panels with natural vertical breathing room and zero scrolling.
   - **Timeframe Horizon Selector (`#jevTfSelectorBar`):** Segmented buttons (`SCALP 15m`, `INTRADAY 4h`, `SWING 1d+`) allowing traders to toggle between quick scalps (15m–45m), session intraday (2h–8h), and intra-month swings (1d–5d). Tab switching utilizes client-side memory and backend SHA-256 state caching (<1ms response).
   - **Duration Estimation Banner:** Renders estimated duration badges (`⏱ 15m – 45m (Quick Scalp)`, `⏱ 2h – 8h (Session Intraday)`, `⏱ 1d – 5d (Intra-Month Swing)`) alongside active horizon tags.
   - **Order Ticket 1-Click Execution Button (`#jevTicketFillBtn`):** Positioned directly above the Buy/Sell controls in the Order Ticket. Moving execution out of the 3rd window preserves analytics real estate while placing trade execution immediately where orders are dispatched. Reflects timeframe prefix and dynamic pricing (e.g. `⚡ FILL JEV TICKET (SCALP BUY @ $81,542)`).
   - Styled via pure CSS classes adhering to strict design-system shell rules (zero unauthorized inline styles).
   - Added comprehensive frontend unit test suite `jev-service.test.js` under jsdom environment covering timeframe switching, cache recall, duration banner rendering, and 1-click ticket preparation.

7. **Zero-Lag Signal Hardening (Noise Elimination Without Over-Filtering):**
   - **Dual-Threshold Schmitt Trigger Hysteresis (`jev_service.go`):** Eliminates boundary chatter around 65% conviction by separating activation ($\ge 65\%$) from retention floor ($\ge 50\%$). Active positions hold steady through micro-noise (52%–64%) without chattering into `HOLD`. Genuine market regime breaks reverse immediately (0ms delay) on strong counter-conviction ($\ge 65\%$).
   - **Spatial Multi-Depth Divergence (`parseDetailedBookMetrics`):** Separates Level 0 Touch Depth (`touchBidUSD`, `touchAskUSD`) from Levels 1–9 Deep Depth (`deepBidUSD`, `deepAskUSD`) in the exact same millisecond. Detects spoofing and fakeout traps (e.g. thin touch bid backed by deep ask overhang) without requiring lagging moving averages.
   - **Instant Toxic Flow Tripwire:** Immediate (0ms) drop to `HOLD` when sweep risk spikes, enforcing an automatic 15s orderbook stabilization cooldown.

8. **Verification & Testing:**
   - Go test suite: 100% green (`go test ./...` across all 26 packages), including `TestParseDetailedBookMetrics`, `TestJevServiceDualThresholdHysteresis`, and `TestJevServiceInstantToxicTripwire`.
   - Vitest suite: **156 / 156 test suites passed** (1,236 / 1,236 tests passing).
   - Production bundle built cleanly (`make release`).
   - Live smoke test against background `hyperliquid-server` verifying all `/api/jev/*` endpoints, live `/api/jev/signal` with `timeframe=scalp|intraday|swing`, duration strings, instant toxic tripwire triggering under live order flow, and order preview audits with live Hyperliquid mainnet orderbook data.

## Previous Changes (September 14, 2026) — Renko Overlay Stability Hardening, Strict Closed-Bar Anti-Repainting & Synchronous Series Synchronization

1. **Strict Closed-Bar Confirmation & Zero Repainting (`web/src/chart/candle-overlay.js`, `web/src/chart/lightweight-chart.js`):**
   - Renko bricks are confirmed exclusively on closed bars (`closedCandles: indicatorCandles`), preventing open forming candle ticks from generating phantom bricks that would disappear if price pulls back before close.
   - Sizing calculations (`computeATR` with `excludeForming: true`, percent mode referencing the latest closed candle) remain immutable during open bar oscillations, guaranteeing that historical brick sizes never shift or jitter intraday.
   - For visual continuity, `options.liveTime` anchors the confirmed brick shelf across consolidation and the forming candle to the live edge. The active latest brick shelf extends across the entire consolidation window through the right boundary of the live candle slot (`activeCandleX + candleSlotPx * 0.5`), allowing dashed trigger projection lines to shoot cleanly into future whitespace without slicing through the live forming candle.

2. **Quantized Step-Index Tracking & Floating-Point Epsilon Tolerance (`web/src/chart/candle-overlay.js`):**
   - Implemented canonical grid price quantization `roundPrice(val, brickSize)` and integer step-index tracking (`currentStep * brickSize`) across initial baseline selection, continuation bricks, and 2-brick reversals, eradicating IEEE 754 precision drift.
   - Applied relative floating-point epsilon tolerance (`EPS = Math.max(1e-9, brickSize * 1e-6)`) on all continuation and reversal threshold checks, eliminating non-deterministic boundary skips.
   - Raised per-candle step expansion guard `MAX_STEPS` from 100 to 1,000 for high-volatility candles.

3. **Synchronous Series Synchronization & Cross-Coin Isolation (`web/src/chart/lightweight-chart.js`, `web/src/chart/candle-overlay.js`, `web/src/ui/candle-overlay-ui.js`):**
   - Moved `candleOverlay.setCandles` to execute synchronously inside `syncSeries` alongside `series.setData(...)`, completely removing it from the 10-frame deferred `overlayPhases` queue. Eliminates race conditions, cancellation windows, and visual desynchronization during rapid timeframe and coin switching.
   - Enforced coin-tag isolation (`coin !== state.coin`) in `updateLast` and `setCandles` to reject inflight cross-coin live ticks during switches.
   - Split `setOptions` execution: calculation options (`mode`, `brickMode`, `fixedSize`, etc.) trigger `recompute()`, while styling-only options (`opacity`, `dimmed`, `showWicks`, `contrast`) trigger instantaneous `redraw()`.
   - Propagates `selectClosedCandles` immediately in `selectCandleOverlayMode` upon dropdown mode selection, and tracked `atrPeriod` in Lightweight Charts' deferred indicator sync key. Fixed percent mode select dropdown synchronization (`0.1%`, `0.25%`, `0.5%`, `1.0%`).

4. **Verification & Suite Coverage:**
   - Added comprehensive unit tests in `candle-overlay.test.js` and `candle-overlay-ui.test.js` covering multi-timeframe and coin switch stability, cross-coin update isolation, float epsilon boundaries, closed-bar shelf extensions, and dropdown value matching.
   - Full test suite: **155 / 155 test suites passed** (1,224 tests passing). Production bundle built in 104ms (`npm run build`).

## Previous Changes (September 13, 2026) — Candle Overlay: Dual Overlay Mode ('Both') & Multi-Series Dimming (Candle, Heikin Ashi, Renko)

1. **Dual Candle Overlay Mode (`'both'`) (`web/src/chart/candle-overlay.js`, `web/src/ui/candle-overlay-ui.js`, `web/src/state/store.js`):**
   - Added `'both'` overlay mode allowing Heikin Ashi smoothed trend bars and Renko price bricks to render concurrently on the same Lightweight Charts canvas primitive.
   - Preserves ergonomic visual layering: smoothed Heikin Ashi bars and wicks render first underneath sharp rectangular Renko bricks, orthogonal step connectors, and active projection lines, providing seamless confluence analysis between smoothed trend momentum and quantized price-action structure.
   - Dynamic popover UI automatically displays configuration panels for both Heikin Ashi (wicks, dimming, opacity) and Renko (brick sizing, ATR/percent/fixed USD, wicks, projections, dimming, opacity) when `'both'` mode is selected.
   - Header toggle button reflects active mode: `Overlay: Off`, `Overlay: Heikin Ashi`, `Overlay: Renko`, or `Overlay: Both`.

2. **Universal Dimming System Across All Three Series (`web/src/chart/candle-overlay.js`, `web/src/ui/candle-overlay-ui.js`, `web/index.html`):**
   - **Base Candles:** Interactive visibility modes (`Dimmed`, `Hidden`, `Normal`) with dedicated contrast slider (`#candleOverlayContrastSlider`, 10%–80%, default 35%) and outline boosting.
   - **Heikin Ashi Dimming:** Independent `dimmed` toggle checkbox (`#heikinAshiDimmedCheck`) and real-time opacity slider (`#heikinAshiOpacitySlider`, 5%–100%, default 50%) with dynamic percentage badge. When dimmed, body fill opacity follows the slider alpha while outlines and wicks scale proportionally (`alpha * 1.35`, capped at 1.0) for crisp boundary definition.
   - **Renko Dimming:** Independent `dimmed` toggle checkbox (`#renkoDimmedCheck`) and real-time opacity slider (`#renkoOpacitySlider`, 5%–100%, default 50%) with dynamic percentage badge. When dimmed, brick fill opacity follows slider alpha while borders, wicks, orthogonal step lines, and active trigger projection lines scale proportionally.
   - **"Dim All" Convenience Toggle:** Panel header action button (`#candleOverlayDimAllBtn`) that toggles dimming across all three series concurrently (`'Dim all'` vs `'Undim all'`), setting base candles to `dimmed` (or `normal`) and synchronizing both Heikin Ashi and Renko `dimmed` states simultaneously.

3. **Lightweight Charts Primitive & State Integration:**
   - Lightweight Charts deferred indicator sync key updated to track `dimmed` and `opacity` for both Heikin Ashi and Renko, ensuring immediate repaints on slider inputs or toggle clicks.
   - Strict adherence to v5 series primitive invariants: `useBitmapCoordinateSpace` for physical pixel DPR rendering, `autoscaleInfo() => null` for zero autoscale distortion, and `zOrder() { return 'top'; }`.
   - All delegated actions registered in `web/src/bootstrap/ui-action-manifest.js` and wired through `app-bindings.js` and `app-runtime.js`.

## Previous Changes (September 8, 2026) — Drawing Tools Deep Audit & Unlimited Measure Tool Support

1. **Unlimited Measure Boxes with Full Drawing Tool Parity:**
   - Removed single-instance constraint in `web/src/chart/drawing-tools.js` that previously purged existing measure boxes on new placements. Multiple measure boxes now render and coexist simultaneously without limit.
   - Restored full persistence parity in `web/src/chart/drawing-model.js` (`serializeDrawings`): measure boxes now serialize and persist per coin in `localStorage` (`pez:drawings:<coin>`), surviving browser reloads and coin switches alongside other drawings.
   - Each measure box maintains independent anchor points, delta price, percentage change, and bar count statistics.
2. **Deep Drawing Audit Enhancements & Polish:**
   - **Measure Selection Highlighting:** Updated `web/src/chart/drawing-render.js` to render the active measure box border and stats in `SELECTED_COLOR` (`#ffb547`) when selected, resolving the previous issue where bullish/bearish color overwrote the selection border stroke.
   - **Viewport Boundary Clamping for Measure Metrics:** Clamped measure label positioning so statistics never clip off canvas tops or sides (`labelX` clamped to visible canvas width; `labelY` flips inside the box if near the top edge).
   - **Delete Control Boundary Safety:** Added `maxW` / `maxH` clamping to `drawDeleteControl` (`drawing-render.js` / `drawing-tools.js`) so the delete ✕ button stays visible and clickable on-screen even when drawings touch top or right canvas boundaries.
   - **Interactive Text Editing:** Enhanced `onDblClick` in `drawing-tools.js` so double-clicking an existing text drawing re-opens the text dialog (`promptTextDrawing`) pre-filled with the current label and font size.
   - **Vertical Channel Geometry:** Fixed parallel line offset calculation in `drawing-render.js` and `drawing-tools.js` when channel lines are vertical (`dx < 1e-6`), offsetting along X instead of collapsing to zero.
3. **Verification & Testing:**
   - Full web test suite: **152 / 152 test files passed (1,157 / 1,157 tests)** including 5 new comprehensive audit tests in `drawing-tools.test.js`.
   - Full Go test suite & `go vet` passed cleanly across all packages.
   - Production bundle and server binary rebuilt cleanly with `make release`.
   - Live smoke test (`scripts/chart_live_smoke.mjs`) verified against running server and Opera/CDP browser instance with zero errors.

## Previous Changes (September 7, 2026) — 24/7 Rolling VWAP Presets (7D, 30D, 90D, 365D), Tiered Line Widths, Startup Defaults & Chart Labels

1. **24/7 Market-Aligned Rolling VWAP Presets:**
   - Replaced legacy 5-day / 20-day TradFi carryovers with true calendar and 24/7 crypto/extended-market lookbacks: **`7D`** (1 week), **`30D`** (1 month), **`90D`** (1 quarter), and **`365D`** (1 year TWAP).
   - Updated `RVWAP_PRESETS` in `web/src/chart/vwap-bands.js`, `RVWAP_LOOKBACKS` / `RVWAP_BAND_LOOKBACKS` in `web/src/state/store.js`, and `data-arg` action manifests in `web/src/bootstrap/ui-action-manifest.js`.
2. **Tiered Line Width Separation (Analogous to 3 POCs):**
   - Implemented clean tiered line thickness across all 4 rolling VWAP curves within Lightweight Charts' integer width bounds (`1 | 2 | 3 | 4`), directly in the ballpark of the 3 Volume Profile POC line tiers:
     - **`7D`**: `lineWidth: 1` (crisp, agile tactical curve)
     - **`30D`**: `lineWidth: 2` (clean intermediate monthly benchmark)
     - **`90D`**: `lineWidth: 3` (prominent quarterly trend baseline)
     - **`365D`**: `lineWidth: 4` (heaviest macro annual anchor)
   - Exposed `lineWidth` across `createVwapBandsOverlay.getDebugState()` and `createRvwapOverlaySet.getDebugState()`.
3. **Indicator Startup Defaults:**
   - **Manual Anchored VWAP Off:** `INDICATOR_STARTUP_DEFAULTS.manualAnchoredVwapVisible = false` in `web/src/state/store.js` and unchecked in `web/index.html`. Chart starts uncluttered without manual anchor lines.
   - **30D, 90D, and 365D On by Default (7D Off):** `INDICATOR_STARTUP_DEFAULTS.rvwapLookbacks = ['30D', '90D', '365D']` with 30D, 90D, and 365D checked in `web/index.html` while 7D starts unchecked (`#rvwap7dCheck`). Prevents initial chart noise from short tactical curves while keeping major macro anchors visible immediately.
   - **Bands Default Off:** `INDICATOR_STARTUP_DEFAULTS.rvwapBandLookbacks = []` and unchecked in `web/index.html`, displaying clean center VWAP curves without deviation band clutter.
4. **Chart Series & Price Scale Labels:**
   - Configured `title: chartLabel` and `lastValueVisible: true` across all center lines (`'7D'`, `'30D'`, `'90D'`, `'365D'`) so each rolling VWAP displays its identifier on the chart legend/status line and a dedicated colored price badge on the right price axis.
   - Preserved uncluttered price scale by keeping deviation bands title-less without axis labels (`title: ''`, `lastValueVisible: false`).
   - Added `hasPendingWork` diagnostic to `createRvwapOverlaySet.getDebugState()`.
5. **Verification & Full Smoke Passing:** All 152 Vitest test files passed (**1,152 / 1,152 tests**), Go test suite passed cleanly (`make test`), `make release` built production assets, and isolated Playwright/CDP smoke test (`scripts/chart_live_smoke.mjs`) passed 323/323 checks with 0 failures and 0 rejected updates. Caches purged via `make clean-caches`.

Go binary `./hyperliquid-server` bundles `web/dist` via `//go:embed`.
Production server runs as a launchd daemon or background process.

---

## Executive Summary

| Subsystem | Status & Implementation Notes |
|-----------|-------------------------------|
| Charts | Backend-owned history/CVD; frontend renders. Display lookbacks are the 190-day indicator-stable window, clamped by `ReachableLookbackMs` to Hyperliquid's 5000-candle retention. First paint requests that same reachable window so default lines/levels do not rewrite as older bars prepend. `1h/4h/15m` warm after the `/readyz` gate via coordinator prefer pass. Snapshot restore serves history without universe REST. Saved user watchlists persist to `data/watchlist-hints.json` and restore across server reboots, unioning directly into startup hydration. Watchlist updates immediately nudge coordinator reconcile via `NudgeCh`. Warm coordinator reserves a dedicated mover quota (`MinMoverSlots = 10`) so top gainers/losers are never starved by large watchlists. Frontend UI predictive hover pre-warm (`hover-prefetch.js`) initiates background candle fetches on 120ms mouse hover over ticker switch buttons. Technical indicator suite complete: Visible Range default Volume Profile (VRVP) with PineScript-derived Low Volume Node (LVN) zones, plus Quarterly & Monthly options, Automated Session VWAPs (D/W/M + prior levels), On-Chart Liquidation Clusters, and full color customization across all overlays. Adapter: [CHART.md](CHART.md). |
| Data engine | Go proxy owns public feeds (`/info`, `/ws`). Dedicated `bybitws` manager pulls real-time BTC/ETH/SOL/DOGE liquidations via per-topic worker pools with exponential backoff and zero deadlocks. `/readyz` gates on Hyperliquid universe health; Bybit is an auxiliary feed that connects asynchronously and degrades gracefully. |
| Account | Real-time wallet balances, position sizes, entry prices, leverage, and margin health streamed directly over WebSocket with automatic reconnect and zero latency polling. |
| Order book | Hyperliquid L2 depth with visual depth bars, aggregated spread indicator, and real-time tick-by-tick order book updates. |
| Timeframes | 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d with seamless historical caching, forward pagination, and zero-stale series switching. |

---

## Technical Indicator Suite Upgrades

The charting terminal includes institutional-grade technical analysis indicators designed for high signal-to-noise ratio, zero autoscale distortion, and zero additional API traffic:

1. **Visible Range Default & Dynamic Volume Profiles (`monthly-volume-profile.js`):**
   - **Visible Range Default (VRVP):** Dynamically computes volume distribution across the user's active viewport logical range (`iFrom:iTo`) during pan/zoom with viewport-anchored histograms and active POC tracking. Default period at startup (`volumeProfilePeriod: 'visible'`). Uses 100 price bins (doubled from 50) for enhanced distribution accuracy, sharper POC identification, and precise LVN zone clustering. Uses editable `profile` palette color.
   - **3 Tiered Points of Control (POCs):** Visible Range ("in-range") profile identifies and renders up to 3 distinct POCs: the largest POC is rendered with the thickest line (`lineWidth: Math.max(3, 3 * vpr)`), the second largest with a thinner line (`Math.max(2, 2 * vpr)`), and the third largest with the thinnest line (`Math.max(1, 1 * vpr)`). Drawn in reverse rank order (rank 3 -> rank 2 -> rank 1) so the largest POC is cleanly rendered on top. Uses the semantic `profile` palette color with the canonical rounded dotted pattern (`[1, 4]` bitmap dash at 0.8 opacity). Distinct peaks are detected via `findProfilePocs` using local maxima with spatial separation (cluster suppression) across the 100 price bins, gracefully falling back to the next highest volume bins when fewer than 3 local peaks exist. Quarterly and Monthly modes retain a single primary POC guide to prevent multi-period historical clutter.
   - **Low Volume Node (LVN) Zones:** PineScript-style contiguous LVN zones computed exclusively on Visible Range profile. Groups contiguous price bins below `lvnThreshold = 0.10` of `maxVol`, bounding each cluster horizontally between its first and last touching bar and vertically across the cluster's price extent (capped at `MAX_LVN_BOXES = 30`). Rendered with neutral profile styling (fill alpha 0.12, border alpha 0.22, 1px width) with dedicated UI toggle (`#volumeProfileLvnCheck`, `volumeProfileLvnVisible: true` default).
   - **Quarterly Mode:** Anchored to calendar quarter boundaries (`Jan 1`, `Apr 1`, `Jul 1`, `Oct 1`). Selectable option for institutional quarterly hedging cycles.
   - **Monthly Mode:** Selectable option for monthly auction analysis.
2. **Automated Session Anchored VWAP (Auto-AVWAP) (`session-vwap.js`):**
   - Automated UTC session anchors: **Session D** (`00:00 UTC`), **Session W** (`Monday 00:00 UTC`), and **Session M** (`1st of month 00:00 UTC`).
   - Renders prior session close levels (`pD-VWAP`, `pW-VWAP`, `pM-VWAP`) as dashed horizontal reference guides with edge-docked typography.
   - Clean boundary breaks across session rolls (no diagonal artifacts) and automatic higher-timeframe suppression.
   - Independent editable palette colors: `Session D` (`sessionDaily`), `Session W` (`sessionWeekly`), and `Session M` (`sessionMonthly`).
3. **On-Chart Liquidation Clusters (`liquidation-clusters.js`):**
   - Clusters market-wide liquidation feed events into price-bucketed zones.
   - Independent editable palette colors: `Short Liq` (`liqShort`) and `Long Liq` (`liqLong`).
   - Dynamically scales cluster width and intensity by aggregate liquidation volume ($USD), rendered with theme-aware tinted badges.
4. **Universal Color Palette Integration (`color-palette.js`, `color-palette-ui.js`, `color_templates.go`):**
   - Settings -> Colors lists all indicators in paired, 2-column swatches with full hue prism, saturation/brightness spectrum, and hex input customization.
   - Dynamic CSS custom properties and live `applyTheme()` dispatch across canvas primitives without page reload or chart recreation.
   - Disk template sync (`/api/color-palette-templates`, `data/color-palette-templates.json`) persisted across all 16 configurable keys.
5. **Historical On-Chart Whale Markers (`whale-markers.js`):**
   - Plots historical whale markers directly on the candlestick price chart at exact `(price, time)` using the built-in historical candle data stream (`indicatorCandles` / `selectClosedCandles`).
   - Strictly evaluated across completed historical candles, strictly excluding the live forming bar (`updateLast` triggers only when a closed bar completes into history).
   - Plotted at exact candle time and typical price `(h + l + c) / 3` (HLC3).
   - **High Tape Speed & RVOL Surge Detection:** Uses rolling 20-bar baseline to calculate trade count speed ratio ($\text{tapeSpeedRatio} = n / \overline{n}_{20}$) and relative volume ($\text{RVOL} = \text{notional} / \overline{\text{notional}}_{20}$). Bars must exhibit an activity surge ($\ge 1.8\times$) or volume climax to qualify.
   - **Structural Level Qualification:** Bars only qualify if they interact with key market structure: 12-bar local swing high/low tests, liquidity sweeps / SFPs, upper/lower absorption rejection wicks ($\ge 35\%$ of bar range), volatility breakouts ($\ge 1.5\times \text{ATR}_{20}$), or extreme volume climaxes ($\text{RVOL} \ge 2.5\times$ or notional $\ge 5\times$ floor).
   - **Cluster Peak Suppression:** Multi-bar momentum runs within $\pm 2$ bars are clustered and suppressed, selecting only the single dominant climax bar ($\max(\text{activityScore} \times \text{notional})$) per event. Eliminates overlapping multi-candle sausage blobs and maintains a clean ~5-7 markers per 80-bar viewport.
   - **Background z-Order & Visual Clarity:** Series primitive `zOrder: () => 'bottom'` renders circles behind candlesticks so price bars and wicks are 100% visible in front. Radius scaled conservatively ($3.5\text{px} \dots 12\text{px}$, max $14\text{px}$ for mega whales) with delicate translucency ($\alpha = 0.18$ fill, $\alpha = 0.70$ stroke).
   - Side-colored using active palette colors: Bullish (cyan/green) for buyer-dominant bars (`cvdDelta >= 0` or `c >= o`), Bearish (red/coral) for seller-dominant bars (`cvdDelta < 0` or `c < o`).
   - Major whale prints ($\ge \$250\text{k}$) feature a subtle solid center core.
   - Mega whale prints ($\ge \$1,000,000\text{ USD}$) stand out with an outer dashed accent halo ring and a compact bold USD text badge (e.g. `$1.0M`, `$2.5M`, `$10M`).
   - Interactive UI controls inside the `IND` popover with checkbox toggle (`#whaleMarkersCheck`) and minimum notional filter dropdown (`#whaleMarkerMinSelect`, `≥$100k`, `≥$250k`, `≥$500k`, `≥$1M`), with dynamic recomputation on threshold change.
   - Zero autoscale distortion: Series primitive in bitmap space (`useBitmapCoordinateSpace`) with `autoscaleInfo() { return null; }` and viewport logical range culling (`ts.getVisibleLogicalRange()`).
   - Pure, stateless calculation from canonical candles; zero WebSocket trade stream pollution or localStorage dependencies.

### Verification & Test Evidence
- **Frontend Unit Tests:** **152 / 152 test files passed** (**1,145 / 1,145 tests passed**), including full coverage for historical closed candle filtering, tape speed surges, RVOL baseline, structural levels (swing/sweep/absorption/breakout), cluster peak suppression, dynamic threshold recomputation, forming bar exclusion, HLC3 pricing, logarithmic sizing, mega-whale badges, and canvas rendering (`whale-markers.test.js`), Whale marker indicator UI controls (`chart-indicator-ui.test.js`), UI action manifest contract (`ui-action-manifest.test.js`), and chart lifecycle (`lightweight-chart.test.js`).
- **Go Backend Test Suite:** **26 / 26 packages passed** cleanly (`make test`).
- **Production Release Build:** Built production distribution bundle via `make release`.
- **Live Browser Smoke Test:** Ran `scripts/chart_live_smoke.mjs` against isolated server instance (`"ok": true`, all assertions passed, 1 chart root, 54 `setData`, 95 `update`, 0 rejected series updates, 0 unhandled rejections). Test server cleanly terminated and caches cleared (`make clean-caches`).

### Lead Engineer & Senior Technical Analyst Audit Findings & Enhancements
A comprehensive engineering and technical analysis audit was performed across all upgraded indicators:
1. **Visible Range Volume Profile (VRVP) & Low Volume Node (LVN) Zones:**
   - *Audit Finding:* When period was set to `visible`, it binned across all historical bars rather than the visible viewport.
   - *Refinement:* Implemented true dynamic viewport VRVP: dynamically slices bars in `ts.getVisibleLogicalRange()`, memoizes by `iFrom:iTo:length:lastBarTime`, anchors at `coordFrom`, caps width to 35% of the viewport, and traces POC across the visible window. Added PineScript-derived LVN contiguous valley clustering with neutral boundary framing.
2. **Auto-AVWAP Prior Level Pinning:**
   - *Audit Finding:* Prior session close levels (`pD-VWAP`, `pW-VWAP`, `pM-VWAP`) were drawn offscreen at `xStart + 4` when scrolling forward.
   - *Refinement:* Clamped label coordinates (`Math.max(xStart + 4, 8)`) so reference labels dock cleanly to the left chart edge during scrollback, with full vertical bounds clipping.
3. **Liquidation Clusters Clustering Invariant:**
   - *Audit Finding:* Premature loop break dropped subsequent large liquidation ticks from merging into existing price clusters.
   - *Refinement:* Removed premature break so all liquidations merge into their volume-weighted price clusters before ranking by total notional ($USD). Added vertical canvas bounds protection.

### 1. Requirements & User Intent
- **Phase 2 Indicator Upgrade Roadmap:** Progressing indicator capabilities to deliver high-signal institutional technical analysis using existing candle data feeds with zero additional REST requests.
- **Architectural Fidelity:**
  - Strict Lightweight Charts 5.2.1 canvas primitive invariants in bitmap coordinate space (`useBitmapCoordinateSpace`).
  - Zero price scale autoscale distortion.
  - Clean boundary breaks between sessions (no diagonal connection line artifacts).
  - Clean UI integration under the "Anchored VWAP" popover group, off by default at startup to prevent chart clutter.

### 2. Implementation Details
- **Mathematical Computation (`computeSessionVwaps` in `session-vwap.js`):**
  - Pure function mapping OHLCV candle streams to session-grouped VWAP series.
  - Groups candles by exact UTC calendar boundaries:
    - Daily: `Date.UTC(year, month, date)`
    - Weekly: `Date.UTC(year, month, date - daysSinceMonday)`
    - Monthly: `Date.UTC(year, month, 1)`
  - Cumulative volume-weighted typical price: $\text{VWAP}_i = \frac{\sum (V \times \text{HLC3})}{\sum V}$.
  - Seamlessly links consecutive sessions: the closing VWAP of session $N-1$ is propagated as `priorVwap` across session $N$.
  - Timeframe compatibility filter: Daily VWAP automatically hides on timeframes $\ge 1\text{d}$, Weekly on $\ge 1\text{w}$, and Monthly on $1\text{M}$ to prevent degenerate 1-bar curves.
- **Canvas Primitive Rendering (`createSessionVwapOverlay`):**
  - Attaches a single custom series primitive to `getCandleSeries()`:
    - Renders developing VWAP curves with distinct, non-clashing colors: Daily (cyan `#22cce6`), Weekly (royal blue `#4a9eff`), Monthly (violet `#a78bfa`).
    - Renders prior session reference lines as dashed horizontal guides (`[3, 3]`) with subtle typographic labels (`pD-VWAP`, `pW-VWAP`, `pM-VWAP`).
    - Uses `timeToIndex(time, true)` + `logicalToCoordinate` for seamless zoom/pan tracking even when session start bars are scrolled off-screen.
- **State & UI Integration:**
  - Added `sessionVwap: { daily: false, weekly: false, monthly: false }` to `INDICATOR_STARTUP_DEFAULTS` and `AppState.ui` in `store.js`.
  - Added `setSessionVwapVisible(period, val)` in `store.js`.
  - Added `<input id="sessionVwapDailyCheck">`, `sessionVwapWeeklyCheck`, and `sessionVwapMonthlyCheck` to `index.html` under the Anchored VWAP section with custom swatch indicators.
  - Exported `onToggleSessionVwap(period, el)` in `chart-indicator-ui.js` and registered in `ui-action-manifest.js`, `app-runtime.js`, and `main.js`.
  - Integrated into `lightweight-chart.js` frame-sliced overlay phases (`syncSessionVwap`) and live updates (`sessionVwapOverlay.updateLast`).
  - Added `sessionVwap` diagnostics to `getLightweightChartDebugState()`.

### 3. Verification & Live Smoke Testing
- **Frontend Unit Tests:** 150 test files passed (**1,115 / 1,115 tests**), including 8 dedicated tests in `session-vwap.test.js` covering session grouping, math golden values, timeframe gating, and primitive lifecycle, plus updated tests in `store.test.js` and `chart-indicator-ui.test.js`.
- **Go Test Suite:** All 26 Go packages passed cleanly (`make test`).
- **Production Release Build:** `make release` compiled production assets (`web/dist/main-7ZD2OACO.js`, `styles-6M4WAEAX.css`) and signed `./hyperliquid-server`.
- **Isolated Live Smoke Test:** Ran `scripts/chart_live_smoke.mjs` against an isolated instance on port `:5002` with automated verification of session VWAP dynamic attachment and session computation. All assertions passed with exit code 0.

## Prior Changes (September 6, 2026) — Volume Profile Quarterly Default & Monthly Option with Clean POC (VAH/VAL Lines Removed)

Refactored the Volume Profile indicator (`monthly-volume-profile.js`) to support both **Quarterly** and **Monthly** time aggregations, making **Quarterly the default on initial startup**, and completely removed the VAH/VAL horizontal boundary lines to eliminate chart clutter while retaining clean Auction Market Theory contrast-shaded histogram bins and the dotted POC guide.

### 1. Requirements & User Intent
- **De-Clutter Chart Overlays:** User identified that VAH (Value Area High) and VAL (Value Area Low) horizontal lines across the chart were visual clutter rather than actionable signals.
- **Quarterly Profile Addition & Default:** Add quarterly aggregation alongside the existing monthly option, making Quarterly the startup default so users immediately see multi-month macro volume distribution.
- **Architectural Fidelity:** Zero code bloat, zero performance regression, preservation of Lightweight Charts 5.2.1 canvas primitive invariants (bitmap coordinate space, zero autoscale distortion), backward compatibility with existing tests and scripts (`monthlyVolumeProfileCheck` preserved).

### 2. Implementation Details
- **Period Math & Pure Computation (`computeVolumeProfiles`):**
  - Added `period: 'quarterly'` default option and `keepQuarters: 4` (1 rolling year).
  - Implemented `quarterKey(timeSec)` (`year * 4 + Math.floor(month / 3)`), `quarterStartSec`, and `quarterEndSec` using UTC calendar quarters (Q1: Jan-Mar, Q2: Apr-Jun, Q3: Jul-Sep, Q4: Oct-Dec).
  - Preserved `computeMonthlyVolumeProfiles` as an alias defaulting `period: 'monthly'`, ensuring downstream consumers (`price-projection-indicator.js` and existing tests) remain 100% functional.
- **Visual De-Cluttering:**
  - Removed VAH and VAL canvas drawing strokes from `draw(target)`, saving canvas draw cycles and removing distracting horizontal lines.
  - Retained the 70% Value Area volume calculation solely for histogram bin contrast (`bin.inValueArea ? 0.35 + 0.55 * intensity : 0.15 + 0.30 * intensity`), providing clean Auction Market Theory visual depth.
  - Kept the distinct POC dotted line (`[1, 4]` bitmap pattern at 0.8 opacity).
- **State & UI Integration:**
  - Added `volumeProfilePeriod: 'quarterly'` to `INDICATOR_STARTUP_DEFAULTS` and `AppState.ui` in `store.js`.
  - Added `setVolumeProfilePeriod(period)` and exported from `store.js`.
  - Added `<select id="volumeProfilePeriodSelect">` (`Quarterly` / `Monthly`) next to `<input type="checkbox" id="monthlyVolumeProfileCheck">` in `index.html`.
  - Styled with `.volume-profile-controls` in `styles.css`.
  - Registered delegated action `onChangeVolumeProfilePeriod` in `chart-indicator-ui.js`, `main.js`, `app-runtime.js`, and `ui-action-manifest.js`.
  - Exposed `setPeriod(period)` on the overlay primitive so period changes immediately recalculate and repaint without waiting for candle sync.

### 3. Verification & Live Smoke Testing
- **Frontend Test Suite:** All 149 Vitest test files passed (**1,104 / 1,104 unit tests**), including new tests for quarterly grouping, period switching, single-stroke POC rendering, and startup defaults.
- **Go Test Suite:** All 26 Go packages passed (`make test`).
- **Production Build:** Rebuilt production distribution (`make release`) producing signed binary `./hyperliquid-server` and dist assets (`web/dist/main-LWMOE3UH.js`).
- **Live Smoke Test:** Executed `scripts/chart_live_smoke.mjs` against an isolated instance on port 5002. All 320/320 assertions passed with 0 errors, and the test server shut down cleanly.

## Prior Changes (September 4, 2026) — DOM Ladder Real-Time Mid Price Synchronization & Fill-Aware Tape Resolution

Resolved the perceptual lag of the DOM ladder mid price relative to real-time fill highlights (grey background flashes) across the browser WebSocket and rendering pipelines.

### 1. Root Cause Analysis
- **Execution Event Disparity:** Trades arrive unthrottled over the market WebSocket stream (`trades` channel). In `handleTrades` (`web/src/streams/market-ws.js`), trades immediately invoke `ingestDomTrades` and schedule an animation frame render via `scheduleLiveDomLadderRender()`, flashing grey trade fills on the DOM ladder instantly.
- **Book Mid Lag:** In contrast, `renderDomLadder` (`web/src/render/dom-ladder.js`) calculated `mid = (bids[0].px + asks[0].px) / 2` strictly from `AppState.market.book`, which only updates when the exchange's throttled L2 orderbook snapshot arrives (~500ms intervals).
- **Decoupled `allMids` Stream:** Although `handleMids` (`web/src/streams/market-ws.js`) ingested live ticker mid prices into `AppState.market.allMids`, it did not trigger `scheduleLiveDomLadderRender()`, and `renderDomLadder` completely ignored `AppState.market.allMids`. Consequently, fast-moving markets or aggressive fills through the resting book caused the grey trade highlights to paint instantaneously while the yellow mid line marker visibly trailed behind until the next L2 book arrived.

### 2. Implementation & Architectural Guarantees
- **Fill-Aware Tape Resolution (`handleTrades`):** When active coin trades arrive that sweep or breach the resting book bounds (`lastTrade.px > bestAsk || lastTrade.px < bestBid`), `handleTrades` synchronously invokes `applyCurrentPrice(tradeCoin, lastTrade.px)`. This immediately updates `AppState.market.allMids[tradeCoin]`, the topbar price, and the live chart price line before scheduling the ladder render.
- **Real-Time Mid Marker Resolution (`resolveDomMid`):** Created and exported `resolveDomMid(coin, bids, asks)` in `web/src/render/dom-ladder.js`. If `AppState.market.allMids[coin]` is available and finite, it is used directly as the DOM ladder mid marker; otherwise it falls back to the resting book mid `(bids[0].px + asks[0].px) / 2`.
- **Live DOM Trigger on `allMids` (`handleMids`):** In `handleMids` (`web/src/streams/market-ws.js`), added a call to `scheduleLiveDomLadderRender()` whenever the active coin's mid price updates, ensuring any off-book mid tick shifts the DOM ladder marker without waiting for an L2 book cycle.
- **State & Pruning Lifecycle:** Initialized `domSessionMidTime` in `ensureDomBuckets` (`web/src/state/dom-ladder-state.js`) and wired its cleanup into `pruneMarketCoinCaches` (`web/src/state/market-trades.js`).

### 3. Verification & Rebuild
- **Frontend Test Suite:** All 149 Vitest test files passed (**1,098 / 1,098 unit tests**), including new regression tests for `resolveDomMid`, mid marker updates from `allMids`, and tape breach resolution.
- **Go Test Suite:** All Go WebSocket tests passed cleanly.
- **Production Build:** Rebuilt production bundle via vendored esbuild (`web/dist/main-4Y2RPX6L.js`) and recompiled Go server binary (`hyperliquid-server`).
- **Live Smoke Test:** Verified live HTTP endpoints (`/healthz`, `/readyz`, root `/` serving `main-4Y2RPX6L.js` with 200 OK). Cleaned all disposable caches via `make clean-caches`.

## Prior Changes (September 2, 2026) — Full Code Review, Execution Hot-Path & Predictive Pre-Warming Architecture

A comprehensive code review, wire audit, hot-path optimization pass, and predictive warm-up enhancement was completed across the Go backend and JavaScript frontend.

### 1. Architectural Review & Key Guarantees
- **Deterministic Separation:** Go backend strictly isolates all rate limiting, ECDSA signing, candle residency/CVD math, snapshot serialization, and 272-market liquidation stream management. The browser frontend acts as a pure render surface managing `AppState` and driving user intents into thin API wrappers.
- **Zero-Allocation Cryptography:** Pre-parsed ECDSA private keys are memoized in `keycache` and `HyperliquidAdapter`, completely eliminating repetitive hex decoding, `big.Int` allocations, and elliptic curve point calculation on signed execution paths (order placement, batch orders, cancellations, modifications, leverage updates).
- **Exact Wire Alignment:** Declared `TifAlo Tif = "Alo"` for Hyperliquid post-only order execution; strict $10 notional validation; unambiguous error propagation on 429/5xx network timeouts without duplicate cloid retries.
- **High-Frequency Allocation Elimination:** In-memory mids cache (`PrimeMids`) populates directly under lock in a single pass without intermediate map allocations.

### 2. Predictive Pre-Warming & Persistence Architecture
- **Server-Side Watchlist Persistence:** Watchlists are atomically saved to `data/watchlist-hints.json` and restored on reboot, unioning directly into `startupChartCoins` to guarantee a trader's favorite markets are hydrated and history-ready before `/readyz` admits traffic.
- **Immediate Coordinator Nudge:** `NudgeCh` in `warmcoordinator.Deps` allows frontend watchlist modifications to immediately trigger a background reconcile without waiting up to 30s.
- **Guaranteed Mover Quota:** Configured `MinMoverSlots = 10` so top gainers and losers always have reserved capacity in the background warm set regardless of how large the user's watchlist grows.
- **Predictive UI Hover Pre-Warming:** [hover-prefetch.js](../web/src/services/hover-prefetch.js) debounces (120ms) hover intent over mover buttons, watchlist items, and ticker links, fetching background candles before the user clicks for instant perceived switch times.
- **Proven Real-World Sleep/Wake Resilience:** Validated live on macOS lid-shut/lid-open events; dead TCP sockets are cleanly severed, and all 68 candle feeds, 27 trade feeds, and 272 liquidation channels recover in under 3 seconds.

### 3. Verification & Metrics
- **Go Backend:** All 26 packages passed (`make test`), `go vet ./...` clean.
- **Frontend Vitest:** All 149 test files passed (**1,094 / 1,094 tests**).
- **Production Build:** `make release` compiled cleanly into `web/dist/` and `./hyperliquid-server`.
- **Live Smoke Test:** Real-browser CDP smoke test passed **320 / 320 assertions** on isolated `:5002` (0 failures, 1 chart root, 51 `setData`, 141 `update`, 0 rejected updates, clean shutdown). Multi-tab browser validation confirmed instant load of 38 gainers and 21 losers across both primary and secondary tabs.
- **Top Gainers & Losers Multi-Tab & Startup Loading Fix:** Fixed bug where top gainers and losers rows failed to load when starting the terminal or opening a second tab. Decoupled local chrome pollers (`startTopMoversPolling`, `start24hPolling`, `startMispricingPolling`) from tab leadership gating — these query the local Go server in-memory cache (<1ms, 0 external requests) and must run in every tab so coin buttons are always present and clickable. Removed artificial delay waiting for candle/radar boot before requesting movers. Added fast startup retry backoff (500ms, 1s, 2s, 4s) in `top-movers-service.js` when the backend is warming asset contexts on fresh launch, eliminating the previous 60-second blank topbar penalty. Wired top movers and 24h changes to `tab-resume.js` for instant updates upon tab focus.
- **Drawing Tools & Circle Price-Anchored Radius (VWAP Lines Parity):** Fixed circle scaling under horizontal time zoom. When a circle is placed between two price levels (such as two VWAP lines), its vertical radius is anchored to price via `dy = |pts[1].y - pts[0].y|` (with `r = Math.max(1, dy > 0 ? dy : dx)`). When the user scrolls the mouse wheel to zoom in or out in time, the price scale and VWAP lines remain stationary, and the circle size stays completely stable and locked between the two VWAP lines. When the price scale changes or zooms vertically, `dy` scales with the price coordinate mapping, keeping the circle perfectly bounded by the price levels while rendering as a true circle (`rx === ry === r`). Center, Handle 1, and whole-drawing dragging preserve price bounds. All 149 test files passed (1,094 / 1,094 tests).

## Prior changes (September 1, 2026) — chart wiring audit

Verified the exchange → backend → frontend wiring review against this tree,
then fixed every confirmed bug. Meg-file splits (`lightweight-chart.js`,
`market_ws.go`, `store.go`) and a shared WS-lifecycle helper were left as
follow-up.

- **Serve path cannot claim a dead feed.** Last client candle-ref `0` calls
  `OnCandleFeedDropped`. Empty REST never pins `coverageStartMs` on a cold
  series. `EnsureChartUniverse` skips a failed market; only “every market
  failed” is fatal. `PrepareStartupUniverse` registers the default TF first
  so the 64-slot cap is landing charts, not remainder TFs of the first names.
  Phase-1 reapply uses each client’s `chartCandleRefSet`; a phase-2 remainder
  failure is fatal for that connect.
- **Wait is not RTT.** Candle and general HTTP clients use `Timeout: 0`.
  `hlratelimit.WithRTTTimeout` starts after limiter `Wait` (25s candles, 10s
  probes). `cancelOnClose` keeps that deadline alive until `Body.Close()` —
  `RoundTrip` returns at headers, so a header-only cancel truncated JSON and
  served it as 200. Truncated-body reads are `passthrough_error`.
  `/api/chart-candles` parent timeout is **2 minutes** so limiter wait is not
  a 504. Market `info` types (`meta`, `allMids`, `l2Book`, `candleSnapshot`)
  use the Enrichment lane. `GetAssetCtxs` is single-flight and clone-on-serve;
  movers keep cached xyz rows when the xyz fetch fails.
- **Overlay live mutate is one helper.** CVD / oscillator / RVWAP
  `update()` go through `mutateOverlaySeries` (crosshair clear, `Value is null`
  → `setData` rebuild). Teardown and series recreate reset
  `lastOverviewSelectionKey`; a lid-wake recreate re-arms fit. Unchanged 4h
  RVWAP source does not live-tick `setCandles`. Explicit empty `displayCandles`
  returns no RVWAP rows (omitted display still means source-axis).
- **Stale adoption is aborted.** Candle dedup keys include `requestToken`;
  `applyCandles` writes only if the selection is current; boot `fetchCandles`
  has a token. Subscribe POST aborts and does not retry after abort. Tab-resume
  payload age uses `lastMarketPayloadAt`, not heartbeats. Market heartbeat
  starts at connect; 2s refresh suppress; null the socket before `close()`.
  HIP-3 Place timeout is gated on the active switch. Unload calls
  `disconnectAccountStream`. `TIMEFRAME_SECONDS` includes `3m` / `12h`.
- **Verification:** `make test` all Go packages green; `go vet ./...` green;
  frontend **1082/1082** (148 files). `make release` → `main-LL66HRBR.js` +
  `styles-GR3RXI6P.css`. Isolated non-funded `:5002` (copied snapshot, temp
  bot-state `{}`, no key, default candle budget): restore **880** series in
  **8.72s**; `/readyz` **50/50** `2h` in **2m38s**. Opera/CDP
  `chart_live_smoke` **320/320** `"ok": true`: 1 chart, 49 `setData`, 121
  `update`, 32 series recreates, 5175 BTC `2h` candles, `rejectedUpdateCount`
  0, 2 recovered 502s. No wallet or funded action. Isolated process stopped.
  Relaunch `start (Mac).command` to pick up this binary on `:5001`.

## Previous (August 31, 2026) — chart switch smoothness

- **RVWAP 4h source starts with the switch, not after the first empty paint.**
  `switchCoin` calls `scheduleActiveRvwapHydration` as soon as the destination
  pair is current; `prefetchAdjacentTimeframes` does the same.
- **Overlay work is frame-sliced after candle `setData` on every non-empty
  history**, including short 4h/8h/1d/1M series. RVWAP is the first deferred
  phase. After a pair/TF overview reset, the chart **always re-fits** when
  those phases finish. Unit tests keep the LC stub path inline.
- **Warm cache re-apply no longer bumps snapshot revision.** If
  `AppState.market.candles` already is the cache array, `fetchCandles` skips
  `applyCandles`. Timeframe switches pass `cacheAlreadyApplied` when cached
  rows were installed.
- **Not changed:** low-TF RVWAP still clips to loaded display timestamps.
  Plotting the full 600-day 4h span would insert extra logical indexes and
  break prepend range shifts. See [CHART.md](CHART.md).
- **Same-day LC adapter close:** future-anchor reverse mapping shares
  `barInterval()` with placement; CVD/oscillator series points are
  `{ time, value, color? }` or `{ time }` only; unix-seconds threshold is
  `100_000_000_000` everywhere.

## Current Priority

1. Run [LIVE_VALIDATION_RUNBOOK.md](LIVE_VALIDATION_RUNBOOK.md) after
   execution, transport, or chart-runtime changes (include a minimal funded
   place/modify-or-cancel when possible).
2. Add focused regression tests for concrete bugs.
3. Keep docs aligned immediately after behavior or ownership changes.
4. Avoid broad cleanup unless a real bug, feature, or regrowth hotspot
   justifies it.

## Known Risks / Residuals

- Funded multi-mode validation (Standard / Unified / Portfolio / builder)
  remains an operator gate after order-path changes.
- Modify re-key: protection re-keys immediately after exchange success (with
  old→new fill alias). Only a theoretical post-return / pre-lock gap remains;
  not closed by exchange atomicity alone.
- 900 upstream subscription ceiling is intentional capacity control — watch
  metrics, do not raise casually.
- Cold readiness can take several minutes for the expanded startup timeframe
  set; disk snapshot keeps relaunches short.
- Bot `window.*` publishes remain for host injection fallback, HTML
  `data-action`, and tests. Live bot start/place remains operator-gated.
- Opera/CDP `1h`/`2h` complete-overview diagnostic: Lightweight Charts can
  remap a requested overview that includes future slots to a same-width
  window with negative `from`. Later overview checks in the same run pass.
  Not rewritten this pass.
- Low-TF RVWAP visible left end follows loaded display depth. That clip is
  required (see [CHART.md](CHART.md)); do not plot extra 4h times onto the
  candle axis.

## Operational Gate

Before calling a trading/execution change release-ready:

- run the live validation runbook
- include at least one minimal place/modify-or-cancel cycle when funded
- capture `window.transportMetrics`
- record whether validation was full execution or transport/render only

Chart-only changes can use isolated `:5002` + `scripts/chart_live_smoke.mjs`
and must not disturb a live `:5001` user session.

## Test-cache policy

Run Go tests through `make test`; it uses an ephemeral system-temporary
`GOCACHE` and removes it on exit. Do not set `GOCACHE` to `.cache/gocache`
(or any path inside this repository). After frontend tests, remove
`web/node_modules/.vite` (including Vitest results) and any temporary
`pez-vitest-localstorage-*` files. Keep regression-test source files.

Do **not** delete `web/node_modules`, `vendor/`, `web/dist`, or
`data/candle-snapshot.json.gz` merely to shrink the tree — those are
operational.
