# Jev System One Orderflow Signal Validation Harness

Standard library Python (3.9+) test and audit harness for validating the **TypeSafe Jev System One** orderbook microstructure engine, trade signal generation, and multi-timeframe horizon calibration. Zero third-party dependencies.

---

## 1. Scope and Invariants

The harness exercises and audits the quantitative and qualitative signal generation pipeline implemented in `internal/services/jev_service.go`:

1. **Spatial Multi-Tier Depth Separation & Level-Decayed Weights:**
   - Level 0 touch depth ($TouchBid$, $TouchAsk$) vs Levels 1–9 deep depth ($DeepBid$, $DeepAsk$).
   - Level decay weighting: $w_i = \frac{1}{1 + i}$ for $i \in [0..9]$, preventing deep fake-walls from distorting queue balance.
2. **Micro-Price & Basis Drift:**
   - Evaluates touch queue pressure via $\text{MicroPrice} = \frac{Q_{bid} \cdot P_{ask} + Q_{ask} \cdot P_{bid}}{Q_{bid} + Q_{ask}}$.
   - Computes drift in basis points ($\text{MicroPriceDriftBps}$) to detect short-term quote pressure.
3. **Cont-Kukanov-Stoikov Dynamic Order Flow Imbalance (OFI):**
   - Reconstructs sequential orderflow deltas across successive snapshot ticks.
   - Blends 70% dynamic OFI with 30% weighted depth imbalance on active streams.
4. **Zero-Lag Schmitt Trigger Hysteresis:**
   - **Activation Threshold ($\ge 65\%$ Conviction):** Transitions from `HOLD` to `BUY` or `SELL`.
   - **Retention Floor ($\ge 50\%$ Conviction):** Prevents micro-noise oscillation (e.g. 52%–64%) from chattering into `HOLD`.
   - **Instant Regime Reversal (0ms Delay):** Immediate reversal on aggressive counter-conviction ($\ge 65\%$).
   - **Neutral Consolidation Step-Down:** Differentiates neutral regime certainty from directional conviction to prevent false retention during dead consolidation.
   - **3-Minute Memory Window:** Times out stale states back to the activation barrier.
5. **Defense Gates & Capital Protection:**
   - **Instant Toxic Sweep Tripwire:** Drops to `HOLD` when sweep risk spikes ($\ge 35\%$ scalp, $\ge 45\%$ intraday, $\ge 55\%$ swing) with a 15s stabilization cooldown.
   - **Zero-Lag Spoof Trap Defense:** Blocks breakout signals when touch depth diverges from opposing deep structural overhang.
   - **Spread Friction Gating:** Blocks signals when bid-ask spread exceeds strategy limits or consumes $\ge 75\%$ of the stop-loss budget.
   - **Crossed / Inverted Book Protection:** Instantly pauses quoting when $P_{bid} \ge P_{ask}$.
   - **Gate 7 Macro Monthly & Quarterly Volume Profile & Extension Rejection:** Modernized from stale 365-day lookbacks to active Monthly (30D) and macro Quarterly (90D) Volume Profiles. Intercepts long signals at Monthly/Quarterly VAH or when move is $\ge 85\%$ exhausted above 30D/90D TWAP anchors ($\ge 6.0\%$); intercepts short signals at Monthly/Quarterly VAL or when move is $\ge 85\%$ exhausted below TWAP anchors ($\le -6.0\%$). On HOLD, clears entry/TP/SL target prices. Features in-memory caching (15-min TTL) and bounded 1.5s timeout for instantaneous evaluation.
6. **Multi-Timeframe Horizon Calibration:**
   - **SCALP (15m–45m):** Touch limit entry, tight brackets (0.50% TP / 0.25% SL, 2:1 R:R), strict 35% toxic gate.
   - **INTRADAY (2h–8h):** Local support entry, session brackets (1.20% TP / 0.60% SL, 2:1 R:R), 45% toxic gate.
   - **SWING (1d–5d):** Structural pullback entry (±0.25%), macro brackets (4.20% TP / 2.00% SL, 2.1:1 R:R), 55% toxic gate.
