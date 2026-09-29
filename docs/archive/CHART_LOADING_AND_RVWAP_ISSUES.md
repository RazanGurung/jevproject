# Chart Loading Smoothness & RVWAP Lookback — Issue Analysis and Fix Plan

> Archived 2026-08-31. F1–F3 shipped; F4 rejected. Current contract:
> [../CHART.md](../CHART.md). The body below still says “No code was changed”
> and is historical. Do not extend this file.

**Date:** 2026-08-31
**Library:** `lightweight-charts` v5.2.1
**Scope:** `web/src/chart/**`, `web/src/services/**`, `web/src/state/**`

**Status (2026-08-31, follow-up):** F1–F3 are implemented. Symptom 2 (low-TF RVWAP extent growing on prepend) remains overlay clipping on purpose: extra 4h times that are not already on the candle series become extra logical indexes and would break history-prepend range shifts. Keep `projectRowsToDisplayAxis` clipped to display timestamps.

Two reported symptoms are analyzed:

1. **Chart isn't smooth / lags after switching coins or timeframes**, even though pre‑loading exists.
2. **RVWAP lines appear to change their historical lookback when zooming in/out**, especially on lower timeframes.

Both were root-caused with file/line evidence. No code was changed; this document defines the issues and the fixes.

---

## Symptom 1 — Switch is not smooth despite preloading

### 1.1 What preloading actually covers (and what it does NOT)

The preload path (`prefetchAdjacentTimeframes` in `services/chart-candle-service.js:687`, and `candleCache`) warms **only the display-candle series** for the target coin/timeframe. A coin switch then paints cached candles immediately (`chart-candle-service.js:440-462`).

**The preload does NOT cover the RVWAP source.** The RVWAP overlay is computed from a **separate, dedicated 4h/600-day dataset** (`services/rvwap-source-service.js:33` `RVWAP_SOURCE_LOOKBACK_MS = 600 * DAY_MS`, interval `'4h'`). This source lives in its own `rvwapSourceCache` and is hydrated only by its own network call (`rvwap-source-service.js:393`, triggered via `scheduleActiveRvwapHydration` at `chart-candle-service.js:412/461/571`). Until that 600-day 4h response arrives:

```js
// chart/lightweight-chart.js:82-90
function rvwapSourceRowsForCoin(coin) {
  const cached = rvwapSourceCache.get(coin);
  if (!Array.isArray(cached) || cached.length === 0) return [];
  const status = AppState.market.rvwapSource || {};
  if (status.coin === coin && status.status === 'ready') return cached;
  const meta = rvwapSourceMetaCache.get(coin);
  if (meta?.complete === true) return cached;
  return [];                       // <-- cold source => empty RVWAP for the whole switch frame
}
```

**Effect:** on the first visit to a coin, the candle series paints immediately (preloaded), but the RVWAP bands render **empty** and then "pop in" later when the background 4h hydration completes. This is a large part of the "laggy even though preloaded" perception.

### 1.2 One synchronous frame does all the heavy work

The switch funnels into one call: `syncLightweightChart()` (`chart/lightweight-chart.js:527`), which runs **synchronously inside** the throttled-rAF `onDraw()` (`chart-render.js:372-384` → `buildRenderModel` → `syncLightweightChart`). Within that single frame:

| Work | Location | Cost |
|---|---|---|
| `recreateMainSeries()` — `removeSeries(candleSeries)` + `addSeries(CandlestickSeries, …)` | `lightweight-chart-core.js:401-424` | series/pane churn |
| `notifySeriesRecreate()` detaches **all 8 overlays** synchronously, each removing their own series | `lightweight-chart.js:335-347` | many `removeSeries` calls |
| `candleSeries.setData(buildCandlestickData(nextCandles))` — full array | `lightweight-chart-series.js:287` | full LC data rebuild |
| **RVWAP `setCandles` — full `ingestBar` loop + 5×`setData` per preset** | `lightweight-chart.js:588-603` → `vwap-bands.js:549-591` | heaviest sync block |
| viewport `fitActiveCandleViewport(...)` + `setVisibleLogicalRange` | `lightweight-chart.js:721-753` | re-layout |

### 1.3 The debatable deferral gate

The heavy indicator phases (manual AVWAP, monthly profile, price projection, week-path, CVD, CVD-oscillator) are deferred across frames **only when `indicatorCandles.length >= 1_500`** (`lightweight-chart.js:671-708`).

- On a short/low-timeframe history the gate does **not** trigger, so all six overlays run **synchronously** in the switch frame.
- Even when it does trigger, the **main series + RVWAP still run synchronously in frame 1**, then the rest paint over the following ~6 frames → visible multi-frame "pop-in."

Additionally, the RVWAP set has its **own** deferral gate that only activates when `enabledLookbacks.length > 1 && source.length >= 2_000` (`vwap-bands.js:812`). For the common single-preset case it always runs synchronously.

