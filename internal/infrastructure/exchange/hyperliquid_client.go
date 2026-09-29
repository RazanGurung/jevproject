package exchange

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	"hyperliquid-go/internal/infrastructure/hlratelimit"
	"hyperliquid-go/internal/infrastructure/infogovernor"
	"hyperliquid-go/internal/infrastructure/signing"
)

var infoRetryDelays = []time.Duration{150 * time.Millisecond, 500 * time.Millisecond}

func NewHyperliquidAdapter() *HyperliquidAdapter {
	maxActions := defaultMaxSignedActionsInFlight
	if raw := strings.TrimSpace(os.Getenv("PEZ_EXCHANGE_MAX_INFLIGHT")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 100 {
			maxActions = parsed
		}
	}
	return &HyperliquidAdapter{
		actionSem:         make(chan struct{}, maxActions),
		szCache:           make(map[string]szDecimalEntry),
		tickCache:         make(map[string]tickSizeEntry),
		activeAssetCache:  make(map[string]activeAssetEntry),
		portfolioCache:    make(map[string]portfolioEntry),
		openOrdersCache:   make(map[string]openOrdersEntry),
		assetIndexCache:   make(map[string]assetIndexEntry),
		perpDexCache:      make(map[string]perpDexEntry),
		builderStateCache: make(map[string]builderStateEntry),
		standardMetaCache: make(map[string]xyzMetaEntry),
		xyzMetaCache:      make(map[string]xyzMetaEntry),
		assetCtxsCache:    make(map[string]assetCtxsEntry),
		assetCtxsInflight: make(map[string]*assetCtxsFlight),
		walletExistsCache: make(map[string]walletExistsEntry),
		accountModeCache:  make(map[string]accountModeEntry),
		parsedKeyCache:    make(map[string]*ecdsa.PrivateKey),
		httpClient: &http.Client{
			// Limiter wait lives in RoundTrip. A Client.Timeout would include that
			// wait and abort signed actions after nonce assignment. Request
			// contexts (mediumTimeout / accountHotPathTimeout) bound the HTTP call.
			Timeout:   0,
			Transport: hlratelimit.WrapTransport(nil),
		},
	}
}

// StartCacheEviction starts a background goroutine that periodically prunes stale cache entries.
func (h *HyperliquidAdapter) StartCacheEviction(ctx context.Context) {
	h.lifecycleCtx = ctx
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.evictStaleCaches()
			}
		}
	}()
}

func (h *HyperliquidAdapter) backgroundContext() context.Context {
	if h.lifecycleCtx != nil {
		return h.lifecycleCtx
	}
	return context.Background()
}

