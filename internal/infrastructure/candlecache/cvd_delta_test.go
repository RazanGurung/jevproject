package candlecache

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testDayMs = int64(24 * 60 * 60 * 1000)

func inject(t *testing.T, s *Store, coin, interval string, candles []Candle) {
	t.Helper()
	s.RegisterSeries(coin, interval, 100*testDayMs)
	ser := s.getSeries(coin, interval)
	if ser == nil {
		t.Fatalf("series %s|%s not registered", coin, interval)
	}
	ser.mu.Lock()
	ser.candles = candles
	ser.coverageStartMs = candles[0].OpenMs
	ser.mu.Unlock()
}

func pct(t *testing.T, key string, c *Candle) float64 {
	t.Helper()
	if c.CvdDelta == nil {
		t.Fatalf("%s: CvdDelta is nil", key)
	}
	return *c.CvdDelta
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		return nil, fmt.Errorf("unexpected fetch in test")
	}, 400)
	s.OnMarketWSReconnect()
	return s
}

func TestComputeCvdDeltasHappyPath(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000) // clean 30m boundary

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "102", Volume: "15"},
		{OpenMs: bt + 600_000, Interval: "5m", Open: "102", Close: "103", Volume: "20"},
		{OpenMs: bt + 900_000, Interval: "5m", Open: "103", Close: "104", Volume: "25"},
		{OpenMs: bt + 1_200_000, Interval: "5m", Open: "104", Close: "105", Volume: "30"},
		{OpenMs: bt + 1_500_000, Interval: "5m", Open: "105", Close: "106", Volume: "35"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
		{OpenMs: bt, Interval: "30m", Open: "100", Close: "106", Volume: "135"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: ""},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if len(result) != 1 {
		t.Fatalf("expected 1 candle, got %d", len(result))
	}
	// seam = ceil(bt / 1_800_000) * 1_800_000 = bt
	// 30m with OpenMs < seam: bt-1_800_000 only — but that bar is BEFORE bt,
	// so excluded from the chart bucket [bt, bt+1h).
	// 5m with OpenMs >= seam: all 6 → +10+15+20+25+30+35 = 135
	got := pct(t, "cvdDelta", &result[0])
	if got != 135 {
		t.Fatalf("expected cvdDelta=135, got %v", got)
	}
}

func TestComputeCvdDeltasMixedCloseOpen(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "99", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "99", Close: "102", Volume: "15"},
		{OpenMs: bt + 600_000, Interval: "5m", Open: "102", Close: "102", Volume: "20"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: ""},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if len(result) != 1 {
		t.Fatalf("expected 1 candle, got %d", len(result))
	}
	// 30m bar at bt-1_800_000 is before chart start, excluded.
	// 5m: bearish(-10) + bullish(+15) + doji(0) = 5
	got := pct(t, "cvdDelta", &result[0])
	if got != 5 {
		t.Fatalf("expected cvdDelta=5, got %v", got)
	}
}

func TestComputeCvdDeltasPartialOverlap(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "102", Volume: "15"},
		{OpenMs: bt + 600_000, Interval: "5m", Open: "102", Close: "103", Volume: "20"},
		{OpenMs: bt + 900_000, Interval: "5m", Open: "103", Close: "104", Volume: "25"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	chart := []Candle{
		{OpenMs: bt, Interval: "15m", Open: "100", Close: "", Volume: ""},
		{OpenMs: bt + 900_000, Interval: "15m", Open: "102", Close: "", Volume: ""},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if len(result) != 2 {
		t.Fatalf("expected 2 candles, got %d", len(result))
	}
	// seam = bt. 30m before seam: bt-1_800_000 (+50)
	// 5m >= seam: all 4
	// Source = [+50, +10, +15, +20, +25]
	// Bucket 0 [bt, bt+900k): +10+15+20 = 45
	// Bucket 1 [bt+900k, bt+1_800_000): +25 = 25
	got0 := pct(t, "bucket0", &result[0])
	if got0 != 45 {
		t.Fatalf("expected bucket0 cvdDelta=45, got %v", got0)
	}
	got1 := pct(t, "bucket1", &result[1])
	if got1 != 25 {
		t.Fatalf("expected bucket1 cvdDelta=25, got %v", got1)
	}
}

func TestComputeCvdDeltasNoSourceReturnsNil(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)
	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: ""},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if result[0].CvdDelta != nil {
		t.Fatal("expected nil CvdDelta when source series missing")
	}
}

