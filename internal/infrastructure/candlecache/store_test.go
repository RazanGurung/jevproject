package candlecache

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"hyperliquid-go/internal/chartrequirements"
)

const h8 = int64(8 * 60 * 60 * 1000)

func mkCandle(openMs int64, trades int64) Candle {
	return Candle{
		OpenMs:   openMs,
		CloseMs:  openMs + h8 - 1,
		Symbol:   "BTC",
		Interval: "8h",
		Open:     "100",
		Close:    "101",
		High:     "102",
		Low:      "99",
		Volume:   "5",
		Trades:   trades,
	}
}

// newWarmStore returns a store with one BTC|8h series covering
// [coverageStart, coverageStart + n*interval), WS marked connected.
func newWarmStore(t *testing.T, coverageStart int64, n int) *Store {
	t.Helper()
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		return nil, fmt.Errorf("unexpected fetch")
	}, 400)
	s.OnMarketWSReconnect()
	s.RegisterSeries("BTC", "8h", 63*dayMs)
	candles := make([]Candle, 0, n)
	for i := 0; i < n; i++ {
		candles = append(candles, mkCandle(coverageStart+int64(i)*h8, 10))
	}
	ser := s.getSeries("BTC", "8h")
	ser.mu.Lock()
	ser.candles = candles
	ser.coverageStartMs = coverageStart
	ser.mu.Unlock()
	return s
}

func snapshotBody(coin, interval string, start, end interface{}) map[string]interface{} {
	return map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin":      coin,
			"interval":  interval,
			"startTime": start,
			"endTime":   end,
		},
	}
}

func servedCandles(t *testing.T, payload []byte) []Candle {
	t.Helper()
	var got []Candle
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("served payload not a candle array: %v", err)
	}
	return got
}

// ServeInfoRequest is the entire proxy-side serve/passthrough decision; a
// wrong slice silently corrupts charts, a wrong decline just loses the win.
func TestServeInfoRequest(t *testing.T) {
	base := int64(1_700_000_000_000)
	s := newWarmStore(t, base, 10) // covers [base, base+10*8h)

	t.Run("serves inclusive range slice", func(t *testing.T) {
		payload, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base+2*h8, base+5*h8))
		if !ok {
			t.Fatal("expected serve")
		}
		got := servedCandles(t, payload)
		if len(got) != 4 {
			t.Fatalf("got %d candles, want 4 (both boundaries inclusive)", len(got))
		}
		if got[0].OpenMs != base+2*h8 || got[3].OpenMs != base+5*h8 {
			t.Fatalf("slice bounds wrong: first=%d last=%d", got[0].OpenMs, got[3].OpenMs)
		}
	})

	t.Run("string timestamps coerce", func(t *testing.T) {
		payload, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h",
			fmt.Sprintf("%d", base), fmt.Sprintf("%d", base+9*h8)))
		if !ok {
			t.Fatal("expected serve with string timestamps")
		}
		if got := servedCandles(t, payload); len(got) != 10 {
			t.Fatalf("got %d candles, want 10", len(got))
		}
	})

	t.Run("empty covered range serves empty array not null", func(t *testing.T) {
		s2 := newWarmStore(t, base, 0)
		ser := s2.getSeries("BTC", "8h")
		ser.mu.Lock()
		ser.coverageStartMs = base
		ser.mu.Unlock()
		payload, ok := s2.ServeInfoRequest(snapshotBody("BTC", "8h", base, base+h8))
		if !ok {
			t.Fatal("expected serve")
		}
		if string(payload) != "[]" {
			t.Fatalf("payload = %s, want []", payload)
		}
	})

	declines := []struct {
		name string
		body map[string]interface{}
	}{
		{"start before coverage", snapshotBody("BTC", "8h", base-h8, base+h8)},
		{"unregistered coin", snapshotBody("ETH", "8h", base, base+h8)},
		{"unregistered interval", snapshotBody("BTC", "1h", base, base+h8)},
		{"missing req", map[string]interface{}{"type": "candleSnapshot"}},
		{"end before start", snapshotBody("BTC", "8h", base+h8, base)},
		{"zero start", snapshotBody("BTC", "8h", 0, base)},
	}
	for _, tc := range declines {
		t.Run("declines: "+tc.name, func(t *testing.T) {
			if _, ok := s.ServeInfoRequest(tc.body); ok {
				t.Fatal("expected passthrough, got serve")
			}
		})
	}

	t.Run("degraded serves history but not a stale live edge", func(t *testing.T) {
		s.OnMarketWSDown()
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, base+h8)); !ok {
			t.Fatal("immutable history must still serve while degraded")
		}
		now := time.Now().UnixMilli()
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now)); ok {
			t.Fatal("stale degraded live-edge must passthrough until a recent verify")
		}
		ser := s.getSeries("BTC", "8h")
		ser.mu.Lock()
		ser.verifiedThroughMs = now
		ser.mu.Unlock()
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now)); !ok {
			t.Fatal("recently verified degraded live-edge may serve from memory")
		}
	})

	t.Run("shed permanent feed serves history and refreshes an aged live tail", func(t *testing.T) {
		now := time.Now().UnixMilli()
		staleBase := now - 5*h8
		s := newWarmStore(t, staleBase, 3)
		ser := s.getSeries("BTC", "8h")
		s.OnCandleFeedDropped("BTC", "8h")
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", staleBase, staleBase+2*h8)); !ok {
			t.Fatal("immutable historical range should remain cacheable after feed shedding")
		}
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", staleBase, now)); ok {
			t.Fatal("aged live tail must refresh through REST")
		}

		freshOpen := now - h8
		s.applyFetchedRange(ser, []Candle{mkCandle(freshOpen, 20)}, staleBase, now, 0)
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", staleBase, now)); !ok {
			t.Fatal("fresh REST merge should make a shed series temporarily servable")
		}
	})

	t.Run("declines before first preload", func(t *testing.T) {
		s2 := New(nil, 400)
		s2.RegisterSeries("BTC", "8h", 63*dayMs)
		if _, ok := s2.ServeInfoRequest(snapshotBody("BTC", "8h", base, base+h8)); ok {
			t.Fatal("expected decline with zero coverage")
		}
	})
}

