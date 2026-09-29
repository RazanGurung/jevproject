package exchange

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGetMidPriceUsesStreamCacheForStandardAndBuilderMarkets(t *testing.T) {
	h := NewHyperliquidAdapter()
	h.PrimeMids(map[string]float64{
		"BTC":      62500.5,
		"xyz:GOLD": 4050.25,
	})

	// A cancelled context proves both values return before any REST fallback.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for coin, want := range map[string]float64{"BTC": 62500.5, "xyz:GOLD": 4050.25} {
		got, err := h.getMidPrice(ctx, coin, false)
		if err != nil || got != want {
			t.Fatalf("getMidPrice(%q)=(%v,%v), want (%v,nil)", coin, got, err, want)
		}
	}
}

func TestGetHip3PriceRestFallbackMergesPrimedMids(t *testing.T) {
	h := NewHyperliquidAdapter()
	h.PrimeMids(map[string]float64{
		"BTC":      62500.5,
		"xyz:GOLD": 4050.25,
	})
	h.httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `[{"universe":[{"name":"xyz:GOLD","szDecimals":4}]},[{"markPx":"4060.5"}]]`
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})}
	// Expire the stream TTL so the xyz REST fallback runs.
	h.hip3MidsMu.Lock()
	h.hip3MidsCache.time = h.hip3MidsCache.time.Add(-hip3MidsCacheTTL - 1)
	h.hip3MidsMu.Unlock()

	got, err := h.getHip3Price(context.Background(), mainnetAPIURL, "xyz:GOLD")
	if err != nil || got != 4060.5 {
		t.Fatalf("getHip3Price xyz:GOLD=(%v,%v), want (4060.5,nil)", got, err)
	}
	if mid, ok := h.cachedHip3Mid("BTC"); !ok || mid != 62500.5 {
		t.Fatalf("REST xyz fallback wiped primed BTC mid: ok=%t mid=%v", ok, mid)
	}
}
