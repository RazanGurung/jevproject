package exchange

import (
	"context"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"

	"hyperliquid-go/internal/accountcache"
	"hyperliquid-go/internal/domain/models"
)

func trimNumericString(value string) string {
	value = strings.TrimRight(value, "0")
	value = strings.TrimRight(value, ".")
	if value == "" || value == "-0" {
		return "0"
	}
	return value
}

func normalizePerpPrice(price float64, szDecimals int) float64 {
	if price <= 0 {
		return price
	}
	maxDecimals := 6 - szDecimals
	if maxDecimals < 0 {
		maxDecimals = 0
	}
	// Hyperliquid's five-significant-figure rule has an explicit exception for
	// integers: 123456 is valid and must not become 123460. Fractional prices
	// still round to the nearest precision allowed by both constraints.
	if price == math.Trunc(price) {
		return price
	}
	sigDecimals := 4 - int(math.Floor(math.Log10(math.Abs(price))))
	if sigDecimals < 0 {
		sigDecimals = 0
	}
	decimals := min(maxDecimals, sigDecimals)
	scale := math.Pow10(decimals)
	return math.Round(price*scale) / scale
}

func formatPerpWirePrice(price float64, szDecimals int) string {
	decimals := 6 - szDecimals
	if decimals < 0 {
		decimals = 0
	}
	return trimNumericString(strconv.FormatFloat(price, 'f', decimals, 64))
}

func formatWireSize(size float64, szDecimals int) string {
	if szDecimals < 0 {
		szDecimals = 0
	}
	return trimNumericString(strconv.FormatFloat(size, 'f', szDecimals, 64))
}

func rejectBelowMinOpenNotional(size, price float64, reduceOnly bool) error {
	if reduceOnly || price <= 0 || size <= 0 {
		return nil
	}
	if size*price+1e-9 < 10.0 {
		return fmt.Errorf("order must have minimum value of $10")
	}
	return nil
}

func isFinitePositive(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func (h *HyperliquidAdapter) validateHip3ExecutionInputs(ctx context.Context, orders []models.OrderRequest, prices, coinSizes []float64, testnet bool) error {
	if len(orders) == 0 {
		return nil
	}
	if len(orders) != len(prices) || len(orders) != len(coinSizes) {
		return fmt.Errorf("xyz execution input mismatch")
	}

	minPx := math.MaxFloat64
	maxPx := 0.0
	allReduceOnly := true
	for i, req := range orders {
		price := prices[i]
		size := coinSizes[i]
		if !isFinitePositive(price) {
			return fmt.Errorf("invalid xyz price for %s", req.Coin)
		}
		if !isFinitePositive(size) {
			return fmt.Errorf("invalid xyz size for %s", req.Coin)
		}
		if price < minPx {
			minPx = price
		}
		if price > maxPx {
			maxPx = price
		}
		if !req.ReduceOnly {
			allReduceOnly = false
		}
	}

	if allReduceOnly {
		return nil
	}

	mid, err := h.getMidPrice(ctx, orders[0].Coin, testnet)
	if err != nil || !isFinitePositive(mid) {
		return nil
	}

	if minPx < mid*0.1 || maxPx > mid*10 {
		return fmt.Errorf(
			"xyz ladder prices for %s look stale or mismatched for the current market (mid=%.4f, min=%.4f, max=%.4f)",
			orders[0].Coin,
			mid,
			minPx,
			maxPx,
		)
	}

	return nil
}

func (h *HyperliquidAdapter) hip3OrderAction(ctx context.Context, req models.OrderRequest, price, coinSize float64, testnet bool) (OrderAction, error) {
	orders, err := h.hip3OrderWires(ctx, []models.OrderRequest{req}, []float64{price}, []float64{coinSize}, testnet)
	if err != nil {
		return OrderAction{}, err
	}
	return OrderAction{Type: "order", Orders: orders, Grouping: groupingNA, Builder: nil}, nil
}

func (h *HyperliquidAdapter) hip3OrderWires(ctx context.Context, reqs []models.OrderRequest, prices, coinSizes []float64, testnet bool) ([]OrderWire, error) {
	apiURL := getAPIURL(testnet)
	if len(reqs) != len(prices) || len(reqs) != len(coinSizes) {
		return nil, fmt.Errorf("hip3 order wire input mismatch")
	}

	assetIdxByCoin := make(map[string]int, len(reqs))
	szDecByCoin := make(map[string]int, len(reqs))
	orders := make([]OrderWire, 0, len(reqs))
	for i, req := range reqs {
		assetIdx, ok := assetIdxByCoin[req.Coin]
		if !ok {
			assetIdx = h.assetIndexForCoin(ctx, apiURL, req.Coin)
			if assetIdx < 0 {
				return nil, fmt.Errorf("could not find asset index for %s", req.Coin)
			}
			assetIdxByCoin[req.Coin] = assetIdx
			szDec, err := h.getSzDecimals(ctx, req.Coin, testnet)
			if err != nil {
				return nil, err
			}
			szDecByCoin[req.Coin] = szDec
		}
		orderType := OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifGtc}}
		if req.LimitPx == 0 {
			orderType = OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifIoc}}
		} else if req.PostOnly || strings.EqualFold(req.Tif, string(TifAlo)) {
			orderType = OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifAlo}}
		}
		cloid, err := resolveOrderCloid(req.Cloid)
		if err != nil {
			return nil, err
		}
		orders = append(orders, OrderWire{
			Asset:      assetIdx,
			IsBuy:      req.IsBuy,
			LimitPx:    formatPerpWirePrice(prices[i], szDecByCoin[req.Coin]),
			Size:       formatWireSize(coinSizes[i], szDecByCoin[req.Coin]),
			ReduceOnly: req.ReduceOnly,
			OrderType:  orderType,
			Cloid:      cloid,
		})
	}
	return orders, nil
}

