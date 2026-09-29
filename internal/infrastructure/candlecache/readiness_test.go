package candlecache

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"hyperliquid-go/internal/chartrequirements"
)

func readinessFetcher(t *testing.T) (FetchFunc, *map[string]int) {
	t.Helper()
	calls := map[string]int{}
	var mu sync.Mutex
	fetch := func(_ context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		mu.Lock()
		calls[coin+"|"+interval]++
		mu.Unlock()
		ms := intervalMs(interval)
		span := int64(2 * time.Hour / time.Millisecond)
		first := endMs - span
		if first < startMs {
			first = startMs
		}
		first -= first % ms
		candles := make([]Candle, 0, int(span/ms)+1)
		for open := first; open < endMs; open += ms {
			candles = append(candles, Candle{
				OpenMs: open, CloseMs: open + ms - 1, Symbol: coin, Interval: interval,
				Open: "1", Close: "2", High: "2", Low: "1", Volume: "1", Trades: 1,
			})
		}
		return candles, nil
	}
	return fetch, &calls
}

func TestEnsureChartReadyHydratesXyzDefaultDependenciesOnce(t *testing.T) {
	fetch, calls := readinessFetcher(t)
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()

	if err := s.EnsureChartReady(context.Background(), "xyz:GOLD", chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartReady: %v", err)
	}
	for _, interval := range []string{chartrequirements.DefaultTimeframe, "5m", "30m"} {
		key := "xyz:GOLD|" + interval
		if (*calls)[key] == 0 {
			t.Fatalf("default dependency %s was not fetched: %v", key, *calls)
		}
	}

	before := map[string]int{}
	for key, count := range *calls {
		before[key] = count
	}
	if err := s.EnsureChartReady(context.Background(), "xyz:GOLD", chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("second EnsureChartReady: %v", err)
	}
	for key, count := range before {
		if (*calls)[key] != count {
			t.Fatalf("ready dependency %s refetched: before=%d after=%d", key, count, (*calls)[key])
		}
	}
}

func TestEnsureChartReadyRepairsRestoredGapAndDegradation(t *testing.T) {
	fetch, _ := readinessFetcher(t)
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()
	s.PrepareChartRequirements("xyz:NVDA", chartrequirements.DefaultTimeframe)
	now := time.Now().UnixMilli()

	for _, requirement := range chartrequirements.SeriesForChart(chartrequirements.DefaultTimeframe) {
		ser := s.getSeries("xyz:NVDA", requirement.Interval)
		ser.mu.Lock()
		ser.coverageStartMs = now - requirement.LookbackMs - 1
		ser.candles = []Candle{{
			OpenMs: now - 4*ser.intervalMs, CloseMs: now - 3*ser.intervalMs - 1,
			Symbol: "xyz:NVDA", Interval: requirement.Interval,
			Open: "1", Close: "2", High: "2", Low: "1", Volume: "1", Trades: 1,
		}}
		ser.degraded = true
		ser.unverifiedGapFromMs = now - 3*ser.intervalMs
		ser.gapGen = 1
		ser.mu.Unlock()
	}

	if err := s.EnsureChartReady(context.Background(), "xyz:NVDA", chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartReady: %v", err)
	}
	for _, requirement := range chartrequirements.SeriesForChart(chartrequirements.DefaultTimeframe) {
		ser := s.getSeries("xyz:NVDA", requirement.Interval)
		ser.mu.RLock()
		ready := seriesRequirementReadyLocked(ser, requirement.LookbackMs, time.Now().UnixMilli())
		gap, degraded := ser.unverifiedGapFromMs, ser.degraded
		ser.mu.RUnlock()
		if !ready || gap != 0 || degraded {
			t.Fatalf("%s not repaired: ready=%v gap=%d degraded=%v", requirement.Interval, ready, gap, degraded)
		}
	}
}

func TestEnsureChartReadyConvergesWhenWebsocketAdvancesGapDuringRepair(t *testing.T) {
	baseFetch, calls := readinessFetcher(t)
	var s *Store
	var advanceOnce sync.Once
	fetch := func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		candles, err := baseFetch(ctx, coin, interval, startMs, endMs)
		if err == nil && coin == "ETH" && interval == "30m" {
			advanceOnce.Do(func() {
				ser := s.getSeries(coin, interval)
				ser.mu.Lock()
				ser.gapGen++
				ser.unverifiedGapFromMs = endMs - 2*ser.intervalMs
				ser.mu.Unlock()
			})
		}
		return candles, err
	}

	s = New(fetch, 1_000_000)
	s.OnMarketWSReconnect()
	if err := s.EnsureChartReady(context.Background(), "ETH", chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartReady: %v", err)
	}
	if got := (*calls)["ETH|30m"]; got < 2 {
		t.Fatalf("30m repair did not retry after gap generation advanced: calls=%d", got)
	}
	var lookbackMs int64
	for _, requirement := range chartrequirements.SeriesForChart(chartrequirements.DefaultTimeframe) {
		if requirement.Interval == "30m" {
			lookbackMs = requirement.LookbackMs
			break
		}
	}
	ser := s.getSeries("ETH", "30m")
	ser.mu.RLock()
	ready := seriesRequirementReadyLocked(ser, lookbackMs, time.Now().UnixMilli())
	gap := ser.unverifiedGapFromMs
	ser.mu.RUnlock()
	if !ready || gap != 0 {
		t.Fatalf("30m series did not converge: ready=%v gap=%d", ready, gap)
	}
}

