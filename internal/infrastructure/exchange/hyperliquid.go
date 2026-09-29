package exchange

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/prometheus/client_golang/prometheus"

	"hyperliquid-go/internal/accountcache"
	exchangeport "hyperliquid-go/internal/ports/exchange"
	"hyperliquid-go/pkg/utils"
)

// HyperliquidAdapter is the first-party Hyperliquid exchange adapter: it owns
// signing (via infrastructure/signing), wire-action construction (hlwire.go),
// REST transport, and the metadata caches that keep the order hot path free
// of synchronous lookups.
type HyperliquidAdapter struct {
	actionSem        chan struct{}
	lifecycleCtx     context.Context
	szCache          map[string]szDecimalEntry
	szMu             sync.RWMutex
	tickCache        map[string]tickSizeEntry
	tickMu           sync.RWMutex
	activeAssetCache map[string]activeAssetEntry
	activeAssetMu    sync.RWMutex
	portfolioCache   map[string]portfolioEntry
	portfolioMu      sync.RWMutex
	openOrdersCache  map[string]openOrdersEntry
	openOrdersMu     sync.RWMutex
	assetIndexCache  map[string]assetIndexEntry
	assetIndexMu     sync.RWMutex
	perpDexCache     map[string]perpDexEntry
	perpDexMu        sync.RWMutex
	builderDexes     []string
	builderDexesAt   time.Time
	builderDexesMu   sync.RWMutex
	// builderStateCache is warmed by the dedicated trading poller. Core account
	// reads consume it without synchronously fanning out across every discovered
	// builder DEX, keeping post-trade reconciliation bounded and chart-friendly.
	builderStateCache map[string]builderStateEntry
	builderStateMu    sync.RWMutex
	// standardMetaCache caches the default perp meta universe so standard perp
	// tick/size lookups do not each cold-fetch /info meta on the first order.
	standardMetaCache map[string]xyzMetaEntry
	standardMetaMu    sync.RWMutex
	// xyzMetaCache caches the raw metaAndAssetCtxs?dex=xyz response body, shared by
	// getHip3TickSize, getHip3SzDecimals, and getAssetIndex to avoid redundant fetches.
	xyzMetaCache map[string]xyzMetaEntry
	xyzMetaMu    sync.RWMutex
	// assetCtxsCache caches GetAssetCtxs results per dex for a short window so the
	// 24h-changes, movers, and mispricing endpoints (which each call it) share one
	// fetch instead of independently hammering /info — a burst that 429s at startup.
	// On a fetch error a still-cached value is served, so a transient rate-limit
	// doesn't fail those endpoints.
	assetCtxsCache    map[string]assetCtxsEntry
	assetCtxsInflight map[string]*assetCtxsFlight
	assetCtxsMu       sync.RWMutex
	// walletExistsCache caches wallet-existence results to skip per-order re-checks.
	walletExistsCache map[string]walletExistsEntry
	walletExistsMu    sync.RWMutex
	accountModeCache  map[string]accountModeEntry
	accountModeMu     sync.RWMutex
	// portfolioRefreshing guards the background portfolio refresh so concurrent
	// cache misses don't each fire a fetch (portfolio is decorative, weight 20).
	portfolioRefreshing sync.Map
	// hip3MidsCache caches the parsed xyz mark-price map for a short window so
	// one order action does not fetch the full metaAndAssetCtxs payload
	// multiple times (pricing + ladder validation + close paths).
	hip3MidsCache hip3MidsEntry
	hip3MidsMu    sync.RWMutex
	lastNonce      int64
	nonceMu        sync.Mutex
	parsedKeyCache map[string]*ecdsa.PrivateKey
	parsedKeyMu    sync.RWMutex
	httpClient     *http.Client
}

var (
	signedActionQueueSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pez_signed_action_queue_seconds",
		Help:    "Time signed exchange actions wait for the bounded transport lane.",
		Buckets: prometheus.DefBuckets,
	}, []string{"action"})
	signedActionRequestSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pez_signed_action_request_seconds",
		Help:    "Duration of signed exchange HTTP requests after acquiring a lane.",
		Buckets: prometheus.DefBuckets,
	}, []string{"action", "result"})
	signedActionsInFlight = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "pez_signed_actions_in_flight",
		Help: "Current signed exchange HTTP requests in flight.",
	})
)

