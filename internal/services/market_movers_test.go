package services

import (
	"context"
	"strconv"
	"testing"

	"hyperliquid-go/internal/services/testutil"
)

func TestGetMarketMoversExtractsChangeAndOI(t *testing.T) {
	withLiquidityFloors(t, 0, 0) // exercise extraction/OI math, not the liquidity floor
	mock := &testutil.MockExchange{
		GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
			switch dex {
			case "":
				return []interface{}{
					// 10% up: markPx 110 vs prevDayPx 100; OI = 110 * 50 = 5500.
					map[string]interface{}{"coin": "BTC", "markPx": "110", "prevDayPx": "100", "openInterest": "50"},
					// -5% : markPx 95 vs prevDayPx 100; OI = 95 * 100 = 9500.
					map[string]interface{}{"coin": "ETH", "markPx": "95", "prevDayPx": "100", "openInterest": "100"},
					// zero OI -> skipped.
					map[string]interface{}{"coin": "DUST", "markPx": "1", "prevDayPx": "1", "openInterest": "0"},
				}, nil
			case "xyz":
				return []interface{}{
					map[string]interface{}{"name": "NVDA", "markPx": "200", "prevDayPx": "190", "openInterest": "3"},
				}, nil
			}
			return nil, nil
		},
	}

	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	movers, err := svc.GetMarketMovers(context.Background())
	if err != nil {
		t.Fatalf("GetMarketMovers error: %v", err)
	}

	byCoin := make(map[string]MoverEntry, len(movers))
	for _, m := range movers {
		byCoin[m.Coin] = m
	}

	if _, ok := byCoin["DUST"]; ok {
		t.Fatalf("zero-OI coin should be skipped, got %+v", byCoin["DUST"])
	}

	btc, ok := byCoin["BTC"]
	if !ok {
		t.Fatalf("expected BTC mover, got %+v", movers)
	}
	if btc.Change < 9.99 || btc.Change > 10.01 {
		t.Fatalf("BTC change want ~10, got %v", btc.Change)
	}
	if btc.OI < 5499 || btc.OI > 5501 {
		t.Fatalf("BTC OI want ~5500, got %v", btc.OI)
	}

	// xyz dex coins must be prefixed.
	if _, ok := byCoin["xyz:NVDA"]; !ok {
		t.Fatalf("expected xyz:NVDA mover (prefixed), got %+v", movers)
	}

	mock.GetAssetCtxsFunc = func(dex string) ([]interface{}, error) {
		if dex == "xyz" {
			return nil, context.DeadlineExceeded
		}
		return []interface{}{
			map[string]interface{}{"coin": "BTC", "markPx": "110", "prevDayPx": "100", "openInterest": "50"},
		}, nil
	}
	movers, err = svc.GetMarketMovers(context.Background())
	if err != nil {
		t.Fatalf("GetMarketMovers xyz failure: %v", err)
	}
	kept := false
	for _, m := range movers {
		if m.Coin == "xyz:NVDA" {
			kept = true
		}
	}
	if !kept {
		t.Fatalf("xyz failure replaced cache with default-only movers: %+v", movers)
	}
}

