# API Contracts

## Runtime Paths

Frontend runtime:

- REST calls go through `web/src/services/api.js`
- account/execution realtime data uses `GET /api/trading-stream`
- market/chart realtime data uses `GET /api/market-stream`
- historical chart reads use `POST /api/chart-candles`
- multi-coin CVD alert reads use `POST /api/cvd-scan`
- client market intent is posted through `POST /api/market-subscribe`
- split-origin deploys should configure `PEZ_WEB_API_BASE_URL` and frontend `window.__PEZ_CONFIG__.apiBaseUrl` or the `pez-api-base` meta tag

Backend runtime:

- handlers load the cached backend key for signed actions
- frontend-provided private keys are compatibility input only
- Hyperliquid mainnet and xyz/HIP-3 are handled by the exchange adapter

## Authentication

- The desktop server binds to `127.0.0.1` by default. To expose it intentionally, set `PEZ_BIND_ADDR` (for example `0.0.0.0`) **and** a non-empty `PEZ_API_TOKEN`; startup refuses a non-loopback bind without that token.
- `PEZ_API_TOKEN` gates the fund-moving / key / proxy / resource-control / bot-control routes. When set, those routes require `Authorization: Bearer <token>` (or `X-PEZ-Token`) and return `401` otherwise. When unset (default for local single-user use) the gate is a no-op. Protected routes include all order/key/bot routes plus `/api/hl`, `/api/chart-candles`, `/api/cvd-scan`, `/api/market-subscribe`, `/api/preload-hint`, `GET /api/bot/status`, `GET /api/has-saved-key`, `POST /api/key-address`, and `GET /metrics`.
- Health/readiness (`/health`, `/healthz`, `/readyz`) and ordinary market-read routes stay open so the page can load before a token exists. Identity and Prometheus must not leak on a bound interface when the token is set.
- CORS `Access-Control-Allow-Methods` is `GET, POST, PUT, OPTIONS` (PUT is required for `/api/color-palette-templates`). The HTTP server sets `ReadHeaderTimeout` 10s and `IdleTimeout` 120s; Gin `SetTrustedProxies(nil)`. `Strict-Transport-Security` is sent only on TLS requests.
- The frontend attaches the token in `api.js` `apiPost` and legacy `bot.js`; the token is read from `window.__PEZ_CONFIG__.apiToken` or `localStorage['pez.apiToken']`. A `401` prompts for the token once and never auto-retries a mutating request.
- When `PEZ_API_TOKEN` is configured, both WebSocket handshakes require it too. Browsers send a base64url-encoded token in the `pez-token.<value>` WebSocket subprotocol (never in the URL); origin-less tooling may use `Authorization: Bearer <token>`. All WebSocket endpoints are also constrained by `PEZ_ALLOWED_ORIGINS`: an unset list permits same-origin browser handshakes and local origin-less tooling; a configured list requires a matching non-empty browser origin.
- The trading stream requires an `account` query parameter and is scoped to that exact normalized address. If a signing session is active, a different requested account is rejected. Account-targeted broadcasts never treat an empty account as a wildcard.
- CORS alone does not protect these routes — it is browser-enforced only.
- Every protected mutating/fund-moving route outcome is audit-logged as one structured `slog` line (route, method, status, duration — never request bodies, which can carry key material). High-volume read routes (`/api/hl`, chart/radar candles, and CVD scan) are represented by metrics instead of one INFO line per request. Signed routes always resolve the cached backend key server-side; a raw frontend-supplied key is never honored (the frontend sends the `__AUTO__` sentinel).

## Market-wide liquidations feed

The backend runs the market-wide liquidation feed (Bybit `allLiquidation.*`
plus QuickNode HyperCore fills when `HL_QUICKNODE_WS` is configured) and
broadcasts normalized events on one `liquidations` channel. There is no
frontend source selection, and each source applies the configured
`HL_QUICKNODE_MIN_NOTIONAL` USD floor.

Before each Bybit connection, the backend fetches every paginated linear
instrument page, keeps only instruments whose current status is `Trading`, and
intersects that set with the canonical Hyperliquid/HIP-3 universe and maintained
aliases. Topics are sorted, deduplicated, and subscribed in deterministic
10-topic batches. Every batch carries a unique `req_id`; the feed is not ready
until every acknowledgement succeeds. A missing, unknown, or rejected
acknowledgement tears down the socket, refreshes instruments, and retries.
Instrument eligibility is refreshed through a graceful reconnect every six
hours. Bybit's `S` field is the liquidated position side and is flipped to the
app's forced-order-side convention before broadcast. xyz markets that do not
have a real Bybit linear instrument are skipped.