func init() {
	prometheus.MustRegister(signedActionQueueSeconds, signedActionRequestSeconds, signedActionsInFlight)
}

// assetCtxsCacheTTL is the freshness window for cached GetAssetCtxs results. Asset
// ctxs carry 24h change / OI (used for ranking, not live pricing — that streams
// over the WS), so a few seconds of staleness is fine and lets the info endpoints
// dedupe their fetches.
const (
	assetCtxsCacheTTL               = 5 * time.Second
	defaultMaxSignedActionsInFlight = 8
	accountModeCacheTTL             = 5 * time.Minute
	// These caches intentionally serve explicitly-stale fallback data during
	// short upstream outages. A longer retention bound preserves that behavior
	// while preventing unbounded address*dex growth on a long-running server.
	builderStateRetentionTTL = 24 * time.Hour
	accountModeRetentionTTL  = 24 * time.Hour
)

type assetCtxsEntry struct {
	value []interface{}
	time  time.Time
}

type assetCtxsFlight struct {
	done  chan struct{}
	value []interface{}
	err   error
}

type builderStateEntry struct {
	state exchangeport.BuilderDexState
	time  time.Time
}

type szDecimalEntry struct {
	value int
	time  time.Time
}

type tickSizeEntry struct {
	value float64
	time  time.Time
}

type activeAssetEntry struct {
	value map[string]interface{}
	time  time.Time
}

type portfolioEntry struct {
	value []interface{}
	time  time.Time
}

type openOrdersEntry struct {
	value []interface{}
	time  time.Time
}

type assetIndexEntry struct {
	value int
	time  time.Time
}

type perpDexEntry struct {
	value int
	time  time.Time
}

type xyzMetaEntry struct {
	universe []interface{} // parsed meta.universe slice
	time     time.Time
}

type hip3MidsEntry struct {
	mids map[string]float64 // keyed by stripDexPrefix(name)
	time time.Time
}

type accountModeEntry struct {
	mode   string
	source string
	time   time.Time
}

type walletExistsEntry struct {
	exists bool
	time   time.Time
}

type twapWire struct {
	Asset      int    `json:"a" msgpack:"a"`
	IsBuy      bool   `json:"b" msgpack:"b"`
	Size       string `json:"s" msgpack:"s"`
	ReduceOnly bool   `json:"r" msgpack:"r"`
	Minutes    int    `json:"m" msgpack:"m"`
	Randomize  bool   `json:"t" msgpack:"t"`
}

type twapOrderAction struct {
	Type string   `json:"type"          msgpack:"type"`
	Dex  string   `json:"dex,omitempty" msgpack:"dex,omitempty"`
	Twap twapWire `json:"twap"          msgpack:"twap"`
}

type twapCancelAction struct {
	Type   string `json:"type"          msgpack:"type"`
	Dex    string `json:"dex,omitempty" msgpack:"dex,omitempty"`
	Asset  int    `json:"a"             msgpack:"a"`
	TwapID int64  `json:"t"             msgpack:"t"`
}

const (
	szCacheTTL                = 30 * time.Minute
	executionMetaRetentionTTL = 24 * time.Hour
	walletExistsCacheTTL      = 10 * time.Minute
	activeAssetCacheTTL       = 20 * time.Second
	portfolioCacheTTL         = 60 * time.Second
	openOrdersCacheTTL        = 5 * time.Second
	shortTimeout              = 10 * time.Second
	mediumTimeout             = 30 * time.Second
)

func parseJSONFloat(v string) float64 {
	f, _ := strconv.ParseFloat(v, 64)
	return f
}

func parseAnyFloat64(v interface{}) float64 {
	switch value := v.(type) {
	case float64:
		return sanitizeFloat64(value)
	case string:
		return sanitizeFloat64(parseJSONFloat(value))
	default:
		return 0
	}
}