func TestSeriesLookbackPromotionIsMonotonicAndSurvivesPrune(t *testing.T) {
	now := time.Now()
	s := New(nil, 400)
	s.RegisterSeries("BTC", "4h", 175*dayMs)
	s.RegisterSeries("BTC", "4h", 600*dayMs)
	s.RegisterSeries("BTC", "4h", 30*dayMs)

	ser := s.getSeries("BTC", "4h")
	ser.mu.Lock()
	if ser.lookbackMs != 600*dayMs {
		ser.mu.Unlock()
		t.Fatalf("promoted lookback = %d, want 600d", ser.lookbackMs)
	}
	oldOpen := now.Add(-500 * 24 * time.Hour).UnixMilli()
	recentOpen := now.Add(-time.Hour).UnixMilli()
	ser.candles = []Candle{
		{OpenMs: oldOpen, CloseMs: oldOpen + 4*60*60*1000 - 1, Symbol: "BTC", Interval: "4h"},
		{OpenMs: recentOpen, CloseMs: recentOpen + 4*60*60*1000 - 1, Symbol: "BTC", Interval: "4h"},
	}
	ser.coverageStartMs = oldOpen
	ser.mu.Unlock()

	s.pruneOnce(now)
	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if ser.lookbackMs != 600*dayMs {
		t.Fatalf("prune lowered lookback to %d", ser.lookbackMs)
	}
	if len(ser.candles) != 2 || ser.candles[0].OpenMs != oldOpen {
		t.Fatalf("promoted deep candle was pruned: %+v", ser.candles)
	}
}

