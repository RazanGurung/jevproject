package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"hyperliquid-go/internal/domain/errors"
	"hyperliquid-go/internal/domain/models"
)

// ensureOrderCloid assigns a fresh 128-bit client order id when the request
// does not already carry one. The same value is sent on the wire and returned
// on CanonicalOrderResult so clients can reconcile without re-deriving it.
func ensureOrderCloid(req *models.OrderRequest) error {
	if req == nil {
		return nil
	}
	if strings.TrimSpace(req.Cloid) != "" {
		return nil
	}
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Errorf("generate cloid: %w", err)
	}
	req.Cloid = "0x" + hex.EncodeToString(value[:])
	return nil
}

func isAmbiguousExchangeError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.HasPrefix(msg, "http 408") || strings.HasPrefix(msg, "http 429") || strings.HasPrefix(msg, "http 5") {
		return true
	}
	return strings.Contains(msg, "exchange request failed") ||
		strings.Contains(msg, "failed to read exchange") ||
		strings.Contains(msg, "failed to decode exchange")
}

func (s *OrderService) PlaceOrder(ctx context.Context, req models.OrderRequest) (*models.CanonicalOrderResult, error) {
	start := time.Now()

	if err := s.validate(req); err != nil {
		return &models.CanonicalOrderResult{
			Error:     err.Error(),
			LatencyMs: time.Since(start).Milliseconds(),
		}, err
	}

	if err := ensureOrderCloid(&req); err != nil {
		return &models.CanonicalOrderResult{
			Error:     err.Error(),
			LatencyMs: time.Since(start).Milliseconds(),
		}, err
	}

	address, err := s.resolveTradingAccount(req.PrivateKey)
	if err != nil {
		return &models.CanonicalOrderResult{
			Error:     err.Error(),
			LatencyMs: time.Since(start).Milliseconds(),
		}, err
	}

	weight := s.rateLimiter.Weight(address, 1)
	if !s.rateLimiter.Allow(address, weight) {
		return &models.CanonicalOrderResult{
			Error:     errors.ErrRateLimitExceeded.Error(),
			LatencyMs: time.Since(start).Milliseconds(),
		}, errors.ErrRateLimitExceeded
	}

	if s.exchange == nil {
		return &models.CanonicalOrderResult{
			Accepted:  true,
			Cloid:     req.Cloid,
			LatencyMs: time.Since(start).Milliseconds(),
		}, nil
	}

	mid := s.getPreTradeMid(req.Coin)
	slippage := calculateSlippageBps(mid, req.LimitPx, req.IsBuy)
	side := "BUY"
	if !req.IsBuy {
		side = "SELL"
	}

	resp, err := s.exchange.PlaceOrder(ctx, req)
	if err != nil {
		if !isAmbiguousExchangeError(err) {
			s.rateLimiter.Refund(address, weight)
		}
		s.recordJournal(models.JournalEntry{
			Action:              "PLACE_ORDER",
			Coin:                req.Coin,
			Side:                side,
			Sz:                  req.Sz,
			LimitPx:             req.LimitPx,
			OrderType:           "LIMIT",
			Tif:                 req.Tif,
			ReduceOnly:          req.ReduceOnly,
			Cloid:               req.Cloid,
			PreTradeMid:         mid,
			RealizedSlippageBps: slippage,
			LatencyMs:           time.Since(start).Milliseconds(),
			Success:             false,
			Status:              "error",
			ErrorMessage:        err.Error(),
			Source:              "TICKET",
		})
		return &models.CanonicalOrderResult{
			Cloid:     req.Cloid,
			Error:     err.Error(),
			Ambiguous: isAmbiguousExchangeError(err),
			LatencyMs: time.Since(start).Milliseconds(),
		}, err
	}

	s.publishOrderUpdate(address, resp)
	s.registerAcceptedOrders(address, []models.OrderRequest{req}, []interface{}{resp})
	s.maybeRegisterProtection(ctx, address, req, resp)

	result := normalizeExchangeOrderResult(resp, time.Since(start).Milliseconds())
	result.Cloid = req.Cloid
	s.recordJournal(models.JournalEntry{
		Action:              "PLACE_ORDER",
		Coin:                req.Coin,
		Side:                side,
		Sz:                  req.Sz,
		LimitPx:             req.LimitPx,
		OrderType:           "LIMIT",
		Tif:                 req.Tif,
		ReduceOnly:          req.ReduceOnly,
		Cloid:               req.Cloid,
		Oid:                 result.Oid,
		PreTradeMid:         mid,
		RealizedSlippageBps: slippage,
		LatencyMs:           result.LatencyMs,
		Success:             result.Accepted,
		Status:              "accepted",
		Source:              "TICKET",
	})
	return &result, nil
}

