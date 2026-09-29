package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"hyperliquid-go/internal/infrastructure/candlecache"

	"github.com/gin-gonic/gin"
)

func TestChartCandleHydrateIsNoOpWhenStoreDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previousStore := runtime.candleStore
	runtime.candleStore = nil
	t.Cleanup(func() { runtime.candleStore = previousStore })

	router := gin.New()
	router.POST("/api/chart-candles", chartCandleHandler)
	now := time.Now().UnixMilli()
	body, _ := json.Marshal(map[string]interface{}{
		"coin": "BTC", "interval": "4h", "startTime": now - 600*24*60*60*1000,
		"endTime": now, "urgency": "hydrate",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/chart-candles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body=%s", w.Code, w.Body.String())
	}
}

func TestChartCandleHydrateReturnsPendingForColdStore(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := candlecache.New(func(context.Context, string, string, int64, int64) ([]candlecache.Candle, error) {
		return nil, nil
	}, 4000)
	store.OnMarketWSReconnect()
	previousStore := runtime.candleStore
	runtime.candleStore = store
	t.Cleanup(func() { runtime.candleStore = previousStore })

	router := gin.New()
	router.POST("/api/chart-candles", chartCandleHandler)
	now := time.Now().UnixMilli()
	body, _ := json.Marshal(map[string]interface{}{
		"coin": "BTC", "interval": "4h", "startTime": now - 600*24*60*60*1000,
		"endTime": now, "urgency": "hydrate",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/chart-candles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1", got)
	}
}

func TestChartCandleHydrateServesSafeStoreHit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	now := time.Now().UnixMilli()
	start := now - 24*60*60*1000
	store := candlecache.New(func(context.Context, string, string, int64, int64) ([]candlecache.Candle, error) {
		return nil, nil
	}, 4000)
	store.OnMarketWSReconnect()
	store.RegisterSeries("BTC", "4h", 600*24*60*60*1000)
	candles := []candlecache.Candle{{
		OpenMs: now - 4*60*60*1000, CloseMs: now - 1, Symbol: "BTC", Interval: "4h",
		Open: "100", Close: "101", High: "102", Low: "99", Volume: "10", Trades: 2,
	}}
	payload, _ := json.Marshal(candles)
	store.MergePassthrough(map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "BTC", "interval": "4h", "startTime": start, "endTime": now,
		},
	}, payload)
	previousStore := runtime.candleStore
	runtime.candleStore = store
	t.Cleanup(func() { runtime.candleStore = previousStore })

	router := gin.New()
	router.POST("/api/chart-candles", chartCandleHandler)
	body, _ := json.Marshal(map[string]interface{}{
		"coin": "BTC", "interval": "4h", "startTime": start,
		"endTime": now, "urgency": "hydrate",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/chart-candles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-PEZ-Candle-Store"); got != "1" {
		t.Fatalf("X-PEZ-Candle-Store = %q, want 1", got)
	}
}

func TestChartCandleHydrateRejectsInvalidRange(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/chart-candles", chartCandleHandler)
	body := []byte(`{"coin":"BTC","interval":"4h","startTime":20,"endTime":10,"urgency":"hydrate"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/chart-candles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}
