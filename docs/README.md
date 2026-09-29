# PEZ$ Docs

Current operator and development docs only. Dated execution records live in
[archive/](archive/README.md).

## Start here

| File | Use |
|------|-----|
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Current build, latest change, known risks |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Ownership boundaries and module map |
| [CHART.md](CHART.md) | Lightweight Charts 5.2.1 adapter, switch/overlay lifecycle, RVWAP clip |
| [API.md](API.md) | Runtime paths, endpoints, payload notes |
| [LIVE_VALIDATION_RUNBOOK.md](LIVE_VALIDATION_RUNBOOK.md) | Browser / funded-session checklist |

After that, open the doc that matches the work:

| Area | File |
|------|------|
| Candle warm vs lazy | [CANDLE_WARMUP_RATIONALE.md](CANDLE_WARMUP_RATIONALE.md) |
| Bot runtime & Jev Signals | [STRATEGIES.md](STRATEGIES.md) |
| TypeSafe Jev Engineering Blueprint | [JEV_ENGINEERING_GUIDE.md](JEV_ENGINEERING_GUIDE.md) |
| Vendored deps / bump procedure | [DEPENDENCIES.md](DEPENDENCIES.md) |
| Feature backlog | [ROADMAP.md](ROADMAP.md) |
| Short dated notes | [PROJECT_STATUS_HISTORY.md](PROJECT_STATUS_HISTORY.md) (older dump in [archive/](archive/README.md)) |

Research overlays (opt-in, not trading truth):

| File | Use |
|------|-----|
| [PRICE_PROJECTION_METHOD.md](PRICE_PROJECTION_METHOD.md) | UTC-month occupancy map — equations, evidence limits |
| [PRICE_PROJECTION_VALIDATION.md](PRICE_PROJECTION_VALIDATION.md) | Archived 5/10/20-day freeze (does **not** transfer to the live map) |
| [WEEK_PATH_PROJECTION_METHOD.md](WEEK_PATH_PROJECTION_METHOD.md) | 2-week path (Mon+14d UTC) model card |
| [WEEK_PATH_PROJECTION_VALIDATION.md](WEEK_PATH_PROJECTION_VALIDATION.md) | Frozen week-path walk-forward (FAIL / unvalidated) |

## How to work in this repo

1. **Rebuild after any change.** The server serves `web/dist`, not source.
   `make release`, then restart. See PROJECT_STATUS.
2. **Tests.** Go: `make test` (ephemeral `GOCACHE`). Frontend:
   `cd web && npm run test:run`. Then drop `web/node_modules/.vite` and any
   `pez-vitest-localstorage-*` files.
3. **Chart work.** Read [CHART.md](CHART.md) before touching
   `web/src/chart/**`. Isolated smoke: `:5002` +
   `node scripts/chart_live_smoke.mjs`. Do not disturb a live `:5001` session.
4. **Execution / transport.** Run
   [LIVE_VALIDATION_RUNBOOK.md](LIVE_VALIDATION_RUNBOOK.md) before calling it
   release-ready. Include a funded place/modify-or-cancel when possible.
5. **Docs.** Update PROJECT_STATUS (latest change only) and the owning current
   doc in the same change. Append a **short** entry to PROJECT_STATUS_HISTORY
   (one heading, a few bullets). Do not re-dump smoke transcripts — one latest
   acceptance line is enough; older passes belong in
   [archive/LIVE_VALIDATION_HISTORY.md](archive/LIVE_VALIDATION_HISTORY.md).

Do **not** delete `web/node_modules`, `vendor/`, `web/dist`, or
`data/candle-snapshot.json.gz` merely to shrink the tree.

Do not start another structural cleanup wave without a concrete bug, feature,
or hotspot. `window.*` is compatibility surface, not the preferred app API.
