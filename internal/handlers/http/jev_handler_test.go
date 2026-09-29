package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hyperliquid-go/internal/infrastructure/typesafe"
	"hyperliquid-go/internal/ports/cache"
	"hyperliquid-go/internal/services"
	"hyperliquid-go/internal/services/testutil"

	"github.com/gin-gonic/gin"
)

func TestJevHandlerStatus(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Case 1: Jev not available
	hUnavailable := NewJevHandler(nil)
	router := gin.New()
	router.GET("/api/jev/status", hUnavailable.Status)

	req := httptest.NewRequest(http.MethodGet, "/api/jev/status", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	var res map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res["available"] != false {
		t.Errorf("expected available false, got %v", res["available"])
	}
}

func TestJevHandlerSignal(t *testing.T) {
	gin.SetMode(gin.TestMode)

	mockJevServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := typesafe.SystemOneResponse{
			Model: "jev-1.13.0",
			Answers: map[string]typesafe.DecisionAnswer{
				"direction": {
					Type:       "choice",
					Choice:     "bullish",
					Confidence: 0.85,
				},
				"confidence": {
					Type:  "score",
					Score: 4.0,
				},
				"toxic_flow": {
					Type: "noul",
					Noul: 0.05,
				},
				"suggested_action": {
					Type:   "choice",
					Choice: "enter_long",
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockJevServer.Close()

	client := typesafe.NewClient("test_key", mockJevServer.URL, "jev-latest", mockJevServer.Client())
	priceCache := testutil.NewMockPriceCache()
	priceCache.Set("BTC", cache.PriceCacheEntry{Buy: 65000.0, Sell: 65000.0})

	svc := services.NewJevService(client, nil, priceCache, nil)
	handler := NewJevHandler(svc)

	router := gin.New()
	router.GET("/api/jev/signal", handler.Signal)
	router.POST("/api/jev/signal", handler.Signal)

	// 1. GET with query param
	getReq := httptest.NewRequest(http.MethodGet, "/api/jev/signal?coin=BTC", nil)
	getRec := httptest.NewRecorder()
	router.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET /api/jev/signal?coin=BTC expected 200, got %d: %s", getRec.Code, getRec.Body.String())
	}
	var getSig services.TradeSignal
	if err := json.Unmarshal(getRec.Body.Bytes(), &getSig); err != nil {
		t.Fatalf("failed to decode signal: %v", err)
	}
	if getSig.Action != "BUY" {
		t.Errorf("expected Action BUY, got %s", getSig.Action)
	}
	if getSig.Timeframe != "intraday" {
		t.Errorf("expected default Timeframe intraday, got %s", getSig.Timeframe)
	}

	// 1b. GET with timeframe=scalp
	scalpReq := httptest.NewRequest(http.MethodGet, "/api/jev/signal?coin=BTC&timeframe=scalp", nil)
	scalpRec := httptest.NewRecorder()
	router.ServeHTTP(scalpRec, scalpReq)
	if scalpRec.Code != http.StatusOK {
		t.Fatalf("GET /api/jev/signal?coin=BTC&timeframe=scalp expected 200, got %d", scalpRec.Code)
	}
	var scalpSig services.TradeSignal
	if err := json.Unmarshal(scalpRec.Body.Bytes(), &scalpSig); err != nil {
		t.Fatalf("failed to decode scalp signal: %v", err)
	}
	if scalpSig.Timeframe != "scalp" {
		t.Errorf("expected Timeframe scalp, got %s", scalpSig.Timeframe)
	}

	// 2. POST with JSON body
	postReq := httptest.NewRequest(http.MethodPost, "/api/jev/signal", strings.NewReader(`{"coin":"BTC"}`))
	postReq.Header.Set("Content-Type", "application/json")
	postRec := httptest.NewRecorder()
	router.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusOK {
		t.Fatalf("POST /api/jev/signal expected 200, got %d: %s", postRec.Code, postRec.Body.String())
	}

	// 3. Validation failure when coin missing
	badReq := httptest.NewRequest(http.MethodGet, "/api/jev/signal", nil)
	badRec := httptest.NewRecorder()
	router.ServeHTTP(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request when coin missing, got %d", badRec.Code)
	}
}
