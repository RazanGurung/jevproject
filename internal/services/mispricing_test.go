package services

import (
	"context"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"hyperliquid-go/internal/services/testutil"
)

func withLiquidityFloors(t *testing.T, oi, vol float64) {
	t.Helper()
	prevOI, prevVol := minTickerOINotionalUSD, minTickerDayVolUSD
	minTickerOINotionalUSD, minTickerDayVolUSD = oi, vol
	t.Cleanup(func() { minTickerOINotionalUSD, minTickerDayVolUSD = prevOI, prevVol })
}

func liquidCtx(name, mark, oracle string) map[string]interface{} {
	return map[string]interface{}{
		"name": name, "markPx": mark, "oraclePx": oracle,
		"openInterest": "1000000", "dayNtlVlm": "100000000",
	}
}

func waitForMispricing(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for asynchronous reference work")
}

func resolvedEntries(t *testing.T, svc *MarketDataService, now time.Time) []MispricingEntry {
	t.Helper()
	if _, err := svc.getStockMispricingsAt(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	waitForMispricing(t, func() bool {
		svc.mispricingRefMu.Lock()
		defer svc.mispricingRefMu.Unlock()
		return len(svc.mispricingRefFlight) == 0
	})
	entries, err := svc.getStockMispricingsAt(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func TestSelectSessionClosePriceUsesLatestCandleAtBoundary(t *testing.T) {
	closeMs := int64(10_000_000)
	got, err := selectSessionClosePrice([]MispricingReferenceCandle{
		{OpenMs: closeMs - 120_000, CloseMs: closeMs - 60_001, Close: "98"},
		{OpenMs: closeMs - 60_000, CloseMs: closeMs - 1, Close: "100"},
		{OpenMs: closeMs, CloseMs: closeMs + 59_999, Close: "500"},
	}, closeMs)
	if err != nil || got != 100 {
		t.Fatalf("close selection got=%v err=%v, want 100", got, err)
	}
}

func TestSelectSessionClosePriceNeverFallsForward(t *testing.T) {
	closeMs := int64(10_000_000)
	if got, err := selectSessionClosePrice([]MispricingReferenceCandle{
		{OpenMs: closeMs, CloseMs: closeMs + 59_999, Close: "500"},
	}, closeMs); err == nil || got != 0 {
		t.Fatalf("post-close candle leaked: got=%v err=%v", got, err)
	}
}

func TestGetStockMispricingsXyzOnlyUsesCloseReferences(t *testing.T) {
	withLiquidityFloors(t, 0, 0)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		switch dex {
		case "xyz":
			return []interface{}{liquidCtx("NVDA", "102", "101"), liquidCtx("GOLD", "97", "96")}, nil
		default:
			// Non-xyz HIP-3 dexs must not be queried for mispricing.
			return []interface{}{liquidCtx("AVGO", "104", "103")}, nil
		}
	}}
	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	svc.SetMispricingReferenceFetcher(func(
		_ context.Context, coin string, _, endMs int64,
	) ([]MispricingReferenceCandle, error) {
		closeByCoin := map[string]string{
			"xyz:NVDA": "100", "xyz:GOLD": "100",
		}
		return []MispricingReferenceCandle{{
			OpenMs: endMs - 60_000, CloseMs: endMs - 1, Close: closeByCoin[coin],
		}}, nil
	})
	entries := resolvedEntries(t, svc, mustTime(t, "2026-06-27T10:00:00Z"))
	if len(entries) != 2 {
		t.Fatalf("got %d entries: %+v", len(entries), entries)
	}
	// Sorted by |deviation| desc: GOLD 3%, NVDA 2%.
	want := []string{"xyz:GOLD", "xyz:NVDA"}
	for i := range want {
		if entries[i].Coin != want[i] {
			t.Fatalf("entry %d=%q want %q", i, entries[i].Coin, want[i])
		}
		if entries[i].ClosePx != 100 || entries[i].MarkPx <= 0 || entries[i].AsOfMs == 0 {
			t.Fatalf("entry missing close-based data: %+v", entries[i])
		}
	}
	if math.Abs(entries[0].DeviationPct-(-3)) > 1e-9 {
		t.Fatalf("deviation=%v want -3", entries[0].DeviationPct)
	}
}

func TestZhipuRegressionUsesHKEXClose(t *testing.T) {
	withLiquidityFloors(t, 0, 0)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		if dex == "xyz" {
			return []interface{}{liquidCtx("ZHIPU", "119.5", "118.08")}, nil
		}
		return nil, nil
	}}
	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	svc.SetMispricingReferenceFetcher(func(
		_ context.Context, _ string, _, endMs int64,
	) ([]MispricingReferenceCandle, error) {
		return []MispricingReferenceCandle{{
			OpenMs: endMs - 60_000, CloseMs: endMs - 1, Close: "109.38",
		}}, nil
	})
	entries := resolvedEntries(t, svc, mustTime(t, "2026-06-27T10:00:00Z"))
	if len(entries) != 1 {
		t.Fatalf("ZHIPU row missing: %+v", entries)
	}
	want := (119.5 - 109.38) / 109.38 * 100
	if math.Abs(entries[0].DeviationPct-want) > 1e-9 || entries[0].DeviationPct < 9 {
		t.Fatalf("ZHIPU deviation=%v want close-based %v", entries[0].DeviationPct, want)
	}
}

