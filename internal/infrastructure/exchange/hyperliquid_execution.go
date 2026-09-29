package exchange

import (
	"context"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"hyperliquid-go/internal/domain/models"
)

// marketOrderSlippage bounds how far past the reference price an IOC market
// order may fill, mirroring the SDK's MarketOpen/MarketClose default.
const marketOrderSlippage = 0.01

// closeOrderSize floors fractional closes to the venue's size precision.
// Multiplying an exchange-valid position (for example 0.00017 BTC) by 25%
// can create an invalid extra decimal (0.0000425). Flooring never closes more
// than requested; full closes always use the authoritative signed position.
func closeOrderSize(positionSzi, requestedSize, fraction float64, szDecimals int) float64 {
	base := math.Abs(positionSzi)
	if fraction <= 0 || fraction > 1 {
		fraction = 1
	}
	if fraction < 1 && requestedSize > 0 {
		base = math.Min(base, math.Abs(requestedSize))
	}
	scale := math.Pow10(max(szDecimals, 0))
	return math.Floor((base*fraction)*scale+1e-9) / scale
}

// stdOrderWire builds a standard-venue wire order. Callers normalize perp
// prices and sizes from verified metadata before using the canonical wire
// formatter.
func stdOrderWire(asset int, isBuy bool, price, size float64, reduceOnly bool, orderType OrderWireType) (OrderWire, error) {
	priceWire, err := floatToWire(price)
	if err != nil {
		return OrderWire{}, fmt.Errorf("failed to wire price: %w", err)
	}
	sizeWire, err := floatToWire(size)
	if err != nil {
		return OrderWire{}, fmt.Errorf("failed to wire size: %w", err)
	}
	return OrderWire{
		Asset:      asset,
		IsBuy:      isBuy,
		LimitPx:    priceWire,
		Size:       sizeWire,
		ReduceOnly: reduceOnly,
		OrderType:  orderType,
	}, nil
}

// extractTopLevelExchangeError reports a whole-action rejection (flat error or
// status=="err") without treating per-status errors as fatal — bulk callers
// surface those per entry.
func extractTopLevelExchangeError(response map[string]interface{}) string {
	if response == nil {
		return ""
	}
	if errText, ok := response["error"].(string); ok && strings.TrimSpace(errText) != "" {
		return strings.TrimSpace(errText)
	}
	if status, ok := response["status"].(string); ok && status == "err" {
		if respStr, ok := response["response"].(string); ok && strings.TrimSpace(respStr) != "" {
			return strings.TrimSpace(respStr)
		}
		return "exchange rejected action"
	}
	return ""
}

// requireCancelStatuses nacks a cancel whose venue payload is missing or
// shorter than the requested count. A data-less ok envelope is not success.
func requireCancelStatuses(response map[string]interface{}, n int) error {
	oids := make([]int64, n)
	for i := range oids {
		oids[i] = int64(i + 1)
	}
	_, err := confirmedCancelOids(response, oids)
	return err
}

func confirmedCancelOids(response map[string]interface{}, requested []int64) ([]int64, error) {
	if topErr := extractTopLevelExchangeError(response); topErr != "" {
		return nil, fmt.Errorf("%s", topErr)
	}
	statuses, ok := extractExchangeStatuses(response)
	if !ok {
		return nil, fmt.Errorf("cancel response missing statuses")
	}
	confirmed := make([]int64, 0, len(requested))
	var failures []string
	for i, oid := range requested {
		if i >= len(statuses) {
			failures = append(failures, fmt.Sprintf("oid %d missing status", oid))
			continue
		}
		switch status := statuses[i].(type) {
		case string:
			if strings.EqualFold(strings.TrimSpace(status), "success") {
				confirmed = append(confirmed, oid)
			} else {
				failures = append(failures, fmt.Sprintf("oid %d: %s", oid, status))
			}
		case map[string]interface{}:
			if errText, _ := status["error"].(string); strings.TrimSpace(errText) != "" {
				failures = append(failures, fmt.Sprintf("oid %d: %s", oid, strings.TrimSpace(errText)))
			} else {
				confirmed = append(confirmed, oid)
			}
		default:
			failures = append(failures, fmt.Sprintf("oid %d unrecognized status", oid))
		}
	}
	if len(failures) > 0 {
		return confirmed, fmt.Errorf("%s", strings.Join(failures, "; "))
	}
	return confirmed, nil
}

