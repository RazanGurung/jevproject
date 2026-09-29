# Live Validation Runbook

Use this after starting the app against the environment you want to test.
Dated pass results live in
[archive/LIVE_VALIDATION_HISTORY.md](archive/LIVE_VALIDATION_HISTORY.md).
Chart adapter invariants: [CHART.md](CHART.md).

Chart-only checks may run on an isolated `:5002` with a copied snapshot,
empty bot-state, and no key. Do **not** point `scripts/chart_live_smoke.mjs`
at a funded `:5001` user session.

## Goal

Validate:

1. chart/render behavior through coin and timeframe churn
2. account/order state repair after execution events
3. request volume and reconnect behavior
4. at least one real order lifecycle when funded
5. top-right Portfolio Value and Available update from the account WebSocket after execution (REST is fallback, not the primary visible update)

## Console Snapshot

Inspect counters:

```js
window.transportMetrics
```

Copy final snapshot:

```js
JSON.stringify(window.transportMetrics, null, 2)
```

## Session Plan

Run as one continuous 10-15 minute browser session.

### 1. Warm Start

1. Connect wallet/session.
2. Wait for initial chart, account state, and stream connection.
3. Exercise the shared popover behavior with Market, Overlay, Draw, and IND: only one surface is open; clicking its trigger again, clicking outside, pressing `Escape`, or resizing closes it; opening another replaces it; chevrons and highlights match the visible surface. Confirm `Escape` returns focus to the trigger. Open **Overlay** (directly left of Draw), verify default mode is Off with Dimmed base candles. Switch to Heikin Ashi and confirm smoothed bars with optional wicks render on the canvas. Switch to Renko, test ATR, %, and Fixed $ brick modes, wicks, and next-brick projection lines; verify that historical Renko bricks remain strictly identical across timeframe and coin switching without repainting from the open candle. Switch to Both mode and verify smoothed Heikin Ashi bars render underneath sharp Renko bricks. Test the contrast slider for dimmed base candles, the opacity sliders for Heikin Ashi and Renko, and the 'Dim all' convenience button. Toggle base candles between Dimmed, Hidden, and Normal. Return mode to Off and confirm clean primitive detachment. Open IND, confirm its Anchored VWAP / Rolling VWAP / Other overlays / Lower panes / Alerts groups are clear. **Anchors** must start OFF with no shared Bands/Width row, and **Volume Profile** (Visible Range default with 3 tiered POC lines) must start ON; Rolling VWAP center lines **30D, 90D, and 365D** start ON while **7D** and deviation bands start OFF. Rolling VWAPs feature clean tiered line widths (7D: 1, 30D: 2, 90D: 3, 365D: 4) analogous to the 3 volume profile POC tiers. Confirm no weekly-anchor checkbox exists. Add an anchor and confirm its start marker has a compact dot inside a clearly larger same-color ring. Selecting that marker (or the just-placed one) shows **Bands** and **1σ/2σ/3σ/4σ** next to the origin; those start off at 2σ and do not require reopening IND. The matching IND row stays in sync; a second anchor keeps its own bands/σ independently. Enable the 7D and 30D bands, hide only the 7D bands while center lines remain visible, restore them, then toggle each RVWAP independently without IND closing. Confirm the retired `DOM ×N` control is absent from the topbar. Toggle **HIDE $** and confirm it reads **SHOW $** while account values are hidden, then restores **HIDE $** when values are shown.
   In the same IND panel, confirm the **Price projection** group starts OFF with no 5/10/20 horizon selector. Enable it and verify Research status, the **current-month occupancy map** from that month’s UTC open (no quantile fans or median path lines; elapsed month-to-date squares faint vs remaining-horizon), non-zero `UpFreq`/`wESS`/`cESS` diagnostics, and `BT50`/`BT80` empirical coverage; if history is too short the status is an honest unavailable reason. Disable it and confirm the occupancy primitive detaches. `UpFreq` is not a calibrated probability, `wESS`/`cESS` are not independent sample counts, and backtest coverage is not a future-coverage guarantee. A newly closed bar inside the live UTC month must keep the same month-open origin and full-month horizon while occupancy/weights may refresh. Quantile fans and median path lines must not appear. Same-bucket forming-candle updates must not recompute.
   Confirm the **2-week path projection** group starts OFF (envelope checkbox may default ON). Enable Path and verify Research status, path fan to Monday+14d UTC (not a short remaining-week stub late in the week), optional week H/L envelope, and status `~Nd left` with N typically ≥7 late week; disable and confirm series detach. Distinct from UTC-month Price Projection.
