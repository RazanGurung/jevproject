# Strategies

## Current stack

There is one execution owner:

```text
Bot UI (web/src/services/bot.js)
  -> /api/bot/start|stop|status
  -> backend BotService
  -> persisted restore + fill-triggered refresh
```

The unused in-browser strategy executor (`StrategyManager`, `StrategySwitcher`, `rvwap-bollinger*`, `PezStrategyRuntime`, `PezStrategyExecution`, chart-layers overlay) was removed. Do not reload those modules for live trading.

## Active strategies

Backend `BotService` runs:

- `rvwap-bollinger`
- `rvwap-short-bollinger`
- `jev-orderflow`

Config and start/stop live on `/api/bot/*`. Status is delivered on the scoped account stream and can fall back to polling.

### Jev Orderflow Strategy (`jev-orderflow`)

- **Decision Engine:** Evaluates live Hyperliquid L2 orderbook balance, OFI (order flow imbalance), and spread via TypeSafe's Jev System One model.
- **Dynamic Skewing:** When orderflow conviction is high (>0.70), bid/ask skews adjust dynamically to favor favorable fills while stepping back from toxic liquidity sweeps.
- **Avellaneda-Stoikov Inventory Dampening:** Inspects real-time position data (`GetActiveAssetData`). If long exposure exceeds 25% of total grid allocation, bids are dampened and asks tightened to de-risk; vice-versa when short.
- **Toxic Flow Defense & Hysteresis:** When Jev detects `toxicFlowRisk > 0.65`, active orders are immediately cancelled and a 30s hysteresis cooldown window (`toxicHaltUntil`) prevents quoting churn during high-velocity liquidity cascades.

## Jev Real-Time Discretionary Trade Signals & 1-Click Ticket Execution

In addition to automated bot market-making, Jev System One powers real-time discretionary trading signals integrated directly into the manual Order Ticket.

### Where to Find it in the UI
- **LIQS & MISPRICE Column (Column 4) — 3rd Window:**
  - Dedicated full-width analytics window (`#jevSignalSection` -> `#jevSignalWindow`) located directly beneath the Liquidation Feed and Mispricing Arbitrage panels.
  - Houses the complete qualitative and quantitative orderflow breakdown:
    - **Header:** `⚡ JEV SIGNAL` with manual `↻` re-scan button.
    - **Timeframe Selector Bar (`#jevTfSelectorBar`):** Segmented horizon tabs (`SCALP 15m`, `INTRADAY 4h`, `SWING 1d+`) allowing traders to instantly switch between holding duration profiles. Switching tabs leverages local and SHA-256 state caching (<1ms response).
    - **Top Row:** Active coin badge, Action badge (`BUY` green, `SELL` red, `HOLD` neutral), and Conviction percentage with 5-star score.
    - **Duration Banner:** Estimated trade duration badge (`⏱ 15m – 45m (Quick Scalp)`, `⏱ 2h – 8h (Session Intraday)`, or `⏱ 1d – 5d (Intra-Month Swing)`) alongside the active horizon badge.
    - **Metrics Grid:** Mid Price, Limit Entry Target, Take-Profit target level (+%), Stop-Loss target level (-%).
    - **Orderflow Stats Row:** Order Flow Imbalance (OFI), Spread (bps), Risk:Reward ratio (2:1 calibrated), and Toxic Liquidity Sweep Risk (%).
    - **Thesis Narrative:** Deep microstructural orderflow reasoning card calibrated to the selected timeframe.
    - **Footer:** TypeSafe model tag (`jev-1.13.0`) and signal timestamp.
- **Trade Window (Order Ticket, Column 5) — 1-Click Fill Button:**
  - Directly above the Buy/Sell side buttons (`#sideControl`), the ticket features a sleek, compact **`⚡ FILL JEV TICKET`** button (`#jevTicketFillBtn`). Moving execution exclusively to the order ticket frees up maximal vertical space in the 3rd window, allowing all metrics to fit without scrolling.
  - Dynamically updates its label, timeframe horizon tag, and color with live market action:
    - `⚡ FILL JEV TICKET (SCALP BUY @ $81,542.00)` (green accent)
    - `⚡ FILL JEV TICKET (SWING BUY @ $81,346.00)` (green accent)
    - `⚡ FILL JEV TICKET (INTRADAY SELL @ $81,553.00)` (red accent)
    - `⚡ JEV: HOLD (SCALP NO EDGE)` (disabled, neutral)
  - Automatically hidden when the ticket is switched to `BOT` mode to keep the bot interface uncluttered.

