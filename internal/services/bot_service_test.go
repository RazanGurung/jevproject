package services

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/services/testutil"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestBotServiceRestoreAndHandleUserFills(t *testing.T) {
	tmpDir := t.TempDir()
	stateFile := filepath.Join(tmpDir, "bot-state.json")
	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	candles := make([]map[string]interface{}, 0, 20)
	now := time.Now()
	for i := 0; i < 20; i++ {
		ts := now.Add(-time.Duration(20-i) * 24 * time.Hour).UnixMilli()
		price := 100.0 + float64(i)
		candles = append(candles, map[string]interface{}{
			"t": ts,
			"h": price + 2,
			"l": price - 2,
			"c": price,
			"v": 1000 + i*10,
		})
	}
	candleBody, err := json.Marshal(candles)
	if err != nil {
		t.Fatalf("marshal candles: %v", err)
	}

	mockExchange := testutil.NewMockExchange()
	mockExchange.GetMidPriceFunc = func(coin string, testnet bool) (float64, error) {
		return 112, nil
	}

	var mu sync.Mutex
	placed := 0
	cancelled := make([]int64, 0)
	nextOID := int64(700)
	mockExchange.PlaceBulkOrdersFunc = func(orders []models.OrderRequest) ([]interface{}, error) {
		mu.Lock()
		defer mu.Unlock()
		placed++
		results := make([]interface{}, 0, len(orders))
		for range orders {
			nextOID++
			results = append(results, map[string]interface{}{
				"resting": map[string]interface{}{"oid": float64(nextOID)},
			})
		}
		return results, nil
	}
	mockExchange.CancelOrderFunc = func(address, coin string, oid int64, testnet bool) error {
		mu.Lock()
		defer mu.Unlock()
		cancelled = append(cancelled, oid)
		return nil
	}
	mockExchange.BulkCancelOrdersFunc = func(address string, cancels []models.CancelEntry, testnet bool) ([]int64, error) {
		mu.Lock()
		defer mu.Unlock()
		oids := make([]int64, 0, len(cancels))
		for _, cancel := range cancels {
			cancelled = append(cancelled, cancel.Oid)
			oids = append(oids, cancel.Oid)
		}
		return oids, nil
	}

	orderService := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(1000, time.Minute),
		nil,
		NewAccountRuntime(),
	)

	httpClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       ioNopCloser(bytes.NewReader(candleBody)),
			}, nil
		}),
	}

	initialPrev := 105.0
	state := botPersistedState{
		Running:  true,
		Account:  "0xfcf8b585db6a5d2f32a1b18c8dcbf5c6bb2d6f88",
		Strategy: "rvwap-short-bollinger",
		Coin:     "BTC",
		Config: models.BotConfig{
			OrdersPerSide: 2,
			OrderSize:     15,
			BidSkew:       1,
			AskSkew:       1,
		},
		StartedAt: now.Add(-5 * time.Minute).UTC(),
		UpdatedAt: now.Add(-5 * time.Minute).UTC(),
		OrderIDs:  []int64{101, 202},
		PrevKVWAP: &initialPrev,
	}
	stateBytes, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	if err := os.WriteFile(stateFile, stateBytes, 0o600); err != nil {
		t.Fatalf("write state: %v", err)
	}

	botService := NewBotService(orderService, mockExchange, httpClient, stateFile)
	if err := botService.Restore(context.Background(), privateKey); err != nil {
		t.Fatalf("Restore returned error: %v", err)
	}
	defer botService.Stop(context.Background(), privateKey)

	waitFor(t, time.Second, func() bool {
		status := botService.Status()
		return status.Running && len(status.OrderIDs) > 0
	})

	mu.Lock()
	restorePlaced := placed
	restoreCancelled := append([]int64(nil), cancelled...)
	mu.Unlock()

	if restorePlaced == 0 {
		t.Fatal("expected restore to place orders")
	}
	if len(restoreCancelled) == 0 || restoreCancelled[0] != 101 {
		t.Fatalf("expected restore to cancel persisted bot orders, got %v", restoreCancelled)
	}

	status := botService.Status()
	if len(status.OrderIDs) == 0 {
		t.Fatal("expected active bot order ids after restore")
	}
	matchOID := status.OrderIDs[0]

	botService.HandleUserFills("", []interface{}{
		map[string]interface{}{"coin": "BTC", "oid": matchOID, "side": "B"},
	})

	waitFor(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return placed > restorePlaced
	})
}

func waitFor(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

type nopCloser struct {
	*bytes.Reader
}

func (n nopCloser) Close() error { return nil }

func ioNopCloser(r *bytes.Reader) nopCloser {
	return nopCloser{Reader: r}
}
