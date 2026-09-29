// Package chartrequirements is the single source of truth for chart history
// depth and indicator data dependencies. It deliberately has no infrastructure
// imports so the candle store, websocket subscription manager, and startup
// coordinator can all consume the same contract.
package chartrequirements

import "time"

const DefaultTimeframe = "2h"

// StartupTimeframes are display charts prepared before snapshot restore and
// warmed around startup. Default 2h is the /readyz admit set (plus CVD
// sources via SeriesForChart). RemainderStartupTimeframes are the coordinator's
// first post-admit display pass so common switches hit memory without
// multiplying cold-start barrier latency.
var StartupTimeframes = []string{DefaultTimeframe, "4h", "1h", "15m"}

// RemainderStartupTimeframes are the non-admit startup charts hydrated after
// /readyz. The warm coordinator owns that pass; interactive passthrough covers
// any still-cold switch.
func RemainderStartupTimeframes() []string {
	out := make([]string, 0, len(StartupTimeframes))
	for _, tf := range StartupTimeframes {
		if tf == DefaultTimeframe {
			continue
		}
		out = append(out, tf)
	}
	return out
}

type SeriesRequirement struct {
	Interval   string
	LookbackMs int64
}

type ChartRequirement struct {
	Timeframe   string
	LookbackMs  int64
	CvdSources  []SeriesRequirement
	RvwapSource *SeriesRequirement
	StartupRank int
}

const dayMs = int64(24 * time.Hour / time.Millisecond)
const rvwapSourceLookbackMs = 600 * dayMs

// IndicatorStableLookbackMs is the display window that makes default
// on-load lines and levels invariant under later prepends: 90-day viewport
// plus the 90-day CVD oscillator lookback, and six UTC months of volume
// profile POCs (~186d), plus a few days of calendar slack. Timeframes whose
// Hyperliquid 5000-candle retention is shorter (1m/5m/15m/30m) still declare
// this window; ReachableLookbackMs clamps ready/warm/hydrate/client fetches.
const IndicatorStableLookbackMs = 190 * dayMs

func rvwapSource() *SeriesRequirement {
	return &SeriesRequirement{Interval: "4h", LookbackMs: rvwapSourceLookbackMs}
}

var requirements = []ChartRequirement{
	// The visible 8h chart uses the same indicator-stable display window as
	// the other trading timeframes. RVWAP's independent 600-day source shares
	// the 4h key but is promoted only by background/interactive indicator
	// hydration; making 600 days the display requirement added minutes to the
	// readiness barrier.
	{Timeframe: "8h", LookbackMs: IndicatorStableLookbackMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 0},
	{Timeframe: "4h", LookbackMs: IndicatorStableLookbackMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 1},
	{Timeframe: "2h", LookbackMs: IndicatorStableLookbackMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 2},
	{Timeframe: "1h", LookbackMs: IndicatorStableLookbackMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 3},
	{Timeframe: "1d", LookbackMs: IndicatorStableLookbackMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 4},
	{Timeframe: "30m", LookbackMs: IndicatorStableLookbackMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 5},
	{Timeframe: "15m", LookbackMs: IndicatorStableLookbackMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 6},
	{Timeframe: "5m", LookbackMs: 20 * dayMs, CvdSources: cvdSources(), RvwapSource: rvwapSource(), StartupRank: 7},
	// 1m computes CVD from its own bars because a coarser source cannot fill
	// one-minute buckets without inventing intrabucket flow.
	{Timeframe: "1m", LookbackMs: 7 * dayMs, RvwapSource: rvwapSource(), StartupRank: 8},
	{Timeframe: "1w", LookbackMs: 720 * dayMs, RvwapSource: rvwapSource(), StartupRank: 9},
	{Timeframe: "1M", LookbackMs: 3100 * dayMs, RvwapSource: rvwapSource(), StartupRank: 10},
}

func cvdSources() []SeriesRequirement {
	return []SeriesRequirement{
		{Interval: "5m", LookbackMs: 20 * dayMs},
		{Interval: "30m", LookbackMs: IndicatorStableLookbackMs},
	}
}

// ForTimeframe returns a defensive copy of a chart's complete requirement.
func ForTimeframe(timeframe string) (ChartRequirement, bool) {
	for _, requirement := range requirements {
		if requirement.Timeframe != timeframe {
			continue
		}
		out := requirement
		out.CvdSources = append([]SeriesRequirement(nil), requirement.CvdSources...)
		if requirement.RvwapSource != nil {
			source := *requirement.RvwapSource
			out.RvwapSource = &source
		}
		return out, true
	}
	return ChartRequirement{}, false
}