func (h *HyperliquidAdapter) PlaceOrder(ctx context.Context, req models.OrderRequest) (interface{}, error) {
	testnet := req.Testnet
	if req.Mainnet {
		testnet = false
	}

	price := req.LimitPx
	var err error
	if price == 0 {
		price, err = h.getMidPrice(ctx, req.Coin, testnet)
		if err != nil || price == 0 {
			return nil, fmt.Errorf("no price available for %s", req.Coin)
		}
	}
	priceForSizing := price
	venue := resolveMarketVenue(req.Coin)
	if venue.isBuilderPerp() && req.LimitPx == 0 {
		price = h.aggressiveMarketPrice(req.IsBuy, price)
	}
	szDecimals, err := h.getSzDecimals(ctx, req.Coin, testnet)
	if err != nil {
		return nil, err
	}
	price = normalizePerpPrice(price, szDecimals)
	coinSize := roundOrderNotionalToCoinSize(req.Sz, priceForSizing, szDecimals, !req.ReduceOnly)
	if err := rejectBelowMinOpenNotional(coinSize, priceForSizing, req.ReduceOnly); err != nil {
		return nil, err
	}
	orderType := "limit"
	if req.LimitPx == 0 {
		orderType = "market"
	}
	log.Printf("PlaceOrder: coin=%s type=%s reqUsd=%.4f refPx=%.4f coinSize=%.8f szDecimals=%d reduceOnly=%t",
		req.Coin, orderType, req.Sz, priceForSizing, coinSize, szDecimals, req.ReduceOnly)

	if venue.isBuilderPerp() {
		return h.placeHip3Order(ctx, req, price, coinSize, testnet)
	}

	apiURL := getAPIURL(testnet)
	asset := h.assetIndexForCoin(ctx, apiURL, req.Coin)
	if asset < 0 {
		return nil, fmt.Errorf("could not find asset index for %s", req.Coin)
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()

	var wire OrderWire
	var expiresAfter *int64
	if req.LimitPx == 0 {
		// Market order: IOC limit at a slippage-bounded price. reduceOnly is an
		// independent Hyperliquid wire flag and must be preserved for market
		// closes just as it is for GTC, bulk, and builder-perp orders.
		slippagePx := slippagePrice(priceForSizing, req.IsBuy, marketOrderSlippage, szDecimals)
		wire, err = stdOrderWire(asset, req.IsBuy, slippagePx, coinSize, req.ReduceOnly,
			OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifIoc}})
	} else {
		tif := TifGtc
		if req.PostOnly || strings.EqualFold(req.Tif, string(TifAlo)) {
			tif = TifAlo
		}
		wire, err = stdOrderWire(asset, req.IsBuy, price, coinSize, req.ReduceOnly,
			OrderWireType{Limit: &OrderWireTypeLimit{Tif: tif}})
		if req.ExpiresAfter > 0 {
			expiresAfter = &req.ExpiresAfter
		}
	}
	if err != nil {
		return nil, err
	}
	wire.Cloid, err = resolveOrderCloid(req.Cloid)
	if err != nil {
		return nil, err
	}

	action := OrderAction{Type: "order", Orders: []OrderWire{wire}, Grouping: groupingNA}
	result, err := h.executeSignedExchangeActionExpiring(ctx, req.PrivateKey, testnet, action, expiresAfter)
	if err != nil {
		return nil, err
	}
	if statusErr := extractExchangeStatusError(result); statusErr != "" {
		return nil, fmt.Errorf("%s", statusErr)
	}
	log.Printf("PlaceOrder: success coin=%s type=%s response=%s", req.Coin, orderType, summarizeExchangeResult(result))
	return result, nil
}

func (h *HyperliquidAdapter) aggressiveMarketPrice(isBuy bool, mid float64) float64 {
	if mid <= 0 {
		return mid
	}
	if isBuy {
		return mid * (1 + marketOrderSlippage)
	}
	return mid * (1 - marketOrderSlippage)
}

