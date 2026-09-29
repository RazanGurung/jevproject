# Roadmap

Future work only. None of this is required before live validation of the current build.

Chart adapter contract: [CHART.md](CHART.md). Current posture:
[PROJECT_STATUS.md](PROJECT_STATUS.md).

## Near Term

- Run funded live validation after transport/execution changes.
- Add focused tests for concrete bugs and async failure modes.
- Keep docs current after behavior or ownership changes (latest change in PROJECT_STATUS; a short PROJECT_STATUS_HISTORY bullet; do not re-dump smoke transcripts).
- Keep bot execution backend-owned; do not reintroduce a frontend strategy executor.

## Intentional non-goals

- Do **not** plot RVWAP on extra 4h timestamps that are not already on the candle series. That inserts logical indexes and breaks history-prepend range shifts. Low-TF visible left-end growth with scrollback is overlay clipping, not a bug. See [CHART.md](CHART.md).
- Do not start another structural cleanup wave without a concrete bug, feature, or hotspot.

## Feature Backlog

### OI / Footprint

- 5m open-interest delta pane from `activeAssetCtx`
- trade-bin footprint cells by price row — *partially covered July 3, 2026: the DOM ladder panel now shows session buy/sell volume-at-price per grid level (`state/dom-ladder-state.js`); a chart-integrated footprint could build on that aggregation*
- reconnect-safe aggregation
- session-start history only unless S3 backfill becomes worth the complexity

### Risk Controls

- max size per trade
- max aggregate exposure
- max concurrent positions
- daily loss / weekly drawdown lock
- reduce-only damage mode
- backend validation for critical rules — *partially covered September 21, 2026: TypeSafe Jev Pre-Trade Audit (`/api/jev/pre-trade-audit`) with programmable permissions (`allow`, `ask`, `deny`) and deep script inspection enforces circuit breaker ceiling ($500k), catastrophic book wipe (> 80%), excessive adverse selection (> 35%), and toxic flow gating*

### Trade Review

- grouped fills into trades
- tags, notes, setup attribution
- MAE/MFE and stats by setup/coin/session
- optional chart snapshots at entry/exit

### Market News

- tune impact weights from observed false positives and false negatives
- improve near-duplicate event clustering across differently worded publishers
- extend official-source mappings when a stable free RSS/Atom endpoint exists
- keep the feed read-only and independent from chart signals, risk, and execution

### Deployment Tools

- bracket deploys
- one-click protect existing position
- flip/reverse with validation
- deploy into TWAP or scale templates

### Semi-Automation

- arm signal and wait for trigger
- auto-place protection after confirmed fill
- breakeven automation
- portfolio-aware deployment logic