func TestMispricingCandidatesDoNotDependOnReferences(t *testing.T) {
	withLiquidityFloors(t, 0, 0)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		if dex == "xyz" {
			return []interface{}{liquidCtx("NVDA", "102", "100")}, nil
		}
		return nil, nil
	}}
	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	svc.mispricingNow = func() time.Time { return mustTime(t, "2026-06-27T10:00:00Z") }
	coins := svc.MispricingCandidateCoins(context.Background())
	if len(coins) != 1 || coins[0] != "xyz:NVDA" {
		t.Fatalf("candidate discovery depended on reference: %v", coins)
	}
	entries, _ := svc.getStockMispricingsAt(context.Background(), mustTime(t, "2026-06-27T10:00:00Z"))
	if len(entries) != 0 {
		t.Fatalf("unresolved reference should not emit endpoint row: %+v", entries)
	}
}

func TestMispricingExcludesOpenAndUnsupportedMarkets(t *testing.T) {
	withLiquidityFloors(t, 0, 0)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		if dex != "xyz" {
			return nil, nil
		}
		return []interface{}{
			liquidCtx("NVDA", "110", "100"),
			liquidCtx("TOTAL2", "150", "100"),
			liquidCtx("BTC", "150", "100"),
		}, nil
	}}
	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	entries, err := svc.getStockMispricingsAt(
		context.Background(), mustTime(t, "2026-06-24T15:00:00Z"),
	)
	if err != nil || len(entries) != 0 {
		t.Fatalf("open/unsupported markets leaked: entries=%+v err=%v", entries, err)
	}
	if coins := svc.MispricingCandidateCoins(context.Background()); len(coins) > 1 {
		t.Fatalf("unexpected candidate set: %v", coins)
	}
}

func TestMispricingRequiresRenderableMetadata(t *testing.T) {
	withLiquidityFloors(t, 0, 0)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		if dex == "xyz" {
			return []interface{}{liquidCtx("NVDA", "102", "100"), liquidCtx("AAPL", "103", "100")}, nil
		}
		return nil, nil
	}}
	meta := testutil.NewMockMetadataCache()
	meta.SetDecimals("xyz:NVDA", 3)
	meta.SetMaxLeverage("xyz:NVDA", 20)
	svc := NewMarketDataService(mock, nil, meta, nil, MarketNewsOptions{})
	candidates, _, _ := svc.collectMispricingCandidates(
		context.Background(), mustTime(t, "2026-06-27T10:00:00Z"),
	)
	if len(candidates) != 1 || candidates[0].entry.Coin != "xyz:NVDA" {
		t.Fatalf("renderability gate failed: %+v", candidates)
	}
}

func TestMispricingSkipsInvalidMarkAndIlliquid(t *testing.T) {
	withLiquidityFloors(t, 3_000_000, 1_000_000)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		if dex != "xyz" {
			return nil, nil
		}
		invalid := liquidCtx("NVDA", "0", "100")
		thin := liquidCtx("AAPL", "110", "100")
		thin["openInterest"] = "1"
		return []interface{}{invalid, thin}, nil
	}}
	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	candidates, _, _ := svc.collectMispricingCandidates(
		context.Background(), mustTime(t, "2026-06-27T10:00:00Z"),
	)
	if len(candidates) != 0 {
		t.Fatalf("invalid/illiquid candidates leaked: %+v", candidates)
	}
}

