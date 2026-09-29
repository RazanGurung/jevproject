# Architecture Improvement Plan

> Archived. Status remains **COMPLETE**. Current ownership:
> [../ARCHITECTURE.md](../ARCHITECTURE.md). Do not extend this file.

**Date:** 2026-08-11  
**Status:** **COMPLETE** (Phases 1–3 + optional + final cleanup)  
**Goal:** Backend owns exchange truth, market data residency, reconciliation, and request priority. Frontend is mostly a render model + DOM adapter.

## Non-negotiable ownership

```text
Backend
  exchange wire + signing
  account runtime / order protection / bots
  candle store, warm, gap, CVD enrichment at serve time
  HL weight limiter + info governor
  market + trading stream fanout

Frontend
  AppState render model
  stream → state apply (thin)
  chart/DOM paint from state
  user intent → API/session controllers
  window.* compatibility only (data-action shell + strategy host)
```

Research overlays (price projection math) may remain client-side as **opt-in diagnostics** but must not own trading or candle truth.

## Shipped summary

### Phase 1 — ownership & dual-truth
- Single venue classifier (Go + JS): `IsBuilderPerpCoin` / `isBuilderPerpCoin`
- `OrderPlacementBudget` vs process-wide `hlratelimit`
- Single trading connection + bookVersion truth
- `market-session.js` for chart intent
- Stream hot-path mirror no-ops removed

### Phase 2 — backend gravity wells
- `cmd/server` split: proxy / chart candles / session / static
- `order_service_protection.go` extracted
- `candlecache/cvd.go` for composite CVD
- Exchange port: only `GetBuilderDexState` (no `GetXyz*`)
- WS: `FillProcessor` / `BotEventHandler`; `BroadcastMarket` / `BroadcastTrading`

### Phase 3 — frontend control plane
- Window: pure `core` format helpers not dumped by default
- `rvwap-source-service.js`, chart-candle / poller import barrels
- `ui/async-prompt.js`
- `research/price-projection.js`
- `drawing-model.js` + `drawing-render.js` + overlay factory

### Final cleanup
- Production call sites no longer invoke no-op `syncMarketRuntimeMirrors` / `syncConnectionRuntimeMirrors`
- Plan closed; further refactors are ordinary maintenance, not open plan items

## Success criteria (met)

- Go + JS test suites green  
- `make release` succeeds  
- Live smoke against a running server passes for chart/API health  
- No new product logic moved *onto* the frontend  
- ARCHITECTURE documents backend-heavy ownership explicitly  
