package http

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/services"
	"hyperliquid-go/pkg/utils"

	"github.com/gin-gonic/gin"
)

type AccountHandler struct {
	accountService *services.AccountService
	accountRuntime *services.AccountRuntime
	cache          *services.CachedAccountService
}

const freshAccountBurstTTL = 1500 * time.Millisecond

func NewAccountHandler(as *services.AccountService, runtime *services.AccountRuntime, cache *services.CachedAccountService) *AccountHandler {
	return &AccountHandler{
		accountService: as,
		accountRuntime: runtime,
		cache:          cache,
	}
}

func (h *AccountHandler) GetAccount(c *gin.Context) {
	snapshotRequestedAt := time.Now().UnixMilli()
	var req models.AccountRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		slog.Warn("GetAccount: bad request", "error", err.Error())
		respondError(c, http.StatusBadRequest, err)
		return
	}

	if !req.Force && h.cache != nil {
		if cached, ok := h.cache.GetFresh(req.Address, freshAccountBurstTTL); ok {
			c.JSON(http.StatusOK, cached)
			return
		}
	}

	var (
		resp        map[string]interface{}
		orders      []interface{}
		err         error
		ordErr      error
		ordersStale bool
		hasOrders   bool
		wg          sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		if req.Force {
			resp, err = h.accountService.GetAccountFresh(c.Request.Context(), req.Address)
		} else {
			resp, err = h.accountService.GetAccount(c.Request.Context(), req.Address)
		}
	}()
	go func() {
		defer wg.Done()
		orders, ordErr = h.accountService.GetOpenOrders(c.Request.Context(), req.Address)
	}()
	wg.Wait()

	if err != nil {
		slog.Warn("GetAccount: service error", "error", err.Error())
		if cached, ok := h.cache.Get(req.Address); ok {
			c.JSON(http.StatusOK, cached)
			return
		}
		if cached, ok := h.cache.GetLastKnown(req.Address); ok {
			c.JSON(http.StatusOK, cached)
			return
		}
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	if ordErr != nil {
		slog.Warn("GetAccount: open orders error", "error", ordErr.Error())
		if h.accountRuntime != nil {
			runtimeSnapshot := h.accountRuntime.GetSnapshot(req.Address)
			if runtimeSnapshot.HasSnapshot {
				orders = runtimeSnapshot.Orders
				hasOrders = true
				ordersStale = !runtimeSnapshot.OrderFresh
			} else if cached, ok := h.cache.Get(req.Address); ok {
				if cachedOrders, ok := cached["orders"].([]interface{}); ok {
					orders = cachedOrders
					hasOrders = true
					ordersStale = true
				} else {
					hasOrders = false
				}
			} else {
				hasOrders = false
			}
		} else if cached, ok := h.cache.Get(req.Address); ok {
			if cachedOrders, ok := cached["orders"].([]interface{}); ok {
				orders = cachedOrders
				hasOrders = true
				ordersStale = true
			} else {
				hasOrders = false
			}
		} else {
			hasOrders = false
		}
	} else {
		if h.accountRuntime != nil {
			runtimeSnapshot := h.accountRuntime.UpdateOrdersFromSnapshot(req.Address, orders, true)
			orders = runtimeSnapshot.Orders
		}
		hasOrders = true
	}

	resp = services.NormalizeAccountState(resp)
	resp["accountSnapshotAt"] = snapshotRequestedAt
	resp["accountSnapshotStale"] = false

	payload := gin.H{
		"state": resp,
	}
	if hasOrders {
		payload["orders"] = orders
	}
	if ordersStale {
		payload["ordersStale"] = true
	}
	if h.accountRuntime != nil {
		if runtimeSnapshot := h.accountRuntime.GetSnapshot(req.Address); runtimeSnapshot.HasSnapshot {
			payload["orderRevision"] = runtimeSnapshot.Revision
			payload["ordersFresh"] = runtimeSnapshot.OrderFresh
		}
	}
	h.cache.Set(req.Address, payload)

	body, err := json.Marshal(payload)
	if err != nil {
		slog.Error("GetAccount: marshal error", "error", err.Error())
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to encode account response"})
		return
	}

	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

func (h *AccountHandler) GetFills(c *gin.Context) {
	var req struct {
		Address string `json:"address"`
		Mainnet bool   `json:"mainnet"`
	}
	if !bindJSON(c, &req) {
		return
	}

	fills, err := h.accountService.GetFills(c.Request.Context(), req.Address)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			status = http.StatusGatewayTimeout
		}
		respondError(c, status, err)
		return
	}

	c.JSON(http.StatusOK, fills)
}

