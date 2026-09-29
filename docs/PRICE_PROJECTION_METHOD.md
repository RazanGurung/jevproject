# Price Projection Method, Audit, and Model Card

## Status and verdict

Price Projection is a **research-only chart overlay**. The live product is a **UTC-month occupancy map** for the **current month
only**. Quantile fan lines are computed for calibration diagnostics but are
not drawn. Eligible months for the library are those Monthly Volume Profile
would render (last 6 UTC months, ≥5 bars, valid range). The drawn map
originates at
the last closed bar **before** that UTC month open and covers that month’s
own bars (`[monthStart, monthEnd)`). A new close inside the live month does
**not** move the origin or shorten the horizon. It only refreshes analogue
weights from month-to-date auction state and redraws the occupancy grid.

The display model is `month-open-map-v1` (`pathModel` `month-open-occupancy`).
Evidence status is **`unvalidated`**. The retired 5/10/20-day freeze
(`price-projection-walk-forward-1786425347395`) does **not** transfer to this
month-aligned horizon. That is **not** a claim of directional trading edge or
net profitability.

- `ready` means the calculation completed with enough history.
- The live median is the analogue-conditional 50th percentile, shrunk toward
  zero by \(cESS/(cESS+10)\). The archived `volatility-baseline-v1` candidate
  still pins its median at zero log-return.
- The overlay is **off by default** and is **not** connected to orders, strategies,
  sizing, or risk controls.

Earlier additive CQR residual wideners only expanded bands and over-covered on the
same frozen protocol (C50≈0.557, C80≈0.896). The August 10, 2026 multiperiod-HAR +
multiplicative interval-scale pass brought coverage inside the ±5pp promotion
window while keeping the zero-median baseline.

## Data boundary

Inputs are confirmed Hyperliquid OHLCV candles only: open/close timestamps,
exchange OHLC prices, and exchange-reported base volume. The shared close-time
resolver excludes forming candles. Mids, marks, order book, funding, open
interest, CVD, account state, and the display-only live candle are excluded.

Rows must have positive valid OHLC, non-negative finite volume, strict timestamp
ordering, and exact selected cadence. **Gaps:** the model keeps the **trailing
contiguous regular-cadence segment** ending at the latest closed bar; an older
gap no longer discards the entire series (only a short trailing clean segment
fails as insufficient history). A newly closed candle **inside the live UTC month** rebuilds only the live
month-from-open occupancy (historical months are identity-stable). An
authoritative closed-history revision, or a change to the prefix before the
latest month open, rebuilds the frozen historical fans as well.

User-facing **live** horizon is the **full UTC month from the open**. Live
month-to-date state reweights analogues; it does not rebase the origin.
Lookback history is day-denominated (**90** day minimum on
sub-daily charts, **60** on daily/weekly, **1000** day maximum), not a fixed
bar count. Each span is converted to bars for the active chart timeframe
(`bars = spanSeconds / barSeconds`). Weekly/monthly bars, and paths denser
than 31 days of 1h bars, are rejected with an explicit unavailable reason
rather than silently rounded.

**Calibration depth** for a month-length window is ≥4 non-overlapping origins
so typical ~2k-bar 2h charts remain usable. If that sample is missing for a
given month, the month still draws with raw analogue widths. The overlay is
unavailable only when **no** profile month has a valid origin forecast.
Drawn interval factors stay at **λ = 1** (raw analogue width) until at least
**10** prequential residual scores exist; the 80th percentile of two
month-block λ samples is not a width estimate.

**Month seams:** each profile month is its own Lightweight Charts line
series set (50% inner fan plus an 80% envelope). Historical 80% is dotted
and faint so walk-forward containment is visible without burying price or
the 50% fan; the live month keeps the stronger dashed 80%. Completed months
end on their last in-month bar so they do not share the next UTC month open
with the following origin (same-x endpoints read as a vertical even on
separate series). The live month-from-open fan still reaches month end
from the month open.

