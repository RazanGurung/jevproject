# Chart Runtime

Current Lightweight Charts adapter, switch/overlay lifecycle, and the
remaining RVWAP clip. Module ownership and candle-store rules stay in
[ARCHITECTURE.md](ARCHITECTURE.md). Operator checks live in
[LIVE_VALIDATION_RUNBOOK.md](LIVE_VALIDATION_RUNBOOK.md).

**Library:** `lightweight-charts` **5.2.1**, exact-pinned in `web/package.json`
and statically imported from `web/src/chart/lightweight-chart-core.js`.
Production never loads a runtime vendor script. The in-memory stub is
test-only and requires `__PEZ_LIGHTWEIGHT_CHARTS_TEST_STUB__`.

**Latest evidence (2026-09-23):** frontend **1262/1262** (158 test files); isolated `:5001`
Opera/CDP `chart_live_smoke` **334/334** `"ok": true` on `main-J5BKJTE7.js`
(1 chart, 56 `setData`, 205 `update`, 32 series recreates, 3280 BTC `2h`
candles, `rejectedUpdateCount` 2, 0 active candle recovery warnings). Default landing
timeframe is **2h** (`chart-history-requirements.js` `DEFAULT_TIMEFRAME`
mirrors `chartrequirements.DefaultTimeframe`). Live ticks `update()` the
native series and `updateLast` overlays through `mutateOverlaySeries`; they
do not reschedule an overlay `setData`. Unchanged 4h RVWAP source
does not live-tick `setCandles`. Same-bucket live merges keep the higher
trade count. Teardown and series recreate reset `lastOverviewSelectionKey`.

---

## v5 invariants (do not regress)

These match the official v5 skill and the pinned 5.2.1 typings.

| Rule | PEZ contract |
|------|----------------|
| `chart.addSeries(ImportedType, options, paneIndex)` | No v4 `addLineSeries` / `addCandlestickSeries` |
| `series.setMarkers` | Unused. CVD resets are a data series, not markers |
| `setData` vs `update` | Canonical snapshots use `setData`. Ordered live-tail uses `update` |
| Time is UTC **seconds** | `>= 100_000_000_000` is milliseconds → divide by 1000. One threshold everywhere (chart adapters, CVD family, RVWAP source) |
| Whitespace | `{ time }` only. Never `value: null` |
| No `timeScale.timezone`; no chart `watermark` | Theme options only |
| Primitives | `IPrimitivePaneRenderer` + `useBitmapCoordinateSpace`. `zOrder` is a **method**. `positionsLine` / `positionsBox` are **not** in 5.2.1 — do not invent them |
| One `createChart` | Page lifetime. Coin/TF changes recreate the main series, not the chart |
| Logical range | Capture `getVisibleLogicalRange` before canonical `setData`; restore after. History prepend shifts the **fractional** range by `addedCount` |
| Overlay scales | CVD / oscillator use custom ids `cvd` / `cvdOsc`. Manual AVWAP and RVWAP share candle `right` (no `autoscaleInfoProvider`). Session VWAP, volume profile (visible range default, quarterly, monthly) with LVN zones, liquidation clusters, whale markers, and candle overlays (Heikin Ashi & Renko canvas primitives) return `null` from `autoscaleInfo()` (no autoscale distortion). Occupancy map is a primitive (no autoscale). 2-week-path fans return `null` from `autoscaleInfoProvider` so wide bands cannot squash candles |
| Crosshair recovery | Never clear crosshair on normal ticks or mutations so cursor lines and price/time labels persist when the mouse stops. `web/build.mjs` applies `lightweightChartsNullSafetyPlugin` to guard `barStyleFnMap` against null bar references during conflation/churn. If `update()` or `setData()` ever throws (e.g. hover races with churn), `mutateOverlaySeries` catches the error, calls `clearCrosshairPosition()`, and rebuilds/retries with `setData` and restores the range |
| `series.data()` | Production pointer-move helpers must not call it (5.2 maps the whole series) |
| Historical `update(..., true)` | Never. 5.2 rejects it with conflation enabled |
| `createChart` on 0×0 | Do not. Retry only when the container layout changes |
| `IChartApi.resize()` | No-ops while `autoSize` is on. Resume recovery and container geometry changes toggle autoSize off → `resize(w,h,true)` → on |
| Container resize auto-fit | `onChartResize` in `lightweight-chart-core.js` notifies subscribers on container dimension shifts. `lightweight-chart.js` hooks `refitOverviewIfUserHasNotPanned()` on resize so hiding/showing News, Trade, or Liqs expands or contracts the overview range to fill the new container space without leaving voids |
`positionsLine` / `positionsBox` stay out until a library bump actually exports
them. Primitive snap is `media × pixelRatio` inside `useBitmapCoordinateSpace`.