- `HL_QUICKNODE_WS` — A QuickNode HyperCore `/hypercore/ws` endpoint (incl. token). When set, the backend subscribes to the QuickNode node-fills stream as an additional liquidation source (HL-native ground truth via the fills' `liquidation` tag). The public Hyperliquid `trades` feed carries no liquidation tag, so HL-native market-wide truth needs this node fills stream. No frontend flag is exposed.
- `HL_QUICKNODE_MIN_NOTIONAL` — USD floor applied to every market-wide source to drop dust liquidations (default `10000`).

## Market mispricing (closed-session HL close deviation)

`GET /api/stock-mispricing` keeps its historical path for compatibility. It scans the exact supported non-24/7 product registry on the **xyz HIP-3 dex only** (other builder dexs are not loaded as markets) and compares each closed market's current Hyperliquid mark with the Hyperliquid 1-minute close at the underlying venue's latest completed close:

`deviationPct = (markPx - closePx) / closePx × 100`

- **Close reference:** `closePx` is the latest valid Hyperliquid 1m candle ending at or before `sessionCloseMs`. A post-close candle is never accepted as a fallback. This is a Hyperliquid candle reference, not an external official-close feed.
- **Closed sessions only:** an entry is omitted while its underlying venue is open. Session classification uses IANA time zones, weekends, ordered cash windows (including TSE/HKEX/SSE lunch intervals), CME/ICE maintenance, split KRX futures windows, continuous-week FX hours, and maintained closure/early-close tables. Dates outside maintained coverage fail closed and do not enter the scanner. Product-specific futures holiday schedules are also conservatively excluded instead of being guessed from one generic early-close time.
- **Exact product eligibility:** a full canonical ID such as `xyz:AVGO` must exist in `mispricingInstruments`; a familiar bare ticker on another DEX does not inherit that registration. Non-`xyz` builder markets are never registered. Crypto and unknown listings are omitted until their actual session is verified and registered. `make mispricing-audit` performs a read-only comparison between the checked-in active-universe fixture and Hyperliquid's current `xyz` metadata.
- **Renderable and liquid only:** the canonical coin must exist in the production metadata cache and have valid leverage/precision metadata. It must also clear the shared notional-OI and 24h-volume floors (`PEZ_MIN_TICKER_OI`, default $3M; `PEZ_MIN_TICKER_VOL`, default $1M). The same liquidity definition gates `/api/market-movers`.
- **Non-blocking resolution:** candidate discovery does not depend on reference availability. Endpoint requests serve resolved rows immediately and single-flight missing `(coin, sessionCloseMs)` references in the background. Resolution is capped at three jobs, uses the candle store's shared budgeted/serialized background lane, and retries failures only after a five-minute cooldown. A new session-close key cannot reuse the prior close. One failed DEX/reference does not suppress healthy rows.
- **UI cadence:** the primary tab begins polling after 15s and refreshes every 15s. The browser recomputes against `allMids[coin]`, falling back to `markPx`, and animation-frame-batches mid-driven renders. It displays only `|deviation| ≥ 1%`, live-sorted by absolute magnitude. The tooltip shows session-close price → current HL price plus DEX, exchange, and closed-session state.

Each row is `{coin, dex, exchange, sessionState, sessionCloseMs, asOfMs, markPx, closePx, deviationPct, jevVerdict?, jevConfidence?, jevAction?}`. When Jev is available and deviation $|deviationPct| \ge 0.20\%$, the row is automatically evaluated to distinguish mean-reverting basis noise (`fade_arbitrage`) from informed off-hours macro repricing (`stand_aside`).

Calendar maintenance sources: [Nasdaq US trading calendar](https://www.nasdaqtrader.com/trader.aspx?id=Calendar), [JPX market holidays](https://www.jpx.co.jp/english/corporate/about-jpx/calendar/), [HKEX calendars](https://www.hkex.com.hk/News/HKEX-Calendar), [SSE closures](https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml), [KRX holiday rules](https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T1.jsp), and [CME holiday hours](https://www.cmegroup.com/trading-hours.html).

## Endpoint Set

| Method | Endpoint | Use |
|------|---------|-----|
| `GET` | `/api/color-palette-templates` | Load four durable Colors popover templates from disk (`data/color-palette-templates.json`); survives browser cache clears |
| `PUT` | `/api/color-palette-templates` | Replace the four template slots (token-protected when `PEZ_API_TOKEN` is set) |
| `GET` | `/healthz` | Liveness probe |
| `GET` | `/readyz` | Readiness probe; `503` until the default-chart admit set is history-ready (pinned/liquid universe × `2h` + CVD sources, coverage to `ReachableLookbackMs` / Hyperliquid's 5000-candle retention). Other startup timeframes hydrate after admission. `/healthz` is available earlier, including during snapshot restore. Payload reports Bybit liquidation transport/topic status without making that feed a gate |
| `GET` | `/health` | Detailed health probe (readiness/API/stream/market-ws/Bybit liquidation status); the upstream API result is cached for 10s so monitoring cannot amplify `/info` load |
| `GET` | `/metrics` | Prometheus metrics (Go/process defaults + `pez_*` app series: route latency, candle serving/budget, upstream limits, market subscriptions, and requested/subscribed/rejected liquidation topics). Token-gated when `PEZ_API_TOKEN` is set |
| `GET` | `/api/coin-meta` | Cached coin metadata (decimals, tick, max leverage) |
| `GET` | `/api/24h-changes` | Per-coin trading-trigger snapshots for native + xyz contexts. Each value is `{change, dayNtlVlm?, oi?, funding?, markPx?}` (`change` is a `%.2f` string percent; `oi` is notional USD; `funding` is percent points). Legacy clients that only need the percent can read `entry.change`. |
| `GET` | `/api/market-movers` | Backend-ranked `{gainers, losers}` rows (high-OI cohort, change-sorted) for the topbar; each entry is `{coin, change, oi}` |
| `GET` | `/api/stock-mispricing` | exact-registry, renderable, liquid non-24/7 markets across registered DEXes, closed-session only, with non-blocking HL 1m session-close references; each entry is `{coin, dex, exchange, sessionState, sessionCloseMs, asOfMs, markPx, closePx, deviationPct}` |
| `GET` | `/api/news-config` | Enabled news providers and per-source health |
| `GET` | `/api/news` | Read-only news snapshot; the browser merges global and per-coin items into one chronological feed |
| `GET` | `/api/has-saved-key` | Whether a backend signing key is loaded (token-gated when `PEZ_API_TOKEN` is set) |
| `GET` | `/api/trading-stream` | Isolated account/order/fill/TWAP/bot WebSocket |
| `GET` | `/api/market-stream` | Isolated mids/book/trade/candle/liquidation WebSocket |
| `POST` | `/api/chart-candles` | Backend-owned visible/prefetch chart candle reads |
| `POST` | `/api/cvd-scan` | Backend-owned compact CVD alert read model. Accepts `{coins:[...]}` (maximum 40 per request) and returns confirmed 1h oscillator readings without exposing candle hydration to the browser |
| `POST` | `/api/market-subscribe` | Client-scoped market subscription intent; may shed background symbols under upstream capacity pressure |
| `POST` | `/api/preload-hint` | Primary tab posts its watchlist (`{watchlist:[...]}`) so the warm coordinator keeps those charts warm; coins are validated against the loaded perp universe, capped, and TTL-aged |
| `POST` | `/api/account` | Enriched account payload `{ state, orders }` |
| `POST` | `/api/set-key` | Cache backend signing key, start user WS |
| `POST` | `/api/clear-key` | Clear backend key/session |
| `POST` | `/api/key-address` | Derive address from key (token-gated when `PEZ_API_TOKEN` is set) |
| `POST` | `/api/hl` | First-party Hyperliquid `/info` proxy. Allowlisted types only: `metaAndAssetCtxs`, `fundingHistory`, `allMids`, `l2Book`, `meta` (plus `candleSnapshot`, which is redirected to the chart-candle passthrough). `userRole`, `userFills*`, `historicalOrders`, and other high-weight types return `400` |
| `POST` | `/api/order` | Single order |
| `POST` | `/api/bulk-orders` | Batch orders |
| `POST` | `/api/scale-preview` | Scale ladder preview; rejects when the coin tick is unknown rather than guessing |
| `POST` | `/api/order-preview` | Margin/liquidation preview (CPU-only when client passes account metrics); attaches live Jev adverse flow/slippage audit (`jevAudit`) for orders $\ge \$1,000$ |
| `POST` | `/api/cancel-order` | Cancel one order |
| `POST` | `/api/bulk-cancel` | Cancel multiple orders; reports `partial` + `cancelledOids` for backend-confirmed oids only. Missing per-oid venue statuses are nacked, not treated as success |
| `POST` | `/api/cancel-by-cloid` | Cancel by client order id |
| `POST` | `/api/close-position` | Partial/full position close (IOC). App clients send optional signed `positionSzi` to avoid a redundant direction lookup (`positionSize` remains the absolute compatibility field); fractional size is floored to venue precision and can still be rejected when the resulting reduce-only notional is below Hyperliquid's $10 minimum. Success returns `{status, requestedSzCoin, filledSzCoin, avgPx?, residualSzCoin?, partial?, cloid?}` so an IoC shortfall under the ±1% slippage bound is visible (`partial:true` when filled is under 97% of requested coin size) |
| `POST` | `/api/trigger-order` | TP/SL reduce-only trigger. A single leg uses `grouping=na`. Entry-attached TP+SL is one `positionTpsl` action so Hyperliquid sibling-cancels the other leg. Market triggers (`isMarket:true`) set wire `p` to the official ±1% slippage IOC price, not the trigger itself |
| `POST` | `/api/modify-order` | Modify order (limit or TP/SL trigger); returns replacement `oid`. Trigger modifies send `LimitPx` from `triggerExecPrice` and the trigger wire type from the trigger itself |
| `POST` | `/api/bulk-modify-orders` | Modify multiple orders; returns replacement `oids` |
| `POST` | `/api/schedule-cancel` | Dead-man's-switch schedule cancel; `time` must be at least 5 seconds in the future (official Hyperliquid rule). Hyperliquid also rejects both set/clear for accounts below its volume-eligibility threshold |
| `POST` | `/api/set-leverage` | Set leverage. Optional `isCross` follows official `updateLeverage`. Omitted `isCross` is `false` on builder/HIP-3 coins (typically isolated-only) and `true` on standard perps |
| `POST` | `/api/update-isolated-margin` | Isolated margin update. Client `ntli` is a signed **USD** delta (positive add, negative remove). The backend converts it with the official 6-decimal integer (`1 USD = 1_000_000`) and always sends `isBuy: true` until hedge mode exists |
| `POST` | `/api/twap-order` | Place TWAP |
| `POST` | `/api/twap-cancel` | Cancel TWAP |
| `POST` | `/api/fills` | Fill history |
| `GET` | `/api/journal/executions` | Immutable execution journal query (filtered by coin/action, paginated) |
| `GET` | `/api/journal/summary` | Aggregate execution journal statistics (fill rate, slippage bps, latency ms) |
| `POST` | `/api/active-asset-data` | Active asset data |
| `POST` | `/api/l2-snapshot` | L2 snapshot |
| `GET` | `/api/bot/status` | Backend bot status/logs (token-gated when `PEZ_API_TOKEN` is set) |
| `POST` | `/api/bot/start` | Start backend bot |
| `POST` | `/api/bot/stop` | Stop backend bot |
| `GET` | `/api/jev/status` | Jev System One availability and model identity |
| `POST` | `/api/jev/analyze` | Jev System One live orderbook and macro momentum analysis with dynamic visibility ladder |
| `GET`/`POST` | `/api/jev/signal` | Real-time multi-timeframe trade signal generation with visibility ladder, Schmitt trigger, Gates 1–7, and subgoal deduplication |
| `POST` | `/api/jev/classify-news` | Jev System One semantic news and catalyst classification |
| `POST` | `/api/jev/pre-trade-audit` | Jev System One programmable permissions pre-trade audit (`allow`, `ask`, `deny`) |
| `POST` | `/api/jev/evaluate-mispricing` | Jev System One synthetic equity / HIP-3 basis dislocation audit |

Removed compatibility operations return `404`: the former multiplexed
`GET /api/account-stream` has been replaced by the two scoped WebSockets, and
the former no-op `POST /api/news-config` has been removed. News providers are
configured through server environment variables and remain readable through
`GET /api/news-config`.

## Important Payload Notes

### Chart candles

`POST /api/chart-candles` accepts `{coin, interval, startTime, endTime, dex?, urgency?}`. `urgency` is `visible` by default; `prefetch` uses the isolated one-wide background lane. `hydrate` is store-only and non-blocking: a safe covered series returns `200` with the candle array and `X-PEZ-Candle-Store: 1`; a miss returns `202 {"status":"warming"}` plus `Retry-After: 1` after starting/joining the budget-paced background warm. With `PEZ_CANDLE_PRELOAD=0` it is an intentional `204` no-op. It never falls through to an interactive upstream passthrough. Candle arrays may include `cvdDelta` on every bucket the backend's health-gated 5m/30m composite can verify.

`POST /api/preload-hint` returns both `accepted` and the exact ordered `acceptedCoins` subset. Browsers must use `acceptedCoins`, rather than assuming the first `accepted` inputs survived validation and the process-wide 50-coin cap, when scheduling watchlist hydration.

Before opening the HTTP listener, the server selects curated pinned markets plus the most liquid markets under the configured OI threshold/cap, expands each default 2h chart into its declared `2h + 5m + 30m` dependency set, and verifies those histories through the candle store. This applies equally to standard and builder-dex (`xyz:*`) markets while deliberately excluding the illiquid long tail from the startup barrier. A connected CVD-enabled chart also holds client refs for its primary interval and declared sources outside the 64 cache-owned feed cap. Nil values remain valid only outside source retention/coverage or across a runtime unverified gap, and mean that the renderer must use directional per-bar fallback.

For a market outside the startup set, the first visible request never waits on
the background warm queue: it uses the protected passthrough lane, folds that
response into the store, registers the series for live updates, and starts a
single-flighted full-lookback warm. Declared 5m/30m sources warm automatically
and the active series receives coordinator priority. The first price chart is
therefore normally one upstream round trip, but it may be head-truncated at the
exchange's 5,000-candle response cap and may initially omit `cvdDelta` until the
background chunks and source histories finish. The frontend requests the same
indicator-stable reachable window as the store (`190d` display, clamped to the
5,000-bar cap per interval), extends only if that snapshot is still short, and
retries missing CVD on bounded backoff; subsequent covered reads are memory hits.

**Timeouts and client retries (August 3, 2026):** candleSnapshot passthroughs
use a dedicated HTTP client with a **25s** timeout (metadata/health keep the
general 10s client). The handler budget remains 30s so a stuck upstream cannot
hold a semaphore slot forever. Hard timeouts and upstream errors still schedule
background warm so a retry can hit the store. The browser posts through the
same transient-retry ladder as `/api/hl` (429/500/502/504/deadline); intentional
cancels on coin/timeframe switch (abort / 499 / 504 `request canceled`) are
silent and not retried. A blank active chart self-heals on 1s/2s/5s/10s after
throttle or timeout. Builder perps send `dex` for any well-formed
`<dex>:<symbol>` id, not only the legacy `xyz:` prefix.

### CVD scans

`POST /api/cvd-scan` accepts `{coins:[...]}` with at most 40 unique normalized coin keys. It returns `{readings, asOf, requested, errors}`, where each reading is `{coin, barTime, value}` for the latest closed 1h bar. Per-coin store/upstream failures are omitted from `readings` and counted in `errors`; an empty input returns an empty reading set. The frontend de-duplicates the movers-plus-watchlist union and sends sets larger than 40 as sequential batches. It never raises the server limit or overlaps timer-driven scan passes.

### Orders

`POST /api/order` and each status in `POST /api/bulk-orders` return the
normalized envelope:

```json
{
  "accepted": true,
  "oid": 123456789,
  "cloid": "0x0123456789abcdef0123456789abcdef",
  "filled": { "avgPx": "65000", "totalSz": "0.001", "oid": 123456789 },
  "latencyMs": 820
}
```

`cloid` is always the 128-bit hex client order id submitted on the wire. When the
request omits `cloid`, the backend generates one before signing and echoes it
here so clients can reconcile or call `/api/cancel-by-cloid` without guessing.
Caller-supplied valid cloids are preserved. On exchange rejection the envelope
still includes the attempted `cloid` when one was assigned.

A transport/`http 429`/`5xx` failure that cannot prove the venue rejected the
action returns `accepted:false` with `ambiguous:true`. Clients must not retry
that round-trip with a new cloid; poll order status instead. Explicit venue
rejects (`Order must have minimum value of $10.`, etc.) are not ambiguous.

Place/Bulk that would open below Hyperliquid's $10 minimum notional are rejected
locally. The backend does not silently size the order up to the floor.

Frontend order `sz` is USD notional.

```json
{
  "coin": "BTC",
  "isBuy": true,
  "sz": 250,
  "limitPx": 65000,
  "reduceOnly": false,
  "mainnet": true
}
```

Backend converts notional to exchange coin size. Hyperliquid open-order `sz` values are coin amount, so UI display must compute:

```text
sizeUsd = sz * displayPrice
```

When `limitPx` is zero, `/api/order` submits a direction-bounded IOC market
order. Standard and builder-perp execution preserve `reduceOnly` exactly as
provided: `true` may only reduce an existing position, while `false` may open
or increase one. The backend does not infer or rewrite that flag. In
Hyperliquid's exchange schema, reduce-only (`r`) is an independent order field;
IOC is only the time-in-force inside the limit-order type.

For TP/SL orders, display/chart price should prefer trigger price:

- `triggerPx`
- `triggerPrice`
- `stopPx`
- `stopPrice`
- nested `orderType.trigger.triggerPx`

TP/SL identity may come from:

- `tpsl`
- nested trigger `tpsl`
- `orderType`
- `triggerCondition`

Note: Hyperliquid's stop-loss `orderType` text is `"Stop Market"` / `"Stop Limit"` —
the string "stop loss" never appears, so classifiers must match a standalone
`stop` (after checking take-profit).

### Modify (chart drag)

A Hyperliquid modify is **cancel + replace**: the resting order comes back under
a new `oid`. `/api/modify-order` returns it (`{"status":"ok","oid":<new>}`;
`/api/bulk-modify-orders` returns `"oids"` aligned with the request). Clients
re-key optimistic state to the replacement oid immediately — waiting for the
next account snapshot leaves a ghost order at the old price, which on HIP-3
dexes (slow/partial user-stream coverage) made chart drags flicker.

`/api/modify-order` also natively moves TP/SL triggers (one atomic exchange
action — no cancel-then-place window) when trigger fields are present:

```json
{
  "coin": "BTC",
  "oid": 123,
  "isBuy": false,
  "sz": 0.00032,
  "limitPx": 58000,
  "triggerPx": 58000,
  "isMarket": true,
  "tpsl": "sl",
  "reduceOnly": true,
  "mainnet": true
}
```

Modify `sz` is **coin units** (unlike `/api/order`'s USD notional) — it passes
through unchanged. Trigger modifies are forced reduce-only.

### TWAP

`POST /api/twap-order` request:

```json
{
  "coin": "BTC",
  "isBuy": true,
  "sz": 250,
  "limitPx": 0,
  "minutes": 30,
  "randomize": false,
  "reduceOnly": false,
  "mainnet": true
}
```

The frontend reads the exchange TWAP id from:

```text
response.data.status.running.twapId
```

`POST /api/twap-cancel` requires:

```json
{ "coin": "BTC", "twapId": 123456, "mainnet": true }
```

### Wallet And HIP-3

Builder-perp trading is handled inline by the exchange adapter during order placement
(wallet-existence validation, venue metadata, encoded asset routing, and signing; see
`internal/infrastructure/exchange/hyperliquid_execution_hip3.go` and `WarmUpForKey`).
The server detects and reports account abstraction mode but never changes it;
mode changes belong in the user's Hyperliquid account settings.
There are no standalone wallet-onboarding / dex-abstraction REST endpoints — the
former `/api/check-wallet-initialized`, `/api/approve-agent`,
`/api/dex-abstraction-status`, and `/api/set-dex-abstraction` routes were unused and
removed. A wallet that has never been funded still surfaces the upstream
`User or API Wallet ... does not exist` error; the fix is to deposit USDC on
Hyperliquid.

## WebSocket Contract

The application uses two independent data planes. `GET /api/trading-stream`
delivers account and execution events; `GET /api/market-stream` delivers market
and chart events. Each owns its own queue, sequence counter, heartbeat and
reconnect lifecycle. There is no multiplexed compatibility stream.
`{type:"heartbeat"}` keeps the local socket alive and is **not** market data.
`{type:"upstream","connected":true|false}` reports the backend's Hyperliquid
market socket. Chrome Live requires that upstream plus an allMids/book/trades/candle
tick within 15s.

Query params:

- `account`: required exact active wallet address for the trading stream; omitted for the market stream
- `clientId`: stable per-tab client id (market stream only)

When `PEZ_API_TOKEN` is non-empty, the handshake must carry the authenticated
subprotocol described above. The token is deliberately absent from query
strings, browser history, proxy access logs, and reconnect URLs.

On market-stream connect the server immediately pushes:

1. an `allMids` message built from the server-side BBO cache (only entries
   fresher than 60s **and** only while the upstream Hyperliquid market socket
   is connected — timestamps are `UnixMilli`, never monotonic `time.Since`.
   After a server wake, pre-sleep prices are excluded and arrive when the
   upstream stream recovers), so prices paint without waiting for the next
   upstream mids push. If upstream is down the snapshot is empty even though
   the local `/api/market-stream` is connected. Connect-time BBO frames set
   `data.snapshot: true` so the browser paints prices without treating them as
   a live tick.
On trading-stream connect the server pushes:

1. `{"type":"initialState","channel":"webData2"}` with orders (runtime
   snapshot, REST fallback), `orderRevision`, `ordersFresh`, and account state
   (positions/margin/withdrawable/spot/risk) when an account is resolvable
2. `botStatus` when a bot session is running for the connecting account

Account channels (browser-facing labels):

- `webData2` — the backend subscribes upstream to Hyperliquid's `webData2` feed
  (main-dex clearinghouseState + openOrders). Do NOT subscribe `webData3`: probed
  live (June 2026), it returns only account meta (`userState`) and per-dex
  skeletons (`perpDexStates`) with no clearinghouse/positions/orders data. The
  `dex` param on `webData2` subscriptions is silently ignored (main-dex only).
- `xyzPositions` — compatibility alias for xyz position repairs. New code
  should consume `builderPositions`.
- `builderPositions` — generic additive builder-dex repair channel with
  `{dex, assetPositions}`. The frontend replaces only that dex's position
  slice. `xyzPositions` is emitted alongside it for compatibility.
- `orderUpdates`
- `userFills`
- `twapStates`
- `botStatus`

Market channels:

- `allMids` — the backend subscribes to the default feed and one feed for each
  dex discovered from `perpDexs` (keys remain dex-qualified). Builder mids keep the
  frontend price-age guard satisfied (market entries on thin xyz markets were
  previously blocked as "stale") and prime the adapter's hip3 mid cache so
  xyz order placement skips the metaAndAssetCtxs fetch on the hot path
- `l2Book`
- `candle`
- `trades`
- `bbo`
- `activeAssetCtx`

Rules:

- enriched account snapshots add `accountMode`, `accountModeSource`,
  `riskSummaryFresh`, and `builderDexStates`; existing fields remain unchanged

- `allMids` is broad fan-out
- subscription-bound market channels are scoped by `clientId` intent
- payloads include lane-local `eventId` values for frontend dedupe; market
  volume cannot advance the trading sequence
- stalled downstream clients are disconnected instead of blocking relay writes
- handshake origin is validated against `PEZ_ALLOWED_ORIGINS` (empty list preserves same-origin/localhost)
- TP/SL attach failures publish `protectionError`; a failure is retried
  automatically, not left silent or lost (see below)
- Builder-perp state does not arrive completely via the upstream user stream
  (`webData2` is main-dex only). Both ends treat snapshot absence as unknown,
  not closed/cancelled. The generic repair poll is authoritative per dex;
  legacy xyz preservation remains until its compatibility alias is retired.
- A builder execution can emit both `orderUpdates` and `userFills`. These
  browser-facing events are still delivered independently, but their internal
  targeted state repair is coalesced per `account|dex`: a 75ms burst window
  produces one fetch, and an event received during that fetch permits only one
  follow-up. The fetch is asynchronous and has a 3s deadline, so reconciliation
  cannot hold the signed-action response, either downstream stream, or chart
  history reads. This is an internal scheduling guarantee; payloads and event
  ordering on this API are unchanged.
- order snapshots come from `frontendOpenOrders` (both dexes), never plain
  `openOrders`, so `reduceOnly`/`orderType`/`triggerPx` are always present
- a stream-health watchdog logs a WARNING if the user stream delivers no
  account state (`clearinghouseState`) for 5 minutes during an active
  session — Hyperliquid silently changed a stream payload once (webData3);
  the app must never degrade quietly to REST-only again
- queued TP/SL protection requests for resting orders persist to
  `pending_protection.json` (working directory, never includes private keys —
  the signing key is re-resolved from the key cache at attach time), so a
  backend restart does not silently drop protection

### TP/SL protection attach retry

TP and SL are placed as two independent legs, each tracked (and persisted)
separately (`internal/services/order_service.go`, `protectionAttachUnit`):

- **A failed leg never suppresses the other.** TP is attempted first, then SL,
  regardless of whether TP succeeded — a TP rejection no longer prevents SL
  from being placed at all.
- **A failed leg is retried, not lost.** A background sweep
  (`internal/services/order_service.go`, `StartProtectionRetrySweep`, every
  ~20s) scans for any leg still missing and retries it — forever; an
  unprotected live position is a standing financial risk, and the retry cost
  is one cheap signed HTTP call. A leg that already succeeded is never
  re-placed (guarded per-leg, not per-order). Fill-event replays (e.g. a
  reconnect snapshot resending a recent fill) are also a retry trigger, on top
  of the sweep.
- **Retries are idempotent at the exchange boundary.** Each persisted TP/SL leg
  owns a deterministic 128-bit client order id (`cloid`) derived from account,
  coin, trade id, and leg. That id is persisted before the first signed call and
  reused after errors or restart. The persistence file itself is replaced
  atomically (same-directory temporary file, fsync, rename), so a crash cannot
  leave a half-written JSON file or silently assign a new identity.
- **Immediate fills are durable too.** An order that fills synchronously in
  the same `/api/order` response persists its attach request to
  `pending_protection.json` *before* the exchange call is attempted, so a
  crash mid-attach is recovered by the sweep or the next restart instead of
  silently losing the request (previously this path was a bare detached
  goroutine with no durable record).
- **Immediate-fill stream replays are deduped by order identity.** The later
  `userFills` event uses a trade-id key, but a terminal synchronous fill is
  routed back to its persisted `immediate:<oid>` unit. It never creates a
  second TP/SL pair.
- **Repeated failure alerts are throttled, not silenced.** A `protectionError`
  for a persistently failing leg is published immediately on first failure,
  then again at 1m, 5m, 15m, and hourly thereafter — so a stuck leg is never
  silent for long, but doesn't spam.
- **No signing key available** (e.g. a disk-restored entry before `/api/set-key`
  is called again) fails fast with a distinct error rather than attempting a
  doomed signed call, and the leg stays pending for the next retry once a key
  is available.
- A resting order's cancel does not abandon protection for an already-filled
  portion: if an earlier partial fill left a leg incomplete, the entry is kept
  (closed to new fills) for the sweep instead of being deleted.

`POST /api/market-subscribe` request:

```json
{
  "clientId": "pez-abc123",
  "coin": "BTC",
  "interval": "1m",
  "tradeCoins": ["BTC", "ETH", "SOL"],
  "indicatorIntervals": ["4h"]
}
```

`indicatorIntervals` is optional and currently accepts only the chart
requirement's dedicated RVWAP source (`["4h"]`); invalid or excessive values
return `400`. The backend diffs aggregate client intent and only changes
upstream Hyperliquid subscriptions when needed. xyz/HIP-3 coins automatically
include `dex: "xyz"` in subscription frames.

The response includes `acceptedTradeCoins`, `droppedTradeCoins`, and a
`flowSnapshots` object. The first successful intent on a newly connected market
socket receives snapshots for the accepted set; later updates receive only
newly added coins. Reposting identical membership, including a rank-only
reordering, is a true no-op: it does not rewrite upstream references, reset Flow
windows, emit another applied-subscription log, or resend snapshots. Each flow snapshot carries
two backend-owned windows using the same exchange-time ordering and exact
eviction logic: `buyVol`/`sellVol` cover the latest 500 valid public prints,
while `whaleBuyVol`/`whaleSellVol` cover the latest 500 prints meeting
`whaleFlowThresholdUsd` (currently $100k). ALL uses `sampleCount`,
`sampleCapacity`, and oldest/newest exchange timestamps; WHALE uses the parallel
`whaleSampleCount`, `whaleSampleCapacity`, `whaleOldestTimeMs`, and
`whaleNewestTimeMs` fields. Threshold metadata plus numeric `revision` allow the browser to hydrate a
warm pair before its next trade message. The same additive `revision` field is
present in every trades message's top-level `_flow` annotation. It increases
monotonically when a coin is first subscribed (empty armed window), whenever a
new public-trade batch changes any coin's backend Flow sample, and when final
unsubscribe clears a non-empty sample. That clear is published as a newer
zero-valued revision. In-flight trades after the final unsubscribe do not
recreate the cache. Clients should reject a lower revision received within the same market
stream connection epoch. Existing consumers may ignore the field. The active
coin is retained; background watchlist symbols may be dropped when the server
reserves headroom below Hyperliquid's shared upstream subscription limit (the
server budget is 900 subscriptions). The browser does not raise a page warning
for this expected capacity control; use server logs or
`pez_market_subscription_shed_total` when diagnosing it. If the same budget sheds or rejects a
permanent candle-store feed, `pez_market_permanent_candle_feed_dropped_total` increments and the
store bypasses that series until a real candle WebSocket tick restores it; chart history therefore
falls back to a fresh candle snapshot rather than returning a stale tail.

All `/api/*` request bodies are limited to 1 MiB. `GET /api/news` accepts at
most 17 unique symbols, matching the Market Radar's maximum request size.

## Frontend Compatibility Contracts

App shell bridges still published:

- `PezStrategyHost` (PriceFeed + bot UI injection)
- `window.app`
- `window.transportMetrics`

Modern app code should prefer imports, selectors, and bridge modules over direct `window.*` reads. The unused `PezStrategyRuntime` / `PezStrategyExecution` client executor is gone.

## CSP / Split Origin

When `PEZ_WEB_API_BASE_URL` is set, backend CSP `connect-src` includes:

- same-origin
- configured API origin
- matching `wss://` or `ws://` scoped-stream origin

Optional X news feeds are server-configured with:

- `PEZ_X_NEWS_MIRROR_BASE`
- `PEZ_X_NEWS_ACCOUNTS`

The browser does not fetch raw `x.com` timelines directly.

Market News is one read-only chronological feed for discretionary context. The
browser provides no source modes, symbol filters, scanner rows, or execution
controls; it automatically follows the currently selected ticker and hides
items older than 72 hours. Before ingestion, every source passes through the
same deterministic impact filter: a ticker mention must also carry a concrete
catalyst (for example regulatory action, flows, security incidents, listings,
unlocks, earnings/guidance, macro policy, supply/inventory data, or a material
market move). SEO predictions, explainers, promotional content, and bare ticker
mentions are rejected. It never feeds signal scores, account risk, ticket sizing,
or execution. New items use the `news` channel on `/api/market-stream`;
`GET /api/news` remains the startup and reconciliation snapshot. Configure
optional free sources with:

- `PEZ_NEWS_EXTRA_RSS_FEEDS` — comma-separated HTTPS RSS/Atom feeds. Built-in
  CoinDesk, Decrypt, Cointelegraph, CryptoSlate, and Bloomberg Markets publisher
  feeds plus SEC, CFTC, Federal Reserve, EIA, and ECB official feeds are always
  registered. Direct publisher feeds provide low-latency crypto, equity, index,
  commodity, and FX coverage;
  Google News remains a breadth fallback.
- `PEZ_BSKY_NEWS_ACCOUNTS` — comma-separated Bluesky handles. The backend
  resolves their DIDs and consumes only those accounts from Jetstream.
- `PEZ_X_NEWS_MIRROR_BASE` / `PEZ_X_NEWS_ACCOUNTS` — legacy best-effort X RSS
  mirrors; each account feed is fetched once per cycle and then classified.

Direct feeds are conditionally fetched with their ETag/Last-Modified metadata.
A failing source backs off independently at 1, 2, 4… minutes up to 30 minutes;
success or `304 Not Modified` resets that state. `GET /api/news-config` exposes
the last attempt, success, error, and item count for each source.

Streamed/snapshot items add stable `id`, `coins`, `scope`, `sourceTier`,
`verification`, `ingestedAt`, `detectedPrices`, and corroboration metadata.
Social posts are labeled `unverified`; same-headline reports from another source
are clustered and surfaced as corroboration rather than duplicated.

## TypeSafe Jev System One Endpoints

Backend service integrating TypeSafe AI's Jev (System One decision model) for calibrated microsecond-level qualitative reasoning.

### Key Resolution & Privacy Policy
The TypeSafe API key is **strictly anonymous** within the codebase and server responses:
- Resolved on the server only via: `TYPESAFE_API_KEY` -> `PEZ_TYPESAFE_API_KEY` -> `data/typesafe_key.txt` -> `typesafe_key.txt`.
- Files matching `*typesafe*.txt`, `*typesafe*.json`, `*.key`, `*.secret` are ignored in `.gitignore`.
- Key material is never logged, exposed over Prometheus metrics, or passed to frontend client scripts.

### Endpoints

#### `GET /api/jev/status`
Returns availability status and active model identifier without disclosing credentials.
- Response: `{"available": true, "model": "jev-latest"}`

#### `POST /api/jev/analyze`
Analyzes live Hyperliquid L2 orderbook, OFI (order flow imbalance), spread, 24h macro momentum, and ATR volatility to output actionable trade recommendations.
- Request: `{"coin": "BTC"}`
- Response:
  ```json
  {
    "coin": "BTC",
    "midPrice": 81296.5,
    "bestBid": 81296,
    "bestAsk": 81297,
    "spread": 1,
    "spreadBps": 0.12,
    "bookImbalance": -0.33,
    "weightedBookImbalance": -0.28,
    "touchImbalance": -0.42,
    "deepImbalance": -0.19,
    "microPrice": 81296.3,
    "microPriceDriftBps": -0.25,
    "bidDepthUsd": 495302.77,
    "askDepthUsd": 989216.88,
    "direction": "bearish",
    "directionConfidence": 0.96,
    "directionProbabilities": {"bearish": 0.97, "bullish": 0.02, "neutral": 0.01},
    "confidenceScore": 2.25,
    "toxicFlowRisk": 0.38,
    "suggestedAction": "enter_short",
    "suggestedLimitPrice": 81297,
    "timestamp": 1789946758193,
    "model": "jev-1.13.0",
    "visibilityLevel": "full",
    "sharedRetrieval": true,
    "change24h": -2.45,
    "dayVolume": 482910400,
    "fundingRate": 0.0100,
    "atrPct": 1.25,
    "macroTrend": "bearish"
  }
  ```

#### `GET /api/jev/signal?coin=BTC&timeframe=intraday` / `POST /api/jev/signal`
Generates real-time actionable trade recommendations synthesizing L2 orderbook depth, OFI, spread, macro trend confluence, dynamic ATR volatility brackets, and Steidlmayer Auction Market Theory Monthly (30-day) and Quarterly (90-day) volume profile levels. Enforces dual-threshold Schmitt trigger hysteresis, instant toxic flow tripwires, multi-depth spoof defense, counter-trend dump/rally suppression, and macro overhead resistance/support gating (Gate 7).
- Request: `{"coin": "SOL", "timeframe": "scalp"}` or query param `?coin=SOL&timeframe=intraday`
- Timeframe options: `"scalp"` (15m–45m), `"intraday"` (2h–8h), `"swing"` (1d–5d)
- Response:
  ```json
  {
    "coin": "SOL",
    "timeframe": "intraday",
    "estimatedDuration": "2h – 8h (Session Intraday)",
    "action": "BUY",
    "signalType": "trend",
    "marketEnvironment": "trend",
    "conviction": 0.85,
    "score": 4.25,
    "midPrice": 142.50,
    "entryPrice": 142.48,
    "takeProfitPrice": 146.04,
    "stopLossPrice": 140.71,
    "takeProfitPct": 2.50,
    "stopLossPct": 1.25,
    "riskRewardRatio": 2.0,
    "toxicRisk": 0.12,
    "spreadBps": 0.88,
    "bookImbalance": 0.32,
    "weightedBookImbalance": 0.28,
    "microPriceDriftBps": 1.4,
    "reason": "[INTRADAY] OFI positive (+0.32) with strong session bid support ($1871K depth).",
    "timestamp": 1789953175831,
    "model": "jev-1.13.0",
    "visibilityLevel": "long",
    "sharedRetrieval": true,
    "cacheReused": false,
    "atrPct": 1.04,
    "macroTrend": "bullish",
    "change24h": 3.12,
    "vah": 148.40,
    "val": 136.65,
    "poc": 142.20,
    "profileHorizon": "monthly",
    "monthlyVah": 148.40,
    "monthlyVal": 136.65,
    "monthlyPoc": 142.20,
    "quarterlyVah": 162.10,
    "quarterlyVal": 124.50,
    "quarterlyPoc": 140.80,
    "distFromTwapPct": 2.15,
    "distFrom365dPct": 2.15
  }
  ```
- Macro Profile & Strategy Classification Fields:
  - `signalType`: Structural signal classification (`"trend"`, `"counter_trend"`, or `"neutral"`). In a range environment at Range High (VAH), retail buying pressure triggers a counter-trend short (`"counter_trend"`, `action: "SELL"`) targeting POC mean reversion unless conviction is institutional ($\ge 82\%$).
  - `marketEnvironment`: Active regime classification (`"range"` or `"trend"`). Derived from 24h absolute price change ($\le 3.5\%$), rolling ATR volatility ($\le 1.8\%$), and proximity to the Steidlmayer Volume Profile Value Area ($[VAL, VAH]$).
  - `visibilityLevel`: Active context visibility tier (`short` for scalp, `long` for intraday, `full` for swing) dynamically formatting orderbook context depth.
  - `sharedRetrieval`: Boolean indicating whether underlying L2 depth, OFI, and volatility were pulled from the shared retrieval cache.
  - `cacheReused`: Boolean indicating in-flight subgoal deduplication hit.
  - `profileHorizon`: Active profile horizon (`"monthly"` for scalp/intraday, `"quarterly"` for swing).
  - `vah`: Value Area High of the active profile horizon (Steidlmayer 70% value area). Longs are intercepted at or above this level unless breaking out with $\ge 82\%$ conviction.
  - `val`: Value Area Low of the active profile horizon. Shorts are intercepted at or below this level unless breaking down with $\ge 82\%$ conviction.
  - `poc`: Point of Control of the active profile horizon (price level with highest traded volume). Mean-reversion target for counter-trend setups.
  - `monthlyVah` / `monthlyVal` / `monthlyPoc`: 30-day monthly auction boundaries for session/tactical reference.
  - `quarterlyVah` / `quarterlyVal` / `quarterlyPoc`: 90-day quarterly macro auction boundaries.
  - `distFromTwapPct`: Percentage price deviation from active horizon TWAP (30D or 90D). When $\ge +6.0\%$ with move consumption $\ge 85\%$, breakout longs are suppressed to `HOLD`.
  - `distFrom365dPct`: Backwards-compatible alias for `distFromTwapPct`.
- Neutral HOLD Clearing: When action is `HOLD`, `entryPrice`, `takeProfitPrice`, and `stopLossPrice` are cleared to 0 (rendered as `—` in the UI) to avoid displaying phantom long tickets at macro inflection zones.
- Performance & In-Memory Caching: Macro profile levels are cached in memory for 15 minutes per coin and ATR volatility is cached for 60 seconds per timeframe. Bounded 1.5s timeout prevents blocking on upstream rate limits. Signal generation responds in < 300ms from cache.

#### `POST /api/jev/classify-news`
Classifies headline market sentiment and catalyst status using Jev System One semantic understanding.
- Request: `{"headline": "Federal Reserve cuts interest rates by 50 basis points"}`
- Response:
  ```json
  {
    "headline": "Federal Reserve cuts interest rates by 50 basis points",
    "direction": "bullish",
    "sentiment": 0.95,
    "impact": 0.78,
    "isCatalyst": true,
    "confidence": 0.95,
    "model": "jev-1.13.0"
  }
  ```

#### `POST /api/jev/pre-trade-audit`
Pre-flight audit of proposed order size against top-of-book depth, checking book-wipe percentage, programmable permissions, and toxic adverse selection risk.
- Request: `{"coin": "BTC", "isBuy": true, "sizeUsd": 2500}`
- Response:
  ```json
  {
    "coin": "BTC",
    "isBuy": true,
    "sizeUsd": 2500,
    "midPrice": 81296.5,
    "spreadBps": 0.12,
    "depth50Bps": 2534491.71,
    "bookWipePct": 0.098,
    "slippageRisk": "acceptable",
    "toxicRisk": 0.1,
    "approved": true,
    "permissionVerdict": "allow",
    "policyRule": "standard_execution",
    "advice": "Order structure safe to execute.",
    "model": "jev-1.13.0"
  }
  ```
- Programmable Permissions Policies:
  - `permissionVerdict`: Policy verdict (`"allow"`, `"ask"`, `"deny"`).
  - `policyRule`: Matched inspection rule (`"circuit_breaker_ceiling_exceeded"` for orders $> \$500,000$, `"catastrophic_book_wipe"` for $> 80\%$ book wipe, `"excessive_adverse_selection"` for $> 35\%$ book wipe or toxic flow, or `"standard_execution"`).

#### `POST /api/jev/evaluate-mispricing`
Evaluates synthetic equity or index asset dislocations to distinguish between mean-reverting basis noise (favorable arbitrage) vs informed off-hours repricing.
- Request: `{"coin": "xyz:SP500", "markPrice": 5520, "referenceClose": 5550, "deviationPct": -0.54}`
- Response:
  ```json
  {
    "coin": "xyz:SP500",
    "markPrice": 5520,
    "referenceClose": 5550,
    "deviationPct": -0.54,
    "verdict": "mean_reverting_noise",
    "confidence": 0.95,
    "recommended": "fade_arbitrage",
    "model": "jev-1.13.0"
  }
  ```

### Immutable Execution & Audit Journal

SEC 17a-4 / MiFID II RTS 25 compliant append-only ledger tracking all trade submissions, cancellations, and executions with arrival prices, realized slippage, and latency ms.

#### `GET /api/journal/executions`
Retrieves execution journal entries from in-memory ring buffer (up to 1,000 entries) or persistent append-only storage (`data/execution_journal.jsonl`).
- Query parameters:
  - `coin`: (Optional) Filter by coin symbol (e.g. `BTC`, `SOL`).
  - `action`: (Optional) Filter by action (`place`, `cancel`, `cancel_by_cloid`, `bulk_place`, `bulk_cancel`).
  - `limit`: (Optional) Number of entries to return (default 100, max 1000).
  - `offset`: (Optional) Offset index for pagination.
- Response:
  ```json
  {
    "status": "ok",
    "totalEntries": 42,
    "limit": 100,
    "offset": 0,
    "entries": [
      {
        "id": "1727092100000000000-1",
        "timestampNs": 1727092100000000000,
        "timestampIso": "2026-09-23T11:48:20.000Z",
        "action": "place",
        "coin": "BTC",
        "isBuy": true,
        "size": 0.05,
        "limitPrice": 63450.0,
        "arrivalPrice": 63448.5,
        "execPrice": 63449.0,
        "slippageBps": 0.78,
        "cloid": "0x1234...",
        "oid": 987654321,
        "status": "filled",
        "latencyMs": 14.2
      }
    ]
  }
  ```

#### `GET /api/journal/summary`
Retrieves cumulative execution quality and latency metrics computed across the active journal ledger.
- Response:
  ```json
  {
    "status": "ok",
    "summary": {
      "totalSubmissions": 150,
      "filledOrders": 128,
      "cancelledOrders": 22,
      "failedOrders": 0,
      "fillRatePct": 85.33,
      "totalNotionalUsd": 450250.0,
      "avgSlippageBps": 0.42,
      "avgLatencyMs": 16.5,
      "earliestTimestamp": "2026-09-23T08:00:00.000Z",
      "latestTimestamp": "2026-09-23T11:48:20.000Z"
    }
  }
  ```