For origin `t` and bar horizon `h`, the return target is:

```text
R(t,h) = log(C[t+h] / C[t])
P(t,h,q) = C[t] × exp(Qq(t,h))
```

## Model candidates

The live display model is `month-open-map-v1`. The archived day-horizon freeze
still compares these three predeclared candidates:

1. `volatility-baseline-v1`
2. `analogue-volatility-v2`
3. `analogue-v1` (legacy reproduction)

`month-open-map-v1` is scored separately on completed UTC-month opens
(`--origin-mode month-open`). That report is **monitoring**, not a locked
freeze, until a month-aligned protocol is intentionally promoted.

### Volatility baseline

One-bar log returns feed a **multiperiod HAR** realized-variance cascade
(Corsi-style short/medium/long on 8 / 32 / 96 bars, then multi-step mean
reversion toward long-run RV). The live month-from-open cone evaluates HAR
at the month-open origin for the full month \(h=T-t_0\). Width still mixes the
**previous UTC month’s** realized variance (weight 0.20) as a completed
auction prior, then blends month-to-date RV/volume/semivar with weight at
most half the elapsed month (so the prior never drops below 50%). Both
sides scale by \(\sqrt{V/\bar V}\) and the 80% tilts with signed
semivariance. The median stays zero — last month’s *direction* is not a
point forecast.

```text
RVs = mean of last 8 squared returns
RVm = mean of last 32 squared returns
RVl = mean of last 96 squared returns
σ²_har(t) = 0.40·RVs + 0.35·RVm + 0.25·RVl
LR(t)     = RVl   (long-run anchor)
ρ         = exp(-ln 2 / 32)   # variance half-life ≈ 32 bars
CumVar(t,h) = h·LR + (σ²_har - LR)·(1-ρ^h)/(1-ρ)
scale(t,h)  = sqrt(CumVar(t,h))

Z(i,h) = R(i,h) / max(scale(i,h), 1e-10)
```

When `σ²_har ≈ LR`, this recovers ordinary `σ√h`. After a vol spike
(`σ²_har ≫ LR`), longer horizons tighten relative to pure local constancy.

**Displayed bands (baseline candidate):** `volatility-baseline-v1` still
takes quantiles of terminal HAR-normalized \(Z(i,H)\) and broadcasts them
through live `scale(t,h)` with \(h\) the full month from the open.
Analogues are **reweighted** by how
similar their month-to-date auction was to the origin’s auction: VWAP
location inside the month range (the same information the monthly profile
shows), log RV, log volume, signed semivariance, and log range — plus
recency. On a live month-open origin the previous completed month is the auction
prior; MTD of the current month reweights analogues at the same elapsed
fraction without moving the origin.
The median is the state-conditional 50th percentile, **shrunk toward zero**
by \(cESS/(cESS+10)\). Few similar months → random-walk center. Many → a
small tilt the data actually earned. Width uses previous-month RV, volume,
and signed vol as the prior, blended with MTD on the live month. That is a
scale-free FHS cone: width grows with the multiperiod HAR scale from the
origin. A single terminal-rank
trajectory is often on the wrong side of zero for the first 1–2 weeks of a
28–31d month; pinning the median to zero then clamped that stretch to a
flat origin line.

The volatility analogue still uses per-step weighted quantiles of its
nearest-neighbour library. Terminal-rank coherent paths remain a tested
helper and the legacy `analogue-v1` display. Intermediate values are still
ordered around the (possibly pinned) median so multiplicative calibration
sees real half-widths.

The production baseline then forces the **median path to zero** (random-walk
point forecast) while keeping vol-adaptive outer bands. Eligible origins use
the full retained day window (up to **1000** calendar days), weighted with a
**250-day** recency half-life. `UpFreq` is the weighted frequency of positive
terminal outcomes among those trajectories, not a calibrated probability.
Projection line colors use the Colors-menu **AVWAP** swatch.
`volModel` label: **`har-month-conditioned-rv`**. The 8/32/96 helper remains
`har-multiperiod-rv` for week-path and unit tests.