func TestReadyXyzTwoHourServeIsCvdEnrichedWithoutRequestHydration(t *testing.T) {
	fetch, calls := readinessFetcher(t)
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()
	if err := s.EnsureChartReady(context.Background(), "xyz:CL", "2h"); err != nil {
		t.Fatalf("EnsureChartReady: %v", err)
	}

	before := 0
	for _, count := range *calls {
		before += count
	}
	now := time.Now().UnixMilli()
	body := map[string]interface{}{"type": "candleSnapshot", "req": map[string]interface{}{
		"coin": "xyz:CL", "interval": "2h",
		"startTime": now - int64(165*24*time.Hour/time.Millisecond), "endTime": now,
	}}
	payload, ok := s.ServeInfoRequest(body)
	if !ok {
		t.Fatal("ready default chart was not served from the store")
	}
	var candles []Candle
	if err := json.Unmarshal(payload, &candles); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(candles) == 0 || candles[len(candles)-1].CvdDelta == nil {
		t.Fatalf("first ready 2h serve was not CVD enriched: %+v", candles)
	}
	after := 0
	for _, count := range *calls {
		after += count
	}
	if after != before {
		t.Fatalf("ServeInfoRequest triggered hydration: before=%d after=%d", before, after)
	}
}

func TestRecentRestVerificationKeepsSparseFeedShedSeriesServeable(t *testing.T) {
	now := time.Now().UnixMilli()
	interval := int64(2 * time.Hour / time.Millisecond)
	sparse := []Candle{{OpenMs: now - 3*24*60*60*1000, Interval: "2h"}}
	if requestIsHistoricalOrTailFresh(sparse, interval, 0, now, now) {
		t.Fatal("old sparse tail without REST verification should not be considered fresh")
	}
	if !requestIsHistoricalOrTailFresh(sparse, interval, now, now, now) {
		t.Fatal("complete REST verification through now should vouch for a sparse no-trade tail")
	}
}

func TestRestoredCompleteSeriesIsHistoryReadyWithoutFetch(t *testing.T) {
	fetch, calls := readinessFetcher(t)
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()
	s.PrepareChartRequirements("BTC", chartrequirements.DefaultTimeframe)
	now := time.Now().UnixMilli()

	for _, requirement := range chartrequirements.SeriesForChart(chartrequirements.DefaultTimeframe) {
		ser := s.getSeries("BTC", requirement.Interval)
		ms := ser.intervalMs
		start := now - requirement.LookbackMs
		start -= start % ms
		candles := make([]Candle, 0, 8)
		for open := start; open < now; open += ms {
			candles = append(candles, Candle{
				OpenMs: open, CloseMs: open + ms - 1, Symbol: "BTC", Interval: requirement.Interval,
				Open: "1", Close: "2", High: "2", Low: "1", Volume: "1", Trades: 1,
			})
			if len(candles) >= 8 {
				break
			}
		}
		ser.mu.Lock()
		ser.candles = candles
		ser.coverageStartMs = now - requirement.LookbackMs - 1
		ser.verifiedThroughMs = now // live edge already fresh from a recent save
		ser.degraded = true
		ser.unverifiedGapFromMs = 0
		ser.mu.Unlock()
	}

	before := map[string]int{}
	for key, count := range *calls {
		before[key] = count
	}
	if err := s.EnsureChartReady(context.Background(), "BTC", chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartReady: %v", err)
	}
	for key, count := range *calls {
		if count != before[key] {
			t.Fatalf("history-ready restored series fetched %s: before=%d after=%d full=%v", key, before[key], count, *calls)
		}
	}

	// Historical range must serve while still degraded.
	body := map[string]interface{}{"type": "candleSnapshot", "req": map[string]interface{}{
		"coin": "BTC", "interval": chartrequirements.DefaultTimeframe,
		"startTime": now - int64(10*24*time.Hour/time.Millisecond), "endTime": now - int64(5*24*time.Hour/time.Millisecond),
	}}
	if _, ok := s.ServeInfoRequest(body); !ok {
		t.Fatal("expected historical serve from degraded restored series")
	}
}

