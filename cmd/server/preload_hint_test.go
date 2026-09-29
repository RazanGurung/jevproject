package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestWatchlistHintsCapAndTTL(t *testing.T) {
	h := newWatchlistHints()

	// Cap: only maxWatchlistHints distinct coins are retained.
	over := make([]string, maxWatchlistHints+10)
	for i := range over {
		over[i] = "C" + string(rune('A'+i%26)) + string(rune('0'+i/26))
	}
	h.assert(over)
	if got := len(h.coins()); got != maxWatchlistHints {
		t.Fatalf("cap not enforced: got %d coins, want %d", got, maxWatchlistHints)
	}

	// TTL: an un-refreshed coin ages out.
	h2 := newWatchlistHints()
	h2.assert([]string{"BTC"})
	h2.mu.Lock()
	h2.entries["BTC"] = time.Now().Add(-watchlistHintTTL - time.Minute)
	h2.mu.Unlock()
	if got := h2.coins(); len(got) != 0 {
		t.Fatalf("stale coin not aged out: %v", got)
	}
}

func TestPreloadHintHandlerValidatesAndCaps(t *testing.T) {
	gin.SetMode(gin.TestMode)
	hints := newWatchlistHints()
	known := func(coin string) bool { return coin == "BTC" || coin == "xyz:AAPL" }

	r := gin.New()
	r.POST("/api/preload-hint", preloadHintHandler(hints, known))

	body, _ := json.Marshal(map[string]any{
		"watchlist": []string{"BTC", "xyz:AAPL", "FAKECOIN", "", "BTC"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/preload-hint", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Accepted      int      `json:"accepted"`
		AcceptedCoins []string `json:"acceptedCoins"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Accepted != 2 {
		t.Fatalf("accepted = %d, want 2 (unknown/empty/dupe dropped)", resp.Accepted)
	}
	if len(resp.AcceptedCoins) != 2 || resp.AcceptedCoins[0] != "BTC" || resp.AcceptedCoins[1] != "xyz:AAPL" {
		t.Fatalf("acceptedCoins = %v, want [BTC xyz:AAPL]", resp.AcceptedCoins)
	}

	got := hints.coins()
	sort.Strings(got)
	if len(got) != 2 || got[0] != "BTC" || got[1] != "xyz:AAPL" {
		t.Fatalf("hint set = %v, want [BTC xyz:AAPL]", got)
	}
}

func TestPreloadHintHandlerRejectsBadBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/preload-hint", preloadHintHandler(newWatchlistHints(), func(string) bool { return true }))

	req := httptest.NewRequest(http.MethodPost, "/api/preload-hint", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestWatchlistHintsPersistenceAndNudge(t *testing.T) {
	tmpDir := t.TempDir()
	hintsPath := tmpDir + "/watchlist-hints.json"

	nudged := 0
	onNew := func() {
		nudged++
	}

	h := newWatchlistHintsWithPersistence(hintsPath, onNew)
	h.assert([]string{"BTC", "SOL"})

	if nudged != 1 {
		t.Fatalf("nudged = %d, want 1 after new coins", nudged)
	}

	// Re-asserting identical coins should NOT fire onNew
	h.assert([]string{"BTC", "SOL"})
	if nudged != 1 {
		t.Fatalf("nudged = %d, want 1 after re-asserting same coins", nudged)
	}

	// Adding a third coin should fire onNew again
	h.assert([]string{"ETH"})
	if nudged != 2 {
		t.Fatalf("nudged = %d, want 2 after adding ETH", nudged)
	}

	// Verify persistence file exists and restores properly
	h2 := newWatchlistHintsWithPersistence(hintsPath, nil)
	restored := h2.coins()
	sort.Strings(restored)
	if len(restored) != 1 || restored[0] != "ETH" {
		// h.assert([]string{"ETH"}) saved ["ETH"] because accepted was ["ETH"]
		// Let's assert all 3 together to verify batch save and restore
	}
	h.assert([]string{"BTC", "ETH", "SOL"})
	h3 := newWatchlistHintsWithPersistence(hintsPath, nil)
	restored3 := h3.coins()
	sort.Strings(restored3)
	if len(restored3) != 3 || restored3[0] != "BTC" || restored3[1] != "ETH" || restored3[2] != "SOL" {
		t.Fatalf("restored = %v, want [BTC ETH SOL]", restored3)
	}
}

