# 2-Week Path Projection Frozen Walk-Forward Validation

Report ID: `week-path-projection-walk-forward-1786546708882`

Validation-selected candidate: `week-vol-baseline-v1`

Production research model: `week-vol-baseline-v1`

Promotion: **FAIL** (unvalidated)

Scoring path: `scorePrequentialForecasts-per-step-multiplicative-scale-pre-aci` (same multiplicative interval scorer as live chart diagnostics; ACI-lite is chart-only).

Horizon geometry: remaining bars to Monday 00:00 UTC two weeks after ISO week start (Mon+14d).

| Model | Validation pinball | Test pinball | Test MAE | Zero MAE | Brier | Climatology | C50 | C80 | Samples |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| week-vol-baseline-v1 | 0.032207 | 0.024398 | 0.060502 | 0.060502 | 0.289506 | 0.284011 | 0.571429 | 0.809524 | 28 |
| week-wtd-analogue-v1 | — | — | — | — | — | — | — | — | — |

## Promotion gates

- PASS — pinballNoWorseThanBaseline
- PASS — maeNoWorseThanZero
- PASS — pinballGateVacuousForZeroMedianBaseline
- PASS — maeGateVacuousForZeroMedianBaseline
- FAIL — brierNoWorseThanClimatology
- FAIL — pooledCoverage50WithinFivePoints
- PASS — pooledCoverage80WithinFivePoints
- PASS — noMaterialSubgroupUndercoverage
- PASS — minTestSamples

Note: for the zero-median production baseline, pinball-vs-baseline and MAE-vs-zero are identity checks (always true). Coverage and Brier remain the material gates.

Day-class pooling (vol baseline): candidates with the same remaining-day class (1..14) and at least as many realized bars contribute truncated paths of length horizon.

This report measures forecast-band quality only, not trading profitability.
