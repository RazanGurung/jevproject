package exchange

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

func (h *HyperliquidAdapter) GetMidPrice(ctx context.Context, coin string, testnet bool) (float64, error) {
	return h.getMidPrice(ctx, coin, testnet)
}

func (h *HyperliquidAdapter) getMidPrice(ctx context.Context, coin string, testnet bool) (float64, error) {
	apiURL := getAPIURL(testnet)
	if mid, ok := h.cachedHip3Mid(coin); ok {
		return mid, nil
	}
	if resolveMarketVenue(coin).isBuilderPerp() {
		return h.getHip3Price(ctx, apiURL, coin)
	}
	mids, err := h.getAllMids(ctx, apiURL)
	if err != nil {
		return 0, err
	}
	if midStr, ok := mids[coin]; ok {
		price, _ := strconv.ParseFloat(midStr, 64)
		return price, nil
	}
	return 0, fmt.Errorf("no mid price for %s", coin)
}

func (h *HyperliquidAdapter) getAllMids(ctx context.Context, apiURL string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, shortTimeout)
	defer cancel()
	var mids map[string]string
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{"type": "allMids"}, &mids); err != nil {
		return nil, err
	}
	if len(mids) == 0 {
		return nil, fmt.Errorf("empty allMids response")
	}
	return mids, nil
}

// hip3MidsCacheTTL is deliberately short: the streamed cache contains both
// standard and builder-perp mids, and these prices feed order
// sizing and the ±1% market-slippage bound, so staleness must stay well
// inside normal price drift. The market stream primes this cache at ~1s
// cadence (allMids dex=xyz via PrimeMids), so on the hot path xyz order
// placement normally never fetches metaAndAssetCtxs at all; the TTL covers
// stream gaps with a bounded fallback fetch.
const hip3MidsCacheTTL = 5 * time.Second

// PrimeMids refreshes the execution mid cache from the market stream. It is
// intentionally shared by standard and builder-perp close/order hot paths so
// a live price never requires a redundant /info request.
func (h *HyperliquidAdapter) PrimeMids(mids map[string]float64) {
	if len(mids) == 0 {
		return
	}
	h.hip3MidsMu.Lock()
	if h.hip3MidsCache.mids == nil {
		h.hip3MidsCache.mids = make(map[string]float64, len(mids))
	}
	updated := 0
	for coin, mid := range mids {
		if mid > 0 {
			h.hip3MidsCache.mids[coin] = mid
			updated++
		}
	}
	if updated > 0 {
		h.hip3MidsCache.time = time.Now()
	}
	h.hip3MidsMu.Unlock()
}

func (h *HyperliquidAdapter) cachedHip3Mid(coin string) (float64, bool) {
	h.hip3MidsMu.RLock()
	defer h.hip3MidsMu.RUnlock()
	if h.hip3MidsCache.mids == nil || time.Since(h.hip3MidsCache.time) > hip3MidsCacheTTL {
		return 0, false
	}
	mid, ok := h.hip3MidsCache.mids[coin]
	if !ok {
		mid, ok = h.hip3MidsCache.mids[stripDexPrefix(coin)]
	}
	return mid, ok && mid > 0
}

func (h *HyperliquidAdapter) getHip3Price(ctx context.Context, apiURL, coin string) (float64, error) {
	if mid, ok := h.cachedHip3Mid(coin); ok {
		return mid, nil
	}
	var respArr []interface{}
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{"type": "metaAndAssetCtxs", "dex": "xyz"}, &respArr); err != nil || len(respArr) < 2 {
		return 0, fmt.Errorf("invalid response for HIP-3 price")
	}
	meta, ok := respArr[0].(map[string]interface{})
	if !ok {
		return 0, fmt.Errorf("invalid meta")
	}
	universe, ok := meta["universe"].([]interface{})
	if !ok {
		return 0, fmt.Errorf("invalid universe")
	}
	assetCtxs, ok := respArr[1].([]interface{})
	if !ok {
		return 0, fmt.Errorf("invalid asset ctxs")
	}

	mids := make(map[string]float64, len(universe))
	for i, item := range universe {
		m, ok := item.(map[string]interface{})
		if !ok || i >= len(assetCtxs) {
			continue
		}
		name, _ := m["name"].(string)
		if name == "" {
			continue
		}
		assetCtx, ok := assetCtxs[i].(map[string]interface{})
		if !ok {
			continue
		}
		var price float64
		switch p := assetCtx["markPx"].(type) {
		case float64:
			price = p
		case string:
			price, _ = strconv.ParseFloat(p, 64)
		}
		if price > 0 {
			mids[stripDexPrefix(name)] = price
		}
	}

	h.hip3MidsMu.Lock()
	if h.hip3MidsCache.mids == nil {
		h.hip3MidsCache.mids = make(map[string]float64, len(mids))
	}
	for coin, mid := range mids {
		h.hip3MidsCache.mids[coin] = mid
	}
	h.hip3MidsCache.time = time.Now()
	h.hip3MidsMu.Unlock()

	if mid, ok := mids[stripDexPrefix(coin)]; ok && mid > 0 {
		return mid, nil
	}
	return 0, fmt.Errorf("no price for %s", coin)
}

func (h *HyperliquidAdapter) GetL2Snapshot(ctx context.Context, coin string, depth int, testnet bool) (interface{}, error) {
	apiURL := getAPIURL(testnet)
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	var result interface{}
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{"type": "l2Book", "coin": coin}, &result); err != nil {
		return nil, err
	}
	return result, nil
}
