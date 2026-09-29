"""
Comprehensive Python Test Suite for PEZ$ Jev System One Signal Engine.
Validates logic, microstructural mathematics, accuracy, hysteresis,
and multi-timeframe horizon calibration. Stdlib-only (Python 3.9+).
"""

import math
import sys
import time
import unittest
from pathlib import Path

# Ensure jev_validation package is in sys.path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR.parent) not in sys.path:
    sys.path.insert(0, str(BASE_DIR.parent))

from jev_validation.jev_model import (
    JevSignalEngine,
    calculate_dynamic_ofi,
    calculate_micro_price,
    check_spoof_trap,
    check_spread_feasibility,
    compute_macro_extension,
    compute_volume_profile,
    normalize_perp_price,
    parse_extended_book_metrics,
)


class TestOrderbookMicrostructureMath(unittest.TestCase):
    """Category A: Orderbook parsing, level decay, micro-price, and OFI."""

    def test_parse_extended_book_metrics(self):
        book = {
            "levels": [
                # Bids: Level 0 (100k), Level 1 (60k)
                [
                    {"px": "50000.0", "sz": "2.0"},
                    {"px": "49990.0", "sz": "1.2"},
                ],
                # Asks: Level 0 (50k), Level 1 (150k)
                [
                    {"px": "50010.0", "sz": "1.0"},
                    {"px": "50020.0", "sz": "3.0"},
                ],
            ]
        }
        (
            best_bid,
            best_ask,
            bid_depth,
            ask_depth,
            touch_bid,
            touch_ask,
            deep_bid,
            deep_ask,
            weighted_bid,
            weighted_ask,
            touch_bid_sz,
            touch_ask_sz,
        ) = parse_extended_book_metrics(book)

        self.assertEqual(best_bid, 50000.0)
        self.assertEqual(best_ask, 50010.0)
        self.assertEqual(touch_bid_sz, 2.0)
        self.assertEqual(touch_ask_sz, 1.0)
        self.assertEqual(touch_bid, 100000.0)
        self.assertEqual(touch_ask, 50010.0)
        self.assertAlmostEqual(deep_bid, 49990.0 * 1.2, places=4)
        self.assertAlmostEqual(deep_ask, 50020.0 * 3.0, places=4)

        # Decay weights: w0 = 1.0, w1 = 0.5
        expected_weighted_bid = 100000.0 * 1.0 + (49990.0 * 1.2) * 0.5
        expected_weighted_ask = 50010.0 * 1.0 + (50020.0 * 3.0) * 0.5
        self.assertAlmostEqual(weighted_bid, expected_weighted_bid, places=4)
        self.assertAlmostEqual(weighted_ask, expected_weighted_ask, places=4)
        self.assertAlmostEqual(bid_depth, touch_bid + deep_bid, places=4)
        self.assertAlmostEqual(ask_depth, touch_ask + deep_ask, places=4)

    def test_micro_price_calculation(self):
        # 1. Balanced touch -> micro-price equals mid-price
        mid = 50005.0
        mp, drift = calculate_micro_price(50000.0, 50010.0, 100000.0, 100000.0, mid)
        self.assertAlmostEqual(mp, mid, places=4)
        self.assertAlmostEqual(drift, 0.0, places=4)

        # 2. Buyers pressing touch: 150k bid vs 50k ask
        # MicroPrice = (150k * 50010 + 50k * 50000) / 200k = 50007.5
        mp_bull, drift_bull = calculate_micro_price(50000.0, 50010.0, 150000.0, 50000.0, mid)
        self.assertAlmostEqual(mp_bull, 50007.5, places=4)
        self.assertGreater(mp_bull, mid)
        self.assertGreater(drift_bull, 0.0)

        # 3. Sellers pressing touch: 50k bid vs 150k ask -> MicroPrice = 50002.5
        mp_bear, drift_bear = calculate_micro_price(50000.0, 50010.0, 50000.0, 150000.0, mid)
        self.assertAlmostEqual(mp_bear, 50002.5, places=4)
        self.assertLess(mp_bear, mid)
        self.assertLess(drift_bear, 0.0)

    def test_dynamic_ofi_computation(self):
        # Snapshot 1: baseline
        snap1 = {"best_bid": 50000.0, "best_ask": 50010.0, "bid_sz": 2.0, "ask_sz": 2.0, "ts": 100.0}
        # Snapshot 2: buyers step up to higher price (50002.0) with larger size (4.0)
        snap2 = {"best_bid": 50002.0, "best_ask": 50010.0, "bid_sz": 4.0, "ask_sz": 2.0, "ts": 102.0}

        # Delta_bid = 4.0 (higher price). Delta_ask = 0.0. Raw OFI = +4.0. Norm OFI = 4.0 / (4.0+2.0) = +0.667.
        ofi = calculate_dynamic_ofi(snap1, snap2, weighted_imbalance=0.20)
        self.assertGreater(ofi, 0.40)

        # Snapshot 3: seller aggressively sweeps through bid
        snap3 = {"best_bid": 49998.0, "best_ask": 50008.0, "bid_sz": 1.0, "ask_sz": 5.0, "ts": 104.0}
        # Lower bid price -> Delta_bid = -4.0. Lower ask price -> Delta_ask = 5.0. OFI = -4.0 - 5.0 = -9.0.
        ofi_bear = calculate_dynamic_ofi(snap2, snap3, weighted_imbalance=-0.30)
        self.assertLess(ofi_bear, -0.50)