// evictStaleCaches removes expired entries. Execution metadata is retained
// beyond its refresh TTL so a previously verified value remains available
// during a transient /info outage.
func (h *HyperliquidAdapter) evictStaleCaches() {
	now := time.Now()

	h.szMu.Lock()
	for k, v := range h.szCache {
		if now.Sub(v.time) > executionMetaRetentionTTL {
			delete(h.szCache, k)
		}
	}
	h.szMu.Unlock()

	h.tickMu.Lock()
	for k, v := range h.tickCache {
		if now.Sub(v.time) > executionMetaRetentionTTL {
			delete(h.tickCache, k)
		}
	}
	h.tickMu.Unlock()

	h.activeAssetMu.Lock()
	for k, v := range h.activeAssetCache {
		if now.Sub(v.time) > activeAssetCacheTTL {
			delete(h.activeAssetCache, k)
		}
	}
	h.activeAssetMu.Unlock()

	h.portfolioMu.Lock()
	for k, v := range h.portfolioCache {
		if now.Sub(v.time) > portfolioCacheTTL {
			delete(h.portfolioCache, k)
		}
	}
	h.portfolioMu.Unlock()

	h.openOrdersMu.Lock()
	for k, v := range h.openOrdersCache {
		if now.Sub(v.time) > openOrdersCacheTTL {
			delete(h.openOrdersCache, k)
		}
	}
	h.openOrdersMu.Unlock()

	h.assetIndexMu.Lock()
	for k, v := range h.assetIndexCache {
		if now.Sub(v.time) > executionMetaRetentionTTL {
			delete(h.assetIndexCache, k)
		}
	}
	h.assetIndexMu.Unlock()

	h.perpDexMu.Lock()
	for k, v := range h.perpDexCache {
		if now.Sub(v.time) > executionMetaRetentionTTL {
			delete(h.perpDexCache, k)
		}
	}
	h.perpDexMu.Unlock()

	h.xyzMetaMu.Lock()
	for k, v := range h.xyzMetaCache {
		if now.Sub(v.time) > executionMetaRetentionTTL {
			delete(h.xyzMetaCache, k)
		}
	}
	h.xyzMetaMu.Unlock()

	h.standardMetaMu.Lock()
	for k, v := range h.standardMetaCache {
		if now.Sub(v.time) > executionMetaRetentionTTL {
			delete(h.standardMetaCache, k)
		}
	}
	h.standardMetaMu.Unlock()

	h.walletExistsMu.Lock()
	for k, v := range h.walletExistsCache {
		if now.Sub(v.time) > walletExistsCacheTTL {
			delete(h.walletExistsCache, k)
		}
	}
	h.walletExistsMu.Unlock()

	h.builderStateMu.Lock()
	for k, v := range h.builderStateCache {
		if now.Sub(v.time) > builderStateRetentionTTL {
			delete(h.builderStateCache, k)
		}
	}
	h.builderStateMu.Unlock()

	h.accountModeMu.Lock()
	for k, v := range h.accountModeCache {
		if now.Sub(v.time) > accountModeRetentionTTL {
			delete(h.accountModeCache, k)
		}
	}
	h.accountModeMu.Unlock()
}

// nextNonce returns a strictly monotonic millisecond nonce safe for concurrent signed actions.
func (h *HyperliquidAdapter) nextNonce() int64 {
	h.nonceMu.Lock()
	defer h.nonceMu.Unlock()
	now := time.Now().UnixMilli()
	if now > h.lastNonce {
		h.lastNonce = now
	} else {
		h.lastNonce++
	}
	return h.lastNonce
}

func isRetryableInfoError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, " http 429") ||
		strings.Contains(msg, " http 500") ||
		strings.Contains(msg, " http 502") ||
		strings.Contains(msg, " http 503") ||
		strings.Contains(msg, "empty response body") ||
		strings.Contains(msg, "non-json response") ||
		// Transient network/timeout failures: lets callers serve their last
		// cached value (e.g. GetOpenOrders) instead of erroring during an
		// upstream latency blip.
		strings.Contains(msg, "context deadline exceeded") ||
		strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "unexpected eof")
}

