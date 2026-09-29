# Codebase Refactor Log

> Archived. Current docs: [../README.md](../README.md). Do not extend this file.

**Date:** June 4, 2026  
**Scope:** Senior-engineer cleanup + architecture audit of the frontend (`web/`), with a verified-only edit policy.  
**Goal (owner's words):** "simple dashboard with trading functions that need to be as fast as possible and stable… make this the best, clean and efficient codebase."

This log records everything done in this pass, the architecture verdict, and the exact remaining plan so it can be executed safely later.

---

## August 26, 2026 — shutdown hydrate teardown

Ctrl+C cancels leftover background candle hydrates. That is teardown, not a
failed repair. `weightBudget.wait` now honors the lifecycle context (no token
spend, interruptible refill sleep) and hydrate/warm/backfill stay quiet on
`context.Canceled`. Snapshot-on-close is unchanged.

Verification: `make test` + `go vet ./...` green; frontend **1059/1059**;
`make release` → `main-F2DUXGOT.js`; isolated Opera/CDP `chart_live_smoke`
**320/320**. Isolated SIGTERM saved 905 series with no `hydrate repair failed`
lines. Production snapshot hash `5e2e1959…` unchanged.

---

## August 25, 2026 — reachable lookback and leftover structure

`chartrequirements.ReachableLookbackMs` is the single retention clamp.
Ready, warm, hydrate, registration, and extended lookback all use it, so
cap-complete 5m/30m no longer REST after `/readyz`. Snapshot gzip clones
rows and shares the CVD coin-max idle clock with eviction. HIP-3
modify/cancel are the standard signed path with `mediumTimeout`. Reconnect
sleep is delay+30s; market keepalive wakes chart-only sessions; upstream
drop zeros the trading tick.

Verification: `make test` + `go vet ./...` green; frontend **1059/1059**;
`make release` → `main-F2DUXGOT.js`; isolated Opera/CDP `chart_live_smoke`
**320/320**.

---

## August 25, 2026 — per-anchor AVWAP bands and σ

Shared IND Bands/Width controls no longer apply to every manual anchored VWAP.
Each persisted anchor stores its own `bandsVisible` and `sigma` (default hidden
at 2σ). The Anchored VWAP card lists a row per anchor with neighboring Bands
and 1σ/2σ/3σ controls; hiding one set of bands leaves that center line and
every other anchor untouched. Legacy stored records without those fields load
as hidden/2σ. AppState no longer owns global AVWAP band/sigma fields.

Verification: frontend **1046/1046** (145 files); `make release` →
`main-IUGDNYHN.js`; isolated Opera/CDP `chart_live_smoke` **319/319**.

Selecting an origin marker now also shows the same Bands/σ controls in a
compact editor next to the marker so IND does not have to be reopened.

---

## August 18, 2026 — occupancy estimator logic

Month-open occupancy is now a single product kernel (state × soft auction ×
soft elapsed × recency) mixed toward the recency month-open climatology with
α = cESS/(cESS+10). Sequential auction overwrite is gone. HDI is computed on
the mixed measure. Evidence stays `unvalidated`.

Verification: focused projection + indicator + UI **49/49**.

---

## August 18, 2026 — occupancy-only month map

Dashed month-open and solid remaining-horizon lines are no longer drawn.
Elapsed month-to-date occupancy stays faint; remaining-horizon squares stay
at the MAP color. Path math is still computed for diagnostics.

Verification: focused projection + indicator + UI **48/48**;
`make web-build` → `main-YDDGO7WZ.js`.

---

## August 18, 2026 — finer MAP-colored occupancy

Occupancy grid is 80 bins × ~60 slices. Squares and both paths read the new
Colors-menu **MAP** swatch (`projection`), independently of AVWAP / RVWAP /
PROFILE, at profile-like box alpha. v1 `indicator` migrates onto `projection`
as well. Evidence stays `unvalidated`.

Verification: focused projection + palette **65/65**; frontend **1015/1015**
(141 files); `go test ./internal/preferences` and `go vet` green;
`make release` → `main-QED4HRVB.js`.

---

## August 18, 2026 — month-from-open occupancy map

Live Price Projection is again a month-from-open product. Origin is the last
close before the UTC month open for every profile month, including the live
month. A new in-month close keeps that origin and full-month horizon; it only
refreshes analogue weights (previous-month auction + elapsed-fraction match)
and the occupancy heatmap. Display model `month-open-map-v1` uses analogue-v2
OHLC/volume features on month-open candidates, running high/low excursions,
and a 16-bin occupancy grid. Thin libraries fall back to
`volatility-baseline-v1` at the same month-open origin. Evidence stays
`unvalidated`. Validation harness gained `--origin-mode month-open` without
touching the archived 5/10/20-day freeze.

Verification: focused projection **44/44**; frontend **1012/1012** (141 files);
`go vet ./...` green; `make release` → `main-COQPKQWT.js`. Isolated `:5002`
restore 1001/7.852s; `/readyz` 43/43 immediately. Snapshot BTC 2h/4h fans
are month-open-live with 12 occupancy slices. Opera/CDP unavailable. User
`:5001` left running; temps/caches cleared.

## August 18, 2026 — Lightweight Charts adapter edge hardening

Verified leftover adapter holes around LC 5.2.0 without replacing the
renderer. `syncSeries` now restores the visible logical range after every
`setData` (LC #1875), not only the forming-bucket reconciliation path.
History preload marks the 40k cap complete instead of refetching a chunk
that `slice(-40000)` would discard. A live append that evicts the oldest
bar rebuilds with `setData` and shifts the window by `-droppedCount`.
Theme refresh strips `handleScroll`/`handleScale` like `timeScale` and
re-asserts `releaseStuckChartGestures`. Signatures include last `o/h/l`.
Future-drawing intervals use the selected timeframe; production supplies
canonical last/prev times so pointer moves never call `series.data()`.
Projection fans return null from `autoscaleInfoProvider`. `createChart`
retries only on a layout-size change.

Verification: focused chart **130/130**; frontend **1009/1009** (141 files);
`go vet ./...` green; `make release` → `main-4GLTRWJU.js`. Isolated `:5002`
restore 1001/8.498s; `/readyz` 44/44 immediately. Opera/CDP second pass
**298** passed, **2** failed (known first 1h/2h overview remap). User
`:5001` left running; temps/caches cleared.

## August 17, 2026 — remaining-horizon live month fan

The last profile month is no longer a frozen start-of-month cone. Origin is
the last closed bar with `t < monthEnd`; horizon is the exact remaining
bars to the next UTC month open. HAR + auction weights refresh at that tip.
Width keeps the previous-month prior and blends MTD at
`α = 0.5 · elapsed`. Calibration gates stay month-class (4 origins) so a
shorter remaining span does not suddenly demand 16 blocks.

`sourceSignature` now samples prefix bars (`t < latestStart`) and live-month
closed bars. Growing the current month recomputes the live fan; historical
month objects stay identity-stable. Series count remains `5 × monthCount`.
Frontend **1002/1002**. Release `main-35ATVFE4.js`.

## August 17, 2026 — month-auction cone

`buildMonthAuctionStates` is one O(n) pass (MTD VWAP location, RV, volume,
signed vol, range). Baseline weights = recency × Gaussian similarity on
those five features. Median = state-conditional q50 × `cESS/(cESS+10)`.
q50 series is hidden until shrink is material. Falls back to recency-only
if auction reweight would fail ESS.

## August 17, 2026 — previous-month cone conditioning

`calendarMonthState` / `monthConditioning` / `blendHarWithMonthRv` feed the
baseline cone only (not week-path HAR). At the origin: mix previous-month RV
into live HAR (0.20), multiply width by clamped \(\sqrt{V/V_{\mathrm{trail}}}\),
tilt halves with semivariance. Median remains 0. Historical Z still uses the
plain 8/32/96 scale so calibration stays O(HAR).

## August 17, 2026 — faint historical 80%

Indicator now attaches `q10`/`q90` on every profile month. Historical outer
bands are dotted at alpha 0.16; the live month stays dashed at 0.48. Smoke
expects `seriesCount === 4 * monthCount`.

## August 17, 2026 — HAR quantile cone

`rawForecast` for `volatility-baseline-v1` no longer draws five terminal-rank
Z-paths. It takes recency-weighted quantiles of terminal \(Z(i,H)\) and
broadcasts them through live `harHorizonScale(t,h)`. That is the correct
zero-median FHS cone: early width follows \(\sigma\sqrt{h}\) (HAR), so the
first 1–2 weeks are a real fan instead of a `pinMedian` clamp to the origin.

`stepwiseWeightedQuantiles` remains for `analogue-volatility-v2` (120
neighbours). `coherentPathQuantiles` remains for `analogue-v1` and tests.

## August 17, 2026 — historical month-fan pairing

Verified live-chart errors after the UTC-month overlay: (1) 2h dropped
Mar–May profile months because `buildCalibration` failed `cESS` on earlier
origins and the month was skipped; (2) every completed fan shared
`monthEnd` with the next origin, so separate LC series still showed a
same-x vertical (18–23% on BTC 4h).

A valid origin `rawForecast` now always emits the month; missing calibration
uses `applyPathCalibration` with `coverageSamples: 0` (drawn λ = 1). After
the month list is known, completed paths pop points at/after `monthEnd`.
Look-ahead test covers the whole month object, not only `rawForecast`.

Frontend **995/995**. Release `main-CTNQ5HOP.js`. Isolated `:5002` served
BTC `2h`/`4h` at 6/6 profile months with 2h/4h seam gaps.

## August 17, 2026 — UTC-month projection + LC scroll/update audit

Price Projection is a UTC-month overlay (one fan per monthly-profile month,
frozen at month open). 5/10/20-day UI and validated-freeze inheritance are
gone. Evidence `unvalidated`. Each profile month is its own LC line series so fans cannot join with a
vertical at month handoff; historical months keep the 50% fan only; drawn λ
stays 1 until ≥10 prequential residuals. Completed fans are later clipped
off the next month open (see pairing follow-up above).

Post-admit candle depth: restore promotes lookback to the resident span so
prune cannot drop extra snapshot history; `PromoteExtendedLookbacks` raises
`2h`/`1h`/`15m` toward the HL 5000-candle cap and `4h` to 600d so the
coordinator keeps fetching older bars after `/readyz`. Chart history loader
continues walking older chunks after the first prepend.

Lightweight Charts 5.2.0 audit against official setData/update + logical-range
docs:

| Change | Why |
|--------|-----|
| Prepend shifts live fractional `getVisibleLogicalRange()` | Integer `viewStart`/`viewCount` snapped a partial-bar scroll |
| Deferred overview fit only if still on that overview | Indicator attach was yanking a user pan back to fit |
| Projection live-edge adds slack, not the full month path | Month fans zoomed a live-edge view out by hundreds of bars |
| Restore logical range after reconciliation `setData` | Conflation rejects `update(..., true)`; setData can jump (LC #1875) |
| Pan/zoom repositions labels only | Full series sync on every range event fought native scroll |
| `axisDoubleClickReset` restored with theme navigation | Unlock after Draw/AVWAP dropped the official double-click reset |

Verification (re-run August 17): Go + vet + focused race green; frontend
**989/989**. Release `main-AVDIL6XN.js`. Isolated `:5002` restore 990/6.707s;
`/readyz` after 44/44 `2h` in 1m2s; remainder TFs 0s. Opera/CDP first pass
293/7 (forming-candle + 504 transients); second pass **298** passed, **2**
failed (first 1h/2h overview diagnostic). Smoke stopped; temps/caches cleared.

## August 12, 2026 — DOM/Flow live-path correctness

Live-feed audit of the DOM ladder and Flow header. Core bookkeeping was sound
(independent ALL/WHALE latest-500 windows; session-persistent ladder VAP;
pair/epoch/render generation gates). Replay, unsubscribe, and paint races were
not, and the pump was fully decoding every `l2Book` snapshot.

| Change | Why |
|--------|-----|
| Live-key set on each rolling window | Arrival-order FIFO could forget a key still in the time-ordered 500 sample; a later replay double-counted it |
| Arm empty window on first trade-ref | `getOrCreate` after final unsubscribe resurrected a deleted cache from an in-flight frame |
| Annotate under the update lock | A concurrent clear could publish empty newer `_flow` for the batch that just inserted |
| Subscription-lived browser identities | 1,200-key eviction let a resent print re-enter session DOM volume |
| HUD: require current epoch unless `_flow` just applied; cancel clears pending flags | Stale cache could paint after reconnect; cancel swallowed the next schedule |
| Shared book+trade rAF | `renderDomLadder` ran twice in one interval |
| Typed envelope + raw `l2Book` relay; typed `allMids` + `ParseFloat` | Avoid full `map[string]interface{}` decode of large books |

Verification: `make test` + `go vet ./...` green; websocket `-race` green;
frontend **980/980** (141 files). `make release` → `main-EP3LLBLI.js` +
`styles-4A66HO2I.css`. Isolated `:5002` snapshot restore 810 series / 5.3s,
ready 45/45 immediately. Market-subscribe BTC/ETH/SOL `sampleCapacity:500`;
25s stream 40 `_flow` frames / 132 unique tids, monotonic revisions, reorder
no-op. Opera/CDP **296** passed; 5 failures were forming-candle projection /
same-bucket stability / transient candle 504s, not Flow. Smoke stopped;
temps/caches cleared. No funded action.

## August 12, 2026 — price projection full-accuracy harden + week-path freeze

- Indicator signatures sample first/Q1/mid/Q3/tip OHLCV (+ revision) for PP and
  2-week path overlays; mid-series repair recompute unit-tested.
- `scripts/week_path_projection_validation.mjs` added; both validation harnesses
  expand snapshot v2 columnar. Week-path freeze FAIL/unvalidated with report id
  pinned in `MODEL_EVIDENCE`. PP production evidence stays locked PASS; rolling
  recheck JSON kept for monitoring.
- Smoke asserts PP `validated-frozen-test` when ready. Frontend **992/992**;
  release `main-5H4X7AZH.js`.

## August 11, 2026 — startup / candle-cache load optimization

Warm-restart and admit path restructured for measurable load time:

- **History-ready vs live-unverified:** readiness and historical `ServeInfoRequest`
  no longer require `!degraded`. Live-edge still declines until tick/REST while
  degraded (WS outage / restore distrust).
- **Listener-first:** HTTP opens before snapshot decode; `/healthz` during restore.
- **Progressive admit:** `/readyz` = universe × default `2h`+CVD only;
  `EnsureChartUniverseRemainder` warms `1h/4h/15m` after the gate.
- **PrepareStartupUniverse** primes full startup TF deps before decode.
- **restoreCandles:** copy when sorted; skip map+sort merge on empty restore.
- **Snapshot v2 columnar:** write parallel `t/T/o/h/l/c/v/n` (no per-row `s`/`i`, no `cvdDelta`); load accepts v1+v2. Live migrate: 44→35MB gz, restore 8.2s→4.7s for 799 series.
- Live smoke `:5002`/`:5003`: warm admit after restore; charts serve.

## August 11, 2026 — drawing interaction factory thinned

Moved full shape painting into `drawing-render.js` (`drawShape`, square handles,
delete control, stroke/arrow helpers). `drawing-tools.js` overlay factory keeps
coords, hit-test, pointer lifecycle, and thin render wrappers (~1055 lines vs
~1350). Drawing tests green (62 + router 15).

## August 11, 2026 — chart-candle service physical ownership

Moved chart candle fetch/CVD self-heal/history/prefetch/L2 implementation into
`web/src/services/chart-candle-service.js` (~710 lines). `market-service.js` is
now a thin façade (~185 lines): pollers, reference data, CVD alerts, re-exports.
Call sites (`main`, `chart-render`, timeframe runtime) import candles from
`chart-candle-service` directly. Broke import cycle (chart-candle ↛ market-ui/dom-ladder
top-level; UI side-effects via dynamic import). Frontend **979/979** green.

## August 11, 2026 — final cleanup (plan closed)

- Removed remaining production **no-op mirror** calls from `coin-switch` and `main` (`syncMarketRuntimeMirrors` / `syncConnectionRuntimeMirrors`). `syncLegacyGlobals` kept only as privateKey strip on init.
- Drawing pure canvas helpers extracted to `drawing-render.js` (stroke/arrow markers); model + overlay factory remain split.
- `ARCHITECTURE_IMPROVEMENT_PLAN.md` marked **COMPLETE** — no open deferred/optional plan items.
- **Verification:** Go + frontend **979/979** green; `make release` → `main-FPBBM6YS.js`; live smoke `:5002` ready/index 200.

## August 11, 2026 — optional edits complete (WS runtimes, RVWAP/drawing model, window shrink)

Finished remaining optional items:

- **WS:** `runtime_feeds.go` embeds `DownstreamHub` + `MarketFeedRuntime` + `AccountFeedRuntime` in `WebSocketManager` (field access unchanged via promotion).
- **FE market:** RVWAP implementation extracted to `rvwap-source-service.js` (~415 lines); market-service is chart+pollers + re-exports (~866 lines).
- **Drawing:** `drawing-model.js` owns type counts, serialize/load/save; `drawing-tools.js` is overlay factory/render/interaction.
- **Window:** `createGroupedWindowBindings` omits pure `core` utils by default.
- **Verification:** Go `make test` green; frontend **979/979**; `make release` → `main-SSYEXZVS.js`. Live smoke `:5002`: ready, index 200, BTC 1h candles 72. Smoke stopped; temps cleaned.

## August 11, 2026 — deferred edits complete (WS interfaces, GetXyz collapse, FE paths)

Finished remaining items from the architecture improvement plan:

- **Exchange port:** removed `GetXyzPositions` / `GetXyzOpenOrders`; single `GetBuilderDexState` path (mock + AccountFetcher updated).
- **WebSocket manager:** `FillProcessor` + `BotEventHandler` interfaces (no concrete service types on order/bot hooks); `BroadcastMarket` / `BroadcastTrading` naming with legacy aliases.
- **FE:** `ui/async-prompt.js` (prompt/confirm out of trading-service); `research/price-projection.js` (+ chart re-export); import barrels `chart-candle-service.js`, `rvwap-source-service.js`, `market-pollers.js`; market-session + indicator UI use them.
- **Still optional later:** full WebSocketManager process split into three runtimes; drawing-tools model/render split; further `window` shrink; fully physical split of market-service.js body.
- **Verification:** Go `make test` green; frontend **978/978**; `make release` → `main-3U4SCTVS.js`. Live smoke `:5002`: ready, health ok, index 200, BTC 1h candles 168, bundle hash served. Smoke stopped; temps cleaned.

## August 11, 2026 — architecture improvement Phase 2 complete (backend gravity wells)

Follow-on to Phase 1 in the same improvement track:

- **`order_service_protection.go`**: TP/SL attach units, disk persist, fill/order update hooks, retry sweep, rekey — extracted from the place/cancel path so `order_service.go` is ~400 lines of order API.
- **`cmd/server` carve**: `proxy_info.go` (HL info proxy + cache), `chart_candles.go` (passthrough/hydrate/chart lanes), `session_key.go` (key + palette routes), `static_web.go` (dist serving). Composition root `main.go` ~800 lines.
- **`candlecache/cvd.go`**: composite CVD delta + WS annotate separated from residency/warm/gap in `store.go`.
- Backend still owns exchange, candles, CVD serve enrichment, protection; frontend remains renderer (Phase 1 market-session + dual-truth cleanup).
- **Verification:** `make test` all Go packages green; frontend **978/978**; `make release` → `main-K6XIPLK7.js`. Live smoke on `:5002` after hydration. WebSocketManager split and exchange `GetXyz*` port collapse remain Phase 3/later.

## August 11, 2026 — architecture improvement pass (backend-heavy / FE renderer)

Full audit remediation **Phase 1** (see `ARCHITECTURE_IMPROVEMENT_PLAN.md`):

- **Go venue single source:** `pkg/utils.IsBuilderPerpCoin` / `GetDexName`; `IsHip3Coin` is xyz category only. Adapter `resolveMarketVenue` and `isRuntimeBuilderPerpCoin` delegate to utils.
- **Rate-limit clarity:** `OrderPlacementBudget` renames/documents the local place throttle; process-wide HL weight stays in `hlratelimit` only. `main` constructs `NewOrderPlacementBudget`.
- **FE single connection truth:** `setConnectionState` / `getConnectionState` only touch `AppState.connection.tradingState` (removed dual module var).
- **FE single bookVersion:** only `runtime-mirrors`; market-ws increments via `incrementBookVersion`; removed no-op `syncMarketRuntimeMirrors` from stream hot paths.
- **FE venue helpers:** production `startsWith('xyz:')` routing forks replaced with `isBuilderPerpCoin` / `isHip3Coin` / `getDex`.
- **Market session controller:** `web/src/services/market-session.js` owns subscribe/candle/RVWAP intent; timeframe runtime + chart-indicator UI go through it; bootstrap `configureMarketSession` in `main.js`.
- **Deferred (Phase 2+):** carve `main.go`, extract `ProtectionService`, split `WebSocketManager`, peel CVD from candle store, shrink `window` ambient surface, pure trading APIs without DOM.
- **Verification:** `make test` all Go packages green; frontend **978/978** (142 files); `make release` → `main-K6XIPLK7.js`. Live non-funded smoke on `:5002`: ready after chart-universe hydration (~6m), health ok, index 200, chart-candles BTC 2h **360**, movers 20/30, bundle hash served. Opera/CDP `:9222` unavailable. Smoke server stopped; temps cleaned.

## August 10, 2026 — price-projection edge cases (per-side nest + BT vs drawn)

Closed residual shape/UX holes after the multiperiod + multiplicative pass:
**per-side nesting** so mid-path halves cannot exceed terminal; status line
labels BT as pre-ACI and surfaces `drawn×…` when ACI-lite moves chart factors;
removed artificial `[0.4, 2]` applied-factor hard cap (sanitize non-finite only);
frozen re-run **PASS** (`price-projection-walk-forward-1786425347395`,
C50≈0.547 / C80≈0.822). Focused projection/UI tests green; `make release`
rebuilds production bundle.

## August 10, 2026 — price-projection multiperiod HAR + multiplicative calibration

Coverage-first upgrade of the research overlay. Replaced pure local-constancy
`√(σ²·h)` with **multiperiod HAR** (mean-reverting cascade toward RV_long,
half-life 32 bars; `volModel: har-multiperiod-rv`). Replaced additive CQR
residuals (widen-only) with **multiplicative interval scale factors** `λ`
(shrink when raw fans over-cover, widen when under-cover), rolling residual
window 48, linear-interpolated quantiles, and intermediate path re-order around
the pinned median. ACI-lite on drawn paths is now symmetric (inflate/deflate).
Live≡offline still shared via `scorePrequentialForecasts` /
`applyPathCalibration`. Frozen walk-forward BTC/ETH/SOL day horizons **PASS**
all promotion gates (`price-projection-walk-forward-1786420177344`): C50≈0.535,
C80≈0.827; evidence **`validated-frozen-test`** (still research-only; zero-median
point forecast; not a trading-edge claim). UI status shows **Frozen-test OK**
when validated. Frontend **974/974**; Go packages + `go vet` green; `make release`
→ `main-SOZDNZ5A.js`; live `:5002` API + live-candle projection smoke ready on
BTC/ETH/SOL × 5/10/20d (Opera/CDP `:9222` unavailable this session).

## August 10, 2026 — price-projection live≡validation residual scoring

Follow-on to the same-day quant audit: offline validation no longer used a
terminal-only residual cousin of the chart path. Exported
`scorePrequentialForecasts` is the single prequential per-step scorer for
live `buildCalibration` diagnostics and `scripts/price_projection_validation.mjs`.
`applyPathCalibration` owns residual adjust + ACI-lite + ordered quantiles for
drawn paths. Promotion coverage stays pre-ACI so it matches UI BT50/BT80.
Reports now label vacuous identity gates for the zero-median baseline. Method
card gap policy is trailing-clean-segment only. Frozen re-run on BTC/ETH/SOL
(day horizons) at that checkpoint still failed C50/C80 before the multiperiod /
multiplicative pass (`price-projection-walk-forward-1786417469979`). Frontend
**974/974**; `make release` → `main-LUSOMMV4.js`; Opera/CDP smoke **299/299** on
`:5002`.

## August 10, 2026 — price-projection quant audit and evidence-gated model framework

The legacy analogue overlay passed its software invariants but failed the higher
standard implied by predictive quant use. A snapshot-wide 24-bar diagnostic found
that only 111/501 ready series beat zero-return MAE; median MAE was 3.9% worse
than zero and median Brier/coverage diagnostics showed weak discrimination and
over-wide bands. The live default is now a zero-median filtered-historical-
volatility baseline. A volatility-scaled, candidate-only robust-standardized
analogue and the exact legacy analogue remain predeclared comparison models.

Calibration origins are separated by the full horizon, overlap-adjusted `cESS`
joins Kish `wESS`, and diagnostics now include proper pinball/interval scores,
prevalence Brier and zero-return MAE skill, plus deterministic block-bootstrap
intervals. Public status separates calculation readiness from `unvalidated`
research evidence, and the UI says Research explicitly. The new frozen walk-
forward harness locks three trials, validation selection, promotion gates, and a
single test-period evaluation. The model card now documents the adverse findings,
revised math, and limits rather than treating unit-test success as model evidence.

A follow-on operator request replaced bar-count horizons and bar-count lookback
with calendar days: horizons **5 / 10 / 20** (default **5**), history
**90–1000 days** (60d floor on daily/weekly). Day spans map to exact bars for
the chart timeframe; non-aligned, sub-bar, or overly dense short-TF paths fail
closed with explicit reasons. Usability upgrades: trailing clean segment (older
gaps no longer discard the series), horizon-scaled calibration minima (20/16/12
origins), HAR-lite multi-scale RV scaling (8/32/96, precomputed), coherent
terminal-rank path quantiles, ACI-lite residual widen on coverage deficit,
full retained lookback for candidates, clearer unavailable copy, and projection
stroke color bound to the Colors AVWAP swatch. 
---

## August 9, 2026 — scientifically audited historical-analogue price projection

The chart now offers an opt-in empirical projection built only from confirmed
OHLCV history. It standardizes multi-scale momentum, volatility/range, candle
location, and relative-volume features; selects 60 embargoed nearest historical
analogues; weights them by distance and recency; and projects return quantiles
instead of presenting one deterministic target as fact. Rolling prequential
origins apply CQR-style residual widening to the empirical pointwise 50% and
80% bands without looking forward. Because overlapping market returns are a
dependent time series, this is backtest evidence and not a formal conformal
coverage guarantee.
Supported horizons are 3/6/12/24/36/60 bars, with 24 selected by default and the
overlay off at startup. The UI reports `Analog↑` (weighted historical terminal
frequency), analogue count, `wESS` (weight concentration), and terminal-horizon
`BT50`/`BT80` rolling-origin coverage or an explicit unavailable state. These
diagnostics are deliberately not labelled as calibrated probabilities or
independent sample counts. The complete equations, provenance, assumptions, and
evidence limits are in [PRICE_PROJECTION_METHOD.md](../PRICE_PROJECTION_METHOD.md).

Five native Lightweight Charts line series own the median and two interval pairs.
They consume the shared closed-candle view, recompute only after a confirmed close
or authoritative repair, and detach without mutating candles, other indicators,
strategies, backend state, or APIs. The longer 60-bar option exposed a deferred
indicator/time-scale ordering edge in the complete-history browser matrix: after
a coin/timeframe reset, the chart now performs the requested fit again when
serialized long-history indicator work has settled. Manual pan/zoom remains
untouched during ordinary updates.

The smoke harness was migrated from removed `window.current*` mirrors to the
supported `getChartDebugState().selection` contract and now asserts projection
startup, 24/60-bar attach, five-series ownership, diagnostics, future extent,
no-repaint behavior, and detach. Verification passed **966/966** frontend tests
across **142** files, focused projection/model/UI **16/16**, all Go packages,
`go vet ./...`, and `make release`. Rebuilt `main-EZLQT7QI.js` passed the isolated
non-funded Opera/CDP gate **299/299** after 46/46 readiness. Final health and
ready were true, market WS and the 259-topic Bybit feed were ready, and chart
diagnostics reported zero rejected updates or runtime/resource failures. No
signing key, wallet, order, or funded action was used. The server/browser stopped
cleanly and the isolated browser profile plus Vite test cache were removed.

---

## August 9, 2026 — RVWAP warm-data hydration and bounded startup depth

The visible 4h startup dependency no longer inherits RVWAP's 600-day depth: it
uses the normal 175-day chart window, while the optional rolling source promotes
the shared store series only when an active/watchlist hydration request needs it.
Store lookbacks now promote monotonically, so a restored legacy 175-day series
cannot cause pruning to discard a later 600-day fill. Promotion includes one
source bucket of overlap; the live smoke caught and the regression suite now
pins the exact-clock edge where an asynchronous warm beginning milliseconds
after an exact 600-day request otherwise left that request perpetually outside
coverage.

`urgency: hydrate` is a store-only `/api/chart-candles` lane: safe data returns
200, while a miss returns 202 after starting or joining the budgeted full/tail
repair and never consumes foreground passthrough capacity. The browser prepares
the active coin first and then the backend's exact accepted watchlist identities
(50 maximum), moves on after each pending probe, caches active + watchlist
sources, stages concurrent live 4h rows over late snapshots, and keeps completed
data visible during revalidation. Exact `acceptedCoins` also fixes validation/cap
holes where an accepted count could point at the wrong watchlist prefix.

The supplied pre-edit run reached 45/45 readiness in **7m51s** and needed another
**5m54s** warm-coordinator pass. The rebuilt live run restored 928 series in
9.1s, reached **46/46 in 6m07s** (1m44 faster with one extra market), and the
coordinator completed in **0s**. Health, upstream market WS, and the 259-topic
Bybit feed were ready; preload-hint returned the exact `[BTC, XMR]` subset from
`[BTC, XMR, FAKECOIN]`; hydrate misses returned 202 without any passthrough or
rate-limit metric. The smoke server shut down cleanly and saved all 928 series.

Verification: focused hydration/frontend coverage **92/92**, complete frontend
**946/946 across 137 files**, all Go packages, reconnect ref-count race cases,
and `go vet ./...` pass. The production bundle and ad-hoc-signed server were
rebuilt; no funded action was attempted.

---

## August 7, 2026 — chart pan unlock after reconnect (hardened)

Operator report: after market-stream reconnect (and sometimes lid-wake), the chart could not be panned/zoomed until a full reload. Root cause was not the subscription thrash fix: Draw tools and manual AVWAP set Lightweight Charts `handleScroll`/`handleScale` to `false` while armed or dragging; a transport recycle can drop `pointerup`, leaving navigation locked. Re-enable used boolean `true` (weaker than theme objects) and drawing tools could no-op re-enable when another overlay had flipped scroll.

| Change | Why |
|--------|-----|
| `chart-navigation.js` full enable objects | Match theme-shaped LC options |
| `releaseStuckGestures` on Draw router + AVWAP | Clear stuck drag state |
| `releaseStuckChartGestures` | Single recovery entry |
| Call sites: market open, tab resume, series recreate, pointercancel, visibility, pageshow, blur | Cover sleep/reconnect/OS gesture paths |
| Keep lock only for armed Draw / AVWAP placement | Orphaned `isDragging` must not block restore |
| Scroll intent survives null chart; re-assert on attach | Series recreate mid-gesture |
| Always re-apply enable (no early-return) | AVWAP vs Draw flag desync |

### Full verification

- `make test` all Go packages; `go vet ./...`; focused `-race` green
- Frontend **939/939** (137 files) including edge-case pan tests
- `make release` → `main-T322GLN2.js` + codesigned server
- Live non-funded smoke on `:5002` (~5m14s ready): health/readyz/metrics, index, coin-meta, 24h-changes (340), chart-candles BTC/ETH/`xyz:GOLD`, market-subscribe + WS stream, movers, mispricing, l2, cvd-scan, dist nav options
- CDP browser matrix skipped (no `:9222`); funded actions not performed
- Smoke process stopped; vite/vitest/tmp caches cleared

---

## August 7, 2026 — elegance pass: reconnect subscription thrash

Long-running console (multiple away/sleep cycles) showed healthy recovery but repeated `market subscription applied` churn on every reconnect (`tradeCoins` 58→32→58 within ~1s). No functional failure; pure ref-count waste.

| Change | Why |
|--------|-----|
| Grace-delayed pending restore (500ms) + skip when client already has intent | Healthy re-subscribe POST wins; lost-POST path still restores |
| `schedulePendingMarketSubscription` returns completion `<-chan struct{}` | Race-safe test sync; no lock-free reads of ref maps mid-apply |
| Movers fire `pez:tracked-coins-changed` only on membership change | Rank-only re-poll no longer POSTs market-subscribe every 60s |
| 250ms debounce on background market re-subscribe | Coalesce reconnect + movers + watchlist bursts |
| Order-insensitive subscription key + intent equality | Re-order ≠ new warm set |
| `subscribeMarket(coin, interval)` no longer defaults `tradeCoins=[]` | Avoid active-only collapse footgun |
| Precompiled account-address regex in `cmd/server` | Hot-path micro-elegance |

### Follow-up verification (same day)

- `make test` — all Go packages green
- `go vet ./...` green
- `go test -race` on websocket / services / cmd/server / exchange green (initial race on scheduled-pending tests fixed by completion channel + locked asserts)
- Frontend **933/933** across **135** files
- `make release` → `web/dist/main-7JLLMA7M.js` + ad-hoc codesigned `hyperliquid-server`
- Cleared `web/node_modules/.vite`, Vitest localStorage temps, orphaned `/tmp/pez-*`, Finder metadata; kept `vendor/`, `web/node_modules`, `web/dist`, `data/candle-snapshot.json.gz`, binary

No structural rewrite. Funded validation and Opera/CDP not run.

---

## August 6, 2026 — protection re-key, account clone, serverRuntime

Verified deep-research residuals and implemented Phase 1–2 only (no speculative ports or Stage 3 `window.*` deletion):

| Change | Why |
|--------|-----|
| Early modify re-key + old→new fill alias | Shrink documented TP/SL orphan window; order-update cancels must not clear replacement protection |
| Structured `clonePayload` | Remove JSON marshal/unmarshal from every account cache Get/Set |
| `serverRuntime` in `cmd/server` | One composition-root holder for helper-facing process deps |

Verification: `go test ./...`, focused `-race`, frontend 924/924, `make release` (`main-CAVDJOQQ.js`), live non-funded API+WS smoke. Deferred: application ports for handlers, `hlratelimit` ports, Stage 3 strategy decoupling.

---

## August 6, 2026 — dead-code pass

Full pass with `deadcode`/`staticcheck` (Go) + export/call-site audit (JS).

**Removed (proven unused in production):**

- Go: legacy X-per-coin RSS (`fetchXFeedItems` + helpers), `MarketDataService.GetMidPrice`, `getCached24hChanges`, `series.serveSlice`, `wireRoundToDecimals`, `roundPriceToTickSize`, `applyClientMarketSubscriptions` wrapper, `ParseFloatFromString`/`NormalizeKey`/`OrderSide`/`UnrealizedPnl`/`RoundToSignificantFigures`
- JS: `debounce`/`throttle`/`retry`, unused `fmt`, un-exported api-resolver internals, store `getState` + never-called `suppressOrderCoin` path

**Kept deliberately:** testutil mocks, signing/test goldens, `SessionFor` registry API, strategy/`window.*` bridges, bulk AppState dual-write mirrors (Stage 3), documented external HTTP APIs without UI buttons, large live modules.

Post-pass: `deadcode -test=true` clean; Go + frontend 924/924 green.

---

## August 4, 2026 — xyz-only HIP-3 market loading

Hyperliquid lists many builder/HIP-3 dexs via `perpDexs`. Product policy is
now explicit: **only the `xyz` HIP-3 dex is loaded as markets.** Standard
(main) perps are unchanged.

Choke points:

| Layer | Change |
|-------|--------|
| `GetBuilderDexes` | Filters discovery to `xyz` only (no `para`/`vntl`/`mkts` fanout) |
| Preload meta | Loads default + `xyz` meta only → `/api/coin-meta` |
| Market WS | `SetBuilderDexes` keeps only `xyz` allMids |
| Mispricing | Registry/fixture/audit script drop non-xyz instruments |
| Coin dropdowns | `isLoadableMarketCoin` — standard perps + `xyz:*` |
| Watchlist | Strips/rejects non-xyz builder keys from storage |

Verification: `go vet` + all Go packages; frontend **907/907 across 133
files**; `make release` → `main-XQHCIMRT.js` + codesigned server. Live
non-funded smoke on `:5001`: ready after chart hydration, coin-meta
`337`/`105` xyz/`0` other builder, mispricing `dexes=['xyz']`, charts for
BTC + `xyz:NVDA` + `xyz:GOLD`, shed total `0`. Ephemeral test/cache
artifacts cleared after the run.

---

## August 1, 2026 — Race-safe immediate Flow switching

The subscription endpoint already returned useful Flow snapshots, but the
browser only copied them into per-coin state. It did not schedule the active
Flow renderer, so a hydrated pair could remain visually stale until another
trade arrived. Pair switching also treated every retained cache as equally
fresh and overlapping A→B→A requests could apply out of order.

Flow cache values now have separate `{marketEpoch, revision}` ownership. A real
ticker switch cancels queued Flow/DOM frames and synchronously selects either a
connected, backend-accepted cache from the current downstream socket epoch or
an explicit `WARM 0/500` slice. Reconnect increments the epoch without deleting
cache values. Subscription requests carry generation tokens, their accepted
snapshots repaint the active Flow within one frame, and older generations are
ignored without disturbing the current dedupe state. The Go relay adds a
manager-wide monotonic numeric `revision` to both `_flow` and `flowSnapshots`;
same-epoch lower revisions cannot overwrite fresher trades-frame state.

Focused frontend coverage passes 70/70 and pins synchronous clearing, accepted
current-epoch reuse, disconnected/unaccepted/old-epoch fallback, hydration
repaint, revision rejection, superseded response rejection, queued-frame
cancellation, and reconnect invalidation. The clean-profile acceptance candidate
passed 883/883 frontend tests across 131 files; normal and race-enabled Go suites
plus `go vet ./...` passed. Its isolated non-funded Opera/CDP gate served
`main-CYJZD3HK.js` and measured warm
switches at 3.3–4.3ms, rapid BTC→ETH→BTC at 2.9–3.2ms, and unaccepted SOL clear
plus hydration at 0ms/153ms. Multiple BTC/ETH/SOL revisions remained monotonic;
no runtime/resource error, new rate limit, shed, queue drop, wallet, or signed
action occurred.

A final follow-through made duplicate downstream connections with the same
`clientId` one logical client and gave final-unsubscribe Flow cleanup a newer
empty tombstone revision. This added one frontend regression. The current suite
passes 884/884 across 131 files, focused WebSocket race coverage passes, and
`make release` produces the signed `main-J352OPBK.js` candidate. The supplied
operator session ran that candidate for more than nine hours and recovered
normal upstream expiries, TCP resets, and browser-stream rotations without a
dropped subscription.

Final verification added a backend regression for a movers-list rank reorder
with unchanged membership: book/trade reference counts stay at one and retained
Flow is byte-for-byte unchanged. All Go packages, `go vet ./...`, the complete
WebSocket race suite, and 884/884 frontend tests pass. A fresh `make release`
reproduced `main-J352OPBK.js` and the existing signed-server hashes exactly;
signature verification passed. The hygiene pass removed only generated Vitest
local-storage databases and Finder metadata, preserving all maintained tests.

## August 1, 2026 — Latest-500 DOM flow, warm pair hydration, and direct scale zoom

The DOM had three coupled usability problems: FLOW was cumulative for an arbitrarily long subscription session, retained trades permanently widened the automatic ladder, and a pair selected outside the currently warm set waited for both flow and book state. The UI also described different whale thresholds in different places. This made the view harder to interpret for trading and made switching pairs feel slower than the actual transport.

The backend now owns one bounded, timestamp-ordered 500-print sample per coin. Insertion handles out-of-order batches, eviction subtracts exact regular/whale totals, all valid prints contribute to FLOW, and one $100k boundary owns the WHALE subset plus DOM marker classification. Trades `_flow` and market-subscribe `flowSnapshots` expose sample count/capacity/timestamps. The browser remains a renderer: its recent list and DOM activity queue use the same 500 cap, replay identity retention is 1,200 keys, and zero coverage renders an explicit WARM state.

The desired market set is ordered active → watchlist → visible movers. Accepted background pairs keep trades and books warm; the subscription response hydrates flow immediately, cached books restore synchronously, and a selection-guarded L2 REST snapshot covers only a cold book that has not arrived within 250ms. Admission/shedding remains backend-owned.

Automatic DOM grouping now fits the nearest ten live levels on the 1-2-5 sequence with a stable ×5 floor and no dependence on historical trade extremes. Direct price-spine drag adds a session-only per-pair bias (up=in, down=out); double-click resets AUTO. Normal click-to-limit behavior is retained. Volume-at-price and whale markers are exact rolling projections, not session artifacts. Chart CVD was deliberately outside this change.

Verification: 875/875 frontend tests across 303 suites, all Go packages, `go vet`, and the full Go race suite passed. `make release` produced `main-DPPGAOHC.js`. The isolated non-funded Opera/CDP gate served that hash, observed populated BTC/ETH/SOL rolling samples, measured flow+DOM readiness at 11ms/34ms/8ms, and passed real drag, per-pair memory, and double-click AUTO reset with no runtime/resource errors, rate limits, queue drops, or subscription shedding.

## July 31, 2026 conflation-safe chart reconciliation follow-through

A long-running operator session found a chart boundary the release smoke had
not exercised: the display-only live-price projection could append the next
bucket before Hyperliquid delivered the final prior-bucket revision. The chart
then used Lightweight Charts' historical `update(..., true)` option, but 5.2
rejects historical updates whenever conflation is enabled because its reduction
pipeline requires ordered data.

The boundary now replaces the native series from the ordered canonical candle
array with `setData()`. The existing price path immediately reprojects the
current bucket; routine exchange replaces/appends remain `update()` calls, and
no synthesized data enters application state, caches, indicators, or APIs. A
new `reconciliationSetDataCount` diagnostic distinguishes this recovery from
incremental updates, and the browser gate treats `[chart] series.update()
failed` as a release failure. A conflation-strict regression pins canonical
final OHLC plus subsequent projection restoration.

All Go packages, `go vet ./...`, and 871/871 frontend tests across 131 files
passed. `make release` produced `main-E2ZRX66D.js` and the rebuilt signed server.
The isolated non-funded Opera/CDP matrix passed 293/293 with one chart instance,
zero rejected updates, no chart-update warning, no runtime/resource/recovery or
upstream failure, and no signed action. Startup restored 966 temporary snapshot
series, reached 38/38 readiness in 4m50s, and shutdown checkpointed 967 series;
health was ready/OK with 1,184 cached prices and 74 upstream subscriptions.

## July 31, 2026 independent lead-engineer follow-through

The full repository audit found one execution defect and several release and
reproducibility weaknesses, all now resolved without a structural rewrite:

- standard market IOC orders preserve `reduceOnly` instead of forcing it off;
  regression tests inspect the signed wire action for both boolean values
- the macOS launcher performs a full release build, tracks and validates its
  child PID, and refuses to terminate an unrelated process occupying its port
- `make deps-verify` now proves `vendor/` is exactly reproducible, while npm is
  locked to the official registry with exact compatible tooling and a direct
  `esbuild` declaration; full and production audits both report zero findings
- high-frequency subscribe/preload control requests retain protection and
  metrics but are excluded from the mutating-route audit log

Verification passed all Go packages, focused race tests, vet, 871/871 frontend
tests across 131 files, a production release rebuild, code-sign validation, and
the 292/292 non-funded live browser matrix. Startup reached 38/38 readiness in
2m20s, live metrics showed zero subscription shedding and signed actions, and
shutdown plus temporary-file cleanup completed normally.

---

## 1. Headline verdict

**The codebase is already clean and correctly architected for a fast, stable trading terminal — it is *not* over-engineered against Hyperliquid.** One real piece of structural debt remains (the legacy `window.*` bridge), but it is **load-bearing and functional**, and removing it is unsafe to do blind. See §5.

This matches the project's own governance in `../README.md` / `../ARCHITECTURE.md`: *the remaining `window.*` surface is compatibility only; do not start another structural cleanup wave without a concrete bug/feature/hotspot, and do not deeply refactor legacy/compat code without browser/runtime coverage.*

---

## 2. Verified changes shipped this pass

Every edit below was validated with `node --check` (syntax) **and** an offline unit-test harness (see §4), kept green at **113 passing / 0 failing** across the 34 mock-free test files, and re-confirmed on disk after writing.

| File | Change | Rationale |
|------|--------|-----------|
| `web/src/utils/format.js` | Merged three near-identical volume formatters into one shared `compactVolume(n)`; `fmtVol` keeps the null/NaN guard, `fmtVolAlways = fmtVol`. **Deleted dead `fmtVolFixed`** (exported, never imported). | Single source of truth for volume formatting; remove dead export. |
| `web/src/state/market-candles.js` | Removed dead internal `isOneMinuteCandle()` (defined, never referenced). | Dead code. |
| `web/src/ui/ticket-transitions.js` | Removed dead `reconcileSideChangePreview()` (no imports, no refs, no test, not window-bound; logic is a superseded subset of `reconcileOrderTypePreview`). | Dead, redundant code. |

### Earlier safe cleanup in the same effort
- Deleted dead `web/src/state/constants.js` and `web/src/state/ui-selectors.js`.
- Relocated a stray test to `web/src/bootstrap/__tests__/app-runtime-delegation.test.js`.
- Removed a stray `.DS_Store`.

### Whole-frontend dead-code scan result
- Across **all** `web/src/*.js`, exactly **one** fully-dead export existed (the `reconcileSideChangePreview` above). It was removed.
- A dead-internal-function detector across the 17 harness-covered modules found **none** remaining.
- Conclusion: the frontend is already lean. The prior cleanup wave noted in `../PROJECT_STATUS.md` did its job.

---

## 3. Latent correctness finding — `toNumber` is NOT a duplicate (do not auto-merge)

There are six `toNumber()` definitions. They *look* redundant but implement **three different behaviors**, so mechanically merging them would silently change risk/sizing/signal math:

| Modules | Implementation | `"12px"` | `""` | `true` | `"1,000"` |
|---------|----------------|--------|------|--------|-----------|
| `state/account-state.js`, `services/trading-service-helpers.js` | `Number(value)` | `0` | `0` | `1` | `0` |
| `services/risk-engine.js`, `services/account-metrics.js`, `services/fill-actions.js` | `parseFloat(value)` | `12` | `0` | `0` | `1` |
| `services/signal-engine.js` | typed guard + `parseFloat` | `12` | `0` | `0` | `1` |

**Recommendation:** decide the intended numeric-coercion semantics deliberately (likely the `parseFloat` family for exchange string fields), unify behind one shared helper, then run the full local suite. This is an owner decision, not a mechanical cleanup. Left untouched in this pass.

Similar note: `sleep` (×4) and `clamp` (×3) **are** behaviorally identical and could be consolidated into `utils/helpers.js`, but they live in trading-critical files outside the offline-verifiable set, so they were left for a verified pass (low value, non-zero risk).

---

## 4. Offline test harness (how the above was verified)

The real toolchain can't boot in this environment (`node_modules` were installed on macOS; the Linux sandbox is missing `@rollup/rollup-linux-x64-gnu` / `esbuild` native binaries, and there is no network). To still verify edits, a dependency-free harness was built:

- `vitest-shim.mjs` — implements `describe/it/expect` + the matcher subset the tests use (incl. asymmetric matchers, `resolves`/`rejects`, `vi.fn` tracking).
- `run-one.mjs` — per-file isolated runner; honors `/** @vitest-environment jsdom */`, resolves `jsdom` from the project, polyfills RAF/ResizeObserver/matchMedia.
- A loader using `realpathSync` to avoid `/data` symlink module-identity splits.

**Verifiable subset:** 34 test files that do **not** use `vi.mock` / fake timers / module resets / spies (those need real Vitest). Baseline and post-change: **113 passing / 0 failing**.

**Not offline-verifiable (require local `npm run test:run` + `go test ./...`):** the ~65 mock/timer-based JS tests and the entire Go backend.

---

## 5. The one real debt: the legacy `window.*` bridge

### What it is
~1,000 lines whose only job is keeping a **second copy** of state on `window` so a set of **classic (non-module) scripts** can interoperate with the modern ES-module store:

- Bridge code at the time of this June audit included `state/legacy-globals.js`, `state/runtime-mirrors.js`, `bootstrap/window-state.js`, `chart/chart-legacy-adapter.js`, and `services/runtime-compat.js`. The chart adapter was removed in the July 14 chart consolidation; see `../ARCHITECTURE.md` for the current owners.
- **121** `window.x =` mirror writes (`currentPrice` ×23, `currentCoin` ×21, `bookData`, `accountState`, …).
- ~~Classic scripts that depend on it (loaded in `index.html`): `bot.js` + 12 `strategies/*.js`.~~ **As of June 7, 2026 (Stages 1–2) there are no classic scripts left** — all 13 are ES modules under `web/src/`. The mirror writes remain because the now-modular strategies still read state/each other via `window.*`; converting those reads to imports/selectors and deleting the mirrors is Stage 3.

### Why it's not over-engineering against Hyperliquid
- Orders/cancels/scale/TWAP all delegate to the Go backend (`/api/order`, `/api/bulk-orders`, `/api/bulk-cancel`, `/api/scale-preview`). The browser holds **no key** (`getManagedExchangePrivateKey()` returns the `'__AUTO__'` sentinel) and signs nothing. Correct, lean design.
- Client-side HL rules (`getHyperliquidPriceDecimals`, tick/lot rounding, min-size) are legitimate instant-feedback UX; the backend + exchange remain the enforcers. Routing these through the backend would add latency and *hurt* speed/stability — explicitly not done.

### Why it is NOT safe to remove blind
The bridge is consumed through **multiple implicit contracts**, not direct calls:
- `state/strategy-host.js` resolves bot/host functions from `window` by name (`refreshBotStatus`, `applyBotStatus`, `loadBotStrategy`, `updateTotals`, `onAccountStreamConnectionStateChange`).
- `services/runtime-compat.js` → `applyBotStatusBridge()` is called by `streams/account-stream-ui.js`.
- Bot functions are invoked via the host bridge / action delegation, **not** inline `onclick` (0 inline bot handlers in `index.html`).
- The strategy modules still interoperate through `window.*` (e.g. `window.StrategyManager`, `window.StrategyHelpers`, `window.BaseStrategy`), resolved by name rather than imported, so the mirror writes cannot be deleted until those reads are converted to imports/selectors (Stage 3).

None of this is executable-testable in the offline sandbox (no browser, and the relevant tests use mocks). Per the project's own rule, deep refactors here require browser/runtime coverage.

---

## 6. Staged migration plan (execute with verification between stages)

Eliminating the bridge is worthwhile but must be staged, each stage gated by local `npm run test:run` + a funded/live bot smoke test (`../LIVE_VALIDATION_RUNBOOK.md`).

**Stage 1 — Port `bot.js` → ES module** ✅ DONE (June 7, 2026) — shipped as `web/src/services/bot.js`
- Reads canonical state via imports instead of `window`: `AppState.trading.currentPrice/currentCoin`, `AppState.account.state`, `getApiKey()` and `getExchangeLeverage()` from `state/account-selectors.js`, `getAccountStreamSocket()` from `streams/account-stream.js`, `resolveApiUrl`/`getApiToken` from `services/api.js`. The bot's inward `window.*` reads are now zero.
- Still exposes the bot's ~24 outward functions on `window` (`botStart`, `applyBotStatus`, `loadBotStrategy`, `BOT`, …) — the host bridge + 12 classic strategy scripts resolve them by name.
- `main.js` imports `initBotUI` and calls it during bootstrap (before `init()`); removed `<script src="/bot.js?v=13">` from `index.html`; deleted `web/bot.js`; removed its `Dockerfile` COPY line.
- Also removed the now-dead `window.__pezApi` exposure in `services/api.js` (its only consumer was the classic `bot.js`).
- Verified: `bot-lifecycle.test.js` updated to the module + `AppState`; full local suite green (104 files / 498 tests). **Live bot arm/place/cancel validation still pending** — not release-ready until run per `../LIVE_VALIDATION_RUNBOOK.md`.

**Stage 2 — Migrate `strategies/*.js` classic scripts to modules** ✅ DONE (June 7, 2026) — all 12 moved to `web/src/strategies/`
- All 12 scripts (`chart-layers`, `price-feed`, `strategy-helper-calculations`, `strategy-helper-support`, `helpers`, `strategy-context`, `base-strategy`, `strategy-manager`, `strategy-switcher`, `exit-manager`, `rvwap-bollinger-short`, `rvwap-bollinger`) are now ES modules, side-effect-imported from `main.js` in dependency order. All classic `<script>` tags and the empty `web/strategies/` dir are gone; the `Dockerfile` `web/strategies` COPY was dropped (they ship via `web/src`).
- **Stage 2 was deliberately module-ification only, not decoupling.** The `window.*` wiring is preserved exactly: each module still publishes its global (`window.ChartLayers`, `window.StrategyManager`, …) and still reads siblings/app state via `window`. Sibling load order is now guaranteed by imports instead of the old `setTimeout(arguments.callee, …)` polling guards (removed — `arguments.callee` is illegal in module strict mode; the manager + rvwap auto-inits were rewritten to named functions). `helpers.js` imports its two split owners directly.
- Verified: existing helper/price-feed tests repointed to the new paths; added `module-wiring.test.js` smoke test (loads the whole chain, asserts globals publish + both strategies register); full local suite green. **Live strategy deploy/execution validation still pending** for each strategy — not release-ready until run per `../LIVE_VALIDATION_RUNBOOK.md`.

**Stage 3 — Decouple from `window.*` (IN PROGRESS, June 7, 2026) — original "delete the bridge" plan is outdated and partly unsafe**

Investigation while starting Stage 3 found two things that invalidate the original framing:

1. **The bridge files were load-bearing app infrastructure, not mechanically deletable compat shims.** The non-chart bridges remain scoped infrastructure. The July 14 chart consolidation later removed `chart-legacy-adapter.js` only after the canvas renderer and its consumers were eliminated together.
2. **`strategy-host.js`'s `window.*`-by-name resolution is an intentional, tested indirection** (`strategy-host.test.js` asserts `getChartService() === window.ChartLayers`), letting the app inject any chart/manager implementation. Removing it reduces a deliberate seam and breaks its contract test.

Done so far:
- `base-strategy.js` now reads `AppState.trading.currentPrice/currentCoin` directly instead of the `window.*` mirrors — it was the last strategy code reading those app-state mirrors. They are now read only by test scaffolding (`test-utils/canonical-state.js`).

Re-scoped remainder (each gated on `../LIVE_VALIDATION_RUNBOOK.md`, since the strategy execution path has no automated coverage):
- ~~Optionally convert the remaining sibling-strategy `window.*` reads to imports.~~ **Slice A DONE (August 6, 2026):** RVWAP long/short, strategy-manager, and strategy-switcher use ES imports for siblings; `window.X =` publishes kept for host bridge. Removed setTimeout load-order polls. `module-wiring.test.js` asserts import identity === window publish + registry.
- ~~Slice B (inject module refs into strategy-host).~~ **Slice B DONE (August 6, 2026):** `setStrategyHostDeps` injects ChartLayers/PriceFeed/StrategyManager/StrategyHelpers after strategy load and bot surface after `initBotUI`. Getters prefer injected refs, fall back to `window` for tests. `strategy-host.test.js` covers both paths.
- ~~Slice C (prune write-only AppState mirrors).~~ **Slice C DONE (August 6, 2026):** store/trading-runtime/chart-session/legacy-globals/runtime-mirrors no longer dual-write app state onto `window.*`. `setLegacy` writes AppState only. Host keeps `switchCoin` / `syncMobileChartActionBar` / `chartCanvas`. HTML `data-action` → `window` stays.

**Do not skip the gates.** A silent state-sync regression here places real orders incorrectly. Live strategy arm/place remains operator-gated.

---

## 7. Verification posture for this pass

| Item | Status |
|------|--------|
| Edited files syntax (`node --check`) | ✅ all pass |
| Whole-frontend `node --check` | ✅ all `src/*.js` parse |
| Offline harness (34 mock-free files) | ✅ 113 passed / 0 failed |
| Full `npm run test:run` (99 files / 450 tests) | ⏳ run locally |
| `go test ./...` | ⏳ run locally (no Go toolchain offline) |
| Live/funded bot validation | ⏳ run locally before release |

The shipped edits are limited to dead-code removal and a behavior-preserving formatter consolidation, all inside the harness-covered set — low risk — but the project's standing rule still applies: run the full local suite before treating anything as release-ready.

---

## 8. Helper consolidation pass (DRY, behavior-preserving)

Duplicated leaf utilities were collapsed into the existing pure leaf module `web/src/utils/helpers.js` (imports nothing, so no import cycles are possible).

| Helper | Removed from | Routed to |
|--------|-------------|-----------|
| `sleep` | `services/api.js`, `services/account-service.js`, `services/trading-service-order-api.js` | `helpers.sleep` (byte-identical bodies) |
| `clamp` | `services/signal-engine.js`, `services/deploy-config.js` | `helpers.clamp` (identical for all `min <= max`; every call site verified to use valid bounds) |
| `toNumber` (parseFloat family) | `services/risk-engine.js`, `services/account-metrics.js`, `services/fill-actions.js`, `services/signal-engine.js` | new canonical `helpers.toNumber` |

**New canonical helper added:** `helpers.toNumber(value)` — `parseFloat` + finite guard, collapsing non-numeric / `NaN` / `±Infinity` to `0`. A dedicated function (not `safeParseFloat`, which deliberately lets `±Infinity` pass through). The typed-guard variant formerly in `signal-engine.js` was proven equivalent for every input class (number, `NaN`, `±Infinity`, `"12px"`) before removal.

**Intentionally NOT merged:** the `Number()`-based `toNumber` in `state/account-state.js` and `services/trading-service-helpers.js`. `Number()` and `parseFloat` diverge on real inputs (`Number("12px") -> NaN -> 0` vs `parseFloat("12px") -> 12`); these are trading-critical and stay local. A `// NOTE:` comment now documents the deliberate divergence at both sites so a future cleanup doesn't "fix" it.

**Verification:** `node --check` passes on all 11 touched files; whole-frontend syntax sweep clean; offline mock-free harness unchanged at green (no regression vs. pre-pass run); `grep` confirms zero orphan local definitions remain and exactly one `helpers.js` import per consumer.

---

## 9. Packaging requirement (chart runtime dependency) — superseded July 14, 2026

The runtime `/vendor/lightweight-charts/...` import described by the original
June entry was removed. Lightweight Charts is now an exact-pinned static npm
import compiled into the normal web bundle. Release artifacts should include
the built `web/dist` assets; they no longer need to ship `web/node_modules` or
expose a runtime chart-library route. See `DEPENDENCIES.md`.


---

## §10 — UI feature: collapsible Trading windows + full-universe coin browser

_Added as a product feature (not a refactor). Frontend-only; backend untouched._

### 10.1 Trading windows toggle (mirrors Market Radar)
The **Order Entry** ticket (`.order-panel`) and the **Positions / Orders** bottom panel (`.bottom-panel`) are now hidden by default and shown only when chosen — exactly like the Market Radar.

- **Always visible:** the Chart and the Order Flow tape (`.book-panel`). The chart expands to fill the freed vertical space when trading windows are hidden.
- **Toggle button:** `#tradingToggleBtn` ("Trade Off" / "Trade On") sits next to the Radar toggle in the chart panel header (`data-action="toggleTradingPanel"`).
- **State:** `AppState.ui.tradingPanelVisible` (default `false`); the `#mainLayout` element carries a `trading-hidden` class (added to the initial markup, so it is hidden on first paint).
- **Mechanism:** `toggleTradingPanel()` / `setTradingPanelState()` in `web/src/render/ui-state.js` flip the class, update the button, and call `scheduleChartRender()` so the chart resizes. CSS in `web/styles.css` reflows the grid for all four radar×trading combinations (and the toggle button is hidden on mobile, where the panels always show).
- **Wiring:** registered through the standard delegated-action path — `ui-state.js` export → `main.js` import + delegation maps → `app-bindings.js` action list → `app-runtime.js` action map.

### 10.2 Category coin dropdowns (full lists per category)
The single "OTHER ▼" dropdown was replaced by **five separate category dropdowns**, each generated dynamically from the live universe and showing the **complete list** for its category:

- **Categories:** **Crypto** (all native perps), and the `xyz:` synthetics split into **Indices**, **Commodities**, **Stocks**, and **FX**. Each is its own trigger button in the tab bar.
- **Source of truth:** `Object.keys(AppState.market.allMids)` (the global `allMids` stream carries every tradable perp, including `xyz:` synthetics), merged with coin metadata so lists are complete even before mids arrive.
- **Classification:** `classifyCoin(coin)` — non-`xyz` → Crypto; `xyz:` symbols mapped via `XYZ_CATEGORY` (indices/commodities/fx) with **unknown `xyz:` symbols defaulting to Stocks** (the majority of HIP-3 equity listings). New listings therefore appear automatically without code changes.
- **Full lists incl. core:** unlike the old dropdown, the category lists are complete — they include the core members (e.g. GOLD/SILVER show under Commodities, SP500/NAS100 under Indices) so each category is genuinely exhaustive. The fixed core tabs remain as quick-access shortcuts.
- **Display:** each dropdown renders the full category list (no search box) as a compact **multi-column grid** sized to fit the window (`max-height: min(70vh, 560px)` with internal scroll only when a category is very long). The top ticker bar now **wraps** instead of overflowing horizontally, so all core tabs + category buttons stay visible.
- **Implementation:** `COIN_CATEGORIES`, `XYZ_CATEGORY`, `classifyCoin()`, `getAllPerpCoins()`, `getCoinsForCategory()`, `renderCoinDropdown(category)`, `toggleCoinDropdown(category)` in `web/src/ui/controls.js`; a single shared `#coinDropdown` surface is re-rendered and re-positioned under whichever category trigger was clicked (`control-surface.js` tracks the active category via `data-category`). Items reuse the existing `data-action="switchCoin"` delegation, so selection behavior is unchanged.

### 10.3 Verification
- `node --check` passes on all six modified JS modules.
- Offline harness (safe subset): **113 passed / 0 failed**; `coin-switch` DOM suite **7/0**.
- `controls` / `signal-radar` / `wiring-stress` use `vi.mock`, which the offline harness shim does not implement — run these with `npm run test:run` locally.
- **Local UI smoke test (browser-only):** confirm the chart + Order Flow stay visible, "Trade Off/On" reveals/hides Order Entry + Positions, and "OTHER ▼" lists the full universe grouped + searchable.

## 11. Order-path hardening (bug fix + test coverage)

### 11.1 Fixed: missing imports in `strategy-execution.js`
`web/src/state/strategy-execution.js` referenced four symbols it never imported:
`requestBulkCancel`, `hlPost`, `getCurrentCoin`, and `isHip3Coin`. The module still
*loaded* (the symbols are only used inside function bodies / a default parameter), and
`installStrategyExecutionBridge()` happily stored the function references on
`window.PezStrategyExecution` at startup — so the bug was invisible until one of the
bridged functions was actually invoked:

- `cancelOrdersByIds()` → `ReferenceError` (default param `coin = getCurrentCoin()`, then `requestBulkCancel`).
- `fetchStrategyCandles()` → `ReferenceError` (`getCurrentCoin`, `isHip3Coin`, `hlPost`).
- `placeBulkOrders()` / `placeSingleOrder()` were unaffected (they only use the already-imported `apiPost`).

**Fix:** added the four imports from their canonical sources —
`hlPost` from `../services/api.js`, `requestBulkCancel` from `../services/order-cancel.js`,
`getCurrentCoin` from `./trading-selectors.js`, `isHip3Coin` from `../utils/helpers.js`.
No circular dependency is introduced (none of those modules import `strategy-execution.js`),
and all four are already loaded elsewhere at app startup.

### 11.2 New test coverage for previously-untested order-path state
Two safety-critical modules had **zero** automated coverage; both now have harness-runnable suites (no `vi.mock`, so they run in the offline harness *and* local Vitest):

- `web/src/state/__tests__/strategy-execution.test.js` (**10 cases**) — `extractOrderIds` across all response shapes, plus regression tests that the bridge functions resolve through their no-key guard instead of throwing `ReferenceError`. These tests fail against the pre-fix code, so the missing-import regression is now locked out.
- `web/src/services/__tests__/trading-service-order-api-pure.test.js` (**12 cases**) — transient-failure detection (`isTransientLimitFailure`), order-confirmation parsing, accepted-order lock extraction/de-dup, and API error formatting (the existing mock-based suite covers retry/network behavior).
- `web/src/services/__tests__/order-cancel-normalize.test.js` (**4 cases**) — cancel-payload normalization and building cancels from open orders (oid coercion + invalid-entry filtering).
- `web/src/state/__tests__/account-state-orders.test.js` (**16 cases**) — order-oid/locked-order normalization, backend-order batch filtering, the locked-order lifecycle (register/clear/clear-by-coin/merge), and the removal + reconciliation grace window that keeps freshly-cancelled orders from reappearing from a stale exchange snapshot.

### 11.3 Verification
- `node --check` passes on `strategy-execution.js`.
- Offline harness (safe subset, regenerated): **155 passed / 0 failed** (was 113; +42 new across 4 files, 0 regressions).
- `vi.mock`-based suites (`controls`, `signal-radar`, `wiring-stress`, and the existing mock-based order-api/scale suites) still require local `npm run test:run`.

---

## 12. Full local verification on real hardware (June 4, 2026)

The owner ran the complete suite on macOS (after a clean `rm -rf node_modules package-lock.json && npm install`, which fixed the npm optional-dependency bug for the platform Rollup/esbuild binaries).

### 12.1 Go backend — PASS
`go test ./... -count=1`: all packages with tests passed (`internal/handlers/websocket`, `internal/infrastructure/exchange`, `internal/middleware`, `internal/services`, `pkg/utils`); remaining packages have no test files. This is the half that could not be exercised from the offline sandbox — now verified green.

### 12.2 Frontend Vitest — 490 passed / 2 failed, both fixed
The full local run booted (103 files, 492 tests) and surfaced two failures, both legitimately addressed:

1. **`src/chart/__tests__/cvd.test.js` — unresolved import `oakscriptjs`.** The test cross-checks `cvd.js` against the vendored `vendor/lightweight-charts-indicators/dist/index.mjs`, which imports `oakscriptjs`. That package (`0.2.7`, a PineScript-compatible TA library) was never declared in `package.json`; it only survived in stale `node_modules`, so the clean reinstall correctly dropped it. The **runtime app never imports the vendor lib** (cvd.js reimplements the delta logic; the only reference is a doc comment), so `oakscriptjs` was added to **devDependencies**. After `npm install` it resolves and the suite is green.
2. **`src/ui/__tests__/controls.test.js` — `dropdown.style.position` `''` vs `'fixed'`.** Stale test: its DOM used the pre-redesign single "OTHER ▼" trigger with no `data-arg`. The shipped category-dropdown design resolves the trigger per category via `[data-action="toggleCoinDropdown"][data-arg="<cat>"]`, so `positionCoinDropdown` couldn't find a trigger and early-returned. Updated the test trigger to a category button (`data-arg="crypto"`) matching production `index.html`. Production behavior was never broken.

The stderr noise (`Fetch candles error`, `subscribeMarket` / `Invalid URL: /api/market-subscribe`) is expected: those exercise error-handling paths against relative URLs with no backend in jsdom; the assertions still pass.

### 12.3 Status after fixes
- Go: green on real hardware.
- Frontend: 2/2 real failures resolved; expected full green on the next `npm install && npm run test:run`.
- Offline harness safe-subset remains **155 passed / 0 failed**.

## §13 — Coin dropdown classification fix (round 2)

Follow-up to §11/§12 spot-ticker work. Two remaining defects reported from the live Crypto dropdown:

1. **`#NNNN` pseudo-tickers leaking into Crypto** (e.g. `#1000`, `#1001`, `#1581`). These are Hyperliquid builder-perp asset IDs surfaced in `allMids`, distinct from the `@<index>` spot pseudo-tickers handled previously. The old filter `/^@\d+$/` only caught `@N`.
   - Fix: broadened to `NUMERIC_PSEUDO_TICKER = /^[@#]\d+$/` in `web/src/ui/controls.js` (`getAllPerpCoins`), excluding both `@<index>` and `#<index>` unnamed numeric entries.

2. **Crypto appearing in the Stocks dropdown.** `classifyCoin` routed *any* `:`-prefixed coin to the synthetic buckets, defaulting unknowns to `stocks`. Crypto perps on non-`xyz` builder dexs (e.g. `vntl:BTC`) therefore wrongly landed in Stocks.
   - Fix: `classifyCoin` now treats a coin as a synthetic ONLY when `isHip3Coin(coin)` is true (i.e. the `xyz:` prefix). Native perps and all other builder-dex perps classify as `crypto`. Within `xyz:`, the curated `XYZ_CATEGORY` map still routes indices/commodities/FX, defaulting unknown xyz listings to `stocks` (xyz is an equities dex).
   - Added `isHip3Coin` to the helpers import in controls.js.

Verification: `node --check` OK; regex excludes `@1`/`@107`/`#1000`/`#1581` and keeps `BTC`/`0G`/`2Z`/`xyz:GOLD`/`@btc`/`PEPE@1`; classifier trace confirms `vntl:BTC`/`dex2:HYPE`→crypto and `xyz:*`→correct buckets; harness safe-subset 155/0 (38 files) unchanged.

## §14 — Root-cause fix: dex-qualified coin metadata keys (Crypto vs Stocks)

The §13 frontend tweak was treating a symptom. True root cause is in the **backend preloader**.

### Diagnosis
`internal/infrastructure/preload/preload.go::loadMetaUniverse(dex)` iterates each dex's `meta.universe` and cached metadata under the entry's **bare `name`**. Hyperliquid returns BARE symbols (`GOLD`, `SP500`, `NVDA`, `AAPL`…) for EVERY dex — including the `xyz` synthetics dex — so the `"<dex>:"` qualifier was discarded. Result:
- `/api/coin-meta` `szDecimals`/`maxLeverage` keys contained bare stock symbols indistinguishable from native crypto perps.
- The UI classifies Crypto vs Stocks/Indices/Commodities/FX by the `xyz:` prefix (`isHip3Coin`), so bare `GOLD`/`NVDA` fell into **Crypto** → "stocks and crypto mixed up."
- The same assets also stream into `allMids` as `xyz:GOLD` (prefixed), so the two sources disagreed on key format → duplicates / buried real crypto → "not all crypto perps in dropdown."
- Bonus: tick-size & leverage lookups (`GetTickSize('xyz:GOLD')`, `getMaxLeverage('xyz:GOLD')`) missed the bare-keyed cache entries.

`TrackedCoins` is empty, so the full multi-dex universe is loaded — nothing was being filtered out; it was purely mis-keyed.

### Fix (backend, single source of truth)
In `loadMetaUniverse`, store metadata under the **canonical dex-qualified key**: bare for the default perp dex (`dex == ""` → crypto), `"<dex>:<name>"` for builder dexs (e.g. `xyz:GOLD`). This matches the form the frontend, `COIN_TO_TAB_ID`, order routing, and tick/leverage lookups already expect, so the cache and the live `allMids` feed finally agree.

Safety: `preload.GetAssetIndex` (the only consumer of the bare-keyed asset-index map) is dead code; the real HIP-3 asset-index resolver in `hyperliquid.go` compares via `stripDexPrefix(...)`, so it tolerates either format. No order-routing change.

The §13 frontend classifier (`isHip3Coin`-based) is now CORRECT once it receives properly prefixed names; the `@<n>`/`#<n>` numeric-pseudo-ticker filter stays.

### Verification
- preload.go edit reviewed: balanced, no new imports, valid Go (Go toolchain not present in sandbox — user runs `go build ./...` + `go test ./...` on macOS).
- Frontend harness safe-subset 155/0 (38 files) unchanged.
- Expected runtime: Crypto dropdown = native perps only (no `xyz:`/`#`/`@`); xyz synthetics route to Stocks/Indices/Commodities/FX by symbol.

## §15 — Trading-wiring audit: modify oid churn, HIP-3 chart stability, SL classification

User-visible symptoms: BTC chart drags stable, but xyz (HIP-3) TP/SL boxes flickered, drags ghosted/snapped back, and stop-loss lines had no drag box at all.

### Diagnosis
1. **SL drag box missing (all venues):** the chart label overlay deliberately hides trigger orders without a classified `tpsl` (`chart-line-labels.js syncOrderLabels`). The classifier `inferOrderTpsl` matched only "stop loss"/"sl" — Hyperliquid's actual SL `orderType` is **"Stop Market"** — so SL classified as `''` and was filtered. TP ("Take Profit Market") matched, hence TP-only boxes.
2. **xyz flicker/ghosting:** a Hyperliquid modify is cancel+replace — the resting order returns under a NEW oid. Standard perps reconcile in milliseconds via upstream `orderUpdates`; builder-dex coverage in the user stream is slow/partial, so after an xyz drag the UI held the stale old-oid order until the next REST refresh tore down and rebuilt labels (flicker, "order no longer open" drags, perceived slowness).
3. **xyz snapshot wipes:** upstream `webData3` snapshots intermittently omit still-resting builder-dex orders (same root cause as the known HIP-3 position flicker). `UpdateOrdersFromSnapshot` replaced the runtime order list wholesale, so an omission wiped xyz orders → boxes vanished until the next REST reseed.
4. **Latent:** pending TP/SL protection is keyed by oid — a modify of a protected resting order orphaned its protection.

### Fix
- `inferOrderTpsl` matches standalone `stop` (after take-profit) — "Stop Market"/"Stop Limit" → `sl`.
- Modify now returns the exchange-assigned replacement oid end-to-end: adapter (`newOidFromSDKStatus`/`newOidFromRawStatuses`) → service (`registerModifiedOrders` marks old oid removed, registers new, re-keys protection via `rekeyProtection`, publishes old-terminal + new-open updates) → handler (`{"status":"ok","oid":<new>}`, bulk `"oids"`) → frontend (`resolveReplacementOid` suppresses old oid, re-keys locked order). No dependence on upstream event latency.
- `UpdateOrdersFromUpstreamSnapshot` (used only for webData2/3-sourced snapshots) preserves known `xyz:` orders absent from the incoming snapshot unless explicitly removed; REST `frontendOpenOrders` snapshots remain authoritative.
- `isRetryableInfoError` now treats deadline/timeout/conn-reset as transient so `GetOpenOrders` serves its cache through upstream latency blips.

### Verification
`go build/vet/test ./...` green; frontend vitest green (incl. new tests: SL "Stop Market" classification, oid re-key on modify, upstream xyz-order preservation, protection re-keying); bundle rebuilt.

## §16 — DOM ladder price-scale determinism, DEEP/1m-overlay retirement, trade-pipeline consolidation (July 4–5, 2026)

User-visible symptom: SOL DOM at ×10 grouping flip-flopped between row steps, so the ladder's visible price range spread and shrank randomly; price labels mixed decimal precisions per view.

### Diagnosis
1. **Spacing flip-flop:** grid spacing was inferred from the *median gap between adjacent book levels*, snapped to tick multiples `[1,2,5,10,25,…]`. SOL's real granularity at ~$150 is 0.01 (Hyperliquid 5-sig-fig pricing) but the measured gap oscillated 0.01↔0.02 with book density — and with no `20` in the snap table, 0.02 snapped to **0.025**. Base spacing flipped 0.01↔0.025 (×10 view: 0.1↔0.25), each flip resetting the center/mid anchors and re-bucketing the ladder.
2. **Decimal instability:** row labels went through `fmtPrice`'s trailing-zero trimming (mixed `3000`/`3000.1` columns) and could round off-grid prices misleadingly (150.125 → "150.13"); `idx * spacing` float noise leaked into `dataset.arg`.
3. **Parallel trade pipelines (audit):** the DOM ladder and the TRADES/FLOW panels were independent re-implementations over the same WS trades feed — each batch parsed 3× (`ingestTrades`, `ingestDomTrades`, `hasLargeTrade`), deduped by two separate structures with the byte-identical `time:px:sz:side` key; six per-coin caches (`tradeCache`/`largeTradeCache`/`flowCache`/`whaleFlowCache`/dom activity/seen-keys, plus the ladder's `spacingByCoin`) were never pruned, accreting an entry for every coin the signal radar ever streamed; the ladder re-bucketed the full book + 512-price activity map every frame, including trade-only ticks and 150ms fade repaints. (Server audit for the same concern found **no** DOM↔chart storage overlap: the Go server is a pure relay for l2Book/trades — only candles are stored, bounded by 7d idle TTL + hourly prune.)

### Fix
- `computeGridSpacing` derives the base from the **effective tick at mid** via `getHyperliquidPriceDecimals` (floored at the nominal tick), deterministic in price alone; the sticky `SPACING_HOLD_MS` hold now only damps decade crossings; the median-gap snap (+`20` multiple) survives as a metadata-missing fallback. Labels are fixed-decimal per view (`spacingDecimals`), row prices noise-stripped via `toPrecision(12)`.
- Retired with the DOM ladder now covering them: the `drawOrderBook` 1m-chart overlay + its `orderBookChart` state slice (store/market-state/render-model/mirrors/window-state/chart-state) and the DEEP button + `depthBoost` state (`controls.js`, delegation wiring, store setters, dead `render/ui-state.js` duplicates, CSS). The limit-preview depth DEEP also fed is frozen at its old default (×4 → book level 19) in `ui/tabs-preview.js`.
- Trade ingestion single-passed: `normalizeTradeBatch` (`state/market-trades.js`) parses and dedupes once (persistent per-coin `tradeSeenKeys` FIFO, 400 keys); `ingestTrades`/`ingestDomTrades`/`hasLargeTrade` consume normalized entries. Coin switches call `pruneMarketCoinCaches` + `pruneSpacingCache` with the subscribed set (active ∪ tracked ∪ watchlist). Ladder bucketing memoized: book buckets on the book object's identity, activity buckets on `domActivityVersion` (bumped only when ingest changes the map). Thresholds consolidated (`WHALE_NOTIONAL`/`LARGE_TRADE_MIN_NOTIONAL` in `market-trades.js`); dead `MAX_CACHE_PER_COIN` removed from `store.js`.

### Verification
Frontend vitest green (121 files / 735 tests, incl. new regression tests: spacing immune to book-density oscillation, decade-crossing hold, ×10 uniform-decimal exact-step labels, cross-batch dedupe, coin-switch prune keep-set, memoization contract); bundle rebuilt (`npm run build`); manual SOL ×10 pass — ladder holds a steady 0.1 step through book churn.

## §17 — DOM taker-fade speed, sticky whale dot, header last-whale readout retired (July 6, 2026)

User-visible symptom: the DOM ladder's grey "trade just printed here" background fade was too slow and read as laggy once price got volatile.

### Diagnosis
The fade is a linear `1 - age/ttl` alpha (`render/dom-ladder.js`), but `HIGHLIGHT_TTL_MS` (`state/dom-ladder-state.js`) was fixed at 4000ms — doubled to 8000ms whenever a print was whale-sized (`vol.flashNotional >= WHALE_NOTIONAL`) — much slower than the price action causing the flash, so tinted rows stayed lit well past the moment that made them light up.

### Fix
Agreed with the user as a combined pass, since it also resolved a redundant display surface:
1. **Faster, uniform flash:** `HIGHLIGHT_TTL_MS` 4000 → 1200, and dropped the whale-based TTL doubling in `render/dom-ladder.js` — the grey flash is now one fast, uniform tint regardless of print size; the "how big / which side" signal moved to the whale dot instead.
2. **Sticky, dominant-whale dot:** the existing whale marker (`.dom-whale`, previously a fixed 3px neutral-grey circle with a two-stage fade — bright for `WHALE_MARK_TTL_MS` 60s, then a faint session-persistent `WHALE_DOT_SESSION_OPACITY` 0.25) no longer decays over time at all. It now shows the row's **dominant** (single largest) print once it clears the whale threshold (`vol.maxPrintNotional >= WHALE_NOTIONAL`), sized via `tradeIntensity(maxPrintNotional)` and colored by `maxPrintSide` (buy/sell, reusing the ladder's own side colors) — data the state already tracked but previously surfaced only in the row tooltip. `fadeFallbackDelay` simplified to depend only on the grey flash (single-arg signature) since the dot no longer needs a timer-driven repaint cadence.
3. **Header last-whale readout retired:** since the dot now durably shows "biggest whale trade here," `renderLargeTrades()` (→ `#domLastWhale`) became redundant. Removed the function, the `<span id="domLastWhale">` element, and its ~10 call sites across `main.js`, `bootstrap/app-runtime.js`, `bootstrap/app-bindings.js`, `services/coin-switch.js`, `services/tab-resume.js`, `render/scheduler.js` (unused import), and `render/ui-state.js` (a dead `largeTrades` tab branch with no corresponding tab button). The header's FLOW split bar (`#domFlowBar`, the row's only `flex:1` child) automatically fills the freed width — no CSS changes needed.

### Verification
Frontend vitest green (122 files / 744 tests): `dom-ladder.test.js` rewritten for the flat TTL and sticky/sized/colored dot; `trades-header.test.js`'s last-whale suite deleted (its FLOW-strip suite kept); the ~8 other test files referencing `renderLargeTrades`/`domLastWhale` updated. One test-isolation bug surfaced and was fixed along the way: a new dot-color test reused prices from an earlier test in the same file, and since whale data is intentionally session-persistent (never reset), it inherited stale state from the earlier test's opposite-side print at the same price — fixed by using untouched prices. Bundle rebuilt (`npm run build`).

## §18 — Whale dot side-based positioning + continuous size/opacity ramp (July 7, 2026)

User request: sell whale dots should sit on the right side of the DOM row (mirroring the header flow strip's buy-left/sell-right), and the whale dot visual range should be wider — minimum trades at the $10k threshold should be small+dim, maximum trades at $500k+ should be large+bright.

### Diagnosis
All whale dots were positioned at `left:1px` regardless of side, with fixed `opacity: '0.9'` and a narrow size range (`3 + tradeIntensity * 6` = 3.5–9px, saturating at $100k). The user wanted the dots to follow the same buy-left/sell-right convention as the header's `domFlowBuy`/`domFlowSell` columns, and a more expressive visual ramp that doesn't saturate until much larger prints.

### Fix
1. **Position buy/sell on opposing edges:** buy dots set `left:1px; right:''`; sell dots set `right:1px; left:''`. The default template removed `left:1px` so the inline style is fully dynamic.
2. **New `whaleIntensity` function** scales with `sqrt(val / 500000)` instead of `tradeIntensity`'s `sqrt(val / 100000)`, so the visual ramp continues to $500k before saturating:
   - Dot diameter: `3 + intensity * 12` (range ~4.7px at $10k → 15px at $500k+)
   - Opacity: `0.2 + intensity * 0.7` (range ~30% at $10k → 90% at $500k+)

### Verification
All 27 DOM ladder tests pass, including updated opacity assertions (0.32 for $15k, 0.54 for $120k), side-position checks (left for buys, right for sells), and size comparisons. `make release` shipped (frontend + Go binary rebuilt).

## §19 — Whale dots moved inside the price span, flank price text (July 9, 2026)

Visual refinement: whale dots previously lived as a separate absolutely-positioned `<u>` element (`root.children[3]`) spanning the full row width — buy dots at the row's left edge, sell dots at the row's right edge — overlapping the depth and volume bar columns. Moved the `.dom-whale` element inside the `.dom-price` span (`root.children[1].children[0]`) with `position:relative` on the price span, so the dots now sit at the left/right edges of the price column in the gap space between the price text and the colored depth/volume bars. Row element mapping updated: `whale: root.children[1].children[0]`, `price: root.children[1].children[1]`.

## §21 — Unified whale footprints, recent flow, and response (July 12, 2026)

The dot and flow paths previously disagreed: dots qualified at $10k, backend whale flow at $250k, combined flow overlapped whale bias, the advertised three-minute half-life was actually a time constant, and field-only frontend dedupe could collapse distinct identical-looking prints. Flow now uses non-overlapping $1k–$9,999 regular and ≥$10k whale tiers, with ≥$250k retained as a major visual tier; decay is a true three-minute half-life and `_flow` publishes its timestamp/parameters. Trade identity prefers `tid`, then hash, then an occurrence-safe fallback. Sticky dots keep the largest session print, recent whales add a decaying halo, and major whales receive a ring. Same-side whales within five seconds form a response cohort; fresh mids near 15s/60s classify follow-through/rejection/absorption, with only completed 60s results entering the signal behind a $25k evidence floor. Tooltips are capped at three compact lines. Watchlist removal now prunes all related browser state immediately when the coin is no longer retained, and the backend clears flow on its final trade unsubscribe.

**Live validation (July 12, 2026; non-funded/mainnet):** the normal snapshot-restored boot was healthy but sat at the 900-upstream-feed cap, correctly accepting active BTC and shedding background ETH. A controlled `PEZ_CANDLE_SNAPSHOT=0` run reduced the gauge to 18 before the client test; BTC+ETH were then accepted together, followed by an active switch to SOL while BTC+ETH remained subscribed. Over 95s the client received 148 `_flow` snapshots / 431 unique tids (58 BTC, 58 ETH, 32 SOL trade batches; after the switch: 42 BTC, 49 ETH, 32 SOL), with zero duplicate tids and no background shedding. Independent reconstruction of every non-overlapping tier using the advertised true half-life matched the server within 0.0097% maximum relative error (the largest absolute difference was ~$0.10 on ~$1.07k). Sixty ≥$10k whale prints were observed; one real $20.7k BTC sell was sampled at 61.2s and classified absorbed. Health stayed `status=ok`, `api_healthy=true`, and market WS connected. No ≥$250k print occurred, so the major-whale ring remains automated-test-validated rather than live-observed. No funded actions were attempted.

### Verification
All 27 DOM ladder tests pass. Full bundle rebuilt (`npm run build`).

## §22 — Replay-safe whale flow and two-tier DOM meters (July 12, 2026)

The backend now owns flow state under an explicit mutex because final trade-unsubscribe cleanup can run outside the market read pump. Trade accumulation dedupes a bounded per-coin identity FIFO before changing flow, snapshots continuously decay under the same lock, and final unsubscribe clears both flow and dedupe state. `_flow` adds `lastTradeAt`/`lastWhaleAt`; the precomputed book signal uses non-overlapping regular and whale components instead of counting whales once in total flow and again as large flow.

Whale response cohorts can merge only within five seconds of their original start, and completed responses below the documented $25k evidence floor no longer affect directional bias. Qualifying history receives a ten-minute half-life while absorbed/unknown outcomes remain directionally neutral.

The DOM header's barely visible one-pixel whale overlay was replaced by aligned, identically sized full-width 7px `ALL` and `WHALE` taker-flow meters, with aqua buy dollars on the left, red sell dollars on the right, accessible summaries, neutral empty tracks, and the existing three-minute live decay. Both meters now share one geometry class with no whale-only inset ring. Redundant `B`/`S` text prefixes were removed, and FLOW/LIQS now share one fixed 34px, non-shrinking header class. Frontend 123 files / 758 tests pass; focused websocket race tests, full Go tests, `go vet`, and `make release` pass.

The DOM ladder's right historical-total column now mirrors the left resting-book fill treatment—identical bar inset, opacity, height, and outward geometry—while retaining its buy/sell split gradient. Its total uses matching numeric color/weight and aligns toward the price spine. All 27 DOM ladder tests pass and the release was rebuilt.

## §23 — Quiet-flow neutralization and stale signal clearing (July 12, 2026)

The correctness audit found that exponential decay reduced displayed dollars but not a pure buy/sell ratio, allowing tiny old one-sided flow to retain full directional weight. Regular and whale signal bias now scale smoothly with remaining decayed evidence, reaching full weight at $25k and converging toward neutral during silence; browser radar applies elapsed decay from `_flow.asOf`, and completed whale-response influence now truly halves every ten minutes. Book messages always publish `_signal` (explicit `null` when neutral), while active-book handling and coin-switch reset clear prior precomputed signals/walls, preventing stale cross-coin directional reuse. The ticket-side Smart Long/Short consumer described by the original audit was retired on July 12; normal orders now use only the explicit Buy/Sell selection.

Whale response cohorts now merge the newest eligible same-side cohort even when opposite-side prints interleave. Major-whale rings use the dominant major print's side color, and genuinely stale out-of-order prints no longer brighten the current DOM flash. Regression coverage was added across Go annotations/evidence weighting and frontend stream, signal, response, DOM, and reset paths. At that checkpoint the full frontend was 123 files / 764 tests; full Go, focused websocket race, and `go vet` passed. The later Smart consumer cleanup reduced the current suite to 121 files / 758 tests.

**Live non-funded smoke:** controlled no-snapshot boot accepted BTC+ETH and retained both after switching active to SOL. Over 95s it received 621 `_flow` snapshots / 4,430 unique tids with zero duplicates; independent tier/decay reconstruction stayed within 0.0432%. It observed 431 ≥$10k whales and 19 ≥$250k majors; a real $10.7k BTC buy resolved rejected at 61.1s. A separate wire check saw `_signal` present on all three sampled books, including one explicit neutral `null`. Final health was OK, API/market WS healthy, 47 upstream subscriptions, zero shedding, and zero clients after disconnect; no funded actions were attempted.

**Post-change live smoke:** a controlled non-funded/no-snapshot mainnet run accepted BTC+ETH, then SOL while both background feeds remained live. Over 95s it received 134 `_flow` snapshots / 283 unique tids with zero duplicates, nine ≥$10k whales, valid freshness metadata, and a 0.0139% maximum independent reconstruction error. A ~$50.0k BTC sell resolved `Absorbed` at 60.7s. Health remained OK at 33 upstream subscriptions with zero shedding; no ≥$250k major appeared and no funded action was attempted. The server shut down cleanly. On July 12 the regenerated repository Go/Vite caches were removed again; final workspace size is 207 MB including the 36 MB server, approximately 171 MB without it, while preserving dependencies, the release bundle, and the 46 MB candle snapshot.

## §20 — Account modes, generic builder perps, bounded actions, lifecycle ownership (July 11, 2026)

Implemented the lead-engineer architecture review as an additive compatibility pass. Account responses now report detected abstraction mode and risk freshness; builder perp routing/discovery, mids, metadata, positions, and order reconciliation are dex-generic while xyz aliases remain; signed exchange HTTP calls use a bounded 8-wide lane with monotonic nonces and Prometheus latency/concurrency metrics; and long-lived background work derives from the server lifecycle context. HIP-3 action tests no longer depend on live metadata. The live smoke exposed and fixed double-prefixed builder metadata and under-counted builder `allMids` subscriptions.

Verification: full Go suite green, focused race suite green, `go vet ./...` green, frontend 122 files / 752 tests green, release rebuilt. Non-funded mainnet smoke passed with 10 dexes loaded, canonical keys, healthy market WS, store-backed BTC candles, radar/L2/previews, zero signed actions, and the upstream subscription gauge held at the 900 operational cap. Funded and real multi-account-mode validation remains the explicit release gate.

## §24 — Backend chart/CVD ownership and targeted builder-refresh single-flight (July 13, 2026)

Completed the data-plane separation pass around the user-visible chart/trading contention report. Historical chart hydration is served by `/api/chart-candles`, scanner CVD is computed once on the backend through `/api/cvd-scan`, and market/trading realtime messages use independent downstream WebSockets and bounded write queues. Candle snapshot residency and live-feed residency are now intentionally different: the backend can restore hundreds of historical series while admitting only 64 cache-owned permanent candle feeds; active browser chart subscriptions are outside that cache cap and take priority. The browser-side CVD alert monitor no longer parses timeframes, loads per-coin histories, computes oscillators, excludes forming bars, or runs a parallel hydration scheduler. It consumes compact confirmed readings and owns only baseline/crossing hysteresis and notifications.

The final console trace showed that a builder execution's `orderUpdates` and `userFills` could both request the same immediate dex-state refresh. Those duplicate best-effort fetches competed for `/info` capacity and produced paired timeout warnings even though the order and close had already succeeded. `WebSocketManager` now coalesces targeted refreshes by normalized `account|dex`: a 75ms debounce absorbs the ordinary event pair, one dirty bit allows exactly one follow-up when an event lands during the fetch, unrelated keys remain concurrent, and each fetch keeps its three-second deadline. Tests use a blocking fake fetcher to prove both collapse and follow-up semantics.

Removed code: the superseded frontend CVD hydration/calculation path and its redundant forming-bar test. Preserved code/data: the backend oscillator implementation and coverage, frontend alert hysteresis tests, vendored Go modules, npm dependencies, the rebuilt hashed bundle, and the candle snapshot. Verification passed across all Go packages, `go vet`, targeted race packages, and 762 frontend tests in 122 files; both release artifacts built. Repository-local Go/Vite/Vitest caches and the final 36 MB server binary were removed after verification. Final workspace size is approximately 171 MB without the server, down from 1.0 GB with an 827 MB repository-local Go cache.

## §25 — First-render default anchored-CVD completeness (July 13, 2026)

The independent live-feed cap exposed a default-view-only startup hole. Snapshot restore streamed 888 series through `onRegister`, but Go map order made the first 64 cache feeds nondeterministic. BTC 2h could therefore restore covered while BTC 5m/30m stayed degraded or carried an older unverified gap. Because `WarmOnDemand` returned immediately for the covered 2h series, it never launched source repair. Even after source verification, a store miss returned the raw upstream 2h body that had just been merged, so the first browser render still lacked `cvdDelta` and only a later fetch could improve it.

The fixed lifecycle is deterministic. `PrepareCvdSources("BTC")` runs before snapshot decoding and reserves the first two live-feed slots. Visible CVD-enabled charts ref-count the primary interval and their 5m/30m sources as client dependencies outside the cache cap. `EnsureCvdSources` blocks functional readiness until the default pair is market-WS-connected and any restored gap/tail has been sequentially fetched; its critical fetch bypasses only the background token bucket because no functional HTTP client is admitted yet, while retaining the fetch semaphore, info governor, retry handling, and 30-second startup deadline. Covered display-series warms now repair sources before returning. A successful passthrough is merged and immediately re-served through the store so the first response receives CVD enrichment.

Live restored-snapshot validation: `series=888`, `candles=64`, then `default chart CVD sources ready` before functional admission. The first BTC 2h call returned 1,980 bars with all 96 recent completed bars enriched and an enriched tail. The 604 oldest nil values were correctly beyond the retained 30m source edge. New tests pin startup source reservation order, restored-gap repair, covered-display source repair, active chart source-ref derivation, and first-passthrough enrichment. Full Go/vet, affected race packages, and 762 frontend tests passed; both artifacts rebuilt.

## §26 — Bounded complete CVD scan coverage (July 13, 2026)

The backend scanner's 40-coin request bound was not mirrored by the new compact frontend consumer: two mover rows could already total 80 coins before adding the uncapped watchlist. The monitor therefore entered a deterministic minute-by-minute 400 loop whenever the de-duplicated union exceeded 40. It now partitions the complete set into ordered sequential batches of 40 and coalesces overlapping timer ticks onto the active pass, preserving full coverage without raising the backend load boundary. Failed passes release the guard so the next tick retries.

Removed code: the ignored browser-side `computeTimeframe` option and its obsolete calculation comments. Preserved ownership: the backend still selects the latest closed 1h bar and computes the 30-day oscillator; the browser retains only crossing state and notifications. Focused tests pin request ordering, later-batch alerts, single-request behavior, non-overlap, failure recovery, and the backend 41-unique-coin rejection. Full Go tests/vet and 765 frontend tests passed; both artifacts rebuilt. The rebuilt server's live smoke returned healthy status, served `main-JOYUYPZH.js`, produced a confirmed BTC reading with zero errors, rejected 41 unique coins with the documented 400, and shut down cleanly.

## §27 — Live-price-locked forming candle (July 18, 2026)

The apparent candlestick lag was a source-cadence mismatch, not a Lightweight Charts misuse: the native live-price line consumed frequent all-mids/L2 messages while the candle series moved only on Hyperliquid candle messages. Historical `setData()` plus live-tail `update()` was already the recommended library pattern. A new display-only forming-candle controller now applies the official realtime OHLC behavior to that faster price source: fixed open from the prior completed close, close equal to the live line, and monotonic high/low over observed prices. It never enters canonical candle arrays, caches, snapshots, indicators, strategies, or APIs; exchange OHLCV remains authoritative and reconciles the display bar. As corrected by the July 31 follow-through above, a rare bucket-boundary exchange final behind an already-created projected next bar uses ordered canonical `setData()` rather than the library's historical-update option, which is incompatible with enabled conflation.

Coverage adds pure boundary/OHLC tests, chart-series reconciliation and metadata isolation, runtime line/projection wiring, and real-browser close-lock/wick assertions. Full frontend verification passed 787/787 tests across 126 files; all Go packages, `go vet ./...`, and `make release` passed. The production bundle is `main-3DIANIQA.js`. After startup readiness completed, the restored-snapshot non-funded mainnet browser smoke passed 194/194 with one chart instance, zero rejected updates, exact completed-candle REST fidelity, all supported timeframes, BTC/ETH/SOL/`xyz:GOLD` churn, healthy server/market WS, 74 upstream subscriptions, zero shedding, and no runtime/resource/recovery failures. No funded actions were attempted.

## §28 — Professional frontend design-system refinement (July 19, 2026)

Continued and completed the interrupted appearance upgrade as a presentation-only pass over the existing vanilla ES-module architecture. `styles.css` now defines a consistent terminal token layer for surfaces, borders, typography, spacing, elevation, radii, focus rings, and z-index ownership. Static inline layout was migrated from `index.html` into reusable classes for chart/flow chrome, stacked market columns, wallet and connect-modal surfaces, ticket grids/dividers/sliders/actions, and both bot modes. The previously unbound timeframe styling is now backed by a semantic `role="group"` wrapper, and the audit restored the connected-wallet wrapper's width/flex-direction contract that had been lost during the interrupted migration. Runtime visibility, P&L/flow colors, bot activity colors, and other data-driven styles remain JS-owned.

New `design-system-shell.test.js` coverage pins the critical class bindings and restricts remaining shell inline styles to runtime-controlled visibility and bot mode state. Full frontend verification passes **804/804 tests across 129 files**; all frontend JavaScript parses; the full Go suite and `go vet ./...` pass. `make release` rebuilt the production shell, unchanged JS bundle `main-B2L5C3QV.js`, and server binary. After the 39-market startup readiness barrier, the final clean-profile non-funded Opera/CDP gate passed **209/209** with one chart instance, zero rejected updates, and no runtime/resource/recovery failures. A focused desktop/mobile appearance gate passed **25/25**, including modal/dropdown layering, Scale/TWAP/BOT visibility, sequential/bulk switching without bot execution, primary-action hierarchy, responsive market-column hiding, one-column mobile ticket layout, safe modal bounds, and zero horizontal overflow. Desktop and mobile screenshots were visually reviewed; no funded action was attempted.

## §29 — Chart switching, pointer ownership, and multi-drawing hardening (July 19, 2026)

Audited every chart-adjacent mouse/touch editing path after the design-system pass. Two correctness defects were concrete: `applyTimeframeTabButton` removed `active` from every generic `.ctrl-btn`, and `ticket-timeframe-runtime` called `completeTimeframeSwitch` with `coin` while the helper consumed `currentCoin`. The first could silently erase unrelated Draw/IND/DOM control state; the second could reload candles through an undefined asset key. Timeframe state is now scoped to the semantic `.tf-group`, and the runtime/helper contract is aligned and regression-pinned.

Interaction ownership is now deterministic. Clicking an active ready coin/timeframe does not restart its chart session, while an active-tab click also cancels any queued trailing timeframe intent. Drawing tools and manual anchored-VWAP placement explicitly disarm each other. A click that clears an anchor or drawing selection is consumed, including when a lower-pane selection is cleared from another pane, so the same click cannot also edit an order price. Candle-scale vertical grab-pan starts only inside the main price pane. Touch pointer routing now supports overlay drags/freehand/circles and lets drawing/anchor taps consume the gesture before limit-price logic; manual anchor placement therefore also works when the ticket is not currently Limit. Indicator controls use the shared scrollable viewport clamp.

Coverage was extended at each boundary: DOM control-group isolation; timeframe no-op/queued-intent cancellation and active-coin contract; placement-mode exclusivity; drawing/manual deselection; cross-pane routing; lower-pane drag isolation; market-mode touch anchors; and touch freehand forwarding. A dense overlay regression renders 240 persisted drawings in one primitive pass, selects the latest, and commits drawing 241 afterward. The complete frontend suite passes **815/815 tests across 130 files**. Full Go tests and `go vet ./...` pass. `make release` produced `main-62VCP2OK.js` and rebuilt the server. The broad non-funded chart smoke passed **209/209** during the audit; the final rebuilt candidate passed a focused **15/15** real-browser interaction matrix, including 12 independently mouse-placed drawings on one chart with one chart root and live canvas output. No funded operation was performed.

## §30 — Adaptive DOM range grouping (July 19, 2026)

The hard DOM grouping selector was replaced with range-driven scaling while leaving the ladder's rendering and interaction model intact. Each coin starts at ×5. On every ladder render, the lowest and highest valid prices across retained session trade activity and the complete current bid/ask snapshot are compared with the actual height-derived sticky window. When either edge no longer fits, the renderer selects the smallest fitting multiple of five, reusing the existing spacing-change re-anchor path. The multiplier is an uncapped per-coin high-water mark: it can exceed ×100 and never contracts while that coin remains cached, avoiding visual breathing as older extremes are evicted. Existing subscription pruning removes the multiplier state alongside spacing and market caches, so a genuinely removed/re-added coin starts clean at ×5.

Removed code: the topbar `DOM ×N` trigger and menu, aggregation styles/UI module, initialization and delegated actions, and manual cycling/selection exports. Preserved behavior: fixed/sticky axis, mid hysteresis, base-spacing hold, row pooling, book and activity memoization, volume/whale history, flash timing, and click-to-limit price. Focused tests cover both data sources, asymmetric extremes, sticky-center retention, per-coin independence, monotonicity, prune reset, dynamic height, and multipliers above ×100. Full frontend verification passes **816/816 tests across 129 files**; `npm run build` produced `main-CPOJMTDJ.js`. The rebuilt non-funded Opera/CDP mainnet gate passed **212/212**, including explicit checks that the retired control is absent and the live DOM renders a height-derived, uniform descending price grid; chart churn finished with one chart instance, zero rejected updates, and no runtime, static-resource, recovery, or upstream failures.

## §31 — Cumulative DOM flow and book-signal retirement (July 21, 2026)

The ALL/WHALE meters above the DOM now show cumulative taker dollars for each pair's continuous trade-subscription session. Watchlist pairs continue accumulating in the background, while final unsubscribe or backend restart resets the pair. The flow header no longer performs elapsed-time decay or schedules one-second quiet-market repaints. The recent-whale row halo remains a distinct visual effect with its own three-minute half-life.

Smart Long/Short and wall-aware ticket pricing had already been retired, leaving l2Book `_signal` and `_wall` computed, transported, and stored without a reader. Their backend scanners, flow-signal decay/evidence model, wire annotations, frontend precomputed state, and unused whale-response bias history are removed. `_flow` now publishes cumulative regular/whale totals plus thresholds and explicitly named `whaleHaloHalfLifeMs`. The DOM midprice marker retains its two inset hairlines using the brighter theme-aware `--border2` token.

Full verification passes **821/821 frontend tests across 130 files**, all Go packages, and `go vet ./...`. `make release` rebuilt the server binary and produced `main-4YFJZQY3.js`.

## §32 — Capture-phase drawing ownership (July 22, 2026)

Existing mouse drawing drags were detected by a bubbling `mousedown` listener on `chartWrap`. Lightweight Charts' inner canvas received that press first and could arm native panning before the drawing overlay disabled scroll, so dragging a circle or another drawing could shift the chart underneath it. `chart-interactions.js` now resolves manual-anchor placement/drag, gesture tools, armed drawing placement, and existing drawing/handle drags during capture. Claimed primary presses stop before the inner canvas; empty-space presses propagate unchanged for normal navigation, and the existing window move/release path completes the overlay gesture.

Three event-order regressions cover an existing drawing, manual-anchor/armed-tool ownership, and unowned empty space against a simulated inner canvas handler. Focused chart verification passes **97/97**, the complete frontend passes **824/824 tests across 130 files**, and `make release` rebuilt the server with bundle `main-6FLKX6OF.js`.

## §33 — Per-preset rolling VWAP band visibility (July 22, 2026)

Each 3D/10D/30D/90D Rolling VWAP row now has its own neighboring Bands checkbox, matching the manual anchored-VWAP visibility model. The center RVWAP and its four adaptive bands have separate ordered state: hiding bands clears and suppresses only that preset's band series, keeps its center line live, and leaves every other preset untouched. Band preferences default on, remain editable while the corresponding RVWAP is hidden, and reset with the other non-persisted indicator settings on reload.

The overlay-set diagnostics now expose ordered band-enabled lookbacks and per-preset `bandsVisible` state. Focused UI, action-delegation, and overlay tests cover startup defaults, invalid lookbacks, hidden-line preference retention, center-only live updates, band-history restoration, and simultaneous preset isolation. The complete frontend suite passes **833/833 tests across 130 files**; JavaScript syntax checks pass, and `make release` rebuilt the production server with `main-BXSP5EBI.js`. The updated non-funded Opera/CDP smoke passed **217/217**, including all four controls and independently hiding/restoring 3D bands while 3D and 30D remained attached, with one chart instance, zero rejected updates, and no runtime/resource/recovery failures.

## §34 — User-configurable visual color palette (July 22, 2026)

Added a shared **Colors** popover beside Draw and IND for Bullish, Bearish, Indicator, Drawing, Bull candle, and Bear candle colors. The shipped values remain the initial defaults (`#22cce6`, `#ff5050`, `#4a9eff`, `#4a9eff`, `#c8c8c8`, `#8c8c8c`). The initial editor used a 300×150 saturation/brightness map, a hue strip, a synchronized six-digit hex input, current swatch, and per-row Reset; §35 records its subsequent compact prism refinement. Reset all removes the override. The service validates/normalizes input, stores a versioned payload at `localStorage['pez:color-palette']`, tolerates corrupt or partial storage, publishes changes, and applies the palette before the chart session is created.

Palette consumers now share semantic ownership instead of scattering hardcoded color literals. Bullish/Bearish update directional shell state, trades, FLOW, DOM, orders, positions, CVD, and chart lines. Indicator provides the base hue for VWAPs, manual anchors, CVD indicators, and profiles while preserving their opacity hierarchy. Bull/Bear candle colors rebuild candlestick body and wick options with distinct alpha levels. Drawing is captured by newly committed standard drawings; existing saved drawings preserve their recorded colors, and position/directional tools continue to resolve live Bullish/Bearish colors. Changes schedule the existing render path and do not recreate the chart.

Verification covered the service, visual UI, action delegation, chart theme/lines, indicators, drawings, DOM/trades/orders, and shell bindings. The complete frontend suite passed **841/841 tests across 132 files**; fresh full Go tests and `go vet ./...` passed. `make release` rebuilt `web/dist/main-V5UTAVTR.js` and the 36 MB server. A focused non-funded Opera/CDP live gate passed **21/21** checks on BTC 2h: real pointer input moved the hue/map cursors; all six custom hex values persisted exactly; FLOW labels, RVWAP, candle bodies/wicks, and a real committed horizontal drawing matched their expected colors; invalid `#123` was rejected; reload restored the palette before chart creation; Reset all restored defaults; one chart root remained, rejected updates stayed zero, and runtime/page/application-console errors stayed zero. The browser's original palette and drawing records were restored and no funded action was attempted.

Cleanup removed the disposable CDP script, temporary Vitest local-storage databases, macOS metadata, Vite cache, and Go test cache. Regression test sources, installed dependencies, `web/dist`, and the rebuilt binary were intentionally retained.

## §35 — Continuous base prism and late indicator palette ownership (July 22, 2026)

The palette editor now separates fast base selection from fine tuning without a large swatch DOM. One 34px keyboard-accessible prism spans red → yellow → green → cyan → blue → magenta → red continuously. Pointer/drag position maps directly to a 0–359° full-saturation/value base hex; arrow keys step 1°, Shift+arrows step 15°, and Home/End select the endpoints. Its cursor, ARIA value, preview, and manual hex field remain synchronized through the same versioned palette service. The continuous saturation/brightness surface is reduced from 150px to 88px for subsequent shade adjustment; the old standalone hue strip is removed because the prism now owns hue selection.

The reported new-indicator color regression was a lazy lifecycle defect in Monthly Volume Profile. Its palette was captured when the overlay object was constructed; while hidden it correctly skipped rendering, but also skipped the live `applyTheme` pass. Enabling it later therefore attached with the old default. Attachment now resolves `themePalette()` immediately, matching the already-dynamic attach paths used by VWAP and manual-anchor overlays. A regression constructs the overlay, changes Indicator while it is still detached, then proves its first rendered boxes and POC use the new RGB value.

The complete frontend suite passes **843/843 tests across 132 files**. A focused non-funded Opera/CDP gate passed **9/9** on the prism candidate: exactly one 300×34 prism and no legacy swatches, 88px fine map, real-pointer `#00FF00` selection with synchronized cursor/ARIA/hex/CSS state, late Monthly Volume Profile attachment with green boxes/POC, existing RVWAP green opacity tiers, one chart root, and no runtime/application errors. Removing the duplicate hue slider then passed **8/8** focused palette/shell tests; `make release` produced final bundle `main-NVIPP6MY.js` plus the rebuilt server. Original browser palette state was restored, no funded action was attempted, and the validation server shut down cleanly.

## §36 — Unified clear and descriptive privacy controls (July 24, 2026)

The Draw popover no longer duplicates a destructive **Clear all** button among its placement tools. Topbar **CLEAR** now composes the existing toast and drawing cleanup paths: one click removes transient/persistent messages and every active-coin drawing from the price, anchored-CVD, and oscillator overlays, including their local-storage records. The independent clear functions remain intact for internal and diagnostic use. The privacy toggle now states its dollar-value scope as **HIDE $** / **SHOW $**, synchronizes its title and `aria-pressed` state, and carries the missing `#hideValuesBtn` binding required for live label updates.

Focused UI/delegation/shell coverage passes **9/9**. The complete frontend suite passes **836/836 tests across 131 files**; all Go packages and `go vet ./...` pass. `make release` produced `main-DVFPNTQA.js` and rebuilt the server. The smoke harness now checks the visible controls, both privacy states, absence of the Draw-menu clear action, and real unified cleanup of a persistent toast plus price/CVD drawings and storage. After the 43-market readiness barrier, the clean-profile non-funded Opera/CDP gate passed **220/220** with one chart instance, zero rejected updates, and no runtime, resource, recovery, or upstream failures. The first pass stopped on timing-sensitive manual-anchor placement; the second exposed a harness-only `window.showToast` reference after reaching the new drawing checks; the supported `window.app.showToast` facade was used for the final complete pass. The validation server and browser then shut down cleanly; disposable browser/localStorage state, Vite/Go caches, and macOS metadata were removed while retaining test sources, dependencies, release bundle, and binary. No funded action was attempted.

## §37 — Empty rolling RVWAP startup state (July 24, 2026)

Rolling RVWAPs now load on demand instead of attaching chart series during startup. The canonical `AppState.ui` defaults, reload reset, and static IND checkbox state all begin with empty line-enabled and band-enabled lookback sets. Manual Anchors retain their separate hidden-with-bands-ready default. All four rolling presets and their per-preset band preferences remain independently editable during the session.

The UI regression now pins every rolling control unchecked at startup, while the browser gate verifies an unattached empty overlay set before explicitly enabling 3D/30D lines and bands for the existing coexistence and isolation checks. Focused tests passed **7/7**; the complete frontend suite passed **836/836 tests across 131 files**. `make release` produced `main-YGDTLLGU.js` and rebuilt the server. The non-funded Opera/CDP gate passed **220/220** with one chart instance, zero rejected updates, and no runtime, resource, recovery, or upstream failures. Cleanup removed the isolated browser profile, temporary localStorage files, screenshots, and Vite/Go test caches while retaining source tests, dependencies, release bundle, and binary.

## §38 — Split AVWAP, RVWAP, and PROFILE colors (July 25, 2026)

The Colors popover now replaces the generic Indicator row with three independently editable rows: **AVWAP** owns manual anchored-VWAP markers, center lines, and bands; **RVWAP** owns every rolling preset, its center/bands, and the matching IND swatches; **PROFILE** owns Monthly Volume Profile boxes and POC lines, including first attachment after a hidden-state color change. All three retain the prior `#4a9eff` default and the established opacity hierarchy. CVD remains directional and continues to use Bullish/Bearish rather than any of these three overlay colors.

Palette storage advances from version 1 to version 2. A valid legacy `indicator` override is normalized, copied to `avwap`, `rvwap`, and `profile`, and immediately rewritten in the new shape so upgrades preserve the existing chart appearance. Corrupt and partial payloads still fall back per key; per-row Reset and Reset all retain their previous behavior. The generic indicator/VWAP CSS tokens and helpers were replaced by semantic AVWAP/RVWAP/PROFILE ownership, and palette initialization now deterministically selects Bullish when initialized.

Regression coverage was added to the existing palette UI/service and overlay suites; no standalone test source was retained. Focused verification passed **49/49**, and the complete frontend suite passed **840/840 tests across 131 files**. A clean-profile, non-funded Opera/CDP gate passed **22/22** on BTC 2h: the eight exact row labels rendered with no Indicator row; version-1 storage upgraded in place; a real chart click created and persisted one AVWAP anchor; magenta AVWAP, green RVWAP, and orange PROFILE edits persisted independently and produced distinct live canvas colors at their expected opacity tiers; the RVWAP swatch followed its token; invalid `#123` was rejected; one chart root remained with zero rejected updates; and runtime, console, and funded-request counts stayed zero. The disposable smoke script, isolated browser profile, Vite cache, and Vitest local-storage files were removed before the final release rebuild. `make release` then produced `main-354AUFAN.js` and replaced the production server binary.

## §39 — Dedicated scroll-independent RVWAP source (July 25, 2026)

The server preload was functioning, but the history contract was incomplete: 165/175 days seeded only the latest 30D-band point, while the chart immediately displayed 90 historical days and the later 90D preset requires a 495-day deviation window. Scrolling prepended display candles and rebuilt the overlay, visibly changing RVWAP values.

RVWAP now owns one 4h/600-day source (3,600 bars, below the upstream response cap). It is background-warmed and persisted but does not extend the blocking startup barrier. Enabling the first preset fetches the source through `/api/chart-candles` and adds `indicatorIntervals:["4h"]` to the client market subscription; disabling the last removes the client ref. The backend validates that optional dependency, keeps it outside the cache-owned feed cap, restores it across reconnects, and forwards only the requesting client's source candles. Every preset computes solely from that source, withholds incomplete center/band windows, and updates from live 4h revisions. Display history and scrollback are no longer inputs.

Coverage pins the 600-day optional requirement, source-ref add/remove and forwarding, frontend request deduplication, subscription intent, and elapsed warmup gates. A late chart-resize callback found during live validation could also discard the armed manual-anchor click before placement; armed placement now bypasses only that resize guard and retains the movement/long-press checks. The frontend's **845/845 tests across 131 files** pass. `go vet ./...` and all Go packages passed before the final interaction-only edit. `make release` produced `main-XWUDSMLG.js` and rebuilt the server binary. The expanded non-funded Opera/CDP gate passed **223/223**, proving 90D RVWAP and bands render before any scroll and retain the same dedicated 4h source plus center/band row counts across eight scroll-back drags, with one chart instance, zero rejected updates, and no runtime, resource, recovery, or upstream failures.

## §40 — RVWAP chart-switch lifecycle hardening (July 25, 2026)

The dedicated source loader is now request-scoped instead of allowing every async completion to replace one global status object. A late success or failure from a chart the user has left may still warm that coin's cache, but it cannot clear or take ownership of the active chart's RVWAP state. Enabled RVWAP loading starts in parallel with the visible chart request, completed per-coin sources are reused on return, and an ordinary partial 4h display cache is never mistaken for the completed 600-day dependency.

Transient source failures now retry on a bounded 1s/2s/5s/10s schedule only while the coin remains active and at least one preset is enabled. A failed authoritative refresh keeps a fresh completed source visible and disabling the last preset cancels pending recovery. Dedicated sources now live in their own eight-coin LRU, protected for the active coin, so generic 4h display scrollback can neither expand the RVWAP input beyond 600 days nor evict it. Source responses retain concurrent newer 4h rows within the requested range, and live 4h revisions update that dedicated cache even when no generic 4h display entry exists.

Regression coverage exercises reverse-order A→B success and failure, per-coin reuse, partial-cache rejection, refresh fallback, retry success/cancellation, dedicated-cache pressure/live updates, and timeframe reattachment with stable nonzero RVWAP history. The focused lifecycle suites passed **104/104** and the complete frontend suite passed **855/855 tests across 131 files**; `go test ./...` and `go vet ./...` also passed. `make release` produced `main-3HHPIDQL.js` and rebuilt the production server binary. After the normal 42-market readiness barrier, the final-bundle non-funded Opera/CDP gate passed **223/223** checks, including dedicated 90D source attachment before scroll, stable RVWAP source/band counts across history navigation, rapid coin/timeframe churn, one chart root, zero rejected updates, and no runtime or resource failures.

## §41 — Stable candle spacing across timeframes (July 25, 2026; superseded by §43)

The timestamp-based 90-day switch viewport fixed RVWAP-expanded logical-axis drift, but `setVisibleRange()` necessarily recalculated the time scale's pixel spacing from each interval's visible point count. Candle bodies therefore remained thin or wide depending on timeframe despite the theme's nominal `barSpacing: 8`.

Initial load and every coin/timeframe series recreation resolved the latest candle with the official chart-wide `timeToIndex()` API after all candle and indicator series attached, then targeted a fixed pixel spacing with five slots of right margin. That removed data-time fitting and candle-array/shared-axis confusion, but it intentionally showed only part of long histories and changed the inspected time window on resize. §43 retains the correct logical-index boundary handling while replacing the fixed-width product policy.

Focused chart coverage passed **23/23** and the complete frontend suite passed **855/855 tests across 131 files**. `make release` produced `main-S57WHBCS.js` and rebuilt the production server binary.

After restored-snapshot boot reached 42/42 readiness (974 series in 3m24s), the isolated non-funded Opera/CDP gate passed **268/268**. The first pass exposed only a smoke-harness assumption: real browser layout and price-axis rounding reported effective spacing from 7.956px to 8.067px, so the assertion now accepts the intended ±0.1px subpixel tolerance and separately verifies resize preservation. The final pass covered every timeframe from `1m` through `1M` with RVWAP enabled, current-candle visibility, live forming-candle updates, one chart instance, zero rejected updates, and no runtime, resource, or recovery failures. The server and isolated browser were shut down cleanly; the temporary browser profile, Vite cache, Vitest local-storage files, and macOS metadata were removed.

## §42 — Default AVWAP/30D RVWAP visibility and clearer overlay markers (July 25, 2026)

The fixed, non-persisted indicator startup contract now enables manual Anchors without their bands and enables the 30D rolling VWAP with its bands. Other rolling presets remain off. A shared frozen default object feeds canonical `AppState.ui` construction and the explicit reload reset, while the static IND checkbox attributes match it before JavaScript initializes. Since the store already contains the 30D default when the first visible-candle request starts, the dedicated 4h/600-day source loads in parallel and `indicatorIntervals:["4h"]` is present in the initial subscription intent.

Manual anchor origins now draw two concentric shapes: a 10px same-color outer ring around the existing 4.5px dot, expanding to 12px/6px while selected. The hit radius is 13px so the larger visual target is also interactive. AVWAP color ownership and the selected orange treatment remain unchanged.

Monthly Volume Profile POC guides now use a rounded 1px `[1,4]` bitmap dash pattern, producing dots rather than the previous long `[6,4]` dashes. The line keeps the semantic PROFILE color and 0.8 opacity, and its canvas state is saved/restored so the rounded cap cannot leak into other primitive drawing.

Focused indicator, marker, monthly-profile, market-service, subscription, and switch-wiring coverage passed **79/79**. The complete frontend suite passed **856/856 tests across 131 files**, all modified JavaScript passed syntax checks, and `make release` produced `main-C2RRYZMG.js` plus the rebuilt production server binary. The live smoke now requires a ready, rendered default 30D centerline/band set and verifies the exact AVWAP/RVWAP control defaults.

After the normal 42/42 readiness barrier, the isolated clean-profile Opera/CDP gate passed **268/268** against the rebuilt bundle. It proved the 30D centerline and bands attach from the dedicated source before any user toggle, the AVWAP control starts line-only, every timeframe retains the canonical candle spacing, RVWAP remains invariant through scrollback, and live updates finish with one chart instance, zero rejected updates, and no runtime, resource, or recovery failures. An initial gate run mixed the explicit **Fit** action—which intentionally zooms to all history—with the default-spacing resize assertion; the harness now returns only to the live edge before checking resize preservation. The server and browser shut down cleanly, and the isolated profile, Vite cache, Vitest storage, and macOS metadata were removed.

## §43 — Complete-history overview with official dense-candle conflation (July 25, 2026)

The fixed-width framing policy was replaced by the requested overview-first behavior. Initial load, every coin/timeframe recreation, and explicit Fit resolve the active candle series' first/latest chart-wide logical indexes and show that entire range plus five future slots. Dedicated RVWAP timestamps cannot widen those bounds. The overview sets `minBarSpacing: 0.001` so its timestamps survive narrow responsive layouts, while `lockVisibleTimeRangeOnResize: true` retains the inspected time window. Manual pan/zoom remains untouched by live updates and backfills.

Lightweight Charts 5.2's built-in conflation is enabled with threshold factor `1`. It activates only below the DPR-aware physical-pixel threshold, uses the library's OHLC-preserving candlestick reduction for display, and progressively returns to factor `1` as the user zooms in. Canonical candle arrays, indicator calculations, and order logic never consume conflated rows. Diagnostics now expose overview bounds/coverage, visible slot count, raw/minimum/effective spacing, and exact expected conflation state.

The browser gate replaced obsolete fixed-spacing assertions with complete-overview, conflation, and visible-time-range checks. A first resize pass exposed insufficient minimum-spacing headroom; a second exposed a correct 1,000-bar history prepend that shifted logical indexes while retaining timestamps, so the final invariant correctly compares visible time. The isolated non-funded gate then passed **285/285** across every supported timeframe, standard/HIP-3 churn, responsive resize, live updates, one chart instance, zero rejected updates, and no runtime/resource/recovery failures. The complete frontend suite passed **860/860 across 131 files**; all Go packages and `go vet ./...` passed. `make release` produced `main-2S455RC6.js` and the rebuilt server. The liquidation reconnect loop also gained a 30-second stable-session reset so successful uptime clears accumulated exponential delay.

## §44 — Completed-candle indicator boundary and quiet startup (July 30, 2026)

The chart now has one explicit data boundary: the native exchange candle and
display-only live-price projection may update inside the active bucket, while
every derived renderer receives only completed candles. `market-candles.js`
owns close-time resolution from Hyperliquid `T`, fixed intervals, UTC weeks,
and calendar months. This avoids the unsafe “drop the last row” shortcut and
keeps sparse tails that have actually closed. Manual AVWAP/bands, Monthly
Volume Profile, anchored CVD/reset markers, and the CVD oscillator consume the
closed display source; RVWAP/bands consume a closed dedicated 4h source and
project only onto closed display rows.

Live auditing found a second stateful edge after filtering: repeating an
unchanged last closed 4h bar advanced RVWAP's Kalman state even though the
source signature had not changed. The chart coordinator now gates incremental
indicator work on completed-source signatures, and the RVWAP overlay itself
rejects an identical input-bar signature as a defensive invariant. A display
bucket close can still reproject an unchanged RVWAP source without replaying
its calculation, and a genuinely revised closed bar remains accepted.
Diagnostics expose display and RVWAP source signatures plus last rendered
times/values so the invariant is observable in production.

Fresh-load defaults are now manual **Anchors** on with bands off and **Monthly
volume profile** on. Every RVWAP line and band is off, so startup carries no
optional `indicatorIntervals:["4h"]` subscription; enabling the first rolling
preset still loads the existing dedicated source on demand.

Regression coverage pins explicit/inferred close times, fixed/weekly/monthly
boundaries, sparse completed tails, native-tail movement with stable derived
state, and duplicate-versus-revised RVWAP input. The complete frontend suite
passes **870/870 across 131 files**; all Go packages and `go vet ./...` pass.
`make release` produced `main-HFJQHFKY.js` and rebuilt the signed server. The
isolated non-funded Opera/CDP release gate passed **286/286** after restoring
984 snapshot series and reaching 39/39 readiness in 2m30s. It observed a real
same-bucket native price change while the AVWAP, profile, CVD, oscillator, and
enabled RVWAP fingerprints remained identical. Final diagnostics reported one
chart instance, 42 full data sets, 73 incremental updates, zero rejected
updates, and no runtime, resource, recovery, or upstream failures. No funded
action was attempted.

## §45 — Native price-scale ownership and zoom-stable VWAP overlays (July 30, 2026)

The closed-candle boundary fixed same-bucket indicator repainting, but RVWAP
center/band series and manual AVWAP series still opted out of native autoscale
with `autoscaleInfoProvider: () => null`. That left price-derived overlays
outside the main price scale's visible-range calculation and made their screen
positions appear unstable as Lightweight Charts recomputed the viewport during
wheel zoom.

The overlays now follow the official Lightweight Charts
[moving-average example](https://tradingview.github.io/lightweight-charts/tutorials/demos/moving-average):
each AVWAP/RVWAP center and band is a normal line series explicitly attached to
the shared `right` price scale, with no custom autoscale provider. The library
therefore owns the unified price range through its native
[price-scale API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/IPriceScaleApi).
Manual AVWAP also hashes its closed-candle revision, coin, anchors, visibility,
band settings, and sigma; a viewport-only sync reuses the existing native
series without another `setData()`, while any real source, anchor, or option
change still rebuilds it.

This rule applies to other price-derived native line series, not indiscriminately
to every chart implementation. Drawings and Monthly Volume Profile are
primitives attached to an owning series and intentionally do not expand the
price range. Anchored CVD and the CVD oscillator remain native series in
separate panes with their own scale domains. Production diagnostics now expose
right-scale autoscale/range state plus AVWAP/RVWAP last values and full/incremental
data-call counts, making zoom stability directly testable.

Focused overlay coverage passed **62/62** after the final harness refinement,
and the complete frontend suite passed **871/871 across 131 files**. All Go
packages and `go vet ./...` passed. `make release` produced
`main-TMNEGHO4.js` and rebuilt the ad-hoc-signed server binary. The isolated
non-funded Opera/CDP gate passed **292/292**: consecutive inward wheel zooms
left AVWAP/RVWAP sources, timestamps, values, and data-call counts unchanged;
the right scale stayed in native autoscale and contained the visible centers
and bands; reverse zoom preserved every latest value even when reaching the
history threshold legitimately prepended 1,000 older candles. Final
diagnostics retained one chart instance, 41 full data sets, 62 incremental
updates, zero rejected updates, and no runtime, resource, recovery, or upstream
failures. No funded action was attempted.