class TestSchmittTriggerHysteresis(unittest.TestCase):
    """Category B: Dual-threshold Schmitt trigger, micro-noise filtering, and regime breaks."""

    def setUp(self):
        self.engine = JevSignalEngine(sz_decimals=2)
        self.book = {
            "levels": [
                [{"px": "65000.0", "sz": "2.0"}],
                [{"px": "65010.0", "sz": "2.0"}],
            ]
        }

    def test_activation_threshold_gate(self):
        # 1. 0.64 conviction is below 0.65 threshold -> Must remain HOLD
        sig_low = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.64, "toxic_risk": 0.05},
        )
        self.assertEqual(sig_low["action"], "HOLD")
        self.assertIn("insufficient", sig_low["reason"])

        # 2. 0.65 conviction reaches activation threshold -> Must activate BUY
        sig_act = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.65, "toxic_risk": 0.05},
        )
        self.assertEqual(sig_act["action"], "BUY")

    def test_hysteresis_retention_and_floor(self):
        now = time.time()
        # 1. Activate BUY with 0.78 conviction
        sig1 = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.78, "toxic_risk": 0.05},
            now_ts=now,
        )
        self.assertEqual(sig1["action"], "BUY")

        # 2. Conviction dips to 0.58 (below 0.65 activation, above 0.50 retention floor)
        # Hysteresis must retain BUY!
        sig2 = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.58, "toxic_risk": 0.05},
            now_ts=now + 5.0,
        )
        self.assertEqual(sig2["action"], "BUY")
        self.assertIn("hysteresis", sig2["reason"])

        # 3. Conviction dips further to 0.51 (still above 0.50 floor) -> Retained in BUY
        sig3 = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.51, "toxic_risk": 0.05},
            now_ts=now + 10.0,
        )
        self.assertEqual(sig3["action"], "BUY")

        # 4. Conviction fades below floor to 0.44 -> Must step down cleanly to HOLD
        sig4 = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.44, "toxic_risk": 0.05},
            now_ts=now + 15.0,
        )
        self.assertEqual(sig4["action"], "HOLD")
        self.assertIn("faded below retention floor", sig4["reason"])

    def test_instant_regime_reversal(self):
        now = time.time()
        # 1. Active BUY
        self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.75, "toxic_risk": 0.05},
            now_ts=now,
        )

        # 2. Sudden market shift: sellers take control with 0.82 conviction
        # Must reverse instantly (0ms lag) to SELL
        sig_rev = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bearish", "confidence": 0.82, "toxic_risk": 0.05},
            now_ts=now + 1.0,
        )
        self.assertEqual(sig_rev["action"], "SELL")
        self.assertIn("Regime reversal", sig_rev["reason"])

    def test_neutral_consolidation_transition(self):
        now = time.time()
        # 1. Active BUY
        self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.75, "toxic_risk": 0.05},
            now_ts=now,
        )

        # 2. Market goes neutral with high neutral confidence (0.85) and flat OFI
        # Must step down to HOLD, NOT mistake neutral confidence for trend conviction!
        flat_book = {
            "levels": [
                [{"px": "65000.0", "sz": "1.0"}],
                [{"px": "65002.0", "sz": "1.0"}],
            ]
        }
        sig_neutral = self.engine.generate_signal(
            coin="BTC",
            raw_book=flat_book,
            jev_decision={
                "direction": "neutral",
                "confidence": 0.85,
                "probabilities": {"bullish": 0.10, "neutral": 0.85, "bearish": 0.05},
                "toxic_risk": 0.05,
            },
            now_ts=now + 2.0,
        )
        self.assertEqual(sig_neutral["action"], "HOLD")
        self.assertIn("neutral", sig_neutral["reason"])

    def test_memory_window_expiration(self):
        now = time.time()
        # 1. Active BUY
        self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.75, "toxic_risk": 0.05},
            now_ts=now,
        )

        # 2. 185 seconds later (past 180s / 3 min memory window) with 0.58 conviction:
        # Prior state has expired; 0.58 is below activation threshold (0.65) -> Must return HOLD
        sig_expired = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.58, "toxic_risk": 0.05},
            now_ts=now + 185.0,
        )
        self.assertEqual(sig_expired["action"], "HOLD")
        self.assertIn("insufficient", sig_expired["reason"])