func (h *HyperliquidAdapter) PlaceBulkOrders(ctx context.Context, orders []models.OrderRequest) ([]interface{}, error) {
	if len(orders) == 0 {
		return nil, nil
	}
	testnet := orders[0].Testnet
	if orders[0].Mainnet {
		testnet = false
	}
	apiURL := getAPIURL(testnet)

	stdWires := make([]OrderWire, 0, len(orders))
	szDecimalsByCoin := make(map[string]int, len(orders))
	assetIdxByCoin := make(map[string]int, len(orders))
	marketPriceByCoin := make(map[string]float64, len(orders))
	hip3Prices := make([]float64, 0, len(orders))
	hip3CoinSizes := make([]float64, 0, len(orders))
	totalRequestedUsd := 0.0
	hasHip3 := false
	hasNonHip3 := false
	for _, req := range orders {
		venue := resolveMarketVenue(req.Coin)
		totalRequestedUsd += req.Sz
		price := req.LimitPx
		if price == 0 {
			cachedPrice, ok := marketPriceByCoin[req.Coin]
			if !ok {
				var err error
				cachedPrice, err = h.getMidPrice(ctx, req.Coin, testnet)
				if err != nil || cachedPrice == 0 {
					return nil, fmt.Errorf("no price available for %s", req.Coin)
				}
				marketPriceByCoin[req.Coin] = cachedPrice
			}
			price = cachedPrice
		}
		priceForSizing := price
		szDecimals, ok := szDecimalsByCoin[req.Coin]
		if !ok {
			var err error
			szDecimals, err = h.getSzDecimals(ctx, req.Coin, testnet)
			if err != nil {
				return nil, err
			}
			szDecimalsByCoin[req.Coin] = szDecimals
		}
		coinSize := roundOrderNotionalToCoinSize(req.Sz, priceForSizing, szDecimals, !req.ReduceOnly)
		if venue.isBuilderPerp() {
			if req.LimitPx == 0 {
				price = h.aggressiveMarketPrice(req.IsBuy, price)
			}
			price = normalizePerpPrice(price, szDecimals)
			if err := rejectBelowMinOpenNotional(coinSize, priceForSizing, req.ReduceOnly); err != nil {
				return nil, err
			}
			hasHip3 = true
			hip3Prices = append(hip3Prices, price)
			hip3CoinSizes = append(hip3CoinSizes, coinSize)
			continue
		}
		if req.LimitPx == 0 {
			price = slippagePrice(price, req.IsBuy, marketOrderSlippage, szDecimals)
		}
		if err := rejectBelowMinOpenNotional(coinSize, price, req.ReduceOnly); err != nil {
			return nil, err
		}
		hasNonHip3 = true
		price = normalizePerpPrice(price, szDecimals)
		assetIdx, ok := assetIdxByCoin[req.Coin]
		if !ok {
			assetIdx = h.assetIndexForCoin(ctx, apiURL, req.Coin)
			if assetIdx < 0 {
				return nil, fmt.Errorf("could not find asset index for %s", req.Coin)
			}
			assetIdxByCoin[req.Coin] = assetIdx
		}
		tif := TifGtc
		if req.LimitPx == 0 {
			tif = TifIoc
		} else if req.PostOnly || strings.EqualFold(req.Tif, string(TifAlo)) {
			tif = TifAlo
		}
		wire, err := stdOrderWire(assetIdx, req.IsBuy, price, coinSize, req.ReduceOnly,
			OrderWireType{Limit: &OrderWireTypeLimit{Tif: tif}})
		if err != nil {
			return nil, err
		}
		wire.Cloid, err = resolveOrderCloid(req.Cloid)
		if err != nil {
			return nil, err
		}
		stdWires = append(stdWires, wire)
	}
	log.Printf("PlaceBulkOrders: coin=%s count=%d totalReqUsd=%.4f uniqueCoins=%d", orders[0].Coin, len(orders), totalRequestedUsd, len(szDecimalsByCoin))
	if hasHip3 {
		if hasNonHip3 {
			return nil, fmt.Errorf("mixed bulk orders across HIP-3 and standard assets are not supported")
		}
		return h.placeHip3BulkOrders(ctx, orders, hip3Prices, hip3CoinSizes, testnet)
	}

	action := OrderAction{Type: "order", Orders: stdWires, Grouping: groupingNA}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	resp, err := h.executeSignedExchangeAction(ctx, orders[0].PrivateKey, testnet, action)
	if err != nil {
		return nil, err
	}
	// Whole-action rejection fails the batch; per-status errors flow through
	// as result entries so callers keep mixed-result reporting.
	if topErr := extractTopLevelExchangeError(resp); topErr != "" {
		return nil, fmt.Errorf("%s", topErr)
	}
	statuses, ok := extractExchangeStatuses(resp)
	if !ok {
		return nil, fmt.Errorf("empty bulk order response")
	}
	return statuses, nil
}

