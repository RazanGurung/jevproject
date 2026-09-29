# 2-Week Path Projection — Method Card

## Status and verdict

2-week path projection is a **research-only chart overlay**. It projects a
coherent path fan from the latest **confirmed closed** candle to **Monday
00:00 UTC two weeks after the current ISO week start** (remaining of this week
plus the next full week), plus optional **current calendar week** high/low
envelope levels.

Evidence status is **`unvalidated`** after a frozen walk-forward on the live
candle snapshot (`week-path-projection-walk-forward-1786546708882`). Promotion
**failed** material gates (Brier slightly worse than climatology; C50≈0.571
outside ±5pp of 0.50). C80 was inside nominal. Metrics are pinned in
[`WEEK_PATH_PROJECTION_VALIDATION.md`](WEEK_PATH_PROJECTION_VALIDATION.md) so
status is evidence-backed rather than silent. This is **not** directional
trading edge or profitability.

- Off by default; independent of the UTC-month Price Projection overlay.
- Not connected to orders, strategies, sizing, or risk controls.
- Production candidate: `week-vol-baseline-v1` (zero remaining-return median).
- Research trial: `week-wtd-analogue-v1` (WTD-state nearest neighbours; insufficient
  validation observations on this freeze to score).

## Why two weeks (not one week or 20 days)

A single remaining-week path collapses to 1–3 days late in the week and felt too
short on the chart. Stretching to **20 calendar days** would largely duplicate
Price Projection’s month-span overlay. A **week-aligned 14-day**
terminal keeps week geometry (WTD open, same remaining-length origins, week H/L
envelope) while always covering into the following week (≈8–14 days left).

## Data boundary

Same as Price Projection: confirmed Hyperliquid OHLCV only. Forming candles,
mids, marks, book, funding, OI, CVD, and account state are excluded.

## Week / horizon geometry

| Symbol | Definition |
|--------|------------|
| Week start | Monday 00:00 UTC containing the origin bar |
| Calendar week end | Next Monday 00:00 UTC (`isoWeekEndUnix`) |
| Path terminal (`weekEnd` field) | Week start + **14** calendar days (`twoWeekHorizonEndUnix`) |
| Remaining bars | Exact integer bars from origin bar time to path terminal for the chart TF |
| Week open | Close of first bar with time ≥ week start (WTD / envelope still use the **current** calendar week) |
| Horizon weeks | `HORIZON_WEEKS = 2` |

Unsupported: `1w` / `1M` (horizon ≤ bar), dense `1m`/`5m` full-window paths
above `MAX_WEEK_PATH_BARS` (336 = 14×24 on 1h). Primary TFs: **1h / 2h / 4h / 8h**; `1d` ok.

Late-week example (2h): Sunday last bar has **85** remaining bars (~8d) instead of **1**.

## Model

### Volatility baseline (`week-vol-baseline-v1`)

1. Multiperiod HAR RV scale for each remaining step (shared with Price Projection).
2. Historical origins with the **same remaining bar length** (or, for the vol
   baseline, the **same remaining-day class** with at least as many realized
   bars) contribute full Z-paths of length `horizon`; coherent terminal-rank
   quantiles select five trajectories.
3. Live scale restores log-return paths; median pinned to **zero**.
4. Multiplicative λ calibration + ACI-lite on drawn paths (shared scorers).
5. Envelope: weighted quantiles of path max/min Z, scaled, combined with **current-week** WTD H/L.

### Day-class pooling

Exact same remaining-bar-length origins are sparse (~1/week). The vol baseline
also accepts candidates in the **same remaining-day class** (1..14) when the
candidate has **at least** `horizon` realized bars (first `horizon` steps used).
Unit tests cover: exact match, longer same-class accept, shorter reject,
cross-class reject, non-baseline exact-only.

### WTD analogue (`week-wtd-analogue-v1`)

Conditions on week-to-date features (normalized WTD return, range used, vol ratio,
close location, remaining **2-week horizon** fraction) among same-length remaining origins.

## Calibration

- Non-overlapping origins separated by the remaining horizon (same length, or same day-class for baseline).
- Minimum origins scale with remaining-day class (**5–12**; longer remaining windows need fewer non-overlapping blocks to fit ~90d history).
- Remaining-day class is **1..14**. Day-class pooling keeps 8–14d remaining usable on typical ~90–180d chart depth.
- Recency half-life **90 calendar days** (shorter than multi-day Price Projection).
- BT50/BT80 are pre-ACI; chart may show drawn ACI factors separately.

## Frozen walk-forward

```text
node scripts/week_path_projection_validation.mjs \
  --snapshot data/candle-snapshot.json.gz \
  --output docs/WEEK_PATH_PROJECTION_VALIDATION.json \
  --markdown docs/WEEK_PATH_PROJECTION_VALIDATION.md \
  --coins BTC,ETH,SOL \
  --timeframes 1h,2h,4h
```

Harness expands snapshot v1 row and v2 columnar series. Scorer is shared
`scorePrequentialForecasts` (pre-ACI). Promotion uses the same material gates as
Price Projection (Coverage ±5pp, Brier ≤ climatology, subgroup undercoverage).

Latest freeze: **FAIL / unvalidated** — see
[`WEEK_PATH_PROJECTION_VALIDATION.md`](WEEK_PATH_PROJECTION_VALIDATION.md).

## Implementation map

- model: [`web/src/research/week-path-projection.js`](../web/src/research/week-path-projection.js)
- chart re-export: [`web/src/chart/week-path-projection.js`](../web/src/chart/week-path-projection.js)
- chart adapter: [`web/src/chart/week-path-projection-indicator.js`](../web/src/chart/week-path-projection-indicator.js)
- validation harness: [`scripts/week_path_projection_validation.mjs`](../scripts/week_path_projection_validation.mjs)
- frozen validation report: [`docs/WEEK_PATH_PROJECTION_VALIDATION.md`](WEEK_PATH_PROJECTION_VALIDATION.md)
- tests: [`web/src/chart/__tests__/week-path-projection.test.js`](../web/src/chart/__tests__/week-path-projection.test.js),
  [`week-path-projection-indicator.test.js`](../web/src/chart/__tests__/week-path-projection-indicator.test.js)
- UI: IND panel group **2-week path projection** (`web/index.html`, `chart-indicator-ui.js`)

### Indicator recompute signature

Same pattern as Price Projection: coin, timeframe, envelope option, snapshot
`revision`, length, and sampled OHLCV at first / Q1 / mid / Q3 / tip.

## Honesty bar

- Zero-median remaining path is the honest center line for the baseline.
- Envelope levels are distributional extremes on the current calendar week plus path extremes, not entry/exit signals.
- No finite-sample coverage guarantee on dependent financial series.
- Distinct from Price Projection: week-aligned remaining horizon + WTD envelope vs UTC-month start-to-end fans paired with monthly profiles.
- Evidence remains **unvalidated** until a future freeze passes promotion gates.
