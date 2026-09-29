"""Python mirror of the server's composite-CVD pipeline.

Mirrors internal/infrastructure/candlecache/store.go:
  - directionalDelta: sign(close-open) * volume, 0 on doji/parse error.
  - cvdSeam: the 30m boundary at/above the 5m series' first bar; the
    composite uses 30m bars strictly before it and 5m bars at/after.
  - ComputeCvdDeltas bucket rules, including the honesty gates: a bucket is
    None (client falls back) when it straddles the start of coverage, opens
    at/after the end of coverage, is a pre-seam bucket finer than 30m, or is
    a traded bucket with no covering source bars.

The health gates the server also applies (cold/degraded/gapped series) are
invisible to the harness — it computes what an honest server should serve
given complete mainnet source data. A served-nil where the reference has a
value therefore means "server declined (cold/gap)", which check (a)
classifies separately from a genuine mismatch.
"""

RECENT_MS = 300_000       # 5m composite leg
DEEP_MS = 1_800_000       # 30m composite leg


def parse_float(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v


def directional_delta(candle):
    o = parse_float(candle.get("o"))
    c = parse_float(candle.get("c"))
    v = parse_float(candle.get("v"))
    if o is None or c is None or v is None or v <= 0:
        return 0.0
    if c > o:
        return v
    if c < o:
        return -v
    return 0.0


def candle_volume(candle):
    v = parse_float(candle.get("v"))
    return v if v is not None else 0.0


def cvd_seam(first_recent_open_ms):
    return ((first_recent_open_ms + DEEP_MS - 1) // DEEP_MS) * DEEP_MS


def bucket_end_ms(bars, i, interval_ms):
    """Next candle's open when there is one, else open + interval —
    matching store.go bucketEndMs (display holes are absorbed by the
    preceding bar, which is cumulative-conserving)."""
    if i + 1 < len(bars) and int(bars[i + 1]["t"]) > int(bars[i]["t"]):
        return int(bars[i + 1]["t"])
    return int(bars[i]["t"]) + interval_ms


def compute_cvd_deltas(display_bars, display_interval_ms, five_m, thirty_m,
                       seam_ms=None, source_start_ms=None,
                       source_end_ms=None):
    """Returns a list of Optional[float], one per display bar.

    ``seam_ms`` and the source coverage bounds are explicit validation seams:
    callers comparing a retained server series with a fresh (and potentially
    shorter) upstream response must pass the retained series' values.  When
    omitted, the historical behavior is preserved and all three values are
    derived from the supplied source candles.
    """
    n = len(display_bars)
    result = [None] * n
    if n == 0 or not five_m:
        return result

    first_recent = int(five_m[0]["t"])
    last_recent = int(five_m[-1]["t"])
    seam = int(seam_ms) if seam_ms is not None else cvd_seam(first_recent)

    chart_from = int(display_bars[0]["t"])
    derived_source_start = seam
    if chart_from < seam:
        if not thirty_m and source_start_ms is None:
            return result
        if thirty_m:
            derived_source_start = int(thirty_m[0]["t"])
    source_start = (int(source_start_ms) if source_start_ms is not None
                    else derived_source_start)
    source_end = (int(source_end_ms) if source_end_ms is not None
                  else last_recent + RECENT_MS)

    source = [c for c in thirty_m if int(c["t"]) < seam]
    source += [c for c in five_m if int(c["t"]) >= seam]
    deltas = [(int(c["t"]), directional_delta(c)) for c in source]

    src_idx = 0
    for i, bar in enumerate(display_bars):
        open_ms = int(bar["t"])
        if open_ms <= 0:
            continue
        end_ms = bucket_end_ms(display_bars, i, display_interval_ms)
        if open_ms < source_start or open_ms >= source_end:
            continue
        if open_ms < seam and display_interval_ms < DEEP_MS:
            continue
        while src_idx < len(deltas) and deltas[src_idx][0] < open_ms:
            src_idx += 1
        total = 0.0
        covered = 0
        scan = src_idx
        while scan < len(deltas) and deltas[scan][0] < end_ms:
            total += deltas[scan][1]
            covered += 1
            scan += 1
        if covered == 0 and candle_volume(bar) > 0:
            continue
        result[i] = total
    return result