// SeriesForChart expands a display timeframe into its display series followed
// by its unique indicator-source dependencies.
func SeriesForChart(timeframe string) []SeriesRequirement {
	requirement, ok := ForTimeframe(timeframe)
	if !ok {
		return nil
	}
	out := []SeriesRequirement{{Interval: requirement.Timeframe, LookbackMs: requirement.LookbackMs}}
	seen := map[string]bool{requirement.Timeframe: true}
	for _, source := range requirement.CvdSources {
		if seen[source.Interval] {
			continue
		}
		seen[source.Interval] = true
		out = append(out, source)
	}
	return out
}

// All returns defensive copies in startup-priority order.
func All() []ChartRequirement {
	out := make([]ChartRequirement, 0, len(requirements))
	for _, requirement := range requirements {
		copyRequirement, _ := ForTimeframe(requirement.Timeframe)
		out = append(out, copyRequirement)
	}
	return out
}

func CvdEnabled(timeframe string) bool {
	requirement, ok := ForTimeframe(timeframe)
	return ok && len(requirement.CvdSources) > 0
}

// RvwapSourceForTimeframe returns the optional, non-readiness-gating rolling
// VWAP source. The 4h/600d source is warmed in the normal background universe
// and activated as a client-owned feed only while an RVWAP is visible.
func RvwapSourceForTimeframe(timeframe string) (SeriesRequirement, bool) {
	requirement, ok := ForTimeframe(timeframe)
	if !ok || requirement.RvwapSource == nil {
		return SeriesRequirement{}, false
	}
	return *requirement.RvwapSource, true
}

// Hyperliquid candleSnapshot returns at most this many candles per request
// (newest first). Deeper history is not obtainable past this retention.
const UpstreamCandleCap = 5000

// IntervalMs is the nominal bucket width for a chart timeframe.
func IntervalMs(timeframe string) int64 {
	switch timeframe {
	case "1m":
		return int64(time.Minute / time.Millisecond)
	case "3m":
		return int64(3 * time.Minute / time.Millisecond)
	case "5m":
		return int64(5 * time.Minute / time.Millisecond)
	case "15m":
		return int64(15 * time.Minute / time.Millisecond)
	case "30m":
		return int64(30 * time.Minute / time.Millisecond)
	case "1h":
		return int64(time.Hour / time.Millisecond)
	case "2h":
		return int64(2 * time.Hour / time.Millisecond)
	case "4h":
		return int64(4 * time.Hour / time.Millisecond)
	case "8h":
		return int64(8 * time.Hour / time.Millisecond)
	case "12h":
		return int64(12 * time.Hour / time.Millisecond)
	case "1d":
		return dayMs
	case "1w":
		return 7 * dayMs
	case "1M":
		return 30 * dayMs
	default:
		return 0
	}
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ReachableLookbackMs is the history depth that can actually be fetched for
// an interval: the requested lookback, clamped to Hyperliquid's 5000-candle
// retention. Declared display windows (15m/30m 190d, 5m 20d, 1m 7d) exceed
// that cap; ready/warm/hydrate callers must use this instead of the raw lookback.
func ReachableLookbackMs(interval string, requestedMs int64) int64 {
	if requestedMs <= 0 {
		return requestedMs
	}
	width := IntervalMs(interval)
	if width <= 0 {
		return requestedMs
	}
	capMs := int64(UpstreamCandleCap) * width
	if capMs > 0 && capMs < requestedMs {
		return capMs
	}
	return requestedMs
}

// ExtendedLookbackMs is the post-admit background target for a series.
// Readiness still uses the display LookbackMs (fast /readyz). After restore
// the store promotes to this depth and the warm coordinator fills it on the
// shared budget so scrollback is already in memory. Never exceeds Hyperliquid
// retention (~5000 candles).
func ExtendedLookbackMs(interval string) int64 {
	requirement, ok := ForTimeframe(interval)
	if !ok {
		return 0
	}
	width := IntervalMs(interval)
	capMs := int64(0)
	if width > 0 {
		capMs = int64(UpstreamCandleCap) * width
	}
	target := requirement.LookbackMs
	if src, ok := RvwapSourceForTimeframe(interval); ok && src.Interval == interval && src.LookbackMs > target {
		target = src.LookbackMs
	}
	switch interval {
	case "2h", "1h", "15m":
		if capMs > 0 {
			target = capMs
		}
	case "8h":
		target = maxInt64(target, 730*dayMs)
	case "1d":
		target = maxInt64(target, 1000*dayMs)
	}
	return ReachableLookbackMs(interval, target)
}
