"""
Reference Python implementation of the PEZ$ Jev System One Orderflow Signal Engine.
Reflects the exact mathematical and microstructural logic of internal/services/jev_service.go.
Stdlib-only (Python 3.9+) with zero external dependencies.
"""

import math
import time
from typing import Any, Dict, List, Optional, Tuple


def parse_float(val: Any) -> float:
    """Parses float from various types safely."""
    if val is None:
        return 0.0
    try:
        f = float(val)
        return 0.0 if math.isnan(f) or math.isinf(f) else f
    except (ValueError, TypeError):
        return 0.0


def parse_extended_book_metrics(raw_book: Dict[str, Any]) -> Tuple[
    float, float, float, float, float, float, float, float, float, float, float, float
]:
    """
    Parses L2 orderbook snapshot into:
    best_bid, best_ask,
    bid_depth_usd, ask_depth_usd,
    touch_bid_usd, touch_ask_usd,
    deep_bid_usd, deep_ask_usd,
    weighted_bid_usd, weighted_ask_usd,
    touch_bid_sz, touch_ask_sz
    """
    if not isinstance(raw_book, dict) or "levels" not in raw_book:
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

    levels = raw_book.get("levels")
    if not isinstance(levels, (list, tuple)) or len(levels) < 2:
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

    bids_slice = levels[0] if isinstance(levels[0], list) else []
    asks_slice = levels[1] if isinstance(levels[1], list) else []

    best_bid, touch_bid_usd, deep_bid_usd, bid_depth_usd, weighted_bid_usd, touch_bid_sz = (
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0
    )
    for i, item in enumerate(bids_slice):
        if not isinstance(item, dict):
            continue
        px = parse_float(item.get("px"))
        sz = parse_float(item.get("sz"))
        w = 1.0 / (1.0 + float(i))
        if px > 0.0 and sz > 0.0:
            notional = px * sz
            weighted_bid_usd += notional * w
            bid_depth_usd += notional
            if i == 0:
                best_bid = px
                touch_bid_usd = notional
                touch_bid_sz = sz
            else:
                deep_bid_usd += notional
        if i >= 9:
            break

    best_ask, touch_ask_usd, deep_ask_usd, ask_depth_usd, weighted_ask_usd, touch_ask_sz = (
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0
    )
    for i, item in enumerate(asks_slice):
        if not isinstance(item, dict):
            continue
        px = parse_float(item.get("px"))
        sz = parse_float(item.get("sz"))
        w = 1.0 / (1.0 + float(i))
        if px > 0.0 and sz > 0.0:
            notional = px * sz
            weighted_ask_usd += notional * w
            ask_depth_usd += notional
            if i == 0:
                best_ask = px
                touch_ask_usd = notional
                touch_ask_sz = sz
            else:
                deep_ask_usd += notional
        if i >= 9:
            break

    return (
        best_bid,
        best_ask,
        bid_depth_usd,
        ask_depth_usd,
        touch_bid_usd,
        touch_ask_usd,
        deep_bid_usd,
        deep_ask_usd,
        weighted_bid_usd,
        weighted_ask_usd,
        touch_bid_sz,
        touch_ask_sz,
    )


def calculate_micro_price(
    best_bid: float,
    best_ask: float,
    touch_bid_usd: float,
    touch_ask_usd: float,
    mid_price: float,
) -> Tuple[float, float]:
    """
    Calculates Micro-Price and micro-price drift in basis points.
    MicroPrice = (touchBid * bestAsk + touchAsk * bestBid) / (touchBid + touchAsk)
    """
    touch_total = touch_bid_usd + touch_ask_usd
    if touch_total <= 0.0 or best_bid <= 0.0 or best_ask <= 0.0:
        return mid_price, 0.0

    micro_price = (touch_bid_usd * best_ask + touch_ask_usd * best_bid) / touch_total
    drift_bps = 0.0
    if mid_price > 0.0:
        drift_bps = ((micro_price - mid_price) / mid_price) * 10000.0

    return micro_price, drift_bps


def calculate_dynamic_ofi(
    prev_snap: Optional[Dict[str, Any]],
    curr_snap: Dict[str, Any],
    weighted_imbalance: float,
) -> float:
    """
    Calculates Cont-Kukanov-Stoikov Order Flow Imbalance (OFI) delta between sequential snapshots:
    Delta_Bid = Q_bid if P_bid > P_prev_bid; Q_bid - Q_prev_bid if P_bid == P_prev_bid; -Q_prev_bid otherwise.
    Delta_Ask = Q_ask if P_ask < P_prev_ask; Q_ask - Q_prev_ask if P_ask == P_prev_ask; -Q_prev_ask otherwise.
    OFI = Delta_Bid - Delta_Ask.
    Blends 70% dynamic OFI with 30% weighted depth imbalance when sequential state is fresh (<=15s).
    """
    if not prev_snap:
        return weighted_imbalance

    time_diff = curr_snap.get("ts", 0.0) - prev_snap.get("ts", 0.0)
    if time_diff > 15.0 or prev_snap.get("best_bid", 0.0) <= 0.0 or prev_snap.get("best_ask", 0.0) <= 0.0:
        return weighted_imbalance

    best_bid = curr_snap.get("best_bid", 0.0)
    best_ask = curr_snap.get("best_ask", 0.0)
    bid_sz = curr_snap.get("bid_sz", 0.0)
    ask_sz = curr_snap.get("ask_sz", 0.0)

    prev_bid = prev_snap.get("best_bid", 0.0)
    prev_ask = prev_snap.get("best_ask", 0.0)
    prev_bid_sz = prev_snap.get("bid_sz", 0.0)
    prev_ask_sz = prev_snap.get("ask_sz", 0.0)

    delta_bid = 0.0
    if best_bid > prev_bid:
        delta_bid = bid_sz
    elif best_bid == prev_bid:
        delta_bid = bid_sz - prev_bid_sz
    else:
        delta_bid = -prev_bid_sz

    delta_ask = 0.0
    if best_ask < prev_ask:
        delta_ask = ask_sz
    elif best_ask == prev_ask:
        delta_ask = ask_sz - prev_ask_sz
    else:
        delta_ask = -prev_ask_sz

    raw_ofi = delta_bid - delta_ask
    norm_base = bid_sz + ask_sz
    if norm_base <= 0.0:
        return weighted_imbalance

    norm_ofi = max(-1.0, min(1.0, raw_ofi / norm_base))
    return 0.70 * norm_ofi + 0.30 * weighted_imbalance