---

## Switch and overlay lifecycle

Coin and timeframe switches must paint candles first, then overlays, then
(on a requested complete-history overview) re-fit.

1. **RVWAP 4h source starts with the switch.** `switchCoin` and
   `prefetchAdjacentTimeframes` call `scheduleActiveRvwapHydration(coin)` as
   soon as the destination pair is current. Display-candle neighbours stay
   idle work. The dedicated source is 4h / 600 days (`rvwap-source-service.js`);
   display candles never feed the RVWAP math.
2. **Candle `setData` is the first paint.** Overlay rebuilds (RVWAP, manual
   AVWAP, session VWAP, visible/quarterly/monthly volume profile with LVN zones,
   liquidation clusters, whale markers, projections, CVD, oscillator) are
   `scheduleDeferredIndicatorSync` frame-sliced whenever
   `indicatorCandles.length > 0` and the LC test stub is **off**. Unit tests
   keep the stub inline so jsdom does not need to drain rAF. One test unsets
   the stub to cover the production deferral path.
3. **Overview always re-fits after overlay phases** on a pair/TF reset.
   Overlay attach can add logical indexes. Treating that shift as a user pan
   left 4h/8h/1d/1M zoomed incorrectly.
4. **Warm cache is a no-op.** If `AppState.market.candles` already **is** the
   cache array, `fetchCandles` skips `applyCandles` (no `candleSnapshotRevision`
   bump). Live ticks `update()` / `updateLast` via `mutateOverlaySeries` and
   do not reschedule overlay `setData` unless that live `update()` fails.
   Unchanged 4h RVWAP source skips the live overlay write.
5. **RVWAP phase order.** RVWAP is the first deferred overlay. Multi-preset
   `setCandles` still frame-slices only when
   `enabledLookbacks.length > 1 && source.length >= 2_000`.

jsdom does not drain `requestAnimationFrame`. Do not remove the test stub
gate to “make tests look like production”; cover deferral with the one
explicit unset-stub test instead.

---

## RVWAP visible extent (intentional clip)

RVWAP **values** are a fixed rolling window on the 4h/600-day source. Zoom
does not recompute them.

`projectRowsToDisplayAxis` (`vwap-bands.js`) **clips** plotted rows to
timestamps that already exist on the loaded display series (low TFs) or to
coarse buckets (`8h`/`1d`/`1w`/`1M`). **Omitted** `displayCandles` still
means “use the source axis.” An **explicit empty** display array returns
no rows — dumping 600d of 4h times onto a sparse `1M` series inserts extra
logical indexes and breaks Fit/overview. On 1m/5m/15m/1h the loaded display
depth is far shorter than 600 days (Hyperliquid 5000-bar cap: 1m ≈ 3.5d,
5m ≈ 17d, 15m ≈ 52d). Left-edge scrollback prepends more display bars, so
more 4h rows become eligible and the line’s visible left end **steps
backward**.

That clip is required. Plotting the full 4h span on a 5m chart would insert
extra times that are not on the candle series. Lightweight Charts then
treats those times as extra **logical indexes**, which breaks history-prepend
`addedCount` range shifts.

**Do not implement “full-span RVWAP on low TFs.”** If the visible left end
matters on a given timeframe, load more display history (scrollback) or use
a coarse TF. Matching source depth to display depth would only shorten the
backtest; it is not a substitute.

---

## Drawings and future whitespace

