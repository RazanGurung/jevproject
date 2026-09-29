package chartrequirements

import (
	"reflect"
	"testing"
)

func TestDefaultChartDependencyGraph(t *testing.T) {
	got := SeriesForChart(DefaultTimeframe)
	want := []SeriesRequirement{
		{Interval: "2h", LookbackMs: IndicatorStableLookbackMs},
		{Interval: "5m", LookbackMs: 20 * dayMs},
		{Interval: "30m", LookbackMs: IndicatorStableLookbackMs},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SeriesForChart(%q) = %+v, want %+v", DefaultTimeframe, got, want)
	}
}

func TestStartupTimeframesCoverCommonSwitches(t *testing.T) {
	want := []string{DefaultTimeframe, "4h", "1h", "15m"}
	if !reflect.DeepEqual(StartupTimeframes, want) {
		t.Fatalf("StartupTimeframes = %v, want %v", StartupTimeframes, want)
	}
	// First entry is the landing chart so readiness progress logs stay meaningful.
	if StartupTimeframes[0] != DefaultTimeframe {
		t.Fatalf("StartupTimeframes[0] = %q, want landing %q", StartupTimeframes[0], DefaultTimeframe)
	}
}

func TestCvdDependencyPolicy(t *testing.T) {
	for _, timeframe := range []string{"5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d"} {
		if !CvdEnabled(timeframe) {
			t.Fatalf("%s should declare composite CVD dependencies", timeframe)
		}
	}
	for _, timeframe := range []string{"1m", "1w", "1M"} {
		if CvdEnabled(timeframe) {
			t.Fatalf("%s should not declare composite CVD dependencies", timeframe)
		}
	}
}

func TestRvwapSourceIsDeepAndDoesNotGateDefaultReadiness(t *testing.T) {
	source, ok := RvwapSourceForTimeframe(DefaultTimeframe)
	if !ok {
		t.Fatal("default chart should declare an RVWAP source")
	}
	if source.Interval != "4h" || source.LookbackMs != 600*dayMs {
		t.Fatalf("RVWAP source = %+v, want 4h/600d", source)
	}
	if got := SeriesForChart(DefaultTimeframe); len(got) != 3 {
		t.Fatalf("optional RVWAP source entered readiness dependency set: %+v", got)
	}
}

func TestVisibleFourHourChartKeepsDisplayDepth(t *testing.T) {
	requirement, ok := ForTimeframe("4h")
	if !ok {
		t.Fatal("missing 4h requirement")
	}
	if requirement.LookbackMs != IndicatorStableLookbackMs {
		t.Fatalf("visible 4h lookback = %d, want 190d", requirement.LookbackMs)
	}
	if requirement.RvwapSource == nil || requirement.RvwapSource.LookbackMs != 600*dayMs {
		t.Fatalf("optional 4h RVWAP source = %+v, want 600d", requirement.RvwapSource)
	}
	series := SeriesForChart("4h")
	if len(series) != 3 || series[0].LookbackMs != IndicatorStableLookbackMs {
		t.Fatalf("4h readiness series = %+v, want display 190d plus CVD sources", series)
	}
}

func TestExtendedLookbackDeepensDefaultChartsToRetention(t *testing.T) {
	twoHour := ExtendedLookbackMs("2h")
	if twoHour != int64(UpstreamCandleCap)*IntervalMs("2h") {
		t.Fatalf("2h extended = %d, want HL-cap %d", twoHour, int64(UpstreamCandleCap)*IntervalMs("2h"))
	}
	if twoHour <= IndicatorStableLookbackMs {
		t.Fatalf("2h extended %d must exceed the 190d display lookback", twoHour)
	}
	if got := ExtendedLookbackMs("4h"); got != 600*dayMs {
		t.Fatalf("4h extended = %d, want the 600d RVWAP source", got)
	}
	if got := ExtendedLookbackMs("15m"); got != int64(UpstreamCandleCap)*IntervalMs("15m") {
		t.Fatalf("15m extended = %d, want HL cap", got)
	}
	if got := ExtendedLookbackMs("5m"); got != ReachableLookbackMs("5m", 20*dayMs) {
		t.Fatalf("5m extended = %d, want retention cap %d", got, ReachableLookbackMs("5m", 20*dayMs))
	}
	if got := ExtendedLookbackMs("30m"); got != ReachableLookbackMs("30m", IndicatorStableLookbackMs) {
		t.Fatalf("30m extended = %d, want retention cap %d", got, ReachableLookbackMs("30m", IndicatorStableLookbackMs))
	}
	if got := ExtendedLookbackMs("1w"); got != 720*dayMs {
		t.Fatalf("1w extended = %d, want declared 720d", got)
	}
}

func TestReachableLookbackClampsOverRetention(t *testing.T) {
	if got := ReachableLookbackMs("2h", IndicatorStableLookbackMs); got != IndicatorStableLookbackMs {
		t.Fatalf("2h 190d is within cap: %d", got)
	}
	if got := ReachableLookbackMs("5m", 20*dayMs); got >= 20*dayMs || got != int64(UpstreamCandleCap)*IntervalMs("5m") {
		t.Fatalf("5m 20d must clamp to 5000-bar cap, got %d", got)
	}
	if got := ReachableLookbackMs("30m", IndicatorStableLookbackMs); got >= IndicatorStableLookbackMs || got != int64(UpstreamCandleCap)*IntervalMs("30m") {
		t.Fatalf("30m 190d must clamp to 5000-bar cap, got %d", got)
	}
	if got := ReachableLookbackMs("15m", IndicatorStableLookbackMs); got >= IndicatorStableLookbackMs || got != int64(UpstreamCandleCap)*IntervalMs("15m") {
		t.Fatalf("15m 190d must clamp to 5000-bar cap, got %d", got)
	}
	if got := ReachableLookbackMs("1m", 7*dayMs); got >= 7*dayMs {
		t.Fatalf("1m 7d must clamp below declared lookback, got %d", got)
	}
}

func TestRequirementCopiesCannotMutateRegistry(t *testing.T) {
	first, ok := ForTimeframe("2h")
	if !ok {
		t.Fatal("missing 2h requirement")
	}
	first.CvdSources[0].Interval = "BROKEN"
	first.RvwapSource.Interval = "BROKEN"
	second, _ := ForTimeframe("2h")
	if second.CvdSources[0].Interval != "5m" {
		t.Fatalf("registry mutated through returned slice: %+v", second.CvdSources)
	}
	if second.RvwapSource.Interval != "4h" {
		t.Fatalf("registry RVWAP source mutated through returned pointer: %+v", second.RvwapSource)
	}
}
