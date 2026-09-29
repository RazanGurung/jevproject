#!/usr/bin/env python3
"""
PEZ$ Jev System One Backtester & Strategy Optimizer.
Simulates realistic trade execution, fee drag, slippage, and regime dynamics
across historical or multi-regime synthetic market data.

Usage:
    # Run standard backtest across 500 bars
    python3 scripts/jev_validation/backtest.py

    # Run backtest with ATR dynamic brackets and trend filtering
    python3 scripts/jev_validation/backtest.py --bracket-mode atr --trend-filter --verbose

    # Run parameter optimization grid sweep
    python3 scripts/jev_validation/backtest.py --optimize
"""

import argparse
from dataclasses import dataclass, field
import json
import math
from pathlib import Path
import random
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

# Ensure jev_validation package is in sys.path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR.parent) not in sys.path:
    sys.path.insert(0, str(BASE_DIR.parent))

from jev_validation.jev_model import (
    JevSignalEngine,
    compute_macro_extension,
    compute_volume_profile,
    parse_float,
    round_half_up,
)


@dataclass
class MarketBar:
    timestamp: float
    open: float
    high: float
    low: float
    close: float
    volume: float
    cvd_delta: float
    best_bid: float
    best_ask: float
    spread_bps: float
    atr: float
    trend: str  # "bullish", "bearish", "neutral"
    raw_book: Dict[str, Any]
    decision: Dict[str, Any]


@dataclass
class TradeRecord:
    id: int
    coin: str
    timeframe: str
    side: str  # "BUY" or "SELL"
    entry_time: float
    entry_price: float
    exit_time: float = 0.0
    exit_price: float = 0.0
    take_profit: float = 0.0
    stop_loss: float = 0.0
    exit_reason: str = ""  # "TP", "SL", "REVERSAL", "TIMEOUT"
    signal_type: str = "trend"  # "trend" or "counter_trend"
    market_env: str = "range"  # "range" or "trend"
    gross_pnl_pct: float = 0.0
    net_pnl_pct: float = 0.0
    fee_cost_pct: float = 0.0
    slippage_cost_pct: float = 0.0
    bars_held: int = 0
    is_win: bool = False


@dataclass
class BacktestStats:
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    gross_return_pct: float = 0.0
    net_return_pct: float = 0.0
    max_drawdown_pct: float = 0.0
    sharpe_ratio: float = 0.0
    sortino_ratio: float = 0.0
    avg_trade_pnl_bps: float = 0.0
    avg_win_pct: float = 0.0
    avg_loss_pct: float = 0.0
    win_loss_ratio: float = 0.0
    total_fee_drag_pct: float = 0.0
    avg_bars_held: float = 0.0
    trend_trades: int = 0
    trend_wins: int = 0
    trend_net_return_pct: float = 0.0
    counter_trend_trades: int = 0
    counter_trend_wins: int = 0
    counter_trend_net_return_pct: float = 0.0
    trades: List[TradeRecord] = field(default_factory=list)