### Multi-Timeframe Holding Horizons & ATR Dynamic Calibration
Jev generates signals calibrated for three distinct trading horizons, dynamically scaling brackets to actual market volatility (Average True Range):
1. **SCALP (`15m – 45m`)**:
   - **Focus:** Immediate top-of-book orderbook pressure, microstructure OFI surges, and touch liquidity.
   - **Entry:** Immediate touch limit (`BestBid` for buys, `BestAsk` for sells) for queue priority.
   - **Dynamic ATR Brackets:** $\text{SL} = 0.60 \times \text{ATR}_{\%}$ (clamped to $[0.18\%, 1.00\%]$), $\text{TP} = 2.0 \times \text{SL}$ (baseline fallback: 0.25% SL / 0.50% TP).
   - **Defense:** Strict toxic flow gate (`toxicRisk > 0.35` gates to HOLD) to avoid execution ahead of aggressive market sweeps.
2. **INTRADAY (`2h – 8h`)**:
   - **Focus:** Session VWAP reversion, orderbook cumulative depth, and volume-weighted session imbalances.
   - **Entry:** Optimized limit price near local liquidity support/resistance.
   - **Dynamic ATR Brackets:** $\text{SL} = 1.20 \times \text{ATR}_{\%}$ (clamped to $[0.35\%, 2.50\%]$), $\text{TP} = 2.0 \times \text{SL}$ (baseline fallback: 0.60% SL / 1.20% TP).
   - **Defense:** Standard toxic flow gate (`toxicRisk > 0.45` gates to HOLD).
3. **SWING (`1d – 5d`)**:
   - **Focus:** Macro orderbook structural support/resistance and multi-day accumulation/distribution patterns.
   - **Entry:** Structural pullback entry (±0.25% beyond mid) to enter on liquidity retreats.
   - **Dynamic ATR Brackets:** $\text{SL} = 2.20 \times \text{ATR}_{\%}$ (clamped to $[1.00\%, 6.00\%]$), $\text{TP} = 2.1 \times \text{SL}$ (baseline fallback: 2.00% SL / 4.20% TP).
   - **Defense:** Macro structural gate (`toxicRisk > 0.55` gates to HOLD).
4. **Spread Cushion Invariant:** Across all horizons, the engine strictly enforces $\text{SL} \ge 2.0 \times \text{Spread}_{\%}$, guaranteeing stop prices never land inside the exchange bid-ask spread.

### Zero-Lag Signal Hardening (Noise Elimination Without Over-Filtering)
To prevent whipsawing and chatter without adding lagging moving averages, artificial delays, or dulling signal responsiveness, Jev incorporates three structural defense layers:

1. **Dual-Threshold Schmitt Trigger Hysteresis:**
   - **Activation Threshold ($\ge 65\%$ Conviction):** Required to transition from `HOLD` into an active `BUY` or `SELL`.
   - **Retention Floor ($\ge 50\%$ Conviction):** Once established in an active position, micro-tick oscillations (e.g. 58% to 64%) retain the active signal rather than chattering into `HOLD`.
   - **Instant Regime Reversal (0ms Delay):** If the market genuinely shifts (e.g. sellers take control with $\ge 65\%$ bearish conviction), the signal reverses from `BUY` to `SELL` immediately without lag.
   - **Instant Toxic Tripwire (0ms Delay):** If aggressive sweep flow breaches the threshold (35% scalp, 45% intraday, 55% swing), the signal drops to `HOLD` instantly with a 15s stabilization cooldown.

2. **Spatial Multi-Depth Divergence (Zero-Time Spoof Defense):**
   - In the exact same snapshot millisecond, Jev separates **Level 0 Touch Depth** (`touchBidUSD`, `touchAskUSD`) from **Levels 1–9 Deep Depth** (`deepBidUSD`, `deepAskUSD`).
   - If a spoofer flashes a fake bid at touch while deep asks overhang behind it, Jev identifies the **Touch/Deep Divergence** and flags it in the analysis thesis, refusing to fire a false breakout signal.