class TestTripwiresAndDefenseGates(unittest.TestCase):
    """Category C: Instant toxic sweep tripwires, spoof traps, and spread feasibility."""

    def setUp(self):
        self.engine = JevSignalEngine(sz_decimals=2)

    def test_instant_toxic_tripwire_across_timeframes(self):
        book = {
            "levels": [
                [{"px": "50000.0", "sz": "2.0"}],
                [{"px": "50005.0", "sz": "2.0"}],
            ]
        }
        # 1. SCALP: toxic threshold 0.35 -> toxic_risk 0.38 must tripwire to HOLD
        sig_scalp = self.engine.generate_signal(
            coin="BTC",
            raw_book=book,
            jev_decision={"direction": "bullish", "confidence": 0.90, "toxic_risk": 0.38},
            timeframe="scalp",
        )
        self.assertEqual(sig_scalp["action"], "HOLD")
        self.assertIn("tripwire", sig_scalp["reason"])

        # 2. INTRADAY: toxic threshold 0.45 -> toxic_risk 0.48 must tripwire to HOLD
        self.engine.reset()
        sig_intra = self.engine.generate_signal(
            coin="BTC",
            raw_book=book,
            jev_decision={"direction": "bullish", "confidence": 0.90, "toxic_risk": 0.48},
            timeframe="intraday",
        )
        self.assertEqual(sig_intra["action"], "HOLD")
        self.assertIn("tripwire", sig_intra["reason"])

        # 3. SWING: toxic threshold 0.55 -> toxic_risk 0.58 must tripwire to HOLD
        self.engine.reset()
        sig_swing = self.engine.generate_signal(
            coin="BTC",
            raw_book=book,
            jev_decision={"direction": "bullish", "confidence": 0.90, "toxic_risk": 0.58},
            timeframe="swing",
        )
        self.assertEqual(sig_swing["action"], "HOLD")
        self.assertIn("tripwire", sig_swing["reason"])

    def test_toxic_cooldown_window(self):
        book = {
            "levels": [
                [{"px": "50000.0", "sz": "2.0"}],
                [{"px": "50005.0", "sz": "2.0"}],
            ]
        }
        now = time.time()
        # 1. Tripwire fires at t=0
        self.engine.generate_signal(
            coin="BTC",
            raw_book=book,
            jev_decision={"direction": "bullish", "confidence": 0.90, "toxic_risk": 0.70},
            now_ts=now,
        )

        # 2. At t=5 (inside 15s cooldown), toxic_risk relaxes slightly to 0.40 (> 0.45*0.8 = 0.36)
        # Must remain in HOLD during cooldown!
        sig_cool = self.engine.generate_signal(
            coin="BTC",
            raw_book=book,
            jev_decision={"direction": "bullish", "confidence": 0.90, "toxic_risk": 0.40},
            now_ts=now + 5.0,
        )
        self.assertEqual(sig_cool["action"], "HOLD")
        self.assertIn("stabilizing", sig_cool["reason"])

    def test_spoof_trap_defense(self):
        # Spoofer places 100k at touch bid ($50k vs $10k ask),
        # but huge 250k ask overhang right behind touch ($50,020)
        spoof_book = {
            "levels": [
                [
                    {"px": "50000.0", "sz": "2.0"},  # touch: 100k
                    {"px": "49990.0", "sz": "0.1"},  # deep: 5k
                ],
                [
                    {"px": "50005.0", "sz": "0.2"},  # touch: 10k
                    {"px": "50020.0", "sz": "5.0"},  # deep: 250k
                ],
            ]
        }
        # Even if Jev model returned bullish 0.85, the engine's zero-lag spoof defense must gate to HOLD!
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=spoof_book,
            jev_decision={"direction": "bullish", "confidence": 0.85, "toxic_risk": 0.05},
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertIn("Spoof trap defense", sig["reason"])

    def test_crossed_book_defense(self):
        crossed_book = {
            "levels": [
                [{"px": "50015.0", "sz": "2.0"}],  # Bid is 50015
                [{"px": "50010.0", "sz": "2.0"}],  # Ask is 50010 (crossed!)
            ]
        }
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=crossed_book,
            jev_decision={"direction": "bullish", "confidence": 0.90, "toxic_risk": 0.05},
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertIn("crossed", sig["reason"])

    def test_spread_feasibility_defense(self):
        # 50000 bid vs 50150 ask = 150 USD spread on 50k = 30 bps spread
        wide_book = {
            "levels": [
                [{"px": "50000.0", "sz": "1.0"}],
                [{"px": "50150.0", "sz": "1.0"}],
            ]
        }
        # Scalp max spread is 8.0 bps -> 30 bps must gate to HOLD
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=wide_book,
            jev_decision={"direction": "bullish", "confidence": 0.85, "toxic_risk": 0.05},
            timeframe="scalp",
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertIn("Spread too wide", sig["reason"])