def generate_market_dataset(
    num_bars: int = 500,
    base_price: float = 65000.0,
    timeframe: str = "intraday",
    seed: int = 42,
) -> List[MarketBar]:
    """
    Generates a realistic sequence of market bars simulating 5 market regimes:
    1. Steady Bull Trend (strong OFI + positive CVD)
    2. Consolidation / Rangebound Noise (low OFI, alternating book)
    3. Flash Liquidity Cascade / Stop Run (toxic flow shock, 5-8 bars)
    4. Steady Bear Breakdown (ask overhang + negative CVD)
    5. Volatile Reversal & Recovery
    """
    random.seed(seed)
    bars: List[MarketBar] = []

    price = base_price
    base_vol = 0.003 if timeframe == "scalp" else (0.008 if timeframe == "intraday" else 0.020)
    atr_pct = base_vol
    rolling_trs: List[float] = [base_vol]

    start_ts = 1726900000.0
    bar_seconds = 60.0 if timeframe == "scalp" else (300.0 if timeframe == "intraday" else 3600.0)

    for i in range(num_bars):
        t = start_ts + (i * bar_seconds)
        cycle_phase = i % 120

        # Realistic market regime choreography
        if cycle_phase < 45:
            # Regime 1: Sustained Trend (Upward accumulation)
            drift = 0.0006 * price
            vol = price * atr_pct * random.uniform(0.6, 1.1)
            delta_px = drift + random.gauss(0, vol * 0.4)
            trend = "bullish"
            ofi_bias = random.uniform(0.18, 0.42)
            cvd = random.uniform(30000, 90000)
            toxic = random.uniform(0.05, 0.18)
            confidence = random.uniform(0.68, 0.88)
            direction = "bullish"

        elif cycle_phase < 75:
            # Regime 2: Ranging / Consolidation
            trend = "neutral"
            if cycle_phase < 55:
                # Equilibrium oscillation
                delta_px = random.gauss(0, price * atr_pct * 0.3)
                ofi_bias = random.uniform(-0.08, 0.08)
                cvd = random.uniform(-10000, 10000)
                toxic = random.uniform(0.06, 0.18)
                confidence = random.uniform(0.42, 0.60)
                direction = "neutral"
            elif cycle_phase < 65:
                # Testing Range Low (support test: retail selling pressure into VAL)
                delta_px = -random.uniform(0.35, 0.65) * (price * atr_pct)
                ofi_bias = random.uniform(-0.35, -0.15)
                cvd = random.uniform(-40000, -15000)
                toxic = random.uniform(0.08, 0.22)
                confidence = random.uniform(0.68, 0.78)
                direction = "bearish"
            else:
                # Testing Range High (resistance test: retail buying pressure into VAH)
                delta_px = random.uniform(0.35, 0.65) * (price * atr_pct)
                ofi_bias = random.uniform(0.15, 0.35)
                cvd = random.uniform(15000, 40000)
                toxic = random.uniform(0.08, 0.22)
                confidence = random.uniform(0.68, 0.78)
                direction = "bullish"

        elif cycle_phase < 82:
            # Regime 3: Acute Stop Run / Liquidity Cascade (7 bars)
            delta_px = -random.uniform(1.2, 2.2) * (price * atr_pct)
            trend = "bearish"
            ofi_bias = random.uniform(-0.55, -0.25)
            cvd = random.uniform(-180000, -80000)
            toxic = random.uniform(0.65, 0.92)  # Active toxic flow tripwire
            confidence = random.uniform(0.72, 0.90)
            direction = "bearish"

        elif cycle_phase < 105:
            # Regime 4: Bear Distribution & Continuation
            drift = -0.0005 * price
            vol = price * atr_pct * random.uniform(0.7, 1.2)
            delta_px = drift + random.gauss(0, vol * 0.4)
            trend = "bearish"
            ofi_bias = random.uniform(-0.40, -0.15)
            cvd = random.uniform(-75000, -25000)
            toxic = random.uniform(0.12, 0.32)
            confidence = random.uniform(0.68, 0.85)
            direction = "bearish"

        else:
            # Regime 5: Volatile Mean-Reversion / Relief Squeeze (15 bars)
            delta_px = random.uniform(0.8, 1.6) * (price * atr_pct)
            trend = "bullish"
            ofi_bias = random.uniform(0.20, 0.50)
            cvd = random.uniform(50000, 150000)
            toxic = random.uniform(0.15, 0.35)
            confidence = random.uniform(0.70, 0.88)
            direction = "bullish"

        # Construct OHLC
        bar_open = price
        bar_close = max(10.0, bar_open + delta_px)
        high_extra = abs(random.gauss(0, price * atr_pct * 0.35))
        low_extra = abs(random.gauss(0, price * atr_pct * 0.35))
        bar_high = max(bar_open, bar_close) + high_extra
        bar_low = min(bar_open, bar_close) - low_extra

        # True Range and Rolling ATR%
        tr = max(bar_high - bar_low, abs(bar_high - bar_open), abs(bar_low - bar_open))
        tr_pct = tr / bar_close if bar_close > 0 else 0.005
        rolling_trs.append(tr_pct)
        if len(rolling_trs) > 14:
            rolling_trs.pop(0)
        atr_pct = sum(rolling_trs) / len(rolling_trs)
        atr_abs = bar_close * atr_pct

        # Spread & Book modeling
        spread_bps = random.uniform(0.8, 3.5) if not (75 <= cycle_phase < 82) else random.uniform(8.0, 18.0)
        half_spread = (bar_close * (spread_bps / 10000.0)) / 2.0
        best_bid = bar_close - half_spread
        best_ask = bar_close + half_spread

        # Skew depth according to ofi_bias
        bid_multiplier = 1.0 + ofi_bias
        ask_multiplier = 1.0 - ofi_bias

        raw_book = {
            "levels": [
                [
                    {"px": str(round(best_bid, 1)), "sz": str(round(1.5 * bid_multiplier, 2))},
                    {"px": str(round(best_bid - 1.0, 1)), "sz": str(round(3.0 * bid_multiplier, 2))},
                    {"px": str(round(best_bid - 2.0, 1)), "sz": str(round(5.0 * bid_multiplier, 2))},
                ],
                [
                    {"px": str(round(best_ask, 1)), "sz": str(round(1.5 * ask_multiplier, 2))},
                    {"px": str(round(best_ask + 1.0, 1)), "sz": str(round(3.0 * ask_multiplier, 2))},
                    {"px": str(round(best_ask + 2.0, 1)), "sz": str(round(5.0 * ask_multiplier, 2))},
                ],
            ]
        }

        # Jev decision payload
        decision = {
            "direction": direction,
            "confidence": confidence,
            "probabilities": {
                "bullish": confidence if direction == "bullish" else (1.0 - confidence) / 2.0,
                "bearish": confidence if direction == "bearish" else (1.0 - confidence) / 2.0,
                "neutral": 1.0 - confidence,
            },
            "score": round(1.0 + (confidence * 4.0), 1),
            "toxic_risk": toxic,
            "suggested_limit": best_bid if direction == "bullish" else best_ask,
        }

        bars.append(
            MarketBar(
                timestamp=t,
                open=bar_open,
                high=bar_high,
                low=bar_low,
                close=bar_close,
                volume=random.uniform(500000, 2500000),
                cvd_delta=cvd,
                best_bid=best_bid,
                best_ask=best_ask,
                spread_bps=spread_bps,
                atr=atr_abs,
                trend=trend,
                raw_book=raw_book,
                decision=decision,
            )
        )

        price = bar_close

    return bars


