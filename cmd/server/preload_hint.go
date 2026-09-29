package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	// maxWatchlistHints caps the watchlist hint set so many browsers/users
	// posting different watchlists can't grow it without bound or balloon the
	// warm coordinator's budget.
	maxWatchlistHints = 50
	// watchlistHintTTL ages out coins that haven't been re-asserted, so a closed
	// tab's watchlist stops being warmed. The frontend re-posts well within this
	// window (on change + a periodic keep-alive).
	watchlistHintTTL = 5 * time.Minute
)

// watchlistHints is the server-side set of coins the frontends have asked to be
// kept warm, each stamped with when it was last asserted. The warm coordinator
// reads coins() each reconcile tick. Safe for concurrent use.
type watchlistHints struct {
	mu         sync.Mutex
	entries    map[string]time.Time
	filepath   string
	onNewCoins func()
}

func newWatchlistHints() *watchlistHints {
	return newWatchlistHintsWithPersistence("", nil)
}

func newWatchlistHintsWithPersistence(path string, onNewCoins func()) *watchlistHints {
	w := &watchlistHints{
		entries:    make(map[string]time.Time),
		filepath:   path,
		onNewCoins: onNewCoins,
	}
	if path != "" {
		if loaded, err := loadWatchlistHints(path); err == nil && len(loaded) > 0 {
			now := time.Now()
			for _, coin := range loaded {
				if len(w.entries) < maxWatchlistHints {
					w.entries[coin] = now
				}
			}
			log.Printf("watchlistHints: restored %d saved coins from %s", len(w.entries), path)
		}
	}
	return w
}

func loadWatchlistHints(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var coins []string
	if err := json.Unmarshal(data, &coins); err != nil {
		return nil, err
	}
	return coins, nil
}

func saveWatchlistHints(path string, coins []string) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(coins)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// assert refreshes each coin's last-seen time and returns the exact subset the
// set accepted. New coins are dropped once the set is at capacity
// (already-present coins are always refreshed). Returning identities, not only
// a count, matters when validation or the process-wide cap drops a coin in the
// middle of a browser's ordered watchlist.
func (w *watchlistHints) assert(coins []string) []string {
	now := time.Now()
	w.mu.Lock()
	var hasNew bool
	accepted := make([]string, 0, len(coins))
	for _, coin := range coins {
		if _, ok := w.entries[coin]; !ok {
			if len(w.entries) >= maxWatchlistHints {
				continue
			}
			hasNew = true
		}
		w.entries[coin] = now
		accepted = append(accepted, coin)
	}
	onNew := w.onNewCoins
	path := w.filepath
	var toSave []string
	if path != "" && len(accepted) > 0 {
		toSave = append([]string(nil), accepted...)
	}
	w.mu.Unlock()

	if hasNew && onNew != nil {
		onNew()
	}
	if len(toSave) > 0 {
		_ = saveWatchlistHints(path, toSave)
	}
	return accepted
}

// coins returns the still-fresh hint coins, dropping any past the TTL.
func (w *watchlistHints) coins() []string {
	cutoff := time.Now().Add(-watchlistHintTTL)
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]string, 0, len(w.entries))
	for coin, at := range w.entries {
		if at.Before(cutoff) {
			delete(w.entries, coin)
			continue
		}
		out = append(out, coin)
	}
	return out
}

// preloadHintHandler accepts a watchlist from the (primary) tab and folds the
// valid coins into the hint set. The endpoint is unauthenticated, so it only
// accepts coins known to the perp universe (via known) and caps the count —
// nothing here can make the server warm arbitrary symbols.
func preloadHintHandler(hints *watchlistHints, known func(string) bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Watchlist []string `json:"watchlist"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
		valid := make([]string, 0, len(req.Watchlist))
		seen := make(map[string]bool, len(req.Watchlist))
		for _, coin := range req.Watchlist {
			coin = strings.TrimSpace(coin)
			if coin == "" || seen[coin] || !known(coin) {
				continue
			}
			seen[coin] = true
			valid = append(valid, coin)
			if len(valid) >= maxWatchlistHints {
				break
			}
		}
		accepted := hints.assert(valid)
		c.JSON(http.StatusOK, gin.H{
			"accepted":      len(accepted),
			"acceptedCoins": accepted,
		})
	}
}
