package candlecache

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func backdate(t *testing.T, s *Store, coin, interval string, age time.Duration) {
	t.Helper()
	ser := s.getSeries(coin, interval)
	if ser == nil {
		t.Fatalf("series %s|%s not registered", coin, interval)
	}
	ser.lastNeededMs.Store(time.Now().Add(-age).UnixMilli())
}

func TestEvictIdleSeries(t *testing.T) {
	bt := int64(1_700_001_000_000)
	s := newTestStore(t)
	bar := func(interval string) []Candle {
		return []Candle{{OpenMs: bt, Interval: interval, Open: "1", Close: "2", Volume: "3"}}
	}
	// STALE: every series idle past the TTL — the whole coin must go.
	inject(t, s, "STALE", "1h", bar("1h"))
	inject(t, s, "STALE", "5m", bar("5m"))
	inject(t, s, "STALE", "30m", bar("30m"))
	for _, iv := range []string{"1h", "5m", "30m"} {
		backdate(t, s, "STALE", iv, seriesIdleTTL+time.Hour)
	}
	// MIXED: the 1h chart is fresh but its CVD sources' own clocks are stale
	// (ComputeCvdDeltas reads them without touching) — sources must survive
	// via the coin-level max.
	inject(t, s, "MIXED", "1h", bar("1h"))
	inject(t, s, "MIXED", "5m", bar("5m"))
	inject(t, s, "MIXED", "30m", bar("30m"))
	backdate(t, s, "MIXED", "5m", seriesIdleTTL+time.Hour)
	backdate(t, s, "MIXED", "30m", seriesIdleTTL+time.Hour)
	// FRESH: untouched, well within TTL.
	inject(t, s, "FRESH", "1h", bar("1h"))

	var evictedPairs [][2]string
	s.SetOnEvict(func(coin, interval string) {
		evictedPairs = append(evictedPairs, [2]string{coin, interval})
	})

	if n := s.evictIdleSeries(time.Now()); n != 3 {
		t.Fatalf("evicted %d series, want 3 (STALE 1h/5m/30m): %v", n, evictedPairs)
	}
	if len(evictedPairs) != 3 {
		t.Fatalf("onEvict fired %d times, want 3: %v", len(evictedPairs), evictedPairs)
	}
	for _, pair := range evictedPairs {
		if pair[0] != "STALE" {
			t.Fatalf("evicted wrong coin: %v", evictedPairs)
		}
	}
	for _, iv := range []string{"1h", "5m", "30m"} {
		if s.getSeries("STALE", iv) != nil {
			t.Fatalf("STALE %s survived eviction", iv)
		}
		if s.getSeries("MIXED", iv) == nil {
			t.Fatalf("MIXED %s evicted despite the coin's fresh 1h chart", iv)
		}
	}
	if s.getSeries("FRESH", "1h") == nil {
		t.Fatal("FRESH 1h evicted")
	}

	// A second pass is a no-op: nothing left to evict, no callback churn.
	evictedPairs = nil
	if n := s.evictIdleSeries(time.Now()); n != 0 || len(evictedPairs) != 0 {
		t.Fatalf("second pass evicted %d (%v), want none", n, evictedPairs)
	}
}

func TestEvictIdleSeriesSparesReRegisteredPointer(t *testing.T) {
	bt := int64(1_700_001_000_000)
	s := newTestStore(t)
	inject(t, s, "BTC", "1h", []Candle{{OpenMs: bt, Interval: "1h", Open: "1", Close: "2", Volume: "3"}})
	backdate(t, s, "BTC", "1h", seriesIdleTTL+time.Hour)

	// A touch that lands after the victim scan must win over the stale
	// eviction decision (the write-lock recheck).
	s.MarkNeeded("BTC", "1h")
	if n := s.evictIdleSeries(time.Now()); n != 0 {
		t.Fatalf("evicted freshly-touched series: n=%d", n)
	}
	if s.getSeries("BTC", "1h") == nil {
		t.Fatal("touched series removed")
	}
}