func (s *OrderService) PlaceBulkOrders(ctx context.Context, req models.BulkOrderRequest) (*models.CanonicalBulkOrderResult, error) {
	start := time.Now()

	if len(req.Orders) == 0 {
		return nil, errors.ErrInvalidSize
	}

	address, err := s.resolveTradingAccount(req.PrivateKey)
	if err != nil {
		return nil, err
	}

	weight := s.rateLimiter.Weight(address, len(req.Orders))
	if !s.rateLimiter.Allow(address, weight) {
		return &models.CanonicalBulkOrderResult{
			Error:     errors.ErrRateLimitExceeded.Error(),
			LatencyMs: time.Since(start).Milliseconds(),
		}, errors.ErrRateLimitExceeded
	}

	ordersWithKey := make([]models.OrderRequest, len(req.Orders))
	for i, o := range req.Orders {
		ordersWithKey[i] = o
		ordersWithKey[i].PrivateKey = req.PrivateKey
		ordersWithKey[i].Mainnet = req.Mainnet
		if err := ensureOrderCloid(&ordersWithKey[i]); err != nil {
			s.rateLimiter.Refund(address, weight)
			return &models.CanonicalBulkOrderResult{
				Error:     err.Error(),
				LatencyMs: time.Since(start).Milliseconds(),
			}, err
		}
	}

	if s.exchange == nil {
		statuses := make([]models.CanonicalOrderResult, len(ordersWithKey))
		for i, o := range ordersWithKey {
			statuses[i] = models.CanonicalOrderResult{Accepted: true, Cloid: o.Cloid}
		}
		return &models.CanonicalBulkOrderResult{
			Statuses:  statuses,
			LatencyMs: time.Since(start).Milliseconds(),
		}, nil
	}

	results, err := s.exchange.PlaceBulkOrders(ctx, ordersWithKey)
	latencyMs := time.Since(start).Milliseconds()
	if err != nil && len(results) == 0 {
		if !isAmbiguousExchangeError(err) {
			s.rateLimiter.Refund(address, weight)
		}
		return &models.CanonicalBulkOrderResult{
			Error:     err.Error(),
			Ambiguous: isAmbiguousExchangeError(err),
			LatencyMs: latencyMs,
		}, err
	}

	statuses := make([]models.CanonicalOrderResult, len(results))
	for i, r := range results {
		statuses[i] = normalizeExchangeBulkStatus(r, latencyMs)
		if i < len(ordersWithKey) {
			statuses[i].Cloid = ordersWithKey[i].Cloid
		}
	}

	s.publishOrderUpdate(address, results)
	s.registerAcceptedOrders(address, ordersWithKey, results)

	errCount := 0
	firstErr := ""
	for _, st := range statuses {
		if !st.Accepted {
			errCount++
			if firstErr == "" {
				firstErr = st.Error
			}
		}
	}
	var topErr string
	if errCount > 0 {
		if firstErr == "" {
			firstErr = "bulk order errors"
		}
		topErr = fmt.Sprintf("%d/%d bulk orders failed: %s", errCount, len(statuses), firstErr)
	}
	if err != nil && topErr == "" {
		topErr = err.Error()
	}

	return &models.CanonicalBulkOrderResult{
		Statuses:  statuses,
		Error:     topErr,
		LatencyMs: latencyMs,
	}, nil
}

func (s *OrderService) registerAcceptedOrders(account string, submitted []models.OrderRequest, results []interface{}) {
	if s.accountRuntime == nil || account == "" || len(submitted) == 0 || len(results) == 0 {
		return
	}

	accepted := make([]interface{}, 0, len(results))
	for idx, result := range results {
		if idx >= len(submitted) {
			break
		}
		oid := extractAcceptedOid(result)
		if oid <= 0 {
			continue
		}
		sz := submitted[idx].Sz
		if submitted[idx].LimitPx > 0 && submitted[idx].Sz > 0 {
			sz = submitted[idx].Sz / submitted[idx].LimitPx
		}
		order := map[string]interface{}{
			"oid":     oid,
			"coin":    submitted[idx].Coin,
			"limitPx": submitted[idx].LimitPx,
			"sz":      sz,
			"side":    map[bool]string{true: "B", false: "A"}[submitted[idx].IsBuy],
		}
		accepted = append(accepted, order)
	}
	if len(accepted) == 0 {
		return
	}
	s.accountRuntime.RegisterAcceptedOrders(account, accepted)
}