func (h *HyperliquidAdapter) CancelOrder(ctx context.Context, address, coin string, oid int64, testnet bool) error {
	apiURL := getAPIURL(testnet)
	assetIdx := h.assetIndexForCoin(ctx, apiURL, coin)
	if assetIdx < 0 {
		return fmt.Errorf("could not find asset index for %s cancel", coin)
	}
	action := CancelAction{
		Type:    "cancel",
		Cancels: []CancelOrderWire{{Asset: assetIdx, OrderID: oid}},
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	resp, err := h.executeSignedExchangeAction(ctx, address, testnet, action)
	if err != nil {
		return err
	}
	if err := requireCancelStatuses(resp, 1); err != nil {
		return err
	}
	return nil
}

// BulkCancelOrders returns the oids that were actually cancelled. Each venue
// batch is a single all-or-nothing exchange action, so a failure in one venue
// must not be reported as success for its oids.
func (h *HyperliquidAdapter) BulkCancelOrders(ctx context.Context, address string, cancels []models.CancelEntry, testnet bool) ([]int64, error) {
	cancelled := make([]int64, 0, len(cancels))
	if len(cancels) == 0 {
		return cancelled, nil
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()

	var stdCancels []CancelOrderWire
	var stdOids []int64
	var xyzCancels []CancelOrderWire
	var xyzOids []int64
	apiURL := getAPIURL(testnet)

	for _, c := range cancels {
		if c.Oid <= 0 {
			continue
		}
		assetIdx := h.assetIndexForCoin(ctx, apiURL, c.Coin)
		if assetIdx < 0 {
			continue
		}
		if resolveMarketVenue(c.Coin).isBuilderPerp() {
			xyzCancels = append(xyzCancels, CancelOrderWire{Asset: assetIdx, OrderID: c.Oid})
			xyzOids = append(xyzOids, c.Oid)
		} else {
			stdCancels = append(stdCancels, CancelOrderWire{Asset: assetIdx, OrderID: c.Oid})
			stdOids = append(stdOids, c.Oid)
		}
	}

	if len(xyzCancels) > 0 {
		action := CancelAction{
			Type:    "cancel",
			Cancels: xyzCancels,
		}
		resp, err := h.executeSignedExchangeAction(ctx, address, testnet, action)
		if err != nil {
			return cancelled, err
		}
		confirmed, statusErr := confirmedCancelOids(resp, xyzOids)
		cancelled = append(cancelled, confirmed...)
		if statusErr != nil {
			return cancelled, fmt.Errorf("HIP-3 bulk cancel partial failure: %w", statusErr)
		}
	}

	if len(stdCancels) > 0 {
		action := CancelAction{
			Type:    "cancel",
			Cancels: stdCancels,
		}
		resp, err := h.executeSignedExchangeAction(ctx, address, testnet, action)
		if err != nil {
			return cancelled, err
		}
		confirmed, statusErr := confirmedCancelOids(resp, stdOids)
		cancelled = append(cancelled, confirmed...)
		if statusErr != nil {
			return cancelled, fmt.Errorf("bulk cancel partial failure: %w", statusErr)
		}
	}

	return cancelled, nil
}

func (h *HyperliquidAdapter) CancelByCloid(ctx context.Context, address, coin, cloid string, testnet bool) error {
	apiURL := getAPIURL(testnet)
	assetIdx := h.assetIndexForCoin(ctx, apiURL, coin)
	if assetIdx < 0 {
		return fmt.Errorf("could not find asset index for %s cancel", coin)
	}
	normalized, err := normalizeCloid(cloid)
	if err != nil {
		return err
	}
	action := CancelByCloidAction{
		Type:    "cancelByCloid",
		Cancels: []CancelByCloidWire{{Asset: assetIdx, ClientID: normalized}},
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	resp, err := h.executeSignedExchangeAction(ctx, address, testnet, action)
	if err != nil {
		return err
	}
	if err := requireCancelStatuses(resp, 1); err != nil {
		return err
	}
	return nil
}

// isTriggerModify reports whether a modify request re-wires the order as a
// TP/SL trigger rather than a plain GTC limit.
func isTriggerModify(tpsl string) bool {
	return tpsl == "tp" || tpsl == "sl"
}

// validateModifyNotional protects the exchange's cancel+replace modify path.
// Hyperliquid can cancel the old order before rejecting a replacement below
// its $10 opening-order minimum, turning an innocent chart drag into a silent
// cancellation. Reject those requests locally; reduce-only/TP-SL orders are
// allowed below the opening minimum because they only decrease exposure.
func validateModifyNotional(size, price float64, reduceOnly bool, trigger bool) error {
	if reduceOnly || trigger {
		return nil
	}
	const minOpenNotionalUSD = 10.0
	if size <= 0 || price <= 0 {
		return fmt.Errorf("modify size and price must be positive")
	}
	if size*price+1e-9 < minOpenNotionalUSD {
		return fmt.Errorf("modify would place a $%.4f order below the $%.2f exchange minimum; increase size or price", size*price, minOpenNotionalUSD)
	}
	return nil
}

// modifyOrderWireTypeFromPx builds the wire order type for a modify from an
// already-formatted price string: trigger when tpsl is "tp"/"sl", GTC limit
// otherwise.
func modifyOrderWireTypeFromPx(tpsl string, isMarket bool, triggerPxWire string) OrderWireType {
	if !isTriggerModify(tpsl) {
		return OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifGtc}}
	}
	kind := TakeProfit
	if tpsl == "sl" {
		kind = StopLoss
	}
	return OrderWireType{Trigger: &OrderWireTypeTrigger{
		IsMarket:  isMarket,
		TriggerPx: triggerPxWire,
		Tpsl:      kind,
	}}
}

// newOidFromRawStatuses extracts the replacement oid Hyperliquid assigns to a
// modified order. Modify is cancel+replace on-exchange, so the resting order
// always comes back under a new oid; callers need it to reconcile state.
func newOidFromRawStatuses(resp map[string]interface{}, idx int) int64 {
	statuses, ok := extractExchangeStatuses(resp)
	if !ok || idx < 0 || idx >= len(statuses) {
		return 0
	}
	entry, _ := statuses[idx].(map[string]interface{})
	for _, key := range []string{"resting", "filled"} {
		nested, ok := entry[key].(map[string]interface{})
		if !ok {
			continue
		}
		switch oid := nested["oid"].(type) {
		case float64:
			if oid > 0 {
				return int64(oid)
			}
		case int64:
			if oid > 0 {
				return oid
			}
		}
	}
	return 0
}

func (h *HyperliquidAdapter) ModifyOrder(ctx context.Context, req models.ModifyOrderRequest) (int64, error) {
	testnet := req.Testnet && !req.Mainnet
	apiURL := getAPIURL(testnet)
	assetIdx := h.assetIndexForCoin(ctx, apiURL, req.Coin)
	if assetIdx < 0 {
		return 0, fmt.Errorf("could not find asset index for %s modify", req.Coin)
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	isTrigger := isTriggerModify(req.Tpsl)
	szDec, err := h.getSzDecimals(ctx, req.Coin, testnet)
	if err != nil {
		return 0, err
	}
	execPx := modifyOrderExecPx(isTrigger, req.IsMarket, req.IsBuy, req.LimitPx, req.TriggerPx, szDec)
	price := normalizePerpPrice(execPx, szDec)
	if err := validateModifyNotional(req.Sz, price, req.ReduceOnly, isTrigger); err != nil {
		return 0, err
	}
	priceWire, orderType := modifyOrderTypeWires(isTrigger, req.IsMarket, req.Tpsl, execPx, req.TriggerPx, szDec)
	sizeWire := formatWireSize(req.Sz, szDec)
	// Single-entry batchModify: the exchange answers a lone "modify" action
	// with a data-less default response, while "batchModify" responses carry
	// the per-order statuses the re-key flow needs. Encoded asset IDs already
	// distinguish xyz HIP-3 from standard perps (do not send Dex).
	action := BatchModifyAction{
		Type: "batchModify",
		Modifies: []ModifyAction{{
			Oid: req.Oid,
			Order: OrderWire{
				Asset:   assetIdx,
				IsBuy:   req.IsBuy,
				LimitPx: priceWire,
				Size:    sizeWire,
				// Trigger modifies are always reduce-only protection, matching PlaceTriggerOrder.
				ReduceOnly: req.ReduceOnly || isTrigger,
				OrderType:  orderType,
			},
		}},
	}
	resp, err := h.executeSignedExchangeAction(ctx, req.PrivateKey, testnet, action)
	if err != nil {
		return 0, err
	}
	if topErr := extractTopLevelExchangeError(resp); topErr != "" {
		return 0, fmt.Errorf("modify failed: %s", topErr)
	}
	if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		return 0, fmt.Errorf("modify failed: %s", statusErr)
	}
	return newOidFromRawStatuses(resp, 0), nil
}

// BulkModifyOrders returns the replacement oids assigned by the exchange,
// aligned with the input modifies (0 when unknown or the batch failed).
func (h *HyperliquidAdapter) BulkModifyOrders(ctx context.Context, privateKey string, modifies []models.ModifyOrderRequestItem, mainnet bool) ([]int64, error) {
	newOids := make([]int64, len(modifies))
	if len(modifies) == 0 {
		return newOids, nil
	}
	testnet := !mainnet
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()

	// Separate HIP-3 and standard perp modifies, remembering each item's
	// original index so the per-batch statuses map back to the caller's order.
	var hip3Modifies []ModifyAction
	var hip3Idx []int
	var stdModifies []ModifyAction
	var stdIdx []int
	apiURL := getAPIURL(testnet)

	for i, mod := range modifies {
		isTrigger := isTriggerModify(mod.Tpsl)
		assetIdx := h.assetIndexForCoin(ctx, apiURL, mod.Coin)
		if assetIdx < 0 {
			return newOids, fmt.Errorf("could not find asset index for %s modify", mod.Coin)
		}
		szDec, err := h.getSzDecimals(ctx, mod.Coin, testnet)
		if err != nil {
			return newOids, err
		}
		execPx := modifyOrderExecPx(isTrigger, mod.IsMarket, mod.IsBuy, mod.LimitPx, mod.TriggerPx, szDec)
		price := normalizePerpPrice(execPx, szDec)
		if err := validateModifyNotional(mod.Sz, price, mod.ReduceOnly, isTrigger); err != nil {
			return newOids, fmt.Errorf("%s: %w", mod.Coin, err)
		}
		priceWire, orderType := modifyOrderTypeWires(isTrigger, mod.IsMarket, mod.Tpsl, execPx, mod.TriggerPx, szDec)
		action := ModifyAction{
			Oid: mod.Oid,
			Order: OrderWire{
				Asset:      assetIdx,
				IsBuy:      mod.IsBuy,
				LimitPx:    priceWire,
				Size:       formatWireSize(mod.Sz, szDec),
				ReduceOnly: mod.ReduceOnly || isTrigger,
				OrderType:  orderType,
			},
		}
		if resolveMarketVenue(mod.Coin).isBuilderPerp() {
			hip3Modifies = append(hip3Modifies, action)
			hip3Idx = append(hip3Idx, i)
		} else {
			stdModifies = append(stdModifies, action)
			stdIdx = append(stdIdx, i)
		}
	}

	if err := h.postBatchModify(ctx, privateKey, testnet, hip3Modifies, hip3Idx, newOids); err != nil {
		return newOids, err
	}
	if err := h.postBatchModify(ctx, privateKey, testnet, stdModifies, stdIdx, newOids); err != nil {
		return newOids, err
	}

	missing := 0
	for _, oid := range newOids {
		if oid <= 0 {
			missing++
		}
	}
	if missing > 0 {
		return newOids, fmt.Errorf("%d/%d modifications were not confirmed by the exchange", missing, len(newOids))
	}
	return newOids, nil
}

func (h *HyperliquidAdapter) postBatchModify(ctx context.Context, privateKey string, testnet bool, modifies []ModifyAction, idxs []int, newOids []int64) error {
	if len(modifies) == 0 {
		return nil
	}
	action := BatchModifyAction{
		Type:     "batchModify",
		Modifies: modifies,
	}
	resp, err := h.executeSignedExchangeAction(ctx, privateKey, testnet, action)
	if err != nil {
		return err
	}
	if topErr := extractTopLevelExchangeError(resp); topErr != "" {
		return fmt.Errorf("%s", topErr)
	}
	for batchPos, origIdx := range idxs {
		newOids[origIdx] = newOidFromRawStatuses(resp, batchPos)
	}
	return nil
}

func triggerExecPrice(isMarket, isBuy bool, triggerPx float64, szDecimals int) float64 {
	if !isMarket {
		return triggerPx
	}
	// Official market IOC uses mid×(1±slippage). isMarket triggers still carry
	// a limit p; using the trigger itself as p can rest through a gap.
	return slippagePrice(triggerPx, isBuy, marketOrderSlippage, szDecimals)
}

func modifyOrderExecPx(isTrigger, isMarket, isBuy bool, limitPx, triggerPx float64, szDecimals int) float64 {
	if isTrigger {
		return triggerExecPrice(isMarket, isBuy, triggerPx, szDecimals)
	}
	return limitPx
}

func modifyOrderTypeWires(isTrigger, isMarket bool, tpsl string, execPx, triggerPx float64, szDecimals int) (string, OrderWireType) {
	priceWire := formatPerpWirePrice(normalizePerpPrice(execPx, szDecimals), szDecimals)
	if !isTrigger {
		return priceWire, modifyOrderWireTypeFromPx(tpsl, isMarket, priceWire)
	}
	triggerWire := formatPerpWirePrice(normalizePerpPrice(triggerPx, szDecimals), szDecimals)
	return priceWire, modifyOrderWireTypeFromPx(tpsl, isMarket, triggerWire)
}

func (h *HyperliquidAdapter) triggerOrderWire(ctx context.Context, req models.TriggerOrderRequest, triggerPx, coinSize float64, testnet bool) (OrderWire, error) {
	apiURL := getAPIURL(testnet)
	assetIdx := h.assetIndexForCoin(ctx, apiURL, req.Coin)
	if assetIdx < 0 {
		return OrderWire{}, fmt.Errorf("could not find asset index for %s", req.Coin)
	}
	szDecimals, err := h.getSzDecimals(ctx, req.Coin, testnet)
	if err != nil {
		return OrderWire{}, err
	}
	tpsl := TakeProfit
	if req.Tpsl == "sl" {
		tpsl = StopLoss
	}
	execPx := triggerExecPrice(req.IsMarket, req.IsBuy, triggerPx, szDecimals)
	cloid, err := resolveOrderCloid(req.Cloid)
	if err != nil {
		return OrderWire{}, err
	}
	return OrderWire{
		Asset:      assetIdx,
		IsBuy:      req.IsBuy,
		LimitPx:    formatPerpWirePrice(execPx, szDecimals),
		Size:       formatWireSize(coinSize, szDecimals),
		ReduceOnly: true,
		OrderType: OrderWireType{Trigger: &OrderWireTypeTrigger{
			IsMarket:  req.IsMarket,
			TriggerPx: formatPerpWirePrice(triggerPx, szDecimals),
			Tpsl:      tpsl,
		}},
		Cloid: cloid,
	}, nil
}

func (h *HyperliquidAdapter) PlaceTriggerOrder(ctx context.Context, req models.TriggerOrderRequest) error {
	errs := h.PlaceTriggerOrders(ctx, []models.TriggerOrderRequest{req})
	if len(errs) > 0 {
		return errs[0]
	}
	return nil
}

func (h *HyperliquidAdapter) PlaceTriggerOrders(ctx context.Context, reqs []models.TriggerOrderRequest) []error {
	if len(reqs) == 0 {
		return nil
	}
	failAll := func(err error) []error {
		out := make([]error, len(reqs))
		for i := range out {
			out[i] = err
		}
		return out
	}
	testnet := reqs[0].Testnet && !reqs[0].Mainnet
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	wires := make([]OrderWire, 0, len(reqs))
	for _, req := range reqs {
		log.Printf("PlaceTriggerOrder: coin=%s tpsl=%s triggerPx=%.6f notionalUsd=%.4f isBuy=%t isMarket=%t",
			req.Coin, req.Tpsl, req.TriggerPx, req.Sz, req.IsBuy, req.IsMarket)
		szDecimals, err := h.getSzDecimals(ctx, req.Coin, testnet)
		if err != nil {
			return failAll(err)
		}
		triggerPx := normalizePerpPrice(req.TriggerPx, szDecimals)
		coinSize := req.SzCoin
		if coinSize <= 0 {
			coinSize = roundNotionalToCoinSize(req.Sz, triggerPx, szDecimals)
		}
		wire, err := h.triggerOrderWire(ctx, req, triggerPx, coinSize, testnet)
		if err != nil {
			return failAll(err)
		}
		wires = append(wires, wire)
	}
	grouping := groupingNA
	if len(wires) > 1 {
		// Official sibling cancel requires one action with positionTpsl.
		grouping = groupingPositionTpsl
	}
	action := OrderAction{Type: "order", Orders: wires, Grouping: grouping}
	resp, err := h.executeSignedExchangeAction(ctx, reqs[0].PrivateKey, testnet, action)
	if err != nil {
		return failAll(err)
	}
	if topErr := extractTopLevelExchangeError(resp); topErr != "" {
		return failAll(fmt.Errorf("%s", topErr))
	}
	out := make([]error, len(reqs))
	if statuses, ok := extractExchangeStatuses(resp); ok {
		for i := range out {
			if i >= len(statuses) {
				out[i] = fmt.Errorf("missing trigger status")
				continue
			}
			if errText := statusEntryError(statuses[i]); errText != "" {
				out[i] = fmt.Errorf("%s", errText)
			}
		}
	} else if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		return failAll(fmt.Errorf("%s", statusErr))
	} else {
		return failAll(fmt.Errorf("trigger response missing statuses"))
	}
	log.Printf("PlaceTriggerOrders: count=%d grouping=%s firstOid=%d", len(wires), grouping, newOidFromRawStatuses(resp, 0))
	return out
}