func TestHydrateInfoRequestPromotesLiveDepthWithoutForegroundPassthrough(t *testing.T) {
	now := time.Now().UnixMilli()
	fetchStarted := make(chan struct{}, 1)
	releaseFetch := make(chan struct{})
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		if coin == "BTC" && interval == "4h" {
			select {
			case fetchStarted <- struct{}{}:
			default:
			}
			select {
			case <-releaseFetch:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return nil, nil
	}, 4000)
	s.RegisterSeries("BTC", "4h", 175*dayMs)

	body := snapshotBody("BTC", "4h", now-600*dayMs, now)
	if payload, ok := s.HydrateInfoRequest(body); ok || payload != nil {
		t.Fatalf("cold hydrate = (%s, %v), want immediate pending miss", payload, ok)
	}
	ser := s.getSeries("BTC", "4h")
	ser.mu.RLock()
	lookback := ser.lookbackMs
	ser.mu.RUnlock()
	if lookback < 600*dayMs+intervalMs("4h") {
		t.Fatalf("live hydrate lookback = %d, want 600d plus one 4h overlap bucket", lookback)
	}
	select {
	case <-fetchStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("hydrate did not schedule the background warm")
	}
	close(releaseFetch)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := s.HydrateInfoRequest(body); ok {
			t.Fatal("empty REST must not pin coverage as a warmed hit")
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if _, ok := s.HydrateInfoRequest(body); ok {
		t.Fatal("empty REST must not pin coverage as a warmed hit")
	}
}

func TestApplyVerifiedRangeEmptyDoesNotPinColdOrLiveTail(t *testing.T) {
	now := time.Now().UnixMilli()
	s := New(func(context.Context, string, string, int64, int64) ([]Candle, error) {
		return nil, fmt.Errorf("unexpected fetch")
	}, 4000)
	s.OnMarketWSReconnect()
	s.RegisterSeries("NEW", "2h", 190*dayMs)
	ser := s.getSeries("NEW", "2h")
	start := now - 190*dayMs
	s.applyVerifiedRange(ser, nil, start, now, 0, true)
	ser.mu.RLock()
	coverage := ser.coverageStartMs
	ser.mu.RUnlock()
	if coverage != 0 {
		t.Fatalf("empty REST pinned coverage on a cold series: %d", coverage)
	}
	if !s.NeedsWarm("NEW", "2h") {
		t.Fatal("cold empty series must still need warm")
	}

	live := Candle{
		OpenMs: now - intervalMs("2h"), CloseMs: now - 1, Symbol: "NEW", Interval: "2h",
		Open: "1", Close: "1", High: "1", Low: "1", Volume: "1", Trades: 1,
	}
	ser.mu.Lock()
	ser.candles = []Candle{live}
	ser.mu.Unlock()
	s.applyVerifiedRange(ser, nil, start, now, 0, true)
	ser.mu.RLock()
	coverage = ser.coverageStartMs
	ser.mu.RUnlock()
	if coverage == start {
		t.Fatal("empty REST must not claim lookback start when only a live tail exists")
	}
	if !s.NeedsWarm("NEW", "2h") {
		t.Fatal("live-tail series after empty REST must still need warm")
	}
}

func TestHistoricalHydrateCannotInflatePermanentRetention(t *testing.T) {
	now := time.Now().UnixMilli()
	s := New(func(context.Context, string, string, int64, int64) ([]Candle, error) {
		return nil, nil
	}, 4000)
	historicalEnd := now - 30*dayMs
	s.HydrateInfoRequest(snapshotBody("BTC", "4h", historicalEnd-600*dayMs, historicalEnd))
	ser := s.getSeries("BTC", "4h")
	if ser == nil {
		t.Fatal("historical hydrate should register the supported series")
	}
	ser.mu.RLock()
	lookback := ser.lookbackMs
	ser.mu.RUnlock()
	if lookback != lookbackForInterval("4h") {
		t.Fatalf("historical request inflated lookback to %d, want default %d", lookback, lookbackForInterval("4h"))
	}
}

func wsCandleMsg(c Candle) map[string]interface{} {
	return map[string]interface{}{
		"channel": "candle",
		"data": map[string]interface{}{
			"t": float64(c.OpenMs), "T": float64(c.CloseMs),
			"s": c.Symbol, "i": c.Interval,
			"o": c.Open, "c": c.Close, "h": c.High, "l": c.Low,
			"v": c.Volume, "n": float64(c.Trades),
		},
	}
}

// ApplyWSCandle keeps tails fresh; a wrong merge serves bad closes, a missed
// gap serves holes.
func TestApplyWSCandle(t *testing.T) {
	base := int64(1_700_000_000_000)

	lastCandle := func(s *Store) Candle {
		ser := s.getSeries("BTC", "8h")
		ser.mu.RLock()
		defer ser.mu.RUnlock()
		return ser.candles[len(ser.candles)-1]
	}
	isDegraded := func(s *Store) bool {
		ser := s.getSeries("BTC", "8h")
		ser.mu.RLock()
		defer ser.mu.RUnlock()
		return ser.degraded
	}

	t.Run("in-place tail update with higher trade count", func(t *testing.T) {
		s := newWarmStore(t, base, 3)
		update := mkCandle(base+2*h8, 50)
		update.Close = "200"
		s.ApplyWSCandle(wsCandleMsg(update))
		if got := lastCandle(s); got.Close != "200" || got.Trades != 50 {
			t.Fatalf("tail not updated: %+v", got)
		}
	})

	t.Run("lower trade count does not regress tail", func(t *testing.T) {
		s := newWarmStore(t, base, 3)
		stale := mkCandle(base+2*h8, 1)
		stale.Close = "1"
		s.ApplyWSCandle(wsCandleMsg(stale))
		if got := lastCandle(s); got.Close == "1" {
			t.Fatal("stale snapshot overwrote fresher tail")
		}
	})

	t.Run("1M calendar-month append is contiguous", func(t *testing.T) {
		jan := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
		feb := time.Date(2026, time.February, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
		s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			return nil, fmt.Errorf("unexpected fetch")
		}, 400)
		s.OnMarketWSReconnect()
		s.RegisterSeries("BTC", "1M", 3100*dayMs)
		ser := s.getSeries("BTC", "1M")
		ser.mu.Lock()
		ser.candles = []Candle{{
			OpenMs: jan, CloseMs: feb - 1, Symbol: "BTC", Interval: "1M",
			Open: "100", Close: "101", High: "102", Low: "99", Volume: "5", Trades: 10,
		}}
		ser.coverageStartMs = jan
		ser.mu.Unlock()

		next := Candle{
			OpenMs: feb, CloseMs: time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC).UnixMilli() - 1,
			Symbol: "BTC", Interval: "1M",
			Open: "101", Close: "110", High: "111", Low: "100", Volume: "8", Trades: 4,
		}
		s.ApplyWSCandle(wsCandleMsg(next))
		ser.mu.RLock()
		defer ser.mu.RUnlock()
		if len(ser.candles) != 2 || ser.candles[1].OpenMs != feb {
			t.Fatalf("expected Feb append, got %+v", ser.candles)
		}
		if ser.unverifiedGapFromMs != 0 {
			t.Fatalf("calendar-month rollover must not set a gap, got %d", ser.unverifiedGapFromMs)
		}
	})

	t.Run("contiguous append", func(t *testing.T) {
		s := newWarmStore(t, base, 3)
		s.ApplyWSCandle(wsCandleMsg(mkCandle(base+3*h8, 1)))
		if got := lastCandle(s); got.OpenMs != base+3*h8 {
			t.Fatalf("expected appended candle, tail=%d", got.OpenMs)
		}
		if isDegraded(s) {
			t.Fatal("contiguous append must not degrade")
		}
	})

	t.Run("gap declines serving and enqueues backfill", func(t *testing.T) {
		s := newWarmStore(t, base, 3)
		s.ApplyWSCandle(wsCandleMsg(mkCandle(base+6*h8, 1)))
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, base+6*h8)); ok {
			t.Fatal("gap must decline serving until verified")
		}
		if isDegraded(s) {
			t.Fatal("a jump is gap state, not WS-down degradation (ticks clear degraded)")
		}
		select {
		case req := <-s.backfillCh:
			if req.fromMs != base+2*h8 {
				t.Fatalf("backfill from %d, want %d (last candle before gap)", req.fromMs, base+2*h8)
			}
		default:
			t.Fatal("expected a backfill request")
		}
	})

	t.Run("backfill cooldown suppresses repeat enqueue", func(t *testing.T) {
		s := newWarmStore(t, base, 3)
		s.ApplyWSCandle(wsCandleMsg(mkCandle(base+6*h8, 1)))
		<-s.backfillCh
		s.ApplyWSCandle(wsCandleMsg(mkCandle(base+9*h8, 1)))
		select {
		case <-s.backfillCh:
			t.Fatal("second backfill enqueued inside cooldown")
		default:
		}
	})

	t.Run("contiguous candle clears degraded after reconnect", func(t *testing.T) {
		s := newWarmStore(t, base, 3)
		s.OnMarketWSDown()
		s.OnMarketWSReconnect()
		if !isDegraded(s) {
			t.Fatal("reconnect alone must not clear degraded")
		}
		s.ApplyWSCandle(wsCandleMsg(mkCandle(base+2*h8, 99)))
		if isDegraded(s) {
			t.Fatal("contiguous candle after reconnect should clear degraded")
		}
	})

	t.Run("unregistered series ignored", func(t *testing.T) {
		s := newWarmStore(t, base, 3)
		c := mkCandle(base, 1)
		c.Symbol = "DOGE"
		s.ApplyWSCandle(wsCandleMsg(c)) // must not panic or enqueue
		select {
		case <-s.backfillCh:
			t.Fatal("unregistered coin enqueued backfill")
		default:
		}
	})
}

