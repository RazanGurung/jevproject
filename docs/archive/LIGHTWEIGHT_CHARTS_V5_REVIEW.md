# Lightweight Charts v5 Implementation Review

> Archived 2026-08-31. Current adapter contract: [../CHART.md](../CHART.md).
> Do not extend this file.

**Date:** 2026-08-31
**Library version checked:** `5.2.1` (`web/package.json`, verified in `node_modules/lightweight-charts/dist/typings.d.ts`)
**Scope:** `web/src/chart/**` (series, overlays, drawings, theme, interaction, core)
**Review basis:** Official `lightweight-charts` agent skill (`SKILL.md`) plus the pinned `v5.2.1` typings.

---

## Verdict

The chart implementation is **v5-correct** against the official skill and the pinned **5.2.1** typings. One chart instance, `addSeries` with imported tree-shaken types, UTC-second times, `setData` vs `update`, and series primitives — no v4 helpers.

A 2026-08-31 audit against that skill found remaining adapter edge cases (not API-breaking v4 leftovers). Those are closed:

| Issue | Fix |
|---|---|
| Future-anchor **placement** used the selected timeframe, but **reverse mapping** (`logicalIndexForTime`) divided by the last two candles’ gap | Both directions now use `barInterval()` |
| CVD histogram `setData`/`update` forwarded helper flags (`isAnchor`, `whitespace: true`) | Series points are `{ time, value, color? }` or `{ time }` only |
| Oscillator live `update` skipped time-only lag rows on a short series | Whitespace `{ time }` is sent so the pane stays aligned |
| Some chart-layer converters used `1e12` while the series adapter used `1e11` | Unix-seconds vs milliseconds now share the `100_000_000_000` threshold |

Viewport stability (rebuild, prepend, head eviction, resize) and live-tick `update()` without `scrollToRealTime()` were already correct. Coin/TF switches now paint candles first and frame-slice overlay `setData` (RVWAP first), then re-fit the requested overview. Live Opera/CDP `chart_live_smoke` **320/320** after the fixes (`main-WYCTQSKA.js`).

---

## Verified compliant

| Area | Status |
|---|---|
| `chart.addSeries(SeriesType, options, paneIndex)` (no `addLineSeries` / `addCandlestickSeries`) | ✅ `lightweight-chart-core.js`, CVD, oscillator, RVWAP, AVWAP, week-path |
| `series.setMarkers` not used | ✅ No `setMarkers` / `createSeriesMarkers` (CVD resets are a data series) |
| `update()` vs `setData()` (live tick vs full history) | ✅ `lightweight-chart-series.js`; overlays `update` only the latest bar |
| UTC seconds, never `Date.now()` milliseconds on the series | ✅ `>= 100_000_000_000` → divide by 1000 |
| Whitespace is `{ time }` only (never `value: null`) | ✅ CVD / oscillator series payloads |
| No `timeScale.timezone`; no chart `watermark` | ✅ `lightweight-chart-theme.js` |
| `IPrimitivePaneRenderer` + `useBitmapCoordinateSpace` | ✅ drawings, AVWAP markers, profile, occupancy |
| Public coordinate APIs, not canvas DOM geometry | ✅ `drawing-tools.js` (DOM rect only maps global Y onto a pane) |
| `chart.remove()` lifecycle, single `createChart` | ✅ `lightweight-chart-core.js` |
| Logical range restore after canonical `setData` | ✅ prepend / snapshot / 40k-cap eviction |
| Overlay CVD scales use custom ids `cvd` / `cvdOsc` | ✅ last-value labels on; axis ticks inherit overlay defaults |
| `autoscaleInfoProvider` cheap / static | ✅ CVD symmetric; oscillator `[-1,1]`; week-path `null`; AVWAP/RVWAP unset (share `right`) |
| `zOrder: () => 'top'` | ✅ method form matches 5.2.1 `IPrimitivePaneView.zOrder?(): …` |

`positionsLine` / `positionsBox` are **not** in 5.2.1 typings. Primitives snap by multiplying media coordinates by pixel ratio inside `useBitmapCoordinateSpace`; do not invent those helpers until a library bump exports them.

---

## Remaining non-defects

- **RVWAP visible extent on low timeframes** is overlay clipping in `projectRowsToDisplayAxis`, not Lightweight Charts snapping. Values are fixed; the rendered left end follows loaded display depth. See [CHART_LOADING_AND_RVWAP_ISSUES.md](CHART_LOADING_AND_RVWAP_ISSUES.md).
- **AVWAP `updateLast` → `setData` of the full path** is required: the path is recomputed from the anchor, not a last-bar append.
- **If `lightweight-charts` is bumped past 5.2.1**, re-check whether primitive `zOrder` became a property and whether `positionsLine` exists.

No open Lightweight Charts API defects against the pinned **5.2.1**.