func TestMispricingPartialDexFailureStillServes(t *testing.T) {
	withLiquidityFloors(t, 0, 0)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		if dex == "para" {
			return nil, errors.New("temporary")
		}
		if dex == "xyz" {
			return []interface{}{liquidCtx("NVDA", "102", "100")}, nil
		}
		return nil, nil
	}}
	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	svc.SetMispricingReferenceFetcher(func(
		_ context.Context, _ string, _, endMs int64,
	) ([]MispricingReferenceCandle, error) {
		return []MispricingReferenceCandle{{
			OpenMs: endMs - 60_000, CloseMs: endMs - 1, Close: "100",
		}}, nil
	})
	entries := resolvedEntries(t, svc, mustTime(t, "2026-06-27T10:00:00Z"))
	if len(entries) != 1 || entries[0].Coin != "xyz:NVDA" {
		t.Fatalf("partial failure suppressed healthy DEX: %+v", entries)
	}
}

func TestMispricingCachedRowsClearWhenSessionOpens(t *testing.T) {
	weekend := mustTime(t, "2026-06-27T10:00:00Z")
	instrument, _ := MispricingInstrumentFor("xyz:NVDA")
	_, closeAt, _ := instrument.Session.StateAt(weekend)
	cached := []MispricingEntry{{
		Coin: "xyz:NVDA", SessionState: string(SessionWeekend),
		SessionCloseMs: closeAt.UnixMilli(), MarkPx: 102, ClosePx: 100, DeviationPct: 2,
	}}
	open := mustTime(t, "2026-06-29T15:00:00Z")
	if got := filterCachedMispricingsAt(cached, open); len(got) != 0 {
		t.Fatalf("cached closed row survived market open: %+v", got)
	}
	if got := filterCachedMispricingsAt(cached, weekend); len(got) != 1 {
		t.Fatalf("valid closed-session cache was dropped: %+v", got)
	}
}

func TestMispricingReferenceCacheRollsAtNewSessionClose(t *testing.T) {
	svc := NewMarketDataService(nil, nil, nil, nil, MarketNewsOptions{})
	oldKey := mispricingReferenceKey{Coin: "xyz:NVDA", SessionCloseMs: 1}
	newKey := mispricingReferenceKey{Coin: "xyz:NVDA", SessionCloseMs: 2}
	svc.finishMispricingReference(oldKey, 100, nil)
	if got, ok := svc.getMispricingReference(oldKey); !ok || got != 100 {
		t.Fatalf("old reference missing: %v %v", got, ok)
	}
	svc.finishMispricingReference(newKey, 101, nil)
	if _, ok := svc.getMispricingReference(oldKey); ok {
		t.Fatal("old session reference survived rollover")
	}
	if got, ok := svc.getMispricingReference(newKey); !ok || got != 101 {
		t.Fatalf("new reference missing: %v %v", got, ok)
	}
}

func TestMispricingReferenceConcurrencyLimitedToThree(t *testing.T) {
	svc := NewMarketDataService(nil, nil, nil, nil, MarketNewsOptions{})
	var active, maxActive atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{}, 8)
	svc.SetMispricingReferenceFetcher(func(
		_ context.Context, _ string, _, endMs int64,
	) ([]MispricingReferenceCandle, error) {
		n := active.Add(1)
		for {
			old := maxActive.Load()
			if n <= old || maxActive.CompareAndSwap(old, n) {
				break
			}
		}
		started <- struct{}{}
		<-release
		active.Add(-1)
		return []MispricingReferenceCandle{{
			OpenMs: endMs - 60_000, CloseMs: endMs - 1, Close: "100",
		}}, nil
	})
	for i := 0; i < 6; i++ {
		svc.scheduleMispricingReference(mispricingCandidate{entry: MispricingEntry{
			Coin: "coin-" + string(rune('a'+i)), SessionCloseMs: int64(1_000_000 + i),
		}}, time.Now())
	}
	for i := 0; i < 3; i++ {
		<-started
	}
	time.Sleep(10 * time.Millisecond)
	if got := maxActive.Load(); got != 3 {
		t.Fatalf("max concurrent resolutions=%d want 3", got)
	}
	close(release)
	waitForMispricing(t, func() bool {
		svc.mispricingRefMu.Lock()
		defer svc.mispricingRefMu.Unlock()
		return len(svc.mispricingRefFlight) == 0
	})
}

