# Price Projection Frozen Walk-Forward Validation

> This freeze is the retired **5/10/20-day** protocol. It does **not**
> transfer to the live UTC-month occupancy map (`month-open-map-v1`,
> evidence `unvalidated`). Live overlay: [PRICE_PROJECTION_METHOD.md](PRICE_PROJECTION_METHOD.md).

Report ID: `price-projection-walk-forward-1786425347395`

Validation-selected candidate: `volatility-baseline-v1`

Archived research model: `volatility-baseline-v1`

Promotion: **PASS** (validated-frozen-test) — archived protocol only

Scoring path: `scorePrequentialForecasts-per-step-multiplicative-scale-pre-aci` (same multiplicative interval scorer as live chart diagnostics; ACI-lite is chart-only factor adjust).

| Model | Validation pinball | Test pinball | Test MAE | Zero MAE | Brier | Climatology | C50 | C80 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| volatility-baseline-v1 | 0.021042 | 0.017126 | 0.044880 | 0.044880 | 0.258773 | 0.261484 | 0.546742 | 0.821530 |
| analogue-volatility-v2 | 0.021686 | — | — | — | — | — | — | — |
| analogue-v1 | 0.021544 | — | — | — | — | — | — | — |

## Promotion gates

- PASS — pinballNoWorseThanBaseline
- PASS — maeNoWorseThanZero
- PASS — pinballGateVacuousForZeroMedianBaseline
- PASS — maeGateVacuousForZeroMedianBaseline
- PASS — brierNoWorseThanClimatology
- PASS — pooledCoverage50WithinFivePoints
- PASS — pooledCoverage80WithinFivePoints
- PASS — noMaterialSubgroupUndercoverage

Note: for the zero-median production baseline, pinball-vs-baseline and MAE-vs-zero are identity checks (always true). Coverage and Brier remain the material gates.

The test period was evaluated once after model selection on the validation period. This report measures forecast behavior, not net trading profitability.

## Rolling recheck (not the locked freeze)

A re-run on the **current** live candle snapshot (`savedAtMs=1786546708882`, columnar v2) is **not** a substitute for the locked freeze above. On that rolling snapshot the same protocol selected `volatility-baseline-v1` and **failed** only the C50 ±5pp gate (C50≈0.568, C80≈0.847, Brier still ≤ climatology). That rolling recheck is monitoring for the archived 5/10/20-day protocol only. The live UTC-month overlay is `month-open-map-v1` with `evidenceStatus` **`unvalidated`**. Treat rolling rechecks as monitoring, not automatic demotion, until a new freeze is intentionally locked.

## Month-open monitoring (not this freeze)

The live overlay is now a UTC-month-from-open occupancy map (`month-open-map-v1`).
Score completed month-open origins separately:

```text
node scripts/price_projection_validation.mjs \
  --origin-mode month-open \
  --snapshot data/candle-snapshot.json.gz \
  --output docs/PRICE_PROJECTION_MONTH_OPEN_VALIDATION.json \
  --markdown docs/PRICE_PROJECTION_MONTH_OPEN_VALIDATION.md
```

That report does **not** replace this 5/10/20-day freeze and does not authorize
`validated-frozen-test` on the live month product.

Harness note: `scripts/price_projection_validation.mjs` now expands snapshot v2 columnar series (`t,T,o,h,l,c,v`) as well as legacy row `candles` arrays.