// seedWarmSeries seeds an existing store's BTC|8h series with n candles from
// coverageStart, marking coverage.
func seedWarmSeries(t *testing.T, s *Store, coverageStart int64, n int) *series {
	t.Helper()
	ser := s.getSeries("BTC", "8h")
	candles := make([]Candle, 0, n)
	for i := 0; i < n; i++ {
		candles = append(candles, mkCandle(coverageStart+int64(i)*h8, 10))
	}
	ser.mu.Lock()
	ser.candles = candles
	ser.coverageStartMs = coverageStart
	ser.mu.Unlock()
	return ser
}

// Repro of the post-sleep hole bug: buckets B3,B4 trade while the WS is
// down; B5 pushes on reconnect (jump detected, backfill queued); the next
// same-bucket tick used to clear `degraded` and the store served buckets
// [0 1 2 5] — the sleep window — as real data while the backfill sat behind
// the weight budget. Only an actual verification fetch may resume serving.
func TestUnverifiedGapBlocksServingUntilBackfill(t *testing.T) {
	base := int64(1_700_000_000_000)
	missing := []Candle{mkCandle(base+3*h8, 7), mkCandle(base+4*h8, 7)}
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		return missing, nil
	}, 600)
	s.OnMarketWSReconnect()
	s.RegisterSeries("BTC", "8h", 63*dayMs)
	seedWarmSeries(t, s, base, 3)

	s.OnMarketWSDown()
	s.OnMarketWSReconnect()
	s.ApplyWSCandle(wsCandleMsg(mkCandle(base+5*h8, 1))) // jump: B3,B4 missing
	s.ApplyWSCandle(wsCandleMsg(mkCandle(base+5*h8, 2))) // same-bucket tick ~1s later

	if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, base+5*h8)); ok {
		t.Fatal("served a range with an unverified hole (B3/B4 missing)")
	}

	req := <-s.backfillCh
	s.processBackfill(context.Background(), req)

	payload, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, base+5*h8))
	if !ok {
		t.Fatal("verified backfill should resume serving")
	}
	if got := servedCandles(t, payload); len(got) != 6 {
		t.Fatalf("got %d candles, want 6 (hole repaired)", len(got))
	}
}

// A backfill enqueue dropped on a full queue (every series gaps at once
// after a wake) must be retried on later ticks — previously lastBackfillAt
// was stamped before the send and the orphaned gap became a permanent hole.
func TestDroppedBackfillRetriesAfterCooldown(t *testing.T) {
	base := int64(1_700_000_000_000)
	s := New(nil, 600)
	s.OnMarketWSReconnect()
	s.RegisterSeries("BTC", "8h", 63*dayMs)
	ser := seedWarmSeries(t, s, base, 3)

	for i := 0; i < cap(s.backfillCh); i++ {
		s.backfillCh <- backfillReq{coin: "OTHER", interval: "8h", fromMs: 1}
	}
	s.ApplyWSCandle(wsCandleMsg(mkCandle(base+5*h8, 1))) // jump; enqueue dropped
	for len(s.backfillCh) > 0 {
		<-s.backfillCh
	}

	s.ApplyWSCandle(wsCandleMsg(mkCandle(base+5*h8, 2)))
	if len(s.backfillCh) != 0 {
		t.Fatal("retried inside the cooldown")
	}

	ser.mu.Lock()
	ser.lastBackfillAt = time.Now().Add(-2 * backfillCooldown)
	ser.mu.Unlock()
	s.ApplyWSCandle(wsCandleMsg(mkCandle(base+5*h8, 3)))
	select {
	case req := <-s.backfillCh:
		if req.coin != "BTC" || req.fromMs != base+2*h8 {
			t.Fatalf("retried wrong backfill: %+v", req)
		}
	default:
		t.Fatal("dropped backfill never retried — gap orphaned forever")
	}
	if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, base+5*h8)); ok {
		t.Fatal("must keep declining until the retried backfill verifies")
	}
}