func TestMispricingReferenceSingleFlightAndRetryCooldown(t *testing.T) {
	svc := NewMarketDataService(nil, nil, nil, nil, MarketNewsOptions{})
	var calls atomic.Int32
	svc.SetMispricingReferenceFetcher(func(
		_ context.Context, _ string, _, _ int64,
	) ([]MispricingReferenceCandle, error) {
		calls.Add(1)
		return nil, errors.New("temporary")
	})
	candidate := mispricingCandidate{entry: MispricingEntry{Coin: "xyz:NVDA", SessionCloseMs: 10_000}}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			svc.scheduleMispricingReference(candidate, time.Now())
		}()
	}
	wg.Wait()
	waitForMispricing(t, func() bool {
		svc.mispricingRefMu.Lock()
		defer svc.mispricingRefMu.Unlock()
		return len(svc.mispricingRefFlight) == 0
	})
	svc.scheduleMispricingReference(candidate, time.Now())
	time.Sleep(10 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("single-flight/cooldown calls=%d want 1", got)
	}
	key := referenceKey(candidate)
	svc.mispricingRefMu.Lock()
	svc.mispricingRetryAfter[key] = time.Now().Add(-time.Second)
	svc.mispricingRefMu.Unlock()
	svc.scheduleMispricingReference(candidate, time.Now())
	waitForMispricing(t, func() bool { return calls.Load() == 2 })
}

func TestMispricingRegistryIsExact(t *testing.T) {
	if _, ok := MispricingInstrumentFor("para:AVGO"); ok {
		t.Fatal("non-xyz HIP-3 markets must not be registered")
	}
	if _, ok := MispricingInstrumentFor("hyna:AVGO"); ok {
		t.Fatal("unregistered DEX inherited ticker session")
	}
	if _, ok := MispricingInstrumentFor("xyz:MINIMAX"); !ok {
		t.Fatal("active HKEX listing should be explicitly registered")
	}
	if _, ok := MispricingInstrumentFor("mkts:US500"); ok {
		t.Fatal("non-xyz HIP-3 markets must not be registered")
	}
}

func TestSKHYIsSuppressedDuringNasdaqRegularSession(t *testing.T) {
	withLiquidityFloors(t, 0, 0)
	mock := &testutil.MockExchange{GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
		if dex == "xyz" {
			return []interface{}{
				liquidCtx("SKHY", "110", "100"),
				liquidCtx("SKHX", "110", "100"),
			}, nil
		}
		return nil, nil
	}}
	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	candidates, _, err := svc.collectMispricingCandidates(
		context.Background(), mustTime(t, "2026-07-30T15:00:00Z"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].entry.Coin != "xyz:SKHX" {
		t.Fatalf("Nasdaq-open SKHY was not suppressed, candidates=%+v", candidates)
	}
}

func TestMeetsLiquidityFloor(t *testing.T) {
	withLiquidityFloors(t, 3_000_000, 1_000_000)
	pass := map[string]interface{}{"markPx": "100", "openInterest": "40000", "dayNtlVlm": "2000000"}
	lowOI := map[string]interface{}{"markPx": "100", "openInterest": "100", "dayNtlVlm": "2000000"}
	lowVol := map[string]interface{}{"markPx": "100", "openInterest": "40000", "dayNtlVlm": "100"}
	if !meetsLiquidityFloor(pass) || meetsLiquidityFloor(lowOI) || meetsLiquidityFloor(lowVol) {
		t.Fatal("shared liquidity floor did not apply")
	}
}

func TestMispricingCacheCanRepresentEmpty(t *testing.T) {
	svc := NewMarketDataService(nil, nil, nil, nil, MarketNewsOptions{})
	svc.setCachedMispricings([]MispricingEntry{})
	if got, ok := svc.getCachedMispricings(); !ok || len(got) != 0 {
		t.Fatalf("empty snapshot must clear stale rows: got=%v ok=%v", got, ok)
	}
}

func TestCanonicalDexCoin(t *testing.T) {
	for _, tc := range []struct{ coin, dex, want string }{
		{"AVGO", "para", "para:AVGO"},
		{"para:AVGO", "para", "para:AVGO"},
		{"BTC", "", "BTC"},
	} {
		if got := canonicalDexCoin(tc.coin, tc.dex); got != tc.want {
			t.Errorf("canonicalDexCoin(%q,%q)=%q want %q", tc.coin, tc.dex, got, tc.want)
		}
	}
}