func sanitizeFloat64(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func roundNotionalToCoinSize(usdNotional, refPrice float64, szDecimals int) float64 {
	if usdNotional <= 0 || refPrice <= 0 {
		return 0
	}
	coinSize := usdNotional / refPrice
	multiplier := 1.0
	for i := 0; i < szDecimals; i++ {
		multiplier *= 10
	}
	return math.Floor((coinSize*multiplier)+1e-9) / multiplier
}

func roundOrderNotionalToCoinSize(usdNotional, refPrice float64, szDecimals int, enforceMinOpenNotional bool) float64 {
	roundedDown := roundNotionalToCoinSize(usdNotional, refPrice, szDecimals)
	if !enforceMinOpenNotional || refPrice <= 0 {
		return roundedDown
	}

	const minOpenNotionalUSD = 10.0
	if usdNotional+1e-9 < minOpenNotionalUSD {
		return roundedDown
	}
	if roundedDown*refPrice+1e-9 >= minOpenNotionalUSD {
		return roundedDown
	}

	multiplier := 1.0
	for i := 0; i < szDecimals; i++ {
		multiplier *= 10
	}
	rawCoinSize := usdNotional / refPrice
	roundedUp := math.Ceil((rawCoinSize*multiplier)-1e-9) / multiplier
	if roundedUp*refPrice+1e-9 >= minOpenNotionalUSD {
		return roundedUp
	}
	return roundedDown
}

func extractExchangeStatusError(response map[string]interface{}) string {
	if response == nil {
		return ""
	}

	if errText, ok := response["error"].(string); ok && strings.TrimSpace(errText) != "" {
		return strings.TrimSpace(errText)
	}

	// Flat error shape: {"response":"User or API Wallet ... does not exist.","status":"err"}
	if status, ok := response["status"].(string); ok && status == "err" {
		if respStr, ok := response["response"].(string); ok && strings.TrimSpace(respStr) != "" {
			return strings.TrimSpace(respStr)
		}
	}

	// Nested error shape: {response:{type:"order",data:{statuses:[{error:"..."}]}}}
	data, _ := response["data"].(map[string]interface{})
	statuses, _ := data["statuses"].([]interface{})
	if len(statuses) == 0 {
		// Also check response.data.statuses (SDK wrapper shape)
		if resp, ok := response["response"].(map[string]interface{}); ok {
			if d, ok := resp["data"].(map[string]interface{}); ok {
				if sts, ok := d["statuses"].([]interface{}); ok && len(sts) > 0 {
					if first, ok := sts[0].(map[string]interface{}); ok {
						if errText, ok := first["error"].(string); ok && strings.TrimSpace(errText) != "" {
							return strings.TrimSpace(errText)
						}
					}
				}
			}
		}
		return ""
	}

	first, _ := statuses[0].(map[string]interface{})
	if first == nil {
		return ""
	}

	if errText, ok := first["error"].(string); ok && strings.TrimSpace(errText) != "" {
		return strings.TrimSpace(errText)
	}
	if errText, ok := first["Error"].(string); ok && strings.TrimSpace(errText) != "" {
		return strings.TrimSpace(errText)
	}

	return ""
}

func statusEntryError(status interface{}) string {
	if text, ok := status.(string); ok && strings.TrimSpace(text) != "" && text != "success" {
		return strings.TrimSpace(text)
	}
	first, _ := status.(map[string]interface{})
	if first == nil {
		return ""
	}
	if errText, ok := first["error"].(string); ok && strings.TrimSpace(errText) != "" {
		return strings.TrimSpace(errText)
	}
	if errText, ok := first["Error"].(string); ok && strings.TrimSpace(errText) != "" {
		return strings.TrimSpace(errText)
	}
	return ""
}

// lookupPositionSize returns the signed position size (szi) for coin — the
// sign carries the direction a close order must take.
func (h *HyperliquidAdapter) lookupPositionSize(ctx context.Context, privateKey, address, coin string, testnet bool) (float64, error) {
	accountAddress := strings.TrimSpace(address)
	if accountAddress == "" {
		accountAddress = accountcache.GetWithFallback()
	}
	if accountAddress == "" {
		var err error
		accountAddress, err = h.GetAddressFromPrivateKey(ctx, privateKey)
		if err != nil {
			return 0, err
		}
	}
	if accountAddress == "" {
		return 0, fmt.Errorf("missing account address for partial close")
	}

	apiURL := getAPIURL(testnet)

	var state map[string]interface{}
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{
		"type": "clearinghouseState",
		"user": accountAddress,
	}, &state); err != nil {
		return 0, err
	}
	assetPositions, _ := state["assetPositions"].([]interface{})
	for _, ap := range assetPositions {
		apMap, ok := ap.(map[string]interface{})
		if !ok {
			continue
		}
		posMap, ok := apMap["position"].(map[string]interface{})
		if !ok {
			continue
		}
		if posMap["coin"] == coin {
			size := parseFloatStr(posMap["szi"])
			if size != 0 {
				return size, nil
			}
		}
	}
	return 0, fmt.Errorf("position not found for %s", coin)
}

