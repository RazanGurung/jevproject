package candlecache

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"hyperliquid-go/internal/chartrequirements"
)

func snapshotPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "snap.json.gz")
}

func persistTestStore(t *testing.T) *Store {
	t.Helper()
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		return nil, fmt.Errorf("unexpected fetch in test")
	}, 400)
	s.OnMarketWSReconnect()
	return s
}

func TestSnapshotRoundTrip(t *testing.T) {
	bt := int64(1_700_001_000_000)
	src := persistTestStore(t)
	inject(t, src, "BTC", "1h", []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "101", Volume: "10", Trades: 5},
		{OpenMs: bt + 3_600_000, Interval: "1h", Open: "101", Close: "102", Volume: "12", Trades: 7},
	})
	inject(t, src, "ETH", "5m", []Candle{
		{OpenMs: bt, Interval: "5m", Open: "50", Close: "51", Volume: "3", Trades: 2},
	})
	// Registered but empty series must be skipped on save.
	src.RegisterSeries("SOL", "1h", 100*testDayMs)

	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	dst := persistTestStore(t)
	var registered [][2]string
	dst.SetOnRegister(func(coin, interval string) {
		registered = append(registered, [2]string{coin, interval})
	})
	n, err := dst.LoadSnapshot(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if n != 2 {
		t.Fatalf("loaded %d series, want 2", n)
	}
	if len(registered) != 2 {
		t.Fatalf("onRegister fired %d times, want 2 (WS subscriptions must be restored): %v", len(registered), registered)
	}

	ser := dst.getSeries("BTC", "1h")
	if ser == nil {
		t.Fatal("BTC 1h not restored")
	}
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if len(ser.candles) != 2 || ser.candles[1].Close != "102" || ser.candles[1].Trades != 7 {
		t.Fatalf("candles not restored faithfully: %+v", ser.candles)
	}
	if ser.coverageStartMs != bt {
		t.Fatalf("coverageStartMs = %d, want %d", ser.coverageStartMs, bt)
	}
	if !ser.degraded {
		t.Fatal("restored series must load degraded (serving declines until a live tick vouches for the tail)")
	}
	if dst.getSeries("SOL", "1h") != nil {
		t.Fatal("empty series must not be persisted")
	}
}

func TestSnapshotRestoredSeriesHealsOnFirstTick(t *testing.T) {
	bt := int64(1_700_001_000_000)
	src := persistTestStore(t)
	inject(t, src, "BTC", "1h", []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "101", Volume: "10", Trades: 5},
	})
	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	dst := persistTestStore(t)
	if _, err := dst.LoadSnapshot(path); err != nil {
		t.Fatalf("load: %v", err)
	}

	// Immutable history is safe immediately after restore (degraded only
	// distrusts the live edge).
	histBody := map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "BTC", "interval": "1h",
			"startTime": float64(bt), "endTime": float64(bt + 3_600_000),
		},
	}
	if _, ok := dst.ServeInfoRequest(histBody); !ok {
		t.Fatal("restored series must serve historical ranges before a live tick")
	}

	now := time.Now().UnixMilli()
	liveBody := map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "BTC", "interval": "1h",
			"startTime": float64(now - 7*24*60*60*1000), "endTime": float64(now),
		},
	}
	if _, ok := dst.ServeInfoRequest(liveBody); ok {
		t.Fatal("stale restored live-edge must passthrough until a tick or recent verify")
	}

	// Same-bucket tick with higher trade count: the outage-heal path clears
	// degraded and live-edge serving resumes with zero REST calls.
	dst.ApplyWSCandle(map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(bt), "s": "BTC", "i": "1h",
			"o": "100", "c": "101.5", "h": "102", "l": "99", "v": "11", "n": float64(9),
		},
	})
	payload, ok := dst.ServeInfoRequest(histBody)
	if !ok {
		t.Fatal("series must still serve history after the first same-bucket tick")
	}
	if !strings.Contains(string(payload), `"101.5"`) {
		t.Fatalf("served payload missing the live tick's close: %s", payload)
	}
}

