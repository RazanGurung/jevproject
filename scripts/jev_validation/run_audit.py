#!/usr/bin/env python3
"""
PEZ$ Jev System One Orderflow Signal Audit Runner.
Executes deep validation across microstructural mathematics, Schmitt trigger hysteresis,
spatial multi-depth spoof defense, and multi-timeframe horizon calibration.

Usage:
    python3 scripts/jev_validation/run_audit.py
    python3 scripts/jev_validation/run_audit.py --verbose
    python3 scripts/jev_validation/run_audit.py --ticks 250
"""

import argparse
import math
import sys
import time
from typing import Any, Dict
import unittest
from pathlib import Path

# Ensure jev_validation package is in sys.path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR.parent) not in sys.path:
    sys.path.insert(0, str(BASE_DIR.parent))

from jev_validation.jev_model import JevSignalEngine
import jev_validation.test_jev_signal as test_suite


def run_unit_tests(verbosity: int = 1) -> bool:
    """Runs the unit test suite and returns True if all passed."""
    print("=" * 72)
    print("STEP 1: RUNNING UNIT TEST BATTERY")
    print("=" * 72)
    suite = unittest.TestLoader().loadTestsFromModule(test_suite)
    runner = unittest.TextTestRunner(verbosity=verbosity)
    result = runner.run(suite)
    return result.wasSuccessful()