class TestMultiTimeframeCalibrationAndPricing(unittest.TestCase):
    """Category D: Holding horizon targets, brackets, and price quantization."""

    def setUp(self):
        self.engine = JevSignalEngine(sz_decimals=2)
        self.book = {
            "levels": [
                [{"px": "60000.0", "sz": "2.0"}],
                [{"px": "60004.0", "sz": "2.0"}],
            ]
        }

    def test_scalp_horizon_calibration(self):
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.85, "toxic_risk": 0.05},
            timeframe="scalp",
        )
        self.assertEqual(sig["action"], "BUY")
        self.assertIn("Scalp", sig["estimated_duration"])
        # Scalp entry should touch BestBid for priority
        self.assertEqual(sig["entry_price"], 60000.0)
        self.assertEqual(sig["take_profit_pct"], 0.50)
        self.assertEqual(sig["stop_loss_pct"], 0.25)
        self.assertEqual(sig["risk_reward_ratio"], 2.0)
        self.assertGreater(sig["take_profit_price"], sig["entry_price"])
        self.assertLess(sig["stop_loss_price"], sig["entry_price"])

    def test_swing_horizon_calibration(self):
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.80, "toxic_risk": 0.05},
            timeframe="swing",
        )
        self.assertEqual(sig["action"], "BUY")
        self.assertIn("Swing", sig["estimated_duration"])
        # Swing entry should be structural pullback (-0.25% of mid 60002.0)
        expected_pullback = normalize_perp_price(60002.0 * 0.9975, sz_decimals=2)
        self.assertEqual(sig["entry_price"], expected_pullback)
        self.assertEqual(sig["take_profit_pct"], 4.20)
        self.assertEqual(sig["stop_loss_pct"], 2.00)
        self.assertEqual(sig["risk_reward_ratio"], 2.1)

    def test_price_normalization_rules(self):
        # 1. Hyperliquid 5 significant figures: 75756.5 -> 75757
        p1 = normalize_perp_price(75756.5, sz_decimals=5)
        self.assertEqual(p1, 75757.0)

        # 2. Integer price exception: 123456 remains 123456
        p2 = normalize_perp_price(123456.0, sz_decimals=2)
        self.assertEqual(p2, 123456.0)

        # 3. Fractional price precision: 95.25 with 3 decimals remains 95.25
        p3 = normalize_perp_price(95.25, sz_decimals=3)
        self.assertEqual(p3, 95.25)

        # 4. Zero and negative safety
        self.assertEqual(normalize_perp_price(0.0), 0.0)
        self.assertEqual(normalize_perp_price(-5.0), -5.0)

    def test_dynamic_atr_brackets_calibration(self):
        """Validates that ATR dynamic brackets scale proportionally to volatility."""
        # Intraday with 1.50% ATR: SL should be 1.50% * 1.20 = 1.80%, TP should be 3.60%
        sig_atr = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.75, "toxic_risk": 0.05},
            timeframe="intraday",
            atr_pct=1.50,
        )
        self.assertEqual(sig_atr["action"], "BUY")
        self.assertEqual(sig_atr["stop_loss_pct"], 1.80)
        self.assertEqual(sig_atr["take_profit_pct"], 3.60)
        self.assertEqual(sig_atr["risk_reward_ratio"], 2.0)
        self.assertEqual(sig_atr["atr_pct"], 1.50)

        # Scalp with 0.50% ATR: SL should be 0.50% * 0.60 = 0.30%, TP should be 0.60%
        sig_scalp_atr = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.75, "toxic_risk": 0.05},
            timeframe="scalp",
            atr_pct=0.50,
        )
        self.assertEqual(sig_scalp_atr["stop_loss_pct"], 0.30)
        self.assertEqual(sig_scalp_atr["take_profit_pct"], 0.60)

    def test_macro_trend_filter_gate(self):
        """Validates Gate 6: Macro trend confluence filter prevents counter-trend traps."""
        # 1. Counter-trend BUY during severe 24h dump (-5.0%) with sub-78% conviction must be suppressed to HOLD
        sig_dump = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.70, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=-5.0,
        )
        self.assertEqual(sig_dump["action"], "HOLD")
        self.assertIn("Macro trend filter", sig_dump["reason"])
        self.assertIn("counter-trend BUY suppressed", sig_dump["reason"])

        # 2. Institutional conviction (>= 78%) allows oversold bounce entry
        sig_bounce = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.82, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=-5.0,
        )
        self.assertEqual(sig_bounce["action"], "BUY")

        # 3. Counter-trend SELL during strong 24h bull rally (+4.5%) with sub-78% conviction must be suppressed to HOLD
        sig_rally = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bearish", "confidence": 0.72, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=4.5,
        )
        self.assertEqual(sig_rally["action"], "HOLD")
        self.assertIn("counter-trend SELL suppressed", sig_rally["reason"])


