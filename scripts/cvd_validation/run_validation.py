#!/usr/bin/env python3
"""Anchored-CVD live validation entrypoint.

The validator deliberately compares three independently obtained views:
the delta served to the chart, a recomputation over current Hyperliquid
mainnet candles, and a recomputation over the local server's retained source
candles.  That third view makes normal upstream candle revisions reproducible
without weakening the computation check.
"""

import argparse
import csv
import datetime as dt
import math
import os
from pathlib import Path
import sys
import time

from client_sim import calculate, monday_utc
from hl_client import INTERVAL_MS, LocalClient, MainnetClient, WeightBudget
from reference import (DEEP_MS, RECENT_MS, bucket_end_ms,
                       compute_cvd_deltas, cvd_seam)
from universe import fetch_universe, pick_tiers


DAY_MS = 86_400_000
DEFAULT_TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h"]
DEEP_TIMEFRAMES = DEFAULT_TIMEFRAMES + ["1d"]
CLASSIFICATIONS = ("exact", "upstream-revision", "retained-only",
                   "not-ready", "genuine-mismatch")
ABS_TOL = 1e-9


def same_number(left, right):
    if left is None or right is None:
        return left is None and right is None
    return math.isclose(float(left), float(right), rel_tol=1e-12,
                        abs_tol=ABS_TOL)


def bar_end(bar, interval_ms):
    return int(bar.get("T") or (int(bar["t"]) + interval_ms))


def exclude_open_bucket(bars, interval_ms, now_ms):
    """Return sorted, de-duplicated bars whose nominal bucket has closed."""
    by_time = {int(bar["t"]): bar for bar in bars
               if int(bar.get("t") or 0) > 0}
    return [by_time[t] for t in sorted(by_time)
            if t + interval_ms <= now_ms]


def source_geometry(five_m, thirty_m):
    """Infer the server's actual retained seam and composite bounds."""
    if not five_m:
        return None
    first_recent = int(five_m[0]["t"])
    seam = cvd_seam(first_recent)
    source_start = int(thirty_m[0]["t"]) if thirty_m else seam
    source_end = int(five_m[-1]["t"]) + RECENT_MS
    return {"seam": seam, "source_start": source_start,
            "source_end": source_end}


def reference_values(display, interval_ms, five_m, thirty_m, geometry):
    if not geometry:
        return [None] * len(display)
    return compute_cvd_deltas(
        display, interval_ms, five_m, thirty_m,
        seam_ms=geometry["seam"],
        source_start_ms=geometry["source_start"],
        source_end_ms=geometry["source_end"])


def _leg_covers(bars, step_ms, start_ms, end_ms):
    if start_ms >= end_ms:
        return True
    if not bars:
        return False
    return (int(bars[0]["t"]) <= start_ms and
            int(bars[-1]["t"]) + step_ms >= end_ms)


def source_covers_bucket(open_ms, end_ms, interval_ms, five_m, thirty_m,
                         seam_ms):
    """Whether source bounds externally vouch for the whole display bucket."""
    if open_ms < seam_ms and interval_ms < DEEP_MS:
        return True  # structural nil honesty gate, not missing ground truth
    deep_end = min(end_ms, seam_ms)
    recent_start = max(open_ms, seam_ms)
    return (_leg_covers(thirty_m, DEEP_MS, open_ms, deep_end) and
            _leg_covers(five_m, RECENT_MS, recent_start, end_ms))


def classify_delta(served, current_reference, retained_reference,
                   external_covered=True, retained_ready=True,
                   store_ready=True):
    """Classify one served bucket under the revision-tolerant contract."""
    if served is None:
        if not store_ready or not retained_ready:
            return "not-ready"
        if retained_reference is None:
            return "exact"
        return "not-ready"
    if (external_covered and current_reference is not None and
            same_number(served, current_reference)):
        return "exact"
    if retained_reference is not None and same_number(served,
                                                       retained_reference):
        if not external_covered or current_reference is None:
            return "retained-only"
        return "upstream-revision"
    if not store_ready or not retained_ready:
        return "not-ready"
    return "genuine-mismatch"