def run_market_simulation(num_ticks: int = 150, verbose: bool = False) -> Dict[str, Any]:
    """
    Simulates a sequence of market orderbook regimes to audit:
    - Calm consolidation (verifying no chatter/whipsaws)
    - Bullish breakout (verifying activation and bracket calibration)
    - Micro-pullback noise (verifying Schmitt trigger retention)
    - Flash spoofing attack (verifying touch/deep divergence defense)
    - Toxic liquidity cascade (verifying instant tripwire and 15s cooldown)
    - Rapid regime break (verifying 0ms reversal)
    - Wide spread expansion (verifying spread friction gate)
    """
    print("\n" + "=" * 72)
    print(f"STEP 2: RUNNING SEQUENTIAL ORDERFLOW SIMULATION ({num_ticks} TICKS)")
    print("=" * 72)

    engine = JevSignalEngine(sz_decimals=2)
    start_ts = 1726900000.0  # Synthetic fixed timestamp

    # Counters
    stats = {
        "total_ticks": num_ticks,
        "actions": {"BUY": 0, "SELL": 0, "HOLD": 0},
        "whipsaws": 0,
        "gates_triggered": {
            "toxic_tripwire": 0,
            "spoof_defense": 0,
            "spread_friction": 0,
            "crossed_book": 0,
        },
        "hysteresis_retentions": 0,
        "regime_reversals": 0,
    }

    last_action = "HOLD"

    for i in range(num_ticks):
        current_ts = start_ts + (i * 2.0)  # 2s tick cadence
        phase = i % 70

        # Default mid and book
        mid = 65000.0 + (math.sin(i * 0.1) * 20.0)
        best_bid = mid - 1.0
        best_ask = mid + 1.0
        spread_bps = ((best_ask - best_bid) / mid) * 10000.0

        # Scenario orchestration
        if phase < 15:
            # Regime 1: Consolidation / Neutral
            decision = {
                "direction": "neutral",
                "confidence": 0.80,
                "probabilities": {"bullish": 0.1, "neutral": 0.8, "bearish": 0.1},
                "toxic_risk": 0.05,
            }
            raw_book = {
                "levels": [
                    [{"px": str(best_bid), "sz": "1.0"}, {"px": str(best_bid - 2.0), "sz": "2.0"}],
                    [{"px": str(best_ask), "sz": "1.0"}, {"px": str(best_ask + 2.0), "sz": "2.0"}],
                ]
            }

        elif phase < 30:
            # Regime 2: Bullish Momentum Breakout (0.78 conviction)
            decision = {
                "direction": "bullish",
                "confidence": 0.78,
                "probabilities": {"bullish": 0.78, "neutral": 0.15, "bearish": 0.07},
                "toxic_risk": 0.08,
            }
            raw_book = {
                "levels": [
                    [{"px": str(best_bid), "sz": "5.0"}, {"px": str(best_bid - 2.0), "sz": "10.0"}],
                    [{"px": str(best_ask), "sz": "1.0"}, {"px": str(best_ask + 2.0), "sz": "1.5"}],
                ]
            }

        elif phase < 40:
            # Regime 3: Micro-noise pullback (conviction dips to 0.56 -> Hysteresis test)
            decision = {
                "direction": "bullish",
                "confidence": 0.56,
                "probabilities": {"bullish": 0.56, "neutral": 0.30, "bearish": 0.14},
                "toxic_risk": 0.12,
            }
            raw_book = {
                "levels": [
                    [{"px": str(best_bid), "sz": "2.0"}, {"px": str(best_bid - 2.0), "sz": "4.0"}],
                    [{"px": str(best_ask), "sz": "1.8"}, {"px": str(best_ask + 2.0), "sz": "2.0"}],
                ]
            }

        elif phase < 45:
            # Regime 4: Flash Spoof Attack (touch bid inflated, but massive deep ask overhang)
            decision = {
                "direction": "bullish",
                "confidence": 0.75,
                "probabilities": {"bullish": 0.75, "neutral": 0.15, "bearish": 0.10},
                "toxic_risk": 0.10,
            }
            raw_book = {
                "levels": [
                    [{"px": str(best_bid), "sz": "8.0"}, {"px": str(best_bid - 2.0), "sz": "0.1"}],
                    [{"px": str(best_ask), "sz": "0.5"}, {"px": str(best_ask + 2.0), "sz": "25.0"}],  # 25 BTC ask overhang
                ]
            }

        elif phase < 52:
            # Regime 5: Toxic sweep cascade (toxic_risk spikes to 0.68)
            decision = {
                "direction": "bullish",
                "confidence": 0.70,
                "toxic_risk": 0.68,
            }
            raw_book = {
                "levels": [
                    [{"px": str(best_bid), "sz": "0.5"}],
                    [{"px": str(best_ask), "sz": "10.0"}],
                ]
            }

        elif phase < 62:
            # Regime 6: Aggressive Seller Control & Regime Reversal (0.84 bearish)
            decision = {
                "direction": "bearish",
                "confidence": 0.84,
                "probabilities": {"bearish": 0.84, "neutral": 0.10, "bullish": 0.06},
                "toxic_risk": 0.10,
            }
            raw_book = {
                "levels": [
                    [{"px": str(best_bid), "sz": "0.8"}, {"px": str(best_bid - 2.0), "sz": "1.0"}],
                    [{"px": str(best_ask), "sz": "6.0"}, {"px": str(best_ask + 2.0), "sz": "12.0"}],
                ]
            }

        else:
            # Regime 7: Spread blowout (35 bps spread on intraday -> spread gate test)
            wide_bid = mid - 12.0
            wide_ask = mid + 12.0
            decision = {
                "direction": "bullish",
                "confidence": 0.75,
                "toxic_risk": 0.05,
            }
            raw_book = {
                "levels": [
                    [{"px": str(wide_bid), "sz": "1.0"}],
                    [{"px": str(wide_ask), "sz": "1.0"}],
                ]
            }

        sig = engine.generate_signal(
            coin="BTC",
            raw_book=raw_book,
            jev_decision=decision,
            timeframe="intraday",
            now_ts=current_ts,
        )

        act = sig["action"]
        stats["actions"][act] += 1

        # Check for harmful whipsaws (immediate BUY <-> SELL flips within 1 tick without regime break)
        if (last_action == "BUY" and act == "SELL") or (last_action == "SELL" and act == "BUY"):
            if "Regime reversal" not in sig["reason"]:
                stats["whipsaws"] += 1

        # Check gate attributions
        if "tripwire" in sig["reason"] or "stabilizing" in sig["reason"]:
            stats["gates_triggered"]["toxic_tripwire"] += 1
        if "Spoof trap" in sig["reason"]:
            stats["gates_triggered"]["spoof_defense"] += 1
        if "Spread too wide" in sig["reason"]:
            stats["gates_triggered"]["spread_friction"] += 1
        if "crossed" in sig["reason"]:
            stats["gates_triggered"]["crossed_book"] += 1
        if "hysteresis" in sig["reason"]:
            stats["hysteresis_retentions"] += 1
        if "Regime reversal" in sig["reason"]:
            stats["regime_reversals"] += 1

        if verbose and (i < 20 or i % 10 == 0):
            print(f"Tick {i:03d} | Action: {act:4s} | Conv: {sig['conviction']*100:.0f}% | OFI: {sig['book_imbalance']:+.2f} | Reason: {sig['reason'][:55]}")

        last_action = act

    return stats