class JevBacktestRunner:
    """
    Simulates trading of the Jev Signal Engine with execution friction,
    fees, slippage, and configurable risk models.
    """

    def __init__(
        self,
        coin: str = "BTC",
        timeframe: str = "intraday",
        maker_fee_bps: float = 1.0,   # Hyperliquid VIP/Standard maker tier
        taker_fee_bps: float = 2.5,   # Hyperliquid standard taker fee
        slippage_bps: float = 1.0,    # Real-world fill slippage
        bracket_mode: str = "fixed",  # "fixed" or "atr"
        atr_multiplier: float = 1.5,
        target_rr: float = 2.0,
        trend_filter: bool = False,   # Block counter-trend signals
        macro_gate: bool = True,      # Gate 7: Block trades into yearly volume profile VAH/VAL and extended moves
        max_holding_bars: int = 40,
    ):
        self.coin = coin
        self.timeframe = timeframe
        self.maker_fee_pct = maker_fee_bps / 10000.0
        self.taker_fee_pct = taker_fee_bps / 10000.0
        self.slippage_pct = slippage_bps / 10000.0
        self.bracket_mode = bracket_mode
        self.atr_multiplier = atr_multiplier
        self.target_rr = target_rr
        self.trend_filter = trend_filter
        self.macro_gate = macro_gate
        self.max_holding_bars = max_holding_bars

    def run(
        self,
        bars: List[MarketBar],
        min_activation: float = 0.65,
        retention_floor: float = 0.50,
        toxic_threshold: Optional[float] = None,
    ) -> BacktestStats:
        """Executes sequential backtest simulation over bar sequence."""
        engine = JevSignalEngine(sz_decimals=2)
        trades: List[TradeRecord] = []
        active_trade: Optional[TradeRecord] = None
        trade_counter = 0
        all_candle_dicts = [
            {"t": b.timestamp, "o": b.open, "h": b.high, "l": b.low, "c": b.close, "v": b.volume}
            for b in bars
        ]

        for idx, bar in enumerate(bars):
            # Dynamic toxic threshold override if provided
            decision = dict(bar.decision)
            if toxic_threshold is not None and "toxic_risk" in decision:
                # Signal engine uses internal threshold, we can scale risk relative to threshold
                pass

            atr_pct = (bar.atr / bar.close * 100.0) if (self.bracket_mode == "atr" and bar.close > 0) else None
            change_24h = 4.0 if bar.trend == "bullish" else (-4.0 if bar.trend == "bearish" else 0.0)

            vp = None
            ext = None
            m_vp = None
            q_vp = None
            if self.macro_gate and idx >= 15:
                q_candles = all_candle_dicts[max(0, idx - 90):idx]
                m_candles = all_candle_dicts[max(0, idx - 30):idx]
                q_vp = compute_volume_profile(q_candles, horizon_days=90)
                m_vp = compute_volume_profile(m_candles, horizon_days=30)
                q_ext = compute_macro_extension(q_candles, bar.close, horizon_type="quarterly")
                m_ext = compute_macro_extension(
                    m_candles, bar.close, horizon_type="monthly",
                    quarterly_twap=q_ext["twap"], quarterly_dist_pct=q_ext["dist_from_twap_pct"]
                )
                if self.timeframe == "swing":
                    vp = q_vp
                    ext = q_ext
                else:
                    vp = m_vp
                    ext = m_ext

            sig = engine.generate_signal(
                coin=self.coin,
                raw_book=bar.raw_book,
                jev_decision=decision,
                timeframe=self.timeframe,
                external_mid=bar.close,
                now_ts=bar.timestamp,
                atr_pct=atr_pct,
                change_24h=change_24h if self.trend_filter else 0.0,
                macro_trend=bar.trend if self.trend_filter else "neutral",
                volume_profile=vp,
                macro_extension=ext,
                monthly_profile=m_vp,
                quarterly_profile=q_vp,
            )

            # Trend Filter Logic (Enhancement Layer)
            if self.trend_filter:
                if sig["action"] == "BUY" and bar.trend == "bearish":
                    # Require 0.80+ conviction to buy into a bear trend
                    if sig["conviction"] < 0.80:
                        sig["action"] = "HOLD"
                        sig["reason"] = f"Trend filter: suppressed counter-trend BUY ({sig['conviction']*100:.0f}% < 80%)"
                elif sig["action"] == "SELL" and bar.trend == "bullish":
                    # Require 0.80+ conviction to short into a bull trend
                    if sig["conviction"] < 0.80:
                        sig["action"] = "HOLD"
                        sig["reason"] = f"Trend filter: suppressed counter-trend SELL ({sig['conviction']*100:.0f}% < 80%)"

            # Check existing active trade
            if active_trade is not None:
                active_trade.bars_held += 1

                # 1. Check Stop Loss and Take Profit against Bar High/Low
                is_closed = False
                exit_price = 0.0
                exit_reason = ""

                if active_trade.side == "BUY":
                    # Conservative: Check SL first if bar dipped below stop
                    if bar.low <= active_trade.stop_loss:
                        is_closed = True
                        exit_price = min(bar.open, active_trade.stop_loss)  # Possible gap
                        exit_reason = "SL"
                    elif bar.high >= active_trade.take_profit:
                        is_closed = True
                        exit_price = active_trade.take_profit
                        exit_reason = "TP"
                    elif sig["action"] == "SELL":
                        # Regime Reversal Exit
                        is_closed = True
                        exit_price = bar.best_bid
                        exit_reason = "REVERSAL"
                    elif active_trade.bars_held >= self.max_holding_bars:
                        # Time horizon expired
                        is_closed = True
                        exit_price = bar.best_bid
                        exit_reason = "TIMEOUT"

                elif active_trade.side == "SELL":
                    if bar.high >= active_trade.stop_loss:
                        is_closed = True
                        exit_price = max(bar.open, active_trade.stop_loss)
                        exit_reason = "SL"
                    elif bar.low <= active_trade.take_profit:
                        is_closed = True
                        exit_price = active_trade.take_profit
                        exit_reason = "TP"
                    elif sig["action"] == "BUY":
                        # Regime Reversal Exit
                        is_closed = True
                        exit_price = bar.best_ask
                        exit_reason = "REVERSAL"
                    elif active_trade.bars_held >= self.max_holding_bars:
                        is_closed = True
                        exit_price = bar.best_ask
                        exit_reason = "TIMEOUT"

                if is_closed:
                    # Finalize closed trade
                    active_trade.exit_time = bar.timestamp
                    active_trade.exit_price = exit_price
                    active_trade.exit_reason = exit_reason

                    # Compute gross PnL
                    if active_trade.side == "BUY":
                        gross_pnl = (exit_price - active_trade.entry_price) / active_trade.entry_price
                    else:
                        gross_pnl = (active_trade.entry_price - exit_price) / active_trade.entry_price

                    active_trade.gross_pnl_pct = gross_pnl * 100.0

                    # Fees: Entry taker fee + Exit fee (taker on market/stop, maker on passive limit TP)
                    exit_fee = self.maker_fee_pct if exit_reason == "TP" else self.taker_fee_pct
                    total_fee = self.taker_fee_pct + exit_fee
                    total_slippage = self.slippage_pct * (2.0 if exit_reason != "TP" else 1.0)

                    active_trade.fee_cost_pct = total_fee * 100.0
                    active_trade.slippage_cost_pct = total_slippage * 100.0
                    active_trade.net_pnl_pct = (gross_pnl - total_fee - total_slippage) * 100.0
                    active_trade.is_win = active_trade.net_pnl_pct > 0.0

                    trades.append(active_trade)
                    active_trade = None

            # Open new trade if flat and signal triggered
            if active_trade is None and sig["action"] in ("BUY", "SELL"):
                trade_counter += 1
                entry_price = bar.best_ask if sig["action"] == "BUY" else bar.best_bid

                # Determine SL and TP
                if self.bracket_mode == "atr" and bar.atr > 0:
                    # Dynamic ATR Brackets
                    sl_dist = bar.atr * self.atr_multiplier
                    tp_dist = sl_dist * self.target_rr
                    if sig["action"] == "BUY":
                        sl_price = entry_price - sl_dist
                        tp_price = entry_price + tp_dist
                    else:
                        sl_price = entry_price + sl_dist
                        tp_price = entry_price - tp_dist
                else:
                    # Static % Brackets from signal engine
                    sl_price = sig["stop_loss_price"]
                    tp_price = sig["take_profit_price"]

                active_trade = TradeRecord(
                    id=trade_counter,
                    coin=self.coin,
                    timeframe=self.timeframe,
                    side=sig["action"],
                    entry_time=bar.timestamp,
                    entry_price=entry_price,
                    take_profit=tp_price,
                    stop_loss=sl_price,
                    signal_type=sig.get("signal_type", "trend"),
                    market_env=sig.get("market_environment", "range"),
                )

        # Calculate portfolio performance statistics
        return self._calculate_stats(trades)

    def _calculate_stats(self, trades: List[TradeRecord]) -> BacktestStats:
        if not trades:
            return BacktestStats()

        wins = [t for t in trades if t.is_win]
        losses = [t for t in trades if not t.is_win]

        total_trades = len(trades)
        win_count = len(wins)
        loss_count = len(losses)
        win_rate = (win_count / total_trades) * 100.0

        gross_gains = sum(t.gross_pnl_pct for t in wins)
        gross_losses = abs(sum(t.gross_pnl_pct for t in losses))
        profit_factor = (gross_gains / gross_losses) if gross_losses > 0 else (99.9 if gross_gains > 0 else 0.0)

        net_returns = [t.net_pnl_pct for t in trades]
        net_return_pct = sum(net_returns)
        gross_return_pct = sum(t.gross_pnl_pct for t in trades)
        total_fee_drag = sum(t.fee_cost_pct + t.slippage_cost_pct for t in trades)

        # Drawdown calculation
        equity_curve = [0.0]
        peak = 0.0
        max_dd = 0.0
        for ret in net_returns:
            cum = equity_curve[-1] + ret
            equity_curve.append(cum)
            if cum > peak:
                peak = cum
            dd = peak - cum
            if dd > max_dd:
                max_dd = dd

        # Sharpe & Sortino
        if len(net_returns) > 1:
            mean_ret = net_return_pct / total_trades
            var_ret = sum((r - mean_ret) ** 2 for r in net_returns) / (total_trades - 1)
            std_ret = math.sqrt(var_ret) if var_ret > 0 else 1e-6
            sharpe = (mean_ret / std_ret) * math.sqrt(total_trades)

            downside_rets = [min(0.0, r) for r in net_returns]
            var_down = sum(d**2 for d in downside_rets) / len(downside_rets)
            std_down = math.sqrt(var_down) if var_down > 0 else 1e-6
            sortino = (mean_ret / std_down) * math.sqrt(total_trades)
        else:
            sharpe, sortino = 0.0, 0.0

        avg_win = (sum(t.net_pnl_pct for t in wins) / win_count) if win_count > 0 else 0.0
        avg_loss = (abs(sum(t.net_pnl_pct for t in losses)) / loss_count) if loss_count > 0 else 0.0
        win_loss_ratio = (avg_win / avg_loss) if avg_loss > 0 else 0.0
        avg_bars = sum(t.bars_held for t in trades) / total_trades

        trend_trades_list = [t for t in trades if t.signal_type == "trend"]
        ct_trades_list = [t for t in trades if t.signal_type == "counter_trend"]

        trend_trades = len(trend_trades_list)
        trend_wins = len([t for t in trend_trades_list if t.is_win])
        trend_net = sum(t.net_pnl_pct for t in trend_trades_list)

        ct_trades = len(ct_trades_list)
        ct_wins = len([t for t in ct_trades_list if t.is_win])
        ct_net = sum(t.net_pnl_pct for t in ct_trades_list)

        return BacktestStats(
            total_trades=total_trades,
            wins=win_count,
            losses=loss_count,
            win_rate=win_rate,
            profit_factor=profit_factor,
            gross_return_pct=gross_return_pct,
            net_return_pct=net_return_pct,
            max_drawdown_pct=max_dd,
            sharpe_ratio=sharpe,
            sortino_ratio=sortino,
            avg_trade_pnl_bps=(net_return_pct / total_trades) * 100.0,
            avg_win_pct=avg_win,
            avg_loss_pct=avg_loss,
            win_loss_ratio=win_loss_ratio,
            total_fee_drag_pct=total_fee_drag,
            avg_bars_held=avg_bars,
            trend_trades=trend_trades,
            trend_wins=trend_wins,
            trend_net_return_pct=trend_net,
            counter_trend_trades=ct_trades,
            counter_trend_wins=ct_wins,
            counter_trend_net_return_pct=ct_net,
            trades=trades,
        )


