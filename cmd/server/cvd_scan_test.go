package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"hyperliquid-go/internal/infrastructure/candlecache"
)

func TestCVDScanHandlerReturnsCompactBackendReadings(t *testing.T) {
	if cvdLookbackDays != 90 {
		t.Fatalf("cvdLookbackDays = %v, want 90", cvdLookbackDays)
	}
	previousStore := runtime.candleStore
	t.Cleanup(func() { runtime.candleStore = previousStore })

	store := candlecache.New(nil, 400)
	store.OnMarketWSReconnect()
	runtime.candleStore = store
	now := time.Now().Truncate(time.Hour)
	historyDays := int(cvdLookbackDays) + 2
	start := now.Add(-time.Duration(historyDays) * 24 * time.Hour)
	candles := make([]candlecache.Candle, 0, historyDays*24+1)
	previous := 100.0
	for i := 0; i <= historyDays*24; i++ {
		openTime := start.Add(time.Duration(i) * time.Hour)
		closeValue := 100 + 8*math.Sin(float64(i)/9)
		candles = append(candles, candlecache.Candle{
			OpenMs:   openTime.UnixMilli(),
			CloseMs:  openTime.Add(time.Hour).UnixMilli() - 1,
			Symbol:   "BTC",
			Interval: "1h",
			Open:     fmt.Sprintf("%f", previous),
			High:     fmt.Sprintf("%f", math.Max(previous, closeValue)+1),
			Low:      fmt.Sprintf("%f", math.Min(previous, closeValue)-1),
			Close:    fmt.Sprintf("%f", closeValue),
			Volume:   "10",
		})
		previous = closeValue
	}
	body := map[string]interface{}{
		"type": "candleSnapshot",
		"req": map[string]interface{}{
			"coin": "BTC", "interval": "1h",
			"startTime": start.UnixMilli(), "endTime": now.UnixMilli(),
		},
	}
	payload, _ := json.Marshal(candles)
	store.MergePassthrough(body, payload)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/cvd-scan", cvdScanHandler)
	req := httptest.NewRequest(http.MethodPost, "/api/cvd-scan", bytes.NewBufferString(`{"coins":["BTC","BTC"]}`))
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.Code, resp.Body.String())
	}
	var decoded struct {
		Readings  []cvdScanReading `json:"readings"`
		Requested int              `json:"requested"`
		Errors    int              `json:"errors"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Requested != 1 || decoded.Errors != 0 || len(decoded.Readings) != 1 {
		t.Fatalf("unexpected response: %+v body=%s", decoded, resp.Body.String())
	}
	if decoded.Readings[0].Coin != "BTC" || decoded.Readings[0].BarTime <= 0 {
		t.Fatalf("unexpected reading: %+v", decoded.Readings[0])
	}
}

func TestNormalizeCVDScanCoins(t *testing.T) {
	got := normalizeCVDScanCoins([]string{" BTC ", "BTC", "xyz:GOLD", "", string(make([]byte, 65))})
	if len(got) != 2 || got[0] != "BTC" || got[1] != "xyz:GOLD" {
		t.Fatalf("normalized = %v", got)
	}
}

func TestCVDScanHandlerRejectsTooManyUniqueCoins(t *testing.T) {
	coins := make([]string, maxCVDScanCoins+1)
	for i := range coins {
		coins[i] = fmt.Sprintf("COIN%d", i)
	}
	payload, err := json.Marshal(map[string]interface{}{"coins": coins})
	if err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/cvd-scan", cvdScanHandler)
	req := httptest.NewRequest(http.MethodPost, "/api/cvd-scan", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", resp.Code, resp.Body.String())
	}
	if resp.Body.String() != `{"error":"too many scan coins"}` {
		t.Fatalf("body = %s", resp.Body.String())
	}
}