def round_half_up(val: float) -> float:
    """Matches Go's math.Round behavior (round half away from zero)."""
    return math.floor(val + 0.5) if val >= 0.0 else math.ceil(val - 0.5)


def normalize_perp_price(price: float, sz_decimals: int = 2) -> float:
    """
    Canonical Hyperliquid price quantization:
    5 significant figures, at most 6 - sz_decimals decimal places,
    with an integer exception (e.g. 123456 remains integer).
    """
    if price <= 0.0:
        return price
    max_decimals = max(0, 6 - sz_decimals)
    if price == math.trunc(price):
        return price

    sig_decimals = 4 - int(math.floor(math.log10(abs(price))))
    if sig_decimals < 0:
        sig_decimals = 0
    decimals = min(max_decimals, sig_decimals)
    scale = 10 ** decimals
    return round_half_up(price * scale) / scale


def check_spread_feasibility(timeframe: str, spread_bps: float, sl_pct: float) -> Tuple[bool, str]:
    """
    Verifies whether bid-ask spread is within safe trading friction bounds.
    """
    tf = timeframe.lower()
    max_spread = 25.0
    if tf == "scalp":
        max_spread = 8.0
    elif tf == "swing":
        max_spread = 40.0

    spread_pct = spread_bps / 100.0
    if spread_bps > max_spread or (sl_pct > 0.0 and spread_pct >= sl_pct * 0.75):
        return False, f"[{tf.upper()}] Spread too wide ({spread_bps:.1f} bps); friction exceeds strategy tolerance."
    return True, ""


def check_spoof_trap(action: str, touch_imbalance: float, deep_imbalance: float, timeframe: str) -> Tuple[bool, str]:
    """
    Zero-lag spatial multi-depth divergence defense:
    Flags when flash liquidity at touch opposes deep structural depth overhang.
    """
    tf_tag = timeframe.upper()
    if action == "BUY" and touch_imbalance > 0.25 and deep_imbalance < -0.20:
        return False, f"[{tf_tag}] Spoof trap defense: touch/deep depth divergence ({touch_imbalance:+.2f} touch vs {deep_imbalance:+.2f} deep overhang)."
    if action == "SELL" and touch_imbalance < -0.25 and deep_imbalance > 0.20:
        return False, f"[{tf_tag}] Spoof trap defense: touch/deep depth divergence ({touch_imbalance:+.2f} touch vs {deep_imbalance:+.2f} deep support)."
    return True, ""


def compute_volume_profile(
    candles: List[Dict[str, Any]],
    bins: int = 70,
    value_area_pct: float = 0.70,
    horizon_days: int = 30,
) -> Dict[str, Any]:
    """
    Computes Auction Market Theory Volume Profile from OHLCV candles.
    Returns poc, vah, val, profile_low, profile_high, total_volume, horizon_type, horizon_days.
    """
    h_type = "quarterly" if horizon_days >= 90 else "monthly"
    if not candles or len(candles) < 2:
        return {
            "poc": 0.0,
            "vah": 0.0,
            "val": 0.0,
            "profile_low": 0.0,
            "profile_high": 0.0,
            "total_volume": 0.0,
            "horizon_type": h_type,
            "horizon_days": horizon_days,
        }

    lo = float("inf")
    hi = float("-inf")
    for c in candles:
        h = parse_float(c.get("h"))
        l = parse_float(c.get("l"))
        if h > 0 and l > 0:
            lo = min(lo, l)
            hi = max(hi, h)

    if hi <= lo or math.isinf(lo) or math.isinf(hi):
        return {
            "poc": 0.0,
            "vah": 0.0,
            "val": 0.0,
            "profile_low": 0.0,
            "profile_high": 0.0,
            "total_volume": 0.0,
            "horizon_type": h_type,
            "horizon_days": horizon_days,
        }

    bin_h = (hi - lo) / bins
    vols = [0.0] * bins

    for c in candles:
        v = parse_float(c.get("v"))
        h = parse_float(c.get("h"))
        l = parse_float(c.get("l"))
        if v <= 0 or h <= 0 or l <= 0:
            continue
        b0 = max(0, min(bins - 1, int((l - lo) / bin_h)))
        b1 = max(0, min(bins - 1, int((h - lo) / bin_h)))
        per = v / (b1 - b0 + 1)
        for b in range(b0, b1 + 1):
            vols[b] += per

    max_vol = 0.0
    poc_idx = 0
    total_vol = 0.0
    for b in range(bins):
        total_vol += vols[b]
        if vols[b] > max_vol:
            max_vol = vols[b]
            poc_idx = b

    if max_vol <= 0.0 or total_vol <= 0.0:
        return {
            "poc": 0.0,
            "vah": 0.0,
            "val": 0.0,
            "profile_low": lo,
            "profile_high": hi,
            "total_volume": 0.0,
            "horizon_type": h_type,
            "horizon_days": horizon_days,
        }

    target_va_vol = max(0.0, value_area_pct) * total_vol
    va_vol = vols[poc_idx]
    va_upper = poc_idx
    va_lower = poc_idx

    while va_vol < target_va_vol and (va_upper < bins - 1 or va_lower > 0):
        next_up = vols[va_upper + 1] if va_upper + 1 < bins else -1.0
        next_down = vols[va_lower - 1] if va_lower - 1 >= 0 else -1.0
        if next_up >= next_down:
            va_upper += 1
            va_vol += next_up
        else:
            va_lower -= 1
            va_vol += next_down

    poc = lo + (poc_idx + 0.5) * bin_h
    vah = lo + (va_upper + 1) * bin_h
    val = lo + va_lower * bin_h

    return {
        "poc": round_half_up(poc * 100.0) / 100.0,
        "vah": round_half_up(vah * 100.0) / 100.0,
        "val": round_half_up(val * 100.0) / 100.0,
        "profile_low": round_half_up(lo * 100.0) / 100.0,
        "profile_high": round_half_up(hi * 100.0) / 100.0,
        "total_volume": round_half_up(total_vol * 100.0) / 100.0,
        "horizon_type": h_type,
        "horizon_days": horizon_days,
    }


