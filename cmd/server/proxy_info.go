package main

// Hyperliquid /info proxy: cache, single-flight, and passthrough handler.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"hyperliquid-go/internal/infrastructure/exchange"
	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type proxyInfoCacheEntry struct {
	body      []byte
	expiresAt time.Time
}

type proxyInfoInflightEntry struct {
	done chan struct{}
	body []byte
	err  error
}

var (
	proxyInfoCacheMu   sync.RWMutex
	proxyInfoCache     = map[string]proxyInfoCacheEntry{}
	proxyInfoInflight  = map[string]*proxyInfoInflightEntry{}
	serverLifecycleCtx = context.Background()
	startupGateActive  atomic.Bool
	startupReady       atomic.Bool
	healthProbeMu      sync.Mutex
	healthProbeAt      time.Time
	healthProbeOK      bool
)

// =============================================================================
// MAIN
// =============================================================================
func proxyInfoCacheTTL(requestType string) time.Duration {
	switch requestType {
	case "metaAndAssetCtxs":
		return 5 * time.Second
	case "fundingHistory":
		return 30 * time.Second
	case "candleSnapshot":
		return 20 * time.Second
	default:
		return 0
	}
}

// allowedProxyInfoTypes is the first-party /info surface. High-weight types
// (userRole, userFills*, historicalOrders) are rejected so a browser or
// script cannot dump the official 1,200/min IP budget.
var allowedProxyInfoTypes = map[string]bool{
	"metaAndAssetCtxs": true,
	"fundingHistory":   true,
	"allMids":          true,
	"l2Book":           true,
	"meta":             true,
}

func getProxyInfoCache(key string) ([]byte, bool) {
	proxyInfoCacheMu.RLock()
	defer proxyInfoCacheMu.RUnlock()
	entry, ok := proxyInfoCache[key]
	if !ok || time.Now().After(entry.expiresAt) || len(entry.body) == 0 {
		return nil, false
	}
	return append([]byte(nil), entry.body...), true
}

func setProxyInfoCache(key string, body []byte, ttl time.Duration) {
	if key == "" || len(body) == 0 || ttl <= 0 {
		return
	}
	proxyInfoCacheMu.Lock()
	proxyInfoCache[key] = proxyInfoCacheEntry{
		body:      append([]byte(nil), body...),
		expiresAt: time.Now().Add(ttl),
	}
	proxyInfoCacheMu.Unlock()
}

func acquireProxyInfoInflight(key string) (*proxyInfoInflightEntry, bool) {
	if key == "" {
		return nil, false
	}
	proxyInfoCacheMu.Lock()
	defer proxyInfoCacheMu.Unlock()
	if entry, ok := proxyInfoInflight[key]; ok {
		return entry, false
	}
	entry := &proxyInfoInflightEntry{done: make(chan struct{})}
	proxyInfoInflight[key] = entry
	return entry, true
}

func resolveProxyInfoInflight(key string, entry *proxyInfoInflightEntry, body []byte, err error) {
	if key == "" || entry == nil {
		return
	}
	proxyInfoCacheMu.Lock()
	entry.body = append([]byte(nil), body...)
	entry.err = err
	delete(proxyInfoInflight, key)
	close(entry.done)
	proxyInfoCacheMu.Unlock()
}

func numberFromJSON(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case int64:
		return float64(typed), true
	case int:
		return float64(typed), true
	default:
		return 0, false
	}
}

func isRetryableProxyInfoFailure(statusCode int, body string) bool {
	if statusCode == http.StatusTooManyRequests || statusCode == http.StatusBadGateway || statusCode == http.StatusInternalServerError || statusCode == http.StatusServiceUnavailable {
		return true
	}
	body = strings.ToLower(body)
	return strings.Contains(body, "429") || strings.Contains(body, "rate limit")
}