func TestComputeCvdDeltasSkipsNonEnrichableIntervals(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)
	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "102", Volume: "15"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	// 1m must never inherit composite 5m volume even when sources are warm.
	oneMin := []Candle{
		{OpenMs: bt, Interval: "1m", Open: "100", Close: "100.5", Volume: "1"},
	}
	result := s.ComputeCvdDeltas("TEST", oneMin)
	if result[0].CvdDelta != nil {
		t.Fatalf("expected nil cvdDelta for 1m, got %v", *result[0].CvdDelta)
	}

	for _, interval := range []string{"1w", "1M"} {
		chart := []Candle{{OpenMs: bt, Interval: interval, Open: "100", Close: "101", Volume: "10"}}
		result = s.ComputeCvdDeltas("TEST", chart)
		if result[0].CvdDelta != nil {
			t.Fatalf("expected nil cvdDelta for %s, got %v", interval, *result[0].CvdDelta)
		}
	}
}

func TestComputeCvdDeltasGappedDeepStillEnrichesPostSeam(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	// Aligned 5m at bt → seam = bt. Pre-seam needs 30m; post-seam needs only 5m.
	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "102", Volume: "15"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	ser := s.getSeries("TEST", "30m")
	ser.mu.Lock()
	ser.unverifiedGapFromMs = bt - 1_800_000
	ser.mu.Unlock()

	// Pre-seam bucket must stay nil without a healthy 30m leg.
	preSeam := []Candle{{OpenMs: bt - 3_600_000, Interval: "1h", Open: "90", Close: "95", Volume: "50"}}
	pre := s.ComputeCvdDeltas("TEST", preSeam)
	if pre[0].CvdDelta != nil {
		t.Fatalf("expected nil pre-seam cvdDelta when 30m is gapped, got %v", *pre[0].CvdDelta)
	}

	// Post-seam bucket must still enrich from 5m alone.
	postSeam := []Candle{{OpenMs: bt, Interval: "1h", Open: "100", Close: "102", Volume: "25"}}
	post := s.ComputeCvdDeltas("TEST", postSeam)
	got := pct(t, "post-seam with gapped deep", &post[0])
	if got != 25 {
		t.Fatalf("expected post-seam cvdDelta=25 from 5m only, got %v", got)
	}
}

func TestComputeCvdDeltasEmptyCoinReturnsInput(t *testing.T) {
	s := newTestStore(t)
	chart := []Candle{
		{OpenMs: 1000, Interval: "1h", Open: "100", Close: "", Volume: ""},
	}
	result := s.ComputeCvdDeltas("", chart)
	if result[0].CvdDelta != nil {
		t.Fatal("expected nil CvdDelta for empty coin")
	}
}

func TestComputeCvdDeltasEmptyChart(t *testing.T) {
	s := newTestStore(t)
	result := s.ComputeCvdDeltas("TEST", nil)
	if result != nil {
		t.Fatal("expected nil for nil chart input")
	}
}