Placement (`pxToPoint`) and reverse mapping (`logicalIndexForTime`) share
`barInterval()`: selected-timeframe seconds, last-two-bar gap **only** for
calendar `1M`. A sparse last candle must not stretch future drawings on
render, hit-test, or drag. Production `getBarTimes` uses canonical last/prev
times, not `series.data()`.

---

## History windows

Display lookbacks (`chartrequirements` and
`web/src/chart/chart-history-requirements.js`) are the 190-day
indicator-stable window for `15m`/`30m`/`1h`/`2h`/`4h`/`8h`/`1d` (90d
viewport + 90d CVD oscillator + volume profile with 70% Value Area contrast shading & 3 tiered POCs), then
`ReachableLookbackMs` clamps to Hyperliquid’s 5000-candle retention.

| TF | Reachable depth (cap) |
|----|------------------------|
| 1m | ~3.5d |
| 5m | ~17d |
| 15m | ~52d |
| 30m | ~104d |
| 1h+ (declared 190d) | min(190d, 5000 bars) |

In-memory prepend cap is 40,000 bars. A live append that evicts the oldest
bar rebuilds via `setData` and shifts the window by the dropped count.

CVD enrichment is backend-owned and gated by `CvdEnabled`: **1m / 1w / 1M
never receive composite `cvdDelta`**. Nil means fall back to per-bar
directional delta, never serve `0`. Cross-TF identity holds only for
enriched buckets. Harness: `scripts/cvd_validation/`.

---

## Historical Whale Markers

The **Whale Markers** indicator (`whale-markers.js`) visualizes institutional
and large-volume historical activity directly on the price chart:

- **Historical Data Stream:** Evaluated strictly across completed historical
  candles (`indicatorCandles` via `selectClosedCandles`), strictly omitting
  the live/forming bar. Only when a bar completes and enters history does it
  become eligible.
- **Price & Time Coordinates:** Plotted at `time = candle.t` (in seconds) and
  typical price `price = (h + l + c) / 3` (HLC3), falling back to `c`.
- **Notional Thresholds:** Configurable via the `IND` popover with minimum
  thresholds (`≥$100k`, `≥$250k`, `≥$500k`, `≥$1M`). USD notional is
  calculated as $V \times P$ (`candle.v * candle.c`).
- **High Tape Speed & RVOL Filtering:** Evaluated against a rolling 20-bar baseline:
  - **Tape Speed Surge:** Trade count ratio $\text{tapeSpeedRatio} = n / \overline{n}_{20}$
    derived directly from the exchange `candle.n` trade feed (with graceful fallback to RVOL).
  - **Relative Volume:** $\text{RVOL} = \text{notional} / \overline{\text{notional}}_{20}$.
  - Requires an activity surge ($\max(\text{RVOL}, \text{tapeSpeedRatio}) \ge 1.8\times$) or
    extreme volume climax ($\text{RVOL} \ge 2.5\times$ or notional $\ge 5\times$ floor).
- **Structural Level Qualification:** Bars qualify only when interacting with
  important chart structure:
  - **Local Swing High / Low:** Testing or establishing 12-bar swing extremes ($h \ge \text{priorHigh}$ or $l \le \text{priorLow}$).
  - **Liquidity Sweeps / SFP:** Piercing beyond swing extremes and closing back inside ($h > \text{priorHigh} \land c < \text{priorHigh}$).
  - **Absorption Climax Wicks:** Heavy upper/lower rejection wicks ($\ge 35\%$ of bar range) at range extremes.
  - **Volatility Breakouts:** Range expansion $(h - l) \ge 1.5\times \text{ATR}_{20}$ breaking range boundaries.
  - **Volume Climaxes:** Mega institutional prints ($\ge 2.5\times \text{RVOL}$ or $\ge 5\times \text{floor}$).
- **Cluster Peak Suppression:** Multi-bar momentum cascades are clustered ($\pm 2$ bars)
  and suppressed to isolate only the dominant climax peak per event, preventing overlapping sausages.