func TestServeInfoRequestTouchesLastNeeded(t *testing.T) {
	bt := int64(1_700_001_000_000)
	s := newTestStore(t)
	inject(t, s, "BTC", "1h", []Candle{{OpenMs: bt, Interval: "1h", Open: "1", Close: "2", Volume: "3"}})
	backdate(t, s, "BTC", "1h", seriesIdleTTL+time.Hour)

	body := map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "BTC", "interval": "1h",
			"startTime": float64(bt), "endTime": float64(bt + 3_600_000),
		},
	}
	s.ServeInfoRequest(body)

	ser := s.getSeries("BTC", "1h")
	if age := time.Now().UnixMilli() - ser.lastNeededMs.Load(); age > int64(time.Minute/time.Millisecond) {
		t.Fatalf("ServeInfoRequest did not refresh lastNeededMs (age %dms)", age)
	}
}

func TestMarkNeededDoesNotRegister(t *testing.T) {
	s := newTestStore(t)
	s.MarkNeeded("BTC", "1h")
	if s.getSeries("BTC", "1h") != nil {
		t.Fatal("MarkNeeded registered a series")
	}
}

// writeSnapshotFile hand-crafts a legacy (v1 row) snapshot so tests can inject
// series states SaveSnapshot itself would filter out (e.g. already-idle series).
// Header.Version is forced to snapshotVersionLegacy to match the row payload.
func writeSnapshotFile(t *testing.T, path string, header snapshotHeader, series ...snapshotSeriesV1) {
	t.Helper()
	header.Version = snapshotVersionLegacy
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)
	if err := enc.Encode(header); err != nil {
		t.Fatal(err)
	}
	for _, snap := range series {
		if err := enc.Encode(snap); err != nil {
			t.Fatal(err)
		}
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotRoundTripPreservesLastNeeded(t *testing.T) {
	bt := int64(1_700_001_000_000)
	stamp := time.Now().Add(-3 * 24 * time.Hour).UnixMilli()

	src := persistTestStore(t)
	inject(t, src, "BTC", "1h", []Candle{{OpenMs: bt, Interval: "1h", Open: "1", Close: "2", Volume: "3"}})
	src.getSeries("BTC", "1h").lastNeededMs.Store(stamp)

	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	dst := persistTestStore(t)
	if _, err := dst.LoadSnapshot(path); err != nil {
		t.Fatalf("load: %v", err)
	}
	ser := dst.getSeries("BTC", "1h")
	if ser == nil {
		t.Fatal("series not restored")
	}
	if got := ser.lastNeededMs.Load(); got != stamp {
		t.Fatalf("lastNeededMs = %d, want %d (idle age must survive restarts, not reset to registration time)", got, stamp)
	}
}

func TestSaveSnapshotSkipsIdleSeries(t *testing.T) {
	bt := int64(1_700_001_000_000)
	src := persistTestStore(t)
	inject(t, src, "BTC", "1h", []Candle{{OpenMs: bt, Interval: "1h", Open: "1", Close: "2", Volume: "3"}})
	inject(t, src, "OLD", "1h", []Candle{{OpenMs: bt, Interval: "1h", Open: "1", Close: "2", Volume: "3"}})
	backdate(t, src, "OLD", "1h", seriesIdleTTL+time.Hour)

	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	dst := persistTestStore(t)
	n, err := dst.LoadSnapshot(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if n != 1 || dst.getSeries("OLD", "1h") != nil {
		t.Fatalf("idle series persisted: loaded=%d", n)
	}
}

func TestLoadSnapshotRestoresIdleSeriesWhenAlreadyRegistered(t *testing.T) {
	bt := int64(1_700_001_000_000)
	bar := []Candle{{OpenMs: bt, Interval: "30m", Open: "1", Close: "2", Volume: "3"}}
	path := snapshotPath(t)
	writeSnapshotFile(t, path,
		snapshotHeader{SavedAtMs: time.Now().UnixMilli()},
		snapshotSeriesV1{
			Coin: "ETHFI", Interval: "30m", LookbackMs: 175 * testDayMs,
			CoverageStartMs: bt,
			LastNeededMs:    time.Now().Add(-seriesIdleTTL - time.Hour).UnixMilli(),
			Candles:         bar,
		},
	)

	idleStamp := time.Now().Add(-seriesIdleTTL - time.Hour).UnixMilli()
	s := persistTestStore(t)
	s.PrepareChartRequirements("ETHFI", "2h")
	n, err := s.LoadSnapshot(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if n != 1 {
		t.Fatalf("pre-registered idle series must restore: loaded=%d", n)
	}
	ser := s.getSeries("ETHFI", "30m")
	if ser == nil || len(ser.candles) != 1 {
		t.Fatal("admit-set 30m candles missing after restore")
	}
	if got := ser.lastNeededMs.Load(); got <= idleStamp {
		t.Fatalf("startup lastNeeded overwritten by idle snapshot stamp: %d", got)
	}
}

func TestLoadSnapshotSkipsIdleSeriesWithoutRegistering(t *testing.T) {
	bt := int64(1_700_001_000_000)
	bar := []Candle{{OpenMs: bt, Interval: "1h", Open: "1", Close: "2", Volume: "3"}}
	path := snapshotPath(t)
	writeSnapshotFile(t, path,
		snapshotHeader{SavedAtMs: time.Now().UnixMilli()},
		snapshotSeriesV1{
			Coin: "FRESH", Interval: "1h", LookbackMs: 100 * testDayMs,
			CoverageStartMs: bt, LastNeededMs: time.Now().UnixMilli(), Candles: bar,
		},
		snapshotSeriesV1{
			Coin: "OLD", Interval: "1h", LookbackMs: 100 * testDayMs,
			CoverageStartMs: bt,
			LastNeededMs:    time.Now().Add(-seriesIdleTTL - time.Hour).UnixMilli(),
			Candles:         bar,
		},
	)

	s := persistTestStore(t)
	var registered [][2]string
	s.SetOnRegister(func(coin, interval string) {
		registered = append(registered, [2]string{coin, interval})
	})
	n, err := s.LoadSnapshot(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if n != 1 || s.getSeries("OLD", "1h") != nil {
		t.Fatalf("idle series resurrected on restart: loaded=%d", n)
	}
	// The ratchet check: no WS subscription may be created for the skipped
	// series (eviction would otherwise have to tear it down an hour later).
	if len(registered) != 1 || registered[0] != [2]string{"FRESH", "1h"} {
		t.Fatalf("onRegister fired for skipped series: %v", registered)
	}
}

func TestLoadSnapshotZeroStampFallsBackToSavedAt(t *testing.T) {
	bt := int64(1_700_001_000_000)
	savedAt := time.Now().Add(-2 * 24 * time.Hour).UnixMilli()
	path := snapshotPath(t)
	writeSnapshotFile(t, path,
		snapshotHeader{SavedAtMs: savedAt},
		snapshotSeriesV1{
			Coin: "BTC", Interval: "1h", LookbackMs: 100 * testDayMs,
			CoverageStartMs: bt,
			Candles:         []Candle{{OpenMs: bt, Interval: "1h", Open: "1", Close: "2", Volume: "3"}},
		},
	)

	s := persistTestStore(t)
	n, err := s.LoadSnapshot(path)
	if err != nil || n != 1 {
		t.Fatalf("pre-tracking snapshot rejected: n=%d err=%v", n, err)
	}
	ser := s.getSeries("BTC", "1h")
	if got := ser.lastNeededMs.Load(); got != savedAt {
		t.Fatalf("lastNeededMs = %d, want SavedAtMs %d (migration grace)", got, savedAt)
	}
}

func TestRemoveStaleSnapshotTmps(t *testing.T) {
	path := snapshotPath(t)
	stale := path + ".tmp-111"
	fresh := path + ".tmp-222"
	for _, p := range []string{stale, fresh} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	removeStaleSnapshotTmps(path)

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale tmp not removed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh tmp (possible in-flight save) must be kept")
	}
}
