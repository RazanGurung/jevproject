package services

import (
	"fmt"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestCachedAccountServiceBoundsEntries(t *testing.T) {
	cache := NewCachedAccountService(time.Hour)
	for i := 0; i < maxCachedAccounts+8; i++ {
		cache.Set(fmt.Sprintf("0x%040d", i), gin.H{"state": i})
	}
	if got := len(cache.byAddr); got != maxCachedAccounts {
		t.Fatalf("cache entries = %d, want %d", got, maxCachedAccounts)
	}
}

func TestCachedAccountServicePrunesExpiredEntriesOnSet(t *testing.T) {
	cache := NewCachedAccountService(time.Millisecond)
	cache.Set("old", gin.H{"state": "old"})
	time.Sleep(2 * time.Millisecond)
	cache.Set("fresh", gin.H{"state": "fresh"})
	if _, ok := cache.byAddr["old"]; ok {
		t.Fatal("expired entry was retained after a cache write")
	}
}

func TestCachedAccountServiceReturnsExpiredSnapshotOnlyAsLastKnown(t *testing.T) {
	cache := NewCachedAccountService(time.Millisecond)
	cache.Set("account", gin.H{"state": map[string]interface{}{
		"accountSnapshotStale": false,
		"riskSummaryFresh":     true,
	}})
	time.Sleep(2 * time.Millisecond)
	if _, ok := cache.Get("account"); ok {
		t.Fatal("normal cache lookup returned an expired entry")
	}
	payload, ok := cache.GetLastKnown("account")
	if !ok || payload["stale"] != true {
		t.Fatalf("last-known lookup = (%v,%v), want stale payload", payload, ok)
	}
	state, _ := payload["state"].(map[string]interface{})
	if state["accountSnapshotStale"] != true || state["riskSummaryFresh"] != false {
		t.Fatalf("stale state flags = %v", state)
	}
}

func TestCachedAccountServiceCloneIsolatesCallerMutations(t *testing.T) {
	cache := NewCachedAccountService(time.Hour)
	original := gin.H{
		"wallet": "0xabc",
		"state": map[string]interface{}{
			"accountValue":         "100",
			"accountSnapshotStale": false,
			"riskSummaryFresh":     true,
			"positions": []interface{}{
				map[string]interface{}{"coin": "BTC", "szi": "0.1"},
			},
		},
	}
	cache.Set("account", original)

	// Mutating the Set input must not affect the store.
	original["wallet"] = "mutated"
	original["state"].(map[string]interface{})["accountValue"] = "0"

	got, ok := cache.GetFresh("account", time.Hour)
	if !ok {
		t.Fatal("expected fresh cache hit")
	}
	if got["wallet"] != "0xabc" {
		t.Fatalf("store saw Set-input mutation: wallet=%v", got["wallet"])
	}
	state, _ := got["state"].(map[string]interface{})
	if state["accountValue"] != "100" {
		t.Fatalf("store saw nested Set-input mutation: %v", state["accountValue"])
	}

	// Mutating Get / GetFresh / GetLastKnown results must not affect later reads.
	got["wallet"] = "caller"
	state["accountValue"] = "hacked"
	state["positions"].([]interface{})[0].(map[string]interface{})["coin"] = "ETH"
	// markCachedPayloadStale path
	stale, ok := cache.Get("account")
	if !ok || stale["stale"] != true {
		t.Fatalf("Get stale path failed: %v %v", stale, ok)
	}
	staleState, _ := stale["state"].(map[string]interface{})
	if staleState["accountValue"] != "100" {
		t.Fatalf("caller mutation leaked into Get: %v", staleState["accountValue"])
	}
	if pos := staleState["positions"].([]interface{})[0].(map[string]interface{}); pos["coin"] != "BTC" {
		t.Fatalf("nested slice mutation leaked: %v", pos)
	}
	// Stale flags must only appear on the returned copy, not poison GetFresh.
	fresh, ok := cache.GetFresh("account", time.Hour)
	if !ok {
		t.Fatal("expected fresh after Get")
	}
	if fresh["stale"] == true {
		t.Fatal("stale flag leaked into stored payload")
	}
	freshState, _ := fresh["state"].(map[string]interface{})
	if freshState["accountSnapshotStale"] == true {
		t.Fatal("accountSnapshotStale leaked into stored payload")
	}
}

func TestCachedAccountServiceConcurrentGetSet(t *testing.T) {
	cache := NewCachedAccountService(time.Hour)
	cache.Set("account", gin.H{"n": 0, "state": map[string]interface{}{"v": 0}})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			cache.Set("account", gin.H{
				"n":     i,
				"state": map[string]interface{}{"v": i, "nested": []interface{}{i}},
			})
		}
	}()
	for i := 0; i < 200; i++ {
		if payload, ok := cache.Get("account"); ok {
			_ = payload["n"]
			if state, ok := payload["state"].(map[string]interface{}); ok {
				state["v"] = -1 // must not race the store
			}
		}
		if payload, ok := cache.GetFresh("account", time.Hour); ok {
			_ = payload["n"]
		}
	}
	<-done
	if _, ok := cache.GetFresh("account", time.Hour); !ok {
		t.Fatal("cache empty after concurrent Get/Set")
	}
}

func BenchmarkClonePayload(b *testing.B) {
	payload := gin.H{
		"wallet": "0xabc",
		"state": map[string]interface{}{
			"accountValue": "12345.67",
			"positions": []interface{}{
				map[string]interface{}{"coin": "BTC", "szi": "1.5", "entryPx": "50000"},
				map[string]interface{}{"coin": "ETH", "szi": "10", "entryPx": "3000"},
			},
			"openOrders": []interface{}{
				map[string]interface{}{"oid": float64(1), "coin": "BTC", "sz": "0.1"},
			},
		},
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = clonePayload(payload)
	}
}
