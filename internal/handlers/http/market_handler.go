package http

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"hyperliquid-go/internal/services"

	"github.com/gin-gonic/gin"
)

type MarketHandler struct {
	marketService *services.MarketDataService
}

const maxNewsCoins = 17

func NewMarketHandler(ms *services.MarketDataService) *MarketHandler {
	return &MarketHandler{marketService: ms}
}

func (h *MarketHandler) GetL2Snapshot(c *gin.Context) {
	var req struct {
		Coin    string `json:"coin"`
		Depth   int    `json:"depth"`
		Testnet bool   `json:"testnet"`
	}
	if !bindJSON(c, &req) {
		return
	}

	depth := req.Depth
	if depth == 0 {
		depth = 10
	}

	book, err := h.marketService.GetL2Snapshot(c.Request.Context(), req.Coin, depth, req.Testnet)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	c.JSON(http.StatusOK, book)
}

func (h *MarketHandler) GetCoinMeta(c *gin.Context) {
	coin := c.Query("coin")
	if coin == "" {
		// Return all cached metadata when no coin specified (backwards compat)
		meta := h.marketService.GetAllCachedMeta()
		c.JSON(http.StatusOK, meta)
		return
	}
	meta, err := h.marketService.GetCoinMeta(c.Request.Context(), coin)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, meta)
}

func (h *MarketHandler) Get24hChanges(c *gin.Context) {
	// Prefer the rich asset snapshot (change + vol/OI/funding) so the watchlist
	// and other multi-coin surfaces can render trading-trigger columns from the
	// same poll. Falls back to the plain change map if snapshots fail.
	snapshots, err := h.marketService.GetAssetSnapshots(c.Request.Context())
	if err != nil {
		changes, changeErr := h.marketService.Get24hChanges(c.Request.Context())
		if changeErr != nil {
			respondError(c, http.StatusInternalServerError, err)
			return
		}
		c.JSON(http.StatusOK, changes)
		return
	}
	c.JSON(http.StatusOK, snapshots)
}

func (h *MarketHandler) GetMarketMovers(c *gin.Context) {
	movers, err := h.marketService.GetRankedMovers(c.Request.Context())
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, movers)
}

func (h *MarketHandler) GetStockMispricing(c *gin.Context) {
	entries, err := h.marketService.GetStockMispricings(c.Request.Context())
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, entries)
}

func (h *MarketHandler) GetNewsConfig(c *gin.Context) {
	c.JSON(http.StatusOK, h.marketService.GetNewsConfig())
}

func (h *MarketHandler) GetNews(c *gin.Context) {
	rawCoins := c.Query("coins")
	if strings.TrimSpace(rawCoins) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "coins query parameter is required"})
		return
	}
	coins := strings.Split(rawCoins, ",")
	if len(coins) > maxNewsCoins {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("at most %d coins are supported", maxNewsCoins)})
		return
	}
	seen := make(map[string]struct{}, len(coins))
	normalized := make([]string, 0, len(coins))
	for _, coin := range coins {
		coin = strings.TrimSpace(coin)
		if coin == "" {
			continue
		}
		if len(coin) > 64 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "coin is too long"})
			return
		}
		if _, ok := seen[coin]; ok {
			continue
		}
		seen[coin] = struct{}{}
		normalized = append(normalized, coin)
	}
	if len(normalized) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one coin is required"})
		return
	}
	items, err := h.marketService.GetNews(c.Request.Context(), normalized)
	config := h.marketService.GetNewsConfig()
	payload := gin.H{
		"configured": config["configured"],
		"provider":   config["provider"],
		"providers":  config["providers"],
		"health":     config["health"],
		"items":      items,
		"global":     h.marketService.GetGlobalNews(),
		"asOf":       time.Now().UTC(),
	}
	if err != nil {
		payload["error"] = err.Error()
		payload["stale"] = true
	}
	c.JSON(http.StatusOK, payload)
}