// Only a passthrough whose range covers the gap may clear it; the frontend's
// short tail probes reach the present but must not vouch for an older hole.
func TestPassthroughGapClearing(t *testing.T) {
	now := time.Now().UnixMilli()
	base := now - now%h8 - 6*h8
	s := New(nil, 600)
	s.OnMarketWSReconnect()
	s.RegisterSeries("BTC", "8h", 63*dayMs)
	seedWarmSeries(t, s, base, 3)
	s.ApplyWSCandle(wsCandleMsg(mkCandle(base+5*h8, 1))) // jump: B3,B4 missing

	probe, _ := json.Marshal([]Candle{mkCandle(base+5*h8, 2)})
	s.MergePassthrough(snapshotBody("BTC", "8h", base+5*h8, now), probe)
	if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now)); ok {
		t.Fatal("present-reaching tail probe must not clear an older unverified gap")
	}

	covering, _ := json.Marshal([]Candle{mkCandle(base+3*h8, 7), mkCandle(base+4*h8, 7)})
	s.MergePassthrough(snapshotBody("BTC", "8h", base, now), covering)
	payload, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now))
	if !ok {
		t.Fatal("covering passthrough should clear the gap and resume serving")
	}
	if got := servedCandles(t, payload); len(got) != 6 {
		t.Fatalf("got %d candles, want 6 (hole repaired)", len(got))
	}
}

// MergePassthrough is the self-healing path: cold/degraded series get
// repaired by the requests they decline.
func TestMergePassthrough(t *testing.T) {
	// To-present semantics depend on the clock, so anchor near now.
	now := time.Now().UnixMilli()
	base := now - now%h8 - 2*h8 // covers [base, base+2*h8) reaching the present bucket

	t.Run("to-present request extends coverage and enables serving", func(t *testing.T) {
		s := New(nil, 400)
		s.OnMarketWSReconnect()
		s.RegisterSeries("BTC", "8h", 63*dayMs)

		resp, _ := json.Marshal([]Candle{mkCandle(base, 5), mkCandle(base+h8, 5)})
		s.MergePassthrough(snapshotBody("BTC", "8h", base, now), resp)

		payload, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now))
		if !ok {
			t.Fatal("expected serve after passthrough merge")
		}
		if got := servedCandles(t, payload); len(got) != 2 {
			t.Fatalf("got %d candles, want 2", len(got))
		}
	})

	t.Run("historical request on cold series must not claim coverage", func(t *testing.T) {
		s := New(nil, 400)
		s.OnMarketWSReconnect()
		s.RegisterSeries("BTC", "8h", 63*dayMs)

		// Pure scrollback: ends 10 buckets in the past, nothing covers
		// [histEnd, now] yet. Serving from this would show a hole.
		histStart, histEnd := base-20*h8, base-10*h8
		resp, _ := json.Marshal([]Candle{mkCandle(histStart, 5)})
		s.MergePassthrough(snapshotBody("BTC", "8h", histStart, histEnd), resp)

		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", histStart, now)); ok {
			t.Fatal("cold series claimed coverage from a historical fetch with a missing tail")
		}
	})

	t.Run("scrollback adjoining existing coverage extends it", func(t *testing.T) {
		s := newWarmStore(t, base, 2) // covers [base, now]
		resp, _ := json.Marshal([]Candle{mkCandle(base-2*h8, 5), mkCandle(base-h8, 5)})
		s.MergePassthrough(snapshotBody("BTC", "8h", base-2*h8, base-1), resp)

		payload, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base-2*h8, now))
		if !ok {
			t.Fatal("expected serve after adjoining scrollback merge")
		}
		if got := servedCandles(t, payload); len(got) != 4 {
			t.Fatalf("got %d candles, want 4", len(got))
		}
	})

	t.Run("does not clear degraded while WS down", func(t *testing.T) {
		s := newWarmStore(t, base, 2)
		s.OnMarketWSDown()
		resp, _ := json.Marshal([]Candle{mkCandle(base, 99)})
		s.MergePassthrough(snapshotBody("BTC", "8h", base, now), resp)
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now)); !ok {
			t.Fatal("history-ready series must keep serving from memory during a WS outage")
		}
	})

	t.Run("malformed response ignored", func(t *testing.T) {
		s := newWarmStore(t, base, 2)
		s.MergePassthrough(snapshotBody("BTC", "8h", base, base+h8), []byte(`{"error":"x"}`))
		ser := s.getSeries("BTC", "8h")
		ser.mu.RLock()
		defer ser.mu.RUnlock()
		if len(ser.candles) != 2 {
			t.Fatalf("candle count changed on malformed merge: %d", len(ser.candles))
		}
	})
}

