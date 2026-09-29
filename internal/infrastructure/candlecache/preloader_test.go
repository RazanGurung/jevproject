package candlecache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestConfigFromEnvSnapshotInterval(t *testing.T) {
	t.Run("default", func(t *testing.T) {
		t.Setenv("PEZ_CANDLE_SNAPSHOT_INTERVAL", "")
		if got := ConfigFromEnv().SnapshotInterval; got != DefaultSnapshotInterval {
			t.Fatalf("default snapshot interval = %v, want %v", got, DefaultSnapshotInterval)
		}
	})

	t.Run("override", func(t *testing.T) {
		t.Setenv("PEZ_CANDLE_SNAPSHOT_INTERVAL", "45m")
		if got := ConfigFromEnv().SnapshotInterval; got != 45*time.Minute {
			t.Fatalf("snapshot interval = %v, want 45m", got)
		}
	})

	t.Run("rejects unsafe churn", func(t *testing.T) {
		t.Setenv("PEZ_CANDLE_SNAPSHOT_INTERVAL", "30s")
		if got := ConfigFromEnv().SnapshotInterval; got != DefaultSnapshotInterval {
			t.Fatalf("short snapshot interval = %v, want default %v", got, DefaultSnapshotInterval)
		}
	})
}

// SelectCoins decides what gets a warm cache; dropping a pinned tab or
// ignoring the cap changes startup cost and dashboard coverage.
func TestSelectCoins(t *testing.T) {
	rows := []CoinLiquidity{
		{Coin: "BTC", OINotional: 2000e6},
		{Coin: "ZEC", OINotional: 150e6},
		{Coin: "xyz:SPCX", OINotional: 250e6},
		{Coin: "NEAR", OINotional: 60e6},
		{Coin: "DUST", OINotional: 1e6},
		{Coin: "xyz:AAPL", OINotional: 12e6}, // pinned but below cutoff
	}
	pinned := []string{"BTC", "xyz:AAPL"}

	t.Run("pinned kept even below cutoff, others by OI desc", func(t *testing.T) {
		got := SelectCoins(rows, pinned, 30e6, 60)
		want := []string{"BTC", "xyz:AAPL", "xyz:SPCX", "ZEC", "NEAR"}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})

	t.Run("cap bounds additions but never evicts pinned", func(t *testing.T) {
		got := SelectCoins(rows, pinned, 30e6, 3)
		want := []string{"BTC", "xyz:AAPL", "xyz:SPCX"}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})

	t.Run("empty liquidity rows still warm pinned", func(t *testing.T) {
		got := SelectCoins(nil, pinned, 30e6, 60)
		if len(got) != 2 || got[0] != "BTC" || got[1] != "xyz:AAPL" {
			t.Fatalf("got %v, want pinned only", got)
		}
	})

	t.Run("duplicate pinned deduped", func(t *testing.T) {
		got := SelectCoins(nil, []string{"BTC", "BTC"}, 30e6, 60)
		if len(got) != 1 {
			t.Fatalf("got %v, want single BTC", got)
		}
	})
}

// fetchCall records one FetchFunc invocation.
type fetchCall struct {
	coin, interval string
	startMs, endMs int64
}

func recordingFetch(mu *sync.Mutex, calls *[]fetchCall, fail map[string]bool) FetchFunc {
	return func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		mu.Lock()
		*calls = append(*calls, fetchCall{coin, interval, startMs, endMs})
		mu.Unlock()
		if fail[coin+"|"+interval] {
			return nil, fmt.Errorf("boom")
		}
		ms := intervalMs(interval)
		var out []Candle
		for t := startMs - startMs%ms + ms; t < endMs; t += ms {
			out = append(out, Candle{OpenMs: t, CloseMs: t + ms - 1, Symbol: coin, Interval: interval, Trades: 1, Open: "1", Close: "1", High: "1", Low: "1", Volume: "0"})
		}
		return out, nil
	}
}

func TestWarmOnDemandFailureIsolation(t *testing.T) {
	var mu sync.Mutex
	var calls []fetchCall
	s := New(recordingFetch(&mu, &calls, map[string]bool{"ETH|8h": true}), 1_000_000)
	s.OnMarketWSReconnect()

	s.RegisterSeries("ETH", "8h", 2*dayMs)
	s.RegisterSeries("ETH", "1d", 5*dayMs)
	s.WarmOnDemand("ETH", "8h")
	s.WarmOnDemand("ETH", "1d")

	now := time.Now().UnixMilli()
	if _, ok := s.ServeInfoRequest(snapshotBody("ETH", "8h", now-dayMs, now)); ok {
		t.Fatal("failed series must decline")
	}
	if _, ok := s.ServeInfoRequest(snapshotBody("ETH", "1d", now-2*dayMs, now)); !ok {
		t.Fatal("sibling series should have warmed despite the 8h failure")
	}
}

