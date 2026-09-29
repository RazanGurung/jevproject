package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"hyperliquid-go/internal/accountcache"
	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/keycache"
	"hyperliquid-go/internal/services"
	"hyperliquid-go/internal/services/testutil"

	"github.com/gin-gonic/gin"
)

const serverKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func init() {
	gin.SetMode(gin.TestMode)
}

func newOrderService(mock *testutil.MockExchange, rl *services.RateLimiter) *services.OrderService {
	return services.NewOrderService(
		mock,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		rl,
		nil,
		services.NewAccountRuntime(),
	)
}

func postJSON(handler gin.HandlerFunc, body string) *httptest.ResponseRecorder {
	router := gin.New()
	router.POST("/order", handler)
	req := httptest.NewRequest(http.MethodPost, "/order", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestPlaceOrderRejectsMalformedJSON(t *testing.T) {
	h := NewOrderHandler(newOrderService(testutil.NewMockExchange(), services.NewRateLimiter(100, time.Minute)))

	rec := postJSON(h.PlaceOrder, "{not valid json")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

// The security-critical property: whatever privateKey a client puts in the
// request body must be ignored and replaced with the server's own cached key.
// A client must never be able to make the server sign with an attacker key.
func TestPlaceOrderIgnoresClientSuppliedPrivateKey(t *testing.T) {
	keycache.Clear()
	accountcache.Clear()
	keycache.Cache(serverKey)
	t.Cleanup(func() {
		keycache.Clear()
		accountcache.Clear()
	})

	var captured models.OrderRequest
	mock := testutil.NewMockExchange()
	mock.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		captured = req
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(1)}}, nil
	}

	h := NewOrderHandler(newOrderService(mock, services.NewRateLimiter(100, time.Minute)))

	attackerKey := strings.Repeat("b", 64)
	body := `{"coin":"BTC","isBuy":true,"sz":1,"limitPx":100,"privateKey":"` + attackerKey + `"}`
	rec := postJSON(h.PlaceOrder, body)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if captured.PrivateKey != serverKey {
		t.Fatalf("exchange received privateKey %q, want server key %q", captured.PrivateKey, serverKey)
	}
	if captured.PrivateKey == attackerKey {
		t.Fatal("client-supplied private key reached the exchange — must be discarded")
	}
}

func TestPlaceOrderMapsRateLimitTo429(t *testing.T) {
	keycache.Clear()
	accountcache.Clear()
	keycache.Cache(serverKey)
	t.Cleanup(func() {
		keycache.Clear()
		accountcache.Clear()
	})

	mock := testutil.NewMockExchange()
	mock.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(1)}}, nil
	}

	// maxWeight=1: the first order consumes the budget, the second is rejected.
	h := NewOrderHandler(newOrderService(mock, services.NewRateLimiter(1, time.Minute)))
	body := `{"coin":"BTC","isBuy":true,"sz":1,"limitPx":100}`

	if rec := postJSON(h.PlaceOrder, body); rec.Code != http.StatusOK {
		t.Fatalf("first order status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if rec := postJSON(h.PlaceOrder, body); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second order status = %d, want %d; body=%s", rec.Code, http.StatusTooManyRequests, rec.Body.String())
	}
}

func TestCancelOrderRejectsMalformedJSON(t *testing.T) {
	h := NewOrderHandler(newOrderService(testutil.NewMockExchange(), services.NewRateLimiter(100, time.Minute)))

	rec := postJSON(h.CancelOrder, "{")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

// Bulk cancel must report "partial" with the confirmed oids when only some
// cancels succeed, so the frontend suppresses exactly the cancelled orders.
func TestBulkCancelReportsPartialWithConfirmedOids(t *testing.T) {
	keycache.Clear()
	accountcache.Clear()
	keycache.Cache(serverKey)
	t.Cleanup(func() {
		keycache.Clear()
		accountcache.Clear()
	})

	mock := testutil.NewMockExchange()
	mock.BulkCancelOrdersFunc = func(address string, cancels []models.CancelEntry, testnet bool) ([]int64, error) {
		return []int64{101}, nil
	}

	h := NewOrderHandler(newOrderService(mock, services.NewRateLimiter(100, time.Minute)))

	body := `{"cancels":[{"coin":"BTC","oid":101},{"coin":"xyz:SOL","oid":202}],"mainnet":true}`
	rec := postJSON(h.BulkCancel, body)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp struct {
		Status        string  `json:"status"`
		Cancelled     int     `json:"cancelled"`
		CancelledOids []int64 `json:"cancelledOids"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid response JSON: %v; body=%s", err, rec.Body.String())
	}
	if resp.Status != "partial" {
		t.Fatalf("status = %q, want \"partial\"; body=%s", resp.Status, rec.Body.String())
	}
	if resp.Cancelled != 1 || len(resp.CancelledOids) != 1 || resp.CancelledOids[0] != 101 {
		t.Fatalf("unexpected cancelled accounting: %s", rec.Body.String())
	}
}

func TestGetJournalEndpoints(t *testing.T) {
	svc := newOrderService(testutil.NewMockExchange(), services.NewRateLimiter(100, time.Minute))
	tmpDir, _ := os.MkdirTemp("", "journal_handler_test_*")
	defer os.RemoveAll(tmpDir)

	j, _ := services.NewExecutionJournal(filepath.Join(tmpDir, "journal.jsonl"), 50)
	defer j.Close()
	svc.SetJournal(j)

	_ = j.Record(models.JournalEntry{
		Action:  "PLACE_ORDER",
		Coin:    "BTC",
		Side:    "BUY",
		Sz:      0.1,
		LimitPx: 60000,
		Success: true,
	})

	h := NewOrderHandler(svc)
	router := gin.New()
	router.GET("/api/journal/executions", h.GetJournalExecutions)
	router.GET("/api/journal/summary", h.GetJournalSummary)

	// Test executions endpoint
	req := httptest.NewRequest(http.MethodGet, "/api/journal/executions?coin=BTC", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var execResp struct {
		Entries []models.JournalEntry `json:"entries"`
		Count   int                   `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &execResp); err != nil {
		t.Fatalf("unmarshal executions: %v", err)
	}
	if execResp.Count != 1 || execResp.Entries[0].Coin != "BTC" {
		t.Fatalf("unexpected entries: %+v", execResp)
	}

	// Test summary endpoint
	reqSum := httptest.NewRequest(http.MethodGet, "/api/journal/summary", nil)
	recSum := httptest.NewRecorder()
	router.ServeHTTP(recSum, reqSum)

	if recSum.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recSum.Code)
	}
	var sumResp models.JournalSummary
	if err := json.Unmarshal(recSum.Body.Bytes(), &sumResp); err != nil {
		t.Fatalf("unmarshal summary: %v", err)
	}
	if sumResp.TotalOrders != 1 || sumResp.TotalVolumeUsd != 6000 {
		t.Fatalf("unexpected summary: %+v", sumResp)
	}
}