**Multiplicative interval scale + ACI-lite:** a conformity factor `λ` measures
how far the **terminal** outcome sits from the median in units of the raw band
half-width (`λ=0` at the median, `λ=1` at the raw edge, `λ>1` outside). Rolling
prequential quantiles of terminal `λ` (window 48, levels 0.50 / 0.80) produce a
single pair of factors, **broadcast uniformly** along the path (no artificial
`[0.4, 2]` hard cap — only non-finite/non-positive factors are rejected).
Independent per-step factors were rejected: intermediate coherent paths are
often tight after reordering and produced mid-fan explosions. After scaling,
**per-side nesting** proportionally scales each half of the 50%/80% bands so the
peak intermediate extreme never exceeds the terminal on that side, while
preserving path shape (absolute hard clamps created multi-step flat plateaus).
Degenerate raw half-widths contribute `λ=0` so they cannot manufacture infinite
scale factors.
Live chart rendering then applies mild ACI-style inflate/deflate on that factor
(Gibbs–Candès spirit, not a full online α recursion). Promotion BT50/BT80 use
**pre-ACI** terminal factors only.

### Volatility-scaled analogue

The v2 analogue uses the same filtered target but conditions it on historical
states. Its base state contains normalized momentum at 1/3/8/24 bars, short/long
volatility ratio, true range, close location, candle body, log-volume z-score,
and signed relative volume. It adds `log(σ32)` so absolute volatility regime is
not discarded.

At every origin, feature scales are computed from eligible historical candidates
only using `IQR / 1.349`; no future or current-query values enter scaling. The
nearest 120 states use standardized Euclidean distance, Gaussian similarity, and
the fixed recency weight.

### Month-open occupancy map

`month-open-map-v1` is the live research display. Candidates prefer **month-open
origins** (the last bar of each prior UTC month). Each analogue is scored with
the analogue-v2 OHLC/volume vector, recency, previous-month auction similarity,
and — on the live month only — auction similarity at the same elapsed fraction
of the analogue’s subsequent month. The chart draws a close-return occupancy
map: 80 bins × ~60 slices, clipped to the 80% highest-density interval of the
**displayed** measure. Each analogue month-open path is filtered-historical-
simulation scaled (\(Z_i(h)\times\sigma_{\mathrm{live}}(h)\)). Weights are a
**single product kernel** — state similarity × soft previous-month auction
tilt \((0.35+0.65K_{\mathrm{auc}})\) × optional soft elapsed-fraction tilt ×
recency — not a sequential overwrite of the analogue weights.
The displayed occupancy is the empirical-Bayes mix
\(\alpha p_w + (1-\alpha)p_{\mathrm{clim}}\) with
\(\alpha=cESS/(cESS+10)\) and \(p_{\mathrm{clim}}\) the recency-weighted
month-open climatology on the same embargoed library. Thin analogue ESS
therefore falls back toward “what months usually did,” not toward a blank
map. Elapsed month-to-date cells stay faint; remaining-horizon cells stay at
the Colors-menu **MAP** swatch (`projection`). Median path lines are not drawn.
If the month-open library is too small to form a pool, the month falls back to
`volatility-baseline-v1` at the same month-open origin. Quantile fans are still
computed for BT50/BT80 but are not drawn.

### Legacy analogue

`analogue-v1` preserves the original ten clipped features, nearest 60 candidates,
raw-return targets, distance kernel, and recency weighting. It exists for
differential testing and historical comparison, not as the active model.

## Dependence, calibration, and diagnostics

Candidates must satisfy:

```text
i + H <= t - 32
```

This embargo prevents direct target leakage. It does not create independence.
The model therefore reports both:

- `wESS = (Σw)² / Σ(w²)` for weight concentration;
- `cESS`, the same calculation after weights are aggregated into fixed
  horizon-sized outcome blocks.