// fetchChunked must split ranges past the 5000-candle response cap or long
// lookbacks silently truncate.
func TestFetchChunkedSplitsLargeRanges(t *testing.T) {
	var mu sync.Mutex
	var calls []fetchCall
	s := New(recordingFetch(&mu, &calls, nil), 1_000_000)
	s.RegisterSeries("BTC", "1m", 7*dayMs)

	end := time.Now().UnixMilli()
	start := end - 7*dayMs // 10080 1m candles → 3 chunks at 4500
	if _, err := s.fetchChunked(context.Background(), "BTC", "1m", start, end); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 3 {
		t.Fatalf("got %d chunks, want 3", len(calls))
	}
	if calls[0].startMs != start || calls[len(calls)-1].endMs != end {
		t.Fatalf("chunks don't cover range: %+v", calls)
	}
	for _, c := range calls {
		if count := (c.endMs - c.startMs) / 60_000; count > maxCandlesPerFetch {
			t.Fatalf("chunk exceeds cap: %d candles", count)
		}
	}
}

// The weight budget keeps warm-up from starving live traffic and, crucially,
// smooths the spend so the preloader can't dump a full minute's allowance at
// startup (a burst that 429s interactive chart loads). A small fetch within the
// burst ceiling passes immediately; draining a full minute's worth must throttle.
func TestWeightBudgetSmoothsBurst(t *testing.T) {
	now := time.Unix(0, 0)
	var slept time.Duration
	advance := func(d time.Duration) { slept += d; now = now.Add(d) }
	b := newWeightBudget(600, func() time.Time { return now }, advance)

	// A single fetch within the burst ceiling does not wait.
	if err := b.wait(context.Background(), 20); err != nil {
		t.Fatal(err)
	}
	if slept != 0 {
		t.Fatalf("a small fetch within the burst should not wait, slept %v", slept)
	}

	// Draining a full minute's allowance (12 * 50 = 600) cannot happen instantly:
	// past the burst ceiling the bucket throttles, spreading the work over time.
	for i := 0; i < 12; i++ {
		if err := b.wait(context.Background(), 50); err != nil {
			t.Fatal(err)
		}
	}
	if slept == 0 {
		t.Fatal("expected throttling once the burst ceiling is spent")
	}
	if slept > time.Minute {
		t.Fatalf("smoothing should spread roughly a minute of work, slept %v", slept)
	}
}

// TestWeightBudgetPenalizeForcesBackoff covers the live-429-feedback fix: a
// real 429 is ground truth that the configured perMin rate is currently too
// optimistic, so penalize() must force the next wait() to block even though
// the token bucket's own steady-rate accounting would otherwise allow it
// through immediately — and recover to normal timing afterward via the same
// continuous refill (it must not wedge the pacer permanently).
func TestWeightBudgetPenalizeForcesBackoff(t *testing.T) {
	now := time.Unix(0, 0)
	var slept time.Duration
	advance := func(d time.Duration) { slept += d; now = now.Add(d) }
	b := newWeightBudget(600, func() time.Time { return now }, advance)

	// Fully refilled: a small fetch would normally pass instantly.
	b.penalize()
	if err := b.wait(context.Background(), 20); err != nil {
		t.Fatal(err)
	}
	if slept == 0 {
		t.Fatal("expected penalize() to force a wait even within the normal burst ceiling")
	}
	firstWait := slept

	// The bucket must recover once real time actually passes — penalize() is a
	// one-off correction, not a standing reduction of the configured rate.
	now = now.Add(10 * time.Second)
	slept = 0
	if err := b.wait(context.Background(), 20); err != nil {
		t.Fatal(err)
	}
	if slept != 0 {
		t.Fatalf("budget should have recovered after real time passed, slept %v more", slept)
	}

	// penalize() must never make an already-negative balance (e.g. from a
	// burst of interactive charge() calls) less negative — it should only
	// ever remove surplus, never grant it.
	b.charge(500)
	b.penalize()
	slept = 0
	if err := b.wait(context.Background(), 20); err != nil {
		t.Fatal(err)
	}
	if slept < firstWait {
		t.Fatalf("penalize() must not shorten an existing negative balance's wait, got %v want >= %v", slept, firstWait)
	}
}

func TestWeightBudgetWaitCanceledReturnsImmediately(t *testing.T) {
	now := time.Unix(0, 0)
	var slept time.Duration
	advance := func(d time.Duration) { slept += d; now = now.Add(d) }
	b := newWeightBudget(600, func() time.Time { return now }, advance)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := b.wait(ctx, 20); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled wait err = %v, want context.Canceled", err)
	}
	if slept != 0 {
		t.Fatalf("canceled wait must not sleep, slept %v", slept)
	}
}

func TestWeightBudgetWaitCanceledDoesNotConsumeTokens(t *testing.T) {
	now := time.Unix(0, 0)
	var slept time.Duration
	advance := func(d time.Duration) { slept += d; now = now.Add(d) }
	b := newWeightBudget(600, func() time.Time { return now }, advance)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := b.wait(ctx, 20); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled wait err = %v, want context.Canceled", err)
	}

	slept = 0
	if err := b.wait(context.Background(), 20); err != nil {
		t.Fatal(err)
	}
	if slept != 0 {
		t.Fatalf("canceled wait must not take tokens from a full bucket, slept %v", slept)
	}
}