func (h *HyperliquidAdapter) PlaceTwapOrder(ctx context.Context, req models.TwapOrderRequest) (interface{}, error) {
	testnet := req.Testnet
	if req.Mainnet {
		testnet = false
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	price, err := h.getMidPrice(ctx, req.Coin, testnet)
	if err != nil || price == 0 {
		price = req.LimitPx
	}
	if price == 0 {
		return nil, fmt.Errorf("no price available for TWAP")
	}
	apiURL := getAPIURL(testnet)
	asset := h.assetIndexForCoin(ctx, apiURL, req.Coin)
	if asset < 0 {
		return nil, fmt.Errorf("failed to resolve asset index for %s", req.Coin)
	}
	szDecimals, err := h.getSzDecimals(ctx, req.Coin, testnet)
	if err != nil {
		return nil, err
	}
	coinSize := roundOrderNotionalToCoinSize(req.Sz, price, szDecimals, !req.ReduceOnly)
	if coinSize <= 0 {
		return nil, fmt.Errorf("TWAP size rounds to zero")
	}
	if err := rejectBelowMinOpenNotional(coinSize, price, req.ReduceOnly); err != nil {
		return nil, err
	}
	// Dex field omitted: the encoded asset index (100000+) already identifies the dex.
	action := twapOrderAction{
		Type: "twapOrder",
		Twap: twapWire{Asset: asset, IsBuy: req.IsBuy, Size: formatWireSize(coinSize, szDecimals), ReduceOnly: req.ReduceOnly, Minutes: req.Minutes, Randomize: req.Randomize},
	}
	resp, err := h.executeSignedExchangeAction(ctx, req.PrivateKey, testnet, action)
	if err != nil {
		return resp, err
	}
	if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		return resp, fmt.Errorf("TWAP order failed: %s", statusErr)
	}
	return resp, nil
}