func (h *HyperliquidAdapter) placeHip3Order(ctx context.Context, req models.OrderRequest, price, coinSize float64, testnet bool) (interface{}, error) {
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	if err := h.validateHip3ExecutionInputs(ctx, []models.OrderRequest{req}, []float64{price}, []float64{coinSize}, testnet); err != nil {
		return nil, err
	}

	action, err := h.hip3OrderAction(ctx, req, price, coinSize, testnet)
	if err != nil {
		return nil, err
	}
	resp, err := h.executeSignedExchangeAction(ctx, req.PrivateKey, testnet, action)
	if err != nil {
		log.Printf("placeHip3Order: executeSignedExchangeAction failed: %v", err)
		return nil, err
	}
	if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		log.Printf("placeHip3Order: exchange status error coin=%s err=%s", req.Coin, statusErr)
		return nil, fmt.Errorf("HIP-3 order failed: %s", statusErr)
	}
	log.Printf("placeHip3Order: success coin=%s response=%s", req.Coin, summarizeExchangeResult(resp))
	return resp, nil
}

func (h *HyperliquidAdapter) hip3BulkOrderAction(ctx context.Context, reqs []models.OrderRequest, prices, coinSizes []float64, testnet bool) (OrderAction, error) {
	orders, err := h.hip3OrderWires(ctx, reqs, prices, coinSizes, testnet)
	if err != nil {
		return OrderAction{}, err
	}
	return OrderAction{Type: "order", Orders: orders, Grouping: groupingNA, Builder: nil}, nil
}

func (h *HyperliquidAdapter) placeHip3BulkOrders(ctx context.Context, orders []models.OrderRequest, prices, coinSizes []float64, testnet bool) ([]interface{}, error) {
	log.Printf("placeHip3BulkOrders: starting for %d orders, first coin=%s", len(orders), orders[0].Coin)
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	if err := h.validateHip3ExecutionInputs(ctx, orders, prices, coinSizes, testnet); err != nil {
		return nil, err
	}

	action, err := h.hip3BulkOrderAction(ctx, orders, prices, coinSizes, testnet)
	if err != nil {
		return nil, fmt.Errorf("failed to build HIP-3 bulk order action: %w", err)
	}

	resp, err := h.executeSignedExchangeAction(ctx, orders[0].PrivateKey, testnet, action)
	if err != nil {
		log.Printf("placeHip3BulkOrders: executeSignedExchangeAction failed: %v", err)
		return nil, err
	}
	// Whole-action rejection fails the batch. Per-status errors must flow
	// through as result entries so mixed HIP-3 ladders match standard bulk.
	if topErr := extractTopLevelExchangeError(resp); topErr != "" {
		log.Printf("placeHip3BulkOrders: exchange status error coin=%s err=%s", orders[0].Coin, topErr)
		return nil, fmt.Errorf("HIP-3 bulk order failed: %s", topErr)
	}

	log.Printf("placeHip3BulkOrders: success response=%s", summarizeExchangeResult(resp))
	if statuses, ok := extractExchangeStatuses(resp); ok && len(statuses) > 0 {
		return statuses, nil
	}
	return nil, fmt.Errorf("HIP-3 bulk order returned no per-order statuses")
}

