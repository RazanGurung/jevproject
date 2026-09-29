# Live Validation History (archived)

> Archived 2026-08-31. Current checklist:
> [../LIVE_VALIDATION_RUNBOOK.md](../LIVE_VALIDATION_RUNBOOK.md).
> Do not extend this file.

# Live Validation Runbook

Use this after starting the app against the environment you want to test.

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
3. Exercise the shared popover behavior with Market, Draw, and IND: only one surface is open; clicking its trigger again, clicking outside, pressing `Escape`, or resizing closes it; opening another replaces it; chevrons and highlights match the visible surface. Confirm `Escape` returns focus to the trigger. Open IND, confirm its Anchored VWAP / Rolling VWAP / Other overlays / Lower panes / Alerts groups are clear. **Anchors** must start ON with no shared Bands/Width row, and **Monthly volume profile** must start ON; every RVWAP and RVWAP Bands checkbox must start OFF, with no initial 4h indicator subscription. Confirm no weekly-anchor checkbox exists. Add an anchor and confirm its start marker has a compact dot inside a clearly larger same-color ring. Selecting that marker (or the just-placed one) shows **Bands** and **1σ/2σ/3σ** next to the origin; those start off at 2σ and do not require reopening IND. The matching IND row stays in sync; a second anchor keeps its own bands/σ independently. Enable the 3D and 30D lines/bands, hide only the 3D bands while both center lines remain visible, restore them, then hide each RVWAP independently without IND closing. Confirm the retired `DOM ×N` control is absent from the topbar. Toggle **HIDE $** and confirm it reads **SHOW $** while account values are hidden, then restores **HIDE $** when values are shown.
   In the same IND panel, confirm the **Price projection** group starts OFF with no 5/10/20 horizon selector. Enable it and verify Research status, the **current-month occupancy map** from that month’s UTC open (no quantile fans or median path lines; elapsed month-to-date squares faint vs remaining-horizon), non-zero `UpFreq`/`wESS`/`cESS` diagnostics, and `BT50`/`BT80` empirical coverage; if history is too short the status is an honest unavailable reason. Disable it and confirm the occupancy primitive detaches. `UpFreq` is not a calibrated probability, `wESS`/`cESS` are not independent sample counts, and backtest coverage is not a future-coverage guarantee. A newly closed bar inside the live UTC month must keep the same month-open origin and full-month horizon while occupancy/weights may refresh; historical fans must stay fixed. Same-bucket forming-candle updates must not recompute.
   Confirm the **2-week path projection** group starts OFF (envelope checkbox may default ON). Enable Path and verify Research status, path fan to Monday+14d UTC (not a short remaining-week stub late in the week), optional week H/L envelope, and status `~Nd left` with N typically ≥7 late week; disable and confirm series detach. Distinct from UTC-month Price Projection.
4. Open **Colors** and confirm it contains the overlay rows Bullish, Bearish, **AVWAP**, **RVWAP**, **PROFILE**, **MAP**, Drawing, Bull candle, and Bear candle (plus Background and Border). The retired generic **Indicator** row must be absent. Enable one manual anchor, one RVWAP preset with bands, Monthly volume profile, and Price projection; assign four visibly distinct colors and confirm only the matching overlay changes: AVWAP owns manual anchors, RVWAP owns rolling presets/swatches, PROFILE owns monthly boxes/POC, and **MAP** owns the current-month occupancy squares plus both projection paths. Changing colors does not recreate the chart. Reload and confirm the values restore before the overlays attach. `Reset` affects only the selected row, `Reset all` restores all defaults, and an invalid shorthand such as `#123` is rejected. For upgrade validation, seed a version-1 `pez:color-palette` payload with an `indicator` value in an isolated profile; the next load must rewrite it as version 2 with that value copied to `avwap`, `rvwap`, `profile`, and `projection`.
5. Confirm **Draw** is off by default (funding/OI bar only). Toggle **Draw** to open the single-row icon strip in that bar (Funding/OI on the right), with an **Off** control. Select a tool, draw, and confirm **keep-drawing**: the same tool stays armed until Off, Escape, or another tool. Draw one of each tool (trend/curve/arrow/horizontal/vertical/channel, box/circle/pencil, marker, fib/measure/text, long/short position), confirm each renders and tracks pan/zoom. For **Circle**, press at the intended center, drag to set radius, and release; confirm a click/no-drag creates nothing and the center/radius handles remain editable. For **Curve**, click start, end, then midpoint; confirm the curve passes through all three points and each handle can be moved independently. Text prompts for a label; measure shows Δ/%/bars and is **not** persisted; pencil draws on press-drag. Draw at least one tool into the whitespace to the right of the last candle and confirm it renders there, tracks pan/zoom, is selectable/draggable (including dragging an endpoint into the future), and survives a reload + timeframe switch; confirm clicks on chart axes/separators and in the empty area left of the oldest bar do nothing. Select one (✕ + handles appear) and delete it (✕ / right-click / Delete). Draw a pane-safe tool in both the **anchored-CVD pane** and **CVD-oscillator pane**; confirm each stays pane-local through placement/drag and persists under the `:cvd` / `:osc` key. Create a persistent toast, click topbar **CLEAR**, and confirm the toast plus drawings/storage in every active-coin pane are removed together. Confirm fib/measure/positions remain price-pane-only.
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
- manual anchored VWAP starts visible; stored anchors render their center line plus a larger origin ring around the start dot. Each stored anchor keeps its own bands/σ (new anchors default to bands hidden at 2σ). The retired weekly overlay has no checkbox, delegated action, `AppState.ui.anchoredVwapVisible` field, or `indicators.anchoredVwap` diagnostic, and the retired shared Bands/Width controls are absent
- Anchors and Monthly Volume Profile start visible; every rolling Kalman RVWAP and band starts hidden. Enabling a preset acquires the optional 4h source, and every preset/band remains independently toggleable with matching color swatches
- with one RVWAP preset enabled, rapidly switch A→B→A across coins and churn `2h`/`4h`/`8h` before either source load settles: only the selected coin may own `rvwapSource`, enabled center/band rows must repopulate without another toggle, returning to a completed coin should reuse its source, and a transient refresh failure must not erase an already-ready overlay
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
- Price Projection starts disabled. Enable it on a history deep enough for
  at least one origin forecast (typically ≥90 calendar days of closed bars
  on sub-daily charts). Fans should cover each monthly-profile month that
  has a valid origin forecast: historical months from UTC month open through
  that month’s last bar, live month from the latest closed bar through the
  next UTC month open (production baseline hides the flat zero-median path
  unless a shrunk tilt is earned). A month with too few non-overlapping
  calibration origins still draws at raw λ = 1; `BT50`/`BT80` may show as
  `—` on that month. The overlay is unavailable only when no profile month
  can be forecast. The panel should report Research status, current month
  label, remaining `Nd left` on the live month, `UpFreq`, `wESS`/`cESS`,
  MAE skill, and terminal-horizon `BT50`/`BT80`; interpret all of these as
  historical diagnostics rather than calibrated probabilities or guarantees.
  Same-bucket candle/mid updates must leave every projected value fixed; a
  newly closed bar inside the live UTC month must move the live origin and
  shorten remaining horizon; historical fans stay identity-stable. Sparse
  higher timeframes and 1m must report unavailable rather than render a
  fallback. Adjacent month fans must not share a timestamp at the month
  handoff. Historical months draw a faint dotted 80% envelope behind the
  50% fan so prior-month containment is visible; the live month keeps the
  stronger dashed 80%. Series count is `5 × monthCount` on the production
  baseline.