- **Background z-Order & Visual Clarity:**
  - Series primitive `zOrder: () => 'bottom'` guarantees candlesticks, wicks, and bodies render
    cleanly *in front* of the whale markers.
  - Sized conservatively ($3.5\text{px} \dots 12\text{px}$, up to $14\text{px}$ for mega prints)
    with translucent fill ($\alpha = 0.18$) and crisp stroke ($\alpha = 0.70$) to maintain full
    visibility of price action.
- **Side Coloring:** Uses active palette colors — Bullish for buyer-dominant
  bars (`cvdDelta >= 0` or `c >= o`), Bearish for seller-dominant bars
  (`cvdDelta < 0` or `c < o`).
- **Major Prints ($\ge \$250\text{k}$):** Subtle solid inner center core.
- **Mega Prints ($\ge \$1,000,000\text{ USD}$):** Delicate outer dashed accent halo
  ring and a compact bold USD text badge (e.g. `$1.0M`, `$2.5M`, `$10M`).
- **Zero Autoscale Distortion:** Custom series primitive renderer in bitmap
  space (`useBitmapCoordinateSpace`) returning `null` from `autoscaleInfo()`.
  Includes viewport logical range culling (`ts.getVisibleLogicalRange()`).

---

## Candle Overlays (Heikin Ashi & Renko)

The Candle Overlay system renders alternative candle representations directly atop or in place of native candlesticks on the main chart pane.

