# Exchange / Backend / Frontend Wiring Audit — July 20, 2026

> Archived. Current ownership: [../ARCHITECTURE.md](../ARCHITECTURE.md).
> Do not extend this file.

## Outcome

The production graph is connected end to end and the existing architecture remains sound. The audit found and fixed nine bounded lifecycle, duplication, retention, and observability issues without changing the documented API or performing any funded action. All production frontend modules remain reachable, the Go and browser suites pass, the race detector is clean, and a read-only mainnet browser smoke completed all 212 checks.

## Scope and method

The audit traced the runtime path in both directions:

```text
Hyperliquid HTTPS /info + /exchange ─┐
Hyperliquid market/account WS ──────┼─> Go exchange/infrastructure
Bybit public liquidation WS ────────┘          │
                                               ├─> caches, candle store, governor
                                               ├─> handlers and documented HTTP API
                                               └─> isolated market/trading WebSockets
                                                            │
                                                            v
                                              frontend services/state/rendering
```

Checks covered route registration and callers, exchange request paths, metadata ownership, candle request ownership and rate governance, market/account stream connection lifecycles, event fanout, cache retention, module reachability, error classification, tests, race detection, production bundling, and live read-only behavior.

Live validation intentionally excluded order placement, cancellation, leverage, margin, key changes, and every other funded or account-mutating operation.

## Changes made

| Area | Finding | Resolution | Effect |
|---|---|---|---|
| Market stream | Process-local backend event IDs can restart at `1`, while the browser retained its dedupe map for five minutes. A backend restart could therefore suppress valid new events. The old age-pruning loop also became O(n) per frame after 1,000 fresh IDs. | Reset processed IDs for every new WebSocket generation and use the shared strictly bounded FIFO deduper. | Correct recovery after backend restart, constant-time hot-path work, and a hard 1,000-ID memory bound. |
| Account stream | It shared the same stale-ID and pruning-cost risks and stored transport-private state in the global application store. | Made dedupe connection-local through the shared helper, reset it on reconnect, and removed the dead global export. | Smaller state surface, bounded work, and restart-safe delivery. |
| Stream heartbeat | A heartbeat timer could survive a closed socket and initiate competing reconnect work outside normal backoff. | Stop both market and account timers from `onclose` as well as explicit disconnect. | One reconnect owner per transport and stable outage backoff. |
| Startup metadata | `PreloadAssetIndices` fetched Hyperliquid metadata into a map with no production reader. | Removed the unused preload, map, locks, configuration, and accessors. | Eliminates one startup `/info` call and dead state. |
| Liquidation universe | Each liquidation feed independently fetched native and `xyz` metadata already present in the canonical startup cache. A native/`xyz` base collision could also depend on metadata-map iteration order. | Seed the manager from canonical metadata, derive Bybit mappings in memory with deterministic native precedence, and retain a fallback fetch for nonstandard embedding. | Eliminates two normal-startup `/info` calls and preserves stable mapping plus standalone resilience. |
| Bot candles | The bot made direct candle requests outside the server candle store, shared weight governor, repair logic, and concurrency lanes. | Injected the backend-owned candle snapshot path into the bot, retaining its direct fetch only as a standalone fallback. | One governed candle path, shared cache hits, and less burst/rate-limit risk. |
| Event bus | Unused generic event types, SSE client/subscriber contracts, send loop, client IDs, and unsubscribe/count machinery had no production connection. | Reduced the bus to the order-update publisher/fanout actually consumed. | Removes dead concurrency and compatibility surface. |
| Exchange caches | Builder-state and account-mode fallback caches were unbounded by address/dex cardinality. | Added 24-hour retention eviction alongside existing client eviction. | Bounds long-running memory growth while retaining stale outage fallback. |
| Chart abort metrics | Aggressive live chart churn produced ten `502` responses even though there were no upstream rate limits or browser failures; canceled in-flight requests were being classified as upstream faults. | Classify client cancellation as `499` and deadlines as `504` throughout slot, governor, and HTTP cancellation paths. | Intentional chart-switch aborts no longer pollute 5xx/error-rate signals. |

## Connections deliberately retained