func (h *HyperliquidAdapter) CancelTwapOrder(ctx context.Context, req models.TwapCancelRequest) (interface{}, error) {
	testnet := req.Testnet
	if req.Mainnet {
		testnet = false
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	if req.TwapID <= 0 {
		return nil, fmt.Errorf("missing twapId")
	}
	apiURL := getAPIURL(testnet)
	asset := 0
	if req.Coin != "" {
		asset = h.assetIndexForCoin(ctx, apiURL, req.Coin)
		if asset < 0 {
			return nil, fmt.Errorf("failed to resolve asset index for %s", req.Coin)
		}
	}
	// Dex field omitted: the encoded asset index already identifies the dex.
	action := twapCancelAction{Type: "twapCancel", Asset: asset, TwapID: req.TwapID}
	resp, err := h.executeSignedExchangeAction(ctx, req.PrivateKey, testnet, action)
	if err != nil {
		return resp, err
	}
	if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		return resp, fmt.Errorf("TWAP cancel failed: %s", statusErr)
	}
	return resp, nil
}

func (h *HyperliquidAdapter) ScheduleCancel(ctx context.Context, address string, timeMs *int64, testnet bool) error {
	if timeMs != nil && *timeMs < time.Now().UnixMilli()+5000 {
		return fmt.Errorf("schedule cancel time must be at least 5 seconds in the future")
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	action := ScheduleCancelAction{Type: "scheduleCancel", Time: timeMs}
	resp, err := h.executeSignedExchangeAction(ctx, address, testnet, action)
	if err != nil {
		return err
	}
	if statusErr := extractTopLevelExchangeError(resp); statusErr != "" {
		return fmt.Errorf("%s", statusErr)
	}
	return nil
}

func (h *HyperliquidAdapter) ClosePosition(ctx context.Context, privateKey, address, coin string, fraction, positionSize, positionSzi float64, testnet bool) (models.ClosePositionResult, error) {
	if resolveMarketVenue(coin).isBuilderPerp() {
		return h.closeHip3Position(ctx, privateKey, address, coin, fraction, positionSize, positionSzi, testnet)
	}
	if fraction <= 0 {
		fraction = 1
	}

	// The position lookup carries the close direction in szi's sign (the SDK's
	// MarketClose did the same UserState fetch internally).
	szi := positionSzi
	if szi == 0 {
		var err error
		szi, err = h.lookupPositionSize(ctx, privateKey, address, coin, testnet)
		if err != nil {
			return models.ClosePositionResult{}, err
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

	mid, err := h.getMidPrice(ctx, coin, testnet)
	if err != nil || mid <= 0 {
		return models.ClosePositionResult{}, fmt.Errorf("could not get mid price for %s", coin)
	}
	limitPx := slippagePrice(mid, isBuy, marketOrderSlippage, szDec)

	apiURL := getAPIURL(testnet)
	assetIdx := h.assetIndexForCoin(ctx, apiURL, coin)
	if assetIdx < 0 {
		return models.ClosePositionResult{}, fmt.Errorf("could not find asset index for %s", coin)
	}
	wire, err := stdOrderWire(assetIdx, isBuy, limitPx, size, true,
		OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifIoc}})
	if err != nil {
		return models.ClosePositionResult{}, err
	}
	wire.Cloid, err = resolveOrderCloid("")
	if err != nil {
		return models.ClosePositionResult{}, err
	}
	action := OrderAction{Type: "order", Orders: []OrderWire{wire}, Grouping: groupingNA}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	resp, err := h.executeSignedExchangeAction(ctx, privateKey, testnet, action)
	if err != nil {
		return models.ClosePositionResult{}, err
	}
	if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		return models.ClosePositionResult{}, fmt.Errorf("%s", statusErr)
	}
	return closePositionResultFromResponse(size, wire.Cloid, resp), nil
}

