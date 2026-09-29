package candlecache

import (
	"context"
	"testing"
)

func TestIsCold(t *testing.T) {
	base := int64(1_700_000_000_000)
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		return []Candle{mkCandle(base, 1)}, nil
	}, 600)
	s.OnMarketWSReconnect()

	if !s.IsCold("BTC", "8h") {
		t.Fatal("unregistered series should be cold")
	}
	s.RegisterSeries("BTC", "8h", 63*dayMs)
	if !s.IsCold("BTC", "8h") {
		t.Fatal("registered-but-unwarmed series should be cold")
	}
	if err := s.preloadSeries(context.Background(), "BTC", "8h"); err != nil {
		t.Fatalf("preloadSeries: %v", err)
	}
	if s.IsCold("BTC", "8h") {
		t.Fatal("warmed series should not be cold")
	}

	// Outage safety: a warm series that goes degraded (WS down) must still
	// report not-cold so the coordinator's reconcile doesn't re-fetch it.
	s.OnMarketWSDown()
	if s.IsCold("BTC", "8h") {
		t.Fatal("warm-but-degraded series must not be reported cold")
	}
}

func TestIntervalTiers(t *testing.T) {
	deep := DeepIntervals()
	if len(deep) != 2 || deep[0] != "1w" || deep[1] != "1M" {
		t.Fatalf("DeepIntervals = %v, want [1w 1M]", deep)
	}

	core := CoreIntervals()
	for _, iv := range core {
		if iv == "1w" || iv == "1M" {
			t.Fatalf("CoreIntervals leaked deep interval %q", iv)
		}
	}

	// Core ∪ Deep must reconstruct exactly DefaultSeries (no interval dropped).
	if len(core)+len(deep) != len(DefaultSeries) {
		t.Fatalf("core(%d)+deep(%d) != DefaultSeries(%d)", len(core), len(deep), len(DefaultSeries))
	}
	seen := map[string]bool{}
	for _, iv := range append(append([]string{}, core...), deep...) {
		seen[iv] = true
	}
	for _, spec := range DefaultSeries {
		if !seen[spec.Interval] {
			t.Fatalf("interval %q missing from core+deep", spec.Interval)
		}
	}
}