7. **Trend vs. Counter-Trend Signal Expansion & Range Boundary Reversion:**
   - **Market Environment:** Classifies market into `"range"` vs `"trend"` using 24h momentum ($\le 3.5\%$), ATR ($\le 1.8\%$), and Steidlmayer Value Area boundaries ($[VAL, VAH]$).
   - **Range High Rejection:** In a range environment, retail buying pressure into VAH without institutional breakout conviction ($\ge 82\%$) produces a **Counter-Trend Short** (`action: "SELL"`, `signal_type: "counter_trend"`) targeting POC mean reversion with SL above VAH. If conviction $\ge 82\%$, fires a **Trend Breakout Long**.
   - **Range Low Bounce:** In a range environment, retail selling into VAL without breakdown conviction ($\ge 82\%$) produces a **Counter-Trend Long** (`action: "BUY"`, `signal_type: "counter_trend"`) targeting POC mean reversion with SL below VAL. If conviction $\ge 82\%$, fires a **Trend Breakdown Short**.
   - **Trend Following & Counter-Trend Exhaustion:** In a trend environment, momentum trades are tagged `"trend"`; extreme pullbacks passing Gate 6 ($\ge 78\%$) are tagged `"counter_trend"`.
8. **Hyperliquid Execution Price Normalization:**
   - Enforces 5 significant figures, at most $6 - szDecimals$ decimal places, and the integer price exception.
9. **TypeSafe Jev Engineering Blueprint Subsystems (`jev_harness.py`):**
   - **Addressable State / ChunkStore:** Hierarchical key-path addressing, spatial slice filtering, metadata tagging, and LRU eviction.
   - **4-Tier Visibility Ladder:** Query-aware dynamic context formatting across `hide` (0 tok), `short` (1-line), `long` (detailed metrics), and `full` (raw content).
   - **Dynamic FilterHeatmap:** Compresses 2,400+ line outputs (logs, deep orderbook levels) down to highest-scoring lines within token budgets.
   - **KV Cache Reuse Evaluator:** Calculates reuse noul ($C_{\text{noul}} = U \cdot B_{\text{hit}} - O_{\text{chunk}} \cdot B_{\text{cost}}$) to determine cache prefix reuse vs rebuild.
   - **Priced Model Routing Cost Engine:** Implements Diogo Almeida's routing trap arithmetic ($25Y+5Z$ vs $3X+20Y+8Z$ vs purpose-built context $3X'+15Y+3Z+5Y_{\text{summary}}$).
   - **Tiered Tool Disclosure:** 3 disclosure tiers (Tier 1 snippets, Tier 2 full JSON schemas, Tier 3 docs) with plain-text intent routing.
   - **Programmable Permissions with Deep Script Inspection:** Declarative execution policies inspecting full script bodies (`allow`, `ask`, `deny`).
   - **Sub-Agent Concurrency & Subgoal In-Flight Deduplication:** Read-only tasks never contend for locks (`ExecuteReadOnly`), while `SubgoalRegistry` coalesces in-flight queries.
   - **Conditional Instructions & Security Routing:** Compaction-immune condition-bound instruction fragments and file sensitivity classification.
   - **Shared Retrieval Cache:** Multi-session cross-turn caching of expensive market metrics across read-only background evaluators.

---

## 2. Usage

### Run Unit Tests
```sh
# Run Orderbook Microstructure & Strategy Signal Tests (28 tests)
python3 scripts/jev_validation/test_jev_signal.py -v

# Run TypeSafe Jev Engineering Blueprint Tests (10 tests)
python3 scripts/jev_validation/test_jev_harness.py -v

# Run All 40 Validation Tests Across All Suites
python3 -m unittest discover -s scripts/jev_validation -v
```