Rolling calibration origins are separated by the entire forecast horizon, so
terminal outcomes do not overlap. Up to 60 origins are retained. Minimum origins
scale with horizon (20 / 16 / 12 for 5d / 10d / 20d). Prequential coverage needs
at least half that many earlier scores (floored at 10).

For raw interval `[L,U]`, median `m`, and outcome `y`, calibration uses the
multiplicative scale factor:

```text
λ = max( (m - y) / max(m - L, ε), (y - m) / max(U - m, ε), 0 )
```

Empirical 50th/80th quantiles of rolling `λ` rescale the half-widths
(`L' = m - λτ·(m-L)`, `U' = m + λτ·(U-m)`). Unlike additive CQR residuals, this
can **shrink** over-wide fans as well as widen under-wide ones. It remains
empirical calibration only: financial time series are dependent and
non-exchangeable, so no finite-sample coverage guarantee is claimed.
Deterministic moving-block bootstrap intervals accompany recent MAE, pinball,
Brier, and coverage metrics.

Diagnostics include:

- median MAE and skill versus zero return;
- five-quantile pinball loss and skill versus the volatility baseline;
- Brier score and skill versus expanding historical prevalence;
- 50%/80% terminal coverage, width, and interval score;
- `wESS`, overlap-adjusted `cESS`, origin count, and origin separation.

Quantile lines are marginal at each horizon, not coherent simulated paths or a
joint claim that a trajectory remains inside a band.

## Frozen walk-forward validation

Run:

```text
node scripts/price_projection_validation.mjs \
  --snapshot data/candle-snapshot.json.gz \
  --output docs/PRICE_PROJECTION_VALIDATION.json \
  --markdown docs/PRICE_PROJECTION_VALIDATION.md
```

### Shared residual scoring (live ≡ offline)

Live chart diagnostics and the offline harness both call
`scorePrequentialForecasts` from `price-projection.js`:

- multiplicative `λ` factors accumulate **per step** over the full multi-bar path
  in a rolling window (default 48);
- terminal 50%/80% coverage uses `λ` quantiles estimated only from **earlier**
  origins (prequential);
- promotion C50/C80 therefore match the UI **BT50/BT80** fields.

`applyPathCalibration` (multiplicative factors + **ACI-lite** inflate/deflate +
ordered quantiles + per-side nest) is the live **path rendering** step. ACI-lite
can move drawn bands relative to diagnostic factors; it is intentionally **not**
folded into promotion coverage so BT50/BT80 match offline gates. The UI labels
BT as pre-ACI and surfaces `drawn×…` when ACI changes the chart factors.

### Protocol

The harness uses chronological development/validation/frozen-test partitions,
origins separated by the forecast horizon (in bars), all three supported
calendar-day horizons (5/10/20), and the three declared model trials. Selection
minimizes validation five-quantile pinball loss; candidates within 1% defer to
the simpler model. The test period is then evaluated once.

Promotion requires all of the following on the frozen test:

- pinball loss no worse than the volatility baseline
  (**identity / vacuous** when the selected model *is* the zero-median baseline);
- MAE no worse than zero return
  (**identity / vacuous** for the zero-median baseline, because median log-return
  is pinned at 0 so MAE ≡ |R|);
- Brier score no worse than expanding prevalence;
- pooled 50%/80% coverage within five percentage points of nominal;
- no sufficiently sampled timeframe/horizon subgroup undercovered by more than
  ten percentage points.

Failure leaves `evidenceStatus: unvalidated`. Passing these forecast gates sets
`evidenceStatus: validated-frozen-test` but still does **not** establish net
trading profitability; that would additionally require a predeclared decision
rule, costs, spread, slippage, latency, capacity, and a separate untouched test.