func (h *AccountHandler) ClosePosition(c *gin.Context) {
	var req models.ClosePositionRequest
	if !bindJSON(c, &req) {
		return
	}

	// Signed routes always use the cached backend key (same convention as the
	// order handlers); a frontend-supplied raw key is compatibility input only
	// and is not honored here.
	req.PrivateKey = loadPrivateKey()

	testnet := req.Testnet
	if req.Mainnet {
		testnet = false
	}

	result, err := h.accountService.ClosePosition(c.Request.Context(), req.PrivateKey, req.Address, req.Coin, req.Fraction, req.PositionSize, req.PositionSzi, testnet)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}
	if result.Status == "" {
		result.Status = "ok"
	}
	c.JSON(http.StatusOK, result)
}

func (h *AccountHandler) SetLeverage(c *gin.Context) {
	var req models.SetLeverageRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	isCross := true
	if req.IsCross != nil {
		isCross = *req.IsCross
	} else if utils.IsBuilderPerpCoin(req.Coin) {
		// HIP-3 / builder perps are typically isolated-only.
		isCross = false
	}
	err := h.accountService.SetLeverage(c.Request.Context(), req.PrivateKey, req.Coin, req.Leverage, isCross, req.Testnet && !req.Mainnet)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	respondStatusOK(c)
}

func (h *AccountHandler) UpdateMargin(c *gin.Context) {
	var req models.UpdateIsolatedMarginRequest
	if !bindJSON(c, &req) {
		return
	}

	req.PrivateKey = loadPrivateKey()

	err := h.accountService.UpdateIsolatedMargin(c.Request.Context(), req.PrivateKey, req.Coin, req.Ntli, req.Testnet && !req.Mainnet)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	respondStatusOK(c)
}

func (h *AccountHandler) GetActiveAssetData(c *gin.Context) {
	var req struct {
		Address string `json:"address"`
		Coin    string `json:"coin"`
		Mainnet bool   `json:"mainnet"`
	}
	if !bindJSON(c, &req) {
		return
	}

	data, err := h.accountService.GetActiveAssetData(c.Request.Context(), req.Address, req.Coin)
	if err != nil {
		respondError(c, http.StatusBadGateway, err)
		return
	}

	c.JSON(http.StatusOK, data)
}

func (h *AccountHandler) OrderPreview(c *gin.Context) {
	var req struct {
		Address         string  `json:"address"`
		Coin            string  `json:"coin"`
		IsBuy           bool    `json:"isBuy"`
		Sz              float64 `json:"sz"`
		SizeUSD         float64 `json:"sizeUsd"`
		Leverage        int     `json:"leverage"`
		LimitPx         float64 `json:"limitPx"`
		Mainnet         bool    `json:"mainnet"`
		Testnet         bool    `json:"testnet"`
		AccountValue    float64 `json:"accountValue"`    // optional: frontend passes cached value to skip fetch
		AvailableEquity float64 `json:"availableEquity"` // optional: frontend passes cached value
	}
	if !bindJSON(c, &req) {
		return
	}

	sizeUSD := req.SizeUSD
	if sizeUSD <= 0 {
		sizeUSD = req.Sz
	}

	preview, err := h.accountService.OrderPreview(
		c.Request.Context(),
		req.Address,
		req.Coin,
		req.IsBuy,
		sizeUSD,
		req.LimitPx,
		req.Leverage,
		req.AccountValue,
		req.AvailableEquity,
	)
	if err != nil {
		respondError(c, http.StatusInternalServerError, err)
		return
	}

	c.JSON(http.StatusOK, preview)
}