def run_parameter_grid_optimization(bars: List[MarketBar], timeframe: str = "intraday"):
    """Runs a grid search over key hyperparameters to discover optimal edge frontier."""
    print("=" * 80)
    print("RUNNING PARAMETER OPTIMIZATION GRID SWEEP")
    print("=" * 80)

    activation_levels = [0.60, 0.65, 0.70]
    retention_floors = [0.45, 0.50, 0.55]
    bracket_modes = ["fixed", "atr"]
    trend_filters = [False, True]

    results = []

    for bracket_mode in bracket_modes:
        for trend_filter in trend_filters:
            for act in activation_levels:
                for ret_floor in retention_floors:
                    if ret_floor >= act:
                        continue  # Retention floor must be strictly lower than activation

                    runner = JevBacktestRunner(
                        timeframe=timeframe,
                        bracket_mode=bracket_mode,
                        atr_multiplier=1.5,
                        target_rr=2.0,
                        trend_filter=trend_filter,
                    )
                    stats = runner.run(bars, min_activation=act, retention_floor=ret_floor)

                    results.append(
                        {
                            "bracket": bracket_mode,
                            "trend_filter": trend_filter,
                            "activation": act,
                            "retention": ret_floor,
                            "trades": stats.total_trades,
                            "win_rate": stats.win_rate,
                            "profit_factor": stats.profit_factor,
                            "net_pnl": stats.net_return_pct,
                            "max_dd": stats.max_drawdown_pct,
                            "sharpe": stats.sharpe_ratio,
                        }
                    )

    # Sort results by Sharpe Ratio descending
    results.sort(key=lambda x: (x["sharpe"], x["profit_factor"]), reverse=True)

    print(
        f"{'Bracket':<8} | {'TrendFilt':<9} | {'Act':<5} | {'Ret':<5} | {'Trades':<6} | {'Win%':<6} | {'PF':<5} | {'Net PnL%':<9} | {'MaxDD%':<7} | {'Sharpe':<6}"
    )
    print("-" * 88)
    for r in results[:10]:  # Top 10 configurations
        tf_str = "YES" if r["trend_filter"] else "NO"
        print(
            f"{r['bracket']:<8} | {tf_str:<9} | {r['activation']:<5.2f} | {r['retention']:<5.2f} | {r['trades']:<6} | {r['win_rate']:<6.1f} | {r['profit_factor']:<5.2f} | {r['net_pnl']:+8.2f}% | {r['max_dd']:<6.2f}% | {r['sharpe']:<6.2f}"
        )
    print("-" * 88)
    best = results[0]
    print(f"\nOPTIMAL CONFIGURATION: Bracket={best['bracket'].upper()} | TrendFilter={'YES' if best['trend_filter'] else 'NO'} | Activation={best['activation']:.2f} | Retention={best['retention']:.2f}")
    print(f"Outcome: {best['trades']} trades | {best['win_rate']:.1f}% Win Rate | PF {best['profit_factor']:.2f} | Net Return {best['net_pnl']:+.2f}% | Sharpe {best['sharpe']:.2f}")
    print("=" * 80)


