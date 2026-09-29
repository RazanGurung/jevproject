# Candle Warm-Up vs. Lazy-Only Loading — Design Rationale

*Written July 2026, after reviewing an overnight production log showing a self-healed
`429 x23` burst. Question under review: is the candle warm-up (warm coordinator + tiered
preload) worth its complexity and rate-limit risk over simple lazy loading — fetch whatever
chart/timeframe is selected, cache it? Verdict: **yes, keep it.** This doc records why, so
the question doesn't need re-derivation next time a 429 shows up in the log.*

## 1. The framing trap: "warm-up vs. lazy" is not the actual choice

The system is deliberately **hybrid**. A bounded pinned/liquid universe is
dependency-verified before functional HTTP admission, while liveness is
available during hydration and every market outside that startup set remains
lazy. The documented invariant ([ARCHITECTURE.md](ARCHITECTURE.md), *Server-side candle
store*) is that the chart currently being viewed always bypasses the background
warm-up queue:

1. `passthroughCandleSnapshot` (`cmd/server/main.go`) first tries the in-memory store
   (`ServeInfoRequest`) — a covered range serves in ~2 ms with `X-PEZ-Candle-Store: 1`.
2. On a miss (cold, off-list, degraded, or gapped series), the request falls straight
   through to Hyperliquid on a semaphore-bounded visible lane using a dedicated **25s**
   candle HTTP client (metadata probes keep the general 10s client). The price chart
   paints from that response regardless of warm state; the browser also retries
   transient 502/504/deadline on `/api/chart-candles`.
3. The passthrough response folds back into the store (`MergePassthrough`), and
   `warmSeriesFromBody` kicks a background, single-flighted, budget-paced `WarmOnDemand`
   that fills the series to its full lookback, registers its 5m/30m CVD dependencies,
   and wires live candle subscriptions subject to the cache-owned feed cap. Hard
   timeouts still schedule that warm so the next attempt can hit memory.

Steps 1–3 **are** "lazy load whatever is selected and store it in cache." That path is
~250–300 LOC and fully self-sufficient: if the warm coordinator were deleted, every chart
would still load. A never-warmed market can initially have exchange-head-truncated history
or directional-fallback CVD while chunked display/source history completes; the frontend
extends and refetches automatically. So the real question is narrower: *which markets must
be exact before admission, and which should pay that one-time lazy cost only if selected?*

## 2. What the warm-up layer actually is