// A request reaching further back than coverage serves CLIPPED to coverage
// when the covered tail is at least what upstream's 5000-candle cap would
// return, and kicks the budget-paced deepen. Passing it through instead can
// never complete coverage (the cap truncates every response) while burning IP
// allowance — the starvation loop that kept the 150d CVD source pinned.
func TestServeClippedToCoverageAndDeepen(t *testing.T) {
	now := time.Now().UnixMilli()
	const min = int64(60_000)

	makeSeeded := func(fetch FetchFunc, coveredMins int64) *Store {
		s := New(fetch, 600)
		s.OnMarketWSReconnect()
		s.RegisterSeries("BTC", "1m", 9000*min) // clamps to the 5000-bar retention cap
		ser := s.getSeries("BTC", "1m")
		start := now - coveredMins*min
		candles := make([]Candle, 0, coveredMins)
		for open := start; open <= now; open += min {
			c := Candle{OpenMs: open, CloseMs: open + min - 1, Symbol: "BTC", Interval: "1m", Open: "1", Close: "1", High: "1", Low: "1", Volume: "1"}
			candles = append(candles, c)
		}
		ser.mu.Lock()
		ser.candles = candles
		ser.coverageStartMs = start
		ser.mu.Unlock()
		return s
	}

	t.Run("serves the covered tail when coverage beats the cap", func(t *testing.T) {
		fetch := func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			return nil, fmt.Errorf("cap-complete 1m must not deepen")
		}
		s := makeSeeded(fetch, 6000) // 6000 covered minutes > 5000-candle cap span

		payload, ok := s.ServeInfoRequest(snapshotBody("BTC", "1m", now-8000*min, now))
		if !ok {
			t.Fatal("expected a clipped serve")
		}
		got := servedCandles(t, payload)
		if got[0].OpenMs != now-6000*min {
			t.Fatalf("clip start wrong: %d want %d", got[0].OpenMs, now-6000*min)
		}
		if s.NeedsWarm("BTC", "1m") || s.NeedsDisplayWarm("BTC", "1m") {
			t.Fatal("coverage past the 5000-bar cap must satisfy ready/warm")
		}
	})

	t.Run("declines when upstream's cap would return more than coverage holds", func(t *testing.T) {
		fetch := func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			return nil, fmt.Errorf("no fetch expected on the serve path")
		}
		s := makeSeeded(fetch, 3000) // 3000 covered minutes < 5000-candle cap span
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "1m", now-8000*min, now)); ok {
			t.Fatal("expected decline — passthrough returns more than the store holds")
		}
	})
}

// A passthrough response pinned at the upstream 5000-candle cap was truncated
// at the head of the requested range. Claiming the requested start as covered
// would pin the series shallow for the server's lifetime: WarmOnDemand would
// see "covered" and never deepen to the registered lookback, and the store
// would serve the missing head as if it were real history.
func TestTruncatedPassthroughDoesNotPinCoverage(t *testing.T) {
	now := time.Now().UnixMilli()
	var calls int32
	fetch := func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		atomic.AddInt32(&calls, 1)
		var out []Candle
		open := startMs - startMs%h8
		for ; open <= endMs; open += h8 {
			c := mkCandle(open, 10)
			c.Symbol, c.Interval = coin, interval
			out = append(out, c)
		}
		return out, nil
	}
	s := New(fetch, 600)
	s.OnMarketWSReconnect()
	s.RegisterSeries("BTC", "8h", 6000*h8) // clamps to 5000-bar retention
	registered := s.getSeries("BTC", "8h").lookbackMs

	// Requested 5100 bars back; upstream returned only the newest 5000.
	reqStart := now - 5100*h8
	firstReturned := now - 4999*h8
	resp := make([]Candle, 0, chartrequirements.UpstreamCandleCap)
	for i := 0; i < chartrequirements.UpstreamCandleCap; i++ {
		resp = append(resp, mkCandle(firstReturned+int64(i)*h8, 1))
	}
	payload, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	s.MergePassthrough(snapshotBody("BTC", "8h", reqStart, now), payload)

	ser := s.getSeries("BTC", "8h")
	ser.mu.RLock()
	cov := ser.coverageStartMs
	ser.mu.RUnlock()
	if cov != firstReturned {
		t.Fatalf("coverage claimed %d, want first returned candle %d (truncated head must not count)", cov, firstReturned)
	}

	// The shallow coverage must not satisfy WarmOnDemand — it deepens to the
	// reachable registered lookback (not the pre-clamp 6000-bar request).
	s.WarmOnDemand("BTC", "8h")
	if atomic.LoadInt32(&calls) == 0 {
		t.Fatal("WarmOnDemand skipped deepening a truncated series")
	}
	ser.mu.RLock()
	cov = ser.coverageStartMs
	ser.mu.RUnlock()
	// One-interval slack: the warm computes its own "now" a moment after ours.
	if cov > now-registered+h8 {
		t.Fatalf("coverage %d still shallower than the registered lookback %d", cov, registered)
	}
}