- **Architecture:** Implemented in `web/src/chart/candle-overlay.js` (`createCandleOverlay`) as a custom Lightweight Charts v5.2.1 series primitive attached to the main candlestick series (`series.attachPrimitive`).
- **Bitmap Coordinate Space:** Renders in canvas bitmap space via `useBitmapCoordinateSpace`, applying DPR scaling and snapping coordinates to physical pixels for crisp wicks, brick borders, and projection dashes without sub-pixel blur.
- **Autoscale Neutrality:** Returns `null` from `autoscaleInfo()`, ensuring vertical price scale autoscale calculation remains anchored to native series prices without scaling distortion.
- **Z-Ordering:** Declares `zOrder() { return 'top'; }` to render crisply above series bodies while respecting drawing tool interactions.
- **Overlay Modes:**
  - `off`: Detaches the primitive, restoring standard native candle rendering.
  - `heikin-ashi`: Canonical smoothing formula ($O_{HA} = (O_{prev} + C_{prev})/2$, $C_{HA} = (O + H + L + C)/4$, $H_{HA} = \max(H, O_{HA}, C_{HA})$, $L_{HA} = \min(L, O_{HA}, C_{HA})$). Renders high-contrast bullish cyan (`#22cce6`) and bearish coral (`#ff5050`) fills with crisp 1px borders and centered wicks (`showWicks: true` default). Semi-translucent body fill (0.85 opacity when underlying candles are visible) preserves underlying candle structure for direct comparison.
  - `renko`: Authentic Renko horizontal step staircase sequence with continuation multi-brick expansion and standard 2-brick reversal rule.
    - **Symmetrical Initial Direction:** Evaluates the first brick symmetrically from baseline price ($close \ge ref + brickSize \implies UP$; $close \le ref - brickSize \implies DOWN$), preventing directional bias.
    - **Strict Closed-Bar Confirmation & Zero Repainting:** Renko bricks are confirmed exclusively on closed bars (`closedCandles: indicatorCandles`). Intraday price oscillations inside the unclosed forming candle cannot produce phantom bricks that disappear upon price pullbacks, guaranteeing 100% determinism and zero repainting across any ticker and timeframe. When `closedCandles` is explicitly empty (`[]`, e.g. newly listed assets before first bar close), zero bricks are produced rather than falling back to unclosed forming noise. Dynamic sizing calculations (`computeATR` with `excludeForming: true`, percent mode anchored to the latest closed bar) freeze `brickSize` against live tick noise so historical brick geometries never shift.
    - **Live Edge Shelf & Future Projections:** For visual continuity down to the live edge, `options.liveTime` extends the confirmed brick shelf horizontally across consolidation and the unclosed forming candle (`lastTime = Math.max(candleTime, liveTime)`). Forward-looking dashed trigger projection lines display exact pending continuation and 2-brick reversal price thresholds strictly for the active forming bar (`lastItem.bIdx === bricks.length - 1`); when scrolling back to historical periods, viewport culling prevents projection lines from rendering across past history.
    - **Quantized Step-Index Grid & Microcap Float Epsilon Tolerance:** Quantizes all baseline, continuation, and reversal price boundaries via `roundPrice(currentStep * brickSize, brickSize)` and tracks integer step indexes, completely eliminating IEEE 754 precision drift. Threshold comparisons incorporate relative floating-point epsilon tolerance (`EPS = Math.max(1e-15, brickSize * 1e-6)`) down to 1e-15, ensuring deterministic boundary crossing for microcap assets without premature trigger artifacts.
    - **Cross-Timeframe & Cross-Coin Update Isolation:** `updateLast` enforces strict identity verification on both `coin` (`coin && state.coin && coin !== state.coin`) and `timeframe` (`timeframe && state.timeframe && timeframe !== state.timeframe`), rejecting out-of-order in-flight ticks from prior selections and preventing time-scale contamination.
    - **Flat Candle & Zero ATR Fallback:** In `computeATR` and `computeATRPure`, if price is completely flat (`avgTr <= 0`), the calculation automatically falls back to `Math.max(1e-8, fallbackPrice * 0.002)`, preventing runaway brick counts.
    - **Candle-Time & Price Scale Locking, Zero-Stacking Non-Diagonal Architecture:** Renko bricks are strictly anchored to their originating candle's logical coordinate (`candleLeftPx = Math.round(xStart * hpr - defaultBarWidthPx / 2)`), preventing coordinate accumulation across historical candles and eliminating horizontal drift. The live edge brick strictly tracks the live forming candle without being pushed into future blank space. For multi-brick candles ($M > 1$), each candle column renders its established (final) brick level with full horizontal block width (`widthPx >= defaultBarWidthPx`), completely eliminating diagonal staircases and vertical stacking while strictly preserving time-scale synchronization with underlying base candles and Heikin Ashi. Multi-brick vertical price transitions are bridged orthogonally by the vertical connector step line linking prior close to new open. When price consolidates across candles, bricks extend horizontally as price shelves strictly abutting subsequent bricks (`rightPx = nextNominalLeft`).
    - **Orthogonal Step Connectors & Borders:** Uniform rectangular bricks with crisp 1.5px solid borders, 0.75 body opacity, and strictly vertical step connector lines linking prior closes to subsequent opens at the exact shared interface.
    - **Brick Sizing Modes:**
      - `atr`: Dynamic brick size derived from 14-period Average True Range (`computeATR`, `excludeForming: true`) with data-field normalization (`t, o, h, l, c` and `time, open, high, low, close`), price-based fallback for zero-range bars, and safety sanity floor.
      - `percent`: Percentage of last closed candle price (default 0.25%, with preset options 0.1%, 0.25%, 0.5%, 1.0%).
      - `fixed`: Absolute USD dollar amount with custom user-input field.
    - **Brick Options:**
      - Default `showWicks: false` ensuring Renko displays authentic rectangular bricks rather than traditional candles (can be toggled on).
      - Next-brick upward and downward projection dashed lines with trigger prices for the active live forming bar only.
  - `both`: Renders Heikin Ashi smoothed trend bars and Renko price bricks simultaneously on the same canvas primitive. Preserves an ergonomic visual hierarchy by rendering the smoothed Heikin Ashi bodies beneath the sharp Renko brick boundaries and orthogonal step lines, enabling confluence analysis between trend momentum and price-action structure.