class TestMacroStructureAndVolumeProfileGates(unittest.TestCase):
    """Category E: Gate 7 Macro Resistance, Yearly Volume Profile, and Range Extension."""

    def setUp(self):
        self.engine = JevSignalEngine(sz_decimals=2)
        # Synthetic 180-bar daily history for BTC
        self.candles = []
        for i in range(180):
            p = 60000.0 + (i * 120.0) + (800.0 if i % 2 == 0 else -600.0)
            self.candles.append({
                "t": i,
                "o": p,
                "h": p + 1500.0,
                "l": p - 1000.0,
                "c": p + 400.0,
                "v": 2500000.0,
            })
        self.book = {
            "levels": [
                [{"px": "85800.0", "sz": "3.5"}, {"px": "85790.0", "sz": "5.0"}],
                [{"px": "85810.0", "sz": "1.0"}, {"px": "85820.0", "sz": "1.2"}],
            ]
        }

    def test_compute_volume_profile(self):
        vp = compute_volume_profile(self.candles, bins=70, value_area_pct=0.70)
        self.assertGreater(vp["vah"], vp["val"])
        self.assertGreaterEqual(vp["poc"], vp["val"])
        self.assertLessEqual(vp["poc"], vp["vah"])
        self.assertGreater(vp["total_volume"], 0.0)

    def test_compute_macro_extension(self):
        ext = compute_macro_extension(self.candles, 85804.5)
        self.assertGreater(ext["twap_365d"], 0.0)
        self.assertGreater(ext["dist_from_365d_pct"], 0.0)
        self.assertGreater(ext["avg_impulse_pct"], 0.0)

    def test_gate7_resistance_rejection(self):
        # Setup Volume Profile where VAH is $85,850 and price is $85,804.5 (testing resistance)
        vp = {"vah": 85850.0, "val": 68000.0, "poc": 76000.0}
        ext = {"twap_365d": 80552.0, "dist_from_365d_pct": 6.52, "is_resistance_exhausted": True}

        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.72, "toxic_risk": 0.05},
            timeframe="intraday",
            volume_profile=vp,
            macro_extension=ext,
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertIn("Gate 7", sig["reason"])
        self.assertIn("Long suppressed at Monthly Volume Profile resistance", sig["reason"])
        # Invariant: HOLD must zero out execution target prices
        self.assertEqual(sig["entry_price"], 0.0)
        self.assertEqual(sig["take_profit_price"], 0.0)
        self.assertEqual(sig["stop_loss_price"], 0.0)

    def test_gate7_support_rejection(self):
        # Setup Volume Profile where VAL is $68,000 and price is $68,100 (testing support)
        vp = {"vah": 85850.0, "val": 68000.0, "poc": 76000.0}
        ext = {"twap_365d": 80552.0, "dist_from_365d_pct": -15.5, "is_support_exhausted": True}
        sell_book = {
            "levels": [
                [{"px": "68090.0", "sz": "1.0"}, {"px": "68080.0", "sz": "1.2"}],
                [{"px": "68100.0", "sz": "4.5"}, {"px": "68110.0", "sz": "6.0"}],
            ]
        }

        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=sell_book,
            jev_decision={"direction": "bearish", "confidence": 0.72, "toxic_risk": 0.05},
            timeframe="intraday",
            volume_profile=vp,
            macro_extension=ext,
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertIn("Gate 7", sig["reason"])
        self.assertIn("Short suppressed at Monthly Volume Profile support", sig["reason"])
        self.assertEqual(sig["entry_price"], 0.0)
        self.assertEqual(sig["take_profit_price"], 0.0)
        self.assertEqual(sig["stop_loss_price"], 0.0)

    def test_gate7_quarterly_swing_resistance_rejection(self):
        # In swing timeframe, Gate 7 checks Quarterly Volume Profile resistance and 90D TWAP
        vp = {"vah": 85850.0, "val": 68000.0, "poc": 76000.0, "horizon_type": "quarterly"}
        ext = {"twap": 80552.0, "dist_from_twap_pct": 6.52, "horizon_type": "quarterly", "is_resistance_exhausted": True}

        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.72, "toxic_risk": 0.05},
            timeframe="swing",
            volume_profile=vp,
            macro_extension=ext,
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertIn("Gate 7", sig["reason"])
        self.assertIn("Long suppressed at Quarterly Volume Profile resistance", sig["reason"])
        self.assertIn("90D TWAP", sig["reason"])
        self.assertEqual(sig["profile_horizon"], "quarterly")

    def test_gate7_institutional_breakout_allowed(self):
        # When conviction is >= 82%, high-volume breakout through VAH is permitted
        vp = {"vah": 85850.0, "val": 68000.0, "poc": 76000.0}
        ext = {"twap_365d": 80552.0, "dist_from_365d_pct": 6.52, "is_resistance_exhausted": True}

        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book,
            jev_decision={"direction": "bullish", "confidence": 0.85, "toxic_risk": 0.05},
            timeframe="intraday",
            volume_profile=vp,
            macro_extension=ext,
        )
        self.assertEqual(sig["action"], "BUY")
        self.assertGreater(sig["entry_price"], 0.0)
        self.assertGreater(sig["take_profit_price"], sig["entry_price"])