func (h *HyperliquidAdapter) postInfoWithRetry(ctx context.Context, apiURL string, body map[string]interface{}) ([]byte, error) {
	lane := infogovernor.LaneFromContext(ctx, infoLane(body))
	ctx = infogovernor.WithLane(ctx, lane)
	bodyBytes, _ := json.Marshal(body)
	if debugExchangeLogsEnabled() {
		log.Printf("postInfoWithRetry: type=%s body=%s", body["type"], string(bodyBytes))
	}
	var lastErr error

	for attempt := 0; attempt <= len(infoRetryDelays); attempt++ {
		release, err := infogovernor.Acquire(ctx, lane)
		if err != nil {
			return nil, err
		}
		req, _ := http.NewRequestWithContext(ctx, "POST", apiURL+"/info", bytes.NewBuffer(bodyBytes))
		req.Header.Set("Content-Type", "application/json")

		resp, err := h.httpClient.Do(req)
		if err != nil {
			lastErr = err
			if debugExchangeLogsEnabled() {
				log.Printf("postInfoWithRetry: request error: %v", err)
			}
		} else {
			respBody, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if debugExchangeLogsEnabled() {
				log.Printf("postInfoWithRetry: status=%d body=%s", resp.StatusCode, string(respBody[:min(len(respBody), 500)]))
			}
			if err := validateInfoResponse(resp.StatusCode, respBody, body["type"]); err != nil {
				lastErr = err
			} else {
				release()
				return respBody, nil
			}
		}
		release()

		if attempt >= len(infoRetryDelays) || !isRetryableInfoError(lastErr) {
			break
		}

		select {
		case <-time.After(infoRetryDelays[attempt]):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	return nil, lastErr
}

func infoLane(body map[string]interface{}) infogovernor.Lane {
	requestType, _ := body["type"].(string)
	dex, _ := body["dex"].(string)
	switch requestType {
	case "clearinghouseState":
		if dex != "" && dex != "xyz" {
			return infogovernor.Enrichment
		}
		return infogovernor.AccountCore
	case "spotClearinghouseState", "frontendOpenOrders", "webData3", "userFills":
		return infogovernor.AccountCore
	case "portfolio", "perpDexs":
		return infogovernor.Enrichment
	case "meta", "metaAndAssetCtxs", "allMids", "l2Book", "candleSnapshot", "activeAssetData":
		return infogovernor.Enrichment
	default:
		return infogovernor.Execution
	}
}

func (h *HyperliquidAdapter) postInfoJSON(ctx context.Context, apiURL string, body map[string]interface{}, dest interface{}) error {
	respBody, err := h.postInfoWithRetry(ctx, apiURL, body)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(respBody, dest); err != nil {
		return fmt.Errorf("invalid %s response: %w", body["type"], err)
	}
	return nil
}

func (h *HyperliquidAdapter) executeSignedExchangeAction(ctx context.Context, privateKey string, testnet bool, action interface{}) (map[string]interface{}, error) {
	return h.executeSignedExchangeActionExpiring(ctx, privateKey, testnet, action, nil)
}

func (h *HyperliquidAdapter) getOrParseECDSAKey(privateKey string) (*ecdsa.PrivateKey, error) {
	pk := signing.Strip0x(privateKey)
	if len(pk) < 64 {
		return nil, fmt.Errorf("invalid private key length")
	}
	h.parsedKeyMu.RLock()
	cached, ok := h.parsedKeyCache[pk]
	h.parsedKeyMu.RUnlock()
	if ok && cached != nil {
		return cached, nil
	}

	ecdsaKey, err := crypto.HexToECDSA(pk)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	h.parsedKeyMu.Lock()
	if h.parsedKeyCache == nil {
		h.parsedKeyCache = make(map[string]*ecdsa.PrivateKey)
	}
	h.parsedKeyCache[pk] = ecdsaKey
	h.parsedKeyMu.Unlock()
	return ecdsaKey, nil
}

// ClearParsedKeyCache wipes all memoized parsed ECDSA private keys from memory.
func (h *HyperliquidAdapter) ClearParsedKeyCache() {
	h.parsedKeyMu.Lock()
	h.parsedKeyCache = make(map[string]*ecdsa.PrivateKey)
	h.parsedKeyMu.Unlock()
}

// executeSignedExchangeActionExpiring signs and posts an L1 action, optionally
// carrying an expiresAfter deadline (signed into the action hash AND included
// in the payload — the exchange validates both sides agree).
func (h *HyperliquidAdapter) executeSignedExchangeActionExpiring(ctx context.Context, privateKey string, testnet bool, action interface{}, expiresAfter *int64) (map[string]interface{}, error) {
	// Map actions are forbidden: Go map iteration order is random, so their
	// msgpack action hash — and therefore the signature — is nondeterministic
	// and only matches the exchange's canonical field order by luck. Use a
	// typed struct with fields in the schema's insertion order.
	if _, isMap := action.(map[string]interface{}); isMap {
		return nil, fmt.Errorf("signed exchange actions must be typed structs, not maps (nondeterministic msgpack hash)")
	}

	ecdsaKey, err := h.getOrParseECDSAKey(privateKey)
	if err != nil {
		return nil, err
	}

	nonce := h.nextNonce()

	// vaultAddress must be "" for normal user accounts — passing a non-empty value changes
	// the action hash but does not add vaultAddress to the payload, causing the exchange to
	// recover a mismatched signing address and reject the order.
	sig, err := signing.SignL1Action(ecdsaKey, action, "", nonce, expiresAfter, !testnet)
	if err != nil {
		return nil, fmt.Errorf("failed to sign action: %w", err)
	}

	return h.postSignedExchangeActionExpiring(ctx, testnet, action, nonce, sig, expiresAfter)
}

func (h *HyperliquidAdapter) postSignedExchangeActionExpiring(ctx context.Context, testnet bool, action interface{}, nonce int64, sig interface{}, expiresAfter *int64) (map[string]interface{}, error) {
	ctx = infogovernor.WithLane(ctx, infogovernor.Execution)
	actionType := signedActionType(action)
	queuedAt := time.Now()
	select {
	case h.actionSem <- struct{}{}:
		signedActionQueueSeconds.WithLabelValues(actionType).Observe(time.Since(queuedAt).Seconds())
	case <-ctx.Done():
		signedActionQueueSeconds.WithLabelValues(actionType).Observe(time.Since(queuedAt).Seconds())
		return nil, ctx.Err()
	}
	signedActionsInFlight.Inc()
	requestStarted := time.Now()
	resultLabel := "error"
	defer func() {
		signedActionsInFlight.Dec()
		<-h.actionSem
		signedActionRequestSeconds.WithLabelValues(actionType, resultLabel).Observe(time.Since(requestStarted).Seconds())
	}()

	payload := map[string]interface{}{
		"action":    action,
		"nonce":     nonce,
		"signature": sig,
	}
	if expiresAfter != nil {
		payload["expiresAfter"] = *expiresAfter
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal exchange payload: %w", err)
	}

	apiURL := getAPIURL(testnet)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/exchange", bytes.NewBuffer(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exchange request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read exchange response: %w", err)
	}

	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		// The request may already have been accepted, so signed mutations are
		// never replayed automatically. Return the ambiguous outcome for the
		// caller's client-order-id/account reconciliation path.
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		actionSummary := summarizeSignedAction(action)
		responseText := strings.TrimSpace(string(respBody))
		log.Printf("executeSignedExchangeAction: non-2xx status=%d action=%s body=%s", resp.StatusCode, actionSummary, responseText)
		if responseText != "" {
			return nil, fmt.Errorf("http %d: %s", resp.StatusCode, responseText)
		}
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to decode exchange response: %w", err)
	}

	resultLabel = "ok"
	return result, nil
}