func extractExchangeStatuses(response map[string]interface{}) ([]interface{}, bool) {
	if response == nil {
		return nil, false
	}
	if resp, ok := response["response"].(map[string]interface{}); ok {
		if data, ok := resp["data"].(map[string]interface{}); ok {
			if statuses, ok := data["statuses"].([]interface{}); ok {
				return statuses, true
			}
		}
	}
	data, ok := response["data"].(map[string]interface{})
	if !ok {
		return nil, false
	}
	statuses, ok := data["statuses"].([]interface{})
	if !ok {
		return nil, false
	}
	return statuses, true
}

func (h *HyperliquidAdapter) closeHip3Position(ctx context.Context, privateKey, address, coin string, fraction, positionSize, positionSzi float64, testnet bool) (models.ClosePositionResult, error) {
	if fraction <= 0 {
		fraction = 1
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	apiURL := getAPIURL(testnet)

	// Resolve address if not provided.
	if address == "" {
		address = accountcache.GetWithFallback()
	}
	if address == "" {
		var err error
		address, err = h.GetAddressFromPrivateKey(ctx, privateKey)
		if err != nil {
			return models.ClosePositionResult{}, err
		}
	}

	dex := resolveMarketVenue(coin).Dex
	coinKey := stripDexPrefix(coin)
	szi := positionSzi
	if szi == 0 {
		// Compatibility path for callers that do not send signed position size.
		var xyzState map[string]interface{}
		if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{
			"type": "clearinghouseState", "user": address, "dex": dex,
		}, &xyzState); err != nil {
			return models.ClosePositionResult{}, fmt.Errorf("failed to fetch xyz state for close: %w", err)
		}
		if assetPositions, ok := xyzState["assetPositions"].([]interface{}); ok {
			for _, ap := range assetPositions {
				apMap, _ := ap.(map[string]interface{})
				posMap, _ := apMap["position"].(map[string]interface{})
				posCoin, _ := posMap["coin"].(string)
				if stripDexPrefix(posCoin) == coinKey {
					szi = parseFloatStr(posMap["szi"])
					break
				}
			}
		}
	}
	if szi == 0 {
		return models.ClosePositionResult{}, fmt.Errorf("position not found for %s", coin)
	}

	isBuy := szi < 0
	szDec, err := h.getSzDecimals(ctx, coin, testnet)
	if err != nil {
		return models.ClosePositionResult{}, err
	}
	size := closeOrderSize(szi, positionSize, fraction, szDec)
	if size <= 0 {
		return models.ClosePositionResult{}, fmt.Errorf("partial close is below %s size precision; use Close", coin)
	}

	// The market stream primes execution mids every second. Use it before the
	// bounded builder REST fallback so Close remains available when /info is
	// saturated by account refreshes.
	mid, err := h.getMidPrice(ctx, coin, testnet)
	if err != nil || mid <= 0 {
		return models.ClosePositionResult{}, fmt.Errorf("could not get mid price for %s", coin)
	}
	var limitPx float64
	if isBuy {
		limitPx = mid * (1 + marketOrderSlippage)
	} else {
		limitPx = mid * (1 - marketOrderSlippage)
	}
	limitPx = normalizePerpPrice(limitPx, szDec)

	// Resolve asset index for the close order.
	assetIdx := h.assetIndexForCoin(ctx, apiURL, coin)
	if assetIdx < 0 {
		return models.ClosePositionResult{}, fmt.Errorf("could not find asset index for %s", coin)
	}

	cloid, err := resolveOrderCloid("")
	if err != nil {
		return models.ClosePositionResult{}, err
	}
	action := OrderAction{
		Type: "order",
		Orders: []OrderWire{{
			Asset:      assetIdx,
			IsBuy:      isBuy,
			LimitPx:    formatPerpWirePrice(limitPx, szDec),
			Size:       formatWireSize(size, szDec),
			ReduceOnly: true,
			OrderType:  OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifIoc}},
			Cloid:      cloid,
		}},
		Grouping: groupingNA,
	}

	resp, err := h.executeSignedExchangeAction(ctx, privateKey, testnet, action)
	if err != nil {
		return models.ClosePositionResult{}, err
	}
	if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		return models.ClosePositionResult{}, fmt.Errorf("%s", statusErr)
	}
	log.Printf("closeHip3Position: success coin=%s szi=%v isBuy=%v size=%v", coin, szi, isBuy, size)
	return closePositionResultFromResponse(size, cloid, resp), nil
}