func TestComputeCvdDeltasDeepStitch(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	// 5m series starts 10 minutes after bt
	fiveM := []Candle{
		{OpenMs: bt + 600_000, Interval: "5m", Open: "100", Close: "105", Volume: "20"},
		{OpenMs: bt + 900_000, Interval: "5m", Open: "105", Close: "106", Volume: "10"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "90", Close: "100", Volume: "100"},
		{OpenMs: bt, Interval: "30m", Open: "100", Close: "106", Volume: "30"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: ""},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if len(result) != 1 {
		t.Fatalf("expected 1 candle, got %d", len(result))
	}
	// firstRecent = bt+600_000
	// seam = ceil((bt+600_000)/1_800_000)*1_800_000 = bt+1_800_000
	// 30m < seam: bt-1_800_000, bt → both in source
	// 5m >= seam: none (both at 600k/900k are < seam)
	// Source = [30m at bt-1_800_000 (+100), 30m at bt (+30)]
	// Scan for [bt, bt+1h): advance past source[0] (< bt), include source[1] (=bt) → +30
	got := pct(t, "cvdDelta", &result[0])
	if got != 30 {
		t.Fatalf("expected cvdDelta=30, got %v", got)
	}
}

func TestDirectionalDelta(t *testing.T) {
	tests := []struct {
		name string
		c    Candle
		want float64
	}{
		{"bullish", Candle{Open: "100", Close: "105", Volume: "10"}, 10},
		{"bearish", Candle{Open: "105", Close: "100", Volume: "10"}, -10},
		{"doji", Candle{Open: "100", Close: "100", Volume: "10"}, 0},
		{"zero-vol", Candle{Open: "100", Close: "105", Volume: "0"}, 0},
		{"bad-open", Candle{Open: "abc", Close: "105", Volume: "10"}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := directionalDelta(tt.c)
			if got != tt.want {
				t.Fatalf("directionalDelta(%s) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestComputeCvdDeltasDegradedSourceLeavesNil(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "102", Volume: "8"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	ser := s.getSeries("TEST", "5m")
	ser.mu.Lock()
	ser.degraded = true
	ser.mu.Unlock()

	tail := []Candle{
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "", Volume: "8"},
	}
	if result := s.ComputeCvdDeltas("TEST", tail); result[0].CvdDelta != nil {
		t.Fatal("expected nil CvdDelta for the untrusted live tail while degraded")
	}

	closed := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "", Volume: "10"},
	}
	closedResult := s.ComputeCvdDeltas("TEST", closed)
	if closedResult[0].CvdDelta == nil {
		t.Fatal("closed historical buckets must still enrich while only the live tail is untrusted")
	}
}

func TestComputeCvdDeltasGappedDeepSourceLeavesNil(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	// 5m starts 10 minutes after bt → seam = bt+1_800_000, so a chart bucket
	// at bt consults the 30m source — which carries an unverified gap.
	fiveM := []Candle{
		{OpenMs: bt + 600_000, Interval: "5m", Open: "100", Close: "105", Volume: "20"},
	}
	thirtyM := []Candle{
		{OpenMs: bt, Interval: "30m", Open: "100", Close: "106", Volume: "30"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	ser := s.getSeries("TEST", "30m")
	ser.mu.Lock()
	ser.unverifiedGapFromMs = bt
	ser.mu.Unlock()

	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: "30"},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if result[0].CvdDelta != nil {
		t.Fatal("expected nil CvdDelta when the 30m source has an unverified gap")
	}
}

func TestComputeCvdDeltasOutsideCoverageLeavesNil(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "102", Volume: "15"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	// seam = bt (aligned); composite coverage runs from the 30m first bar
	// (bt-1_800_000) to the last 5m open + 5m (bt+600_000). Buckets are
	// contiguous: a hole would legitimately absorb source bars up to the
	// next candle's open (thin-market bucket-skip semantics).
	chart := []Candle{
		{OpenMs: bt - 7_200_000, Interval: "1h", Open: "90", Close: "", Volume: "5"},
		{OpenMs: bt - 3_600_000, Interval: "1h", Open: "95", Close: "", Volume: "50"},
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: "25"},
		{OpenMs: bt + 3_600_000, Interval: "1h", Open: "102", Close: "", Volume: "5"},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if result[0].CvdDelta != nil {
		t.Fatal("expected nil CvdDelta for a bucket before source coverage")
	}
	// Bucket [bt-1h, bt) straddles the coverage start (30m first bar is at
	// bt-30m): only half the hour is summable, so it must stay nil rather
	// than serve a truncated delta.
	if result[1].CvdDelta != nil {
		t.Fatalf("expected nil CvdDelta for the bucket straddling coverage start, got %v", *result[1].CvdDelta)
	}
	got := pct(t, "in-coverage bucket", &result[2])
	if got != 25 {
		t.Fatalf("expected cvdDelta=25, got %v", got)
	}
	if result[3].CvdDelta != nil {
		t.Fatal("expected nil CvdDelta for a bucket after source coverage")
	}
}

func TestComputeCvdDeltasTradedBucketWithoutSourceBarsLeavesNil(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	// A hole between the 5m bars (no gap marker — the stale/hole signature).
	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 1_500_000, Interval: "5m", Open: "104", Close: "105", Volume: "30"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	chart := []Candle{
		// Traded bucket over the hole: must stay nil, not report 0.
		{OpenMs: bt + 300_000, Interval: "15m", Open: "101", Close: "", Volume: "5"},
		// Untraded bucket over the hole: 0 is honest.
		{OpenMs: bt + 600_000, Interval: "15m", Open: "101", Close: "", Volume: ""},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if result[0].CvdDelta != nil {
		t.Fatal("expected nil CvdDelta for a traded bucket with no covering source bars")
	}
	got := pct(t, "untraded bucket", &result[1])
	if got != 0 {
		t.Fatalf("expected cvdDelta=0 for untraded bucket, got %v", got)
	}
}

func TestCvdDeltaForBucket(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "100", Volume: "15"},
		{OpenMs: bt + 600_000, Interval: "5m", Open: "100", Close: "103", Volume: "20"},
	}
	inject(t, s, "TEST", "5m", fiveM)

	delta, ok := s.CvdDeltaForBucket("TEST", bt, bt+3_600_000)
	if !ok {
		t.Fatal("expected ok for covered live bucket")
	}
	if delta != 15 { // +10 -15 +20
		t.Fatalf("expected delta=15, got %v", delta)
	}

	if _, ok := s.CvdDeltaForBucket("TEST", bt+3_600_000, bt+7_200_000); ok {
		t.Fatal("expected !ok for bucket beyond the source tail")
	}
	if _, ok := s.CvdDeltaForBucket("MISSING", bt, bt+3_600_000); ok {
		t.Fatal("expected !ok for unknown coin")
	}

	ser := s.getSeries("TEST", "5m")
	ser.mu.Lock()
	ser.degraded = true
	ser.mu.Unlock()
	if _, ok := s.CvdDeltaForBucket("TEST", bt+600_000, bt+900_000); ok {
		t.Fatal("expected !ok for the untrusted live tail while degraded")
	}
	delta, ok = s.CvdDeltaForBucket("TEST", bt, bt+600_000)
	if !ok || delta != -5 {
		t.Fatalf("closed source bars must still enrich while degraded, got %v ok=%v", delta, ok)
	}
}

func TestCvdDeltaForBucketPreSeam(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	// 5m starts mid-30m-bucket → seam = bt+1_800_000; pre-seam buckets
	// belong to the 30m side of the composite and are declined here.
	fiveM := []Candle{
		{OpenMs: bt + 600_000, Interval: "5m", Open: "100", Close: "105", Volume: "20"},
		{OpenMs: bt + 1_800_000, Interval: "5m", Open: "105", Close: "106", Volume: "10"},
	}
	inject(t, s, "TEST", "5m", fiveM)

	if _, ok := s.CvdDeltaForBucket("TEST", bt+600_000, bt+900_000); ok {
		t.Fatal("expected !ok for a pre-seam bucket")
	}
	delta, ok := s.CvdDeltaForBucket("TEST", bt+1_800_000, bt+2_100_000)
	if !ok || delta != 10 {
		t.Fatalf("expected post-seam delta=10 ok, got %v ok=%v", delta, ok)
	}
}

func TestAnnotateWSCandle(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "102", Volume: "15"},
	}
	inject(t, s, "TEST", "5m", fiveM)

	wsMsg := map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(bt), "T": float64(bt + 3_600_000),
			"s": "TEST", "i": "1h",
			"o": "100", "c": "102", "h": "103", "l": "99", "v": "25", "n": float64(7),
		},
	}
	raw := []byte(`{"channel":"candle"}`)
	out := s.AnnotateWSCandle(wsMsg, raw)
	if !strings.Contains(string(out), `"cvdDelta":25`) {
		t.Fatalf("expected spliced cvdDelta=25, got %s", out)
	}

	// Unknown coin: forwarded bytes unchanged.
	wsMsg2 := map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(bt), "s": "MISSING", "i": "1h",
			"o": "100", "c": "102", "v": "25",
		},
	}
	if out := s.AnnotateWSCandle(wsMsg2, raw); string(out) != string(raw) {
		t.Fatalf("expected raw passthrough for unknown coin, got %s", out)
	}
}

