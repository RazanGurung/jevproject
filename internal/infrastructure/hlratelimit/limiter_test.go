package hlratelimit

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func TestRequestWeight(t *testing.T) {
	tests := []struct {
		name string
		path string
		body string
		want int
	}{
		{"light info", "/info", `{"type":"allMids"}`, 2},
		{"ordinary info", "/info", `{"type":"meta"}`, 20},
		{"user fills reserved extra", "/info", `{"type":"userFills","user":"0xabc"}`, 120},
		{"funding history reserved extra", "/info", `{"type":"fundingHistory","coin":"BTC"}`, 45},
		{"user role", "/info", `{"type":"userRole"}`, 60},
		{"candle response estimate", "/info", `{"type":"candleSnapshot","req":{"interval":"1m","startTime":0,"endTime":7200000}}`, 22},
		{"single action", "/exchange", `{"action":{"type":"updateLeverage"}}`, 1},
		{"forty orders", "/exchange", `{"action":{"type":"order","orders":[` + repeatedJSONObjects(40) + `]}}`, 2},
		{"seventy nine orders", "/exchange", `{"action":{"type":"order","orders":[` + repeatedJSONObjects(79) + `]}}`, 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, _ := RequestWeight(test.path, []byte(test.body))
			if got != test.want {
				t.Fatalf("weight = %d, want %d", got, test.want)
			}
		})
	}
}

func repeatedJSONObjects(count int) string {
	values := make([]string, count)
	for i := range values {
		values[i] = `{}`
	}
	return strings.Join(values, ",")
}

func TestWeightedTransportCountsEveryHyperliquidAttemptAndPreservesBody(t *testing.T) {
	limiter := NewLimiter()
	requests := 0
	transport := &weightedTransport{
		limiter: limiter,
		base: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			requests++
			body, _ := io.ReadAll(req.Body)
			if string(body) != `{"type":"allMids"}` {
				t.Fatalf("forwarded body = %s", body)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(bytes.NewBufferString(`{"mids":{}}`)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest(http.MethodPost, "https://api.hyperliquid.xyz/info", strings.NewReader(`{"type":"allMids"}`))
		resp, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	if requests != 2 {
		t.Fatalf("network attempts = %d, want 2", requests)
	}
	limiter.mu.Lock()
	tokens := limiter.tokens
	limiter.mu.Unlock()
	if tokens > 196.01 || tokens < 195.99 {
		t.Fatalf("tokens = %f, want 196 after two weight-2 attempts", tokens)
	}
}

func TestNonHyperliquidRequestBypassesLimiter(t *testing.T) {
	limiter := NewLimiter()
	transport := &weightedTransport{
		limiter: limiter,
		base: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok")), Header: make(http.Header)}, nil
		}),
	}
	req, _ := http.NewRequest(http.MethodGet, "https://api.bybit.com/v5/market/instruments-info", nil)
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	limiter.mu.Lock()
	tokens := limiter.tokens
	limiter.mu.Unlock()
	if tokens != weightBurst {
		t.Fatalf("non-Hyperliquid request consumed tokens: %f", tokens)
	}
}

func TestRTTTimeoutDoesNotClipLimiterWait(t *testing.T) {
	limiter := NewLimiter()
	limiter.tokens = 0
	limiter.last = limiter.now()
	sawDeadline := false
	transport := &weightedTransport{
		limiter: limiter,
		base: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if _, ok := req.Context().Deadline(); ok {
				sawDeadline = true
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{}`)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	ctx := WithRTTTimeout(context.Background(), 20*time.Millisecond)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.hyperliquid.xyz/info", strings.NewReader(`{"type":"allMids"}`))
	start := time.Now()
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("Wait was clipped by RTT timeout: %v", err)
	}
	resp.Body.Close()
	if time.Since(start) < 50*time.Millisecond {
		t.Fatalf("Wait returned too fast; tokens were 0")
	}
	if !sawDeadline {
		t.Fatal("HTTP request missing RTT deadline")
	}
}

func TestRTTTimeoutKeepsBodyReadableAfterHeaders(t *testing.T) {
	payload := strings.Repeat("x", 64*1024)
	transport := WrapTransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(payload)),
			Header:     make(http.Header),
			Request:    req,
		}, nil
	}))
	ctx := WithRTTTimeout(context.Background(), time.Second)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.hyperliquid.xyz/info", strings.NewReader(`{"type":"allMids"}`))
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("body read: %v", err)
	}
	if string(body) != payload {
		t.Fatalf("body len = %d, want %d", len(body), len(payload))
	}
}