func (h *HyperliquidAdapter) getSzDecimals(ctx context.Context, coin string, testnet bool) (int, error) {
	cacheKey := fmt.Sprintf("%t:%s", testnet, coin)
	var stale *szDecimalEntry
	h.szMu.RLock()
	if cached, ok := h.szCache[cacheKey]; ok {
		if time.Since(cached.time) < szCacheTTL {
			h.szMu.RUnlock()
			return cached.value, nil
		}
		if time.Since(cached.time) < executionMetaRetentionTTL {
			copy := cached
			stale = &copy
		}
	}
	h.szMu.RUnlock()

	apiURL := getAPIURL(testnet)

	cacheValue := func(value int) (int, error) {
		h.szMu.Lock()
		h.szCache[cacheKey] = szDecimalEntry{value: value, time: time.Now()}
		h.szMu.Unlock()
		return value, nil
	}

	if resolveMarketVenue(coin).isBuilderPerp() {
		if value, ok := h.getBuilderSzDecimals(ctx, apiURL, coin); ok {
			if h.builderMetaIsFresh(apiURL, resolveMarketVenue(coin).Dex) {
				return cacheValue(value)
			}
			return value, nil
		}
		if stale != nil {
			return stale.value, nil
		}
		return 0, fmt.Errorf("exchange size metadata unavailable for %s", coin)
	}

	universe := h.getStandardMetaUniverse(ctx, apiURL)
	for _, item := range universe {
		if m, ok := item.(map[string]interface{}); ok {
			if name, ok := m["name"].(string); ok && name == coin {
				if szDec, ok := m["szDecimals"].(float64); ok {
					if h.standardMetaIsFresh(apiURL) {
						return cacheValue(int(szDec))
					}
					return int(szDec), nil
				}
			}
		}
	}
	if stale != nil {
		return stale.value, nil
	}
	return 0, fmt.Errorf("exchange size metadata unavailable for %s", coin)
}

func (h *HyperliquidAdapter) standardMetaIsFresh(apiURL string) bool {
	cacheKey := apiURL + "|standard"
	h.standardMetaMu.RLock()
	entry, ok := h.standardMetaCache[cacheKey]
	h.standardMetaMu.RUnlock()
	return ok && time.Since(entry.time) < szCacheTTL
}

func (h *HyperliquidAdapter) builderMetaIsFresh(apiURL, dex string) bool {
	cacheKey := apiURL + "|" + strings.ToLower(strings.TrimSpace(dex))
	h.xyzMetaMu.RLock()
	entry, ok := h.xyzMetaCache[cacheKey]
	h.xyzMetaMu.RUnlock()
	return ok && time.Since(entry.time) < szCacheTTL
}

func (h *HyperliquidAdapter) getTickSize(ctx context.Context, coin string, testnet bool) float64 {
	cacheKey := fmt.Sprintf("%t:%s", testnet, coin)
	stale := 0.0
	h.tickMu.RLock()
	if cached, ok := h.tickCache[cacheKey]; ok {
		if time.Since(cached.time) < szCacheTTL {
			h.tickMu.RUnlock()
			return cached.value
		}
		if time.Since(cached.time) < executionMetaRetentionTTL {
			stale = cached.value
		}
	}
	h.tickMu.RUnlock()

	apiURL := getAPIURL(testnet)

	cacheValue := func(value float64) float64 {
		if value <= 0 {
			return 0
		}
		h.tickMu.Lock()
		h.tickCache[cacheKey] = tickSizeEntry{value: value, time: time.Now()}
		h.tickMu.Unlock()
		return value
	}

	if resolveMarketVenue(coin).isBuilderPerp() {
		if value := h.getBuilderTickSize(ctx, apiURL, coin); value > 0 {
			return cacheValue(value)
		}
		return stale
	}

	universe := h.getStandardMetaUniverse(ctx, apiURL)
	if universe == nil {
		return stale
	}

	for _, item := range universe {
		if m, ok := item.(map[string]interface{}); ok {
			if name, ok := m["name"].(string); ok && name == coin {
				tick := parseAnyFloat64(m["tickSize"])
				if tick > 0 {
					return cacheValue(tick)
				}
			}
		}
	}
	return stale
}