3. **Gate 6: Macro Trend Confluence Filter (Anti-Fading Protection):**
   - Injects real-time 24h price change, 24h volume, and funding rates from Hyperliquid's cached asset contexts.
   - Suppresses counter-trend `BUY` signals during 24h dumps ($\le -3.5\%$) down to `HOLD`, unless conviction is institutional ($\ge 78\%$).
   - Suppresses counter-trend `SELL` signals during 24h bull rallies ($\ge +3.5\%$) down to `HOLD`, unless conviction is institutional ($\ge 78\%$).

4. **Gate 7: Macro Monthly & Quarterly Volume Profile & Extension Filter (Auction Market Theory Resistance/Support Rejection):**
   - **Lookback Modernization (Monthly & Quarterly Profiles Replacing 365D Lookback):** A 365-day volume profile is too long in 24/7 crypto markets, spanning multiple macro cycles and flattening value areas across irrelevant historical regimes. The engine transitions to:
     - **Monthly (30-Day) Volume Profile & TWAP:** Captures the active monthly auction, monthly options expiry, and immediate range structure ($[VAL_{30}, VAH_{30}]$, $POC_{30}$) calibrated for **Scalp (15m–45m)** and **Intraday (2h–8h)** horizons.
     - **Quarterly (90-Day) Volume Profile & TWAP:** Captures the 3-month macro auction, quarterly options expiry, and high-timeframe structural balance ($[VAL_{90}, VAH_{90}]$, $POC_{90}$) calibrated for **Swing (1d–5d)** horizons.
     - **Dual Extension Confluence:** Intraday trades operating within a Monthly (30D) profile still respect extreme extension from the Quarterly (90D) TWAP anchor ($\ge 6.0\%$).
   - Measures multi-day extension from the active volume-weighted anchor (30D or 90D TWAP) and benchmarks current move progression against the rolling 14-day average candle expansion (Average True Impulse Move %).
   - **Exhaustion & Overhead Resistance Interception:**
     - Suppresses `BUY` signals to `HOLD` when price is trading at or above Monthly/Quarterly VAH, or when the move is extended $\ge +6.0\%$ above TWAP (or move expansion consumed $\ge 85\%$). This eliminates false breakout traps caused by temporary bid depth absorption at macro distribution tops.
     - Suppresses `SELL` signals to `HOLD` when price is trading at or below Monthly/Quarterly VAL, or when the move is extended $\le -6.0\%$ below TWAP (or move expansion consumed $\le -85\%$).
   - **Neutral HOLD Execution Ticket Neutralization:**
     - On any `HOLD` signal, entry, TP, and SL target prices are cleared to 0 (rendering as `—` in the UI) rather than defaulting to entry price with pseudo-long brackets, eliminating misleading order ticket displays at structural inflection points.
    - **Zero-Latency In-Memory Caching & Dedicated Priority Lane:**
      - Monthly and Quarterly Volume Profile and TWAP anchor metrics are cached in-memory with a 15-minute TTL, enabling sub-millisecond recalculations against live `midPrice`.
      - Candle reads for discretionary trade signals are routed through a dedicated semaphore (`jevCandleSem`, capacity 2) mapped to `infogovernor.Enrichment`, isolating interactive signal generation from background chart preloading and warm coordinator passes. Bound to a hard 1.5s timeout with instant fallback.