// WarmOnDemand is the background warm for cold/off-list series: after the proxy
// serves the first view via passthrough, it fills the full lookback (and
// registers + wires off-list coins) so follow-up requests serve from the store.
func TestWarmOnDemand(t *testing.T) {
	now := time.Now().UnixMilli()
	base := now - now%h8 - 5*h8

	makeStore := func(fetch FetchFunc) *Store {
		s := New(fetch, 600)
		s.OnMarketWSReconnect()
		return s
	}
	// fetch returns contiguous 8h candles spanning [startMs, endMs].
	rangeFetch := func(calls *int32) FetchFunc {
		return func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			atomic.AddInt32(calls, 1)
			var out []Candle
			open := startMs - startMs%h8
			for ; open <= endMs; open += h8 {
				c := mkCandle(open, 10)
				c.Symbol, c.Interval = coin, interval
				out = append(out, c)
			}
			return out, nil
		}
	}

	t.Run("warms a registered cold series so the store serves it", func(t *testing.T) {
		var calls int32
		s := makeStore(rangeFetch(&calls))
		s.RegisterSeries("BTC", "8h", 63*dayMs)

		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now)); ok {
			t.Fatal("cold series should not serve before warming")
		}
		s.WarmOnDemand("BTC", "8h")
		if calls != 1 {
			t.Fatalf("expected 1 fetch, got %d", calls)
		}
		// Coverage now reaches the present, so the cheap path serves next time.
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now)); !ok {
			t.Fatal("ServeInfoRequest should hit after warm")
		}
	})

	t.Run("auto-registers an off-list coin and fires onRegister once per series", func(t *testing.T) {
		var calls int32
		s := makeStore(rangeFetch(&calls))
		registered := map[[2]string]int{}
		var regMu sync.Mutex
		s.SetOnRegister(func(coin, interval string) {
			regMu.Lock()
			registered[[2]string{coin, interval}]++
			regMu.Unlock()
		})

		if s.getSeries("DOGE", "8h") != nil {
			t.Fatal("DOGE should be unregistered to start")
		}
		s.WarmOnDemand("DOGE", "8h")
		if s.getSeries("DOGE", "8h") == nil {
			t.Fatal("off-list coin should have been registered on demand")
		}
		if _, ok := s.ServeInfoRequest(snapshotBody("DOGE", "8h", base, now)); !ok {
			t.Fatal("off-list coin should serve from the store after warm")
		}
		regMu.Lock()
		defer regMu.Unlock()
		// The main series AND the 5m/30m CVD sources must each get their WS
		// subscription exactly once — a bare registration would leave the
		// source tails silently aging after the warm.
		for _, key := range [][2]string{{"DOGE", "8h"}, {"DOGE", "5m"}, {"DOGE", "30m"}} {
			if registered[key] != 1 {
				t.Fatalf("onRegister fired %d times for %v (want 1): %v", registered[key], key, registered)
			}
		}
		if len(registered) != 3 {
			t.Fatalf("onRegister fired for unexpected series: %v", registered)
		}
	})

	t.Run("leaves off-list coins on a non-preloaded interval to passthrough", func(t *testing.T) {
		var calls int32
		s := makeStore(rangeFetch(&calls))
		s.WarmOnDemand("DOGE", "3m") // 3m is outside DefaultSeries
		if s.getSeries("DOGE", "3m") != nil {
			t.Fatal("non-preloaded interval should not be registered")
		}
		if calls != 0 {
			t.Fatalf("expected no fetch for a non-preloaded interval, got %d", calls)
		}
	})

	t.Run("single-flights concurrent warms onto one fetch", func(t *testing.T) {
		var calls int32
		release := make(chan struct{})
		started := make(chan struct{}, 1)
		blockingFetch := func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			atomic.AddInt32(&calls, 1)
			select {
			case started <- struct{}{}:
			default:
			}
			<-release // hold so the second caller arrives mid-flight
			var out []Candle
			for open := startMs - startMs%h8; open <= endMs; open += h8 {
				c := mkCandle(open, 10)
				c.Symbol, c.Interval = coin, interval
				out = append(out, c)
			}
			return out, nil
		}
		s := makeStore(blockingFetch)
		s.RegisterSeries("BTC", "8h", 63*dayMs)

		go s.WarmOnDemand("BTC", "8h")
		<-started                   // first warm is in-flight, warming flag set
		s.WarmOnDemand("BTC", "8h") // must see the in-flight warm and return at once
		close(release)
		if calls != 1 {
			t.Fatalf("expected single-flight to collapse to 1 fetch, got %d", calls)
		}
	})

	t.Run("tail repair in flight still honors a deeper warm", func(t *testing.T) {
		var calls int32
		release := make(chan struct{})
		started := make(chan struct{}, 1)
		s := makeStore(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			atomic.AddInt32(&calls, 1)
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			c := mkCandle(endMs-h8, 10)
			c.Symbol, c.Interval = coin, interval
			return []Candle{c}, nil
		})
		s.RegisterSeries("BTC", "8h", 63*dayMs)
		ser := s.getSeries("BTC", "8h")
		ser.mu.Lock()
		ser.coverageStartMs = now - 2*h8
		ser.candles = []Candle{mkCandle(now-h8, 10)}
		ser.mu.Unlock()

		go s.repairOnDemand("BTC", "8h", now-2*h8)
		<-started
		s.WarmOnDemand("BTC", "8h")
		close(release)
		deadline := time.Now().Add(2 * time.Second)
		for atomic.LoadInt32(&calls) < 2 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if atomic.LoadInt32(&calls) < 2 {
			t.Fatalf("deeper warm dropped during tail repair: calls=%d", calls)
		}
	})

	t.Run("leaves the series cold when the warm fetch fails", func(t *testing.T) {
		s := makeStore(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			return nil, fmt.Errorf("upstream down")
		})
		s.RegisterSeries("BTC", "8h", 63*dayMs)
		s.WarmOnDemand("BTC", "8h")
		if _, ok := s.ServeInfoRequest(snapshotBody("BTC", "8h", base, now)); ok {
			t.Fatal("series should stay cold after a failed warm")
		}
	})

	// Regression: WarmOnDemand only single-flights per (coin, interval), so
	// warms for two DIFFERENT tickers clicked seconds apart used to fire their
	// real upstream fetches concurrently — a burst that could collide with
	// Hyperliquid's per-IP limit and 429 the interactive passthrough the user
	// was actively waiting on. fetchSem must serialize them regardless of the
	// weight budget, which only paces the average rate, not concurrency.
	t.Run("serializes background warms for different series so their fetches never overlap", func(t *testing.T) {
		var concurrent int32
		var maxConcurrent int32
		fetch := func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
			n := atomic.AddInt32(&concurrent, 1)
			for {
				m := atomic.LoadInt32(&maxConcurrent)
				if n <= m || atomic.CompareAndSwapInt32(&maxConcurrent, m, n) {
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
			atomic.AddInt32(&concurrent, -1)
			var out []Candle
			for open := startMs - startMs%h8; open <= endMs; open += h8 {
				c := mkCandle(open, 10)
				c.Symbol, c.Interval = coin, interval
				out = append(out, c)
			}
			return out, nil
		}
		s := makeStore(fetch)
		s.RegisterSeries("BTC", "8h", 63*dayMs)
		s.RegisterSeries("ETH", "8h", 63*dayMs)

		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); s.WarmOnDemand("BTC", "8h") }()
		go func() { defer wg.Done(); s.WarmOnDemand("ETH", "8h") }()
		wg.Wait()

		if maxConcurrent > 1 {
			t.Fatalf("expected background fetches for different series to serialize, saw %d concurrent", maxConcurrent)
		}
	})
}