### Run Deep Simulation Audit
```sh
# Standard run (150 simulated orderflow ticks across all market regimes)
python3 scripts/jev_validation/run_audit.py

# Verbose mode (tick-by-tick orderbook and OFI diagnostics)
python3 scripts/jev_validation/run_audit.py --verbose

# Custom tick length
python3 scripts/jev_validation/run_audit.py --ticks 300
```

### Run Strategy Backtester & Parameter Optimizer
```sh
# Run standard 500-bar backtest (simulating fills, fee drag, slippage, drawdown, and trend vs counter-trend breakdown)
python3 scripts/jev_validation/backtest.py

# Verbose trade log showing signal_type (trend vs counter_trend)
python3 scripts/jev_validation/backtest.py --verbose

# Compare with/without Gate 7 Macro Volume Profile and Extension Gating
python3 scripts/jev_validation/backtest.py
python3 scripts/jev_validation/backtest.py --disable-macro-gate

# Compare ATR-calibrated dynamic brackets against fixed % brackets
python3 scripts/jev_validation/backtest.py --bracket-mode fixed
python3 scripts/jev_validation/backtest.py --bracket-mode atr --verbose

# Run parameter optimization grid sweep (finding optimal activation, retention, and risk parameters)
python3 scripts/jev_validation/backtest.py --optimize
```

---

## 3. Test Suites

| Category | Suite | Invariants Tested |
|----------|-------|-------------------|
| **Category A** | `TestOrderbookMicrostructureMath` | Extended depth parsing, level decay ($w_i = \frac{1}{1+i}$), micro-price drift, Cont-Kukanov-Stoikov dynamic OFI. |
| **Category B** | `TestSchmittTriggerHysteresis` | $\ge 65\%$ activation, $\ge 50\%$ retention floor, sub-50% step-down, 0ms regime reversal, neutral consolidation handling, 3m memory expiration. |
| **Category C** | `TestTripwiresAndDefenseGates` | Instant toxic tripwires (scalp/intraday/swing), 15s cooldown stabilization, spoof trap divergence, crossed book pause, spread friction gating. |
| **Category D** | `TestMultiTimeframeCalibrationAndPricing` | Scalp, intraday, swing brackets and duration strings; pullback pricing; Hyperliquid 5 sig fig price normalization. |
| **Category E** | `TestMacroStructureAndVolumeProfileGates` | Steidlmayer Auction Market Theory (Monthly 30D / Quarterly 90D profile, POC, VAH, VAL, 70% value area), 30D/90D TWAP anchor distance, 14-day impulse expansion exhaustion, Gate 7 resistance/support suppression, and neutral HOLD target price clearing. |
| **Category F** | `TestJevHarness` | All 9 TypeSafe Jev Engineering Blueprint subsystems: Addressable State / ChunkStore, Visibility Ladder, FilterHeatmap, Cache Reuse Noul, Priced Model Routing Arithmetic, Tiered Tool Router, Programmable Permissions with Deep Script Inspection, Subgoal Deduplication, Conditional Instructions, and Shared Retrieval Caching. |
| **Category G** | `TestRangeAndTrendSignalExpansion` | Range High Counter-Trend Short (selling into VAH resistance targeting POC with absorption filter), Range Low Counter-Trend Long (buying into VAL support targeting POC with absorption filter), Range Boundary Unabsorbed Flow Hold Gates, Range High Breakout Trend Long ($\ge 82\%$ conviction override), and Trend vs Counter-Trend tagging. |

---

## 4. Acceptance Criteria

Exit `0` requires:
1. 100% of unit tests passing (all 40 tests across all suites).
2. 0 harmful whipsaws during market simulation.
3. 100% spoof trap divergences and toxic sweep events intercepted before order dispatch.
4. Clean evaluation of all 9 Jev Engineering Blueprint subsystems with 0 cost routing anomalies.
5. Bit-level parity between Go and Python for Trend vs Counter-Trend and Range High/Low signal generation.