def compute_macro_extension(
    candles: List[Dict[str, Any]],
    current_price: float,
    horizon_type: str = "monthly",
    quarterly_twap: float = 0.0,
    quarterly_dist_pct: float = 0.0,
) -> Dict[str, Any]:
    """
    Computes TWAP anchor deviation and impulse move consumption %.
    Supports Monthly (30D) and Quarterly (90D) horizons with dual quarterly checks.
    """
    h_type = "quarterly" if horizon_type.lower() == "quarterly" else "monthly"
    h_days = 90 if h_type == "quarterly" else 30

    if not candles or current_price <= 0:
        return {
            "twap": 0.0,
            "dist_from_twap_pct": 0.0,
            "twap_365d": 0.0,
            "dist_from_365d_pct": 0.0,
            "quarterly_twap": round_half_up(quarterly_twap * 100.0) / 100.0,
            "quarterly_dist_pct": round_half_up(quarterly_dist_pct * 100.0) / 100.0,
            "horizon_days": h_days,
            "horizon_type": h_type,
            "avg_impulse_pct": 0.0,
            "impulse_consumed_ratio": 0.0,
            "is_resistance_exhausted": False,
            "is_support_exhausted": False,
        }

    close_sum = sum(parse_float(c.get("c")) for c in candles)
    twap = close_sum / len(candles) if candles else current_price
    dist_from_twap = ((current_price - twap) / twap) * 100.0 if twap > 0 else 0.0

    recent_14 = candles[-14:] if len(candles) >= 14 else candles
    tr_pct_sum = 0.0
    for c in recent_14:
        h = parse_float(c.get("h"))
        l = parse_float(c.get("l"))
        if l > 0:
            tr_pct_sum += ((h - l) / l) * 100.0
    avg_impulse_pct = tr_pct_sum / len(recent_14) if recent_14 else 3.0

    recent_7 = candles[-7:] if len(candles) >= 7 else candles
    min_l_7 = min((parse_float(c.get("l")) for c in recent_7 if parse_float(c.get("l")) > 0), default=current_price)
    max_h_7 = max((parse_float(c.get("h")) for c in recent_7 if parse_float(c.get("h")) > 0), default=current_price)

    up_expansion_pct = ((current_price - min_l_7) / min_l_7) * 100.0 if min_l_7 > 0 else 0.0
    down_expansion_pct = ((current_price - max_h_7) / max_h_7) * 100.0 if max_h_7 > 0 else 0.0
    expected_impulse_range = max(1.0, avg_impulse_pct * 2.5)

    impulse_consumed_ratio = up_expansion_pct / expected_impulse_range if up_expansion_pct >= 0 else down_expansion_pct / expected_impulse_range

    is_res_exhausted = (dist_from_twap >= 6.0 and impulse_consumed_ratio >= 0.85)
    is_sup_exhausted = (dist_from_twap <= -6.0 and impulse_consumed_ratio <= -0.85)

    return {
        "twap": round_half_up(twap * 100.0) / 100.0,
        "dist_from_twap_pct": round_half_up(dist_from_twap * 100.0) / 100.0,
        "twap_365d": round_half_up(twap * 100.0) / 100.0,
        "dist_from_365d_pct": round_half_up(dist_from_twap * 100.0) / 100.0,
        "quarterly_twap": round_half_up(quarterly_twap * 100.0) / 100.0,
        "quarterly_dist_pct": round_half_up(quarterly_dist_pct * 100.0) / 100.0,
        "horizon_days": h_days,
        "horizon_type": h_type,
        "avg_impulse_pct": round_half_up(avg_impulse_pct * 100.0) / 100.0,
        "impulse_consumed_ratio": round_half_up(impulse_consumed_ratio * 100.0) / 100.0,
        "is_resistance_exhausted": is_res_exhausted,
        "is_support_exhausted": is_sup_exhausted,
    }


