package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"hyperliquid-go/internal/infrastructure/candlecache"
	"hyperliquid-go/internal/infrastructure/exchange"
	"hyperliquid-go/pkg/utils"
)

const (
	maxCVDScanCoins = 40
	cvdScanInterval = "1h"
	cvdLookbackDays = 90.0
)

type cvdScanReading struct {
	Coin    string  `json:"coin"`
	BarTime int64   `json:"barTime"`
	Value   float64 `json:"value"`
}

// cvdScanHandler is a compact backend-owned scanner read model. The browser
// sends only its monitored coin set and receives confirmed oscillator values;
// candle cache reads, upstream healing, CVD enrichment and oscillator math all
// stay on the server.
func cvdScanHandler(c *gin.Context) {
	var req struct {
		Coins []string `json:"coins"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	coins := normalizeCVDScanCoins(req.Coins)
	if len(coins) == 0 {
		c.JSON(http.StatusOK, gin.H{"readings": []cvdScanReading{}, "asOf": time.Now().UnixMilli()})
		return
	}
	if len(coins) > maxCVDScanCoins {
		c.JSON(http.StatusBadRequest, gin.H{"error": "too many scan coins"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()
	now := time.Now()
	readings := make([]cvdScanReading, 0, len(coins))
	errors := 0
	for _, coin := range coins {
		candles, source, err := loadCVDScanCandles(ctx, coin, now)
		if err != nil {
			errors++
			cvdScanSeriesTotal.WithLabelValues("error").Inc()
			continue
		}
		barTime, value, ok := candlecache.LatestClosedCVDOscillator(candles, cvdScanInterval, cvdLookbackDays, now)
		if !ok {
			cvdScanSeriesTotal.WithLabelValues("not_ready").Inc()
			continue
		}
		cvdScanSeriesTotal.WithLabelValues(source).Inc()
		readings = append(readings, cvdScanReading{Coin: coin, BarTime: barTime, Value: value})
	}
	c.JSON(http.StatusOK, gin.H{
		"readings":  readings,
		"asOf":      now.UnixMilli(),
		"requested": len(coins),
		"errors":    errors,
	})
}

func normalizeCVDScanCoins(input []string) []string {
	seen := make(map[string]struct{}, len(input))
	out := make([]string, 0, len(input))
	for _, coin := range input {
		coin = strings.TrimSpace(coin)
		if coin == "" || len(coin) > 64 {
			continue
		}
		if _, ok := seen[coin]; ok {
			continue
		}
		seen[coin] = struct{}{}
		out = append(out, coin)
	}
	return out
}

func loadCVDScanCandles(ctx context.Context, coin string, now time.Time) ([]candlecache.Candle, string, error) {
	endMs := now.UnixMilli()
	// One extra day gives the rolling windows a clean boundary sample while
	// remaining far smaller than the old generic 165-day chart hydration.
	startMs := endMs - int64((cvdLookbackDays+1)*24*float64(time.Hour/time.Millisecond))
	innerReq := map[string]interface{}{
		"coin":      coin,
		"interval":  cvdScanInterval,
		"startTime": startMs,
		"endTime":   endMs,
	}
	if dex := utils.GetDexName(coin); dex != "" {
		innerReq["dex"] = dex
	}
	body := map[string]interface{}{"type": "candleSnapshot", "req": innerReq}
	respBody, fromStore, canceled, status, upstreamBody, err := passthroughCandleSnapshot(ctx, exchange.MainnetAPIURL, chartPrefetchSem, body)
	if canceled {
		return nil, "", ctx.Err()
	}
	if err != nil {
		if status > 0 {
			return nil, "", &cvdUpstreamError{status: status, body: upstreamBody}
		}
		return nil, "", err
	}
	// A passthrough response is folded into the store by the shared helper.
	// Read it back once so server-computed cvdDelta enrichment is used when its
	// source series are ready; otherwise the raw response remains a safe fallback.
	if !fromStore && runtime.candleStore != nil {
		if enriched, ok := runtime.candleStore.ServeInfoRequest(body); ok {
			respBody = enriched
			fromStore = true
		}
	}
	var candles []candlecache.Candle
	if err := json.Unmarshal(respBody, &candles); err != nil {
		return nil, "", err
	}
	if fromStore {
		return candles, "store", nil
	}
	return candles, "passthrough", nil
}

type cvdUpstreamError struct {
	status int
	body   string
}

func (e *cvdUpstreamError) Error() string {
	if e.body == "" {
		return http.StatusText(e.status)
	}
	return http.StatusText(e.status) + ": " + e.body
}