// closePartialTolerance matches the browser market-order shortfall threshold:
// residual below 3% of requested size is treated as a full fill (price drift).
const closePartialTolerance = 0.97

func closePositionResultFromResponse(requestedSz float64, cloid *string, resp map[string]interface{}) models.ClosePositionResult {
	result := models.ClosePositionResult{
		Status:          "ok",
		RequestedSzCoin: requestedSz,
	}
	if cloid != nil {
		result.Cloid = *cloid
	}
	avgPx, filledSz, ok := extractCloseFill(resp)
	if !ok {
		// Exchange accepted the action but did not return a filled object
		// (empty book, zero fill). Treat as full residual so the UI can warn.
		if requestedSz > 0 {
			result.ResidualSzCoin = requestedSz
			result.Partial = true
		}
		return result
	}
	result.AvgPx = avgPx
	result.FilledSzCoin = filledSz
	if requestedSz > 0 && filledSz+1e-12 < requestedSz*closePartialTolerance {
		residual := requestedSz - filledSz
		if residual < 0 {
			residual = 0
		}
		result.ResidualSzCoin = residual
		result.Partial = true
	}
	return result
}

func extractCloseFill(resp map[string]interface{}) (avgPx, totalSz float64, ok bool) {
	if resp == nil {
		return 0, 0, false
	}
	if filled, has := resp["filled"].(map[string]interface{}); has {
		return parseCloseFilledMap(filled)
	}
	if data, has := resp["data"].(map[string]interface{}); has {
		if statuses, okStatuses := data["statuses"].([]interface{}); okStatuses && len(statuses) > 0 {
			if first, okFirst := statuses[0].(map[string]interface{}); okFirst {
				if filled, okFilled := first["filled"].(map[string]interface{}); okFilled {
					return parseCloseFilledMap(filled)
				}
			}
		}
	}
	if nested, has := resp["response"].(map[string]interface{}); has {
		return extractCloseFill(nested)
	}
	return 0, 0, false
}