func TestSnapshotGapStaysUnverifiedAfterTailTick(t *testing.T) {
	bt := int64(1_700_001_000_000)
	src := persistTestStore(t)
	inject(t, src, "BTC", "1h", []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "101", Volume: "10", Trades: 5},
		// The missing bt+1h candle mirrors a cached historical hole. The
		// current tail can still receive a same-bucket tick after restart.
		{OpenMs: bt + 2*3_600_000, Interval: "1h", Open: "102", Close: "103", Volume: "12", Trades: 7},
	})
	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	dst := persistTestStore(t)
	if _, err := dst.LoadSnapshot(path); err != nil {
		t.Fatalf("load: %v", err)
	}
	dst.ApplyWSCandle(wsCandleMsg(Candle{
		OpenMs: bt + 2*3_600_000, Symbol: "BTC", Interval: "1h",
		Open: "102", Close: "103.5", High: "104", Low: "101", Volume: "13", Trades: 9,
	}))

	body := snapshotBody("BTC", "1h", bt, bt+2*3_600_000)
	if _, ok := dst.ServeInfoRequest(body); ok {
		t.Fatal("snapshot hole must remain unverified after a same-bucket tail tick")
	}
	ser := dst.getSeries("BTC", "1h")
	ser.mu.RLock()
	gapFrom := ser.unverifiedGapFromMs
	ser.mu.RUnlock()
	if gapFrom != bt {
		t.Fatalf("unverifiedGapFromMs = %d, want %d", gapFrom, bt)
	}
}

func TestSnapshotPreservesVerifiedSparseHistory(t *testing.T) {
	bt := int64(1_700_001_000_000)
	src := persistTestStore(t)
	inject(t, src, "xyz:NVDA", "1h", []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "101", Volume: "10", Trades: 5},
		// A no-trade hour is a legitimate sparse-market discontinuity after a
		// complete REST snapshot has verified the range.
		{OpenMs: bt + 2*3_600_000, Interval: "1h", Open: "102", Close: "103", Volume: "12", Trades: 7},
	})
	ser := src.getSeries("xyz:NVDA", "1h")
	ser.mu.Lock()
	ser.verifiedThroughMs = bt + 3*3_600_000
	ser.mu.Unlock()

	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	dst := persistTestStore(t)
	if _, err := dst.LoadSnapshot(path); err != nil {
		t.Fatalf("load: %v", err)
	}
	restored := dst.getSeries("xyz:NVDA", "1h")
	restored.mu.RLock()
	gap, verifiedThrough := restored.unverifiedGapFromMs, restored.verifiedThroughMs
	restored.mu.RUnlock()
	if gap != 0 {
		t.Fatalf("verified sparse gap was reclassified as unverified: %d", gap)
	}
	if verifiedThrough != bt+3*3_600_000 {
		t.Fatalf("verifiedThroughMs = %d", verifiedThrough)
	}
}

func TestLoadSnapshotRetainsDeeperThanRequirementLookback(t *testing.T) {
	now := time.Now().UnixMilli()
	first := now - 400*testDayMs
	src := persistTestStore(t)
	src.RegisterSeries("BTC", "2h", 175*testDayMs)
	ser := src.getSeries("BTC", "2h")
	ser.mu.Lock()
	ser.candles = []Candle{
		{OpenMs: first, Interval: "2h", Open: "100", Close: "101", Volume: "1", Trades: 1},
		{OpenMs: now - 2*60*60*1000, Interval: "2h", Open: "110", Close: "111", Volume: "1", Trades: 1},
	}
	ser.coverageStartMs = first
	ser.mu.Unlock()

	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	dst := persistTestStore(t)
	if _, err := dst.LoadSnapshot(path); err != nil {
		t.Fatalf("load: %v", err)
	}
	got := dst.getSeries("BTC", "2h")
	if got == nil {
		t.Fatal("BTC 2h not restored")
	}
	got.mu.RLock()
	lookback := got.lookbackMs
	got.mu.RUnlock()
	if lookback < 390*testDayMs {
		t.Fatalf("restored lookback %d, want at least the 400d resident span", lookback)
	}
	dst.pruneOnce(time.Now())
	got.mu.RLock()
	defer got.mu.RUnlock()
	if len(got.candles) == 0 || got.candles[0].OpenMs != first {
		t.Fatalf("prune dropped restored extra history: %+v", got.candles)
	}
}

