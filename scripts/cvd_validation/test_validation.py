"""Deterministic stdlib tests for the anchored-CVD validator."""

import sys
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from hl_client import INTERVAL_MS
from reference import compute_cvd_deltas, cvd_seam
from run_validation import (anchored_divergence, classify_delta, conservation_check,
                            display_holes, exclude_open_bucket, nil_census,
                            source_geometry, stability_differences,
                            write_summary)


BASE = 1_800_000_000


def candle(t, interval="5m", o="1", c="2", v="1", delta=None):
    row = {"t": t, "T": t + INTERVAL_MS[interval] - 1,
           "i": interval, "o": o, "c": c, "v": v}
    if delta is not None:
        row["cvdDelta"] = delta
    return row


class ClassificationTests(unittest.TestCase):
    def test_exact_match(self):
        self.assertEqual(classify_delta(12.0, 12.0, 12.0), "exact")

    def test_upstream_revision(self):
        self.assertEqual(classify_delta(12.0, 10.0, 12.0),
                         "upstream-revision")

    def test_retained_only_source_history(self):
        self.assertEqual(classify_delta(12.0, None, 12.0,
                                        external_covered=False),
                         "retained-only")

    def test_not_ready_is_not_a_false_zero(self):
        self.assertEqual(classify_delta(None, 10.0, 10.0), "not-ready")
        self.assertEqual(classify_delta(0.0, 10.0, 10.0,
                                        store_ready=False), "not-ready")

    def test_enriched_passthrough_can_still_be_proven_exact(self):
        # The handler can merge a passthrough, re-read it enriched, and return
        # the correct value without marking the original transport store-hit.
        self.assertEqual(classify_delta(10.0, 10.0, 10.0,
                                        store_ready=False), "exact")

    def test_genuine_mismatch(self):
        self.assertEqual(classify_delta(9.0, 10.0, 11.0),
                         "genuine-mismatch")


class CoverageTests(unittest.TestCase):
    def test_infers_retained_seam_not_fresh_response_seam(self):
        retained = [candle(BASE + 5 * 60_000)]
        deep = [candle(BASE - 3_600_000, "30m")]
        geometry = source_geometry(retained, deep)
        self.assertEqual(geometry["seam"], cvd_seam(BASE + 5 * 60_000))
        fresh_first = BASE + 4 * 3_600_000
        self.assertNotEqual(geometry["seam"], cvd_seam(fresh_first))

    def test_explicit_seam_prevents_fresh_source_from_moving_partition(self):
        seam = cvd_seam(BASE)
        display = [candle(seam, "30m", v="2")]
        fresh_five = [candle(seam + 5 * 60_000, v="3")]
        values = compute_cvd_deltas(
            display, INTERVAL_MS["30m"], fresh_five, [], seam_ms=seam,
            source_start_ms=seam, source_end_ms=seam + 30 * 60_000)
        self.assertEqual(values, [3.0])

    def test_nil_coverage_bands(self):
        geometry = {"seam": BASE, "source_start": BASE - 3_600_000,
                    "source_end": BASE + 3_600_000}
        series = {"30m": [candle(BASE - 5_400_000, "30m"),
                           candle(BASE - 1_800_000, "30m", delta=1),
                           candle(BASE, "30m", delta=2)]}
        census = nil_census(series, geometry)["30m"]
        self.assertEqual(census["outside-source"], {"total": 1, "nil": 1})
        self.assertEqual(census["deep-30m"], {"total": 1, "nil": 0})
        self.assertEqual(census["recent-5m"], {"total": 1, "nil": 0})

    def test_open_bucket_exclusion(self):
        bars = [candle(BASE), candle(BASE + 300_000)]
        closed = exclude_open_bucket(bars, 300_000, BASE + 599_999)
        self.assertEqual([bar["t"] for bar in closed], [BASE])


class IdentityTests(unittest.TestCase):
    def _source(self):
        bars = []
        for i in range(24):
            bars.append(candle(BASE + i * 300_000, "5m",
                               o="1", c="2" if i % 3 else "0", v=str(i + 1)))
        return bars

    def _enriched(self, times, timeframe, source):
        bars = [candle(t, timeframe, v="10") for t in times]
        geometry = {"seam": BASE, "source_start": BASE,
                    "source_end": BASE + 24 * 300_000}
        values = compute_cvd_deltas(
            bars, INTERVAL_MS[timeframe], source, [],
            seam_ms=geometry["seam"], source_start_ms=geometry["source_start"],
            source_end_ms=geometry["source_end"])
        for bar, value in zip(bars, values):
            bar["cvdDelta"] = value
        return bars

    def test_display_hole_conserves_into_preceding_bucket(self):
        source = self._source()
        low = self._enriched(
            [BASE, BASE + 1_800_000, BASE + 2_700_000], "15m", source)
        high = self._enriched([BASE, BASE + 1_800_000], "30m", source)
        self.assertEqual(display_holes(low, INTERVAL_MS["15m"]), 1)
        checks = conservation_check({"15m": low, "30m": high})
        self.assertEqual(checks[0]["comparable"], 2)
        self.assertEqual(checks[0]["violations"], [])

    def test_cross_timeframe_conservation_violation(self):
        source = self._source()
        low = self._enriched(
            [BASE + i * 900_000 for i in range(8)], "15m", source)
        high = self._enriched(
            [BASE + i * 3_600_000 for i in range(2)], "1h", source)
        checks = conservation_check({"15m": low, "1h": high})
        self.assertEqual(checks[0]["violations"], [])
        high[0]["cvdDelta"] += 1
        checks = conservation_check({"15m": low, "1h": high})
        self.assertEqual(len(checks[0]["violations"]), 1)

    def test_anchored_divergence_ignores_partial_window_head(self):
        source = self._source()
        low = self._enriched(
            [BASE + i * 900_000 for i in range(8)], "15m", source)
        # Mimic a range beginning between high-TF boundaries: the low series
        # has an earlier partial-window bar which must not become divergence.
        high = self._enriched(
            [BASE + 3_600_000], "1h", source)
        result = anchored_divergence({"15m": low, "1h": high})[0]
        self.assertAlmostEqual(result["residual"], 0.0)

    def test_stability_detects_value_change_not_order_change(self):
        left = [candle(BASE, delta=1), candle(BASE + 300_000, delta=2)]
        self.assertEqual(stability_differences(left, list(reversed(left))), 0)
        changed = [dict(bar) for bar in left]
        changed[1]["cvdDelta"] = 3
        self.assertEqual(stability_differences(left, changed), 1)

    def test_report_generation_handles_tied_pair_scores(self):
        pair = {"pair": "5m→1h", "samples": 1, "max_divergence": 0.0,
                "fallback_component": 0.0, "residual": 0.0,
                "normalized": 0.0}
        ticker = {"ticker": "TEST", "store_ready": True,
                  "classifications": {name: 0 for name in
                                      ("exact", "upstream-revision",
                                       "retained-only", "not-ready",
                                       "genuine-mismatch")},
                  "stability_differences": 0, "display_holes": 0,
                  "conservation": [], "divergence": [dict(pair), dict(pair)],
                  "nil_census": {}}
        run = {"generated": "now", "mode": "test", "days": 1,
               "tickers": ["TEST"], "timeframes": ["5m", "1h"],
               "passed": True, "stability_differences": 0,
               "conservation_violations": 0, "display_holes": 0,
               "classifications": ticker["classifications"],
               "results": [ticker]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "summary.md"
            write_summary(path, run)
            self.assertIn("Worst affected pairs", path.read_text())


if __name__ == "__main__":
    unittest.main()