Before listener admission, `SelectCoins` bounds the default-chart universe to
curated pins plus markets above `PEZ_CANDLE_PRELOAD_OI_MIN` (default $30M), capped
by `PEZ_CANDLE_PRELOAD_MAX_COINS` (default 60). The HTTP listener opens first so
`/healthz` answers during snapshot decode. **`/readyz` admit** runs
`EnsureChartUniverse` for the **default timeframe only** (`2h` + shared
`5m`/`30m` CVD sources) until those histories are **history-ready** (coverage to
`ReachableLookbackMs`, no unverified gap). Live-tail `degraded` does not block
admission: restored complete series need no REST. 30m 190d and 5m 20d exceed
Hyperliquid's 5000-candle cap (~104d / ~17d); ready, display-warm, and deepen
all clamp to that cap, so a restored cap-complete CVD source must not re-fetch
the universe after `/readyz`. Remaining `StartupTimeframes` (`1h`, `4h`, `15m`)
run as the warm coordinator's first post-admit display pass
(`PreferCoins` × `PreferIntervals`) after the gate opens. After restore the
store also **promotes lookbacks** to an extended post-admit target (default
`2h` toward Hyperliquid's ~5000-candle cap, `4h` to 600d) so extra snapshot
bars survive prune. The coordinator **display-warms** movers and watchlist
first (`WarmDisplay`), then deepens already-ready series. Restored
history-ready charts serve from memory instead of re-downloading the 190-day display window. This keeps the
landing chart memory-servable with anchored CVD while cold multi-TF work no
longer multiplies admit latency; lazy passthrough covers remainder misses.
Warm relaunch with a complete snapshot is mostly in-memory checks.

`internal/services/warmcoordinator/warmcoordinator.go` unions the clickable
ticker lists the UI actually shows — pinned markets ∪ top movers ∪ market-mispricing
candidates ∪ watchlist hints — and warms them in strict priority:

- **Tier 0** — the (coin, interval) series clients are viewing *right now*, re-checked
  between every bulk item, so a chart selected mid-pass at cold start jumps the queue.
- **Tier 1** — interactive chart timeframes (15m…1d), pinned coins fully first.
- **Tier 2** — non-blocking MISPRICE 1m session-close reference scheduling.
- **Tier 3** — cheap deep 1w/1M history for long-horizon charts.

After the initial pass it reconciles every 60 s, warming **only series still cold**, so it
tracks movers/mispricing/watchlist drift without re-fetching anything warm. All fetching is
paced by a shared token-bucket weight budget (`candlecache/budget.go`, default 800/min of
Hyperliquid's ~1200/min per-IP allowance) and serialized to **one background HTTP call at a
time** (`fetchSem`). Interactive passthroughs never wait on that budget — they charge it
non-blocking, driving it negative so background work yields to the user.

## 3. What warm-up buys that lazy-only cannot

### 3a. Features that have no click to lazy-load from

Lazy loading needs a user action per (coin, interval). One server/UI feature reads candles
across **many coins at once** with no such action:

- **Server-computed CVD deltas** — `cvdDelta` is computed from resident 5m/30m composite
  source series and spliced into snapshot responses and live WS ticks. Until those sources
  are warm, CVD falls back to the client's cruder per-bar delta.

- **MISPRICE close references** — candidate discovery is independent from candle
  availability, but each visible metric needs the Hyperliquid 1m close at a venue
  boundary. Missing `(coin, sessionCloseMs)` keys are scheduled after interactive
  chart warming and before deep history. The resolver is non-blocking, capped at
  three jobs, single-flighted per key, and uses the same budgeted one-call
  background HTTP lane. Endpoint polls can also nudge missing keys without waiting.

### 3b. History deeper than the displayed candle window

Rolling VWAP no longer derives from whichever display candles happen to be loaded. Its
deepest 90D bands need 495 days of deviation history before each plotted point; covering
the chart's initial 90-day viewport therefore needs about 585 days. A dedicated 4h source
is registered at 600 days (3,600 bars, below the 5,000-candle response cap), background
warmed and snapshot-persisted with the other series. The visible 4h chart remains a
190-day indicator-stable display requirement; an active-coin/accepted-watchlist `urgency: hydrate` probe
monotonically promotes the shared store series and either receives an immediate cache hit
or a non-blocking 202 while the server fills it. Browser preparation is active-first and
single-file, but a pending coin yields immediately after its store probe so all accepted
coins can join server-owned, serialized warming. Enabling any RVWAP acquires that one
source as a client-owned live dependency and first reuses the completed per-coin cache;
only a genuinely unfinished source needs the visible fallback through `/api/chart-candles`.
Manual scrollback can no longer change RVWAP values.

### 3c. Lower steady-state upstream pressure

Every warm series serves from memory and stays fresh via a permanent WS candle subscription
at zero REST weight (this is why the log shows `candles=343` reapplied for a single client —
that count is the warm universe, not the user). More warm coverage means fewer passthroughs,
which means fewer opportunities to hit the per-IP limit at all.

The shared upstream subscription budget can still shed a dormant permanent feed to make room
for an active client chart. A shed or rejected permanent feed marks its store series unavailable:
the next chart request bypasses memory and uses a fresh `candleSnapshot` response until a real
upstream candle tick proves the feed is live again. This deliberately favors correct recent bars
over a cache hit under capacity pressure.

Snapshot restore applies the same correctness rule to persisted history: it scans restored candle
timestamps for discontinuities. A same-bucket live tick validates only the current tail, not an
older stored hole, so a gapped series remains unavailable until a covering candle snapshot repairs
it. This prevents a restart from making a historical hole appear trustworthy.

## 4. What warm-up actually costs — and what it doesn't

### 4a. Code

| Layer | LOC | Survives warm-up deletion? |
|---|---|---|
| Warm coordinator (tiering/union/reconcile) | 233 | deleted |
| Preloader specs, coin selection, chunk orchestration | ~300 | mostly deleted |
| Snapshot persistence (v2 columnar + v1 read) | ~350 | deleted (exists to resume *warm*) |
| Preload-hint endpoint (watchlist tabs → warm set) | 94 | deleted |
| Store: merge, gap healing, degraded state, CVD, prune | ~1,000 | **stays** — the cache needs it |
| Weight budget + fetchSem | ~200 | **stays** — WarmOnDemand still paces on it |
| Lazy passthrough glue | ~300 | **stays** |

Roughly **750–900 LOC** of warm-specific orchestration would go — but the genuinely
intricate, bug-prone machinery (gap generation counters, degraded-vs-gap flag separation,
merge semantics, budget/penalize interplay) belongs to the **cache**, is exercised by the
lazy path too, and would all remain. Deleting warm-up removes surprisingly little risk.
The warm-specific code is also the *simple* kind: loops over lists in priority order.

### 4b. The 429 risk — mostly a misattribution

The instinct "warm-up causes the 429s" is contradicted by the project's own live testing,
recorded in ARCHITECTURE.md:

- The **dominant historical cause of 429 bursts was the lazy/interactive side**:
  uncoordinated concurrent passthroughs from adjacent-timeframe prefetch,
  CVD-alert background fetches, and up-to-3× client retries — enough *simultaneous* HTTP
  calls to trip Hyperliquid's burst limit from ordinary browsing. Re-testing after the
  budget-penalize fix shipped showed burst size unchanged — concurrency, not rate
  calibration, was the driver.
- The fixes were concurrency fixes: `fetchSem` (max **1** background fetch in flight),
  `candlePassthroughSem` (4), and a frontend background-lane circuit breaker.
- What remains attributable to warm-up is a **brief cold-start collision window**:
  interactive clicks during the initial warm pass can 429. This is tolerated by design and
  self-heals — a 429'd passthrough still kicks a budget-paced warm so the retry serves from
  memory; `PenalizeRateLimit` zeroes the token bucket the moment a real 429 is observed;
  the client auto-retries blank charts. And the disk snapshot
  (`data/candle-snapshot.json.gz`, restored on boot, healed via the WS-outage path) makes
  genuinely cold starts rare in the first place.

### 4c. Runtime footprint

The series set is bounded by idle eviction (added July 2026; before that, unbounded growth
was an accepted trade): the hourly prune pass also removes any series nothing has needed —
no chart serve, no warm, no warm-coordinator interest — for 7 days (`seriesIdleTTL`),
releasing its permanent WS subscription and dropping it from the snapshot, which the
save/load paths also filter so restarts can't resurrect stale coins. So memory, upstream
subscription count, and snapshot size all track the set of coins *actually in use over the
last week* (the warm union keeps itself alive via the reconcile's `Touch`), rather than
every coin ever clicked. The warm set still guarantees a floor of ~340 subscriptions —
that floor is the warm-up's cost; the eviction only removes what fell out of use.

## 5. Reading the log that prompted this review

The overnight log showed `429 x23` at 04:29 with the hint to lower
`PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN`. Forensics:

- The server had been up since 21:51 the prior evening — this was **not** a cold start.
- Overnight, the market WS dropped repeatedly (laptop sleep / network resets). Each outage
  gaps series; the store **correctly declines to serve** gapped or degraded data.
- At 04:29 the browser reconnected. Its chart loads found gapped series, fell through to
  passthrough, and — together with gap backfills — briefly collided with the per-IP limit.
- The burst self-healed in ~25 seconds (penalize + budget-paced backfill + client retry);
  snapshots resumed on schedule; no user-facing failure followed.

That is the designed degradation path working, and the traffic that hit the limit was the
**lazy** traffic. It is evidence *for* the current design, not against it.

## 6. The verdict

**Keep the bounded startup gate, background warm coordinator, and lazy off-list path.**

- Nothing breaks without it — but mispricing, CVD, multi-coin views, and first-click
  chart depth all degrade, and every one of those degradations converts free memory serves
  into REST traffic, **increasing** 429 exposure rather than reducing it.
- The complexity it would remove is the boring 40% of the subsystem; the intricate 60%
  (cache correctness) is needed by lazy loading regardless.
- Its 429 cost is bounded and paced at startup/background, while snapshot persistence
  prevents full historical re-downloads. The final July 17 restored-snapshot acceptance selected
  41 of 462 markets and reached readiness in 2m56s (then default-`2h` only). After
  expanding the readiness barrier to `StartupTimeframes` `2h/1h/4h/15m`, an
  August 3 live run selected 42 markets and reached readiness in **~9m22s** with
  liveness available throughout; the subsequent Opera/CDP smoke passed **293/293**.
  No illiquid-wide preload was performed.

## 7. If this comes up again: how to re-test empirically (zero code)

- **A/B kill switch:** run with `PEZ_CANDLE_PRELOAD=0` (disables all warming; the lazy path
  takes over completely). Browse pinned coins, the mispricing panel, and CVD-enabled charts
  for a session.
- **Compare on `/metrics`:**
  - `pez_candle_serve_total{source=store|passthrough|passthrough_error}` — the store/passthrough
    ratio should flip passthrough-heavy without warm-up.
  - `pez_upstream_rate_limited_total{type}` — the 429 slope under lazy-only load.
  - `pez_candle_budget_wait_seconds` — how long background fills sat blocked.
  - `pez_market_permanent_candle_feed_dropped_total` — permanent candle feeds that could not
    remain subscribed; chart reads for those series should temporarily shift to passthrough.
- **Tuning levers short of removal**, if the cold-start window ever bothers:
  `PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN` (default 800 — lower = more interactive headroom,
  slower warm), `PEZ_CANDLE_PRELOAD_MAX_COINS`, `PEZ_CANDLE_PRELOAD_OI_MIN`.

## 8. Key source locations

- Lazy passthrough + fold-back + on-demand warm: `cmd/server/main.go`
  (`passthroughCandleSnapshot`, `warmSeriesFromBody`)
- Warm coordinator (tiers, reconcile): `internal/services/warmcoordinator/warmcoordinator.go`
- Series specs, lookbacks, chunked fetch: `internal/infrastructure/candlecache/preloader.go`
- Store (serve/merge/gap/degraded/CVD): `internal/infrastructure/candlecache/store.go`
- Token-bucket budget (wait/charge/penalize): `internal/infrastructure/candlecache/budget.go`
- Snapshot persistence: `internal/infrastructure/candlecache/persist.go`
- Full narrative history of the 429 fixes: [ARCHITECTURE.md](ARCHITECTURE.md), *Server-side candle store*