### 1.4 Cached re-apply still forces a full recompute

`chart-candle-service.js:446` re-applies cached display candles as a **new snapshot**, which increments `candleSnapshotRevision` (`state/market-state.js`). Every overlay signature includes `snapshotRevision` (e.g. `vwap-bands.js:547`, `cvd-indicators.js:305`), so even a fully warm switch recomputes every overlay from scratch rather than skipping.

### 1.5 Per-timeframe storage caps (relevant to both symptoms)

From `chart/chart-history-requirements.js`:
- `UPSTREAM_CANDLE_CAP = 5000` bars per fetch (line 7).
- Display lookback per timeframe (`CHART_DISPLAY_LOOKBACK_MS`, lines 31-43):
  - `1m=7d`, `5m=20d`, `15m/30m/1h/2h/4h/8h/1d=190d`, `1w=720d`, `1M=3100d`.
- The in-memory infinite loader can prepend up to `maxLoadedCandles = 40000` bars (`chart-history-loader.js:25`), but the upstream store caps at 5000 bars per response.

---

## Symptom 2 — RVWAP "lookback" appears to change when zooming (low timeframes)

### 2.1 The RVWAP values never change with zoom

The RVWAP math is **deterministic**: it is a fixed rolling time-window computed only over the fixed 4h/600-day source, plus config. The display candles never feed back into the computation:

- `setCandles` (`vwap-bands.js:535-566`) ingests `sorted = dedupeAndSort(candles)` — the 4h source only.
- `ingestBar` (`vwap-bands.js:190-317`) uses rolling windows keyed on wall-clock seconds (`tMs = lkbSec(config.lookback)`, line 212) and elapsed time from the first *source* bar (`state.firstBarTime`, lines 200/241). No display dependency.
- The warmup/plot gate (`vwap-bands.js:241-243` `if (elapsed >= plotAfterSec)`, and the `elapsed >= tMs` band gate at line 284) is anchored to the fixed 600-day source start, so it does **not** move with zoom.

**Conclusion:** zoom never changes the computed RVWAP data.

### 2.2 The rendered *extent* is clipped to loaded display history — that is what you see

After computing rows, `projectRowsToDisplayAxis` (`vwap-bands.js:349-383`) selects which rows to **render**:

- For **low timeframes** (`5m`, `15m`, `1h`, … not in `COARSE_DISPLAY_TIMEFRAMES`, line 341):
  ```js
  // vwap-bands.js:359-362
  if (!COARSE_DISPLAY_TIMEFRAMES.has(displayTimeframe)) {
    const activeTimes = new Set(displayTimes);
    return sourceRows.filter((row) => activeTimes.has(Number(row?.time || 0)));
  }
  ```
  The RVWAP line is kept **only at 4h-boundary timestamps that already exist in the loaded display array**.

- On low timeframes the display history is far shorter than the 600-day source (e.g. `5m=20d`, `1m=7d`; see §1.5). So the visible left end of the RVWAP line equals `max(intrinsic source start, earliest loaded display timestamp)`, and the **display part dominates** → the RVWAP line is truncated to display depth.

- The infinite-history loader grows the display array in **1000-bar prepend chunks** whenever you zoom into the left edge (`chart-render.js:205-227` → `ensureHistoricalCandles` → `chart-history-loader.js:43-121`, cap 40000 bars). Each prepend extends `displayTimes`, so `projectRowsToDisplayAxis` admits more 4h rows and the RVWAP line's visible left end **steps backward** each chunk.

**Net effect:** the RVWAP *values* are constant, but the *visible backtest extent* is a step function of how much display history is currently loaded. Zoomin in/out on a low timeframe makes the line appear to gain/lose historical lookback. Since coarse timeframes (`1d/1w/1M`) use the always-full-sweep bucket branch (`vwap-bands.js:364-382`), the artifact is far less visible there — matching "especially on lower timeframes."

### 2.3 Open-candle handling and the 365D source — NOT the cause (on low TFs)

- `selectClosedCandles` (dropping the unclosed candle) is time-constant and does not depend on zoom (`market-candles.js`). It only guards the live tail; harmless.
- `resolveTwapSource` (`vwap-bands.js:130-147`) can flip the **365D** TWAP from the 4h source to display candles when display starts earlier. On low timeframes the display never starts before the 600-day source, so it never flips there (it can on coarse timeframes with >600 days of display history — a genuine, data-driven change, not zoom-driven).

---

## Fix plan

### F1. Warm the RVWAP 4h source during coin-switch preloading (Symptom 1 — biggest win)

**Problem:** the display preload does not warm the separate 4h/600-day RVWAP source, so a switch paints empty RVWAP then fills in.

