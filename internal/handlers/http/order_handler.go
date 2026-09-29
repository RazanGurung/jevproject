package http

import (
	"net/http"
	"strconv"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/keycache"
	"hyperliquid-go/internal/services"

	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	orderService *services.OrderService
}

func NewOrderHandler(os *services.OrderService) *OrderHandler {
	return &OrderHandler{orderService: os}
}

func (h *OrderHandler) PlaceOrder(c *gin.Context) {
	var req models.OrderRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	// PlaceOrder always returns a non-nil result whose Error field mirrors any
	// error return, so the envelope is the single source the client reads.
	resp, _ := h.orderService.PlaceOrder(c.Request.Context(), req)

	status := http.StatusOK
	if resp.Error == "rate limit exceeded" {
		status = http.StatusTooManyRequests
	}
	c.JSON(status, resp)
}

func (h *OrderHandler) PlaceBulkOrders(c *gin.Context) {
	var req models.BulkOrderRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	result, err := h.orderService.PlaceBulkOrders(c.Request.Context(), req)
	if err != nil && err.Error() == "rate limit exceeded" {
		c.JSON(http.StatusTooManyRequests, result)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *OrderHandler) ScalePreview(c *gin.Context) {
	var req models.ScalePreviewRequest
	if !bindJSON(c, &req) {
		return
	}

	result, err := h.orderService.BuildScalePreview(c.Request.Context(), req)
	if err != nil {
		respondError(c, http.StatusBadRequest, err)
		return
	}

	c.JSON(http.StatusOK, result)
}

func (h *OrderHandler) CancelOrder(c *gin.Context) {
	var req struct {
		PrivateKey string `json:"privateKey"`
		Coin       string `json:"coin"`
		Oid        int64  `json:"oid"`
		Testnet    bool   `json:"testnet"`
	}
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	err := h.orderService.CancelOrder(c.Request.Context(), req.PrivateKey, req.Coin, req.Oid, req.Testnet)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	respondStatusOK(c)
}

func (h *OrderHandler) BulkCancel(c *gin.Context) {
	var req models.BulkCancelRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	cancelledOids, err := h.orderService.BulkCancel(c.Request.Context(), req)
	if err != nil && len(cancelledOids) == 0 {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	status := "ok"
	if len(cancelledOids) < len(req.Cancels) {
		status = "partial"
	}
	resp := gin.H{"status": status, "cancelled": len(cancelledOids), "cancelledOids": cancelledOids}
	if err != nil {
		resp["error"] = err.Error()
	}
	c.JSON(http.StatusOK, resp)
}

func (h *OrderHandler) PlaceTrigger(c *gin.Context) {
	var req models.TriggerOrderRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	err := h.orderService.PlaceTrigger(c.Request.Context(), req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	respondStatusOK(c)
}

func (h *OrderHandler) KeyAddress(c *gin.Context) {
	var req struct {
		PrivateKey string `json:"privateKey"`
	}
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	address, err := h.orderService.GetAddressFromKey(req.PrivateKey)
	if err != nil {
		respondError(c, http.StatusBadRequest, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"address": address})
}

func (h *OrderHandler) ModifyOrder(c *gin.Context) {
	var req models.ModifyOrderRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	newOid, err := h.orderService.ModifyOrder(c.Request.Context(), req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	// oid is the replacement oid Hyperliquid assigned (modify = cancel+replace);
	// clients re-key their optimistic state to it instead of waiting for the
	// next account snapshot.
	c.JSON(http.StatusOK, gin.H{"status": "ok", "oid": newOid})
}

func (h *OrderHandler) PlaceTwap(c *gin.Context) {
	var req models.TwapOrderRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	resp, err := h.orderService.PlaceTwap(c.Request.Context(), req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "response": resp})
}

func (h *OrderHandler) CancelTwap(c *gin.Context) {
	var req models.TwapCancelRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	resp, err := h.orderService.CancelTwap(c.Request.Context(), req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "response": resp})
}

func (h *OrderHandler) CancelByCloid(c *gin.Context) {
	var req models.CancelByCloidRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	err := h.orderService.CancelByCloid(c.Request.Context(), req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	respondStatusOK(c)
}

func (h *OrderHandler) BulkModifyOrders(c *gin.Context) {
	var req models.BulkModifyOrderRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	newOids, err := h.orderService.BulkModifyOrders(c.Request.Context(), req)
	if err != nil {
		confirmed := 0
		for _, oid := range newOids {
			if oid > 0 {
				confirmed++
			}
		}
		if confirmed == 0 {
			respondError(c, http.StatusInternalServerError, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "partial", "oids": newOids, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "oids": newOids})
}

func (h *OrderHandler) ScheduleCancel(c *gin.Context) {
	var req models.ScheduleCancelRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	err := h.orderService.ScheduleCancel(c.Request.Context(), req)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	respondStatusOK(c)
}

func (h *OrderHandler) GetJournalExecutions(c *gin.Context) {
	coin := c.Query("coin")
	action := c.Query("action")
	limitStr := c.DefaultQuery("limit", "100")
	limit, _ := strconv.Atoi(limitStr)

	journal := h.orderService.GetJournal()
	if journal == nil {
		c.JSON(http.StatusOK, gin.H{"entries": []models.JournalEntry{}, "count": 0})
		return
	}

	entries := journal.GetEntries(coin, action, limit)
	c.JSON(http.StatusOK, gin.H{"entries": entries, "count": len(entries)})
}

func (h *OrderHandler) GetJournalSummary(c *gin.Context) {
	journal := h.orderService.GetJournal()
	if journal == nil {
		c.JSON(http.StatusOK, models.JournalSummary{})
		return
	}

	summary := journal.GetSummary()
	c.JSON(http.StatusOK, summary)
}

func loadPrivateKey() string {
	return keycache.GetWithFallback()
}