func (h *HyperliquidAdapter) getStandardMetaUniverse(ctx context.Context, apiURL string) []interface{} {
	cacheKey := apiURL + "|standard"
	var stale []interface{}
	h.standardMetaMu.RLock()
	if entry, ok := h.standardMetaCache[cacheKey]; ok {
		if time.Since(entry.time) < szCacheTTL {
			h.standardMetaMu.RUnlock()
			return entry.universe
		}
		if time.Since(entry.time) < executionMetaRetentionTTL {
			stale = entry.universe
		}
	}
	h.standardMetaMu.RUnlock()

	reqCtx, cancel := context.WithTimeout(ctx, shortTimeout)
	defer cancel()

	var meta map[string]interface{}
	if err := h.postInfoJSON(reqCtx, apiURL, map[string]interface{}{"type": "meta"}, &meta); err != nil {
		return stale
	}

	universe, ok := meta["universe"].([]interface{})
	if !ok {
		return stale
	}

	h.standardMetaMu.Lock()
	h.standardMetaCache[cacheKey] = xyzMetaEntry{universe: universe, time: time.Now()}
	h.standardMetaMu.Unlock()
	return universe
}

// getXyzMetaUniverse returns the parsed universe slice from metaAndAssetCtxs?dex=xyz.
// The result is cached for szCacheTTL so all callers share a single fetch per TTL window.
func (h *HyperliquidAdapter) getXyzMetaUniverse(ctx context.Context, apiURL string) []interface{} {
	return h.getBuilderMetaUniverse(ctx, apiURL, "xyz")
}

func (h *HyperliquidAdapter) getBuilderMetaUniverse(ctx context.Context, apiURL, dex string) []interface{} {
	dex = strings.ToLower(strings.TrimSpace(dex))
	cacheKey := apiURL + "|" + dex
	var stale []interface{}
	h.xyzMetaMu.RLock()
	if entry, ok := h.xyzMetaCache[cacheKey]; ok {
		if time.Since(entry.time) < szCacheTTL {
			h.xyzMetaMu.RUnlock()
			return entry.universe
		}
		if time.Since(entry.time) < executionMetaRetentionTTL {
			stale = entry.universe
		}
	}
	h.xyzMetaMu.RUnlock()

	var respArr []interface{}
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{
		"type": "metaAndAssetCtxs",
		"dex":  dex,
	}, &respArr); err != nil || len(respArr) < 1 {
		return stale
	}
	meta, ok := respArr[0].(map[string]interface{})
	if !ok {
		return stale
	}
	universe, ok := meta["universe"].([]interface{})
	if !ok {
		return stale
	}
	h.xyzMetaMu.Lock()
	h.xyzMetaCache[cacheKey] = xyzMetaEntry{universe: universe, time: time.Now()}
	h.xyzMetaMu.Unlock()
	return universe
}

func (h *HyperliquidAdapter) getBuilderTickSize(ctx context.Context, apiURL, coin string) float64 {
	universe := h.getBuilderMetaUniverse(ctx, apiURL, resolveMarketVenue(coin).Dex)
	for _, item := range universe {
		if m, ok := item.(map[string]interface{}); ok {
			if name, ok := m["name"].(string); ok {
				if name == coin || stripDexPrefix(name) == stripDexPrefix(coin) {
					tick := parseAnyFloat64(m["tickSize"])
					if tick > 0 {
						return tick
					}
				}
			}
		}
	}
	return 0
}

func (h *HyperliquidAdapter) getBuilderSzDecimals(ctx context.Context, apiURL, coin string) (int, bool) {
	universe := h.getBuilderMetaUniverse(ctx, apiURL, resolveMarketVenue(coin).Dex)
	for _, item := range universe {
		if m, ok := item.(map[string]interface{}); ok {
			if name, ok := m["name"].(string); ok {
				if name == coin || stripDexPrefix(name) == stripDexPrefix(coin) {
					if szDec, ok := m["szDecimals"].(float64); ok {
						return int(szDec), true
					}
				}
			}
		}
	}
	return 0, false
}

