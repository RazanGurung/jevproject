# CVD mainnet validation harness

Validates the server-computed anchored-CVD pipeline against Hyperliquid
**mainnet** ground truth and quantifies the cross-timeframe variance the
user actually sees. Stdlib-only Python 3.9+ — no installs.

The harness excludes open buckets so it proves completed-history math and
source attribution. It does not simulate browser suspension. Sleep/wake
recovery is a separate frontend contract: focus/visibility resume repairs a
market-message pause above 5s, while a visible-tab heartbeat tick more than
30s late covers lid wake with no focus event. Both force an authoritative
active-chart snapshot even when the last display timestamp is still in the
current bucket; see `docs/LIVE_VALIDATION_RUNBOOK.md` §2 and the existing
tab-resume/market-stream tests.

## What it checks, per ticker × timeframe

- **(a) Reference recomputation** — independently rebuilds the 5m/30m
  composite deltas (`reference.py`, a line-for-line mirror of
  `internal/infrastructure/candlecache/store.go ComputeCvdDeltas`) from both
  current mainnet candles and the local server's retained source candles.
  The local 5m series determines the actual retained seam; a fresh, shorter
  mainnet response is never allowed to move it.
- **(b) Cross-timeframe identity** — every complete higher-TF bucket's
  served delta must equal the sum of its covering lower-TF served deltas
  (strictly comparable buckets only; display holes shift deltas between
  buckets by design and are counted, not failed).
- **(c) Nil-coverage census** — fraction of buckets with no `cvdDelta`,
  split by age band aligned to the upstream retention edges (~17.4d of 5m,
  ~104d of 30m at 5000 candles/interval). Nil buckets are where the client
  falls back to display-TF directional deltas — the predicted divergence
  exposure.
- **(d) End-to-end anchored divergence** — simulates the client's anchored
  cumulation (`client_sim.py`, mirroring `web/src/chart/cvd.js`) on both
  timeframes of each pair, samples at higher-TF closes, and reports
  `max |cumA − cumB|` normalized by mean weekly Σ|delta|. Re-running with
  the fallback disabled splits the score into a **fallback share**
  (structural, by design) and a **residual** (genuine disagreement — should
  be ~0).

## Prerequisites

- The app running locally with a warm candle store: `make run`, then confirm
  a probe request returns the `X-PEZ-Candle-Store: 1` header (the harness
  checks this itself and retries — a passthrough response has no `cvdDelta`
  and triggers the server's own warm-on-demand).
- If `PEZ_API_TOKEN` is set for the server, export it (picked up
  automatically) or pass `--api-token`.

## Usage

```sh
# Sanity: one liquid coin, short window
python3 scripts/cvd_validation/run_validation.py --tickers BTC --timeframes 5m,1h --days 3

# Standard audit: liquidity tiers, default 14d window (5m-only composite)
python3 scripts/cvd_validation/run_validation.py --top 5 --mid 5 --bottom 5

# Deep mode: 60d window — exercises the 30m composite leg, the 5m/30m seam
# and the coverage edge; adds the 1d timeframe and the 4h/1d pair
python3 scripts/cvd_validation/run_validation.py --top 5 --mid 5 --bottom 5 --deep

# Ground-truth-only (no local server): validates the reference algorithm's
# own cross-TF identity and runs check (d) on reference-enriched candles
python3 scripts/cvd_validation/run_validation.py --tickers BTC,ETH --skip-local
```

Reports land in `scripts/cvd_validation/reports/<UTC-timestamp>/`
(gitignored): `summary.md` ranks tickers by worst-pair divergence with
attribution; `per_ticker/<COIN>.csv` has bucket-level (a) rows, source
coverage, and classifications.

## Latest recorded acceptance

On July 15, 2026:

- The complete 15-ticker top/middle/bottom deep audit recorded 90,059 exact
  buckets, 24 proven upstream revisions, 22,295 retained-only buckets, and
  zero genuine mismatches, stability differences, conservation violations, or
  recent completed fallback holes. The 123,020 not-ready buckets were confined
  to cold bottom-tier histories and were not falsely enriched.
- The dedicated eight-day `xyz:SKHX` `5m`–`1d` matrix recorded 3,808 exact
  comparisons and four proven upstream revisions, with zero not-ready buckets,
  genuine mismatches, stability differences, conservation violations, or
  recent completed holes.

Generated `reports/` content is disposable and intentionally not retained.
Rerun the audit for current evidence.

Each bucket is classified as:

- `exact` — served and current-mainnet recomputations agree (or both
  honestly withhold a value);
- `upstream-revision` — served disagrees with current mainnet but exactly
  matches a recomputation over the server's retained source bars;
- `retained-only` — current mainnet no longer covers the server's retained
  5m region, while the retained-source recomputation matches;
- `not-ready` — a cold/gapped response cannot yet be proven against retained
  sources (an enriched passthrough that matches a recomputation is still
  classified by its proven value);
- `genuine-mismatch` — the served value matches neither independent
  recomputation.

Exit `0` permits exact results, proven upstream revisions, retained-only
regions, and not-ready cold series. Exit is non-zero for genuine mismatches,
fixed-window stability changes, request errors, or cross-timeframe identity
violations.

## Design notes

- Mainnet requests are chunked ≤4500 candles (the upstream response cap
  truncates the head) and paced by a conservative weight budget
  (`--max-weight-per-min`, default 300 of the ~1200/min IP budget — the
  running app shares the IP).
- Candles through `/api/hl` are always mainnet: the server routes
  candleSnapshot to the mainnet API unconditionally.
- The weekly anchor mirrors the client's canonical `1W-MON00` contract: reset
  at the first available bar of each **Monday 00:00 UTC** week and include
  that bar's delta. `1W-MON14` remains accepted only as a compatibility alias.
- The open (incomplete) bucket is excluded everywhere; on (a) mismatches
  the served series is re-fetched once before flagging (WS-built tails can
  trail a fresh REST snapshot until revised).
- Deep validation separates three source regions: current-mainnet overlap,
  retained-only 5m history, and pre-seam 30m history. The last is still
  checked against current mainnet; every comparable `30m→1h/4h/1d` bucket
  is also checked by conservation.