func TestAnnotateWSCandleSkipsNonCvdTimeframes(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)
	inject(t, s, "TEST", "5m", []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "50"},
	})
	raw := []byte(`{"channel":"candle"}`)

	for _, interval := range []string{"1m", "1w", "1M"} {
		wsMsg := map[string]interface{}{
			"channel": "candle",
			"data": map[string]interface{}{
				"t": float64(bt), "T": float64(bt + 60_000),
				"s": "TEST", "i": interval,
				"o": "100", "c": "101", "h": "101", "l": "100", "v": "1", "n": float64(1),
			},
		}
		if out := s.AnnotateWSCandle(wsMsg, raw); string(out) != string(raw) {
			t.Fatalf("expected raw passthrough for %s, got %s", interval, out)
		}
	}
}

func TestWarmOnDemandSubscribesCvdSources(t *testing.T) {
	bt := int64(1_700_001_000_000)
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		return []Candle{{OpenMs: bt, Symbol: coin, Interval: interval, Open: "1", Close: "2", Volume: "1"}}, nil
	}, 4000)
	s.OnMarketWSReconnect()

	var mu sync.Mutex
	registered := map[string]bool{}
	s.SetOnRegister(func(coin, interval string) {
		mu.Lock()
		registered[coin+"|"+interval] = true
		mu.Unlock()
	})

	s.WarmOnDemand("NEW", "1h")

	mu.Lock()
	defer mu.Unlock()
	for _, key := range []string{"NEW|1h", "NEW|5m", "NEW|30m"} {
		if !registered[key] {
			t.Fatalf("expected onRegister (WS subscription) for %s; got %v", key, registered)
		}
	}
}

func TestPrepareChartRequirementsRegistersDefaultDependencySet(t *testing.T) {
	s := New(func(context.Context, string, string, int64, int64) ([]Candle, error) {
		return nil, nil
	}, 4000)
	var registered []string
	s.SetOnRegister(func(coin, interval string) {
		registered = append(registered, coin+"|"+interval)
	})

	s.PrepareChartRequirements("BTC", "2h")

	want := []string{"BTC|2h", "BTC|5m", "BTC|30m"}
	if !reflect.DeepEqual(registered, want) {
		t.Fatalf("registered = %v, want startup-priority order %v", registered, want)
	}
	for _, interval := range []string{"2h", "5m", "30m"} {
		if s.getSeries("BTC", interval) == nil {
			t.Fatalf("missing prepared BTC %s dependency", interval)
		}
	}
}