func (h *HyperliquidAdapter) getAssetIndex(ctx context.Context, apiURL, coin, dex string) int {
	cacheKey := fmt.Sprintf("%s|%s|%s", apiURL, coin, dex)
	stale := -1
	h.assetIndexMu.RLock()
	if cached, ok := h.assetIndexCache[cacheKey]; ok {
		if time.Since(cached.time) < szCacheTTL {
			h.assetIndexMu.RUnlock()
			return cached.value
		}
		if time.Since(cached.time) < executionMetaRetentionTTL {
			stale = cached.value
		}
	}
	h.assetIndexMu.RUnlock()

	// For xyz dex, use the shared meta cache to avoid a redundant fetch alongside
	// getHip3TickSize / getHip3SzDecimals which are always called before this.
	var universe []interface{}
	metadataFresh := true
	if dex == "xyz" {
		universe = h.getXyzMetaUniverse(ctx, apiURL)
		metadataFresh = h.builderMetaIsFresh(apiURL, dex)
	} else {
		var respArr []interface{}
		if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{
			"type": "metaAndAssetCtxs",
			"dex":  dex,
		}, &respArr); err != nil || len(respArr) < 1 {
			return stale
		}
		meta, ok := respArr[0].(map[string]interface{})
		if !ok {
			return stale
		}
		universe, _ = meta["universe"].([]interface{})
	}
	if universe == nil {
		return stale
	}

	result := -1
	for i, item := range universe {
		if m, ok := item.(map[string]interface{}); ok {
			if name, ok := m["name"].(string); ok {
				if name == coin || stripDexPrefix(name) == stripDexPrefix(coin) {
					if dex == "" {
						result = i
					} else {
						dexIndex := h.getPerpDexIndex(ctx, apiURL, dex)
						if dexIndex >= 0 {
							result = encodeBuilderPerpAssetID(dexIndex, i)
						}
					}
					break
				}
			}
		}
	}
	if result >= 0 && metadataFresh {
		h.assetIndexMu.Lock()
		h.assetIndexCache[cacheKey] = assetIndexEntry{value: result, time: time.Now()}
		h.assetIndexMu.Unlock()
	}
	if result < 0 {
		return stale
	}
	return result
}

func (h *HyperliquidAdapter) getPerpDexIndex(ctx context.Context, apiURL, dex string) int {
	cacheKey := fmt.Sprintf("%s|%s", apiURL, dex)
	stale := -1
	h.perpDexMu.RLock()
	if cached, ok := h.perpDexCache[cacheKey]; ok {
		if time.Since(cached.time) < szCacheTTL {
			h.perpDexMu.RUnlock()
			return cached.value
		}
		if time.Since(cached.time) < executionMetaRetentionTTL {
			stale = cached.value
		}
	}
	h.perpDexMu.RUnlock()

	var items []interface{}
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{
		"type": "perpDexs",
	}, &items); err != nil {
		return stale
	}
	for i, item := range items {
		obj, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		name, ok := obj["name"].(string)
		if ok && name == dex {
			h.perpDexMu.Lock()
			h.perpDexCache[cacheKey] = perpDexEntry{value: i, time: time.Now()}
			h.perpDexMu.Unlock()
			return i
		}
	}
	return stale
}

func encodeBuilderPerpAssetID(perpDexIndex, indexInMeta int) int {
	return 100000 + (perpDexIndex * 10000) + indexInMeta
}

func stripDexPrefix(coin string) string {
	if dex := utils.GetDexName(coin); dex != "" {
		return strings.TrimPrefix(coin, dex+":")
	}
	return coin
}

func getAPIURL(testnet bool) string {
	if testnet {
		return testnetAPIURL
	}
	return mainnetAPIURL
}

func validateInfoResponse(statusCode int, body []byte, endpointType interface{}) error {
	bodyText := strings.TrimSpace(string(body))
	typeName, _ := endpointType.(string)
	if statusCode < 200 || statusCode >= 300 {
		return fmt.Errorf("%s http %d: %s", typeName, statusCode, truncateForLog(bodyText))
	}
	if bodyText == "" {
		return fmt.Errorf("%s empty response body", typeName)
	}
	firstChar := bodyText[0]
	if firstChar != '{' && firstChar != '[' {
		return fmt.Errorf("%s non-json response: %s", typeName, truncateForLog(bodyText))
	}
	return nil
}