func coinsOf(entries []MoverEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Coin
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRankMoversKeepsTopHalfByOI(t *testing.T) {
	// 6 coins; cohort = top 3 by OI (100/90/80). The low-OI 3 are dropped even
	// when they carry extreme changes.
	entries := []MoverEntry{
		{Coin: "A", Change: 5, OI: 100},
		{Coin: "B", Change: -3, OI: 90},
		{Coin: "C", Change: 8, OI: 80},
		{Coin: "D", Change: 20, OI: 10},
		{Coin: "E", Change: -50, OI: 5},
		{Coin: "F", Change: 1, OI: 1},
	}

	ranked := rankMovers(entries, 40)
	if got := coinsOf(ranked.Gainers); !equalStrings(got, []string{"C", "A"}) {
		t.Fatalf("gainers want [C A], got %v", got)
	}
	if got := coinsOf(ranked.Losers); !equalStrings(got, []string{"B"}) {
		t.Fatalf("losers want [B], got %v", got)
	}
	for _, e := range append(ranked.Gainers, ranked.Losers...) {
		if e.Coin == "D" || e.Coin == "E" {
			t.Fatalf("low-OI coin %s should be excluded", e.Coin)
		}
	}
}

func TestRankMoversCapsEachRow(t *testing.T) {
	entries := make([]MoverEntry, 0, 20)
	for i := 0; i < 20; i++ {
		entries = append(entries, MoverEntry{Coin: "G" + strconv.Itoa(i), Change: float64(i + 1), OI: float64(1000 - i)})
	}
	ranked := rankMovers(entries, 3)
	if len(ranked.Gainers) != 3 {
		t.Fatalf("gainers want len 3, got %d", len(ranked.Gainers))
	}
	// top 50% of 20 = 10 coins; highest changes among them, capped to 3.
	if got := coinsOf(ranked.Gainers); !equalStrings(got, []string{"G9", "G8", "G7"}) {
		t.Fatalf("gainers want [G9 G8 G7], got %v", got)
	}
}

func TestRankMoversExcludesZeroChangeAndInvalid(t *testing.T) {
	// 4 coins -> cohort = top 2 by OI (A, B). A has zero change and is dropped
	// from both rows; B remains a gainer. C/D are bottom-50% OI. Z has no OI.
	entries := []MoverEntry{
		{Coin: "A", Change: 0, OI: 100},
		{Coin: "B", Change: 2, OI: 90},
		{Coin: "C", Change: 5, OI: 10},
		{Coin: "D", Change: -1, OI: 5},
		{Coin: "Z", Change: 9, OI: 0},
		{Coin: "", Change: 9, OI: 999},
	}
	ranked := rankMovers(entries, 40)
	if got := coinsOf(ranked.Gainers); !equalStrings(got, []string{"B"}) {
		t.Fatalf("gainers want [B], got %v", got)
	}
	if len(ranked.Losers) != 0 {
		t.Fatalf("losers want empty, got %v", coinsOf(ranked.Losers))
	}
}

func TestRankMoversEmptyInput(t *testing.T) {
	ranked := rankMovers(nil, 40)
	if len(ranked.Gainers) != 0 || len(ranked.Losers) != 0 {
		t.Fatalf("empty input must yield empty rows, got %+v", ranked)
	}
}

func TestGetAssetSnapshotsExtractsTriggerColumns(t *testing.T) {
	mock := &testutil.MockExchange{
		GetAssetCtxsFunc: func(dex string) ([]interface{}, error) {
			switch dex {
			case "":
				return []interface{}{
					map[string]interface{}{
						"coin": "BTC", "markPx": "110", "prevDayPx": "100",
						"openInterest": "50", "dayNtlVlm": "1500000", "funding": "0.0001",
					},
					map[string]interface{}{
						"coin": "ETH", "markPx": "95", "prevDayPx": "100",
						"openInterest": "100", "dayNtlVlm": "800000", "funding": "-0.00005",
					},
				}, nil
			case "xyz":
				return []interface{}{
					map[string]interface{}{
						"name": "NVDA", "markPx": "200", "prevDayPx": "190",
						"openInterest": "3", "dayNtlVlm": "50000", "funding": "0",
					},
				}, nil
			}
			return nil, nil
		},
	}

	svc := NewMarketDataService(mock, nil, nil, nil, MarketNewsOptions{})
	snaps, err := svc.GetAssetSnapshots(context.Background())
	if err != nil {
		t.Fatalf("GetAssetSnapshots error: %v", err)
	}

	btc, ok := snaps["BTC"]
	if !ok {
		t.Fatalf("missing BTC snapshot: %+v", snaps)
	}
	if btc.Change != "10.00" {
		t.Fatalf("BTC change want 10.00, got %q", btc.Change)
	}
	if btc.DayVol != 1_500_000 {
		t.Fatalf("BTC day vol want 1500000, got %v", btc.DayVol)
	}
	if btc.OI != 5500 { // 110 * 50
		t.Fatalf("BTC OI want 5500, got %v", btc.OI)
	}
	if btc.Funding != 0.01 { // 0.0001 * 100
		t.Fatalf("BTC funding want 0.01, got %v", btc.Funding)
	}
	if btc.MarkPx != 110 {
		t.Fatalf("BTC mark want 110, got %v", btc.MarkPx)
	}

	eth, ok := snaps["ETH"]
	if !ok {
		t.Fatalf("missing ETH snapshot")
	}
	if eth.Change != "-5.00" {
		t.Fatalf("ETH change want -5.00, got %q", eth.Change)
	}
	if eth.Funding != -0.005 {
		t.Fatalf("ETH funding want -0.005, got %v", eth.Funding)
	}

	nvda, ok := snaps["xyz:NVDA"]
	if !ok {
		t.Fatalf("missing xyz:NVDA snapshot: %+v", snaps)
	}
	if nvda.Change != "5.26" {
		// (200-190)/190 * 100 = 5.263... → "%.2f" = 5.26
		t.Fatalf("NVDA change want 5.26, got %q", nvda.Change)
	}

	// Get24hChanges remains a plain change map derived from the same cache.
	changes, err := svc.Get24hChanges(context.Background())
	if err != nil {
		t.Fatalf("Get24hChanges error: %v", err)
	}
	if changes["BTC"] != "10.00" || changes["ETH"] != "-5.00" {
		t.Fatalf("Get24hChanges map mismatch: %+v", changes)
	}
}