func TestCoveredDisplayWarmStillRepairsDegradedCvdSources(t *testing.T) {
	now := time.Now().UnixMilli()
	var mu sync.Mutex
	fetched := map[string]int{}
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		mu.Lock()
		fetched[interval]++
		mu.Unlock()
		return []Candle{{
			OpenMs: endMs - intervalMs(interval), Symbol: coin, Interval: interval,
			Open: "1", Close: "2", Volume: "1",
		}}, nil
	}, 1_000_000)
	s.OnMarketWSReconnect()
	s.RegisterSeries("BTC", "2h", lookbackForInterval("2h"))
	s.PrepareChartRequirements("BTC", "2h")

	seed := func(interval string, degraded bool) {
		ser := s.getSeries("BTC", interval)
		ser.mu.Lock()
		ser.coverageStartMs = now - ser.lookbackMs - 1
		ser.candles = []Candle{{
			OpenMs: now - ser.intervalMs, Symbol: "BTC", Interval: interval,
			Open: "1", Close: "2", Volume: "1",
		}}
		ser.degraded = degraded
		ser.mu.Unlock()
	}
	seed("2h", false)
	seed("5m", true)
	seed("30m", true)

	s.WarmOnDemand("BTC", "2h")
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		recentCalls, deepCalls, displayCalls := fetched["5m"], fetched["30m"], fetched["2h"]
		mu.Unlock()
		if recentCalls > 0 && deepCalls > 0 {
			if displayCalls != 0 {
				t.Fatalf("covered display series refetched %d time(s)", displayCalls)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("covered display warm did not repair both sources: 5m=%d 30m=%d 2h=%d", recentCalls, deepCalls, displayCalls)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestMergePassthroughSubscribesCvdSources(t *testing.T) {
	s := newTestStore(t)

	var mu sync.Mutex
	registered := map[string]bool{}
	s.SetOnRegister(func(coin, interval string) {
		mu.Lock()
		registered[coin+"|"+interval] = true
		mu.Unlock()
	})

	now := int64(1_700_001_000_000)
	body := map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "NEW", "interval": "1h",
			"startTime": float64(now - 3_600_000), "endTime": float64(now),
		},
	}
	s.MergePassthrough(body, []byte(`[]`))

	mu.Lock()
	defer mu.Unlock()
	for _, key := range []string{"NEW|1h", "NEW|5m", "NEW|30m"} {
		if !registered[key] {
			t.Fatalf("expected onRegister (WS subscription) for %s; got %v", key, registered)
		}
	}
}

func TestMarshalCandleCvdDelta(t *testing.T) {
	delta := 123.45
	c := Candle{
		OpenMs:   1000,
		CloseMs:  2000,
		Symbol:   "TEST",
		Interval: "1h",
		Open:     "100",
		Close:    "105",
		High:     "106",
		Low:      "99",
		Volume:   "10",
		Trades:   42,
		CvdDelta: &delta,
	}

	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	if !strings.Contains(got, `"cvdDelta":123.45`) {
		t.Fatalf("expected cvdDelta in JSON: %s", got)
	}

	c.CvdDelta = nil
	b, err = json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	got = string(b)
	if strings.Contains(got, "cvdDelta") {
		t.Fatalf("unexpected cvdDelta in JSON with omitempty: %s", got)
	}
}

// mkBars builds count directional bars at stepMs spacing with a deterministic
// up/down and volume pattern, for property-style tests.
func mkBars(startMs, stepMs int64, count int, interval string) []Candle {
	bars := make([]Candle, count)
	for i := range bars {
		open := 100 + float64(i%5)
		close := open + 1
		if i%3 == 2 {
			close = open - 1
		}
		vol := float64(1 + i%7)
		bars[i] = Candle{
			OpenMs:   startMs + int64(i)*stepMs,
			Interval: interval,
			Open:     strconv.FormatFloat(open, 'f', -1, 64),
			Close:    strconv.FormatFloat(close, 'f', -1, 64),
			Volume:   strconv.FormatFloat(vol, 'f', -1, 64),
		}
	}
	return bars
}

// sumDeltas sums directionalDelta over source bars opening in [fromMs, toMs).
func sumDeltas(bars []Candle, fromMs, toMs int64) float64 {
	var total float64
	for _, c := range bars {
		if c.OpenMs >= fromMs && c.OpenMs < toMs {
			total += directionalDelta(c)
		}
	}
	return total
}

// mkChart builds a contiguous display series of traded bars.
func mkChart(startMs, stepMs int64, count int, interval string) []Candle {
	bars := make([]Candle, count)
	for i := range bars {
		bars[i] = Candle{OpenMs: startMs + int64(i)*stepMs, Interval: interval, Open: "100", Close: "101", Volume: "1"}
	}
	return bars
}

