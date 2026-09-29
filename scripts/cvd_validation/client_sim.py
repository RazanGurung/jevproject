"""Python mirror of the frontend's anchored-CVD cumulation (web/src/chart/cvd.js).

Replicates exactly what the chart renders so check (d) measures the
user-visible cross-timeframe divergence:
  - server cvdDelta used when present (0 is a value), else the display-
    timeframe directional fallback sign(close-open) * volume;
  - '1W-MON00' weekly anchor resets when the Monday-00:00-UTC week key of
    the bar's open changes; '1W-MON14' remains a compatibility alias;
  - custom one-shot anchors emit whitespace before the anchor timestamp and
    reset on the first bar at/after it.
"""

WEEK_S = 7 * 86_400
_MONDAY_EPOCH_OFFSET_S = 4 * 86_400  # 1970-01-01 was a Thursday


def monday_utc(t_s):
    return ((t_s - _MONDAY_EPOCH_OFFSET_S) // WEEK_S) * WEEK_S + _MONDAY_EPOCH_OFFSET_S


def directional_delta_for_bar(bar):
    try:
        o, c, v = float(bar["o"]), float(bar["c"]), float(bar.get("v") or 0)
    except (TypeError, ValueError, KeyError):
        return 0.0
    if v <= 0:
        return 0.0
    if c > o:
        return v
    if c < o:
        return -v
    return 0.0


def calculate(bars, anchor="1W-MON00", anchor_ts=None, use_fallback=True):
    """Returns rows [{'t': open_s, 'cum': float, 'is_anchor': bool,
    'used_fallback': bool}] mirroring CVD.calculate. Bars carry ms 't';
    rows carry seconds like the chart. With use_fallback=False, nil-delta
    bars contribute 0 (isolates the fallback's share of divergence)."""
    rows = []
    cum = 0.0
    last_week_key = None
    custom = anchor_ts is not None
    custom_reached = not custom
    last_t = 0

    for bar in bars:
        t_ms = int(bar["t"])
        t = t_ms // 1000 if t_ms >= 10 ** 12 else t_ms
        if last_t and t < last_t:
            continue
        last_t = t

        if custom and not custom_reached and t < anchor_ts:
            continue

        is_anchor = False
        if custom:
            if not custom_reached and t >= anchor_ts:
                custom_reached = True
                is_anchor = True
                cum = 0.0
        elif anchor in ("1W-MON00", "1W-MON14"):
            week_key = monday_utc(t)
            if week_key != last_week_key:
                is_anchor = True
                last_week_key = week_key
                cum = 0.0
        # anchor == 'CONTINUOUS': never reset.

        delta = bar.get("cvdDelta")
        used_fallback = delta is None
        if used_fallback:
            delta = directional_delta_for_bar(bar) if use_fallback else 0.0
        cum += float(delta)
        rows.append({"t": t, "cum": cum, "is_anchor": is_anchor,
                     "used_fallback": used_fallback})
    return rows