func truncateForLog(value string) string {
	if len(value) <= 160 {
		return value
	}
	return value[:160] + "..."
}

func parseFloatStr(v interface{}) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case string:
		f, _ := strconv.ParseFloat(val, 64)
		return f
	case int:
		return float64(val)
	}
	return 0
}

func extractAccountValue(summary, account map[string]interface{}) float64 {
	if summary != nil {
		if accountValue := parseFloatStr(summary["accountValue"]); accountValue > 0 {
			return accountValue
		}
	}
	if marginSummary, ok := account["marginSummary"].(map[string]interface{}); ok {
		if accountValue := parseFloatStr(marginSummary["accountValue"]); accountValue > 0 {
			return accountValue
		}
	}
	if crossMarginSummary, ok := account["crossMarginSummary"].(map[string]interface{}); ok {
		if accountValue := parseFloatStr(crossMarginSummary["accountValue"]); accountValue > 0 {
			return accountValue
		}
	}
	return 0
}

func debugExchangeLogsEnabled() bool {
	switch os.Getenv("PEZ_DEBUG_LOGS") {
	case "1", "true", "TRUE", "yes", "YES", "on", "ON":
		return true
	default:
		return false
	}
}

func (h *HyperliquidAdapter) GetAddressFromPrivateKey(ctx context.Context, pk string) (string, error) {
	ecdsaKey, err := h.getOrParseECDSAKey(pk)
	if err != nil {
		return "", err
	}
	return crypto.PubkeyToAddress(ecdsaKey.PublicKey).Hex(), nil
}

// CheckWalletExistsOnExchange checks if the wallet has been initialized on Hyperliquid.
// Returns false if the wallet doesn't exist yet - user needs to deposit funds first.
// Results are cached for 10 minutes to avoid redundant per-order API calls.
func (h *HyperliquidAdapter) CheckWalletExistsOnExchange(ctx context.Context, privateKey string, testnet bool) (bool, string, error) {
	address := accountcache.GetWithFallback()
	if address == "" {
		var err error
		address, err = h.GetAddressFromPrivateKey(ctx, privateKey)
		if err != nil {
			return false, "", err
		}
	}

	cacheKey := fmt.Sprintf("%s:%t", address, testnet)
	h.walletExistsMu.RLock()
	if entry, ok := h.walletExistsCache[cacheKey]; ok && time.Since(entry.time) < walletExistsCacheTTL {
		h.walletExistsMu.RUnlock()
		return entry.exists, address, nil
	}
	h.walletExistsMu.RUnlock()

	apiURL := getAPIURL(testnet)

	// Check perp clearinghouse state. "userState" is not a valid Hyperliquid info type and
	// returns 422; the correct type is "clearinghouseState".
	var clearState map[string]interface{}
	if err := h.postInfoJSON(ctx, apiURL, map[string]interface{}{
		"type": "clearinghouseState",
		"user": address,
	}, &clearState); err != nil {
		return false, "", fmt.Errorf("failed to fetch clearinghouse state: %w", err)
	}

	// accountValue is nested under marginSummary in clearinghouseState, not top-level.
	perpValue := 0.0
	if ms, ok := clearState["marginSummary"].(map[string]interface{}); ok {
		perpValue = parseFloatStr(ms["accountValue"])
	}
	cacheExists := func(v bool) (bool, string, error) {
		h.walletExistsMu.Lock()
		h.walletExistsCache[cacheKey] = walletExistsEntry{exists: v, time: time.Now()}
		h.walletExistsMu.Unlock()
		return v, address, nil
	}

	withdrawable := parseFloatStr(clearState["withdrawable"])
	if perpValue > 0 || withdrawable > 0 {
		return cacheExists(true)
	}

	// Perp balance is zero — also check spot USDC. A wallet that has deposited only to
	// spot (common before first perp trade) still has a valid initialized account.
	var spotState map[string]interface{}
	spotErr := h.postInfoJSON(ctx, apiURL, map[string]interface{}{
		"type": "spotClearinghouseState",
		"user": address,
	}, &spotState)
	if spotErr != nil {
		// 429 or other transient error during the burst of parallel login requests —
		// can't determine spot balance. Be optimistic: perp state succeeded, so the
		// wallet address is reachable on the exchange.
		log.Printf("CheckWalletExistsOnExchange: spot check failed for %s (%v), assuming wallet exists", address, spotErr)
		return true, address, nil // don't cache on transient errors
	}
	if utils.GetSpotUSDCBalance(spotState) > 0 {
		return cacheExists(true)
	}

	// Both perp and spot returned definitive zero — wallet not yet initialized.
	log.Printf("CheckWalletExistsOnExchange: wallet %s has zero balance - user needs to deposit funds on Hyperliquid first", address)
	return cacheExists(false)
}