// TestComputeCvdDeltasCrossTimeframeIdentity is the keystone cross-timeframe
// property: over a fully covered range, every display timeframe's bucket delta
// equals the sum of the composite source's deltas under it — so any higher-TF
// bucket equals the sum of its covering lower-TF buckets.
func TestComputeCvdDeltasCrossTimeframeIdentity(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000) // 30m-aligned

	const halfDayMs = 12 * 3_600_000
	fiveM := mkBars(bt, 300_000, 144, "5m")               // [bt, bt+12h)
	thirtyM := mkBars(bt-halfDayMs, 1_800_000, 48, "30m") // [bt-12h, bt+12h)
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)
	// seam = bt (5m first bar is 30m-aligned): post-seam composite is the 5m
	// series; pre-seam composite is the 30m series.

	postSeam := []struct {
		interval string
		stepMs   int64
	}{
		{"5m", 300_000}, {"15m", 900_000}, {"30m", 1_800_000}, {"1h", 3_600_000}, {"4h", 14_400_000},
	}
	deltasByTF := map[string][]Candle{}
	for _, tf := range postSeam {
		chart := mkChart(bt, tf.stepMs, int(halfDayMs/tf.stepMs), tf.interval)
		result := s.ComputeCvdDeltas("TEST", chart)
		for i := range result {
			key := fmt.Sprintf("%s bucket %d", tf.interval, i)
			got := pct(t, key, &result[i])
			end := result[i].OpenMs + tf.stepMs
			want := sumDeltas(fiveM, result[i].OpenMs, end)
			if got != want {
				t.Fatalf("%s: delta=%v, want composite sum %v", key, got, want)
			}
		}
		deltasByTF[tf.interval] = result
	}
	// Explicit pairwise identity: each 4h bucket == sum of its 15m buckets.
	for _, hi := range deltasByTF["4h"] {
		var sum float64
		for _, lo := range deltasByTF["15m"] {
			if lo.OpenMs >= hi.OpenMs && lo.OpenMs < hi.OpenMs+14_400_000 {
				sum += *lo.CvdDelta
			}
		}
		if *hi.CvdDelta != sum {
			t.Fatalf("4h bucket at %d: delta=%v, want 15m sum %v", hi.OpenMs, *hi.CvdDelta, sum)
		}
	}

	// Pre-seam: display TFs >= the 30m source granularity hold the same
	// identity against the 30m leg.
	preSeam := []struct {
		interval string
		stepMs   int64
	}{
		{"30m", 1_800_000}, {"1h", 3_600_000}, {"4h", 14_400_000},
	}
	for _, tf := range preSeam {
		chart := mkChart(bt-halfDayMs, tf.stepMs, int(halfDayMs/tf.stepMs), tf.interval)
		result := s.ComputeCvdDeltas("TEST", chart)
		for i := range result {
			key := fmt.Sprintf("pre-seam %s bucket %d", tf.interval, i)
			got := pct(t, key, &result[i])
			end := result[i].OpenMs + tf.stepMs
			want := sumDeltas(thirtyM, result[i].OpenMs, end)
			if got != want {
				t.Fatalf("%s: delta=%v, want composite sum %v", key, got, want)
			}
		}
	}
}