5. **Trend vs. Counter-Trend Signal Expansion & Range High/Low Mean Reversion:**
   - **The Problem Solved:** In a sideways or rangebound market, conventional momentum or orderbook models often fire a `BUY` signal at the top of a trading range because buyers are aggressively market-buying into resistance, or a `SELL` signal at range lows because sellers are dumping into support. In a range environment, buying range highs and selling range lows leads to whipsaws and poor execution.
   - **Market Environment Classification (`market_environment`):**
     - Evaluates 24-hour price momentum, rolling ATR volatility, and distance relative to the Steidlmayer Volume Profile Value Area ($[VAL, VAH]$).
     - Classified as **`"range"`** when $|change_{24h}| \le 3.5\%$ and $ATR_{\%} \le 1.8\%$ and price trades within or near the value area boundaries.
     - Classified as **`"trend"`** when strong directional momentum or high ATR indicates active price discovery and expansion.
   - **Range High Mean Reversion (Counter-Trend Short):**
     - When price trades in the upper band of the range ($mid \ge VAH - 0.20 \times \text{range\_span}$), retail buying pressure is classified as **liquidity exhaustion into overhead resistance**.
     - Unless institutional breakout conviction is exceptional ($\ge 82\%$), the engine inverts the signal into an intraday **Counter-Trend Short** (`action: "SELL"`, `signal_type: "counter_trend"`).
     - **Targeting & Brackets:** Entry is pegged at resistance (`BestAsk`), take-profit targets mean-reversion back to the Point of Control (`POC`), and stop-loss is placed just above VAH ($VAH + 0.50 \times \text{SL\_dist}$).
     - If institutional conviction reaches or exceeds $82\%$, the engine validates a true breakout, emitting a **Trend Breakout Long** (`action: "BUY"`, `signal_type: "trend"`).
     - **Orderflow Absorption Quality Filter:** If aggressive buyers are actively lifting asks with positive book imbalance ($> +0.10$) and conviction is $< 82\%$, entering a short prematurely steps into an unabsorbed buyer surge. The engine gates to **`HOLD`** (`awaiting order flow absorption/rejection before fading`) until either orderflow pivots bearish or absorption is confirmed ($\text{conviction} \ge 70\%$, $\text{imbalance} \le +0.10$).
   - **Range Low Mean Reversion (Counter-Trend Long):**
     - When price trades in the lower band of the range ($mid \le VAL + 0.20 \times \text{range\_span}$), aggressive selling is classified as **liquidity absorption into support**.
     - Unless institutional breakdown conviction reaches $\ge 82\%$, the engine evaluates an intraday **Counter-Trend Long** (`action: "BUY"`, `signal_type: "counter_trend"`).
     - **Targeting & Brackets:** Entry is pegged at support (`BestBid`), take-profit targets mean-reversion back to `POC`, and stop-loss is placed just below VAL ($VAL - 0.50 \times \text{SL\_dist}$).
     - If institutional breakdown conviction reaches or exceeds $82\%$, the engine emits a **Trend Breakdown Short** (`action: "SELL"`, `signal_type: "trend"`).
     - **Orderflow Absorption Quality Filter:** If aggressive sellers are actively dumping into bids with negative book imbalance ($< -0.10$) and conviction is $< 82\%$, longing prematurely catches a falling knife. The engine gates to **`HOLD`** (`awaiting order flow absorption/bounce before longing`) until orderflow pivots bullish or absorption is confirmed ($\text{conviction} \ge 70\%$, $\text{imbalance} \ge -0.10$).
   - **Trend Environment Dynamics:**
     - In an established trend, signals aligned with macro momentum are tagged **`"trend"`**.
     - High-conviction pullbacks and relief squeezes passing Gate 6 ($\ge 78\%$ conviction) are explicitly tagged **`"counter_trend"`**.
   - **UI Badges & Volume Profile Context Strip:**
     - The 3rd Jev window displays dedicated color-coded badges: `TREND` (cyan/blue) vs `COUNTER-TREND` (amber/gold), and `RANGE` (purple) vs `TREND` (blue).
     - A dedicated **Volume Profile & TWAP Context Strip** displays active profile levels ($VAL, $POC, $VAH) and distance from TWAP: e.g., `30D VP: VAL $76,300 · POC $77,900 · VAH $80,100 (+10.5% TWAP)`.
     - The 1-Click Ticket Fill button dynamically includes the descriptor: e.g., `⚡ FILL JEV TICKET (INTRADAY COUNTER-TREND SELL @ $65,450)`.

### TypeSafe Jev Engineering Blueprint Implementation
Based on design notes by Diogo Almeida (TypeSafe), the terminal integrates the complete 9-subsystem Jev harness architecture (detailed in [JEV_ENGINEERING_GUIDE.md](JEV_ENGINEERING_GUIDE.md)):
- **Visibility Ladder Context Assembly:** Instead of static prompt dumps or query-blind compaction, `Analyze` dynamically sizes context depth using the 4-tier Visibility Ladder:
  - `SCALP` $\to$ `VisibilityShort`: Emphasizes touch liquidity, micro-price drift, immediate OFI, and spread bps; prunes macro POC noise.
  - `INTRADAY` $\to$ `VisibilityLong`: Balanced top-10 depth asymmetry, OFI, touch/deep divergence, session ATR, and Monthly (30D) POC/VAH/VAL.
  - `SWING` $\to$ `VisibilityFull`: Multi-level liquidity walls, Quarterly (90D) POC/VAL/VAH, 24h volume, and funding rate.