class TestRangeAndTrendSignalExpansion(unittest.TestCase):
    """Category F: Range vs Trend Environment & Counter-Trend Signal Logic."""

    def setUp(self):
        self.engine = JevSignalEngine(sz_decimals=2)
        self.range_vp = {"vah": 68000.0, "val": 62000.0, "poc": 65000.0}
        self.book_range_high = {
            "levels": [
                [{"px": "67790.0", "sz": "1.0"}, {"px": "67780.0", "sz": "1.5"}],
                [{"px": "67810.0", "sz": "5.0"}, {"px": "67820.0", "sz": "3.0"}],
            ]
        }
        self.book_range_low = {
            "levels": [
                [{"px": "62190.0", "sz": "5.0"}, {"px": "62180.0", "sz": "3.0"}],
                [{"px": "62210.0", "sz": "1.0"}, {"px": "62220.0", "sz": "1.5"}],
            ]
        }

    def test_range_high_counter_trend_short(self):
        """At range high in a range environment, bullish orderflow produces a counter-trend short."""
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book_range_high,
            jev_decision={"direction": "bullish", "confidence": 0.74, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=0.5,
            volume_profile=self.range_vp,
        )
        self.assertEqual(sig["action"], "SELL")
        self.assertEqual(sig["signal_type"], "counter_trend")
        self.assertEqual(sig["market_environment"], "range")
        self.assertIn("Counter-trend range-high short", sig["reason"])
        self.assertGreater(sig["entry_price"], 0.0)
        self.assertGreater(sig["stop_loss_price"], sig["entry_price"])
        self.assertLess(sig["take_profit_price"], sig["entry_price"])

    def test_range_low_counter_trend_long(self):
        """At range low in a range environment, bearish orderflow produces a counter-trend long."""
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book_range_low,
            jev_decision={"direction": "bearish", "confidence": 0.74, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=-0.5,
            volume_profile=self.range_vp,
        )
        self.assertEqual(sig["action"], "BUY")
        self.assertEqual(sig["signal_type"], "counter_trend")
        self.assertEqual(sig["market_environment"], "range")
        self.assertIn("Counter-trend range-low long", sig["reason"])
        self.assertGreater(sig["entry_price"], 0.0)
        self.assertLess(sig["stop_loss_price"], sig["entry_price"])
        self.assertGreater(sig["take_profit_price"], sig["entry_price"])

    def test_range_high_breakout_trend_long(self):
        """At range high with institutional conviction (>= 82%), breakout trend long is permitted."""
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book_range_high,
            jev_decision={"direction": "bullish", "confidence": 0.88, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=2.2,
            volume_profile=self.range_vp,
        )
        self.assertEqual(sig["action"], "BUY")
        self.assertEqual(sig["signal_type"], "trend")
        self.assertEqual(sig["market_environment"], "trend")
        self.assertIn("Breakout trend long", sig["reason"])

    def test_trend_following_and_institutional_counter_trend(self):
        """In a strong trend environment, signals are tagged as trend following or institutional counter-trend."""
        # 1. Bull trend continuation
        sig_bull = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book_range_high,
            jev_decision={"direction": "bullish", "confidence": 0.75, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=4.0,
        )
        self.assertEqual(sig_bull["action"], "BUY")
        self.assertEqual(sig_bull["signal_type"], "trend")
        self.assertEqual(sig_bull["market_environment"], "trend")

        # 2. Bull trend institutional pullback short
        sig_pullback = self.engine.generate_signal(
            coin="BTC",
            raw_book=self.book_range_high,
            jev_decision={"direction": "bearish", "confidence": 0.80, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=4.0,
        )
        self.assertEqual(sig_pullback["action"], "SELL")
        self.assertEqual(sig_pullback["signal_type"], "counter_trend")
        self.assertEqual(sig_pullback["market_environment"], "trend")

    def test_range_high_unabsorbed_push_holds(self):
        """At range high with aggressive unabsorbed buying (book imbalance > 0.10), premature short is gated to HOLD."""
        aggressive_bid_book = {
            "levels": [
                [{"px": "67790.0", "sz": "5.0"}, {"px": "67780.0", "sz": "3.0"}],
                [{"px": "67810.0", "sz": "1.0"}, {"px": "67820.0", "sz": "1.5"}],
            ]
        }
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=aggressive_bid_book,
            jev_decision={"direction": "bullish", "confidence": 0.74, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=0.5,
            volume_profile=self.range_vp,
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertEqual(sig["signal_type"], "neutral")
        self.assertIn("awaiting order flow absorption/rejection", sig["reason"])

    def test_range_low_unabsorbed_dump_holds(self):
        """At range low with aggressive unabsorbed selling (book imbalance < -0.10), premature catch is gated to HOLD."""
        aggressive_ask_book = {
            "levels": [
                [{"px": "62190.0", "sz": "1.0"}, {"px": "62180.0", "sz": "1.5"}],
                [{"px": "62210.0", "sz": "5.0"}, {"px": "62220.0", "sz": "3.0"}],
            ]
        }
        sig = self.engine.generate_signal(
            coin="BTC",
            raw_book=aggressive_ask_book,
            jev_decision={"direction": "bearish", "confidence": 0.74, "toxic_risk": 0.05},
            timeframe="intraday",
            change_24h=-0.5,
            volume_profile=self.range_vp,
        )
        self.assertEqual(sig["action"], "HOLD")
        self.assertEqual(sig["signal_type"], "neutral")
        self.assertIn("awaiting order flow absorption/bounce", sig["reason"])


if __name__ == "__main__":
    unittest.main()