- **Dimming Controls Across All Series:**
  - **Base Candle Visibility & Contrast Control:**
    - `dimmed`: Default mode when an overlay is active. Base candles render with interactive user-controlled contrast (`#candleOverlayContrastSlider`, 10%–80%, default 35%) and crisp matching borders (`borderVisible: true`), preventing dark muddy smudges and providing clear visual separation between the overlay and the underlying price wicks and open/close levels.
    - `hidden`: Native candlestick series colors are set to `transparent`, leaving only the overlay visible on the chart.
    - `normal`: Standard native candlestick opacity (100%).
  - **Heikin Ashi Dimming:** Independent `dimmed` checkbox (`#heikinAshiDimmedCheck`) and interactive opacity slider (`#heikinAshiOpacitySlider`, 5%–100%, default 50%). When dimmed, body fill uses slider alpha, while borders and wicks scale proportionally (`alpha * 1.35`, capped at 1.0) for crisp edges.
  - **Renko Dimming:** Independent `dimmed` checkbox (`#renkoDimmedCheck`) and interactive opacity slider (`#renkoOpacitySlider`, 5%–100%, default 50%). When dimmed, brick fill uses slider alpha, while borders, wicks, step connectors, and projection lines scale proportionally (`alpha * 1.35`, capped at 1.0).
  - **Dim All Convenience Toggle:** Panel header action button (`#candleOverlayDimAllBtn`) that toggles dimming across all three series concurrently: sets base candles to `dimmed` (or `normal` if undimming) and toggles both Heikin Ashi and Renko `dimmed` flags simultaneously.
- **UI & Lifecycle Integration:**
  - Toggle button (`#candleOverlayToggleBtn`) positioned directly to the left of `#drawingToggleBtn` in `.panel-controls`. Displays current active overlay mode (`Overlay: Off`, `Overlay: Heikin Ashi`, `Overlay: Renko`, or `Overlay: Both`).
  - Popover surface (`#candleOverlayPanel`) managed through standard app popover lifecycle (`closePopoversExcept`). Dynamically shows relevant configuration sections for Heikin Ashi, Renko, or both when `'both'` mode is selected.
  - **Synchronous Series Synchronization:** `candleOverlay.setCandles(nextCandles, coin, timeframe, { closedCandles })` executes synchronously inside `syncSeries` immediately after `series.setData(...)`, eliminating the 10-frame delayed animation queue in `overlayPhases` to guarantee zero visual lag and prevent stale candles or race conditions during rapid timeframe and coin switching.
  - **Live Update & Cross-Coin Protection:** Streaming ticks route to `candleOverlay.updateLast(candles, coin, timeframe, { closedCandles })` with strict coin-tag verification (`coin !== state.coin`) to discard inflight ticks from previous markets.
  - **Selective Recompute vs Redraw:** `setOptions` differentiates mathematical parameter changes (triggering `recompute()`) from visual-only adjustments (`opacity`, `dimmed`, `showWicks`, `contrast` which trigger instantaneous `redraw()`).

---

## Bump checklist (`lightweight-charts` past 5.2.1)

```sh
cd web && npm install --save-exact lightweight-charts@X.Y.Z
npm run test:run
```

Then re-check:

1. Primitive `zOrder` still a method (not a property).
2. Whether `positionsLine` / `positionsBox` now exist in typings — only then
   consider using them.
3. `update(..., true)` still rejected with conflation, or newly allowed.
4. `IChartApi.resize()` still no-ops while `autoSize` is on.
5. Overlay `update()` while the crosshair is hovering (`Value is null`).
6. Whitespace still `{ time }` only.
7. `make release` + isolated `:5002` `node scripts/chart_live_smoke.mjs`
   (do not disturb a live `:5001` user session).

---

## Isolated chart smoke

Never point the harness at a funded production window.

```sh
# Isolated server on :5002 with a copied snapshot, empty bot-state, no key.
# Then:
node scripts/chart_live_smoke.mjs
```

The harness launches Opera with an isolated profile when `:9222` is down and
stops it on exit. `PEZ_CDP_URL=""` selects Safari WebDriver.
`PEZ_CDP_NO_LAUNCH=1` requires an already-running debugger.

Acceptance: `"ok": true`, `chartCreateCount === 1`, `rejectedUpdateCount === 0`,
no `[chart] series.update() failed`. After 1m pane attach wait out the 600ms
resize guard before price-pick (harness already waits).

Use the **default** candle weight budget on isolated smoke. Setting
`PEZ_CANDLE_PRELOAD_WEIGHT_PER_MIN=50` on a snapshot that misses the admit
set is a ~15 minute REST wait, not the normal few-minute run.