- **In-Flight Subgoal Deduplication:** `GenerateSignal` leverages `SubgoalRegistry.RegisterInFlight` to coalesce concurrent requests for the same coin and timeframe without duplicate upstream API invocations, returning cached results marked `cacheReused = true`.
- **Programmable Permissions Pre-Trade Audit:** `AuditPreTrade` applies declarative policy queries over order size, depth wipe, and momentum:
  - `deny` if single order $> \$500,000$ (circuit breaker limit).
  - `deny` if depth wipe $> 80\%$ or slippage severe.
  - `ask` if depth wipe $> 35\%$ or toxic flow risk $\ge 0.70$.
  - `allow` if slippage is acceptable and depth wipe $\le 35\%$.
- **Shared Retrieval Pass:** `SharedRetrievalCache` ensures computationally expensive L2 depth analysis, micro-price drift, OFI, ATR, and volume profile calculations are performed once per snapshot window and shared across all read-only background evaluators.

### Python Validation & Strategy Backtesting Harness (`scripts/jev_validation/`)
The repository includes a standalone, standard-library Python (3.9+) test and audit harness:
- `jev_model.py`: Reference Python implementation of the microstructure engine and signal generator with bit-level parity to Go.
- `jev_harness.py`: Reference implementation of Diogo Almeida's TypeSafe Jev Engineering Blueprint (ChunkStore, Visibility Ladder, Priced Routing, Tiered Tools, Programmable Permissions, Subgoal Deduplicator, Conditional Instructions, Security Routing, Shared Retrieval).
- `test_jev_signal.py`: 40 unit tests validating orderbook parsing, micro-price drift, OFI, Schmitt trigger, defense gates, ATR brackets, macro volume profile (Monthly 30D / Quarterly 90D VAH/VAL/POC), TWAP extension, price normalization, and Trend vs Counter-Trend / Range Boundary Absorption logic.
- `test_jev_harness.py`: 10 unit tests covering all 9 subsystems of the Jev Blueprint.
- `run_audit.py`: 150-tick sequential orderflow simulation runner verifying zero harmful whipsaws across multiple market regimes.
- `backtest.py`: Full strategy backtester modeling Hyperliquid taker/maker fees, fill slippage, bar high/low stop-outs, rolling monthly/quarterly volume profiles, and separate performance tracking across Trend (+87.13% net, 72.4% WR) and Counter-Trend (+11.74% net, 100.0% WR) regimes, achieving +98.87% net realized return, 78.95% overall win rate, and Sharpe Ratio 4.49.

### 1-Click Execution Workflow
Clicking **`⚡ FILL JEV TICKET`**:
1. Toggles the appropriate side (`Buy / Long` or `Sell / Short`).
2. Forces Limit Price Entry Mode to **Manual** (disabling auto-tracking so the signal's limit price remains locked).
3. Fills the `Price (USDC)` input with the exact recommended entry price for the active timeframe.
4. Fills the `Take Profit %` input with the calibrated TP bracket for that timeframe.
5. Fills the `Stop Loss %` input with the calibrated SL bracket for that timeframe.
6. Automatically dispatches DOM input/change events to recalculate order value, fees, liquidation distance, and chart preview levels.
7. Displays tactile button feedback (`✓ TICKET PREPARED (ENTRY, TP & SL)`).

### Browser Caching Note
Because modern browsers cache JavaScript bundles aggressively, always press **`Cmd + Shift + R`** (Mac) or `Ctrl + Shift + R` (PC) after building release updates to ensure the latest compiled bundle and DOM layout are loaded.



## Host seam

`strategy-host.js` still injects:

- `PriceFeed` (topbar / tab-resume timestamps)
- bot UI helpers (`refreshBotStatus`, `applyBotStatus`, `loadBotStrategy`, …)

`window.PezStrategyHost` is that injection surface, not a client order path.

## Current rules

- Backend bot execution should survive browser reloads, tab switches, and reconnects.
- `PEZ_BOT_STATE_FILE` enables bot restore after backend restart when the key is available.
- Manual cancel/delete of bot-managed orders is operator intervention on the backend attach path.
- Do not add a second frontend execution stack beside `BotService`.
