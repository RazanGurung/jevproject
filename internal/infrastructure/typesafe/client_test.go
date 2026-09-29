package typesafe

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestResolveKey(t *testing.T) {
	origEnv := os.Getenv("TYPESAFE_API_KEY")
	origPezEnv := os.Getenv("PEZ_TYPESAFE_API_KEY")
	defer func() {
		os.Setenv("TYPESAFE_API_KEY", origEnv)
		os.Setenv("PEZ_TYPESAFE_API_KEY", origPezEnv)
	}()

	os.Setenv("TYPESAFE_API_KEY", "test_env_key_123")
	if key := ResolveKey(); key != "test_env_key_123" {
		t.Fatalf("expected test_env_key_123, got %s", key)
	}

	os.Unsetenv("TYPESAFE_API_KEY")
	os.Setenv("PEZ_TYPESAFE_API_KEY", "test_pez_key_456")
	if key := ResolveKey(); key != "test_pez_key_456" {
		t.Fatalf("expected test_pez_key_456, got %s", key)
	}
}

func TestClientDecide(t *testing.T) {
	mockResponse := SystemOneResponse{
		Model: "jev-1.13.0",
		Answers: map[string]DecisionAnswer{
			"direction": {
				Type:       "choice",
				Choice:     "bullish",
				Confidence: 0.85,
				Probabilities: map[string]float64{
					"bullish": 0.85,
					"bearish": 0.10,
					"neutral": 0.05,
				},
			},
			"confidence": {
				Type:       "score",
				Score:      4.2,
				Confidence: 0.75,
			},
			"toxic_flow": {
				Type: "noul",
				Noul: 0.12,
			},
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/systemone" {
			t.Errorf("expected /systemone, got %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer secret_test_key" {
			t.Errorf("expected Bearer secret_test_key, got %s", auth)
		}

		var req SystemOneRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("failed to decode body: %v", err)
		}
		if req.Model != "jev-latest" {
			t.Errorf("expected model jev-latest, got %s", req.Model)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(mockResponse)
	}))
	defer server.Close()

	client := NewClient("secret_test_key", server.URL, "jev-latest", server.Client())
	if !client.IsAvailable() {
		t.Fatal("client should be available")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resp, err := client.Decide(ctx, "BTC mid 65000", map[string]QuestionSpec{
		"direction": {
			Type: "choice",
			Criteria: map[string]string{
				"bullish": "long",
				"bearish": "short",
			},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if resp.Model != "jev-1.13.0" {
		t.Fatalf("expected model jev-1.13.0, got %s", resp.Model)
	}
	dir, ok := resp.Answers["direction"]
	if !ok || dir.Choice != "bullish" {
		t.Fatalf("expected choice bullish, got %v", dir)
	}
}

func TestClientCacheHit(t *testing.T) {
	requestsCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestsCount++
		resp := SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]DecisionAnswer{
				"flow": {Type: "noul", Noul: 0.15},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := NewClient("secret_key", server.URL, "jev-latest", server.Client())
	ctx := context.Background()
	q := map[string]QuestionSpec{"flow": {Type: "noul"}}

	// First call -> hits server
	_, err := client.Decide(ctx, "state_A", q)
	if err != nil {
		t.Fatalf("call 1 failed: %v", err)
	}
	if requestsCount != 1 {
		t.Fatalf("expected 1 request, got %d", requestsCount)
	}

	// Second call with same state -> should hit cache (requestsCount remains 1)
	_, err = client.Decide(ctx, "state_A", q)
	if err != nil {
		t.Fatalf("call 2 failed: %v", err)
	}
	if requestsCount != 1 {
		t.Fatalf("expected requestsCount to stay 1 due to cache, got %d", requestsCount)
	}

	// Third call with different state -> should hit server (requestsCount becomes 2)
	_, err = client.Decide(ctx, "state_B", q)
	if err != nil {
		t.Fatalf("call 3 failed: %v", err)
	}
	if requestsCount != 2 {
		t.Fatalf("expected requestsCount to be 2, got %d", requestsCount)
	}
}

func TestClientCircuitBreaker(t *testing.T) {
	requestsCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestsCount++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"internal server error"}`))
	}))
	defer server.Close()

	client := NewClient("secret_key", server.URL, "jev-latest", server.Client())
	ctx := context.Background()
	q := map[string]QuestionSpec{"flow": {Type: "noul"}}

	// First 3 calls fail with HTTP 500
	for i := 1; i <= 3; i++ {
		_, err := client.Decide(ctx, fmt.Sprintf("state_%d", i), q)
		if err == nil {
			t.Fatalf("expected call %d to fail", i)
		}
	}
	if requestsCount != 3 {
		t.Fatalf("expected 3 server requests, got %d", requestsCount)
	}
	if !client.IsCircuitOpen() {
		t.Fatalf("expected circuit breaker to be open after 3 consecutive failures")
	}

	// 4th call should fail immediately via circuit breaker without hitting the server
	_, err := client.Decide(ctx, "state_4", q)
	if err == nil || !strings.Contains(err.Error(), "circuit breaker open") {
		t.Fatalf("expected circuit breaker open error, got %v", err)
	}
	if requestsCount != 3 {
		t.Fatalf("expected requestsCount to remain 3, got %d", requestsCount)
	}
}