**Fix options:**
- (Preferred) In `prefetchAdjacentTimeframes` / the coin-switch path (`services/coin-switch.js`), also call `scheduleActiveRvwapHydration(targetCoin)` (or `queueRvwapHydration(...)`) for the coin being switched to, so the 4h source is requested in parallel with the display history and is ready when the first frame paints.
- Ensure `rvwapSourceRowsForCoin` (`lightweight-chart.js:82-90`) can adopt the cache as soon as it's complete even if `status` lags the meta (it partially does via the `meta?.complete === true` branch — but the hydration must complete before that branch helps).

### F2. Un-defer / threshold the heavy overlays consistently (Symptom 1)

**Problem:** the `>= 1500` gate (`lightweight-chart.js:671`) leaves short histories fully synchronous, and the main series + RVWAP always run synchronously regardless.

**Fix options:**
- Lower/remove the gate so the 6 indicator phases are **always** frame-sliced through `scheduleDeferredIndicatorSync` once `candles.length > 0` (or use a bar-count threshold that always holds for a switch).
- Make the RVWAP set defer more aggressively: drop the `enabledLookbacks.length > 1 && source.length >= 2_000` condition (`vwap-bands.js:812`) so RVWAP `setCandles` is always chunked/frame-sliced too.
- Optional: split the `candleSeries.setData(...)` and the viewport fit so they are not both in the same synchronous frame (e.g. fit a frame after data paint).

### F3. Short-circuit warm snapshots (Symptom 1)

**Problem:** re-applying cached candles as a new snapshot increments `candleSnapshotRevision` and forces full overlay recompute even on a warm switch (`chart-candle-service.js:446`).

**Fix:** skip the re-apply (and thus the revision bump) when `cacheAlreadyApplied && getCandles() === cachedCandles` and the series is already painted with that exact data (the code already has a partial guard at line 445; extend it to the active path so a warm switch is a fast no-op).

### F4. Render RVWAP at its full 4h-source span instead of clipping to display depth (Symptom 2)

**Problem:** `projectRowsToDisplayAxis` (`vwap-bands.js:349-383`) drops RVWAP rows whose timestamps aren't present in the loaded display array, so low-TF display depth truncates the line and zoom-out prepends re-extend it.

**Fix options:**
- (Preferred) For low timeframes, do **not** clip RVWAP rows to display timestamps. Compute the `{time, value}` points at 4h resolution over the full source span and render them directly. Lightweight-charts accepts arbitrary 4h timestamps on the shared time axis even if the candle series has different resolution; the comment at `vwap-bands.js:343-348` worried about axis compression on coarse timeframes, which is why the bucket branch exists — keep the coarse branch, but let intraday timeframes render the full 4h-span RVWAP so zoom doesn't truncate/extend it.
- Alternative: keep the current clipping but have the RVWAP source depth match the minimum display depth so it doesn't "grow" — this only hides the symptom and would shorten the backtest, so it is **not recommended**.

### F5. (Consider) RVWAP source depth per timeframe (optional enhancement)

If the goal is for the RVWAP line to always show a stable, full lookback on every timeframe, the cleanest semantic fix is to ensure the 4h RVWAP source covers at least as far back as the longest display timeframe you support on that chart (or simply always 600 days). Combined with F4, the RVWAP line would be stable and never appear to change with zoom.

---

## Validation / measuring the fixes

The code already contains frame-phase instrumentation gated behind
`globalThis.__PEZ_PERF_ENABLED__ === true`, writing to `__PEZ_CHART_PHASES__`
(`lightweight-chart.js:369-379`, `recordChartPhase`). To confirm before/after:

1. Enable the flag, switch coins with a **cold** RVWAP source vs. a **warm** one, and inspect the `'main-series'`, `'rvwap'`, `'total'` phase durations.
2. On a 5m chart, zoom fully out and record whether the RVWAP line's visible left end jumps as left-edge chunks load; after F4 it should be stable across zoom.

---

## Summary table

| # | Symptom | Root cause | File:Line | Recommended fix |
|---|---|---|---|---|
| 1 | Switch lag | RVWAP 4h/600-day source is a cold dependency not covered by display preload | `lightweight-chart.js:82-90`, `rvwap-source-service.js:393` | F1 — warm it during switch |
| 2 | Switch lag | All heavy work runs in one synchronous frame | `lightweight-chart.js:527,588-603,671` | F2 — always frame-slice overlays |
| 3 | Switch lag | Warm snapshot re-apply forces full overlay recompute | `chart-candle-service.js:446` | F3 — no-op warm switches |
| 4 | RVWAP lookback "changes" on zoom | Line clipped to loaded display history, which grows in prepend steps on low TFs | `vwap-bands.js:349-383`, `chart-history-loader.js:43-121` | F4 — render full 4h-source span |
| 5 | (context) | Low-TF display depth is far shorter than 600-day source | `chart-history-requirements.js:31-43` | F5 — optional depth alignment |