def enrich_bars(bars, values):
    out = []
    for bar, value in zip(bars, values):
        row = dict(bar)
        if value is None:
            row.pop("cvdDelta", None)
        else:
            row["cvdDelta"] = value
        out.append(row)
    return out


def stability_differences(first, second):
    """Count fixed-window delta changes; response order does not matter."""
    left = {int(c["t"]): c.get("cvdDelta") for c in first}
    right = {int(c["t"]): c.get("cvdDelta") for c in second}
    keys = set(left) | set(right)
    return sum(1 for key in keys
               if key not in left or key not in right or
               not same_number(left[key], right[key]))


def display_holes(bars, interval_ms):
    return sum(1 for i in range(len(bars) - 1)
               if int(bars[i + 1]["t"]) != int(bars[i]["t"]) + interval_ms)


def conservation_check(series_by_tf):
    """Check every divisible lower→higher pair on strictly comparable bars."""
    results = []
    ordered = sorted(series_by_tf, key=lambda tf: INTERVAL_MS[tf])
    for lo_pos, low_tf in enumerate(ordered):
        low_ms = INTERVAL_MS[low_tf]
        low = series_by_tf[low_tf]
        for high_tf in ordered[lo_pos + 1:]:
            high_ms = INTERVAL_MS[high_tf]
            if high_ms % low_ms:
                continue
            comparable = 0
            violations = []
            low_by_t = {int(c["t"]): (i, c) for i, c in enumerate(low)}
            for high_i, high_bar in enumerate(series_by_tf[high_tf]):
                start = int(high_bar["t"])
                end = bucket_end_ms(series_by_tf[high_tf], high_i, high_ms)
                if end != start + high_ms or high_bar.get("cvdDelta") is None:
                    continue
                first = low_by_t.get(start)
                if first is None:
                    continue
                i = first[0]
                covering = []
                while i < len(low) and int(low[i]["t"]) < end:
                    covering.append((i, low[i]))
                    i += 1
                if not covering:
                    continue
                last_i, _ = covering[-1]
                if bucket_end_ms(low, last_i, low_ms) != end:
                    continue
                if any(bar.get("cvdDelta") is None for _, bar in covering):
                    continue
                expected = sum(float(bar["cvdDelta"])
                               for _, bar in covering)
                actual = float(high_bar["cvdDelta"])
                comparable += 1
                if not same_number(actual, expected):
                    violations.append({"t": start, "actual": actual,
                                       "expected": expected})
            results.append({"pair": "%s→%s" % (low_tf, high_tf),
                            "comparable": comparable,
                            "violations": violations})
    return results


def _cumulative_at_close(bars, use_fallback):
    rows = calculate(bars, use_fallback=use_fallback)
    return {bucket_end_ms(bars, i, INTERVAL_MS.get(
                str(bar.get("i") or ""),
                (bucket_end_ms(bars, i, 1) - int(bar["t"])))) // 1000:
            rows[i]["cum"] for i, bar in enumerate(bars)}


def _mean_weekly_abs(bars):
    if not bars:
        return 0.0
    weekly = {}
    for bar in bars:
        t_s = int(bar["t"]) // 1000
        week = (t_s - 4 * 86_400) // (7 * 86_400)
        value = bar.get("cvdDelta")
        if value is None:
            from client_sim import directional_delta_for_bar
            value = directional_delta_for_bar(bar)
        weekly[week] = weekly.get(week, 0.0) + abs(float(value))
    return sum(weekly.values()) / len(weekly) if weekly else 0.0