4. Open **Colors** and confirm it contains the overlay rows Bullish, Bearish, **AVWAP**, **RVWAP**, **PROFILE**, **MAP**, Drawing, Bull candle, and Bear candle (plus Background and Border). The retired generic **Indicator** row must be absent. Enable one manual anchor, one RVWAP preset with bands, Monthly volume profile, and Price projection; assign four visibly distinct colors and confirm only the matching overlay changes: AVWAP owns manual anchors, RVWAP owns rolling presets/swatches, PROFILE owns monthly boxes/POC, and **MAP** owns the current-month occupancy squares plus both projection paths. Changing colors does not recreate the chart. Reload and confirm the values restore before the overlays attach. `Reset` affects only the selected row, `Reset all` restores all defaults, and an invalid shorthand such as `#123` is rejected. For upgrade validation, seed a version-1 `pez:color-palette` payload with an `indicator` value in an isolated profile; the next load must rewrite it as version 2 with that value copied to `avwap`, `rvwap`, `profile`, and `projection`.
5. Confirm **Draw** is off by default (funding/OI bar only). Toggle **Draw** to open the single-row icon strip in that bar (Funding/OI on the right), with an **Off** control. Select a tool, draw, and confirm **keep-drawing**: the same tool stays armed until Off, Escape, or another tool. Draw one of each tool (trend/curve/arrow/horizontal/vertical/channel, box/circle/pencil, marker, fib/measure/text, long/short position), confirm each renders and tracks pan/zoom. For **Circle**, press at the intended center, drag to set radius, and release; confirm a click/no-drag creates nothing and the center/radius handles remain editable. For **Curve**, click start, end, then midpoint; confirm the curve passes through all three points and each handle can be moved independently. Text prompts for a label (and double-click re-edits); measure shows Δ/%/bars, allows unlimited coexisting boxes, and persists with other drawings; pencil draws on press-drag. Draw at least one tool into the whitespace to the right of the last candle and confirm it renders there, tracks pan/zoom, is selectable/draggable (including dragging an endpoint into the future), and survives a reload + timeframe switch; confirm clicks on chart axes/separators and in the empty area left of the oldest bar do nothing. Select one (✕ + handles appear) and delete it (✕ / right-click / Delete). Draw a pane-safe tool in both the **anchored-CVD pane** and **CVD-oscillator pane**; confirm each stays pane-local through placement/drag and persists under the `:cvd` / `:osc` key. Create a persistent toast, click topbar **CLEAR**, and confirm the toast plus drawings/storage in every active-coin pane are removed together. Confirm fib/measure/positions remain price-pane-only.
6. Confirm `window.transportMetrics.stream.connects >= 1`.

### 2. Coin And Timeframe Churn

Repeat 10-15 times:

1. Switch between at least two coins, including one xyz coin if relevant.
2. Switch timeframes between `1m`, `5m`, and one slower timeframe.
3. Let each chart load fully.
4. Wheel zoom in and out on the price pane, drag horizontally to pan time, drag vertically to pan price, then scroll into older history. `jumpChartToLive` must restore the live bar and price auto-scale; **Fit** must return a complete-history overview. `chartCreateCount` stays 1 and `rejectedUpdateCount` does not rise. The Opera/CDP harness (`scripts/chart_live_smoke.mjs`) performs this on BTC `2h` at baseline and again after rapid coin/TF churn.

### 2a. Close-based MISPRICE validation

Use only read-only endpoints and the market stream; do not connect a funded
wallet or invoke an account/order route for this check.

1. Confirm the page is serving `web/dist` and record the hashed `main-*.js`.
2. Poll `GET /api/stock-mispricing` until resolved rows appear. Every row must
   have exactly the close-based fields `coin,dex,exchange,sessionState,
   sessionCloseMs,asOfMs,markPx,closePx,deviationPct`; `oraclePx` and
   `premiumPct` must be absent.