func proxyHL(c *gin.Context) {
	var body map[string]interface{}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	requestType, _ := body["type"].(string)
	if requestType == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing info type"})
		return
	}
	if !allowedProxyInfoTypes[requestType] && requestType != "candleSnapshot" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported info type"})
		return
	}
	if requestType == "fundingHistory" {
		// Floor startTime to 1h so the 30s body-keyed cache can hit across
		// coin switches. Official funding prints are hourly.
		if start, ok := numberFromJSON(body["startTime"]); ok && start > 0 {
			body["startTime"] = int64(start) - int64(start)%3_600_000
		}
	}

	// candleSnapshot has its own dedicated path (shared with the market-radar
	// sweep's passthrough, see passthroughCandleSnapshot) instead of the
	// generic body-keyed cache/inflight-dedup below, which can't help candles
	// anyway — the frontend stamps every request with endTime=Date.now(), so
	// its key never repeats.
	if requestType == "candleSnapshot" {
		// 2 minutes bounds the whole passthrough (semaphore wait + limiter wait
		// + RTT), mirroring chart_candles.go so limiter queueing is not a 504.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
		defer cancel()
		respBody, servedFromStore, canceled, status, upstreamBody, err := passthroughCandleSnapshot(ctx, exchange.MainnetAPIURL, candlePassthroughSem, body)
		writeCandleSnapshotResponse(c, respBody, servedFromStore, canceled, status, upstreamBody, err)
		return
	}

	bodyBytes, _ := json.Marshal(body)
	cacheKey := ""
	cacheTTL := proxyInfoCacheTTL(requestType)
	if cacheTTL > 0 {
		cacheKey = string(bodyBytes)
	}
	var inflight *proxyInfoInflightEntry
	var owner bool
	if cacheKey != "" {
		inflight, owner = acquireProxyInfoInflight(cacheKey)
		if !owner {
			select {
			case <-c.Request.Context().Done():
				c.JSON(http.StatusGatewayTimeout, gin.H{"error": "request canceled"})
				return
			case <-inflight.done:
				if inflight.err == nil && len(inflight.body) > 0 {
					c.Data(http.StatusOK, "application/json", inflight.body)
					return
				}
				if cachedBody, ok := getProxyInfoCache(cacheKey); ok {
					c.Header("X-PEZ-Stale", "1")
					c.Data(http.StatusOK, "application/json", cachedBody)
					return
				}
			}
		}
	}
	if owner {
		defer func() {
			if r := recover(); r != nil {
				resolveProxyInfoInflight(cacheKey, inflight, nil, fmt.Errorf("proxy panic: %v", r))
				panic(r)
			}
		}()
	}

	// Cacheable/deduped types (everything reaching this point — candleSnapshot
	// returns above) are shared across waiters, so they keep a detached context:
	// one client leaving must not cancel a fetch other waiters still need.
	// Wait may use the 30s parent; HTTP RTT is 10s after tokens are reserved.
	ctx, cancel := context.WithTimeout(serverLifecycleCtx, 30*time.Second)
	defer cancel()
	ctx = infogovernor.WithLane(ctx, infogovernor.Enrichment)
	ctx = hlratelimit.WithRTTTimeout(ctx, 10*time.Second)

	req, err := http.NewRequestWithContext(ctx, "POST", exchange.MainnetAPIURL+"/info", bytes.NewBuffer(bodyBytes))
	if err != nil {
		if owner {
			resolveProxyInfoInflight(cacheKey, inflight, nil, err)
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	releaseInfoLane, laneErr := infogovernor.Acquire(ctx, infogovernor.Enrichment)
	if laneErr != nil {
		if owner {
			resolveProxyInfoInflight(cacheKey, inflight, nil, laneErr)
		}
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": laneErr.Error()})
		return
	}
	defer releaseInfoLane()
	resp, err := httpClient.Do(req)
	if err != nil {
		if owner {
			resolveProxyInfoInflight(cacheKey, inflight, nil, err)
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	trimmed := strings.TrimSpace(string(respBody))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if cacheKey != "" && isRetryableProxyInfoFailure(resp.StatusCode, trimmed) {
			if cachedBody, ok := getProxyInfoCache(cacheKey); ok {
				if owner {
					resolveProxyInfoInflight(cacheKey, inflight, cachedBody, nil)
				}
				c.Header("X-PEZ-Stale", "1")
				c.Data(http.StatusOK, "application/json", cachedBody)
				return
			}
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			// Surface HL rate-limiting (otherwise masked as a 502 to the client):
			// throttled so a burst doesn't flood the log. Sustained hits mean the
			// warm coordinator's budget is too high relative to interactive load.
			logUpstreamRateLimit(requestType)
		}
		if owner {
			resolveProxyInfoInflight(cacheKey, inflight, nil, fmt.Errorf("/info upstream HTTP %d", resp.StatusCode))
		}
		c.JSON(http.StatusBadGateway, gin.H{
			"error":  fmt.Sprintf("/info upstream HTTP %d", resp.StatusCode),
			"status": resp.StatusCode,
			"body":   truncateForLog(trimmed),
		})
		return
	}
	if trimmed == "" {
		if owner {
			resolveProxyInfoInflight(cacheKey, inflight, nil, fmt.Errorf("empty upstream response"))
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": "empty upstream response"})
		return
	}
	firstChar := trimmed[0]
	if firstChar != '{' && firstChar != '[' {
		if owner {
			resolveProxyInfoInflight(cacheKey, inflight, nil, fmt.Errorf("non-json upstream response"))
		}
		c.JSON(http.StatusBadGateway, gin.H{
			"error": "non-json upstream response",
			"body":  truncateForLog(trimmed),
		})
		return
	}
	if cacheKey != "" {
		setProxyInfoCache(cacheKey, respBody, cacheTTL)
	}
	if owner {
		resolveProxyInfoInflight(cacheKey, inflight, respBody, nil)
	}
	c.Data(http.StatusOK, "application/json", respBody)
}