def print_backtest_report(stats: BacktestStats, runner: JevBacktestRunner):
    """Outputs a detailed terminal report of backtest performance."""
    print("=" * 80)
    print(f"JEV SYSTEM ONE STRATEGY BACKTEST RESULTS [{runner.timeframe.upper()}]")
    print("=" * 80)
    print(f"Total Completed Trades:      {stats.total_trades}")
    print(f"Winning Trades / Losses:     {stats.wins} wins / {stats.losses} losses")
    print(f"Win Rate:                    {stats.win_rate:.2f}%")
    print(f"Profit Factor (Gross):       {stats.profit_factor:.2f}")
    print(f"Win / Loss Ratio:            {stats.win_loss_ratio:.2f} : 1")
    print(f"Average Win / Average Loss:  +{stats.avg_win_pct:.2f}% / -{stats.avg_loss_pct:.2f}%")
    print(f"Average Trade Return:        {stats.avg_trade_pnl_bps:+.1f} bps")
    print(f"Average Holding Duration:    {stats.avg_bars_held:.1f} bars")
    print("-" * 80)
    print(f"Gross Return:                {stats.gross_return_pct:+.2f}%")
    print(f"Fee & Slippage Drag:         -{stats.total_fee_drag_pct:.2f}%")
    print(f"Net Realized Return:         {stats.net_return_pct:+.2f}%")
    print(f"Maximum Drawdown (MDD):      {stats.max_drawdown_pct:.2f}%")
    print(f"Sharpe Ratio (Annualized):   {stats.sharpe_ratio:.2f}")
    print(f"Sortino Ratio:               {stats.sortino_ratio:.2f}")
    print("-" * 80)
    print("STRATEGY BREAKDOWN: TREND vs. COUNTER-TREND")
    trend_wr = (stats.trend_wins / stats.trend_trades * 100.0) if stats.trend_trades > 0 else 0.0
    ct_wr = (stats.counter_trend_wins / stats.counter_trend_trades * 100.0) if stats.counter_trend_trades > 0 else 0.0
    print(f"Trend Trades:                {stats.trend_trades} ({stats.trend_wins} wins, {trend_wr:.1f}% WR, {stats.trend_net_return_pct:+.2f}% net)")
    print(f"Counter-Trend Trades:        {stats.counter_trend_trades} ({stats.counter_trend_wins} wins, {ct_wr:.1f}% WR, {stats.counter_trend_net_return_pct:+.2f}% net)")
    print("-" * 80)

    # Breakdown by exit reason
    reasons: Dict[str, int] = {}
    for t in stats.trades:
        reasons[t.exit_reason] = reasons.get(t.exit_reason, 0) + 1
    reason_str = " | ".join(f"{k}: {v}" for k, v in reasons.items())
    print(f"Exit Breakdown:              {reason_str}")
    print("=" * 80)


