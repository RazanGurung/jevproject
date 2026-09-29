package exchange

import (
	"context"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	exchangeport "hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/pkg/utils"
)

const (
	accountHotPathTimeout = 8 * time.Second
	builderStateTimeout   = 3 * time.Second
)

func (h *HyperliquidAdapter) GetAccount(ctx context.Context, address string) (map[string]interface{}, error) {
	apiURL := mainnetAPIURL

	ctx, cancel := context.WithTimeout(ctx, accountHotPathTimeout)
	defer cancel()

	type accountFetch struct {
		perpResult      map[string]interface{}
		xyzResult       map[string]interface{}
		spotResult      map[string]interface{}
		portfolioResult []interface{}
		perpErr         error
		xyzErr          error
		spotErr         error
		mode            string
		modeSource      string
	}

	postInfoMap := func(body map[string]interface{}) (map[string]interface{}, error) {
		var result map[string]interface{}
		if err := h.postInfoJSON(ctx, apiURL, body, &result); err != nil {
			return nil, err
		}
		return result, nil
	}
	postInfoMapWithRetry := func(body map[string]interface{}, maxRetries int) (map[string]interface{}, error) {
		var lastErr error
		for attempt := 0; attempt <= maxRetries; attempt++ {
			result, err := postInfoMap(body)
			if err == nil {
				return result, nil
			}
			lastErr = err
			if attempt < maxRetries {
				select {
				case <-time.After(150 * time.Millisecond * time.Duration(attempt+1)):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
		}
		return nil, lastErr
	}
	getCachedPortfolio := func() ([]interface{}, bool) {
		h.portfolioMu.RLock()
		defer h.portfolioMu.RUnlock()
		entry, ok := h.portfolioCache[strings.ToLower(address)]
		if !ok || time.Since(entry.time) > portfolioCacheTTL {
			return nil, false
		}
		cached := make([]interface{}, len(entry.value))
		copy(cached, entry.value)
		return cached, true
	}
	setCachedPortfolio := func(value []interface{}) {
		if value == nil {
			return
		}
		copied := make([]interface{}, len(value))
		copy(copied, value)
		h.portfolioMu.Lock()
		h.portfolioCache[strings.ToLower(address)] = portfolioEntry{value: copied, time: time.Now()}
		h.portfolioMu.Unlock()
	}

	fetch := accountFetch{}
	var accountModeStale bool
	fetch.mode, fetch.modeSource, accountModeStale = h.getCachedAccountMode(address)
	var wg sync.WaitGroup
	wg.Add(3)
	if fetch.mode == "" || accountModeStale {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fetch.mode, fetch.modeSource = h.fetchAccountMode(ctx, address)
		}()
	}

	// Fetch perp state first - this is the critical one for order placement
	go func() {
		defer wg.Done()
		fetch.perpResult, fetch.perpErr = postInfoMapWithRetry(map[string]interface{}{"type": "clearinghouseState", "user": address}, 2)
	}()
	// Fetch others in parallel
	go func() {
		defer wg.Done()
		fetch.xyzResult, fetch.xyzErr = postInfoMapWithRetry(map[string]interface{}{"type": "clearinghouseState", "user": address, "dex": "xyz"}, 2)
	}()
	go func() {
		defer wg.Done()
		fetch.spotResult, fetch.spotErr = postInfoMapWithRetry(map[string]interface{}{"type": "spotClearinghouseState", "user": address}, 2)
	}()
	wg.Wait()
	// Optional builder DEXes are deliberately not fetched on this hot path.
	// The trading poller refreshes one bounded set at a time; account snapshots
	// consume its last-known cache so an unrelated slow DEX cannot make the
	// entire account (or a concurrent visible chart load) miss its deadline.
	otherBuilderStates, builderFreshness := h.cachedBuilderStates(address)

	// Portfolio is decorative (the equity sparkline) and bulk-tier (weight 20).
	// It is NOT fetched on this hot path — every account refresh used to pay
	// that weight, and during a chart-history burst it was the single biggest
	// repeat consumer driving the info budget into saturation (which then
	// starved the xyz position poller — the live xyz-TP/SL bug). Serve it from
	// cache here; a single background refresh keeps the cache warm.
	if cached, ok := getCachedPortfolio(); ok {
		fetch.portfolioResult = cached
	} else {
		h.refreshPortfolioOnce(address, apiURL, setCachedPortfolio)
	}

	if fetch.perpErr != nil {
		return nil, fetch.perpErr
	}
	result := fetch.perpResult
	if result == nil {
		result = make(map[string]interface{})
	}
	if ms, ok := result["marginSummary"].(map[string]interface{}); ok {
		accountValue := parseFloatStr(ms["accountValue"])
		totalMarginUsed := parseFloatStr(ms["totalMarginUsed"])
		ms["availableMargin"] = fmt.Sprintf("%.8f", math.Max(0, accountValue-totalMarginUsed))
	}
	if cms, ok := result["crossMarginSummary"].(map[string]interface{}); ok {
		accountValue := parseFloatStr(cms["accountValue"])
		totalMarginUsed := parseFloatStr(cms["totalMarginUsed"])
		cms["availableMargin"] = fmt.Sprintf("%.8f", math.Max(0, accountValue-totalMarginUsed))
	}
	if fetch.xyzErr != nil {
		// A failed xyz fetch must be loud: the snapshot silently omitting xyz
		// positions is how a freshly-opened xyz position vanished from the
		// positions panel (webData2 never carries xyz, and the frontend's
		// carry-forward has nothing to preserve for a first appearance).
		log.Printf("WARNING: GetAccount: xyz clearinghouse fetch failed — xyz positions omitted from snapshot: %v", fetch.xyzErr)
	}
	if fetch.xyzErr == nil && fetch.xyzResult != nil {
		if xyzPos, ok := fetch.xyzResult["assetPositions"].([]interface{}); ok && len(xyzPos) > 0 {
			if existingPos, ok := result["assetPositions"].([]interface{}); ok {
				result["assetPositions"] = append(existingPos, xyzPos...)
			} else {
				result["assetPositions"] = xyzPos
			}
		}
		if xyzMarginSummary, ok := fetch.xyzResult["marginSummary"]; ok {
			result["xyzMarginSummary"] = xyzMarginSummary
		}
	}
	for _, builderState := range otherBuilderStates {
		if len(builderState.Positions) == 0 {
			continue
		}
		if existingPos, ok := result["assetPositions"].([]interface{}); ok {
			result["assetPositions"] = append(existingPos, builderState.Positions...)
		} else {
			result["assetPositions"] = builderState.Positions
		}
	}
	result["builderDexStates"] = otherBuilderStates
	result["builderDexFreshness"] = builderFreshness

	spotUSDC := utils.GetSpotUSDCBalance(fetch.spotResult)
	if fetch.spotResult != nil {
		result["spotState"] = fetch.spotResult
	}
	result["spotUSDC"] = fmt.Sprintf("%.8f", spotUSDC)

	riskSummary := map[string]interface{}{}
	if portfolioValue := utils.GetPortfolioCurrentValue(fetch.portfolioResult); portfolioValue > 0 {
		riskSummary["accountValue"] = fmt.Sprintf("%.8f", portfolioValue)
	} else if accountValue := extractAccountValue(nil, result); accountValue > 0 {
		riskSummary["accountValue"] = fmt.Sprintf("%.8f", accountValue)
	}
	// Account abstraction decides which clearinghouse owns collateral. In
	// Standard/DexAbstraction mode, perp withdrawable is meaningful. Hyperliquid
	// explicitly documents that individual perp-dex states are not meaningful
	// for Unified/Portfolio Margin accounts; balances and holds live in the spot
	// clearinghouse state, including tokenToAvailableAfterMaintenance.
	available, availableOK := accountAvailableCollateral(fetch.mode, result, fetch.spotResult)
	if availableOK {
		formatted := fmt.Sprintf("%.8f", available)
		riskSummary["withdrawable"] = formatted
		riskSummary["availableMargin"] = formatted
		riskSummary["totalAvailable"] = formatted
	}
	if spotUSDC > 0 {
		riskSummary["spotUSDC"] = fmt.Sprintf("%.8f", spotUSDC)
	}
	result["riskSummary"] = riskSummary
	if fetch.mode == "" {
		fetch.mode = "unknown"
		fetch.modeSource = "unavailable"
	}
	result["accountMode"] = fetch.mode
	result["accountModeSource"] = fetch.modeSource
	result["riskSummaryFresh"] = fetch.perpErr == nil && fetch.spotErr == nil && fetch.mode != "unknown"

	positionRisk := []interface{}{}
	if assetPos, ok := result["assetPositions"].([]interface{}); ok {
		for _, ap := range assetPos {
			if apMap, ok := ap.(map[string]interface{}); ok {
				if pos, ok := apMap["position"].(map[string]interface{}); ok {
					coin, _ := pos["coin"].(string)
					entryPx := parseFloatStr(pos["entryPx"])
					markPx := parseFloatStr(pos["markPx"])
					size := parseFloatStr(pos["szi"])
					unrealizedPnl := sanitizeFloat64(parseFloatStr(pos["unrealizedPnl"]))
					if unrealizedPnl == 0 && size != 0 && entryPx > 0 && markPx > 0 {
						unrealizedPnl = sanitizeFloat64((markPx - entryPx) * size)
					}
					returnOnEquity := sanitizeFloat64(parseFloatStr(pos["returnOnEquity"]))
					marginUsed := parseFloatStr(pos["marginUsed"])
					if returnOnEquity == 0 && unrealizedPnl != 0 && marginUsed > 0 {
						returnOnEquity = sanitizeFloat64(unrealizedPnl / marginUsed)
					}
					leverage := 0.0
					if levMap, ok := pos["leverage"].(map[string]interface{}); ok {
						switch value := levMap["value"].(type) {
						case float64:
							leverage = sanitizeFloat64(value)
						case string:
							leverage = sanitizeFloat64(parseJSONFloat(value))
						}
					}
					positionRisk = append(positionRisk, map[string]interface{}{
						"coin": coin, "entryPx": entryPx, "markPx": markPx, "size": size,
						"unrealizedPnl": unrealizedPnl, "returnOnEquity": returnOnEquity, "leverage": leverage,
					})
				}
			}
		}
	}
	result["positionRisk"] = positionRisk

	if fetch.xyzErr != nil || fetch.spotErr != nil {
		log.Printf("GetAccount partial errors: xyz=%v spot=%v", fetch.xyzErr, fetch.spotErr)
	}
	if debugExchangeLogsEnabled() {
		log.Printf("GetAccount: returning with riskSummary.accountValue=%v, positions=%d", riskSummary["accountValue"], len(positionRisk))
	}
	return result, nil
}

func accountAvailableCollateral(mode string, perpState, spotState map[string]interface{}) (float64, bool) {
	switch mode {
	case "unifiedAccount", "portfolioMargin":
		if spotState == nil {
			return 0, false
		}
		afterMaintenance := math.Max(0, utils.GetSpotWithdrawable(spotState))
		spendableUSDC := math.Max(0, utils.GetSpotUSDCBalance(spotState))
		return math.Min(afterMaintenance, spendableUSDC), true
	default:
		if perpState == nil {
			return 0, false
		}
		raw, exists := perpState["withdrawable"]
		if !exists {
			return 0, false
		}
		return math.Max(0, parseFloatStr(raw)), true
	}
}

// RefreshPortfolio forces the high-weight portfolio summary into cache.
// Routine account reads keep the 60s cache, while execution-triggered
// WebSocket repairs call this once per coalesced action burst so the top-right
// Portfolio Value is authoritative rather than merely delivered quickly.
func (h *HyperliquidAdapter) RefreshPortfolio(ctx context.Context, address string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var result []interface{}
	if err := h.postInfoJSON(ctx, mainnetAPIURL, map[string]interface{}{
		"type": "portfolio", "user": address,
	}, &result); err != nil {
		return err
	}
	if len(result) == 0 {
		return nil
	}
	copied := make([]interface{}, len(result))
	copy(copied, result)
	h.portfolioMu.Lock()
	h.portfolioCache[strings.ToLower(address)] = portfolioEntry{value: copied, time: time.Now()}
	h.portfolioMu.Unlock()
	return nil
}

func (h *HyperliquidAdapter) GetFills(ctx context.Context, address string, startTime int64) ([]interface{}, error) {
	apiURL := mainnetAPIURL
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	body := map[string]interface{}{"type": "userFills", "user": address}
	if startTime > 0 {
		body["type"] = "userFillsByTime"
		body["startTime"] = startTime
	}
	var result []interface{}
	if err := h.postInfoJSON(ctx, apiURL, body, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (h *HyperliquidAdapter) GetOpenOrders(ctx context.Context, address string) ([]interface{}, error) {
	apiURL := mainnetAPIURL
	ctx, cancel := context.WithTimeout(ctx, accountHotPathTimeout)
	defer cancel()

	cacheKey := strings.ToLower(strings.TrimSpace(address))
	getCachedOpenOrders := func() ([]interface{}, bool) {
		if cacheKey == "" {
			return nil, false
		}
		h.openOrdersMu.RLock()
		defer h.openOrdersMu.RUnlock()
		entry, ok := h.openOrdersCache[cacheKey]
		if !ok || time.Since(entry.time) > openOrdersCacheTTL {
			return nil, false
		}
		cached := make([]interface{}, len(entry.value))
		copy(cached, entry.value)
		return cached, true
	}
	setCachedOpenOrders := func(value []interface{}) {
		if cacheKey == "" || value == nil {
			return
		}
		copied := make([]interface{}, len(value))
		copy(copied, value)
		h.openOrdersMu.Lock()
		h.openOrdersCache[cacheKey] = openOrdersEntry{value: copied, time: time.Now()}
		h.openOrdersMu.Unlock()
	}

	postInfoArray := func(body map[string]interface{}) ([]interface{}, error) {
		var result []interface{}
		if err := h.postInfoJSON(ctx, apiURL, body, &result); err != nil {
			return nil, err
		}
		return result, nil
	}
	var perpOrders, xyzOrders []interface{}
	var perpErr, xyzErr error
	var wg sync.WaitGroup
	wg.Add(2)
	// frontendOpenOrders, not plain openOrders: the plain variant carries no
	// reduceOnly/orderType/triggerPx, so TP/SL protection orders could not be
	// classified anywhere downstream (runtime snapshots, chart lines).
	go func() {
		defer wg.Done()
		perpOrders, perpErr = postInfoArray(map[string]interface{}{"type": "frontendOpenOrders", "user": address})
	}()
	go func() {
		defer wg.Done()
		xyzOrders, xyzErr = postInfoArray(map[string]interface{}{"type": "frontendOpenOrders", "user": address, "dex": "xyz"})
	}()
	wg.Wait()
	var otherBuilderOrders []interface{}
	if dexes, err := h.GetBuilderDexes(ctx); err == nil {
		var builderWG sync.WaitGroup
		var builderMu sync.Mutex
		for _, dex := range dexes {
			if dex == "xyz" {
				continue
			}
			builderWG.Add(1)
			go func(dex string) {
				defer builderWG.Done()
				builderCtx, cancel := context.WithTimeout(ctx, builderStateTimeout)
				defer cancel()
				state, err := h.GetBuilderDexState(builderCtx, address, dex, true)
				if err == nil && len(state.Orders) > 0 {
					builderMu.Lock()
					otherBuilderOrders = append(otherBuilderOrders, state.Orders...)
					builderMu.Unlock()
				}
			}(dex)
		}
		builderWG.Wait()
	}

	if perpErr != nil && xyzErr != nil {
		if isRetryableInfoError(perpErr) || isRetryableInfoError(xyzErr) {
			if cached, ok := getCachedOpenOrders(); ok {
				return cached, nil
			}
		}
		return nil, perpErr
	}

	merged := append(perpOrders, xyzOrders...)
	merged = append(merged, otherBuilderOrders...)
	if len(merged) > 0 || (perpErr == nil && xyzErr == nil) {
		setCachedOpenOrders(merged)
		return merged, nil
	}

	if cached, ok := getCachedOpenOrders(); ok && (isRetryableInfoError(perpErr) || isRetryableInfoError(xyzErr)) {
		return cached, nil
	}

	return merged, nil
}

// refreshPortfolioOnce kicks a single background portfolio fetch (deduped per
// address) and warms the cache. GetAccount no longer fetches portfolio on its
// hot path; this keeps the decorative equity sparkline eventually-fresh
// without paying its weight on every account refresh.
func (h *HyperliquidAdapter) refreshPortfolioOnce(address, apiURL string, store func([]interface{})) {
	key := strings.ToLower(address)
	if _, busy := h.portfolioRefreshing.LoadOrStore(key, true); busy {
		return
	}
	go func() {
		defer h.portfolioRefreshing.Delete(key)
		ctx, cancel := context.WithTimeout(h.backgroundContext(), shortTimeout)
		defer cancel()
		var result []interface{}
		if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{"type": "portfolio", "user": address}, &result); err != nil {
			return
		}
		if len(result) > 0 {
			store(result)
		}
	}()
}

// GetBuilderDexes returns the builder perp dexes this app loads as markets.
// Only the xyz HIP-3 dex is supported; other HIP-3 / builder dexs are
// intentionally filtered out so they never enter metadata, allMids, or
// account-poll fanout. The default (nil) dex is omitted from this result.
func (h *HyperliquidAdapter) GetBuilderDexes(ctx context.Context) ([]string, error) {
	h.builderDexesMu.RLock()
	if len(h.builderDexes) > 0 && time.Since(h.builderDexesAt) < szCacheTTL {
		cached := append([]string(nil), h.builderDexes...)
		h.builderDexesMu.RUnlock()
		return cached, nil
	}
	h.builderDexesMu.RUnlock()
	apiURL := mainnetAPIURL
	ctx, cancel := context.WithTimeout(ctx, shortTimeout)
	defer cancel()
	var items []interface{}
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{"type": "perpDexs"}, &items); err != nil {
		return nil, err
	}
	// Product policy: only xyz HIP-3 markets are loaded. Discover via perpDexs
	// so a missing xyz listing fails closed (empty result) rather than inventing
	// one, but never admit para/vntl/mkts/etc. into the market set.
	dexes := make([]string, 0, 1)
	for _, item := range items {
		obj, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := obj["name"].(string)
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "xyz" {
			dexes = append(dexes, name)
			break
		}
	}
	h.builderDexesMu.Lock()
	h.builderDexes = append([]string(nil), dexes...)
	h.builderDexesAt = time.Now()
	h.builderDexesMu.Unlock()
	return dexes, nil
}

// GetBuilderDexState is the generic repair source for builder-perp positions
// and orders whose user-stream coverage is incomplete.
func (h *HyperliquidAdapter) GetBuilderDexState(ctx context.Context, address, dex string, includeOrders bool) (exchangeport.BuilderDexState, error) {
	dex = strings.ToLower(strings.TrimSpace(dex))
	result := exchangeport.BuilderDexState{Dex: dex}
	if dex == "" {
		return result, fmt.Errorf("builder dex is required")
	}
	ctx, cancel := context.WithTimeout(ctx, shortTimeout)
	defer cancel()
	var state map[string]interface{}
	if err := h.postInfoJSON(ctx, mainnetAPIURL, map[string]interface{}{
		"type": "clearinghouseState", "user": address, "dex": dex,
	}, &state); err != nil {
		return result, err
	}
	result.Positions, _ = state["assetPositions"].([]interface{})
	if includeOrders {
		if err := h.postInfoJSON(ctx, mainnetAPIURL, map[string]interface{}{
			"type": "frontendOpenOrders", "user": address, "dex": dex,
		}, &result.Orders); err != nil {
			return result, err
		}
	}
	cacheKey := strings.ToLower(strings.TrimSpace(address)) + ":" + dex
	h.builderStateMu.Lock()
	h.builderStateCache[cacheKey] = builderStateEntry{state: cloneBuilderState(result), time: time.Now()}
	h.builderStateMu.Unlock()
	return result, nil
}

const builderStateFreshTTL = 15 * time.Second

func cloneBuilderState(state exchangeport.BuilderDexState) exchangeport.BuilderDexState {
	cloned := state
	cloned.Positions = append([]interface{}(nil), state.Positions...)
	cloned.Orders = append([]interface{}(nil), state.Orders...)
	return cloned
}

// cachedBuilderStates returns last-known optional builder state without doing
// network I/O. Freshness is explicit so a renderer can retain honest data
// instead of interpreting a timeout as an empty position list.
func (h *HyperliquidAdapter) cachedBuilderStates(address string) ([]exchangeport.BuilderDexState, map[string]interface{}) {
	prefix := strings.ToLower(strings.TrimSpace(address)) + ":"
	now := time.Now()
	states := make([]exchangeport.BuilderDexState, 0)
	freshness := make(map[string]interface{})
	h.builderStateMu.RLock()
	for key, entry := range h.builderStateCache {
		if !strings.HasPrefix(key, prefix) || entry.state.Dex == "xyz" {
			continue
		}
		states = append(states, cloneBuilderState(entry.state))
		freshness[entry.state.Dex] = map[string]interface{}{
			"asOf":  entry.time.UnixMilli(),
			"fresh": now.Sub(entry.time) <= builderStateFreshTTL,
		}
	}
	h.builderStateMu.RUnlock()
	return states, freshness
}

func (h *HyperliquidAdapter) GetActiveAssetData(ctx context.Context, address, coin string) (map[string]interface{}, error) {
	apiURL := mainnetAPIURL
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	cacheKey := strings.ToLower(address) + ":" + coin
	getCachedActiveAsset := func() (map[string]interface{}, bool) {
		h.activeAssetMu.RLock()
		defer h.activeAssetMu.RUnlock()
		if entry, ok := h.activeAssetCache[cacheKey]; ok && time.Since(entry.time) < activeAssetCacheTTL && entry.value != nil {
			cached := map[string]interface{}{}
			for k, v := range entry.value {
				cached[k] = v
			}
			return cached, true
		}
		return nil, false
	}

	if cached, ok := getCachedActiveAsset(); ok {
		return cached, nil
	}

	body := map[string]interface{}{"type": "activeAssetData", "user": strings.ToLower(address), "coin": coin}
	var data map[string]interface{}
	if err := h.postInfoJSON(ctx, apiURL, body, &data); err != nil {
		if cached, ok := getCachedActiveAsset(); ok && isRetryableInfoError(err) {
			return cached, nil
		}
		return nil, err
	}
	leverage := 0
	leverageType := ""
	if levData, ok := data["leverage"].(map[string]interface{}); ok {
		leverageType, _ = levData["type"].(string)
		switch value := levData["value"].(type) {
		case float64:
			leverage = int(value)
		case string:
			leverage = int(parseJSONFloat(value))
		}
	}
	var maxTradeSzs [2]float64
	if szs, ok := data["maxTradeSzs"].([]interface{}); ok && len(szs) == 2 {
		maxTradeSzs[0] = parseAnyFloat64(szs[0])
		maxTradeSzs[1] = parseAnyFloat64(szs[1])
	}
	var availableToTrade [2]float64
	if avail, ok := data["availableToTrade"].([]interface{}); ok && len(avail) == 2 {
		availableToTrade[0] = parseAnyFloat64(avail[0])
		availableToTrade[1] = parseAnyFloat64(avail[1])
	}
	result := map[string]interface{}{
		"coin": coin, "leverage": leverage, "leverageType": leverageType,
		"markPx":      parseAnyFloat64(data["markPx"]),
		"maxTradeSzs": maxTradeSzs, "availableToTrade": availableToTrade, "data": data,
	}
	h.activeAssetMu.Lock()
	h.activeAssetCache[cacheKey] = activeAssetEntry{value: result, time: time.Now()}
	h.activeAssetMu.Unlock()
	return result, nil
}

func cloneAssetCtxs(in []interface{}) []interface{} {
	out := make([]interface{}, len(in))
	for i, raw := range in {
		ctxMap, ok := raw.(map[string]interface{})
		if !ok {
			out[i] = raw
			continue
		}
		cp := make(map[string]interface{}, len(ctxMap))
		for k, v := range ctxMap {
			cp[k] = v
		}
		out[i] = cp
	}
	return out
}

func (h *HyperliquidAdapter) GetAssetCtxs(ctx context.Context, dex string) ([]interface{}, error) {
	// Serve a fresh-enough cached result so the 24h/movers/mispricing endpoints
	// that each call this share one fetch instead of bursting /info.
	h.assetCtxsMu.Lock()
	if entry, ok := h.assetCtxsCache[dex]; ok && time.Since(entry.time) < assetCtxsCacheTTL {
		value := cloneAssetCtxs(entry.value)
		h.assetCtxsMu.Unlock()
		return value, nil
	}
	if flight, ok := h.assetCtxsInflight[dex]; ok {
		h.assetCtxsMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			if flight.err != nil {
				return nil, flight.err
			}
			return cloneAssetCtxs(flight.value), nil
		}
	}
	flight := &assetCtxsFlight{done: make(chan struct{})}
	h.assetCtxsInflight[dex] = flight
	h.assetCtxsMu.Unlock()

	finish := func(value []interface{}, err error) ([]interface{}, error) {
		h.assetCtxsMu.Lock()
		flight.value = value
		flight.err = err
		delete(h.assetCtxsInflight, dex)
		close(flight.done)
		h.assetCtxsMu.Unlock()
		if err != nil {
			return nil, err
		}
		return cloneAssetCtxs(value), nil
	}

	apiURL := mainnetAPIURL
	ctx, cancel := context.WithTimeout(ctx, mediumTimeout)
	defer cancel()
	var body map[string]interface{}
	if dex != "" {
		body = map[string]interface{}{"type": "metaAndAssetCtxs", "dex": dex}
	} else {
		body = map[string]interface{}{"type": "metaAndAssetCtxs"}
	}
	var result []interface{}
	if err := h.postInfoJSON(ctx, apiURL, body, &result); err != nil {
		h.assetCtxsMu.RLock()
		entry, ok := h.assetCtxsCache[dex]
		h.assetCtxsMu.RUnlock()
		if ok {
			return finish(entry.value, nil)
		}
		return finish(nil, err)
	}
	if len(result) >= 2 {
		if assetCtxs, ok := result[1].([]interface{}); ok {
			// metaAndAssetCtxs keeps coin names in the parallel universe array
			// (result[0]), not on the ctx objects. Inject each name onto its ctx
			// by index so downstream consumers can key by "coin".
			if meta, ok := result[0].(map[string]interface{}); ok {
				if universe, ok := meta["universe"].([]interface{}); ok {
					for i, raw := range assetCtxs {
						ctxMap, ok := raw.(map[string]interface{})
						if !ok || i >= len(universe) {
							continue
						}
						u, ok := universe[i].(map[string]interface{})
						if !ok {
							continue
						}
						if name, ok := u["name"].(string); ok && name != "" {
							if _, exists := ctxMap["coin"]; !exists {
								ctxMap["coin"] = name
							}
						}
					}
				}
			}
			h.assetCtxsMu.Lock()
			h.assetCtxsCache[dex] = assetCtxsEntry{value: assetCtxs, time: time.Now()}
			h.assetCtxsMu.Unlock()
			return finish(assetCtxs, nil)
		}
	}
	return finish(nil, fmt.Errorf("invalid metaAndAssetCtxs response shape"))
}