func TestEnsureChartReadyAcceptsUpstreamRetentionCap(t *testing.T) {
	fetch, calls := readinessFetcher(t)
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()
	s.PrepareChartRequirements("PURR", chartrequirements.DefaultTimeframe)
	now := time.Now().UnixMilli()

	for _, requirement := range chartrequirements.SeriesForChart(chartrequirements.DefaultTimeframe) {
		ser := s.getSeries("PURR", requirement.Interval)
		capLookback := chartrequirements.ReachableLookbackMs(requirement.Interval, requirement.LookbackMs)
		start := now - capLookback
		ser.mu.Lock()
		ser.candles = []Candle{{
			OpenMs: start, CloseMs: start + ser.intervalMs - 1,
			Symbol: "PURR", Interval: requirement.Interval,
			Open: "1", Close: "2", High: "2", Low: "1", Volume: "1", Trades: 1,
		}}
		ser.coverageStartMs = start
		ser.verifiedThroughMs = now
		ser.degraded = true
		ser.unverifiedGapFromMs = 0
		ser.mu.Unlock()
	}

	if err := s.EnsureChartReady(context.Background(), "PURR", chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartReady: %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("retention-capped restored series must not REST: %v", *calls)
	}
}

func TestEnsureChartReadyStillHydratesShallowCoverage(t *testing.T) {
	fetch, calls := readinessFetcher(t)
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()
	s.PrepareChartRequirements("ETHFI", chartrequirements.DefaultTimeframe)
	now := time.Now().UnixMilli()
	ser := s.getSeries("ETHFI", "30m")
	start := now - 10*testDayMs
	ser.mu.Lock()
	ser.candles = []Candle{{
		OpenMs: start, CloseMs: start + ser.intervalMs - 1,
		Symbol: "ETHFI", Interval: "30m",
		Open: "1", Close: "2", High: "2", Low: "1", Volume: "1", Trades: 1,
	}}
	ser.coverageStartMs = start
	ser.degraded = true
	ser.mu.Unlock()

	if err := s.EnsureChartReady(context.Background(), "ETHFI", chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartReady: %v", err)
	}
	if (*calls)["ETHFI|30m"] == 0 {
		t.Fatal("shallow 30m coverage must still hydrate")
	}
}

func TestEnsureChartUniverseDefaultOnlySkipsRemainderTimeframes(t *testing.T) {
	fetch, calls := readinessFetcher(t)
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()

	if err := s.EnsureChartUniverse(context.Background(), []string{"SOL"}, chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartUniverse: %v", err)
	}
	for _, interval := range chartrequirements.RemainderStartupTimeframes() {
		key := "SOL|" + interval
		if (*calls)[key] != 0 {
			t.Fatalf("admit path fetched remainder timeframe %s: %v", key, *calls)
		}
	}
	if (*calls)["SOL|"+chartrequirements.DefaultTimeframe] == 0 || (*calls)["SOL|5m"] == 0 || (*calls)["SOL|30m"] == 0 {
		t.Fatalf("admit path missed default dependencies: %v", *calls)
	}

	for _, tf := range chartrequirements.RemainderStartupTimeframes() {
		s.WarmDisplay("SOL", tf)
	}
	if (*calls)["SOL|1h"] == 0 {
		t.Fatalf("remainder did not hydrate 1h: %v", *calls)
	}
}

func TestEnsureChartUniverseSkipsFailedMarket(t *testing.T) {
	calls := map[string]int{}
	fetch := func(_ context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		calls[coin+"|"+interval]++
		if coin == "DEAD" {
			return nil, nil
		}
		ms := intervalMs(interval)
		first := endMs - 2*ms
		return []Candle{{
			OpenMs: first, CloseMs: first + ms - 1, Symbol: coin, Interval: interval,
			Open: "1", Close: "2", High: "2", Low: "1", Volume: "1", Trades: 1,
		}}, nil
	}
	s := New(fetch, 1_000_000)
	s.OnMarketWSReconnect()
	if err := s.EnsureChartUniverse(context.Background(), []string{"DEAD", "SOL"}, chartrequirements.DefaultTimeframe); err != nil {
		t.Fatalf("EnsureChartUniverse: %v", err)
	}
	if calls["SOL|"+chartrequirements.DefaultTimeframe] == 0 {
		t.Fatalf("healthy market was not hydrated: %v", calls)
	}
}

func TestRestoreCandlesSkipsMergeWhenSorted(t *testing.T) {
	sorted := []Candle{
		{OpenMs: 100, Trades: 1},
		{OpenMs: 200, Trades: 2},
		{OpenMs: 300, Trades: 3},
	}
	got := restoreCandles(sorted)
	if len(got) != 3 || got[1].OpenMs != 200 {
		t.Fatalf("restoreCandles sorted: %+v", got)
	}
	// Mutating the input must not affect the restored slice.
	sorted[1].Trades = 99
	if got[1].Trades != 2 {
		t.Fatal("restoreCandles must copy")
	}

	unsorted := []Candle{
		{OpenMs: 300, Trades: 1},
		{OpenMs: 100, Trades: 2},
		{OpenMs: 100, Trades: 9}, // dup, higher trades wins
	}
	got = restoreCandles(unsorted)
	if len(got) != 2 || got[0].OpenMs != 100 || got[0].Trades != 9 || got[1].OpenMs != 300 {
		t.Fatalf("restoreCandles merge fallback: %+v", got)
	}
}
