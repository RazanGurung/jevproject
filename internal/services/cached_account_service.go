package services

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const DefaultAccountCacheTTL = 30 * time.Second
const maxCachedAccounts = 256

type cachedAccountEntry struct {
	payload   gin.H
	fetchedAt time.Time
}

// CachedAccountService wraps AccountService with a per-address TTL cache.
// On a cache hit it returns the payload with "stale: true" injected.
type CachedAccountService struct {
	mu     sync.RWMutex
	byAddr map[string]cachedAccountEntry
	ttl    time.Duration
}

// clonePayload returns a deep copy of a JSON-like account payload so callers
// can mark stale flags or mutate nested maps without racing the cache.
// Prefer a structured walk over JSON marshal/unmarshal on the hot Get path.
func clonePayload(payload gin.H) gin.H {
	if payload == nil {
		return nil
	}
	if cloned, ok := deepCloneValue(map[string]interface{}(payload)).(map[string]interface{}); ok {
		return gin.H(cloned)
	}
	// Extremely defensive fallback for types deepCloneValue cannot handle.
	body, err := json.Marshal(payload)
	if err != nil {
		out := gin.H{}
		for k, v := range payload {
			out[k] = v
		}
		return out
	}
	var cloned gin.H
	if err := json.Unmarshal(body, &cloned); err != nil {
		out := gin.H{}
		for k, v := range payload {
			out[k] = v
		}
		return out
	}
	return cloned
}

// deepCloneValue recursively copies maps and slices used in account JSON
// payloads. Scalar values and unknown types are returned as-is (immutable or
// caller-owned).
func deepCloneValue(v interface{}) interface{} {
	switch x := v.(type) {
	case nil:
		return nil
	case map[string]interface{}:
		out := make(map[string]interface{}, len(x))
		for k, child := range x {
			out[k] = deepCloneValue(child)
		}
		return out
	case gin.H:
		out := make(map[string]interface{}, len(x))
		for k, child := range x {
			out[k] = deepCloneValue(child)
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(x))
		for i, child := range x {
			out[i] = deepCloneValue(child)
		}
		return out
	case []map[string]interface{}:
		out := make([]interface{}, len(x))
		for i, child := range x {
			out[i] = deepCloneValue(child)
		}
		return out
	default:
		// bool, string, numeric types, time.Time, etc. are immutable or copied by value.
		return v
	}
}

func NewCachedAccountService(ttl time.Duration) *CachedAccountService {
	return &CachedAccountService{
		byAddr: make(map[string]cachedAccountEntry),
		ttl:    ttl,
	}
}

// Get returns a defensive copy of the cached payload with "stale: true" set,
// and true if the entry exists and is within TTL. Returns nil, false otherwise.
func (c *CachedAccountService) Get(address string) (gin.H, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.byAddr[address]
	if !ok || entry.payload == nil {
		return nil, false
	}
	if time.Since(entry.fetchedAt) > c.ttl {
		return nil, false
	}
	return markCachedPayloadStale(clonePayload(entry.payload)), true
}

// GetLastKnown returns the most recent snapshot even after the normal TTL.
// It is used only when the upstream account fan-out failed, so a degraded
// exchange returns an explicitly stale dashboard instead of HTTP 500/blank
// balances. Entries remain memory-bounded by Set's pruning and max size.
func (c *CachedAccountService) GetLastKnown(address string) (gin.H, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.byAddr[address]
	if !ok || entry.payload == nil {
		return nil, false
	}
	return markCachedPayloadStale(clonePayload(entry.payload)), true
}

func markCachedPayloadStale(payload gin.H) gin.H {
	if payload == nil {
		return nil
	}
	payload["stale"] = true
	if state, ok := payload["state"].(map[string]interface{}); ok && state != nil {
		state["accountSnapshotStale"] = true
		state["riskSummaryFresh"] = false
	}
	return payload
}

// GetFresh returns a defensive copy of a recent cached payload without forcing
// the caller to treat it as stale. It is intended for short-lived read bursts
// where avoiding another upstream account fan-out is more valuable than forcing
// a brand-new refresh.
func (c *CachedAccountService) GetFresh(address string, maxAge time.Duration) (gin.H, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.byAddr[address]
	if !ok || entry.payload == nil {
		return nil, false
	}
	if maxAge <= 0 || time.Since(entry.fetchedAt) > maxAge {
		return nil, false
	}
	return clonePayload(entry.payload), true
}

// Set stores a defensive copy of payload for the given address.
func (c *CachedAccountService) Set(address string, payload gin.H) {
	if address == "" || payload == nil {
		return
	}
	c.mu.Lock()
	now := time.Now()
	for key, entry := range c.byAddr {
		if now.Sub(entry.fetchedAt) > c.ttl {
			delete(c.byAddr, key)
		}
	}
	if _, exists := c.byAddr[address]; !exists && len(c.byAddr) >= maxCachedAccounts {
		var oldestKey string
		var oldest time.Time
		for key, entry := range c.byAddr {
			if oldestKey == "" || entry.fetchedAt.Before(oldest) {
				oldestKey, oldest = key, entry.fetchedAt
			}
		}
		if oldestKey != "" {
			delete(c.byAddr, oldestKey)
		}
	}
	c.byAddr[address] = cachedAccountEntry{
		payload:   clonePayload(payload),
		fetchedAt: now,
	}
	c.mu.Unlock()
}
