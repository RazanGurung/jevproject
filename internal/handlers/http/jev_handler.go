package http

import (
	"net/http"
	"strings"

	"hyperliquid-go/internal/services"

	"github.com/gin-gonic/gin"
)

type JevHandler struct {
	jevService *services.JevService
}

func NewJevHandler(js *services.JevService) *JevHandler {
	return &JevHandler{jevService: js}
}

// Status returns whether the TypeSafe Jev model is configured and ready.
// It strictly maintains anonymity: no secret keys or key fragments are ever returned.
func (h *JevHandler) Status(c *gin.Context) {
	if h.jevService == nil || !h.jevService.IsAvailable() {
		c.JSON(http.StatusOK, gin.H{
			"available": false,
			"model":     "",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"available": true,
		"model":     h.jevService.Model(),
	})
}

// Analyze receives a coin and returns real-time market analysis and structured Jev decisions.
func (h *JevHandler) Analyze(c *gin.Context) {
	if h.jevService == nil || !h.jevService.IsAvailable() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "TypeSafe Jev service is not available (missing API key)",
		})
		return
	}

	var req struct {
		Coin string `json:"coin"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Coin) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "coin is required"})
		return
	}

	result, err := h.jevService.Analyze(c.Request.Context(), req.Coin)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// ClassifyNews receives a headline and returns Jev's semantic sentiment and catalyst impact.
func (h *JevHandler) ClassifyNews(c *gin.Context) {
	if h.jevService == nil || !h.jevService.IsAvailable() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "TypeSafe Jev service is not available (missing API key)",
		})
		return
	}

	var req struct {
		Headline string `json:"headline"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Headline) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "headline is required"})
		return
	}

	result, err := h.jevService.ClassifyNewsHeadline(c.Request.Context(), req.Headline)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// PreTradeAudit receives order parameters and returns Jev's pre-flight slippage and adverse flow evaluation.
func (h *JevHandler) PreTradeAudit(c *gin.Context) {
	if h.jevService == nil || !h.jevService.IsAvailable() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "TypeSafe Jev service is not available (missing API key)",
		})
		return
	}

	var req struct {
		Coin    string  `json:"coin"`
		IsBuy   bool    `json:"isBuy"`
		SizeUSD float64 `json:"sizeUsd"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Coin) == "" || req.SizeUSD <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "valid coin and positive sizeUsd are required"})
		return
	}

	result, err := h.jevService.AuditPreTrade(c.Request.Context(), req.Coin, req.IsBuy, req.SizeUSD)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// EvaluateMispricing receives synthetic asset deviation and returns Jev's arbitrage vs informed move verdict.
func (h *JevHandler) EvaluateMispricing(c *gin.Context) {
	if h.jevService == nil || !h.jevService.IsAvailable() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "TypeSafe Jev service is not available (missing API key)",
		})
		return
	}

	var req struct {
		Coin           string  `json:"coin"`
		MarkPrice      float64 `json:"markPrice"`
		ReferenceClose float64 `json:"referenceClose"`
		DeviationPct   float64 `json:"deviationPct"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Coin) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "coin is required"})
		return
	}

	result, err := h.jevService.EvaluateMispricing(c.Request.Context(), req.Coin, req.MarkPrice, req.ReferenceClose, req.DeviationPct)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// Signal receives an optional coin parameter (via GET query or POST JSON)
// and returns Jev's real-time actionable trade recommendation with entry, TP, and SL.
func (h *JevHandler) Signal(c *gin.Context) {
	if h.jevService == nil || !h.jevService.IsAvailable() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "TypeSafe Jev service is not available (missing API key)",
		})
		return
	}

	coin := strings.TrimSpace(c.Query("coin"))
	timeframe := strings.TrimSpace(c.Query("timeframe"))
	if coin == "" && c.Request.Method == http.MethodPost {
		var req struct {
			Coin      string `json:"coin"`
			Timeframe string `json:"timeframe"`
		}
		if err := c.ShouldBindJSON(&req); err == nil {
			if strings.TrimSpace(req.Coin) != "" {
				coin = strings.TrimSpace(req.Coin)
			}
			if strings.TrimSpace(req.Timeframe) != "" {
				timeframe = strings.TrimSpace(req.Timeframe)
			}
		}
	}

	if coin == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "coin is required"})
		return
	}

	signal, err := h.jevService.GenerateSignal(c.Request.Context(), coin, timeframe)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, signal)
}