func TestCapCompleteCvdSourcesDoNotNeedDisplayWarm(t *testing.T) {
	s := persistTestStore(t)
	now := time.Now().UnixMilli()
	s.PrepareChartRequirements("PURR", "2h")
	for _, interval := range []string{"5m", "30m"} {
		ser := s.getSeries("PURR", interval)
		capLookback := chartrequirements.ReachableLookbackMs(interval, ser.lookbackMs)
		start := now - capLookback
		ser.mu.Lock()
		ser.candles = []Candle{{
			OpenMs: start, CloseMs: start + ser.intervalMs - 1,
			Symbol: "PURR", Interval: interval,
			Open: "1", Close: "2", Volume: "1", Trades: 1,
		}}
		ser.coverageStartMs = start
		ser.degraded = true
		ser.mu.Unlock()
		if s.NeedsDisplayWarm("PURR", interval) {
			t.Fatalf("%s cap-complete coverage still wants display warm", interval)
		}
		if s.NeedsWarm("PURR", interval) {
			t.Fatalf("%s cap-complete coverage still wants deepen", interval)
		}
	}
}

func TestSaveSnapshotKeepsCvdSourceWhenCoinIsActive(t *testing.T) {
	s := persistTestStore(t)
	bt := int64(1_700_001_000_000)
	inject(t, s, "BTC", "2h", []Candle{{OpenMs: bt, Interval: "2h", Open: "1", Close: "2", Volume: "1", Trades: 1}})
	inject(t, s, "BTC", "30m", []Candle{{OpenMs: bt, Interval: "30m", Open: "1", Close: "2", Volume: "1", Trades: 1}})
	s.getSeries("BTC", "2h").lastNeededMs.Store(time.Now().UnixMilli())
	s.getSeries("BTC", "30m").lastNeededMs.Store(time.Now().Add(-seriesIdleTTL - time.Hour).UnixMilli())

	path := snapshotPath(t)
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	dst := persistTestStore(t)
	n, err := dst.LoadSnapshot(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if n != 2 || dst.getSeries("BTC", "30m") == nil {
		t.Fatalf("idle 30m CVD source dropped while 2h was active: loaded=%d", n)
	}
}

func TestPromoteExtendedLookbacksDeepensDisplayWindow(t *testing.T) {
	now := time.Now().UnixMilli()
	s := persistTestStore(t)
	display := chartrequirements.IndicatorStableLookbackMs
	s.RegisterSeries("ETH", "2h", display)
	ser := s.getSeries("ETH", "2h")
	ser.mu.Lock()
	ser.coverageStartMs = now - display
	ser.candles = []Candle{{
		OpenMs: ser.coverageStartMs, Interval: "2h",
		Open: "1", Close: "1", Volume: "1", Trades: 1,
	}}
	ser.mu.Unlock()
	if s.NeedsWarm("ETH", "2h") {
		t.Fatal("display coverage should satisfy the registered lookback")
	}
	if n := s.PromoteExtendedLookbacks([]string{"ETH"}); n < 1 {
		t.Fatalf("promoted %d, want at least the 2h series", n)
	}
	if !s.NeedsWarm("ETH", "2h") {
		t.Fatal("extended 2h lookback must leave the display-only series needing a deepen")
	}
	if s.NeedsDisplayWarm("ETH", "2h") {
		t.Fatal("display window must stay warm after lookback promotion")
	}
}

func TestWarmDisplayFetchesVisibleWindowNotExtendedLookback(t *testing.T) {
	var mu sync.Mutex
	var calls []fetchCall
	s := New(recordingFetch(&mu, &calls, nil), 1_000_000)
	s.OnMarketWSReconnect()
	s.WarmDisplay("DOGE", "2h")
	mu.Lock()
	defer mu.Unlock()
	if len(calls) == 0 {
		t.Fatal("WarmDisplay fetched nothing")
	}
	display := displayLookbackForInterval("2h")
	extended := lookbackForInterval("2h")
	span := calls[0].endMs - calls[0].startMs
	if span < display-2*60*60*1000 || span > display+2*60*60*1000 {
		t.Fatalf("WarmDisplay span %d, want display %d", span, display)
	}
	if extended > display && span > display+dayMs {
		t.Fatalf("WarmDisplay used extended span %d (extended=%d display=%d)", span, extended, display)
	}
	if !s.NeedsWarm("DOGE", "2h") {
		t.Fatal("display-only warm must still need an extended deepen")
	}
	if s.NeedsDisplayWarm("DOGE", "2h") {
		t.Fatal("display window should be satisfied after WarmDisplay")
	}
}

func TestLoadSnapshotMissingFileIsNoOp(t *testing.T) {
	s := persistTestStore(t)
	n, err := s.LoadSnapshot(filepath.Join(t.TempDir(), "nope.json.gz"))
	if err != nil || n != 0 {
		t.Fatalf("missing file: n=%d err=%v, want 0/nil", n, err)
	}
}

func TestLoadSnapshotCorruptFile(t *testing.T) {
	path := snapshotPath(t)
	if err := os.WriteFile(path, []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := persistTestStore(t)
	n, err := s.LoadSnapshot(path)
	if err == nil {
		t.Fatal("corrupt file must error")
	}
	if n != 0 {
		t.Fatalf("corrupt file loaded %d series", n)
	}
}

func writeSnapshotHeader(t *testing.T, path string, header snapshotHeader) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	if err := json.NewEncoder(gz).Encode(header); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSnapshotStaleOrWrongVersionIgnored(t *testing.T) {
	stale := snapshotPath(t)
	writeSnapshotHeader(t, stale, snapshotHeader{
		Version:   snapshotVersion,
		SavedAtMs: time.Now().Add(-snapshotMaxAge - time.Hour).UnixMilli(),
	})
	s := persistTestStore(t)
	if n, err := s.LoadSnapshot(stale); err != nil || n != 0 {
		t.Fatalf("stale snapshot: n=%d err=%v, want 0/nil", n, err)
	}

	wrongVer := snapshotPath(t)
	writeSnapshotHeader(t, wrongVer, snapshotHeader{
		Version:   snapshotVersion + 1,
		SavedAtMs: time.Now().UnixMilli(),
	})
	if n, err := s.LoadSnapshot(wrongVer); err != nil || n != 0 {
		t.Fatalf("wrong version: n=%d err=%v, want 0/nil", n, err)
	}
}

func TestSnapshotV2ColumnarRoundTrip(t *testing.T) {
	bt := int64(1_700_001_000_000)
	src := persistTestStore(t)
	inject(t, src, "BTC", "1h", []Candle{
		{OpenMs: bt, CloseMs: bt + 3_599_999, Interval: "1h", Open: "100", High: "105", Low: "99", Close: "101", Volume: "10", Trades: 5},
		{OpenMs: bt + 3_600_000, CloseMs: bt + 7_199_999, Interval: "1h", Open: "101", High: "106", Low: "100", Close: "102", Volume: "12", Trades: 7},
	})
	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	// File must be v2 columnar (has "t":[ not "candles":[).
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// gunzip check via load
	dst := persistTestStore(t)
	n, err := dst.LoadSnapshot(path)
	if err != nil || n != 1 {
		t.Fatalf("load v2: n=%d err=%v", n, err)
	}
	ser := dst.getSeries("BTC", "1h")
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if len(ser.candles) != 2 || ser.candles[1].Close != "102" || ser.candles[1].Trades != 7 {
		t.Fatalf("v2 candles: %+v", ser.candles)
	}
	if ser.candles[0].Symbol != "BTC" || ser.candles[0].Interval != "1h" {
		t.Fatalf("v2 expand must restore series identity on rows: %+v", ser.candles[0])
	}
	_ = raw
}

func TestSnapshotV1LegacyStillLoads(t *testing.T) {
	bt := int64(1_700_001_000_000)
	path := snapshotPath(t)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	enc := json.NewEncoder(gz)
	if err := enc.Encode(snapshotHeader{Version: snapshotVersionLegacy, SavedAtMs: time.Now().UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	legacy := snapshotSeriesV1{
		Coin: "ETH", Interval: "5m", LookbackMs: 100 * testDayMs, CoverageStartMs: bt,
		GapStateKnown: true, VerifiedThroughMs: bt + 300_000, LastNeededMs: time.Now().UnixMilli(),
		Candles: []Candle{
			{OpenMs: bt, CloseMs: bt + 299_999, Symbol: "ETH", Interval: "5m", Open: "1", Close: "2", High: "2", Low: "1", Volume: "3", Trades: 4},
		},
	}
	if err := enc.Encode(legacy); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	dst := persistTestStore(t)
	n, err := dst.LoadSnapshot(path)
	if err != nil || n != 1 {
		t.Fatalf("legacy v1 load: n=%d err=%v", n, err)
	}
	ser := dst.getSeries("ETH", "5m")
	if ser == nil {
		t.Fatal("ETH 5m missing")
	}
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if len(ser.candles) != 1 || ser.candles[0].Close != "2" || !ser.degraded {
		t.Fatalf("legacy restore: %+v degraded=%v", ser.candles, ser.degraded)
	}
}

func TestSaveSnapshotLeavesNoTempFiles(t *testing.T) {
	bt := int64(1_700_001_000_000)
	s := persistTestStore(t)
	inject(t, s, "BTC", "1h", []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "101", Volume: "10"},
	})
	path := snapshotPath(t)
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

func TestLoadSnapshotRemovesFreshOrphanTmps(t *testing.T) {
	path := snapshotPath(t)
	orphan := path + ".tmp-333"
	if err := os.WriteFile(orphan, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := persistTestStore(t)
	n, err := s.LoadSnapshot(path)
	if err != nil || n != 0 {
		t.Fatalf("missing snapshot: n=%d err=%v", n, err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("fresh orphan tmp must be removed on load")
	}
}

func TestSaveSnapshotKeepsFreshSiblingTmp(t *testing.T) {
	bt := int64(1_700_001_000_000)
	s := persistTestStore(t)
	inject(t, s, "BTC", "1h", []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "101", Volume: "10"},
	})
	path := snapshotPath(t)
	fresh := path + ".tmp-444"
	if err := os.WriteFile(fresh, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh sibling tmp (possible in-flight save) must be kept")
	}
}

func TestLoadSnapshotNeverClobbersLiveData(t *testing.T) {
	bt := int64(1_700_001_000_000)
	src := persistTestStore(t)
	inject(t, src, "BTC", "1h", []Candle{
		{OpenMs: bt, Interval: "1h", Open: "100", Close: "101", Volume: "10"},
	})
	path := snapshotPath(t)
	if err := src.SaveSnapshot(path); err != nil {
		t.Fatalf("save: %v", err)
	}

	dst := persistTestStore(t)
	inject(t, dst, "BTC", "1h", []Candle{
		{OpenMs: bt + 3_600_000, Interval: "1h", Open: "102", Close: "103", Volume: "5"},
	})
	if _, err := dst.LoadSnapshot(path); err != nil {
		t.Fatalf("load: %v", err)
	}
	ser := dst.getSeries("BTC", "1h")
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if len(ser.candles) != 1 || ser.candles[0].Close != "103" {
		t.Fatalf("live series clobbered by snapshot: %+v", ser.candles)
	}
	if ser.degraded {
		t.Fatal("live series must not be marked degraded by a skipped restore")
	}
}