def anchored_divergence(series_by_tf):
    results = []
    ordered = sorted(series_by_tf, key=lambda tf: INTERVAL_MS[tf])
    for lo_pos, low_tf in enumerate(ordered):
        low_ms = INTERVAL_MS[low_tf]
        for high_tf in ordered[lo_pos + 1:]:
            if INTERVAL_MS[high_tf] % low_ms:
                continue
            low, high = series_by_tf[low_tf], series_by_tf[high_tf]
            normal_low = _cumulative_at_close(low, True)
            normal_high = _cumulative_at_close(high, True)
            source_low = _cumulative_at_close(low, False)
            source_high = _cumulative_at_close(high, False)
            closes = sorted(set(normal_low) & set(normal_high))
            # A requested window usually begins mid-week and the first low-TF
            # candle precedes the first aligned high-TF candle.  Normalize
            # that partial week's unavoidable head offset; subsequent Monday
            # anchors reset both series naturally and need no adjustment.
            first_week = None
            normal_head = source_head = 0.0
            if closes:
                first_week = monday_utc(closes[0] - 1)
                normal_head = normal_low[closes[0]] - normal_high[closes[0]]
                source_head = source_low[closes[0]] - source_high[closes[0]]

            def difference(left, right, close, head):
                value = left[close] - right[close]
                if monday_utc(close - 1) == first_week:
                    value -= head
                return abs(value)

            full = max((difference(normal_low, normal_high, t, normal_head)
                        for t in closes), default=0.0)
            residual = max((difference(source_low, source_high, t, source_head)
                            for t in closes), default=0.0)
            scale = _mean_weekly_abs(low)
            results.append({
                "pair": "%s→%s" % (low_tf, high_tf),
                "samples": len(closes), "max_divergence": full,
                "fallback_component": max(0.0, full - residual),
                "residual": residual,
                "normalized": full / scale if scale else 0.0,
            })
    return results


def nil_band(open_ms, geometry):
    if not geometry:
        return "unknown"
    if open_ms >= geometry["seam"]:
        return "recent-5m"
    if open_ms >= geometry["source_start"]:
        return "deep-30m"
    return "outside-source"


def nil_census(series_by_tf, geometry):
    census = {}
    for timeframe, bars in series_by_tf.items():
        bands = {}
        for bar in bars:
            band = nil_band(int(bar["t"]), geometry)
            row = bands.setdefault(band, {"total": 0, "nil": 0})
            row["total"] += 1
            row["nil"] += bar.get("cvdDelta") is None
        census[timeframe] = bands
    return census