class JevSignalEngine:
    """
    Stateful Python engine mirroring JevService in internal/services/jev_service.go.
    """

    def __init__(self, sz_decimals: int = 2):
        self.sz_decimals = sz_decimals
        self.last_signals: Dict[str, Dict[str, Any]] = {}
        self.toxic_cooldowns: Dict[str, float] = {}
        self.last_snapshots: Dict[str, Dict[str, Any]] = {}

    def reset(self, coin: Optional[str] = None):
        """Clears cached signals, cooldowns, and snapshots."""
        if not coin:
            self.last_signals.clear()
            self.toxic_cooldowns.clear()
            self.last_snapshots.clear()
            return
        c = coin.strip().upper()
        self.last_signals = {k: v for k, v in self.last_signals.items() if not k.startswith(c + ":")}
        self.toxic_cooldowns = {k: v for k, v in self.toxic_cooldowns.items() if not k.startswith(c + ":")}
        self.last_snapshots.pop(c, None)

    def analyze_orderbook(
        self,
        coin: str,
        raw_book: Dict[str, Any],
        timeframe: str = "intraday",
        external_mid: float = 0.0,
        now_ts: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Analyzes orderbook, calculates touch/deep depth, weighted imbalance, micro-price,
        and dynamic OFI.
        """
        ts = now_ts if now_ts is not None else time.time()
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
        ) = parse_extended_book_metrics(raw_book)

        mid_price = external_mid
        if mid_price <= 0.0 and best_bid > 0.0 and best_ask > 0.0:
            mid_price = (best_bid + best_ask) / 2.0

        spread = 0.0
        spread_bps = 0.0
        if best_bid > 0.0 and best_ask > 0.0:
            if best_ask >= best_bid:
                spread = best_ask - best_bid
                if mid_price > 0.0:
                    spread_bps = (spread / mid_price) * 10000.0
            else:
                spread = best_ask - best_bid
                spread_bps = -1.0  # Crossed book flag

        total_depth = bid_depth + ask_depth
        book_imbalance = (bid_depth - ask_depth) / total_depth if total_depth > 0.0 else 0.0

        weighted_total = weighted_bid + weighted_ask
        weighted_imbalance = (
            (weighted_bid - weighted_ask) / weighted_total if weighted_total > 0.0 else 0.0
        )

        touch_total = touch_bid + touch_ask
        touch_imbalance = (touch_bid - touch_ask) / touch_total if touch_total > 0.0 else 0.0

        deep_total = deep_bid + deep_ask
        deep_imbalance = (deep_bid - deep_ask) / deep_total if deep_total > 0.0 else 0.0

        micro_price, micro_drift_bps = calculate_micro_price(
            best_bid, best_ask, touch_bid, touch_ask, mid_price
        )

        curr_snap = {
            "best_bid": best_bid,
            "best_ask": best_ask,
            "bid_sz": touch_bid_sz,
            "ask_sz": touch_ask_sz,
            "ts": ts,
        }
        coin_key = coin.strip().upper()
        prev_snap = self.last_snapshots.get(coin_key)
        self.last_snapshots[coin_key] = curr_snap

        ofi = calculate_dynamic_ofi(prev_snap, curr_snap, weighted_imbalance)

        return {
            "coin": coin_key,
            "timeframe": timeframe.lower(),
            "mid_price": mid_price,
            "best_bid": best_bid,
            "best_ask": best_ask,
            "spread": spread,
            "spread_bps": spread_bps,
            "book_imbalance": ofi,
            "raw_imbalance": book_imbalance,
            "weighted_imbalance": weighted_imbalance,
            "touch_imbalance": touch_imbalance,
            "deep_imbalance": deep_imbalance,
            "micro_price": micro_price,
            "micro_price_drift_bps": micro_drift_bps,
            "bid_depth_usd": bid_depth,
            "ask_depth_usd": ask_depth,
            "timestamp": int(ts * 1000),
        }

    def generate_signal(
        self,
        coin: str,
        raw_book: Dict[str, Any],
        jev_decision: Dict[str, Any],
        timeframe: str = "intraday",
        external_mid: float = 0.0,
        now_ts: Optional[float] = None,
        atr_pct: Optional[float] = None,
        change_24h: Optional[float] = None,
        macro_trend: Optional[str] = None,
        volume_profile: Optional[Dict[str, Any]] = None,
        macro_extension: Optional[Dict[str, Any]] = None,
        monthly_profile: Optional[Dict[str, Any]] = None,
        quarterly_profile: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Synthesizes orderbook metrics and Jev AI decision into an actionable trade signal.
        """
        tf = timeframe.lower() if timeframe else "intraday"
        if tf not in ("scalp", "intraday", "swing"):
            tf = "intraday"

        profile_hz = "quarterly" if tf == "swing" else "monthly"
        if volume_profile and volume_profile.get("horizon_type"):
            profile_hz = volume_profile.get("horizon_type")
        elif volume_profile is None:
            if profile_hz == "quarterly" and quarterly_profile:
                volume_profile = quarterly_profile
            elif monthly_profile:
                volume_profile = monthly_profile

        ts = now_ts if now_ts is not None else time.time()
        now_ms = int(ts * 1000)
        state_key = f"{coin.strip().upper()}:{tf}"

        prev_sig = self.last_signals.get(state_key)
        cooldown_until = self.toxic_cooldowns.get(state_key, 0.0)
        in_cooldown = ts < cooldown_until

        analysis = self.analyze_orderbook(coin, raw_book, tf, external_mid, ts)

        direction = jev_decision.get("direction", "neutral")
        dir_conf = parse_float(jev_decision.get("confidence", 0.5))
        dir_probs = jev_decision.get("probabilities", {})
        score = parse_float(jev_decision.get("score", 3.0))
        toxic_risk = parse_float(jev_decision.get("toxic_risk", 0.0))
        suggested_limit = parse_float(jev_decision.get("suggested_limit", 0.0))

        # Dynamic ATR vs Baseline brackets
        has_atr = atr_pct is not None and atr_pct > 0.0
        if has_atr:
            if tf == "scalp":
                estimated_duration = "15m – 45m (Quick Scalp)"
                toxic_threshold = 0.35
                min_activation = 0.65
                retention_floor = 0.50
                max_spread_bps = 8.0
                sl_pct = round(max(0.30, min(1.50, atr_pct * 0.60)), 2)
                tp_pct = round(sl_pct * 2.0, 2)
            elif tf == "swing":
                estimated_duration = "1d – 5d (Intra-Month Swing)"
                toxic_threshold = 0.55
                min_activation = 0.60
                retention_floor = 0.48
                max_spread_bps = 40.0
                sl_pct = round(max(2.00, min(12.00, atr_pct * 2.20)), 2)
                tp_pct = round(sl_pct * 2.1, 2)
            else:  # intraday
                estimated_duration = "2h – 8h (Session Intraday)"
                toxic_threshold = 0.45
                min_activation = 0.65
                retention_floor = 0.50
                max_spread_bps = 25.0
                sl_pct = round(max(1.00, min(4.50, atr_pct * 1.20)), 2)
                tp_pct = round(sl_pct * 2.0, 2)
        else:
            if tf == "scalp":
                estimated_duration = "15m – 45m (Quick Scalp)"
                toxic_threshold = 0.35
                min_activation = 0.65
                retention_floor = 0.50
                max_spread_bps = 8.0
                sl_pct, tp_pct = 0.25, 0.50
                if analysis["spread_bps"] > 5.0:
                    sl_pct, tp_pct = 0.40, 0.80
                elif analysis["spread_bps"] < 0.5:
                    sl_pct, tp_pct = 0.20, 0.40
            elif tf == "swing":
                estimated_duration = "1d – 5d (Intra-Month Swing)"
                toxic_threshold = 0.55
                min_activation = 0.60
                retention_floor = 0.48
                max_spread_bps = 40.0
                sl_pct, tp_pct = 2.00, 4.20
                if analysis["spread_bps"] > 5.0:
                    sl_pct, tp_pct = 3.00, 6.30
                elif analysis["spread_bps"] < 0.5:
                    sl_pct, tp_pct = 1.50, 3.15
            else:  # intraday
                estimated_duration = "2h – 8h (Session Intraday)"
                toxic_threshold = 0.45
                min_activation = 0.65
                retention_floor = 0.50
                max_spread_bps = 25.0
                sl_pct, tp_pct = 0.60, 1.20
                if analysis["spread_bps"] > 5.0:
                    sl_pct, tp_pct = 0.90, 1.80
                elif analysis["spread_bps"] < 0.5:
                    sl_pct, tp_pct = 0.40, 0.80
        is_crossed = (
            analysis["spread_bps"] < 0.0
            or (analysis["best_bid"] > 0.0 and analysis["best_ask"] > 0.0 and analysis["best_bid"] >= analysis["best_ask"])
        )
        spread_pct = analysis["spread_bps"] / 100.0 if analysis["spread_bps"] > 0.0 else 0.0
        is_toxic_halted = False
        toxic_halt_remaining_seconds = 0
        market_env = "range"
        signal_type = "neutral"
        if is_crossed:
            action = "HOLD"
            reason = f"[{tf.upper()}] Orderbook crossed or unquoted (bid {analysis['best_bid']:.4f} >= ask {analysis['best_ask']:.4f}); market paused."
        elif toxic_risk > toxic_threshold:
            # Gate 2: Instant Toxic Flow Tripwire (0ms)
            action = "HOLD"
            reason = f"[{tf.upper()}] Toxic flow tripwire active ({toxic_risk*100:.0f}% > {toxic_threshold*100:.0f}% limit); adverse sweep detected."
            self.toxic_cooldowns[state_key] = ts + 15.0
            is_toxic_halted = True
            toxic_halt_remaining_seconds = 15
        elif in_cooldown and ts < cooldown_until and toxic_risk > (toxic_threshold * 0.8):
            action = "HOLD"
            remaining = max(1, int(round(cooldown_until - ts)))
            reason = f"[{tf.upper()}] Toxic flow stabilizing ({remaining}s cooldown); waiting for orderbook replenishment."
            is_toxic_halted = True
            toxic_halt_remaining_seconds = remaining
        elif analysis["spread_bps"] > max_spread_bps or (sl_pct > 0.0 and spread_pct >= sl_pct * 0.75):
            # Gate 3: Spread friction gating
            action = "HOLD"
            reason = f"[{tf.upper()}] Spread too wide ({analysis['spread_bps']:.1f} bps); friction exceeds strategy tolerance."
        else:
            # Gate 4: Dual-Threshold State Hysteresis (Schmitt Trigger)
            has_valid_prior = (
                prev_sig is not None
                and prev_sig.get("action") != "HOLD"
                and (now_ms - prev_sig.get("timestamp", 0)) < 180000  # 3 min memory window
            )

            if has_valid_prior and prev_sig["action"] == "BUY":
                # Instant regime reversal on high counter-conviction
                if direction == "bearish" and dir_conf >= min_activation:
                    action = "SELL"
                    reason = f"[{tf.upper()}] Regime reversal: aggressive ask overhang detected ({dir_conf*100:.0f}% conviction)."
                elif direction == "bullish" and dir_conf >= retention_floor:
                    action = "BUY"
                    if dir_conf < min_activation:
                        reason = f"[{tf.upper()}] BUY state retained via hysteresis ({dir_conf*100:.0f}% conviction holding above {retention_floor*100:.0f}% floor)."
                    else:
                        reason = f"[{tf.upper()}] Bullish orderflow conviction confirmed ({dir_conf*100:.0f}%)."
                elif direction == "neutral":
                    bull_prob = parse_float(dir_probs.get("bullish", 0.0))
                    if (bull_prob >= retention_floor or analysis["book_imbalance"] > 0.12) and dir_conf < 0.75:
                        action = "BUY"
                        reason = f"[{tf.upper()}] BUY state retained during consolidation (order flow imbalance {analysis['book_imbalance']:+.2f})."
                    else:
                        action = "HOLD"
                        reason = f"[{tf.upper()}] Long conviction faded; order flow consolidated into neutral."
                else:
                    action = "HOLD"
                    reason = f"[{tf.upper()}] Long conviction faded below retention floor ({dir_conf*100:.0f}% < {retention_floor*100:.0f}%)."

            elif has_valid_prior and prev_sig["action"] == "SELL":
                # Instant regime reversal on high counter-conviction
                if direction == "bullish" and dir_conf >= min_activation:
                    action = "BUY"
                    reason = f"[{tf.upper()}] Regime reversal: aggressive bid support detected ({dir_conf*100:.0f}% conviction)."
                elif direction == "bearish" and dir_conf >= retention_floor:
                    action = "SELL"
                    if dir_conf < min_activation:
                        reason = f"[{tf.upper()}] SELL state retained via hysteresis ({dir_conf*100:.0f}% conviction holding above {retention_floor*100:.0f}% floor)."
                    else:
                        reason = f"[{tf.upper()}] Bearish orderflow conviction confirmed ({dir_conf*100:.0f}%)."
                elif direction == "neutral":
                    bear_prob = parse_float(dir_probs.get("bearish", 0.0))
                    if (bear_prob >= retention_floor or analysis["book_imbalance"] < -0.12) and dir_conf < 0.75:
                        action = "SELL"
                        reason = f"[{tf.upper()}] SELL state retained during consolidation (order flow imbalance {analysis['book_imbalance']:+.2f})."
                    else:
                        action = "HOLD"
                        reason = f"[{tf.upper()}] Short conviction faded; order flow consolidated into neutral."
                else:
                    action = "HOLD"
                    reason = f"[{tf.upper()}] Short conviction faded below retention floor ({dir_conf*100:.0f}% < {retention_floor*100:.0f}%)."

            else:
                # Activation from HOLD
                if dir_conf < min_activation:
                    action = "HOLD"
                    reason = f"[{tf.upper()}] Directional conviction insufficient ({dir_conf*100:.0f}% < {min_activation*100:.0f}% activation threshold)."
                elif direction == "bullish":
                    action = "BUY"
                    reason = f"[{tf.upper()}] Directional activation: bullish flow confirmed ({dir_conf*100:.0f}%)."
                elif direction == "bearish":
                    action = "SELL"
                    reason = f"[{tf.upper()}] Directional activation: bearish flow confirmed ({dir_conf*100:.0f}%)."

            # Gate 5: Spatial Multi-Depth Divergence Defense (Spoof Trap Protection)
            if action != "HOLD":
                safe, spoof_msg = check_spoof_trap(
                    action, analysis["touch_imbalance"], analysis["deep_imbalance"], tf
                )
                if not safe:
                    action = "HOLD"
                    reason = spoof_msg

            # Environment & Signal Type Classification (Range vs Trend)
            signal_type = "neutral"
            market_env = "range"
            c24 = change_24h if change_24h is not None else 0.0
            vah_val = parse_float(volume_profile.get("vah")) if volume_profile else 0.0
            val_val = parse_float(volume_profile.get("val")) if volume_profile else 0.0
            poc_val = parse_float(volume_profile.get("poc")) if volume_profile else 0.0
            has_range_bounds = vah_val > 0.0 and val_val > 0.0 and vah_val > val_val
            at_range_high = False
            at_range_low = False
            if has_range_bounds:
                at_range_high = (analysis["mid_price"] >= 0.990 * vah_val and analysis["mid_price"] <= 1.025 * vah_val)
                at_range_low = (analysis["mid_price"] <= 1.010 * val_val and analysis["mid_price"] >= 0.975 * val_val)

            if abs(c24) >= 3.0:
                market_env = "trend"
            elif has_range_bounds:
                if analysis["mid_price"] > vah_val * 1.020 and c24 >= 2.0:
                    market_env = "trend"
                elif analysis["mid_price"] < val_val * 0.980 and c24 <= -2.0:
                    market_env = "trend"
                else:
                    market_env = "range"
            else:
                market_env = "range" if abs(c24) < 2.0 else "trend"

            # Macro Extension metrics for Gate 7
            is_long_extended = False
            is_short_extended = False
            display_dist = 0.0
            display_twap_title = "30D" if profile_hz != "quarterly" else "90D"
            profile_title = "Quarterly" if profile_hz == "quarterly" else "Monthly"
            if macro_extension is not None:
                dist_twap = parse_float(macro_extension.get("dist_from_twap_pct", macro_extension.get("dist_from_365d_pct", 0.0)))
                q_dist = parse_float(macro_extension.get("quarterly_dist_pct", 0.0))
                is_res_exhausted = bool(macro_extension.get("is_resistance_exhausted", False))
                is_sup_exhausted = bool(macro_extension.get("is_support_exhausted", False))
                is_long_extended = is_res_exhausted or dist_twap >= 6.0 or q_dist >= 6.0
                is_short_extended = is_sup_exhausted or dist_twap <= -6.0 or q_dist <= -6.0
                display_dist = dist_twap
                if profile_hz != "quarterly" and q_dist >= 6.0 and dist_twap < 6.0:
                    display_dist = q_dist
                    display_twap_title = "90D"
                elif profile_hz != "quarterly" and q_dist <= -6.0 and dist_twap > -6.0:
                    display_dist = q_dist
                    display_twap_title = "90D"

            # Range Boundary & Support/Resistance Evaluation
            if at_range_high:
                if action == "BUY" and dir_conf >= 0.82:
                    # Institutional breakout trend long
                    action = "BUY"
                    signal_type = "trend"
                    market_env = "trend"
                    reason = f"[{tf.upper()}] Breakout trend long: institutional conviction ({dir_conf*100:.0f}%) clearing range high resistance (VAH ${vah_val:.2f}); momentum continuation."
                else:
                    # Counter-trend range-high short: fade long exhaustion at resistance
                    is_rejection = (direction == "bearish")
                    is_absorption = (dir_conf >= 0.70 and analysis["book_imbalance"] <= 0.10)
                    if is_rejection or is_absorption:
                        action = "SELL"
                        signal_type = "counter_trend"
                        market_env = "range"
                        if is_rejection:
                            reason = f"[{tf.upper()}] Counter-trend range-high short: resistance rejection confirmed at VAH (${vah_val:.2f}); fading toward POC (${poc_val:.2f})."
                        else:
                            reason = f"[{tf.upper()}] Counter-trend range-high short: testing resistance (${analysis['mid_price']:.2f} vs VAH ${vah_val:.2f}) with orderflow absorption; fading long exhaustion for mean-reversion toward POC (${poc_val:.2f})."
                    else:
                        action = "HOLD"
                        signal_type = "neutral"
                        market_env = "range"
                        if is_long_extended:
                            reason = f"[{tf.upper()}] Gate 7: Long suppressed at {profile_title} Volume Profile resistance (${analysis['mid_price']:.1f} testing VAH ${vah_val:.1f}; {display_dist:+.1f}% above {display_twap_title} TWAP); asymmetric downside risk."
                        else:
                            reason = f"[{tf.upper()}] Range high resistance test (${analysis['mid_price']:.2f} vs VAH ${vah_val:.2f}): awaiting order flow absorption/rejection before fading."
            elif at_range_low:
                if action == "SELL" and dir_conf >= 0.82:
                    # Institutional breakdown trend short
                    action = "SELL"
                    signal_type = "trend"
                    market_env = "trend"
                    reason = f"[{tf.upper()}] Breakdown trend short: institutional conviction ({dir_conf*100:.0f}%) clearing range low support (VAL ${val_val:.2f}); momentum continuation."
                else:
                    # Counter-trend range-low long: fade short exhaustion at support
                    is_bounce = (direction == "bullish")
                    is_absorption = (dir_conf >= 0.70 and analysis["book_imbalance"] >= -0.10)
                    if is_bounce or is_absorption:
                        action = "BUY"
                        signal_type = "counter_trend"
                        market_env = "range"
                        if is_bounce:
                            reason = f"[{tf.upper()}] Counter-trend range-low long: support bounce confirmed at VAL (${val_val:.2f}); mean-reversion bounce toward POC (${poc_val:.2f})."
                        else:
                            reason = f"[{tf.upper()}] Counter-trend range-low long: testing support (${analysis['mid_price']:.2f} vs VAL ${val_val:.2f}) with orderflow absorption; mean-reversion bounce toward POC (${poc_val:.2f})."
                    else:
                        action = "HOLD"
                        signal_type = "neutral"
                        market_env = "range"
                        if is_short_extended:
                            reason = f"[{tf.upper()}] Gate 7: Short suppressed at {profile_title} Volume Profile support (${analysis['mid_price']:.1f} testing VAL ${val_val:.1f}; {display_dist:+.1f}% below {display_twap_title} TWAP); asymmetric bounce risk."
                        else:
                            reason = f"[{tf.upper()}] Range low support test (${analysis['mid_price']:.2f} vs VAL ${val_val:.2f}): awaiting order flow absorption/bounce before longing."
            else:
                # NOT at range high or range low: strictly enforce Gate 6 and Gate 7 against open-water momentum
                if action == "BUY" and c24 <= -3.5 and dir_conf < 0.78:
                    action = "HOLD"
                    reason = f"[{tf.upper()}] Macro trend filter: counter-trend BUY suppressed during 24h dump ({c24:+.1f}%; requires 78% conviction)."
                elif action == "SELL" and c24 >= 3.5 and dir_conf < 0.78:
                    action = "HOLD"
                    reason = f"[{tf.upper()}] Macro trend filter: counter-trend SELL suppressed during 24h surge ({c24:+.1f}%; requires 78% conviction)."
                elif action == "BUY" and is_long_extended and dir_conf < 0.82:
                    action = "HOLD"
                    reason = f"[{tf.upper()}] Gate 7: Long suppressed at {profile_title} Volume Profile resistance (${analysis['mid_price']:.1f}; {display_dist:+.1f}% above {display_twap_title} TWAP); asymmetric downside risk."
                elif action == "SELL" and is_short_extended and dir_conf < 0.82:
                    action = "HOLD"
                    reason = f"[{tf.upper()}] Gate 7: Short suppressed at {profile_title} Volume Profile support (${analysis['mid_price']:.1f}; {display_dist:+.1f}% below {display_twap_title} TWAP); asymmetric bounce risk."
                elif action != "HOLD":
                    if market_env == "range":
                        if poc_val > 0.0 and abs(analysis["mid_price"] - poc_val) / poc_val <= 0.005 and dir_conf < 0.70:
                            action = "HOLD"
                            signal_type = "neutral"
                            reason = f"[{tf.upper()}] Range equilibrium: price oscillating near POC (${poc_val:.2f}); awaiting test of range boundaries (VAH/VAL)."
                        else:
                            signal_type = "trend"
                            if not has_valid_prior:
                                if action == "BUY":
                                    reason = f"[{tf.upper()}] Range rotation BUY: upward momentum from POC (${poc_val:.2f}) toward range high (VAH ${vah_val:.2f})."
                                elif action == "SELL":
                                    reason = f"[{tf.upper()}] Range rotation SELL: downward momentum from POC (${poc_val:.2f}) toward range low (VAL ${val_val:.2f})."
                    else:
                        if c24 >= 2.0:
                            if action == "BUY":
                                signal_type = "trend"
                                if not has_valid_prior:
                                    reason = f"[{tf.upper()}] Trend following BUY: aligned with macro bull trend ({c24:+.1f}% 24h); upside continuation."
                            elif action == "SELL":
                                signal_type = "counter_trend"
                                if not has_valid_prior:
                                    reason = f"[{tf.upper()}] Counter-trend pull-back SELL: institutional conviction ({dir_conf*100:.0f}%) fading overextended bull trend ({c24:+.1f}% 24h)."
                        elif c24 <= -2.0:
                            if action == "SELL":
                                signal_type = "trend"
                                if not has_valid_prior:
                                    reason = f"[{tf.upper()}] Trend following SELL: aligned with macro bear trend ({c24:+.1f}% 24h); downside continuation."
                            elif action == "BUY":
                                signal_type = "counter_trend"
                                if not has_valid_prior:
                                    reason = f"[{tf.upper()}] Counter-trend relief BUY: institutional conviction ({dir_conf*100:.0f}%) fading oversold bear trend ({c24:+.1f}% 24h)."
                        else:
                            signal_type = "trend"
                            if not has_valid_prior:
                                reason = f"[{tf.upper()}] Trend following {action}: directional momentum confirmed ({dir_conf*100:.0f}% conviction)."
        # Execution targets and bracket pricing
        entry_price = 0.0
        tp_price = 0.0
        sl_price = 0.0

        if action == "BUY":
            raw_entry = analysis["mid_price"]
            if tf == "scalp":
                if analysis["best_bid"] > 0.0:
                    raw_entry = analysis["best_bid"]
            elif tf == "swing":
                if analysis["mid_price"] > 0.0:
                    raw_entry = analysis["mid_price"] * 0.9975  # -0.25% pullback
            else:  # intraday
                if (
                    suggested_limit > 0.0
                    and analysis["best_ask"] > 0.0
                    and suggested_limit <= analysis["best_ask"]
                ):
                    raw_entry = suggested_limit
                elif analysis["best_bid"] > 0.0:
                    raw_entry = analysis["best_bid"]
            entry_price = normalize_perp_price(raw_entry, self.sz_decimals)

            if signal_type == "counter_trend" and val_val > 0.0 and poc_val > 0.0 and entry_price > 0.0:
                target_sl = entry_price * (1.0 - (sl_pct / 100.0))
                if val_val * 0.992 < entry_price:
                    target_sl = min(target_sl, val_val * 0.992)
                sl_price = normalize_perp_price(target_sl, self.sz_decimals)
                if 0.0 < sl_price < entry_price:
                    sl_pct = round(((entry_price - sl_price) / entry_price) * 10000.0) / 100.0
                target_tp = entry_price * (1.0 + (tp_pct / 100.0))
                if poc_val > entry_price:
                    target_tp = max(target_tp, poc_val)
                tp_price = normalize_perp_price(target_tp, self.sz_decimals)
                if tp_price > entry_price:
                    tp_pct = round(((tp_price - entry_price) / entry_price) * 10000.0) / 100.0
            else:
                tp_price = normalize_perp_price(entry_price * (1.0 + (tp_pct / 100.0)), self.sz_decimals)
                sl_price = normalize_perp_price(entry_price * (1.0 - (sl_pct / 100.0)), self.sz_decimals)
        elif action == "SELL":
            raw_entry = analysis["mid_price"]
            if tf == "scalp":
                if analysis["best_ask"] > 0.0:
                    raw_entry = analysis["best_ask"]
            elif tf == "swing":
                if analysis["mid_price"] > 0.0:
                    raw_entry = analysis["mid_price"] * 1.0025  # +0.25% bounce
            else:  # intraday
                if (
                    suggested_limit > 0.0
                    and analysis["best_bid"] > 0.0
                    and suggested_limit >= analysis["best_bid"]
                ):
                    raw_entry = suggested_limit
                elif analysis["best_ask"] > 0.0:
                    raw_entry = analysis["best_ask"]
            entry_price = normalize_perp_price(raw_entry, self.sz_decimals)

            if signal_type == "counter_trend" and vah_val > 0.0 and poc_val > 0.0 and entry_price > 0.0:
                target_sl = entry_price * (1.0 + (sl_pct / 100.0))
                if vah_val * 1.008 > entry_price:
                    target_sl = max(target_sl, vah_val * 1.008)
                sl_price = normalize_perp_price(target_sl, self.sz_decimals)
                if sl_price > entry_price:
                    sl_pct = round(((sl_price - entry_price) / entry_price) * 10000.0) / 100.0
                target_tp = entry_price * (1.0 - (tp_pct / 100.0))
                if 0.0 < poc_val < entry_price:
                    target_tp = min(target_tp, poc_val)
                tp_price = normalize_perp_price(target_tp, self.sz_decimals)
                if 0.0 < tp_price < entry_price:
                    tp_pct = round(((entry_price - tp_price) / entry_price) * 10000.0) / 100.0
            else:
                tp_price = normalize_perp_price(entry_price * (1.0 - (tp_pct / 100.0)), self.sz_decimals)
                sl_price = normalize_perp_price(entry_price * (1.0 + (sl_pct / 100.0)), self.sz_decimals)
        else:
            entry_price = 0.0
            tp_price = 0.0
            sl_price = 0.0
            tp_pct = 0.0
            sl_pct = 0.0
            signal_type = "neutral"

        risk_reward = 2.0
        if sl_pct > 0.0:
            risk_reward = round((tp_pct / sl_pct) * 100.0) / 100.0

        signal = {
            "coin": analysis["coin"],
            "timeframe": tf,
            "estimated_duration": estimated_duration,
            "action": action,
            "signal_type": signal_type,
            "market_environment": market_env,
            "conviction": dir_conf,
            "score": score,
            "mid_price": analysis["mid_price"],
            "entry_price": entry_price,
            "take_profit_price": tp_price,
            "stop_loss_price": sl_price,
            "take_profit_pct": tp_pct,
            "stop_loss_pct": sl_pct,
            "risk_reward_ratio": risk_reward,
            "toxic_risk": toxic_risk,
            "spread_bps": analysis["spread_bps"],
            "book_imbalance": analysis["book_imbalance"],
            "weighted_imbalance": analysis["weighted_imbalance"],
            "micro_price_drift_bps": analysis["micro_price_drift_bps"],
            "reason": reason,
            "is_toxic_halted": is_toxic_halted,
            "toxic_halt_remaining_seconds": toxic_halt_remaining_seconds,
            "timestamp": now_ms,
            "atr_pct": atr_pct,
            "macro_trend": macro_trend,
            "change_24h": change_24h,
            "vah": parse_float(volume_profile.get("vah")) if volume_profile else 0.0,
            "val": parse_float(volume_profile.get("val")) if volume_profile else 0.0,
            "poc": parse_float(volume_profile.get("poc")) if volume_profile else 0.0,
            "profile_horizon": profile_hz,
            "monthly_vah": parse_float(monthly_profile.get("vah")) if monthly_profile else (parse_float(volume_profile.get("vah")) if profile_hz == "monthly" and volume_profile else 0.0),
            "monthly_val": parse_float(monthly_profile.get("val")) if monthly_profile else (parse_float(volume_profile.get("val")) if profile_hz == "monthly" and volume_profile else 0.0),
            "monthly_poc": parse_float(monthly_profile.get("poc")) if monthly_profile else (parse_float(volume_profile.get("poc")) if profile_hz == "monthly" and volume_profile else 0.0),
            "quarterly_vah": parse_float(quarterly_profile.get("vah")) if quarterly_profile else (parse_float(volume_profile.get("vah")) if profile_hz == "quarterly" and volume_profile else 0.0),
            "quarterly_val": parse_float(quarterly_profile.get("val")) if quarterly_profile else (parse_float(volume_profile.get("val")) if profile_hz == "quarterly" and volume_profile else 0.0),
            "quarterly_poc": parse_float(quarterly_profile.get("poc")) if quarterly_profile else (parse_float(volume_profile.get("poc")) if profile_hz == "quarterly" and volume_profile else 0.0),
            "dist_from_twap_pct": parse_float(macro_extension.get("dist_from_twap_pct", macro_extension.get("dist_from_365d_pct", 0.0))) if macro_extension else 0.0,
            "dist_from_365d_pct": parse_float(macro_extension.get("dist_from_twap_pct", macro_extension.get("dist_from_365d_pct", 0.0))) if macro_extension else 0.0,
        }

        self.last_signals[state_key] = signal
        return signal