// TestComputeCvdDeltasPartialCoverageFirstBucketIsNil pins the coverage-edge
// rule: a display bucket that straddles the start of composite coverage
// (open < sourceStart < end) can only be partially summed, and a partial sum
// served as the bucket's delta is confidently wrong — it must stay nil so the
// client falls back honestly.
func TestComputeCvdDeltasPartialCoverageFirstBucketIsNil(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	// Deep coverage starts mid-1h-bucket at bt+30m; 5m starts at bt+2h.
	thirtyM := []Candle{
		{OpenMs: bt + 1_800_000, Interval: "30m", Open: "100", Close: "105", Volume: "50"},
		{OpenMs: bt + 3_600_000, Interval: "30m", Open: "105", Close: "106", Volume: "20"},
		{OpenMs: bt + 5_400_000, Interval: "30m", Open: "106", Close: "104", Volume: "10"},
	}
	fiveM := []Candle{
		{OpenMs: bt + 7_200_000, Interval: "5m", Open: "104", Close: "105", Volume: "5"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: "60"},
		{OpenMs: bt + 3_600_000, Interval: "1h", Open: "105", Close: "", Volume: "30"},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	if result[0].CvdDelta != nil {
		t.Fatalf("expected nil CvdDelta for the bucket straddling coverage start, got %v", *result[0].CvdDelta)
	}
	got := pct(t, "fully covered bucket", &result[1])
	if got != 10 { // +20 - 10
		t.Fatalf("expected cvdDelta=10, got %v", got)
	}
}

// TestComputeCvdDeltasPreSeamSubSourceBucketsAreNil pins the pre-seam
// granularity rule: before the seam the composite has only 30m resolution, so
// a 5m/15m display bucket cannot be honestly summed — the 30m-boundary bucket
// would lump the whole 30m delta while its siblings fall back, double-counting
// the half hour on the client. All pre-seam sub-30m buckets must stay nil.
func TestComputeCvdDeltasPreSeamSubSourceBucketsAreNil(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	thirtyM := []Candle{
		{OpenMs: bt, Interval: "30m", Open: "100", Close: "105", Volume: "50"},
		{OpenMs: bt + 1_800_000, Interval: "30m", Open: "105", Close: "106", Volume: "30"},
	}
	// 5m starts at bt+1h → seam = bt+1h; everything before is 30m-only.
	fiveM := []Candle{
		{OpenMs: bt + 3_600_000, Interval: "5m", Open: "106", Close: "107", Volume: "5"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	fiveChart := mkChart(bt, 300_000, 6, "5m") // [bt, bt+30m) pre-seam
	result := s.ComputeCvdDeltas("TEST", fiveChart)
	for i := range result {
		if result[i].CvdDelta != nil {
			t.Fatalf("expected nil CvdDelta for pre-seam 5m bucket %d, got %v", i, *result[i].CvdDelta)
		}
	}

	fifteenChart := mkChart(bt, 900_000, 2, "15m")
	result = s.ComputeCvdDeltas("TEST", fifteenChart)
	for i := range result {
		if result[i].CvdDelta != nil {
			t.Fatalf("expected nil CvdDelta for pre-seam 15m bucket %d, got %v", i, *result[i].CvdDelta)
		}
	}

	// 30m display matches the source granularity and stays enriched.
	thirtyChart := mkChart(bt, 1_800_000, 2, "30m")
	result = s.ComputeCvdDeltas("TEST", thirtyChart)
	if got := pct(t, "pre-seam 30m bucket 0", &result[0]); got != 50 {
		t.Fatalf("expected cvdDelta=50, got %v", got)
	}
	if got := pct(t, "pre-seam 30m bucket 1", &result[1]); got != 30 {
		t.Fatalf("expected cvdDelta=30, got %v", got)
	}
}

// TestCvdSeamUnalignedFirstRecentBar pins the seam partition when the 5m
// series starts mid-30m-bucket: the unaligned leading 5m bars are excluded
// (their half hour is covered by the 30m bar), and the 30m bar at the seam is
// excluded (covered by 5m bars) — no hole, no double count.
func TestCvdSeamUnalignedFirstRecentBar(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	// 5m starts at bt+10m → seam rounds up to bt+30m.
	fiveM := []Candle{
		{OpenMs: bt + 600_000, Interval: "5m", Open: "100", Close: "101", Volume: "7"},    // pre-seam: excluded
		{OpenMs: bt + 900_000, Interval: "5m", Open: "101", Close: "102", Volume: "9"},    // pre-seam: excluded
		{OpenMs: bt + 1_800_000, Interval: "5m", Open: "102", Close: "103", Volume: "11"}, // post-seam
		{OpenMs: bt + 2_100_000, Interval: "5m", Open: "103", Close: "101", Volume: "13"}, // post-seam
	}
	thirtyM := []Candle{
		{OpenMs: bt, Interval: "30m", Open: "100", Close: "102", Volume: "40"},             // pre-seam: included
		{OpenMs: bt + 1_800_000, Interval: "30m", Open: "102", Close: "101", Volume: "24"}, // at seam: excluded
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: "64"},
	}
	result := s.ComputeCvdDeltas("TEST", chart)
	// 30m@bt (+40) + 5m post-seam (+11, -13) = 38. The excluded legs would
	// have double-counted (+7+9 from 5m, -24 from the seam 30m bar).
	got := pct(t, "seam bucket", &result[0])
	if got != 38 {
		t.Fatalf("expected cvdDelta=38, got %v", got)
	}
}

// TestAnnotateWSCandleMatchesSnapshotTail pins WS-vs-snapshot consistency: the
// delta AnnotateWSCandle splices into a live display-TF tick mid-bucket equals
// what ComputeCvdDeltas serves for the same tail bucket, after the 5m tick
// itself was merged via ApplyWSCandle.
func TestAnnotateWSCandleMatchesSnapshotTail(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10", Trades: 3},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "100", Volume: "15", Trades: 4},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	// A live 5m tick extends the source before the display tick is annotated
	// (the ApplyWSCandle-then-AnnotateWSCandle call order in market_ws).
	s.ApplyWSCandle(map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(bt + 600_000), "T": float64(bt + 900_000),
			"s": "TEST", "i": "5m",
			"o": "100", "c": "103", "h": "103", "l": "100", "v": "20", "n": float64(5),
		},
	})

	wsMsg := map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(bt), "T": float64(bt + 3_600_000),
			"s": "TEST", "i": "1h",
			"o": "100", "c": "103", "h": "103", "l": "100", "v": "45", "n": float64(12),
		},
	}
	out := s.AnnotateWSCandle(wsMsg, []byte(`{"channel":"candle"}`))
	var decoded struct {
		Data struct {
			CvdDelta *float64 `json:"cvdDelta"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Data.CvdDelta == nil {
		t.Fatalf("expected spliced cvdDelta, got %s", out)
	}

	chart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "103", Volume: "45"},
	}
	snapshot := pct(t, "snapshot tail bucket", &s.ComputeCvdDeltas("TEST", chart)[0])
	if *decoded.Data.CvdDelta != snapshot {
		t.Fatalf("WS delta %v != snapshot delta %v for the same bucket", *decoded.Data.CvdDelta, snapshot)
	}
	if snapshot != 15 { // +10 -15 +20
		t.Fatalf("expected delta=15, got %v", snapshot)
	}
}

// TestComputeCvdDeltasDisplayHoleConservation pins the bucketEndMs semantics:
// when the display series skips a bucket (thin market), the preceding bar
// absorbs the hole's source deltas — per-bar surprising but cumulative-
// conserving, so totals still match across timeframes.
func TestComputeCvdDeltasDisplayHoleConservation(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := mkBars(bt, 300_000, 36, "5m") // [bt, bt+3h)
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	holey := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: "1"},
		// hole at bt+1h
		{OpenMs: bt + 7_200_000, Interval: "1h", Open: "102", Close: "", Volume: "1"},
	}
	result := s.ComputeCvdDeltas("TEST", holey)
	got0 := pct(t, "bucket absorbing the hole", &result[0])
	if want := sumDeltas(fiveM, bt, bt+7_200_000); got0 != want {
		t.Fatalf("expected bucket0 to absorb the hole: delta=%v, want %v", got0, want)
	}
	got1 := pct(t, "bucket after the hole", &result[1])
	if want := sumDeltas(fiveM, bt+7_200_000, bt+10_800_000); got1 != want {
		t.Fatalf("expected bucket1 delta=%v, want %v", got1, want)
	}

	contiguous := mkChart(bt, 3_600_000, 3, "1h")
	full := s.ComputeCvdDeltas("TEST", contiguous)
	var fullTotal float64
	for i := range full {
		fullTotal += pct(t, fmt.Sprintf("contiguous bucket %d", i), &full[i])
	}
	if got0+got1 != fullTotal {
		t.Fatalf("holey total %v != contiguous total %v", got0+got1, fullTotal)
	}
}

// TestComputeCvdDeltasLiveBucketPartialElapsed pins the live-edge rule: the
// in-progress display bucket is served with the partial-elapsed sum (the same
// at any instant on every timeframe), and buckets wholly past the source tail
// stay nil.
func TestComputeCvdDeltasLiveBucketPartialElapsed(t *testing.T) {
	s := newTestStore(t)
	bt := int64(1_700_001_000_000)

	fiveM := []Candle{
		{OpenMs: bt, Interval: "5m", Open: "100", Close: "101", Volume: "10"},
		{OpenMs: bt + 300_000, Interval: "5m", Open: "101", Close: "100", Volume: "15"},
		{OpenMs: bt + 600_000, Interval: "5m", Open: "100", Close: "103", Volume: "20"},
	}
	thirtyM := []Candle{
		{OpenMs: bt - 1_800_000, Interval: "30m", Open: "95", Close: "100", Volume: "50"},
	}
	inject(t, s, "TEST", "5m", fiveM)
	inject(t, s, "TEST", "30m", thirtyM)

	hourChart := []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "", Volume: "45"},
	}
	hourDelta := pct(t, "in-progress 1h bucket", &s.ComputeCvdDeltas("TEST", hourChart)[0])
	if hourDelta != 15 { // +10 -15 +20 elapsed so far
		t.Fatalf("expected partial-elapsed delta=15, got %v", hourDelta)
	}

	fiveChart := mkChart(bt, 300_000, 3, "5m")
	fiveResult := s.ComputeCvdDeltas("TEST", fiveChart)
	var fiveTotal float64
	for i := range fiveResult {
		fiveTotal += pct(t, fmt.Sprintf("5m bucket %d", i), &fiveResult[i])
	}
	if fiveTotal != hourDelta {
		t.Fatalf("5m total %v != in-progress 1h delta %v", fiveTotal, hourDelta)
	}

	pastTail := []Candle{
		{OpenMs: bt + 900_000, Interval: "5m", Open: "103", Close: "", Volume: "5"},
	}
	if result := s.ComputeCvdDeltas("TEST", pastTail); result[0].CvdDelta != nil {
		t.Fatalf("expected nil CvdDelta past the source tail, got %v", *result[0].CvdDelta)
	}
}
