package exchange

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNextNonceUniqueUnderConcurrency(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	const count = 200
	values := make(chan int64, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			values <- adapter.nextNonce()
		}()
	}
	wg.Wait()
	close(values)
	seen := make(map[int64]struct{}, count)
	for value := range values {
		if _, exists := seen[value]; exists {
			t.Fatalf("duplicate nonce %d", value)
		}
		seen[value] = struct{}{}
	}
}

func TestSignedActionTransportIsBounded(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.actionSem = make(chan struct{}, 2)
	var inFlight atomic.Int32
	var maximum atomic.Int32
	adapter.httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		current := inFlight.Add(1)
		for current > maximum.Load() && !maximum.CompareAndSwap(maximum.Load(), current) {
		}
		time.Sleep(20 * time.Millisecond)
		inFlight.Add(-1)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":"ok"}`)), Header: make(http.Header)}, nil
	})}

	const count = 8
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(nonce int64) {
			defer wg.Done()
			_, err := adapter.postSignedExchangeActionExpiring(context.Background(), false,
				ScheduleCancelAction{Type: "scheduleCancel"}, nonce, map[string]interface{}{}, nil)
			if err != nil {
				t.Errorf("post action: %v", err)
			}
		}(int64(i + 1))
	}
	wg.Wait()
	if got := maximum.Load(); got != 2 {
		t.Fatalf("max in-flight=%d want 2", got)
	}
}

func TestParsedECDSAKeyMemoization(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	key1, err := adapter.getOrParseECDSAKey(goldenTestKey)
	if err != nil {
		t.Fatalf("getOrParseECDSAKey: %v", err)
	}
	key2, err := adapter.getOrParseECDSAKey("0x" + goldenTestKey)
	if err != nil {
		t.Fatalf("getOrParseECDSAKey with 0x prefix: %v", err)
	}
	if key1 != key2 {
		t.Fatalf("expected identical cached pointer for same key, got %p != %p", key1, key2)
	}
}

