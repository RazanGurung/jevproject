package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"hyperliquid-go/internal/infrastructure/candlecache"
)

func testCandleBody() map[string]interface{} {
	return map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin":      "BTC",
			"interval":  "15m",
			"startTime": int64(1000),
			"endTime":   int64(2000),
		},
	}
}

// TestPassthroughCandleSnapshotSuccess covers the shared helper's happy path.
func TestPassthroughCandleSnapshotSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"t":1000,"T":1899999,"s":"BTC","i":"15m","o":"1","c":"2","h":"3","l":"0.5","v":"10","n":5}]`))
	}))
	defer srv.Close()

	sem := make(chan struct{}, 2)
	respBody, servedFromStore, canceled, status, upstreamBody, err := passthroughCandleSnapshot(context.Background(), srv.URL, sem, testCandleBody())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if servedFromStore || canceled || status != 0 || upstreamBody != "" {
		t.Fatalf("unexpected flags: servedFromStore=%v canceled=%v status=%d upstreamBody=%q", servedFromStore, canceled, status, upstreamBody)
	}
	if len(respBody) == 0 {
		t.Fatal("expected a non-empty response body")
	}
	if len(sem) != 0 {
		t.Fatalf("semaphore slot not released, held=%d", len(sem))
	}
}

func TestPassthroughCandleSnapshotEnrichesFirstResponseAfterMerge(t *testing.T) {
	now := time.Now().UnixMilli()
	twoHours := int64(2 * time.Hour / time.Millisecond)
	fiveMinutes := int64(5 * time.Minute / time.Millisecond)
	bucketOpen := now - now%twoHours

	store := candlecache.New(func(context.Context, string, string, int64, int64) ([]candlecache.Candle, error) {
		return nil, nil
	}, 4000)
	store.OnMarketWSReconnect()
	store.PrepareChartRequirements("BTC", "2h")
	recent := make([]candlecache.Candle, 0, 24)
	for open := bucketOpen; open < bucketOpen+twoHours; open += fiveMinutes {
		recent = append(recent, candlecache.Candle{
			OpenMs: open, CloseMs: open + fiveMinutes - 1, Symbol: "BTC", Interval: "5m",
			Open: "1", Close: "2", High: "2", Low: "1", Volume: "1", Trades: 1,
		})
	}
	recentJSON, _ := json.Marshal(recent)
	store.MergePassthrough(map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "BTC", "interval": "5m", "startTime": bucketOpen, "endTime": now,
		},
	}, recentJSON)

	chart := candlecache.Candle{
		OpenMs: bucketOpen, CloseMs: bucketOpen + twoHours - 1, Symbol: "BTC", Interval: "2h",
		Open: "1", Close: "2", High: "2", Low: "1", Volume: "24", Trades: 24,
	}
	rawChart, _ := json.Marshal([]candlecache.Candle{chart})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(rawChart)
	}))
	defer srv.Close()

	previousStore := runtime.candleStore
	runtime.candleStore = store
	defer func() { runtime.candleStore = previousStore }()
	body := map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "BTC", "interval": "2h", "startTime": bucketOpen, "endTime": now,
		},
	}
	respBody, _, _, _, _, err := passthroughCandleSnapshot(context.Background(), srv.URL, make(chan struct{}, 1), body)
	if err != nil {
		t.Fatalf("passthroughCandleSnapshot: %v", err)
	}
	var got []candlecache.Candle
	if err := json.Unmarshal(respBody, &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(got) != 1 || got[0].CvdDelta == nil {
		t.Fatalf("first passthrough response was not CVD-enriched: %+v", got)
	}
}

// TestPassthroughCandleSnapshot429 covers the failure path: status/upstreamBody
// are surfaced so the caller can reconstruct the same {error,status,body} JSON
// shape the client already knows how to detect as a throttle (isUpstreamThrottleError).
func TestPassthroughCandleSnapshot429(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer srv.Close()

	sem := make(chan struct{}, 2)
	respBody, servedFromStore, canceled, status, upstreamBody, err := passthroughCandleSnapshot(context.Background(), srv.URL, sem, testCandleBody())
	if err == nil {
		t.Fatal("expected an error for a 429 upstream response")
	}
	if servedFromStore || canceled {
		t.Fatalf("unexpected flags: servedFromStore=%v canceled=%v", servedFromStore, canceled)
	}
	if status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", status)
	}
	if upstreamBody == "" {
		t.Fatal("expected the truncated upstream body to be surfaced")
	}
	if respBody != nil {
		t.Fatal("expected no response body on failure")
	}
	if len(sem) != 0 {
		t.Fatalf("semaphore slot not released after failure, held=%d", len(sem))
	}
}

// TestPassthroughCandleSnapshotGivesUpWhenLaneIsFull covers cancellation via a
// full semaphore: a superseded/aborted request must not wait behind traffic
// it no longer needs.
func TestPassthroughCandleSnapshotGivesUpWhenLaneIsFull(t *testing.T) {
	sem := make(chan struct{}, 1)
	sem <- struct{}{} // fill the only slot
	defer func() { <-sem }()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	_, servedFromStore, canceled, status, _, err := passthroughCandleSnapshot(ctx, "http://example.invalid", sem, testCandleBody())
	if !canceled {
		t.Fatalf("expected canceled=true when the lane never frees up, err=%v", err)
	}
	if servedFromStore || status != http.StatusGatewayTimeout {
		t.Fatalf("unexpected flags: servedFromStore=%v status=%d", servedFromStore, status)
	}
}

func TestPassthroughCandleSnapshotClassifiesClientAbort(t *testing.T) {
	sem := make(chan struct{}, 1)
	sem <- struct{}{} // force the request to observe its canceled context
	defer func() { <-sem }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, canceled, status, _, err := passthroughCandleSnapshot(ctx, "http://example.invalid", sem, testCandleBody())

	if !canceled || status != statusClientClosedRequest || err != context.Canceled {
		t.Fatalf("abort = canceled:%v status:%d err:%v, want true/499/context.Canceled", canceled, status, err)
	}
}