func TestMergeCandlesConflict(t *testing.T) {
	older := mkCandle(1000, 5)
	older.Close = "old"
	newer := mkCandle(1000, 9)
	newer.Close = "new"

	merged := mergeCandles([]Candle{older}, []Candle{newer})
	if len(merged) != 1 || merged[0].Close != "new" {
		t.Fatalf("higher trade count should win: %+v", merged)
	}
	merged = mergeCandles([]Candle{newer}, []Candle{older})
	if len(merged) != 1 || merged[0].Close != "new" {
		t.Fatalf("lower trade count must not overwrite: %+v", merged)
	}
}

func TestPruneOnce(t *testing.T) {
	now := time.Now()
	// Old candles sit beyond lookback+slack; recent ones inside it.
	oldMs := now.UnixMilli() - 80*dayMs
	recentMs := now.UnixMilli() - h8
	s := New(nil, 400)
	s.RegisterSeries("BTC", "8h", 63*dayMs)
	ser := s.getSeries("BTC", "8h")
	ser.mu.Lock()
	ser.candles = []Candle{mkCandle(oldMs, 1), mkCandle(recentMs, 1)}
	ser.coverageStartMs = oldMs
	ser.mu.Unlock()

	s.pruneOnce(now)

	ser.mu.RLock()
	defer ser.mu.RUnlock()
	if len(ser.candles) != 1 || ser.candles[0].OpenMs != recentMs {
		t.Fatalf("prune kept wrong candles: %+v", ser.candles)
	}
	if ser.coverageStartMs == oldMs {
		t.Fatal("coverage must shrink with pruned candles or serving would claim pruned ranges")
	}
}

// The market-WS read goroutine writes while HTTP handlers read; this must
// hold under -race.
func TestConcurrentServeAndApply(t *testing.T) {
	base := time.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	base -= base % h8
	s := newWarmStore(t, base, 50)
	end := base + 50*h8

	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			s.ApplyWSCandle(wsCandleMsg(mkCandle(base+49*h8, int64(100+i))))
		}
	}()
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			s.ServeInfoRequest(snapshotBody("BTC", "8h", base, end))
		}
	}()
	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()
}

func TestLogFetchErrSkipsCanceled(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	logFetchErr("hydrate repair", "BTC", "5m", context.Canceled)
	if buf.Len() != 0 {
		t.Fatalf("canceled fetch logged %q", buf.String())
	}

	logFetchErr("hydrate repair", "BTC", "5m", fmt.Errorf("upstream HTTP 500"))
	if !strings.Contains(buf.String(), "hydrate repair failed coin=BTC interval=5m: upstream HTTP 500") {
		t.Fatalf("real fetch error was not logged: %q", buf.String())
	}
}