func signedActionType(action interface{}) string {
	switch value := action.(type) {
	case OrderAction:
		return value.Type
	case CancelAction:
		return value.Type
	case CancelByCloidAction:
		return value.Type
	case ModifyAction:
		return value.Type
	case BatchModifyAction:
		return value.Type
	case ScheduleCancelAction:
		return value.Type
	case UpdateLeverageAction:
		return value.Type
	case UpdateIsolatedMarginAction:
		return value.Type
	case twapOrderAction:
		return value.Type
	case twapCancelAction:
		return value.Type
	default:
		return fmt.Sprintf("%T", action)
	}
}

func summarizeSignedAction(action interface{}) string {
	switch value := action.(type) {
	case OrderAction:
		firstOrder := map[string]interface{}{}
		if len(value.Orders) > 0 {
			firstOrder = map[string]interface{}{
				"asset":      value.Orders[0].Asset,
				"isBuy":      value.Orders[0].IsBuy,
				"limitPx":    value.Orders[0].LimitPx,
				"size":       value.Orders[0].Size,
				"reduceOnly": value.Orders[0].ReduceOnly,
				"hasTrigger": value.Orders[0].OrderType.Trigger != nil,
				"hasLimit":   value.Orders[0].OrderType.Limit != nil,
			}
		}
		return fmt.Sprintf("type=%s dex=%s grouping=%s firstOrder=%v", value.Type, value.Dex, value.Grouping, firstOrder)
	default:
		body, err := json.Marshal(value)
		if err != nil {
			return fmt.Sprintf("%T", action)
		}
		return truncateForLog(string(body))
	}
}

func summarizeExchangeResult(result interface{}) string {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Sprintf("%T", result)
	}
	return truncateForLog(strings.TrimSpace(string(body)))
}