Three documented backend mutation endpoints have no current in-repository frontend caller:

- `POST /api/cancel-by-cloid`
- `POST /api/bulk-modify-orders`
- `POST /api/update-isolated-margin`

They remain supported external API surface in `docs/API.md`; absence of a first-party UI caller is not evidence that they are dead. Their route registration, authorization boundary, handler, service, exchange wire implementation, and tests were retained.

The liquidation feed's metadata network fallback and the bot's direct candle fallback were also retained because those components can be constructed outside the standard server composition root. Normal server startup now uses the consolidated paths.

## Verification evidence

- Go unit/integration suite: `make test` passed across all packages.
- Static analysis: `go vet ./...` passed with an isolated temporary build cache.
- Race detection: `go test -race ./... -count=1` passed across all packages.
- Frontend suite: 130 files and 822 tests passed.
- Production module reachability: all 172 production web modules were reachable from runtime entry points. The only unreferenced module was `test-utils/canonical-state.js`, intentionally test-only.
- Production release: `make release` rebuilt `web/dist` and `hyperliquid-server` successfully.
- Read-only mainnet smoke: 212 checks passed with zero browser failures across BTC, ETH, SOL, `xyz:GOLD`, intervals `1m` through `1M`, live candles, CVD, VWAP, oscillator rendering, responsive layout, chart churn, and removed-route checks.
- Live stream health: 74 upstream subscriptions, zero active subscription shedding, zero rejected chart updates, and no observed upstream rate-limit series.
- Live candle source counts during the smoke: 23 store serves and 24 passthrough serves. The observed `934` permanent-feed-drop counter was the expected restored-snapshot population beyond the cache-owned 64-feed cap, not active client subscription shedding; client-owned visible feeds remained connected.
- Live render behavior: 45 full data sets, 59 incremental updates, 3,980 candles, one chart instance, and zero rejected incremental updates.

## Residual boundaries

- Funded/account mutation correctness remains covered by unit and integration tests only in this pass. It requires an explicitly authorized funded-session validation to exercise against mainnet.
- Hyperliquid and Bybit can change external payloads or connection policies independently. The retained fallbacks, reconnect backoff, readiness gates, rate governor, and existing metrics are the operational defenses; they should remain monitored rather than replaced with additional parallel request paths.
- No broader compatibility removal is justified by current evidence. Future removal should require both absence of internal callers and an explicit decision to retire the documented external contract.

## August 3, 2026 follow-up (wiring/math audit)

A second read-only pass re-checked Hyperliquid official weight/tick docs, Lightweight Charts 5.2 conflation/history contracts, CVD composite math, and execution rounding. Verified defects fixed in-tree:

| Finding | Fix |
|---|---|
| `ComputeCvdDeltas` could enrich `1m` when 5m/30m warm | Gate with `chartrequirements.CvdEnabled` at serve + compute |
| Unhealthy 30m zeroed all CVD including post-seam | Post-seam still enriches from 5m alone |
| History prepend only bumped `viewStart` | Also `requestVisibleLogicalRange` by `addedCount` |
| Market IOC used SDK floor sig-figs ≠ `normalizePerpPrice` | `slippagePrice` → `normalizePerpPrice` |

Deferred earlier and **shipped August 3, 2026 follow-up**: IOC close residual
size reporting (`ClosePositionResult` on `/api/close-position`) and returning
auto-generated cloids on place/bulk (`CanonicalOrderResult.cloid`). Still
deferred: re-probing `webData2` vs official `webData3`.

### Chart switch speed (same day)

| Finding | Fix |
|---|---|
| Active re-switch forced REST when any recent bar lacked `cvdDelta` | Paint span+tail-fresh cache immediately; CVD heal uses background `forceAuthoritative` |
| Startup only verified default `2h` (+5m/30m) | `StartupTimeframes` = `2h/1h/4h/15m` before `/readyz` |
| Warm budget 600 weight/min | Default **800** weight/min |

Evidence: market-service 40/40; candlecache/chartrequirements Go green; release `main-PLTT3WKO.js`; readiness 42 markets × startup TFs **~9m22s**; Opera/CDP smoke **293/293** (1 chart instance, 0 rejected updates).