- the `1m` native candle accepts same-bucket exchange revisions in place; the anchored-CVD tail stays fixed, then appends the completed prior bucket exactly once after rollover
- manual pan does not snap back unless user returns to live edge
- DOM column: top **ALL/WHALE** are exact latest-500 rolling totals (never session-cumulative, never chart CVD). The header shows `WARM 0/500` before the first print and then exposes sample coverage in its tooltip. **Inside the ladder**, right-column volume-at-price and whale markers are **session-persistent per price** for the pair subscription: a level's total must only increase (or hold) as the tape moves away, and must not shrink when the top FLOW 500 window rotates. Pair prune / switch still clears that coin's session map. Switch among an active pair plus at least two watchlist/mover pairs and confirm FLOW and the ladder change immediately without showing the previous pair. On a genuinely cold pair, the guarded `/api/l2-snapshot` fallback may appear after 250ms. Grey execution flashes still fade near 1.2s (time TTL only); whale cores begin at $100k, major begins at $250k, and the five square stages top out at $5m and stay for the session. Chart CVD and both CVD panes must remain unchanged by these DOM interactions.
- DOM scale remains automatic with a ×5 floor and local nearest-ten-level fit. Drag upward on any price cell to zoom in and downward to zoom out; the 1-2-5 row step must change without altering the selected coin, order type, FLOW totals, DOM trade classification, or chart/CVD state. Switch away and back: the manual scale is remembered for that pair only. Double-click the price spine to restore AUTO. A sub-5px press/release remains a normal row click and loads the limit price. Verify `/api/market-subscribe` responds with accepted/dropped symbols plus `flowSnapshots`; accepted watchlist/visible-mover pairs should already have book and rolling-flow state on selection.
- market-subscribe requests only happen on real intent changes
- capture `_flow.revision` from trades frames while exercising normal and rapid BTC→ETH→BTC switches. Revisions for each coin must never decrease. Delay or reorder overlapping `/api/market-subscribe` responses in automation: only the newest selection generation may change accepted coins or Flow state.
- for an accepted cache received on the current connected market-stream epoch, switch pairs and inspect Flow in the same JavaScript turn: the target values and DOM text must replace the prior pair within one render frame. Then remove a cached target from the accepted set (or reconnect to advance the epoch) and switch to it: `WARM 0/500` must appear synchronously, its retained old cache must not paint, and subscription hydration must repaint without waiting for a later user action (latency target ≤250ms for an actively trading pair).
- a near-full restored candle snapshot may log `requested=N accepted=M dropped=K` for market subscriptions. This is expected background shedding under the 900-upstream-subscription safety cap: the active chart remains live, while some watchlist/tracked DOM and trade feeds pause. A shed permanent candle-store feed now bypasses the store until a real candle tick restores it, so no stale recent tail is painted; confirm pressure through `/metrics` (`pez_market_subscription_shed_total` and `pez_market_permanent_candle_feed_dropped_total`).
- on a restart with a recent snapshot (`data/candle-snapshot.json.gz`, saved every 30 min by default via `PEZ_CANDLE_SNAPSHOT_INTERVAL` with a minimum of `5m`, plus on graceful shutdown): the log shows `candle store restored from snapshot` and contiguous previously-warm charts serve from the store (with `cvdDelta`) within ~1–2s of boot — a true cold-start warm-up (first launch, snapshot >7d old, or `PEZ_CANDLE_SNAPSHOT=0`) is now the exception, not the rule. Restored series with any timestamp discontinuity deliberately bypass the store until a covering candle snapshot repairs the hole; thin/hip3 coins may therefore withhold `cvdDelta` for ~1–3 min while their sparse 5m source waits for verification (honest directional fallback, converges on its own)
- during the cold-start warm-up pass above: the actively selected chart never gets stuck on "Chart temporarily unavailable" for more than ~10s (one throttle-cooldown cycle) — if it does, background warm fetches for other tickers are colliding with the interactive passthrough (check the server log for repeated `Hyperliquid HTTP 429` bursts tied to rapid ticker flips, not just a single isolated one). A real 429 now also forces the shared weight budget to back off live (`Store.PenalizeRateLimit`, see *429 / timeout self-healing* in `ARCHITECTURE.md`), so a bad collision window should show a shrinking `x%d` burst count in `logUpstreamRateLimit`'s log line and clear within a single throttle-cooldown cycle rather than stacking several — if bursts stay large/sustained despite that, lower `PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN`. The cleaner check is now `GET /metrics`: `pez_upstream_rate_limited_total` should go flat once the cold window ends while `pez_candle_serve_total{source="store"}` keeps climbing past `passthrough` — that ratio flipping store-heavy is the self-heal working; and `GET /health` should report `api_healthy: true / status: ok` (it reported "degraded" unconditionally before the July 2026 Content-Type probe fix, so treat any "degraded" as a real signal now). Rapid builder-dex flips must not spam permanent `Fetch candles error` for aborted switches; a single 502/deadline on a cold pair should recover via client retry + background warm without a re-click.

### Latest verification — August 26, 2026 (shutdown hydrate teardown)

Release `main-F2DUXGOT.js` + `styles-GR3RXI6P.css` (backend-only). Frontend
**1059/1059** (146 files); `make test` + `go vet ./...` green. Isolated
non-funded `:5002` (copied snapshot, temp bot-state, no key, default candle
budget): restore **905** / **8.337s**; `/readyz` **48/48** `2h` in **0s**;
remainder `1h`/`4h`/`15m` **0s**. health ok, market WS connected, 1067 prices;
Bybit 269/269; index `main-F2DUXGOT.js`; BTC `2h` **2100** / `cvdDelta`
**1447**. Opera/CDP `chart_live_smoke` **320/320**. SIGTERM saved 905 series
with no `hydrate repair failed` lines. Production snapshot hash `5e2e1959…`
unchanged. No funded action.

### Prior verification — August 25, 2026 (leftover-fix)

Release `main-XDO47V3J.js` + `styles-GR3RXI6P.css`. Frontend **1054/1054**
(146 files); `make test` + `go vet ./...` green. Isolated non-funded `:5002`
(copied snapshot, temp bot-state, no key, **default** candle budget): restore
**927** / **8.345s**; `/readyz` **48/48** `2h` in **1m23s**; health ok, market
WS connected, 1066 prices; index `main-XDO47V3J.js`; BTC `2h` **2400** /
`cvdDelta` **1441**; subscribe BTC/ETH/SOL; 8s stream **51** frames / **29**
`_flow` trades. Signed in-flight **0**. Opera/CDP skipped (`:9222`). No
funded action. Do not set `PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN=50` on a
snapshot that misses the admit set — that is a ~15 min REST wait, not the
normal few-minute smoke.

### Prior verification — August 25, 2026 (first feed-truth pass)

Feed-truth / at-most-once / wake / movers / security pass. Release
`main-BTL54RWJ.js` + `styles-GR3RXI6P.css`. `make test` + `go vet ./...`
green; frontend **1049/1049** (146 files). Isolated non-funded `:5002`
(copied snapshot, temp bot-state, no key, `PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN=50`):
restore **927** series in **8.304s**; `/readyz` **47/47** `2h` in **14m59s**
(admit-set REST hydration under the 50 w/min budget — 41 budget waits,
~997s blocked). Health `ok` / `api_healthy:true` / market WS connected /
1066 cached prices. Bybit liquidations 269/269. coin-meta **348**.
24h-changes **348**. Movers 27/36. Mispricing **0** (US session still open).
Chart-candles store-hit BTC `2h` **2400** / `cvdDelta` **1441**, BTC `1h`
**4800** / **2882**, `xyz:GOLD` `2h` **2400** / **`cvdDelta`=0**; BTC `1m`
**11520** / **`cvdDelta`=0** (passthrough). cvd-scan 2 readings.
`/api/hl` `userRole`/`userFills`/`historicalOrders` **400**; `meta` universe
232. Market-subscribe accepted BTC/ETH/SOL (`sampleCapacity:500`, pending
then applied `added=3 dropped=0`). 18s market-stream: **136** frames,
**1** heartbeat (not treated as data), allMids **9**, trades **88** all with
`_flow`, **358** unique tids, revisions monotonic (BTC 4→90 / ETH 5→91 /
SOL 6→85). CORS PUT **204**. `has-saved-key` false. `pez_signed_actions_in_flight`
**0**; book/trade shed **0**; permanent candle-feed dropped **863** (64-cap).
Opera/CDP not available (`:9222`). No wallet or funded action. Isolated
process stopped (tmp snapshot save 927 series); user `:5001` was not
listening; temps/caches cleared. Production `data/candle-snapshot.json.gz`
hash unchanged (`3b911fa4…`).

### Latest verification — August 18, 2026