func parseCloseFilledMap(filled map[string]interface{}) (avgPx, totalSz float64, ok bool) {
	avgPx = parseFloatStr(filled["avgPx"])
	if avgPx <= 0 {
		avgPx = parseFloatStr(filled["px"])
	}
	totalSz = parseFloatStr(filled["totalSz"])
	if totalSz <= 0 {
		totalSz = parseFloatStr(filled["sz"])
	}
	if avgPx <= 0 || totalSz <= 0 {
		return 0, 0, false
	}
	return avgPx, totalSz, true
}

func (h *HyperliquidAdapter) SetLeverage(ctx context.Context, privateKey, address, coin string, leverage int, isCross, testnet bool) error {
	apiURL := getAPIURL(testnet)
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	asset := h.assetIndexForCoin(ctx, apiURL, coin)
	if asset < 0 {
		return fmt.Errorf("coin %s not found in metadata", coin)
	}
	// Typed action, not a map: a Go map's random msgpack field order made this
	// signature valid only by chance (see executeSignedExchangeActionExpiring).
	action := UpdateLeverageAction{Type: "updateLeverage", Asset: asset, IsCross: isCross, Leverage: leverage}
	resp, err := h.executeSignedExchangeAction(ctx, privateKey, testnet, action)
	if err != nil {
		return err
	}
	if statusErr := extractExchangeStatusError(resp); statusErr != "" {
		return fmt.Errorf("set leverage failed: %s", statusErr)
	}
	return nil
}

func (h *HyperliquidAdapter) UpdateIsolatedMargin(ctx context.Context, privateKey, address, coin string, ntli float64, testnet bool) error {
	apiURL := getAPIURL(testnet)
	asset := h.assetIndexForCoin(ctx, apiURL, coin)
	if asset < 0 {
		return fmt.Errorf("coin %s not found in metadata", coin)
	}
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	wireNtli, err := usdToNtli(ntli)
	if err != nil {
		return err
	}
	if wireNtli == 0 {
		return fmt.Errorf("isolated margin change rounds to zero")
	}
	// Official: ntli is a signed 6-decimal integer; isBuy is unused until hedge
	// mode and must stay true (Python SDK always sends true).
	action := UpdateIsolatedMarginAction{Type: "updateIsolatedMargin", Asset: asset, IsBuy: true, Ntli: wireNtli}
	resp, err := h.executeSignedExchangeAction(ctx, privateKey, testnet, action)
	if err != nil {
		return err
	}
	if statusErr := extractTopLevelExchangeError(resp); statusErr != "" {
		return fmt.Errorf("update isolated margin failed: %s", statusErr)
	}
	return nil
}
