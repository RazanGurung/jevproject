# Architecture Hardening Implementation

> Archived. Current ownership: [../ARCHITECTURE.md](../ARCHITECTURE.md). Do not extend this file.

Living execution record for the July 2026 architecture review. This file records
the implementation gates, decisions, verification evidence, and any follow-up
work discovered while executing the pass.

## Invariants

- Existing REST payloads, `xyzPositions`, `isHip3Coin`, and strategy bridges
  remain compatible during this pass.
- Account abstraction is detected and reported; the server never changes it.
- Unknown account modes never produce invented aggregate risk values.
- Builder-perp routing is driven by venue metadata and encoded asset IDs.
- Signed exchange actions remain typed, uniquely nonced, timeout-bounded, and
  never log key material.
- HTTP disconnects do not discard persisted protection work, while graceful
  shutdown cancels all server-owned background work.
- No funded exchange action is part of the non-funded smoke test.

## Execution Gates

| Phase | Status | Acceptance gate | Evidence |
|---|---|---|---|
| Baseline | Complete | Existing architecture and tests inventoried | Frontend baseline: 122 files / 750 tests. Go baseline exposed live-network HIP-3 tests and was rerun outside the restricted listener sandbox. |
| Account modes and venues | Complete | Standard, legacy DEX abstraction, unified, portfolio-margin, and unknown fixtures pass; generic builder venue plus xyz compatibility pass | Pure mode fixtures and offline `xyz`/`vntl` transport fixtures pass. Live startup discovered 9 builder dexes plus the default dex. Real mode validation remains the funded/operator gate because no key was loaded. |
| Action concurrency and lifecycle | Complete | Unique nonces, bounded concurrency, latency metrics, and shutdown cancellation pass | 200-way nonce uniqueness and 2-wide transport-bound tests pass; focused race suite is green; graceful smoke shutdown canceled feed/cache work. |
| Targeted decomposition | Complete | Public contracts unchanged and focused suites pass after each split | Account-mode detection moved to its own backend module; drawing geometry moved to a tested frontend module. Larger modules were not mechanically split without a behavior-driven seam. |
| Full verification | Complete | Go, race, vet, frontend, and production build pass | Full Go green; focused race green; vet green; frontend 122 files / 752 tests; `make release` completed with an ephemeral Go cache. |
| Non-funded smoke | Complete | Health, streams, account reads, previews, candles, metrics, and reconnect pass without signed actions | Health/API/market WS green; 10 dexes loaded; canonical metadata; candle/radar/L2/scale/order previews and built shell passed. No saved key; signed in-flight stayed 0. |
| Documentation | Complete | Current docs match verified behavior and clearly retain the funded execution gate | Architecture, API, project status, runbook, dependencies, refactor log, and docs index updated. |

## Decisions

- Compatibility migration is additive: generic builder-perp contracts are
  introduced alongside xyz aliases.
- Signed actions use bounded concurrency rather than a 100 ms command batcher.
- The default maximum is eight in-flight exchange actions and is configurable.
- Generic builder perps default to crypto presentation. MISPRICE is the narrow
  exception: only full coin IDs in its conservative multi-DEX non-24/7 registry
  receive a venue/session classification.
- The implementation supports a single active wallet and is not a multi-tenant
  server redesign.

## Verification Commands

```sh
make deps-verify
make test
go test -race ./internal/infrastructure/exchange ./internal/services ./internal/handlers/http ./internal/handlers/websocket ./cmd/server -count=1
go vet ./...
cd web && npm audit --omit=dev && npm audit && npm run test:run
make release
```

## Results Log

- July 31 independent release audit closed the remaining execution and
  reproducibility findings. Standard market IOC signing now carries the
  caller's `reduceOnly` bit (both values are regression-tested), matching the
  official Hyperliquid order schema. The macOS launcher builds the complete
  release, stops only its validated PID, and refuses a foreign port listener.
  Vendor verification now stages source, regenerates `vendor/`, and exact-diffs
  it; npm uses the official registry with exact compatible test tooling and a
  declared direct `esbuild` dependency. Both full and production npm audits are
  clean. Audit middleware no longer emits repetitive mutating-route entries for
  internal subscribe/preload control traffic.