func TestWeightBudgetWaitCanceledWhileBlocked(t *testing.T) {
	b := newWeightBudget(600, time.Now, nil)
	b.penalize()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	started := time.Now()
	go func() { done <- b.wait(ctx, 20) }()
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("blocked wait err = %v, want context.Canceled", err)
		}
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("blocked wait should return on cancel promptly, took %v", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("wait did not return after cancel")
	}
}

func TestWeightBudgetQueuedWaitersCancelWithoutSerialSleep(t *testing.T) {
	b := newWeightBudget(800, time.Now, nil)
	b.penalize()

	ctx, cancel := context.WithCancel(context.Background())
	const n = 6
	done := make(chan error, n)
	started := time.Now()
	for i := 0; i < n; i++ {
		go func() { done <- b.wait(ctx, 20) }()
	}
	time.Sleep(80 * time.Millisecond)
	cancel()

	for i := 0; i < n; i++ {
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("waiter %d err = %v, want context.Canceled", i, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("queued waiters did not all return after cancel (got %d/%d)", i, n)
		}
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("queued waiters slept serially after cancel, took %v", elapsed)
	}
}

func TestFetchChunkedCanceledDoesNotFetch(t *testing.T) {
	fetched := 0
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		fetched++
		return nil, fmt.Errorf("should not fetch")
	}, 400)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.fetchChunked(ctx, "BTC", "1m", 1, 60_000)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("fetchChunked err = %v, want context.Canceled", err)
	}
	if fetched != 0 {
		t.Fatalf("fetcher called %d times on canceled ctx", fetched)
	}
}

func TestFetchChunkedCanceledDuringBudgetWaitDoesNotFetch(t *testing.T) {
	fetched := 0
	s := New(func(ctx context.Context, coin, interval string, startMs, endMs int64) ([]Candle, error) {
		fetched++
		return nil, fmt.Errorf("should not fetch")
	}, 600)
	s.budget.penalize()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := s.fetchChunked(ctx, "BTC", "1m", 1, 60_000)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("fetchChunked err = %v, want context.Canceled", err)
		}
		if fetched != 0 {
			t.Fatalf("fetcher called %d times after cancel during budget wait", fetched)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("fetchChunked did not return after cancel")
	}
}

func TestNewHTTPFetcherSendsDexAndRetries(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]interface{}
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		attempts++
		n := attempts
		mu.Unlock()
		if n == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		json.NewEncoder(w).Encode([]Candle{{OpenMs: 1000, Symbol: "xyz:GOLD", Interval: "30m", Trades: 1}})
	}))
	defer srv.Close()

	orig := fetchRetryDelays
	fetchRetryDelays = []time.Duration{time.Millisecond}
	defer func() { fetchRetryDelays = orig }()

	var rateLimitHits int
	fetch := NewHTTPFetcher(srv.Client(), srv.URL, func() { rateLimitHits++ })
	candles, err := fetch(context.Background(), "xyz:GOLD", "30m", 1, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if len(candles) != 1 {
		t.Fatalf("got %d candles, want 1", len(candles))
	}
	if rateLimitHits != 1 {
		t.Fatalf("got %d onRateLimited calls, want 1 for the single 429", rateLimitHits)
	}

	mu.Lock()
	defer mu.Unlock()
	if attempts != 2 {
		t.Fatalf("got %d attempts, want retry after 429", attempts)
	}
	req, _ := bodies[0]["req"].(map[string]interface{})
	if req["dex"] != "xyz" {
		t.Fatalf("builder-dex coin must carry req.dex, got %v", req)
	}
}

func TestFetchLiquidityComputesNotionalAndPrefix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["dex"] == "xyz" {
			// Bare per-dex symbol: must come back prefixed.
			fmt.Fprint(w, `[{"universe":[{"name":"GOLD"}]},[{"openInterest":"1000","markPx":"4000"}]]`)
			return
		}
		fmt.Fprint(w, `[{"universe":[{"name":"BTC"},{"name":"OLD","isDelisted":true}]},[{"openInterest":"2","markPx":"50000"},{"openInterest":"9","markPx":"9"}]]`)
	}))
	defer srv.Close()

	rows, err := FetchLiquidity(context.Background(), srv.Client(), srv.URL, []string{"", "xyz"})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, r := range rows {
		got[r.Coin] = r.OINotional
	}
	if got["BTC"] != 100000 {
		t.Fatalf("BTC OI notional = %v, want 100000", got["BTC"])
	}
	if got["xyz:GOLD"] != 4_000_000 {
		t.Fatalf("xyz:GOLD OI notional = %v, want 4000000 (prefixed)", got["xyz:GOLD"])
	}
	if _, ok := got["OLD"]; ok {
		t.Fatal("delisted coins must be excluded")
	}
}