def _utc(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()


def _format_value(value):
    return "" if value is None else format(float(value), ".17g")


def write_ticker_csv(path, rows):
    fields = ["ticker", "timeframe", "open_ms", "open_utc", "served",
              "mainnet_reference", "retained_reference", "classification",
              "nil_band", "store_ready", "external_covered"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def write_summary(path, run):
    counts = run["classifications"]
    lines = ["# Anchored-CVD validation", "",
             "Generated: `%s`" % run["generated"], "",
             "Mode: `%s`; window: `%sd`; tickers: `%s`; timeframes: `%s`." %
             (run["mode"], run["days"], ", ".join(run["tickers"]),
              ", ".join(run["timeframes"])), "",
             "## Outcome", "",
             "- Exit contract: **%s**" % ("PASS" if run["passed"] else "FAIL"),
             "- Stability differences: **%d**" % run["stability_differences"],
             "- Conservation violations: **%d**" % run["conservation_violations"],
             "- Display holes (reported, not failed): **%d**" % run["display_holes"],
             ""]
    for name in CLASSIFICATIONS:
        lines.append("- `%s`: **%d**" % (name, counts.get(name, 0)))
    lines += ["", "Only `genuine-mismatch`, fixed-window stability changes, and "
              "cross-timeframe conservation violations fail a run. Proven "
              "upstream revisions and retained-only source regions are warnings.",
              "", "## Per ticker", ""]
    for ticker in run["results"]:
        lines += ["### %s" % ticker["ticker"], "",
                  "Seam: `%s`; source coverage: `%s` → `%s`; store: `%s`." %
                  (ticker.get("seam_utc", "unknown"),
                   ticker.get("source_start_utc", "unknown"),
                   ticker.get("source_end_utc", "unknown"),
                   "ready" if ticker["store_ready"] else "not-ready"), "",
                  "Classifications: %s." % ", ".join(
                      "%s=%d" % (k, ticker["classifications"].get(k, 0))
                      for k in CLASSIFICATIONS), "",
                  "Stability differences: `%d`; display holes: `%d`." %
                  (ticker["stability_differences"], ticker["display_holes"]), ""]
        if ticker.get("error"):
            lines += ["Error: `%s`" % ticker["error"], ""]
        if ticker["conservation"]:
            lines += ["| Conservation pair | Comparable | Violations |",
                      "|---|---:|---:|"]
            for item in ticker["conservation"]:
                lines.append("| %s | %d | %d |" %
                             (item["pair"], item["comparable"],
                              len(item["violations"])))
            lines.append("")
        if ticker["divergence"]:
            lines += ["| Anchored pair | Samples | Max | Fallback | Residual | Normalized |",
                      "|---|---:|---:|---:|---:|---:|"]
            for item in sorted(ticker["divergence"],
                               key=lambda x: x["normalized"], reverse=True):
                lines.append("| %s | %d | %.9g | %.9g | %.9g | %.6g |" %
                             (item["pair"], item["samples"],
                              item["max_divergence"],
                              item["fallback_component"], item["residual"],
                              item["normalized"]))
            lines.append("")
        lines += ["Nil coverage:", ""]
        for timeframe, bands in ticker["nil_census"].items():
            rendered = []
            for band, values in bands.items():
                pct = 100 * values["nil"] / values["total"] if values["total"] else 0
                rendered.append("%s %d/%d (%.1f%%)" %
                                (band, values["nil"], values["total"], pct))
            lines.append("- `%s`: %s" % (timeframe, "; ".join(rendered)))
        lines.append("")
    worst = []
    for ticker in run["results"]:
        for item in ticker["divergence"]:
            worst.append((item["normalized"], ticker["ticker"], item))
    lines += ["## Worst affected pairs", "",
              "| Ticker | Pair | Normalized | Fallback | Residual |",
              "|---|---|---:|---:|---:|"]
    for _, ticker, item in sorted(
            worst, key=lambda row: (row[0], row[1], row[2]["pair"]),
            reverse=True)[:20]:
        lines.append("| %s | %s | %.6g | %.9g | %.9g |" %
                     (ticker, item["pair"], item["normalized"],
                      item["fallback_component"], item["residual"]))
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def validate_ticker(ticker, timeframes, start_ms, end_ms, now_ms,
                    mainnet, local=None, source_probe_days=200):
    main_five_start = max(start_ms, end_ms - 20 * DAY_MS)
    main_five = exclude_open_bucket(
        mainnet.candles(ticker, "5m", main_five_start, end_ms), RECENT_MS,
        now_ms)
    main_thirty = exclude_open_bucket(
        mainnet.candles(ticker, "30m", start_ms, end_ms), DEEP_MS, now_ms)

    store_ready = local is None
    retained_ready = local is None
    if local is None:
        retained_five, retained_thirty = main_five, main_thirty
        geometry = source_geometry(main_five, main_thirty)
    else:
        probe_start = end_ms - source_probe_days * DAY_MS
        retained_five, five_ready = local.candles(
            ticker, "5m", probe_start, end_ms)
        retained_thirty, thirty_ready = local.candles(
            ticker, "30m", probe_start, end_ms)
        retained_five = exclude_open_bucket(retained_five, RECENT_MS, now_ms)
        retained_thirty = exclude_open_bucket(retained_thirty, DEEP_MS, now_ms)
        geometry = source_geometry(retained_five, retained_thirty)
        retained_ready = five_ready and bool(retained_five)
        if geometry and start_ms < geometry["seam"]:
            retained_ready = retained_ready and thirty_ready and bool(retained_thirty)
        store_ready = retained_ready

    series = {}
    rows = []
    classifications = {name: 0 for name in CLASSIFICATIONS}
    stability = 0
    holes = 0
    for timeframe in timeframes:
        interval_ms = INTERVAL_MS[timeframe]
        if local is None:
            display = mainnet.candles(ticker, timeframe, start_ms, end_ms)
            display = exclude_open_bucket(display, interval_ms, now_ms)
            values = reference_values(display, interval_ms, main_five,
                                      main_thirty, geometry)
            served_bars = enrich_bars(display, values)
            second = served_bars
            timeframe_ready = True
        else:
            # The retained source probes above own the bounded warm wait. Two
            # immediate display reads both test fixed-window stability and
            # give MergePassthrough one retry opportunity without multiplying
            # a 45-second source wait by every selected timeframe.
            first, first_ready = local.candles(
                ticker, timeframe, start_ms, end_ms, warm_retries=1)
            second, second_ready = local.candles(
                ticker, timeframe, start_ms, end_ms, warm_retries=1)
            served_bars = exclude_open_bucket(first, interval_ms, now_ms)
            second = exclude_open_bucket(second, interval_ms, now_ms)
            timeframe_ready = first_ready and second_ready
            store_ready = store_ready and timeframe_ready
            stability += stability_differences(served_bars, second)
        holes += display_holes(served_bars, interval_ms)
        series[timeframe] = served_bars
        current_values = reference_values(served_bars, interval_ms, main_five,
                                          main_thirty, geometry)
        retained_values = reference_values(
            served_bars, interval_ms, retained_five, retained_thirty, geometry)
        for i, bar in enumerate(served_bars):
            open_ms = int(bar["t"])
            end = bucket_end_ms(served_bars, i, interval_ms)
            external = bool(geometry) and source_covers_bucket(
                open_ms, end, interval_ms, main_five, main_thirty,
                geometry["seam"])
            classification = classify_delta(
                bar.get("cvdDelta"), current_values[i], retained_values[i],
                external_covered=external, retained_ready=retained_ready,
                store_ready=timeframe_ready)
            classifications[classification] += 1
            rows.append({
                "ticker": ticker, "timeframe": timeframe,
                "open_ms": open_ms, "open_utc": _utc(open_ms),
                "served": _format_value(bar.get("cvdDelta")),
                "mainnet_reference": _format_value(current_values[i]),
                "retained_reference": _format_value(retained_values[i]),
                "classification": classification,
                "nil_band": nil_band(open_ms, geometry),
                "store_ready": str(bool(timeframe_ready)).lower(),
                "external_covered": str(bool(external)).lower(),
            })

    conservation = conservation_check(series)
    divergence = anchored_divergence(series)
    result = {
        "ticker": ticker, "classifications": classifications,
        "stability_differences": stability, "display_holes": holes,
        "store_ready": store_ready, "conservation": conservation,
        "divergence": divergence, "nil_census": nil_census(series, geometry),
        "rows": rows,
    }
    if geometry:
        result.update({"seam_utc": _utc(geometry["seam"]),
                       "source_start_utc": _utc(geometry["source_start"]),
                       "source_end_utc": _utc(geometry["source_end"])})
    return result


def parse_csv(value):
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tickers", help="comma-separated explicit tickers")
    parser.add_argument("--timeframes", help="comma-separated chart intervals")
    parser.add_argument("--days", type=int, help="history window in days")
    parser.add_argument("--top", type=int, default=0)
    parser.add_argument("--mid", type=int, default=0)
    parser.add_argument("--bottom", type=int, default=0)
    parser.add_argument("--deep", action="store_true",
                        help="60-day audit including 1d and the 30m source leg")
    parser.add_argument("--skip-local", action="store_true",
                        help="validate reference identity without a local server")
    parser.add_argument("--api-token", default=os.getenv("PEZ_API_TOKEN"))
    parser.add_argument("--max-weight-per-min", type=int, default=300)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    days = args.days if args.days is not None else (60 if args.deep else 14)
    if days <= 0:
        raise SystemExit("--days must be positive")
    timeframes = parse_csv(args.timeframes) or list(
        DEEP_TIMEFRAMES if args.deep else DEFAULT_TIMEFRAMES)
    if args.deep and "1d" not in timeframes:
        timeframes.append("1d")
    unknown = [tf for tf in timeframes if tf not in INTERVAL_MS]
    if unknown:
        raise SystemExit("unsupported timeframe(s): %s" % ", ".join(unknown))

    mainnet = MainnetClient(WeightBudget(args.max_weight_per_min))
    tickers = parse_csv(args.tickers)
    top, mid, bottom = args.top, args.mid, args.bottom
    if not tickers and not any((top, mid, bottom)):
        top = mid = bottom = 5
    if any((top, mid, bottom)):
        tiers = pick_tiers(fetch_universe(mainnet), top, mid, bottom)
        seen = set(tickers)
        tickers += [ticker for ticker in tiers if ticker not in seen and
                    not seen.add(ticker)]
    if not tickers:
        raise SystemExit("no tickers selected")

    now_ms = int(time.time() * 1000)
    end_ms = (now_ms // min(INTERVAL_MS[tf] for tf in timeframes)) * min(
        INTERVAL_MS[tf] for tf in timeframes)
    start_ms = end_ms - days * DAY_MS
    local = None if args.skip_local else LocalClient(
        os.getenv("PEZ_URL", "http://127.0.0.1:5001"), args.api_token)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_dir = Path(__file__).resolve().parent / "reports" / timestamp
    report_dir.mkdir(parents=True, exist_ok=True)

    run = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(),
           "mode": "ground-truth-only" if args.skip_local else "local-live",
           "days": days, "tickers": tickers, "timeframes": timeframes,
           "results": [], "classifications": {name: 0 for name in CLASSIFICATIONS},
           "stability_differences": 0, "conservation_violations": 0,
           "display_holes": 0, "passed": False}
    print("CVD validation: %d ticker(s), %dd, %s" %
          (len(tickers), days, ",".join(timeframes)), flush=True)
    for ticker in tickers:
        print("[%s] fetching and validating..." % ticker, flush=True)
        try:
            result = validate_ticker(ticker, timeframes, start_ms, end_ms,
                                     now_ms, mainnet, local)
        except Exception as exc:  # preserve partial reports on network errors
            result = {"ticker": ticker, "error": str(exc),
                      "classifications": {name: 0 for name in CLASSIFICATIONS},
                      "stability_differences": 0, "display_holes": 0,
                      "store_ready": False, "conservation": [],
                      "divergence": [], "nil_census": {}, "rows": []}
            result["classifications"]["genuine-mismatch"] = 1
        write_ticker_csv(report_dir / "per_ticker" / (ticker.replace(":", "_") + ".csv"),
                         result.pop("rows"))
        run["results"].append(result)
        for name in CLASSIFICATIONS:
            run["classifications"][name] += result["classifications"].get(name, 0)
        run["stability_differences"] += result["stability_differences"]
        run["display_holes"] += result["display_holes"]
        run["conservation_violations"] += sum(
            len(item["violations"]) for item in result["conservation"])
        print("[%s] %s; stability=%d conservation=%d" %
              (ticker, ", ".join("%s=%d" % (name, result["classifications"].get(name, 0))
                                  for name in CLASSIFICATIONS),
               result["stability_differences"],
               sum(len(item["violations"]) for item in result["conservation"])),
              flush=True)

    run["passed"] = (run["classifications"]["genuine-mismatch"] == 0 and
                     run["stability_differences"] == 0 and
                     run["conservation_violations"] == 0)
    write_summary(report_dir / "summary.md", run)
    print("%s: genuine=%d stability=%d conservation=%d" %
          ("PASS" if run["passed"] else "FAIL",
           run["classifications"]["genuine-mismatch"],
           run["stability_differences"], run["conservation_violations"]))
    print("Report: %s" % (report_dir / "summary.md"))
    return 0 if run["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
