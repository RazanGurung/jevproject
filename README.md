# PEZ$

Single-user Hyperliquid trading terminal: Go backend plus a vanilla ES-module
frontend. Exchange is Hyperliquid mainnet and xyz HIP-3 only.

**Docs:** [docs/README.md](docs/README.md)

| Start with | For |
|------------|-----|
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | Current build, latest change, known risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Ownership and module map |
| [docs/STRATEGIES.md](docs/STRATEGIES.md) | Bot runtime, Jev System One & Trade Signals |
| [docs/JEV_ENGINEERING_GUIDE.md](docs/JEV_ENGINEERING_GUIDE.md) | TypeSafe Jev Engineering Blueprint |
| [docs/CHART.md](docs/CHART.md) | Lightweight Charts 5.2.1 adapter |
| [docs/LIVE_VALIDATION_RUNBOOK.md](docs/LIVE_VALIDATION_RUNBOOK.md) | Browser / funded-session checklist |

## Run

The server serves `web/dist`, not source. Rebuild after any change.

```sh
make release
./start\ \(Mac\).command    # or: make run
```

Default listen is `127.0.0.1:5001`. Isolated chart smoke uses a separate
`:5002` process — do not point `scripts/chart_live_smoke.mjs` at a live
funded session.

## Tests

```sh
make test                  # Go, ephemeral GOCACHE
cd web && npm run test:run
```