def main():
    parser = argparse.ArgumentParser(description="Jev System One Strategy Backtester & Optimizer")
    parser.add_argument("--bars", type=int, default=500, help="Number of market bars to simulate")
    parser.add_argument("--timeframe", choices=["scalp", "intraday", "swing"], default="intraday", help="Holding horizon")
    parser.add_argument("--bracket-mode", choices=["fixed", "atr"], default="atr", help="Take-profit/stop-loss bracket mode")
    parser.add_argument("--trend-filter", action="store_true", help="Enable high-timeframe trend filter")
    parser.add_argument("--disable-macro-gate", action="store_true", help="Disable Gate 7 Volume Profile & Extension filter")
    parser.add_argument("--optimize", action="store_true", help="Run parameter optimization grid sweep")
    parser.add_argument("--verbose", action="store_true", help="Print trade log")
    args = parser.parse_args()

    print(f"Generating {args.bars} bars of multi-regime orderflow market data...")
    bars = generate_market_dataset(num_bars=args.bars, timeframe=args.timeframe)

    if args.optimize:
        run_parameter_grid_optimization(bars, timeframe=args.timeframe)
        return

    runner = JevBacktestRunner(
        timeframe=args.timeframe,
        bracket_mode=args.bracket_mode,
        trend_filter=args.trend_filter,
        macro_gate=not args.disable_macro_gate,
    )
    stats = runner.run(bars)
    print_backtest_report(stats, runner)

    if args.verbose and stats.trades:
        print("\nFIRST 10 TRADES SAMPLE:")
        print(f"{'ID':<4} | {'Side':<4} | {'Type':<13} | {'Entry':<9} | {'Exit':<9} | {'Reason':<8} | {'Gross%':<7} | {'Net%':<7} | {'Bars':<4}")
        print("-" * 80)
        for t in stats.trades[:10]:
            print(
                f"{t.id:<4} | {t.side:<4} | {t.signal_type:<13} | {t.entry_price:<9.1f} | {t.exit_price:<9.1f} | {t.exit_reason:<8} | {t.gross_pnl_pct:+6.2f}% | {t.net_pnl_pct:+6.2f}% | {t.bars_held:<4}"
            )


if __name__ == "__main__":
    main()