// WarmUpForKey pre-warms all xyz-related caches at sign-in so the first order
// executes with the same latency as a regular perp order.
// Must be called as a background goroutine — it may take 1-3 seconds.
func (h *HyperliquidAdapter) WarmUpForKey(ctx context.Context, privateKey string, testnet bool) {
	apiURL := getAPIURL(testnet)

	// Pre-warm the default perp meta universe so standard perp tick/size lookups
	// are in-memory on the first order.
	standardUniverse := h.getStandardMetaUniverse(ctx, apiURL)
	for _, item := range standardUniverse {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		name, ok := m["name"].(string)
		if !ok || name == "" {
			continue
		}
		if szDec, ok := m["szDecimals"].(float64); ok {
			szKey := fmt.Sprintf("%t:%s", testnet, name)
			h.szMu.Lock()
			if _, exists := h.szCache[szKey]; !exists {
				h.szCache[szKey] = szDecimalEntry{value: int(szDec), time: time.Now()}
			}
			h.szMu.Unlock()
		}
		tick := parseAnyFloat64(m["tickSize"])
		if tick > 0 {
			tickKey := fmt.Sprintf("%t:%s", testnet, name)
			h.tickMu.Lock()
			if _, exists := h.tickCache[tickKey]; !exists {
				h.tickCache[tickKey] = tickSizeEntry{value: tick, time: time.Now()}
			}
			h.tickMu.Unlock()
		}
	}
	log.Printf("WarmUpForKey: standard meta pre-loaded, %d coins", len(standardUniverse))

	// Pre-warm the shared xyz meta universe (single metaAndAssetCtxs fetch).
	// This pre-populates xyzMetaCache which getHip3TickSize, getHip3SzDecimals, and
	// getAssetIndex all read from — cold-start fetches per order are eliminated.
	universe := h.getXyzMetaUniverse(ctx, apiURL)
	log.Printf("WarmUpForKey: xyz meta pre-loaded, %d coins", len(universe))

	// Walk the universe once to pre-populate szCache, tickCache, and assetIndexCache
	// for every xyz coin. After this, per-order lookups are pure in-memory.
	dexIndex := h.getPerpDexIndex(ctx, apiURL, "xyz")
	for i, item := range universe {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		name, ok := m["name"].(string)
		if !ok || name == "" {
			continue
		}

		// szCache
		if szDec, ok := m["szDecimals"].(float64); ok {
			szKey := fmt.Sprintf("%t:%s", testnet, name)
			h.szMu.Lock()
			if _, exists := h.szCache[szKey]; !exists {
				h.szCache[szKey] = szDecimalEntry{value: int(szDec), time: time.Now()}
			}
			h.szMu.Unlock()
		}

		// tickCache
		tick := parseAnyFloat64(m["tickSize"])
		if tick > 0 {
			tickKey := fmt.Sprintf("%t:%s", testnet, name)
			h.tickMu.Lock()
			if _, exists := h.tickCache[tickKey]; !exists {
				h.tickCache[tickKey] = tickSizeEntry{value: tick, time: time.Now()}
			}
			h.tickMu.Unlock()
		}

		// assetIndexCache
		if dexIndex >= 0 {
			assetIdx := encodeBuilderPerpAssetID(dexIndex, i)
			idxKey := fmt.Sprintf("%s|%s|%s", apiURL, name, "xyz")
			h.assetIndexMu.Lock()
			if _, exists := h.assetIndexCache[idxKey]; !exists {
				h.assetIndexCache[idxKey] = assetIndexEntry{value: assetIdx, time: time.Now()}
			}
			h.assetIndexMu.Unlock()
		}
	}

	// Pre-warm wallet existence check (cached 10 min, skipped per-order after this).
	exists, address, _ := h.CheckWalletExistsOnExchange(ctx, privateKey, testnet)
	log.Printf("WarmUpForKey: wallet check done for %s exists=%v", address, exists)
}