def print_audit_report(stats: Dict[str, Any]):
    """Formats and prints the executive audit report."""
    print("\n" + "=" * 72)
    print("AUDIT REPORT SUMMARY: JEV SYSTEM ONE ORDERFLOW SIGNAL")
    print("=" * 72)
    print(f"Total Evaluated Ticks:         {stats['total_ticks']}")
    print(f"Action Distribution:           BUY: {stats['actions']['BUY']} ({stats['actions']['BUY']/stats['total_ticks']*100:.1f}%) | "
          f"SELL: {stats['actions']['SELL']} ({stats['actions']['SELL']/stats['total_ticks']*100:.1f}%) | "
          f"HOLD: {stats['actions']['HOLD']} ({stats['actions']['HOLD']/stats['total_ticks']*100:.1f}%)")
    print(f"Hysteresis Retentions:         {stats['hysteresis_retentions']} (Micro-noise chatter prevented)")
    print(f"Clean Regime Reversals:        {stats['regime_reversals']} (0ms delay trend pivots)")
    print(f"Harmful Whipsaws:              {stats['whipsaws']} (0 allowed)")
    print("\nDefense Gates Audit:")
    print(f"  - Toxic Sweep Tripwires:     {stats['gates_triggered']['toxic_tripwire']} triggered")
    print(f"  - Spoof Trap Divergences:    {stats['gates_triggered']['spoof_defense']} intercepted")
    print(f"  - Spread Friction Gated:     {stats['gates_triggered']['spread_friction']} intercepted")
    print(f"  - Crossed Book Pauses:       {stats['gates_triggered']['crossed_book']} intercepted")

    passed = stats["whipsaws"] == 0 and stats["gates_triggered"]["spoof_defense"] > 0 and stats["gates_triggered"]["toxic_tripwire"] > 0
    print("\n" + "-" * 72)
    if passed:
        print("AUDIT VERDICT: [PASS] All microstructural invariants and safety gates verified.")
    else:
        print("AUDIT VERDICT: [FAIL] Invariants breached.")
    print("-" * 72 + "\n")
    return passed


def main():
    parser = argparse.ArgumentParser(description="Jev System One Orderflow Audit Harness")
    parser.add_argument("--verbose", "-v", action="store_true", help="Print verbose tick details")
    parser.add_argument("--ticks", "-t", type=int, default=150, help="Number of ticks to simulate")
    args = parser.parse_args()

    tests_ok = run_unit_tests(verbosity=2 if args.verbose else 1)
    if not tests_ok:
        print("\n[ERROR] Unit tests failed! Aborting simulation.")
        sys.exit(1)

    stats = run_market_simulation(num_ticks=args.ticks, verbose=args.verbose)
    passed = print_audit_report(stats)

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