3. For every row, verify `deviationPct ≈ (markPx-closePx)/closePx*100`, the
   underlying session is closed, and the independently fetched Hyperliquid 1m
   reference is the latest valid candle ending at or before `sessionCloseMs`.
   Reject any implementation that substitutes a candle opening/ending after
   the boundary.
4. Compare the panel with the current `allMids`: apply the absolute 1% floor,
   recompute/live-sort from the mid (mark fallback only when absent), and verify
   the tooltip reads session close → current HL price. Exercise a live threshold
   crossing if normal price movement provides one.
5. Check at least one product from every currently represented closed venue
   under the **xyz** HIP-3 registry (non-xyz builder dexs are not loaded), not
   only ZHIPU. When `xyz:ZHIPU` is eligible, its known regression example is
   `closePx=109.38` and HL near `119.5`, about `+9.3%`; this is a convenient
   fixture, not special-case logic.
6. Inspect `/metrics` and server logs during resolution. Background references
   may be partial while keys resolve, requests must remain responsive, upstream
   429s must not form a sustained burst, and healthy DEX rows must survive a
   sibling failure.

Do at least one pass of this **within the first ~1-2 minutes after a fresh server restart** (the candle-store warm-up window), flipping rapidly across several different, ideally off-list/low-OI, tickers — include at least one thin **xyz** HIP-3 pair (`xyz:*` only; other builder dexs are not loaded as markets). The chart you're currently viewing always bypasses the warm-up queue — it's served by a direct Hyperliquid passthrough regardless of whether the background store has warmed it yet (`/api/chart-candles` → `passthroughCandleSnapshot` in `cmd/server/main.go`; see *Server-side candle store* in `ARCHITECTURE.md`) — so it should paint within ~1–2s every time (cold thin pairs may take longer but must self-heal without a re-click). A single cold-load timeout must not leave a permanent blank chart or spam `Fetch candles error` for intentional switch cancels.

Watch for:

- no previous pair candles, volume, order lines, or price scale after switch
- no stuck loading state
- candles paint first on a switch; enabled RVWAP/AVWAP/profile/CVD then attach without leaving a short TF (4h/8h/1d/1M) zoomed incorrectly after Fit/overview
- manual anchored VWAP starts hidden; when enabled, stored anchors render their center line plus a larger origin ring around the start dot. Each stored anchor keeps its own bands/σ (new anchors default to bands hidden at 2σ). The retired weekly overlay has no checkbox, delegated action, `AppState.ui.anchoredVwapVisible` field, or `indicators.anchoredVwap` diagnostic, and the retired shared Bands/Width controls are absent
- Volume Profile (Visible Range default with 3 tiered POCs) starts visible, and 30D, 90D, and 365D rolling Kalman RVWAP center lines start visible (7D and bands start hidden, with tiered line widths 7D: 1, 30D: 2, 90D: 3, 365D: 4). Every preset/band remains independently toggleable with matching color swatches
- with one RVWAP preset enabled, rapidly switch A→B→A across coins and churn `2h`/`4h`/`8h` before either source load settles: only the selected coin may own `rvwapSource`, enabled center/band rows must repopulate without another toggle, returning to a completed coin should reuse its source, and a transient refresh failure must not erase an already-ready overlay
- on a low TF (1m/5m/15m/1h), the RVWAP **values** stay fixed while zooming; the visible left end may step backward as display history prepends. That is overlay clipping to loaded display timestamps, not a recompute. Do not treat it as a bug, and do not plot extra 4h times that are missing from the candle series
- AVWAP, RVWAP, monthly PROFILE, and MAP colors remain independent through timeframe/coin churn: AVWAP owns manual-anchor markers/lines/bands, RVWAP owns every rolling preset and its swatch/bands, PROFILE owns monthly boxes/POC, and MAP owns Price Projection occupancy squares (elapsed month-to-date faint, remaining-horizon at MAP color; no median path lines). The monthly POC guide must render as a fine rounded dotted line, not a long-dashed guide
- chart drawings persist per coin: a drawing made on one coin reappears after a reload and when switching back to that coin, and does not bleed into other coins
- CVD comparable between `2h` and `4h` (server computes from the same 5m/30m composite source, so **enriched** — non-nil `cvdDelta` — buckets are identical across all timeframes ≥5m: each complete higher-TF bucket's `cvdDelta` equals the sum of the covering lower-TF `cvdDelta`s, verifiable exactly). Where the server withholds `cvdDelta` (beyond the ~104d 30m retention edge, pre-seam buckets finer than 30m, buckets straddling the coverage start, cold/gapped sources), the client's per-timeframe directional fallback **diverges across timeframes by design** — that region must never carry an enriched-looking claim of cross-TF identity. The automated harness below quantifies exactly this split
- CVD diagnostics report `anchorTimeframe: "1W-MON00"`, `baselineVisible: true`, and a positive `resetCount`. At each `lastResetTime`, the neutral reset marker is plotted at exactly zero while the histogram/outline retain the anchor candle's delta-inclusive value. `1W-MON14` is input compatibility only and must never be reported by chart diagnostics.
- after a sleep/wake or recovered candle gap, wait for the replacement snapshot and switch across `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `8h`, and `1d`: candles and every enabled candle-derived indicator (anchored CVD, oscillator, manual anchored VWAP, rolling VWAP bands, monthly profile, and CVD reset markers) must redraw from the repaired data even when the snapshot has the same first/last timestamp and bar count as the stale view. A focus/visibility resume with a market-message pause above 5s forces this snapshot; above 45s it also recycles the market socket. Closing the lid with the tab already visible may emit no focus event: the first heartbeat tick more than 30s late must increment `window.transportMetrics.stream.marketWakeDetections`, force the same-bucket snapshot, recycle only the market socket, and reapply subscriptions. Chrome `resume`, `online`, and bfcache `pageshow.persisted` must recover the chart canvas (not only candle timestamps) and recycle a zombie `OPEN` socket. Rapid coin/TF churn must leave `rejectedUpdateCount` at 0 and `chartCreateCount` at 1; a `Value is null` overlay-line throw during `update()` must rebuild from canonical `setData` instead of desyncing the series. A hidden-tab timer gap must not increment that metric. On `1M` / `1w`, a reconnect while the tail is still the current UTC calendar month or Monday week must **not** increment `candleReconnectBackfills` or issue `/api/chart-candles`; only a previous-month / previous-week tail should recover.
- force a skipped live bucket (or resume after a >5s market-message pause) while the tail timestamp is still inside the current `4h` bucket: `candleIntegrity.repairAttempts` must advance immediately, `/api/chart-candles` must actually be requested, `lastVerifiedSnapshotAt` must change, and `repairSuccesses` must advance without a re-click. A successful authoritative sparse response is terminal; it must not create a retry loop or synthetic flat candle. A failed visible repair retries near 1s/2s/5s/10s, never concurrently, and disappears from `activeRepair` after a ticker/timeframe switch.
- start a scrollback fetch, then rapidly change ticker and timeframe before it returns: the late history response must not alter the selected chart. After settling, `canonicalInvalidCount`, `canonicalDuplicateCount`, and `canonicalOutOfOrderCount` are all zero; CVD `rowCount` equals `exchangeCandleCount` on supported timeframes, and enabled warm indicators have non-zero computed history.
- CVD is populated from closed candles on initial historical load. The native open bucket may move and same-bucket candle-WS revisions still carry a server-spliced cumulative `cvdDelta`, but anchored CVD, its reset markers, the oscillator, AVWAP, RVWAP/bands, and Monthly Profile must remain unchanged until that bucket closes. Completed buckets may change only when an authoritative snapshot proves and repairs stale/fallback content.
- on a cold/off-list coin: the first serve may have **no** `cvdDelta` at all (client renders per-bar directional CVD — a visibly coarser but honest fallback) and converges to fully-enriched store serves as the on-demand 5m/30m source warm completes. Leave the pair selected: the active chart must refetch on its own (first retry near 30s, then bounded backoff), not wait for a coin/timeframe switch. A thin pair whose final returned candle is already completed must also retry. Previously enriched completed levels must not downgrade to fallback during a transient bare snapshot; what must **never** appear is a CVD tail flatlining at exactly zero while the coin is trading
- CVD Oscillator pane (third lower pane) renders a line oscillating within [-1,1] with visible -1/0/+1 reference lines, red above zero / aqua below; its latest value depends on the previous completed bar, so it advances on bucket roll and detaches on `1w`/`1M`. Changing the **CVD Oscillator Lookback** dropdown (default 90D) visibly recomputes the line. The oscillator computes directly on chart bars (no separate lower-TF source)
- Price Projection starts disabled. Enable it on history deep enough for a month-open occupancy map (typically ≥90 calendar days of closed bars on sub-daily charts). Production draws the **current-month occupancy map only** (no quantile fans or median path lines): origin is the last close before that UTC month open; a newly closed bar inside the live month keeps that origin and full-month horizon while occupancy/weights may refresh. Same-bucket forming-candle updates must not recompute. Sparse higher timeframes and 1m must report unavailable rather than render a fallback. Evidence is `unvalidated`. `UpFreq`/`wESS`/`cESS`/`BT50`/`BT80` are historical diagnostics, not calibrated probabilities or future-coverage guarantees. Method: [PRICE_PROJECTION_METHOD.md](PRICE_PROJECTION_METHOD.md)
- the `1m` native candle accepts same-bucket exchange revisions in place; the anchored-CVD tail stays fixed, then appends the completed prior bucket exactly once after rollover
- manual pan does not snap back unless user returns to live edge
- DOM column: top **ALL/WHALE** are exact latest-500 rolling totals (never session-cumulative, never chart CVD). The header shows `WARM 0/500` before the first print and then exposes sample coverage in its tooltip. **Inside the ladder**, right-column volume-at-price and whale markers are **session-persistent per price** for the pair subscription: a level's total must only increase (or hold) as the tape moves away, and must not shrink when the top FLOW 500 window rotates. Pair prune / switch still clears that coin's session map. Switch among an active pair plus at least two watchlist/mover pairs and confirm FLOW and the ladder change immediately without showing the previous pair. On a genuinely cold pair, the guarded `/api/l2-snapshot` fallback may appear after 250ms. Grey execution flashes still fade near 1.2s (time TTL only); whale cores begin at $100k, major begins at $250k, and the five square stages top out at $5m and stay for the session. Chart CVD and both CVD panes must remain unchanged by these DOM interactions.
- DOM scale remains automatic with a ×5 floor and local nearest-ten-level fit. Drag upward on any price cell to zoom in and downward to zoom out; the 1-2-5 row step must change without altering the selected coin, order type, FLOW totals, DOM trade classification, or chart/CVD state. Switch away and back: the manual scale is remembered for that pair only. Double-click the price spine to restore AUTO. A sub-5px press/release remains a normal row click and loads the limit price. Verify `/api/market-subscribe` responds with accepted/dropped symbols plus `flowSnapshots`; accepted watchlist/visible-mover pairs should already have book and rolling-flow state on selection.
- market-subscribe requests only happen on real intent changes
- capture `_flow.revision` from trades frames while exercising normal and rapid BTC→ETH→BTC switches. Revisions for each coin must never decrease. Delay or reorder overlapping `/api/market-subscribe` responses in automation: only the newest selection generation may change accepted coins or Flow state.
- for an accepted cache received on the current connected market-stream epoch, switch pairs and inspect Flow in the same JavaScript turn: the target values and DOM text must replace the prior pair within one render frame. Then remove a cached target from the accepted set (or reconnect to advance the epoch) and switch to it: `WARM 0/500` must appear synchronously, its retained old cache must not paint, and subscription hydration must repaint without waiting for a later user action (latency target ≤250ms for an actively trading pair).
- a near-full restored candle snapshot may log `requested=N accepted=M dropped=K` for market subscriptions. This is expected background shedding under the 900-upstream-subscription safety cap: the active chart remains live, while some watchlist/tracked DOM and trade feeds pause. A shed permanent candle-store feed now bypasses the store until a real candle tick restores it, so no stale recent tail is painted; confirm pressure through `/metrics` (`pez_market_subscription_shed_total` and `pez_market_permanent_candle_feed_dropped_total`).
- on a restart with a recent snapshot (`data/candle-snapshot.json.gz`, saved every 30 min by default via `PEZ_CANDLE_SNAPSHOT_INTERVAL` with a minimum of `5m`, plus on graceful shutdown): the log shows `candle store restored from snapshot` and contiguous previously-warm charts serve from the store (with `cvdDelta`) within ~1–2s of boot — a true cold-start warm-up (first launch, snapshot >7d old, or `PEZ_CANDLE_SNAPSHOT=0`) is now the exception, not the rule. Restored series with any timestamp discontinuity deliberately bypass the store until a covering candle snapshot repairs the hole; thin/hip3 coins may therefore withhold `cvdDelta` for ~1–3 min while their sparse 5m source waits for verification (honest directional fallback, converges on its own)
- during the cold-start warm-up pass above: the actively selected chart never gets stuck on "Chart temporarily unavailable" for more than ~10s (one throttle-cooldown cycle) — if it does, background warm fetches for other tickers are colliding with the interactive passthrough (check the server log for repeated `Hyperliquid HTTP 429` bursts tied to rapid ticker flips, not just a single isolated one). A real 429 now also forces the shared weight budget to back off live (`Store.PenalizeRateLimit`, see *429 / timeout self-healing* in `ARCHITECTURE.md`), so a bad collision window should show a shrinking `x%d` burst count in `logUpstreamRateLimit`'s log line and clear within a single throttle-cooldown cycle rather than stacking several — if bursts stay large/sustained despite that, lower `PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN`. The cleaner check is now `GET /metrics`: `pez_upstream_rate_limited_total` should go flat once the cold window ends while `pez_candle_serve_total{source="store"}` keeps climbing past `passthrough` — that ratio flipping store-heavy is the self-heal working; and `GET /health` should report `api_healthy: true / status: ok`. Rapid builder-dex flips must not spam permanent `Fetch candles error` for aborted switches; a single 502/deadline on a cold pair should recover via client retry + background warm without a re-click.

### 2b. Automated CVD validation (mainnet)

A committed Python harness (`scripts/cvd_validation/`, stdlib-only) replaces
eyeballing the CVD cross-timeframe claims above with exact checks against
Hyperliquid mainnet. Run it whenever CVD code changes or a ticker "looks
off":

```sh
# App running (make run) with a warm store — the harness verifies the
# X-PEZ-Candle-Store header itself and retries while warm-on-demand kicks in.
# If PEZ_API_TOKEN is set for the server, export it first.
python3 scripts/cvd_validation/run_validation.py --tickers BTC --timeframes 5m,1h --days 3   # sanity
python3 scripts/cvd_validation/run_validation.py --top 5 --mid 5 --bottom 5 --deep           # full audit
```

It checks, per ticker × timeframe: **(a)** served `cvdDelta` against two
independent Python recomputations of the 5m/30m composite; **(b)** every
strictly comparable complete higher-TF bucket equals the sum of covering
lower-TF buckets; **(c)** nil-`cvdDelta` census by retained source age band;
**(d)** a simulation of the client's anchored cumulation, split into
fallback and residual. Reports land in
`scripts/cvd_validation/reports/<timestamp>/` and are disposable — rerun
when current evidence is required.

Exit `0` allows exact results, proven upstream revisions, retained-only
history, and cold `not-ready` series. Genuine mismatches, fixed-window
stability changes, request errors, or conservation violations exit nonzero.
See `scripts/cvd_validation/README.md`.

### 2c. Automated Lightweight Charts browser validation

Opera/Chromium CDP is the default browser transport and requires no npm driver.

```sh
node scripts/chart_live_smoke.mjs
```

If `127.0.0.1:9222` is not already a DevTools endpoint, the harness launches
Opera (then Chrome/Chromium) with an isolated profile and stops it on exit.
Override the application with `PEZ_URL`; override CDP with `PEZ_CDP_URL`.
Setting `PEZ_CDP_URL=""` selects the Safari WebDriver fallback.
`PEZ_CDP_NO_LAUNCH=1` requires an already-running debugger; `PEZ_BROWSER`
overrides the binary.

Use the **default** candle weight budget. `PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN=50`
on a snapshot that misses the admit set is a ~15 minute REST wait, not the
normal few-minute smoke.

The gate must finish with `"ok": true`. It covers the exact-pinned Lightweight
Charts runtime, one chart instance across resize/churn, REST candle fidelity,
authoritative and projected WebSocket `series.update()` paths, forming-candle
lock to the live-price line, closed-only indicator signatures, all `1m`–`1M`
intervals, BTC/ETH/SOL and HIP-3 `xyz:GOLD`, panes/overlays/drawings, RVWAP
readiness, wheel-zoom invariance, Fit/overview after overlay attach, and
stale-request rejection. Transient upstream 429s pass only when cached
history remains substantial, `rejectedUpdateCount` stays 0, and no
`[chart] series.update() failed` warning occurs.

**Latest recorded browser acceptance (September 1, 2026):** isolated
non-funded `:5002` serving `main-LL66HRBR.js`. Restore **880** / **8.72s**;
`/readyz` **50/50** `2h` in **2m38s**. Opera/CDP `chart_live_smoke`
**320/320** `"ok": true`: 1 chart, 49 `setData`, 121 `update`, 32 series
recreates, 5175 BTC `2h` candles, `rejectedUpdateCount` 0, 2 recovered 502s.
No wallet or funded action. Isolated process stopped. Older passes:
[archive/LIVE_VALIDATION_HISTORY.md](archive/LIVE_VALIDATION_HISTORY.md).

### 2d. Exhaustive frontend performance and accuracy gate

The committed CDP runner validates the complete static interaction contract,
responsive navigation, cached pair ownership, every timeframe, and candle
ordering. It intercepts every known mutating API route and fulfills mutation
requests with a local fixture (safe for an isolated non-funded profile). It
still uses live read-only market endpoints.

```sh
PEZ_URL=http://127.0.0.1:5001 \
PEZ_CDP_URL=http://127.0.0.1:9222 \
PEZ_PERF_REPORT_DIR=performance-results/latest \
make web-perf
```

Acceptance budgets: local navigation p95 ≤50ms / max ≤100ms, cached symbol
commit p95 ≤50ms, chart-ready p95 ≤250ms, no task over 50ms, 113/113 static
action variants, zero runtime exceptions, zero failed read responses, and
zero invalid/duplicate/out-of-order/rejected chart updates.

```sh
make web-perf-soak
```

adds twenty minutes of rapid surface switching and fails if post-GC DOM
nodes, event listeners, heap, or document counts grow by more than 10%.
Funded lifecycle validation remains the operator gate below.

### 3. Order Lifecycle

When funded and safe:

0. Select Buy or Sell explicitly. The ticket has no Smart Long/Short auto-side path.

1. Place one small limit order.
2. Modify or cancel it.
3. If safe, place one order that fills.
4. Confirm TP/SL chart lines render, including xyz TP/SL trigger lines.
5. If TWAP is relevant, place and cancel one TWAP.

If unfunded, mark the session as `transport/render only`.

Watch for:

- order appears quickly in table and chart
- TP/SL lines are dotted and labeled `TP` / `SL`
- for an order that fills immediately with TP/SL set, the ticket clears as soon as the entry fills; the TP/SL legs attach a moment later (placed asynchronously). Confirm the backend log shows `attachProtection: TP placed …` and `attachProtection: SL placed …` with trigger prices that match the intended TP/SL percentages. If a filled TP/SL order produces no `attachProtection` lines (or a `WARNING: failed to attach TP/SL protection`), the position is unprotected.
- fill/cancel cleanup removes only affected orders
- no stale open orders lingering after repair
- `transportMetrics.api.rateLimits === 0`
- after a fill/close, Portfolio Value and Available should update from a scoped normalized `webData2` account snapshot or the forced post-action REST fallback; confirm the values do not wait for the normal polling interval, `Avail.` tracks the account-mode-owned unleveraged free collateral (perp `withdrawable` in Standard/DEX abstraction; the lesser of spot `tokenToAvailableAfterMaintenance` and spendable USDC `total - hold` in Unified/Portfolio Margin), and a legitimate exhausted balance renders `$0.00` instead of reviving the previous positive value

### 4. Resume / Reconnect

1. Background the tab for 10-20 seconds, then return.
2. Repeat 3-5 times.
3. If practical, interrupt network briefly and let the app recover.

Watch for:

- stream reconnects cleanly
- no polling storm
- bot status rehydrates without restarting bot
- `transportMetrics.stream.pollingTicks` stays `0` during normal websocket operation
- account and market request counts remain explainable

## Acceptance Signals

- account snapshot reports `accountMode`, `accountModeSource`, and
  `riskSummaryFresh`; validate each supported mode with a real wallet before
  treating its aggregate risk display as funded-ready
- metadata contains canonical `<dex>:<symbol>` keys and no
  `<dex>:<dex>:<symbol>` keys
- generic builder position updates arrive on `builderPositions`; xyz also
  receives the compatibility `xyzPositions` update
- `pez_market_upstream_subscriptions` remains at or below 900 including every
  builder `allMids` feed
- `pez_signed_action_queue_seconds` and request latency remain bounded during
  funded place/cancel/protection validation
- one builder fill may publish both `orderUpdates` and `userFills`, but it must
  not create two simultaneous `targeted builder refresh failed` messages for
  the same dex. A later single retry can be legitimate when another event
  arrived during the in-flight refresh; repeated paired warnings indicate the
  per-`account|dex` single-flight has regressed
- on a snapshot-restored boot, `reapplying market subscriptions` should show no
  more than 64 cache-owned candle feeds before active client subscriptions are
  added. Historical series count may be much larger; that separation is
  intentional and the active chart must still load immediately
- with a large movers-plus-watchlist set, `/api/cvd-scan` requests must contain
  at most 40 coins each, run sequentially, and cover the entire de-duplicated
  set. No second scan pass should begin while the previous pass is in flight
- MISPRICE contains only currently closed registered products; endpoint
  deviations match `markPx/closePx`, panel deviations match live midpoint/
  `closePx`, no reference candle is post-close, and unresolved/failed
  references produce partial rows rather than blocking the request
- no console errors except expected degraded/no-backend test-style messages in local smoke scenarios
- no repeated `POST /api/cvd-scan 400` responses; any recurrence means the
  frontend/backend request-limit contract has regressed
- `transportMetrics.api.rateLimits === 0`
- no runaway growth in `/api/account`, `/api/hl`, or `/api/market-subscribe`
- orders/fills/cancels match exchange state
- chart state clears correctly on pair/timeframe switches
- CVD, VWAP, order lines, and preview lines match expected behavior

## Report Back

Send:

1. `JSON.stringify(window.transportMetrics, null, 2)`
2. session length
3. full validation or `transport/render only`
4. whether an order was placed, modified/canceled, and filled
5. whether reconnect/network interruption was forced
6. any stale chart, stale order, duplicate line, CVD/VWAP issue, or scroll/centering issue
7. served `main-*.js` hash

## Red Flags

- non-zero rate limits
- polling ticks during healthy websocket operation
- repeated market-subscribe without coin/timeframe changes
- canceled/filled exchange orders still visible in UI
- previous pair chart state visible after switch
- TP/SL lines missing for normal or xyz orders
- filled order with TP/SL set but no `attachProtection: TP placed` / `SL placed` in the backend log (position left unprotected)
- completed anchored-CVD history changing without an attributed authoritative repair, or comparable closed timestamps disagreeing across timeframes
- manual anchored VWAP missing, losing its exact anchor time, or jumping across timeframes
- any enabled RVWAP missing, not updating on timeframe roll, bleeding after an independent toggle, or not expanding/contracting after breaches
- AVWAP, RVWAP, PROFILE, or MAP color edits bleeding into another overlay, failing to restore after reload, or recreating the chart
- manual pan snapping to live edge without user action
- `chartCreateCount` rising above 1, or `rejectedUpdateCount` rising during coin/TF churn