Official Hyperliquid wire + stream audit. Release `main-5NK7TKH5.js`.
`make test` + `go vet ./...` green; frontend **1019/1019**. Isolated
non-funded `:5002` (copied snapshot, temp bot-state, no key): restore
1001 / 7.738s; `/readyz` 42/42 `2h` immediately; remainder TFs 0s.
`/api/hl` `userRole`/`userFills`/`historicalOrders` 400. Chart-candles
store-hit BTC `2h` 2400 / `cvdDelta` 1361, BTC `1h` 4800 / 2721,
`xyz:GOLD` `2h` 2400 / `cvdDelta` 0; BTC `1m` `cvdDelta` 0. 24h-changes
346. `pez_signed_actions_in_flight` 0. Opera/CDP not available. No
funded action. User `:5001` left running.

### Latest verification — August 17, 2026

UTC-month Price Projection + Lightweight Charts 5.2.0 scroll/update audit.
Release `main-AVDIL6XN.js`. Isolated non-funded `:5002` (copied snapshot):
restore 990 / 6.707s; `/readyz` after 44/44 `2h` in 1m2s. Opera/CDP second
pass **298** / **2** (first `1h`/`2h` complete-overview diagnostic only).
Month fans, 2-week path, wheel-zoom invariance, one chart, zero rejected
updates. No funded action. See §2c.

### Latest DOM/Flow live-path correctness — August 12, 2026

Release `main-EP3LLBLI.js` + adhoc-signed server after live-key FIFO, armed
subscribe windows, same-lock `_flow` annotate, subscription-lived browser
identities, and HUD cancel/epoch coalescing. Full Go + `go vet` green; frontend
**980/980**. Isolated non-funded `:5002` (copied snapshot, temp bot-state):
restore 810 series in 5.3s, `/readyz` 45/45 immediately, index hash, BTC `2h`
168 enriched, BTC `1m` 120 with `cvdDelta` absent, `xyz:GOLD` `2h` 168,
24h-changes 341. One `POST /api/market-subscribe` accepted BTC/ETH/SOL with
`sampleCapacity:500` and arm revisions 1/2/3; 25s of market-stream trades
delivered 40 `_flow` frames / 132 unique tids, every frame carried
capacity+revision, revisions never decreased (BTC 39 / ETH 43 / SOL 41), and a
membership-only reorder sent no snapshots. Opera/CDP `chart_live_smoke` passed
**296** checks; **5** failed on forming-candle projection / same-bucket
closed-indicator observation / transient `chart-candles` 504s during churn —
not Flow accounting. No wallet or funded action. Repeat the isolated
clean-profile matrix when a new release needs fresh browser evidence.

### Latest chart-candles cold-passthrough hardening — August 3, 2026

Release `main-SCOJCKSS.js` + codesigned server. CandleSnapshot passthroughs use a 25s dedicated HTTP client; `/api/chart-candles` shares the frontend transient-retry ladder with `/api/hl`; cancels stay silent; active-chart self-heal covers 504/deadline. Focused API/market-service tests **43/43**; `go test ./cmd/server` ok. Live reproduction before the fix: thin `xyz:BIRD` 15m cold range returned 502 `context deadline exceeded` under the old 10s client. After the fix, restart + hard-reload, then flip rapidly across cold `xyz:*` pairs/timeframes: charts should paint or self-heal; console should not fill with permanent fetch errors for intentional switches. No funded action.

### Latest DOM session volume ownership — August 3, 2026

Release `main-XTPKVMWO.js` + codesigned server after making ladder volume-at-price and whale markers session-persistent (latest-500 remains top FLOW only); superseded same-day by `main-SCOJCKSS.js` for chart timeout retries. Focused DOM suites **50/50**. Live non-funded smoke on `127.0.0.1:5001`: readiness 42 markets after snapshot restore (950 series), market-subscribe accepted BTC/ETH/SOL with header `sampleCapacity:500`, market-stream delivered allMids/l2Book/trades/candle with `_flow.sampleCapacity=500` and growing `sampleCount`/`revision`, zero subscription shedding. No wallet or funded action. Browser visual check still recommended: a busy pair's right-column totals should only grow at a price while the tape moves away.

### Latest DOM flow/scale acceptance — August 1, 2026

An isolated non-funded Opera/CDP run served `main-DPPGAOHC.js`, warmed BTC/ETH/SOL through one accepted watchlist subscription, and observed populated rolling samples of 110/117/52 prints. Flow plus DOM became ready on pair switches in 8ms/11ms/34ms. A real price-spine drag zoomed out, the scale survived BTC→ETH→BTC without leaking to ETH, and a real double-click restored AUTO. The page retained 39 ladder rows with no uncaught exception or failed resource. Final server health was ready/OK with 1,185 cached prices and a connected market WebSocket; upstream subscriptions were 156 with zero shedding, rate limits, or queue drops. No wallet was connected and no funded action was attempted.

### Race-safe Flow switch acceptance — August 1, 2026

The isolated release served `main-CYJZD3HK.js` from a clean Opera profile on port 5002 with a copied 56 MiB candle snapshot and temporary bot-state path. The server restored 1,008 snapshot series; no production key, bot state, or wallet was loaded. One completed subscription warmed BTC/ETH/SOL to 35/40/33 prints. Same-turn cache switches painted in 3.3–4.3ms and rapid BTC→ETH→BTC in 2.9–3.2ms, with distinct target Flow on every real switch. After restricting acceptance to BTC, switching to retained SOL rendered `WARM 0/500` immediately and hydrated in 153ms. Captured revisions were monotonic across 5 BTC, 2 ETH, and 2 SOL trades frames. Runtime exceptions, console/resource failures, new rate limits, subscription shedding, queue drops, and signed actions were all zero. Final health was ready/OK with 1,185 prices and 74 upstream subscriptions; the downstream client count returned to zero after the CDP target closed.

The final August 1 follow-through retained that browser evidence rather than
rewriting its artifact identity: duplicate same-`clientId` connections now
collapse to one logical downstream client and final-unsubscribe Flow cleanup
publishes a newer empty tombstone revision. The current release candidate is
`main-J352OPBK.js`; 884/884 frontend tests, all Go packages, `go vet ./...`, and
focused WebSocket race coverage pass. A supplied nine-hour operator session on
that candidate reached 38/38 readiness and repeatedly recovered upstream and
downstream resets without a dropped subscription. Repeat the isolated
clean-profile matrix whenever a new release requires fresh browser evidence.