The checked-in BTC/ETH/SOL **day-horizon (5/10/20)** report selected the
volatility baseline (simplicity default). Promotion **passes** on the multiperiod
HAR + multiplicative scale path (unclamped λ factors, terminal broadcast +
per-side nest): C50/C80 within ±5pp of nominal, Brier ≤ climatology, no material
subgroup undercoverage. Pinball/MAE gates remain identity for the zero-median
baseline. See
[`PRICE_PROJECTION_VALIDATION.md`](PRICE_PROJECTION_VALIDATION.md)
(`price-projection-walk-forward-1786425347395`).

## Scientific references and literature map

This section maps **every quant method used in code** to a primary citation, then
lists methods that are **not** implemented. It is not a claim of SOTA completeness.

### Implemented methods → citations (complete for current code)

| Method in `price-projection.js` | Primary citation(s) | Fidelity |
|---------------------------------|---------------------|----------|
| Log-return multi-horizon targets \(R=\log(C_{t+h}/C_t)\) | Campbell, Lo, and MacKinlay (1997), *The Econometrics of Financial Markets* | Standard textbook use |
| Zero-median random-walk point forecast (production baseline) | Textbook efficient-market / martingale benchmark (see CLM 1997) | Exact: median path pinned at 0 log-return |
| Multiperiod HAR realized variance (8/32/96 bars, weights 0.40/0.35/0.25; mean-reversion to RV_long, half-life 32 bars) plus previous-UTC-month RV mix (0.20), volume width, signed RV tilt | Corsi (2009), [A Simple Approximate Long-Memory Model of Realized Volatility](https://doi.org/10.1093/jjfinec/nbp001); Andersen, Bollerslev, Diebold, and Labys (2003); Barndorff-Nielsen and Shephard semivariance; volume–variance (Lamoureux–Lastrapes) | **Multiperiod lite + month state:** not fitted HAR-RV; volume/semivar are bounded width multipliers, not a directional model |
| Month-from-open occupancy map: origin = last close before UTC month open; live MTD multiplies an elapsed auction kernel (does not replace state weights) | Filtered historical simulation of complete month paths (Barone-Adesi et al. 1999); occupancy = product-kernel Nadaraya–Watson measure mixed with recency climatology | \(\hat p=\alpha p_w+(1-\alpha)p_{\mathrm{clim}}\), \(\alpha=cESS/(cESS+10)\). James-Stein / Dirichlet-multinomial shrink; not a published month-occupancy paper. Evidence still unvalidated |
| Heteroskedasticity motivation | Bollerslev (1986), [GARCH](https://public.econ.duke.edu/~boller/Published_Papers/joe_86.pdf); Engle (1982) ARCH | **Motivational only** — no GARCH/ARCH likelihood |
| HAR-scaled terminal-Z quantile cone (computed; **not drawn**) | Filtered historical simulation (Barone-Adesi, Giannopoulos, and Vosper 1999); vol-cone / \(\sigma\sqrt{h}\) envelope | Terminal \(Z\) quantiles × live multiperiod HAR scale; live display is the occupancy map |
| Coherent pathwise quantiles by terminal rank + intermediate re-order | Same FHS tradition | Used for legacy `analogue-v1` and as a tested helper; not the live month-fan renderer |
| Nearest-neighbour / analogue state matching (v1/v2 research models) | Farmer and Sidorowich (1987); analogue / historical simulation practice | Used for research candidates only |
| Robust feature scale \(\mathrm{IQR}/1.349\) | Tukey robust scale constants (Gaussian-consistent IQR) | Exact constant for σ-scale under normality |
| Gaussian kernel similarity on distances | Standard Nadaraya–Watson / RBF kernel practice | Fixed bandwidth = median distance |
| Recency half-life weights | Exponential time-decay (standard risk/forecasting practice) | 250 calendar-day half-life |
| Kish \(wESS=(\sum w)^2/\sum w^2\) | Kish (1965), *Survey Sampling* | Exact Kish formula on path weights |
| Overlap-adjusted \(cESS\) (horizon-block weight aggregation) | Extension of Kish ESS to clustered/dependent sampling units | In-house cluster adaptation, not a named paper |
| Embargo + non-overlapping rolling origins | Tashman (2000), [Out-of-sample tests of forecasting accuracy](https://doi.org/10.1016/S0169-2070(00)00065-0) | Purged-style separation by full horizon |
| Multiplicative interval scale \(\lambda\) + rolling prequential quantiles (`scorePrequentialForecasts`) | Conformal / CQR spirit (Romano, Patterson, and Candès 2019); multiplicative nonconformity for shrink-or-widen | **Style only** — no exchangeability / finite-sample guarantee; shared by live diagnostics and offline validation |
| ACI-lite factor inflate/deflate on coverage gap (`applyPathCalibration`) | Gibbs and Candès (2021), [Adaptive Conformal Inference Under Distribution Shift](https://arxiv.org/abs/2106.00170) | **Lite:** symmetric mild factor adjust on **drawn paths only**; not online α GD; not in promotion coverage |
| Pinball (quantile) loss, interval score, Brier score | Gneiting and Raftery (2007), [Strictly Proper Scoring Rules](https://doi.org/10.1198/016214506000001437); Koenker and Bassett (1978) on regression quantiles | Exact standard definitions |
| Moving-block bootstrap CIs on diagnostics | Künsch (1989); Politis and Romano (1994) | Deterministic seed; √n-style block length |
| Frozen walk-forward, predeclared trials, simplicity tie-break | Bailey, Borwein, López de Prado, and Zhu, [The Probability of Backtest Overfitting](https://carmamaths.org/jon/backtest2.pdf) ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253)) | Process inspiration; **full PBO/CSCV not computed** |

### Formal bibliography (implemented or directly motivating)

1. Andersen, T. G., Bollerslev, T., Diebold, F. X., & Labys, P. (2003). Modeling and forecasting realized volatility. *Econometrica*.
2. Bailey, D. H., Borwein, J. M., López de Prado, M., & Zhu, Q. J. The Probability of Backtest Overfitting. [PDF](https://carmamaths.org/jon/backtest2.pdf) / [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253).
3. Barone-Adesi, G., Giannopoulos, K., & Vosper, L. (1999). VaR without correlations for portfolios of derivative securities. *Journal of Futures Markets* (filtered historical simulation line).
4. Bollerslev, T. (1986). [Generalized Autoregressive Conditional Heteroskedasticity](https://public.econ.duke.edu/~boller/Published_Papers/joe_86.pdf). *Journal of Econometrics*.
5. Campbell, J. Y., Lo, A. W., & MacKinlay, A. C. (1997). *The Econometrics of Financial Markets*. Princeton University Press.
6. Corsi, F. (2009). [A Simple Approximate Long-Memory Model of Realized Volatility](https://doi.org/10.1093/jjfinec/nbp001). *Journal of Financial Econometrics*.
7. Engle, R. F. (1982). Autoregressive Conditional Heteroscedasticity with Estimates of the Variance of United Kingdom Inflation. *Econometrica*.
8. Farmer, J. D., & Sidorowich, J. J. (1987). Predicting chaotic time series. *Physical Review Letters*.
9. Gibbs, I., & Candès, E. (2021). [Adaptive Conformal Inference Under Distribution Shift](https://arxiv.org/abs/2106.00170). NeurIPS.
10. Gneiting, T., & Raftery, A. E. (2007). [Strictly Proper Scoring Rules, Prediction, and Estimation](https://doi.org/10.1198/016214506000001437). *JASA*.
11. Kish, L. (1965). *Survey Sampling*. Wiley.
12. Koenker, R., & Bassett, G. (1978). Regression quantiles. *Econometrica*.
13. Künsch, H. R. (1989). The jackknife and the bootstrap for general stationary observations. *Annals of Statistics*.
14. Politis, D. N., & Romano, J. P. (1994). The stationary bootstrap. *JASA*.
15. Romano, Y., Patterson, E., & Candès, E. (2019). [Conformalized Quantile Regression](https://arxiv.org/abs/1905.03222). NeurIPS.
16. Tashman, L. J. (2000). [Out-of-sample tests of forecasting accuracy](https://doi.org/10.1016/S0169-2070(00)00065-0). *International Journal of Forecasting*.

### Not implemented (do not read the bibliography as SOTA delivery)

| Not in code | Relevant literature if pursued later |
|-------------|--------------------------------------|
| Fitted GARCH/EGARCH likelihood | Engle (1982); Bollerslev (1986) |
| Fitted multiperiod HAR-RV coefficients / full recursion | Corsi (2009) and extensions |
| Full online ACI α gradient | Gibbs and Candès (2021, 2024 JMLR) |
| Diebold–Mariano pairwise tests | Diebold and Mariano (1995) |
| Reality check / SPA / full PBO | White (2000); Hansen (2005); Bailey et al. PBO combinatorics |
| Trading costs / capacity / execution edge | Separate predeclared decision-rule test |

### Honesty bar

- **Cited and used (with fidelity notes above):** log returns, zero-median RW baseline (archived candidate), multiperiod HAR RV, month-from-open occupancy map (live display: FHS + product kernel + empirical-Bayes climatology mix), HAR-scaled terminal-Z quantile cone (baseline candidate), per-step FHS quantiles (vol analogue / month-open map), coherent terminal-rank paths (legacy/helper), NN analogues, running high/low excursions, multiplicative interval scale, ACI-lite factor adjust, proper scores, Kish/cESS, block bootstrap, Tashman-style OOS split, PBO-aware trial hygiene.
- **Product status:** **`unvalidated`** UTC-month overlay — **not** a trading-alpha claim. Live display is `month-open-map-v1`. The archived 5/10/20-day freeze is in [`PRICE_PROJECTION_VALIDATION.md`](PRICE_PROJECTION_VALIDATION.md) (`price-projection-walk-forward-1786425347395`) and does not apply to the live month-span product. Month-open monitoring uses `--origin-mode month-open`.

## Implementation map

- model (source of truth): [`web/src/research/price-projection.js`](../web/src/research/price-projection.js)
- chart re-export: [`web/src/chart/price-projection.js`](../web/src/chart/price-projection.js)
- chart adapter: [`web/src/chart/price-projection-indicator.js`](../web/src/chart/price-projection-indicator.js)
- validation harness: [`scripts/price_projection_validation.mjs`](../scripts/price_projection_validation.mjs) (supports snapshot v1 row + v2 columnar)
- frozen day-horizon validation report: [`docs/PRICE_PROJECTION_VALIDATION.md`](PRICE_PROJECTION_VALIDATION.md)
- month-open monitoring (not a locked freeze): `node scripts/price_projection_validation.mjs --origin-mode month-open`
- rolling recheck (non-locked): [`docs/PRICE_PROJECTION_VALIDATION_ROLLING_RECHECK.json`](PRICE_PROJECTION_VALIDATION_ROLLING_RECHECK.json)
- tests: [`web/src/chart/__tests__/price-projection.test.js`](../web/src/chart/__tests__/price-projection.test.js), [`price-projection-indicator.test.js`](../web/src/chart/__tests__/price-projection-indicator.test.js)

### Indicator recompute signature

The chart adapter recomputes when the closed-source signature changes:
coin, timeframe, snapshot `revision`, eligible profile-month bounds,
sampled OHLCV in the prefix **before** the latest month open (historical
fans), and sampled OHLCV of closed bars **inside** the live month (so a new
close refreshes month-to-date analogue weights and occupancy). Mid-series repairs in the prefix
still recompute frozen months. A profile month with a valid origin forecast
is kept even when month-block calibration is thinner than four origins;
those fans draw at λ = 1. Historical series are clipped off the next month
open.