- Final July 31 gates passed: all Go packages, `go vet ./...`, the focused race
  suite, 871/871 frontend tests across 131 files, `make deps-verify`,
  `make release`, and code-sign verification. The rebuilt browser gate passed
  292/292 with zero rejected chart updates or application failures. Live
  readiness reached 38/38 in 2m20s; final metrics showed zero subscription
  shedding and zero signed actions. Shutdown checkpointed 951 candle series,
  and temporary profiles/caches were removed. No funded action was performed.
- July 17 lead-engineer audit follow-through: ambiguous signed mutations are
  at-most-once across browser and backend transports; every order carries a
  client id and durable TP/SL legs reuse deterministic ids from atomically
  replaced state. Position incremental rendering now verifies row/action
  identity before value-only updates. Raw keys are discarded from browser
  state after backend acceptance. Both downstream WebSocket lanes authenticate
  without URL tokens, and the account lane requires exact account scope.
  Startup exposes liveness while keeping all functional routes behind
  readiness, detailed upstream health is cached, and server-owned account
  repair observes process cancellation. Dynamic exchange-fed markup uses one
  shared escaping boundary. Repository-wide occurrence checks removed proven
  dead Go/JavaScript helpers and compatibility state without broad speculative
  rewrites. The real-browser candle fidelity check now compares a completed
  bar, eliminating the open-tail timing race.
- Final verification for this follow-through: full `make test` passed every Go
  package, `go vet ./...` and `go build ./...` passed, and the frontend passed
  764/764 tests across 122 files. The production bundle rebuilt successfully;
  `scripts/chart_live_smoke.mjs` passed syntax validation. Funded execution was
  intentionally not performed by this audit and remains an operator gate.
- Rebuilt-release live acceptance then passed both committed mainnet gates. The
  Opera/CDP browser harness passed 189/189 checks with zero rejected updates or
  runtime/resource failures. The independent CVD harness exited PASS with
  51,702 exact comparisons, 10 upstream revisions, zero genuine mismatches,
  zero stability/conservation failures, and zero display holes; 45,225 cold
  thin-market rows were honestly withheld as not-ready. Live startup restored
  995 series, exposed liveness while readiness stayed 503, and completed the
  41-market dependency barrier in 2m56s. Final health was OK/ready with zero
  signed actions. The managed browser/server shut down cleanly, after which all
  generated reports, isolated profiles, logs, test databases, and Go/Vite
  caches were removed. Release artifacts, regression tests, dependencies, and
  the freshly checkpointed 1,023-series candle snapshot were retained.

- Baseline repository has no `.git` metadata in the supplied workspace, so
  change review uses direct file inspection and targeted diffs rather than Git.
- Baseline frontend suite passed all 750 tests. Baseline Go execution could not
  bind `httptest` listeners in the restricted sandbox, and two HIP-3 wire tests
  attempted live metadata discovery; both conditions are addressed by this pass.
- The first full Go run caught a missing default xyz mids subscription on
  test-created managers; the compatibility default was restored and the suite
  then passed.
- Live smoke found double-prefixed builder metadata and under-counted generic
  `allMids` subscriptions. Both were fixed with regression tests. Final live
  metrics held the operational subscription cap at 900, intentionally shed 9
  dormant candle feeds and 15 background trade symbols, and showed zero signed
  actions. No upstream 429 metric was emitted.
- The earlier July 11 smoke session left a server running for operator review;
  the final July 17 audit session instead verified graceful shutdown and left
  no validation listener running.
- An independent post-implementation review directly inspected the resulting
  source (no Git metadata was available), reran the full Go suite, and passed
  all 752 frontend tests across 122 files. The supplied 4+ hour server console
  showed stable 897-series snapshot persistence, successful low-latency API
  traffic, and automatic recovery from normal market/liquidation WebSocket
  resets without a reconnect loop or HTTP failure.
- The review also confirmed that the 900-subscription ceiling is now the main
  operational capacity constraint: startup shed seven dormant permanent candle
  feeds, and the fully discovered 10-dex subscription set reapplied 884 candle
  feeds while accepting 1–3 of 16 requested background trade symbols. This is
  expected active-chart-first degradation, but the upstream-subscription,
  background-shed, and permanent-feed-drop metrics should remain operationally
  visible. Funded account-mode and signed-action validation remains outstanding.