The final hygiene gate also pins membership-only movers reordering: changing
rank order without changing the set must preserve upstream reference counts and
retained Flow. The focused regression, all Go packages, the WebSocket race
suite, and 884/884 frontend tests pass. Rebuilding reproduced the existing
`main-J352OPBK.js` and signed-server hashes; generated test-local-storage files
were removed after verification.

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
independent Python recomputations of the 5m/30m composite — one over current
mainnet and one over the local server's retained source bars. The actual seam
is inferred from the local retained 5m series, never from a fresh, shorter
mainnet response. Results are `exact`, `upstream-revision` (the retained
recomputation proves a normal source-candle revision), `retained-only`
(server history outside today's mainnet 5m response), `not-ready`
(cold/gapped data that cannot yet be proven), or `genuine-mismatch`; an
enriched passthrough that matches either recomputation is classified by its
proven value; **(b)** every strictly comparable
complete higher-TF bucket equals the sum of covering lower-TF buckets on
served data; **(c)** nil-`cvdDelta` census by retained source age band; **(d)**
a simulation of the client's anchored cumulation on timeframe pairs, split
into fallback and residual components. Deep mode explicitly checks the
current-mainnet overlap, retained-only 5m region, pre-seam 30m region, and
`30m→1h/4h/1d` conservation. Reports land in
`scripts/cvd_validation/reports/<timestamp>/`.

Exit `0` allows exact results, proven upstream revisions, retained-only
history, and cold `not-ready` series. Genuine mismatches, fixed-window
stability changes, request errors, or conservation violations exit nonzero.
Acceptance: 0 genuine mismatches, 0 stability differences, 0 identity
violations, and residual ≈ 0 on liquid tickers; thin tickers may carry a large
fallback component or temporarily remain not-ready. See
`scripts/cvd_validation/README.md`.

#### Latest recorded CVD acceptance — July 17, 2026

- The rebuilt local-live 15-ticker audit covered 14 days across
  `5m,15m,30m,1h,4h`: 51,702 exact comparisons, 10 proven upstream revisions,
  45,225 cold/not-ready comparisons, and zero retained-only values. It exited
  PASS with zero genuine mismatches, stability differences, conservation
  violations, or display holes. The not-ready rows belonged to thin off-list
  markets and were correctly withheld rather than falsely enriched.

Generated reports are disposable validation output. Rerun the commands above
when current evidence is required; do not treat an old report directory as a
release artifact.

### 2c. Automated Lightweight Charts browser validation

Opera/Chromium CDP is the default browser transport and requires no npm driver.
With the rebuilt server healthy on port 5001, run from the repository root:

```sh
node scripts/chart_live_smoke.mjs
```

If `127.0.0.1:9222` is not already a DevTools endpoint, the harness launches
Opera (then Chrome/Chromium) with an isolated profile and stops it on exit.
Override the application with `PEZ_URL`; override CDP with `PEZ_CDP_URL`.
Setting `PEZ_CDP_URL=""` selects the Safari WebDriver fallback configured by
`PEZ_WEBDRIVER_URL`. `PEZ_CDP_NO_LAUNCH=1` requires an already-running debugger;
`PEZ_BROWSER` overrides the binary. Manual launch remains valid:

```sh
rm -rf /tmp/pez-opera-smoke
/Applications/Opera.app/Contents/MacOS/Opera \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pez-opera-smoke \
  --no-first-run --no-default-browser-check about:blank
```

The gate must finish with `"ok": true`. It covers the exact-pinned Lightweight
Charts runtime, one chart instance across resize/churn, Hyperliquid REST candle
fidelity, authoritative and projected WebSocket `series.update()` paths, the
forming candle close locked to the live-price line with retained wick extrema,
closed-only AVWAP/RVWAP/profile/CVD/oscillator signatures during same-bucket
native updates, all `1m`–`1M` intervals, BTC/ETH/SOL and
HIP-3 `xyz:GOLD`, native panes/lines/primitives, indicator attach/detach,
absence of the retired weekly anchored-VWAP checkbox/action/state/diagnostic,
manual pivot-anchored VWAP placement, persistence, per-anchor bands/sigma changes,
cross-timeframe recalculation, deletion and coin isolation, drawings,
90D RVWAP/band readiness before any scroll, strict AVWAP/RVWAP data-call
invariance through consecutive real wheel zoom-ins, native shared-right-scale
autoscaling, value/timestamp stability through reverse zoom even when older
history legitimately prepends, and source stability across scroll-back history,
the mobile toolbar, pane-safe price picking,
latest-intent coin/timeframe churn, canonical candle validity/order, indicator
row convergence, orphaned-repair cleanup, dead static routes, and server metrics.
Transient upstream 429s are reported separately from application resource
failures and pass only when cached history remains substantial, chart update
rejections stay at zero, no `[chart] series.update() failed` warning occurs,
and no runtime error occurs. Coin/timeframe snapshots
also wait for rendered series metadata and the canonical candle array to
converge, so a normal staged switch cannot be misreported as stale ownership.

Latest recorded browser acceptance (August 31, 2026, switch smoothness): rebuilt
server on isolated non-funded `:5002` serving `main-WYCTQSKA.js` (copied
snapshot, temp bot-state, no key). Restore **872** series in **8.715s**;
`/readyz` **53/53** `2h` in **10s**; remainder `1h`/`4h`/`15m` **1m47s**.
Harness auto-launched Opera on `:9222` with an isolated profile. Opera/CDP
`chart_live_smoke` **320/320**: 1 chart, 41 `setData`, 86 `update`, 0 rejected,
33 series recreates, 5168 BTC `2h` candles. First pass failed 4h/8h/1d/1M
overview until post-overlay refit was forced. No wallet or funded action.
Isolated process and Opera profile stopped; temps/caches cleared. Production
snapshot hash `30b87408…` (user `:5001` had saved). Restart the start-script
to load `main-WYCTQSKA.js`.

Prior recorded browser acceptance (August 31, 2026, LC adapter): rebuilt server on
isolated non-funded `:5002` serving `main-SF42TQDS.js` (copied snapshot, temp
bot-state, no key). Restore **872** series in **8.786s**; `/readyz` **53/53**
`2h` in **0s**; remainder `1h`/`4h`/`15m` **0s**. Harness auto-launched Opera
on `:9222` with an isolated profile. Opera/CDP `chart_live_smoke` **320/320**:
1 chart, 40 `setData`, 118 `update`, 0 rejected, 32 series recreates,
5168 BTC `2h` candles. First pass failed 1m main-pane price-pick against the
600ms resize guard; the harness now waits after the 1m switch. No wallet or
funded action. Isolated process and Opera profile stopped; temps/caches
cleared. Isolated smoke used a copied snapshot; production hash `9323ba77…`
unchanged. User `:5001` was not listening.

Prior recorded browser acceptance (August 26, 2026): rebuilt server on
isolated non-funded `:5002` serving `main-F2DUXGOT.js` (copied snapshot, temp
bot-state, no key). Restore **905** series in **8.337s**; `/readyz` **48/48**
`2h` in **0s**; remainder `1h`/`4h`/`15m` **0s**. Harness auto-launched Opera
on `:9222` with an isolated profile. Opera/CDP `chart_live_smoke` **320/320**:
1 chart, 43 `setData`, 97 `update`, 0 rejected, 32 series recreates,
5099 BTC `2h` candles. SIGTERM saved 905 series with no
`hydrate repair failed` / `context canceled` lines. No wallet or funded action.
Isolated process and Opera profile stopped; temps/caches cleared. Isolated
smoke used a copied snapshot; production hash `5e2e1959…` unchanged.

Prior recorded browser acceptance (August 25, 2026): rebuilt server on
isolated non-funded `:5002` serving `main-F2DUXGOT.js` (copied snapshot, temp
bot-state, no key). Restore **916** series in **8.393s**; `/readyz` **47/47**
`2h` in **0s**; remainder `1h`/`4h`/`15m` **0s**. Harness auto-launched Opera
on `:9222` with an isolated profile. Opera/CDP `chart_live_smoke` **320/320**:
1 chart, 44 `setData`, 111 `update`, 0 rejected, 32 series recreates,
5097 BTC `2h` candles. No wallet or funded action. Isolated process and Opera
profile stopped; temps/caches cleared. Isolated smoke used a copied snapshot;
production hash `b607a3a0…` unchanged.

Prior recorded browser acceptance (August 25, 2026): rebuilt server on
isolated non-funded `:5002` serving `main-Z2O7UXV3.js` (copied snapshot, temp
bot-state, no key). Restore **927** series in **8.537s**; `/readyz` **48/48**
`2h` in **0s**; remainder `1h`/`4h`/`15m` **0s**. Harness auto-launched Opera
on `:9222` with an isolated profile. Opera/CDP `chart_live_smoke` **320/320**:
1 chart, 45 `setData`, 124 `update`, 0 rejected, 33 series recreates,
5094 BTC `2h` candles. No wallet or funded action. Isolated process and Opera
profile stopped; temps/caches cleared. Isolated smoke used a copied snapshot;
production hash `f76518e8…`.

Prior recorded browser acceptance (August 18, 2026): rebuilt
`main-4GLTRWJU.js` on isolated non-funded `:5002` (copied snapshot, temp
bot-state, no key). Restore **1001** series in **8.498s**; `/readyz` **44/44**
`2h` immediately after restore; remainder `1h`/`4h`/`15m` **0s**. First
Opera/CDP pass **297** / **3** (first `1h`/`2h` complete-overview remap plus
a forming-candle `waitFor` flake). Immediate re-run **298** passed, **2**
failed: the first `1h` and `2h` complete-overview diagnostic only (LC remaps
a requested overview that includes future slots to a same-width window with
negative `from`; later `2h` overview checks, forming-candle lock/wicks,
authoritative `update()`, and `rejectedUpdateCount=0` all passed). Adapter
hardening under test: `setData` range restore, 40k-cap history complete,
head-eviction rebuild, theme navigation lock, timeframe-based future
drawings, projection autoscale opt-out. Final summary: BTC `2h` 5006
candles, `setDataCount=43`, `updateCount=21`,
`reconciliationSetDataCount=0`, `seriesRecreateCount=32`,
`recoveredUpstreamFailures=0`, one chart instance. No wallet or funded
action. Isolated Opera profile, `:5002` process, `/tmp/pez-smoke-5002`,
and Vite/Vitest caches removed; production `data/candle-snapshot.json.gz`
untouched; user `:5001` left running.

Prior recorded browser acceptance (August 17, 2026): rebuilt
`main-AVDIL6XN.js` on isolated non-funded `:5002` (copied snapshot, temp
bot-state). Restore **990** series in **6.707s**; `/readyz` after **44/44**
`2h` histories in **1m2s**; remainder `1h`/`4h`/`15m` **0s**. First Opera/CDP
pass **293** / **7** (same-bucket wait, forming-candle cluster, 4×
`/api/chart-candles` 504). Immediate re-run **298** passed, **2** failed: the
first `1h` and `2h` complete-overview diagnostic only (LC remaps a requested
overview that includes future slots to a same-width window with negative
`from`; later `2h` overview checks passed). UTC-month Price Projection fans,
2-week path, wheel-zoom invariance, history prepend, one chart instance,
`rejectedUpdateCount=0`, and throttle-recovery passed. Final summary: BTC
`2h` 2980 candles, `setDataCount=47`, `updateCount=32`,
`reconciliationSetDataCount=0`, `seriesRecreateCount=32`,
`recoveredUpstreamFailures=2`. No wallet or funded action. Isolated Opera
profile, `:5002` process, and Vite/Vitest caches removed; production
`data/candle-snapshot.json.gz` untouched by the smoke.

Prior recorded browser acceptance (August 9, 2026): rebuilt
`main-EZLQT7QI.js` passed **299/299** non-funded Opera/CDP checks after the
isolated no-key server completed the 46/46 readiness barrier. The gate covered
projection-disabled startup, five native series, 5- and 20-day horizons,
empirical diagnostics, future extent,
confirmed-close-only stability, and clean detach, plus every existing
`1m`–`1M`, BTC/ETH/SOL/`xyz:GOLD`, drawing/VWAP/CVD, history, resize, churn,
and live-candle assertion. Final diagnostics reported one chart instance,
zero rejected updates, no runtime/resource error, and a settled BTC 2h chart.
Health and ready were true with 1,055 cached prices, connected market WS, and
the 259-topic Bybit feed ready. No signing key, wallet, order, or funded action
was used. The server/browser stopped cleanly; the isolated browser profile and
Vite test cache were removed.

Prior recorded browser acceptance (July 31, 2026): the conflation-safe
reconciliation release restored 966 series from an isolated temporary snapshot
and completed the 38/38 default-chart readiness barrier in 4m50s. Rebuilt
`main-E2ZRX66D.js` passed **293/293** non-funded Opera/CDP checks across every
`1m`–`1M` interval and BTC/ETH/SOL/`xyz:GOLD`. Final diagnostics reported one
chart instance, `setDataCount=44`, `updateCount=41`,
`reconciliationSetDataCount=0` during the natural live run, 33 main-series
recreations, 2,980 final BTC 2h candles, zero rejected updates, and no chart
warning, runtime, application-resource, recovery, or upstream failure. The
strict unit regression separately forced projected-next-bucket → late-final-
prior-bucket ordering and proved canonical `setData()` plus projection restore
under conflation semantics. Health was ready/OK with 1,184 cached prices;
metrics showed 74 upstream subscriptions, zero active shedding, zero stream
clients after the gate, and zero signed actions. Clean shutdown checkpointed
967 temporary series. The server, browser, temporary snapshot/profile, test
storage, Vite cache, and macOS metadata were removed; production `data/` was
untouched. No order or funded action was attempted.

Prior recorded browser acceptance (earlier July 31, 2026): the independently audited
release restored 946 candle series and completed the 38/38 default-chart
readiness barrier in 2m20s. Rebuilt `main-4TY6WRF3.js` passed **292/292**
non-funded Opera/CDP checks across all `1m`–`1M` intervals and
BTC/ETH/SOL/`xyz:GOLD`. Final diagnostics reported one chart instance,
`setDataCount=45`, `updateCount=105`, 33 main-series recreations, 2,980 final
BTC 2h candles, zero rejected updates, and no runtime, application-resource,
recovery, or upstream failures. Health was OK and ready with 1,183 cached
prices; metrics showed 74 upstream market subscriptions, zero subscription
shedding, zero downstream queue drops observed by the gate, and zero signed
actions in flight. The server and isolated browser shut down cleanly, the
candle checkpoint advanced to 951 series, and temporary browser/test caches
were removed. No order or funded action was attempted.

Prior recorded browser acceptance (July 30, 2026): rebuilt
`main-TMNEGHO4.js` passed **292/292** non-funded Opera/CDP checks. With 3D,
30D, and 90D RVWAPs enabled, real wheel input changed Lightweight Charts'
spacing twice inward and once outward while AVWAP/RVWAP sources, tail
timestamps, values, and viewport-only `setData()` counts stayed stable. The
right price scale remained in native autoscale mode and contained all visible
VWAP centers/bands. Reverse zoom was allowed to trigger the existing
1,000-candle infinite-history prepend; that correctly rebuilt history while
leaving every latest AVWAP/RVWAP timestamp and value unchanged. Final
diagnostics reported one chart instance, `setDataCount=41`, `updateCount=62`,
32 main-series recreations, 2,980 BTC 2h candles, zero rejected updates, and no
runtime, application-resource, recovery, or upstream failures. No order or
funded action was attempted.

Earlier recorded browser acceptance (July 30, 2026): the isolated release server
restored 984 candle series in 8.18s and completed the 39/39 `/readyz` barrier
in 2m30s. Rebuilt `main-HFJQHFKY.js` passed **286/286** non-funded Opera/CDP
checks across every `1m`–`1M` timeframe and BTC/ETH/SOL/`xyz:GOLD`. The new
closed-candle gate observed the native forming candle advance under real
WebSocket traffic while the manual AVWAP, Monthly Profile, CVD, oscillator,
and enabled RVWAP fingerprints remained unchanged. It also verified the fresh
Anchors-on/Profile-on/RVWAP-off defaults and empty initial 4h indicator
subscription. Final diagnostics reported one chart instance,
`setDataCount=42`, `updateCount=73`, 33 main-series recreations, 2,980 final
BTC 2h candles, zero rejected updates, and no runtime, application-resource,
recovery, or upstream failures. Rapid churn settled on the latest BTC 2h
intent with valid canonical ordering and no orphaned repair. No order or
funded action was attempted. The server and isolated browser shut down cleanly;
their copied snapshot/profile plus Vitest/Vite and macOS scratch files were
removed.

Prior recorded browser acceptance (July 29, 2026): after the 39-market
`/readyz` barrier completed, rebuilt `main-BSDKG3PO.js` passed 285/285
non-funded Opera/CDP checks. The matrix covered every `1m`–`1M` timeframe,
BTC/ETH/SOL/`xyz:GOLD`, manual AVWAP and drawings, RVWAP/CVD/oscillator,
resize/history, and projected plus authoritative live candles. It retained one
chart instance, `setDataCount=44`, `updateCount=107`, zero rejected updates,
and no runtime, application-resource, or recovery failures. The isolated
server restored 973 candle series in 8.47s, reached chart readiness in 2m2s,
stayed `ready/ok`, and held 74 upstream subscriptions with zero shedding.
Live news health also confirmed ten items from the corrected U.S. CFTC feed.
The first pass exposed a one-slot `1m` full-overview shift when projection
opened a new bucket after Fit; the chart now expands that active overview on
append, backed by a focused unit regression. One intermediate rerun stopped at
a transient live DOM ladder timeout; an unchanged immediate repeat passed all
285 checks. No funded actions were attempted.

Prior recorded browser acceptance (July 25, 2026): after the 42-market
`/readyz` barrier completed, rebuilt `main-XWUDSMLG.js` passed 223/223
non-funded Opera/CDP checks. Before any history navigation, the gate enabled
90D RVWAP and bands, proved they rendered from the ready 4h source with complete
warmup, then performed eight chart scroll-back drags and proved the source
extent plus center/band row counts stayed unchanged. The complete
chart/indicator/coin/timeframe matrix retained one chart instance, zero rejected
updates, and no runtime, application-resource, recovery, or upstream failures.
A late ResizeObserver callback initially exposed that an armed manual-anchor
click could be discarded; armed placement now bypasses only the resize guard
while retaining movement and long-press protections. A transient history merge
between readiness and snapshot also led the harness to recapture the settled
CVD state. No funded actions were attempted.

Earlier recorded browser acceptance (July 18, 2026): after `/readyz` completed,
the clean-profile rebuilt `main-3DIANIQA.js` release passed 194/194 checks. It
preserved the complete Hyperliquid payload on a completed candle, proved the
forming close/source price equals the native live-price line across successive
updates, retained observed high/low extrema, held one chart instance with zero
rejected updates, covered all `1m`–`1M` timeframes plus
BTC/ETH/SOL/`xyz:GOLD`, and reported no runtime, resource, recovery, or
upstream-throttle failures. The server stayed healthy with 74 upstream
subscriptions and zero shedding. No funded actions were attempted.

### 2d. Exhaustive frontend performance and accuracy gate

The committed CDP runner validates the complete static interaction contract,
responsive navigation, cached pair ownership, every timeframe, and candle
ordering. It intercepts every known mutating API route and fulfills mutation
requests with a local fixture, so this is safe for an isolated non-funded
profile. It still uses live read-only market endpoints; upstream failures remain
visible in the report and fail the gate.

Start the built app and an isolated Opera profile, then run:

```sh
PEZ_URL=http://127.0.0.1:5001 \
PEZ_CDP_URL=http://127.0.0.1:9222 \
PEZ_PERF_REPORT_DIR=performance-results/latest \
make web-perf
```

The default run uses 30 repetitions for common desktop/mobile navigation and
enough cached BTC/ETH/SOL/`xyz:GOLD` cycles for meaningful warm p95 samples.
Acceptance budgets are local navigation p95 ≤50ms/max ≤100ms, cached symbol
commit p95 ≤50ms, chart-ready p95 ≤250ms, no task over 50ms, 113/113 static
action variants, zero runtime exceptions, zero failed read responses, and zero
invalid/duplicate/out-of-order/rejected chart updates. JSON and Markdown reports
are written when `PEZ_PERF_REPORT_DIR` is set.

Run the sustained leak gate separately:

```sh
make web-perf-soak
```

That adds twenty minutes of rapid desktop/mobile surface switching and fails if
post-GC DOM nodes, event listeners, heap, or document counts grow by more than
10%. Conditional controls (orders, fills, positions) stay catalogued as dynamic
actions and are exercised when their owning live fixture exists; funded lifecycle
validation remains the separate operator gate below.

Latest recorded run (August 9, 2026): isolated Opera against the fully-ready
server and `main-E7QNBUWV.js` exercised 113/113 static variants plus 14 direct
controls across 30 iterations. Desktop/mobile navigation p95 was at most
34.9ms (worst max 50.2ms); cached symbol commit p95 was 36.1ms and chart-ready
p95 37.6ms. All
BTC/ETH/SOL/`xyz:GOLD` ownership checks and all 11 timeframes became ready with
zero invalid, duplicate, out-of-order, or rejected updates. Runtime exceptions,
console errors, and failed read responses were zero; two palette writes were
intercepted. Frame-sliced indicator/RVWAP work removed the cold deep-history
residual: the strict result is **PASS**, with zero tasks over 50ms and a worst
instrumented chart phase of 18.3ms. The report is in
`performance-results/final/`; the twenty-minute soak remains an
operator-duration gate and was not claimed by this run.

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

### Close-based MISPRICE result — July 30, 2026

- `make release` produced `web/dist/main-OWBAA2ML.js` and a verified
  ad-hoc-signed `hyperliquid-server`.
- The isolated no-key/no-bot-state mainnet server restored 973 candle series,
  completed 40/40 default-chart readiness, and loaded 472 metadata markets
  across 10 DEXes. `/api/stock-mispricing` returned five currently closed Asian
  rows in 0.397s with the exact nine-field schema, zero formula error, correct
  absolute sorting, and no open session.
- Independent 1m reads spanning each of the five venue boundaries proved every
  `closePx` was the final pre-boundary candle even though post-close candles
  existed. The check covered TSE, KRX, and HKEX names; it was not scoped to
  ZHIPU. The ZHIPU example resolved `109.38` and rendered live at `119.35`
  (`+9.12%`).
- The clean-profile Opera/CDP production-bundle gate passed all checks: the
  visible set and order matched live `allMids`, all rows cleared the absolute
  1% floor, mark fallback remained available, tooltips showed session close →
  current HL, legacy oracle/premium fields were absent, and there were zero
  runtime errors or relevant HTTP failures.
- Browser transport recorded 14/14 successful API requests and zero rate
  limits. Server metrics showed 74 upstream subscriptions, zero subscription
  shedding, and zero upstream 429s. No funded action or account mutation was
  attempted.

### Full Lightweight Charts result — July 14, 2026

- A rebuilt mainnet-connected server passed the committed browser gate at
  **132/132 checks** with no failures. The run exercised all 11 intervals,
  BTC/ETH/SOL/`xyz:GOLD`, native candle/CVD/oscillator panes, anchored VWAP,
  rolling VWAP bands, monthly volume profile, drawings in price and CVD panes,
  preview/live price lines, mobile controls, REST payload equality, history
  backfill to 5,001 BTC 2h bars, and live candle traffic.
- Lightweight Charts remained at one chart instance. The final diagnostic
  recorded 49 `setData()` snapshots, 13 live `update()` calls, 26 main-series
  recreations, and **0 rejected updates**; final ownership was BTC 2h with
  5,001 canonical exchange candles. No runtime error, unhandled rejection,
  application/static HTTP failure, or dead compatibility route remained.
- Live stress found and fixed three edges: the mobile action toolbar lacked its
  responsive display rule; the old 100 ms debounce discarded a final rapid
  timeframe click; and a throttled repeat timeframe load cleared its cached
  history. The toolbar now renders on mobile, timeframe churn coalesces to the
  latest intent, and target cache is painted before refresh. An inactive coin
  tick can no longer overwrite the active legacy price/title.
- Full frontend tests, full Go tests, `go vet ./...`, and `make release` passed.
  CCXT remains intentionally excluded: this path depends on Hyperliquid-native
  candles, subscriptions, HIP-3 routing, cache health, and first-party Go
  execution/signing rather than a normalized multi-exchange adapter.

### Trading/chart isolation result — July 13, 2026

- Scope: funded mainnet operator console review after splitting realtime market
  and trading streams, moving chart/CVD reads behind backend-owned endpoints,
  and limiting cache-owned permanent candle feeds. BTC and `xyz:GOLD` were
  exercised with minimal size.
- Startup restored 888 historical series but reapplied only 64 permanent candle
  feeds. Market and trading browser clients connected on separate sockets; the
  active subscription accepted all 17 requested trade coins with zero drops.
- Repeated coin/timeframe switching produced immediate subscription changes and
  no prior `/api/chart-candles` INFO-log flood. The active chart remained
  responsive while trading state initialized.
- BTC market entry filled in 1.099s. `xyz:GOLD` market entry filled in 0.939s
  and its position close completed in 0.917s. Close All issued one standard and
  one builder request, so two `/api/close-position` audit records were expected.
- One post-close builder repair pair timed out because `orderUpdates` and
  `userFills` started duplicate targeted refreshes. This was fixed afterward
  with the per-`account|dex` burst single-flight and is regression-tested; the
  next funded restart should confirm at most one initial targeted refresh per
  event burst. Periodic builder/account timeout warnings remain recoverable
  upstream degradation when the UI retains explicitly stale state.
- Automated post-fix gate: all Go tests and vet passed, focused race packages
  passed, frontend 762/762 tests across 122 files passed, and both production
  artifacts built successfully.

### Default chart dependency startup gate — July 17, 2026
(Updated August 11, 2026: listener-before-snapshot; admit = default TF only;
history-ready without REST for complete restored series, including 5m/30m CVD sources at Hyperliquid's 5000-candle retention.)

- Restart with the real candle snapshot and do not switch coin or timeframe.
  The server address/health listener should be announced **before snapshot
  restore completes** (not only before chart hydration). During that window
  `/healthz` must return `200`, `/readyz` and functional routes must return
  `503`, and no partial chart/API request may be admitted. When using
  `start (Mac).command`, no browser tab may open during this window. Startup
  must then log `startup chart universe selected`, `restoring candle snapshot`
  / restore took, then `default chart histories ready` with the pinned/liquid
  market count for **2h only**; `/readyz` must turn `200`, after which the
  launcher must open exactly one browser tab. Remainder TFs (`1h`/`4h`/`15m`)
  may log `remainder startup timeframes ready` later without blocking the gate.
  A startup chart hydration failure on the admit set is fatal and the launcher
  must report an early server exit instead of waiting indefinitely.
- On the first direct 2h render for BTC and representative liquid/sparse
  `xyz:*` pairs, inspect the recent completed weekly-anchor window. Every bar
  inside obtainable source coverage must carry `cvdDelta`; the renderer must
  not need a lower-timeframe switch or delayed refetch to become complete.
- Latest restored-snapshot acceptance (July 17): metadata discovered 462
  markets, the pinned/OI policy selected 41, 1,023 historical series restored,
  and the 64 cache-owned feed cap remained enforced. `/healthz` returned 200
  while `/readyz` returned 503 during hydration. Readiness reached 41/41 in
  2m58s, `/readyz` turned 200, and final detailed health reported
  ready/API/market WebSocket healthy. The Mac launcher opened the browser once,
  only after readiness; its process-liveness guard also reported an induced
  early exit without hanging.
- The first migration from a snapshot without persisted verified-gap state can
  take materially longer because every selected dependency must be proven.
  Later snapshots retain that state but still verify live tails under the
  shared upstream budget. Startup duration is not a failure while readiness is
  advancing and functional HTTP remains gated.
- Force the REST/WS convergence race in the automated readiness test: advance a
  30m series' `gapGen` during its first repair. Startup must re-inspect and
  repair the newer range rather than fail; stable empty results must not repeat
  the same full-history request.
- Switching among `15m/30m/1h/2h/4h/8h/1d` should retain the same coin's shared
  5m/30m client refs; switching coin should move those refs to the new coin.
  `1m`, `1w`, and `1M` hold only their primary candle feed.

### Latest whale/flow result — July 12, 2026

- Scope: non-funded mainnet transport/state validation; no order actions and no manual browser visual inspection.
- Restored-snapshot boot: healthy at the 900-feed ceiling; active BTC accepted and background ETH correctly shed.
- Controlled below-cap boot (`PEZ_CANDLE_SNAPSHOT=0`): BTC+ETH accepted, then SOL made active while both continued streaming; zero shedding.
- 95s capture: 148 `_flow` snapshots, 431 unique tids, zero duplicate tids, and 60 ≥$10k whales.
- Independent tier/half-life reconstruction: maximum relative difference 0.0097% (~$0.10 on ~$1.07k).
- Real response sample: $20.7k BTC sell, sampled at 61.2s, classified `Absorbed`.
- Final health: `status=ok`, `api_healthy=true`, market WebSocket connected, zero stream clients after disconnect.
- Not observed live: a ≥$250k print/major ring. Halo/ring/tooltips remain covered by automated renderer tests; repeat manual browser validation when a major print is available.

### Post-optimization whale/flow result — July 12, 2026

- Scope: non-funded mainnet transport/state validation of the replay-safe flow and freshness changes; controlled `PEZ_CANDLE_SNAPSHOT=0` boot, no order actions, no manual browser visual inspection.
- BTC+ETH were accepted together, followed by active SOL while BTC+ETH continued streaming; 33 upstream subscriptions, zero shedding.
- 95s capture: 134 `_flow` snapshots / 283 unique tids, zero duplicate tids; 64 BTC, 54 ETH, and 16 SOL trade batches. All background feeds continued after the switch.
- `_flow` thresholds plus `lastTradeAt`/`lastWhaleAt` metadata validated. Independent non-overlapping tier/half-life reconstruction matched within 0.0139% maximum relative error (~$1.12 on ~$8.05k).
- Nine ≥$10k whales were observed. A real ~$50.0k BTC sell sampled at 60.7s classified `Absorbed`; no ≥$250k major occurred.
- Final health: `status=ok`, `api_healthy=true`, market WebSocket connected, zero stream clients after validation; graceful shutdown completed.

### Top WHALE flow threshold result — July 23, 2026

- Scope: focused 95s non-funded mainnet transport/state validation of the top-meter-only cutoff change; rebuilt server on an isolated local port, BTC+ETH+SOL trade feeds, no signing key or order action.
- Captured 239 `_flow` snapshots / 496 unique trades with zero duplicate trade IDs, zero threshold mismatches, and zero independent reconstruction mismatches.
- Every snapshot advertised `flowThresholdUsd=1000`, DOM `whaleThresholdUsd=10000`, top-meter `whaleFlowThresholdUsd=100000`, and `majorWhaleThresholdUsd=250000`.
- Thirty-three live $10k–$99,999 prints remained DOM-whale eligible while staying out of the top WHALE totals; eight ≥$100k prints entered the top WHALE tier. Independently reconstructed regular/whale buy/sell totals matched every cumulative backend snapshot.
- All three trade feeds were accepted with zero shedding. Final health was `status=ok`, `api_healthy=true`, and market WebSocket connected; downstream client count returned to zero, upstream subscriptions returned to the 74-feed baseline, and the server shut down cleanly.

### Funded BTC trading result — July 12, 2026

- Scope: Unified account, minimal mainnet BTC sizes. Started and finished flat; final `frontendOpenOrders=[]` and standard-perp `assetPositions=[]`. BTC leverage was restored to 5x.
- Limit lifecycle: placed a non-marketable order (1.216s), moved it through the chart-modify endpoint (0.830s), then canceled it (0.866s).
- Bull scale/bulk lifecycle: placed two resting scale orders in one batch (0.807s), bulk-modified them, and exercised mixed stale/replaced bulk cancellation. This live case exposed partial-result optimism; backend and UI now reconcile only per-status-confirmed replacement/cancel oids.
- Market/protection lifecycle: market entry filled in 1.057s; TP and SL attached asynchronously, both triggers were moved atomically (0.746s / 0.838s), then bulk-canceled 2/2 in 0.881s. Live sizing exposed the stop leg flooring one BTC size increment; protection now carries exact filled coin size.
- TWAP/leverage lifecycle: exchange minimum rejection surfaced correctly; a valid 10-minute $102 TWAP was accepted (1.327s), immediately canceled (1.301s), its first `0.00018 BTC` slice was closed (1.032s), and leverage was restored. The $100 boundary can round below the exchange minimum, so validation should use a small buffer above it.
- Unified account panel: live mode detection and Available were verified. Resting-order spot holds now reduce Available (`min(tokenToAvailableAfterMaintenance, total-hold)`), and builder-dex account fan-out has a 3s per-dex deadline so one slow venue cannot consume the whole account request budget.
- Automated gate after fixes: full Go suite and `go vet ./...` passed; frontend passed 760/760 tests across 121 files; production frontend and server were rebuilt.

### Funded BTC + xyz:GOLD rebuild verification — July 12, 2026

- Scope: second funded pass against the restarted/rebuilt server, Unified account, minimal BTC and `xyz:GOLD` mainnet sizes. Both venues started and finished with `frontendOpenOrders=[]` and `assetPositions=[]`.
- Unified hold math passed live: Available moved from `$13.46195111` to `$11.35307111` while a BTC resting order held `$2.10888`, then recovered after cleanup. A normal aggregate account read completed in 0.564s. One forced read during upstream contention exceeded 12s; the hot path is now bounded at 8s overall, 3s per builder dex, and 2s for the forced portfolio refresh.
- BTC: limit place 1.137s, chart move 0.973s, two-level bullish scale place 0.800–0.830s, clean bulk cancel 2/2 in 0.722s, market+protection fill 1.051s, exact `0.00016` TP and SL, trigger moves 0.819–0.881s, protection bulk cancel 2/2 in 0.842s, close 1.102s.
- `xyz:GOLD`: limit place 0.966s, chart move 0.771s, two-level bullish scale place 0.778s, bulk cancel 2/2 in 0.964s, market fill 0.831s, exact `0.0025` TP and SL, trigger moves 0.762–0.920s, protection bulk cancel 2/2 in 0.829s, close 1.150s.
- Below-minimum modify edge: moving `0.00018 BTC` to `$55,000` creates `$9.90` notional. Live exchange behavior removed the old order while rejecting the replacement. Frontend and backend now reject such opening-order drags before signing; reduce-only and TP/SL modifies remain exempt.
- Position-panel path: manual TP/SL, cancel, and close were exercised separately. The TP reproduced a rounding under-size (`0.00015` protecting `0.00016`) because the panel sent notional based on an unrounded trigger. Position-panel TP/SL now sends exact `szCoin`, and its optimistic chart lock uses coin size.
- Post-fix automated gate: full Go suite and `go vet ./...` passed; frontend passed 762/762 tests across 121 files. Release artifacts were rebuilt after these fixes.

### Final trading-control audit — July 12, 2026

- Scope: funded validation against the next restarted build plus a source audit of every rendered trading `data-action`. Final cleanup confirmed no standard or `xyz` orders/positions.
- Live passed: Buy/Market, Sell/Limit, Preview, valid Modify, below-minimum Modify rejection with the original order preserved, single Cancel, BTC and GOLD Scale, cross-venue Cancel All (4/4), exact position-panel TP and SL, TP/SL cancel, leverage change/restore, TWAP start/cancel/slice cleanup, and full Close.
- Scheduled Cancel was wired and returned the exchange's real eligibility error: account volume `$365,991.2`, `$1,000,000` required. No schedule was installed. This is an account restriction, not a button/transport failure.
- The 25% Close request exposed a 12s stall before signing; exchange state proved it made no change. Root cause was an unnecessary clearinghouse direction lookup even though the rendered row already carried signed size. Close requests now send signed `positionSzi`; standard and builder paths skip that lookup, while legacy callers retain fallback behavior. The 50/75/full and Close All controls share the same corrected path; unit coverage includes both long and short signed sizes.
- Dead frontend code removed: `bulkModifyOrdersUI`, `cancelByCloidUI`, and `updateIsolatedMarginUI` plus their uncalled bulk-modify service branch. None had a visible button or production caller; backend endpoints remain intact.
- Verification after cleanup: all Go packages and `go vet ./...` passed; frontend passed 759/759 tests across 121 files (three tests intentionally removed with dead code). Production artifacts rebuilt; Go/Vite/Vitest caches cleared after the build.

### Full funded frontend matrix — July 12, 2026

- Scope: repeated funded mainnet validation on the final rebuilt binary, Unified account, standard BTC plus builder `xyz:GOLD`. Every order/position mutation was exchange-confirmed and cleanup finished with zero orders and zero positions; BTC and GOLD leverage were restored to 5x.
- Bulk controls: BTC bull Scale accepted 20/20, chart/modal move returned its replacement oid, and bulk cancel confirmed 20/20. GOLD bear Scale independently accepted 20/20, moved through the builder modify path, and bulk cancel confirmed 20/20. A mixed BTC+GOLD Cancel Selected/All request confirmed both venues in one batch. Single Buy/Sell limit place and Cancel also passed.
- Protection/order controls: Buy/Sell previews passed on both venues; BTC attached protection and position-panel protection used exact size, both TP and SL moved atomically, and the replacement oids bulk-canceled 2/2. GOLD exact-size TP/SL, TP drag, and 2/2 protection cancel passed. Ordinary reduce-only limit/cancel passed.
- Position controls on exchange-minimum-safe ~$44 entries: BTC 25% reduced `0.00070 → 0.00053` (725ms), short 50% `-0.00070 → -0.00035` (869ms), and 75% `0.00070 → 0.00018` (929ms); every remaining full Close succeeded. GOLD 25% reduced `0.0108 → 0.0081` (765ms), then full Close succeeded. Close All flattened simultaneous BTC long and GOLD short in ~0.8s per venue.
- TWAP/leverage: 10-minute `$102` BTC TWAP id `2025428` started and canceled in under one second per action; any first slice was included in final flat cleanup. Leverage changes/restores passed.
- Scheduled Cancel is wired but account-restricted: Hyperliquid rejected set and clear because `$1,000,000` lifetime volume is required and the account had `$366,514.73`. No timer was installed. Treat this as an eligibility result, not a transport failure.
- Live defects found and fixed during the matrix: confirmed Unified mode is retained across transient `webData3` failure; expired account snapshots are served explicitly stale instead of HTTP 500 and keep last fresh Available; streamed standard/builder mids now feed execution so Close does not fail on a redundant `allMids` REST call; fractional close size is floored to venue precision. The deliberately tiny `$11` 25% test then reached the exchange correctly and was rejected only because its ~$2.50 partial was below the venue's $10 minimum; the ~$44 validation entries passed.
- Final automated gate: all Go packages and `go vet ./...` passed; frontend passed 761/761 tests across 121 files; production frontend/server artifacts were rebuilt.

### Stable candle-spacing result — July 25, 2026 (historical; superseded)

- Restored-snapshot boot loaded 974 candle series and reached the 42/42 market-readiness barrier in 3m24s.
- The isolated, non-funded Opera/CDP gate passed **268/268** checks against the rebuilt production bundle.
- The former fixed-spacing target was validated across every supported timeframe and responsive resize before the overview-first policy superseded it.
- The current candle stayed visible with dedicated 90-day RVWAP and bands attached; RVWAP history remained stable across scrollback, and the live forming candle continued updating.
- Final diagnostics reported one chart instance, 48 full data sets, 41 incremental updates, zero rejected updates, and no runtime, resource, or recovery failures.
- The validation server and isolated browser were shut down cleanly. The isolated browser profile, Vite cache, Vitest local-storage files, and macOS metadata were removed.

### Complete-history/conflation result — July 25, 2026

- Restored-snapshot boot loaded 974 candle series and reached the 42/42 readiness barrier on an isolated port.
- The final production bundle passed **285/285** non-funded Opera/CDP checks.
- Every `1m`–`1M` switch opened on the complete candle-only overview plus future space, with the current candle visible and DPR-aware conflation diagnostics matching Lightweight Charts' factor calculation.
- Responsive resize preserved the same visible timestamps. The gate deliberately tolerates logical-index shifts from a concurrent infinite-history prepend and verifies the user-visible time window instead.
- Zoomed-in spacing resolves to conflation factor `1`; canonical OHLCV integrity, RVWAP/CVD rendering, `setData`/`update` lifecycle, and live forming-candle behavior remained valid.
- Final diagnostics reported one chart instance, zero rejected updates, and no runtime, resource, or recovery failures. No orders or funded actions were attempted.

### Default indicator and overlay-marker result — July 25, 2026 (historical; startup defaults superseded)

- The isolated clean-profile Opera/CDP gate passed **268/268** checks against production bundle `main-C2RRYZMG.js` after the normal 42/42 market-readiness barrier.
- Before any user toggle, that historical release loaded 30D RVWAP plus bands
  and Anchors line-only. The current July 30 contract instead starts Anchors
  line-only plus Monthly Volume Profile and leaves every RVWAP/band off.
- AVWAP origin-ring geometry and dotted Monthly Volume Profile POC rendering passed focused canvas assertions; the full browser gate retained one chart instance, zero rejected updates, and no runtime, resource, or recovery failures.
- The gate returns to the live edge without invoking explicit **Fit** before its resize assertion because Fit intentionally changes candle spacing to display all loaded history.
- The validation server/browser were shut down and the isolated profile, Vite cache, Vitest storage, and macOS metadata were removed.

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
