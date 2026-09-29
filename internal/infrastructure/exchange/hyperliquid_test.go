package exchange

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/infrastructure/infogovernor"
)

func TestPlaceOrderDoesNotReplayAmbiguousTransportFailure(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	var exchangeCalls atomic.Int32
	var submittedCloid string
	adapter.httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/exchange") {
			exchangeCalls.Add(1)
			var payload struct {
				Action struct {
					Orders []struct {
						Cloid string `json:"c"`
					} `json:"orders"`
				} `json:"action"`
			}
			body, _ := io.ReadAll(req.Body)
			_ = json.Unmarshal(body, &payload)
			if len(payload.Action.Orders) == 1 {
				submittedCloid = payload.Action.Orders[0].Cloid
			}
			// Model the dangerous case: the remote side committed the order but
			// the client lost the response. The adapter must return ambiguity to
			// reconciliation, never emit another signed order.
			return nil, errors.New("timeout after remote commit")
		}
		return nil, errors.New("unexpected request")
	})}

	now := time.Now()
	adapter.szCache["false:BTC"] = szDecimalEntry{value: 5, time: now}
	adapter.tickCache["false:BTC"] = tickSizeEntry{value: 1, time: now}
	adapter.assetIndexCache[mainnetAPIURL+"|BTC|"] = assetIndexEntry{value: 0, time: now}

	_, err := adapter.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         100,
		LimitPx:    64000,
		Mainnet:    true,
	})
	if err == nil || !strings.Contains(err.Error(), "timeout after remote commit") {
		t.Fatalf("expected ambiguous transport error, got %v", err)
	}
	if got := exchangeCalls.Load(); got != 1 {
		t.Fatalf("ambiguous signed action was replayed: calls=%d", got)
	}
	if _, err := normalizeCloid(submittedCloid); err != nil {
		t.Fatalf("order did not carry a valid generated cloid %q: %v", submittedCloid, err)
	}
}

func TestPlaceStandardMarketOrderPreservesReduceOnlyWireFlag(t *testing.T) {
	for _, reduceOnly := range []bool{false, true} {
		t.Run(fmt.Sprintf("reduceOnly=%t", reduceOnly), func(t *testing.T) {
			adapter := NewHyperliquidAdapter()
			var captured struct {
				Action struct {
					Orders []struct {
						ReduceOnly bool `json:"r"`
						OrderType  struct {
							Limit *struct {
								Tif string `json:"tif"`
							} `json:"limit"`
						} `json:"t"`
					} `json:"orders"`
				} `json:"action"`
			}
			adapter.httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if !strings.HasSuffix(req.URL.Path, "/exchange") {
					return nil, fmt.Errorf("unexpected request path %s", req.URL.Path)
				}
				body, err := io.ReadAll(req.Body)
				if err != nil {
					return nil, err
				}
				if err := json.Unmarshal(body, &captured); err != nil {
					return nil, err
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(`{"status":"ok"}`)),
					Header:     make(http.Header),
				}, nil
			})}

			now := time.Now()
			adapter.PrimeMids(map[string]float64{"BTC": 64000})
			adapter.szCache["false:BTC"] = szDecimalEntry{value: 5, time: now}
			adapter.tickCache["false:BTC"] = tickSizeEntry{value: 1, time: now}
			adapter.assetIndexCache[mainnetAPIURL+"|BTC|"] = assetIndexEntry{value: 0, time: now}

			_, err := adapter.PlaceOrder(context.Background(), models.OrderRequest{
				PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
				Coin:       "BTC",
				IsBuy:      false,
				Sz:         100,
				ReduceOnly: reduceOnly,
				Mainnet:    true,
			})
			if err != nil {
				t.Fatalf("PlaceOrder returned error: %v", err)
			}
			if len(captured.Action.Orders) != 1 {
				t.Fatalf("expected one wire order, got %d", len(captured.Action.Orders))
			}
			wire := captured.Action.Orders[0]
			if wire.ReduceOnly != reduceOnly {
				t.Fatalf("wire reduceOnly=%t, want %t", wire.ReduceOnly, reduceOnly)
			}
			if wire.OrderType.Limit == nil || wire.OrderType.Limit.Tif != string(TifIoc) {
				t.Fatalf("market wire must remain IOC, got %#v", wire.OrderType)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestHip3OrderActionOmitsDexField(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.assetIndexCache[mainnetAPIURL+"|xyz:CL|xyz"] = assetIndexEntry{value: 110029, time: time.Now()}
	adapter.szCache["false:xyz:CL"] = szDecimalEntry{value: 2, time: time.Now()}

	req := models.OrderRequest{
		Coin:    "xyz:CL",
		IsBuy:   true,
		LimitPx: 112.98,
	}

	action, err := adapter.hip3OrderAction(context.Background(), req, 112.98, 6.019, false)
	if err != nil {
		t.Fatalf("hip3OrderAction returned error: %v", err)
	}

	if action.Dex != "" {
		t.Fatalf("expected HIP-3 order action dex to be omitted, got %q", action.Dex)
	}

	body, err := json.Marshal(action)
	if err != nil {
		t.Fatalf("failed to marshal action: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("failed to unmarshal action: %v", err)
	}

	if _, ok := decoded["dex"]; ok {
		t.Fatalf("expected marshaled HIP-3 action to omit dex field, got %s", string(body))
	}

	if decoded["type"] != "order" {
		t.Fatalf("expected type=order, got %#v", decoded["type"])
	}
	if decoded["grouping"] != "na" {
		t.Fatalf("expected grouping=na, got %#v", decoded["grouping"])
	}
}

func TestHip3BulkOrderActionOmitsDexFieldAndBuildsMultipleOrders(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.assetIndexCache[mainnetAPIURL+"|xyz:CL|xyz"] = assetIndexEntry{value: 110029, time: time.Now()}
	adapter.szCache["false:xyz:CL"] = szDecimalEntry{value: 2, time: time.Now()}

	reqs := []models.OrderRequest{
		{
			Coin:    "xyz:CL",
			IsBuy:   true,
			LimitPx: 112.98,
		},
		{
			Coin:  "xyz:CL",
			IsBuy: true,
		},
	}

	action, err := adapter.hip3BulkOrderAction(
		context.Background(),
		reqs,
		[]float64{112.98, 112.75},
		[]float64{6.019, 6.031},
		false,
	)
	if err != nil {
		t.Fatalf("hip3BulkOrderAction returned error: %v", err)
	}

	if action.Dex != "" {
		t.Fatalf("expected HIP-3 bulk order action dex to be omitted, got %q", action.Dex)
	}
	if len(action.Orders) != 2 {
		t.Fatalf("expected 2 orders, got %d", len(action.Orders))
	}
	if action.Orders[0].OrderType.Limit == nil || action.Orders[0].OrderType.Limit.Tif != "Gtc" {
		t.Fatalf("expected first HIP-3 bulk order to be GTC limit, got %#v", action.Orders[0].OrderType)
	}
	if action.Orders[1].OrderType.Limit == nil || action.Orders[1].OrderType.Limit.Tif != "Ioc" {
		t.Fatalf("expected second HIP-3 bulk order to be IOC market-style, got %#v", action.Orders[1].OrderType)
	}

	body, err := json.Marshal(action)
	if err != nil {
		t.Fatalf("failed to marshal bulk action: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("failed to unmarshal bulk action: %v", err)
	}

	if _, ok := decoded["dex"]; ok {
		t.Fatalf("expected marshaled HIP-3 bulk action to omit dex field, got %s", string(body))
	}
}

func TestPlaceHip3BulkOrdersReturnsFlatExchangeError(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body := `{"status":"err","response":"User or API Wallet 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa does not exist."}`
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	}

	now := time.Now()
	adapter.szCache["false:xyz:CL"] = szDecimalEntry{value: 3, time: now}
	adapter.tickCache["false:xyz:CL"] = tickSizeEntry{value: 0.001, time: now}
	adapter.assetIndexCache[mainnetAPIURL+"|xyz:CL|xyz"] = assetIndexEntry{value: 110029, time: now}

	orders := []models.OrderRequest{
		{
			PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
			Coin:       "xyz:CL",
			IsBuy:      true,
			Sz:         10,
			LimitPx:    95.25,
		},
		{
			PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
			Coin:       "xyz:CL",
			IsBuy:      true,
			Sz:         10,
			LimitPx:    95.20,
		},
	}

	_, err := adapter.placeHip3BulkOrders(context.Background(), orders, []float64{95.25, 95.20}, []float64{0.105, 0.105}, false)
	if err == nil {
		t.Fatal("expected HIP-3 bulk order error")
	}
	if !strings.Contains(err.Error(), "User or API Wallet") {
		t.Fatalf("expected exchange wallet error, got %v", err)
	}
}

func TestPlaceHip3BulkOrdersReturnsPerOrderStatuses(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body := `{"status":"ok","response":{"type":"order","data":{"statuses":[{"resting":{"oid":1}},{"resting":{"oid":2}}]}}}`
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	}

	now := time.Now()
	adapter.szCache["false:xyz:CL"] = szDecimalEntry{value: 3, time: now}
	adapter.tickCache["false:xyz:CL"] = tickSizeEntry{value: 0.001, time: now}
	adapter.assetIndexCache[mainnetAPIURL+"|xyz:CL|xyz"] = assetIndexEntry{value: 110029, time: now}

	orders := []models.OrderRequest{
		{
			PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
			Coin:       "xyz:CL",
			IsBuy:      true,
			Sz:         10,
			LimitPx:    95.25,
		},
		{
			PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
			Coin:       "xyz:CL",
			IsBuy:      true,
			Sz:         10,
			LimitPx:    95.20,
		},
	}

	results, err := adapter.placeHip3BulkOrders(context.Background(), orders, []float64{95.25, 95.20}, []float64{0.105, 0.105}, false)
	if err != nil {
		t.Fatalf("expected no HIP-3 bulk error, got %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 per-order statuses, got %d", len(results))
	}
}

func TestPlaceHip3BulkOrdersReturnsMixedPerOrderStatuses(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body := `{"status":"ok","response":{"type":"order","data":{"statuses":[{"error":"Order must have minimum value of $10."},{"resting":{"oid":2}}]}}}`
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	}

	now := time.Now()
	adapter.szCache["false:xyz:CL"] = szDecimalEntry{value: 3, time: now}
	adapter.tickCache["false:xyz:CL"] = tickSizeEntry{value: 0.001, time: now}
	adapter.assetIndexCache[mainnetAPIURL+"|xyz:CL|xyz"] = assetIndexEntry{value: 110029, time: now}

	orders := []models.OrderRequest{
		{
			PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
			Coin:       "xyz:CL",
			IsBuy:      true,
			Sz:         10,
			LimitPx:    95.25,
		},
		{
			PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
			Coin:       "xyz:CL",
			IsBuy:      true,
			Sz:         10,
			LimitPx:    95.20,
		},
	}

	results, err := adapter.placeHip3BulkOrders(context.Background(), orders, []float64{95.25, 95.20}, []float64{0.105, 0.105}, false)
	if err != nil {
		t.Fatalf("expected mixed HIP-3 statuses to return, got %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 per-order statuses, got %d", len(results))
	}
	first, _ := results[0].(map[string]interface{})
	if first["error"] == nil {
		t.Fatalf("expected first status error, got %#v", results[0])
	}
	second, _ := results[1].(map[string]interface{})
	if second["resting"] == nil {
		t.Fatalf("expected second status resting, got %#v", results[1])
	}
}

func TestExtractExchangeStatusErrorHandlesTopLevelError(t *testing.T) {
	errText := extractExchangeStatusError(map[string]interface{}{
		"error": "http 422: Failed to deserialize the JSON body into the target type",
	})
	if !strings.Contains(errText, "Failed to deserialize") {
		t.Fatalf("expected top-level error text, got %q", errText)
	}
}

func TestPlaceHip3BulkOrdersRejectsClearlyStalePriceBand(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	adapter.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			body := `[{"universe":[{"name":"xyz:GOLD","szDecimals":4}], [{"markPx":"4715.8"}]}]`
			if strings.Contains(req.URL.Path, "/info") {
				body = `[{"universe":[{"name":"xyz:GOLD","szDecimals":4}]},[{"markPx":"4715.8"}]]`
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	}

	now := time.Now()
	adapter.szCache["false:xyz:GOLD"] = szDecimalEntry{value: 4, time: now}
	adapter.tickCache["false:xyz:GOLD"] = tickSizeEntry{value: 0.1, time: now}
	adapter.assetIndexCache[mainnetAPIURL+"|xyz:GOLD|xyz"] = assetIndexEntry{value: 110003, time: now}

	orders := []models.OrderRequest{
		{
			PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
			Coin:       "xyz:GOLD",
			IsBuy:      true,
			Sz:         12,
			LimitPx:    220.07,
		},
	}

	_, err := adapter.placeHip3BulkOrders(context.Background(), orders, []float64{220.07}, []float64{0.0681}, false)
	if err == nil {
		t.Fatal("expected stale xyz ladder error")
	}
	if !strings.Contains(err.Error(), "look stale or mismatched") {
		t.Fatalf("expected stale ladder validation error, got %v", err)
	}
}

func TestAggressiveMarketPrice(t *testing.T) {
	adapter := NewHyperliquidAdapter()

	if got := adapter.aggressiveMarketPrice(true, 100); got != 101 {
		t.Fatalf("expected buy market price 101, got %v", got)
	}
	if got := adapter.aggressiveMarketPrice(false, 100); got != 99 {
		t.Fatalf("expected sell market price 99, got %v", got)
	}
}

func TestNormalizePerpPriceUsesSigFigsAndSzDecimals(t *testing.T) {
	if got := normalizePerpPrice(6831.438, 3); got != 6831.4 {
		t.Fatalf("expected normalized price 6831.4, got %v", got)
	}
	if got := normalizePerpPrice(4758.312, 4); got != 4758.3 {
		t.Fatalf("expected normalized price 4758.3, got %v", got)
	}
}

func TestFormatPerpWirePriceTrimsTrailingZeros(t *testing.T) {
	if got := formatPerpWirePrice(180.260, 3); got != "180.26" {
		t.Fatalf("expected trimmed price 180.26, got %q", got)
	}
	if got := formatPerpWirePrice(24822.0, 4); got != "24822" {
		t.Fatalf("expected integer price 24822, got %q", got)
	}
}

func TestFormatWireSizeTrimsTrailingZeros(t *testing.T) {
	if got := formatWireSize(0.160000, 2); got != "0.16" {
		t.Fatalf("expected trimmed size 0.16, got %q", got)
	}
	if got := formatWireSize(4.300000, 1); got != "4.3" {
		t.Fatalf("expected trimmed size 4.3, got %q", got)
	}
}

func TestStandardMetaUniverseCachesTickAndSzLookups(t *testing.T) {
	var metaCalls int32
	adapter := NewHyperliquidAdapter()
	adapter.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if strings.HasSuffix(req.URL.Path, "/info") {
				bodyBytes, _ := io.ReadAll(req.Body)
				var body map[string]any
				_ = json.Unmarshal(bodyBytes, &body)
				if body["type"] == "meta" {
					atomic.AddInt32(&metaCalls, 1)
					payload := `{"universe":[{"name":"BTC","szDecimals":5,"tickSize":"1"}]}`
					return &http.Response{
						StatusCode: http.StatusOK,
						Body:       io.NopCloser(strings.NewReader(payload)),
						Header:     make(http.Header),
					}, nil
				}
			}
			return &http.Response{
				StatusCode: http.StatusNotFound,
				Body:       io.NopCloser(strings.NewReader(`{}`)),
				Header:     make(http.Header),
			}, nil
		}),
	}

	got, err := adapter.getSzDecimals(context.Background(), "BTC", false)
	if err != nil {
		t.Fatalf("getSzDecimals: %v", err)
	}
	if got != 5 {
		t.Fatalf("expected BTC szDecimals 5, got %d", got)
	}
	if got := adapter.getTickSize(context.Background(), "BTC", false); got != 1 {
		t.Fatalf("expected BTC tick size 1, got %v", got)
	}
	if atomic.LoadInt32(&metaCalls) != 1 {
		t.Fatalf("expected 1 standard meta fetch, got %d", atomic.LoadInt32(&metaCalls))
	}
}

func TestSzDecimalsFailsClosedWithoutVerifiedMetadata(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := adapter.getSzDecimals(ctx, "BTC", false); err == nil {
		t.Fatal("expected unavailable metadata to fail closed")
	}
	if len(adapter.szCache) != 0 {
		t.Fatalf("expected no guessed metadata to be cached, got %d entries", len(adapter.szCache))
	}
}

func TestSzDecimalsUsesRetainedVerifiedMetadataDuringRefreshFailure(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	cacheKey := "false:BTC"
	adapter.szCache[cacheKey] = szDecimalEntry{
		value: 5,
		time:  time.Now().Add(-szCacheTTL - time.Minute),
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	got, err := adapter.getSzDecimals(ctx, "BTC", false)
	if err != nil {
		t.Fatalf("expected retained metadata, got %v", err)
	}
	if got != 5 {
		t.Fatalf("expected retained BTC szDecimals 5, got %d", got)
	}
	if adapter.szCache[cacheKey].time.After(time.Now().Add(-szCacheTTL)) {
		t.Fatal("retained metadata must not be relabeled as freshly verified")
	}
}

func TestSzDecimalsDoesNotRelabelRetainedUniverseAsFresh(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	metaKey := mainnetAPIURL + "|standard"
	adapter.standardMetaCache[metaKey] = xyzMetaEntry{
		universe: []interface{}{
			map[string]interface{}{"name": "BTC", "szDecimals": float64(5)},
		},
		time: time.Now().Add(-szCacheTTL - time.Minute),
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	got, err := adapter.getSzDecimals(ctx, "BTC", false)
	if err != nil {
		t.Fatalf("expected retained universe metadata, got %v", err)
	}
	if got != 5 {
		t.Fatalf("expected retained BTC szDecimals 5, got %d", got)
	}
	if len(adapter.szCache) != 0 {
		t.Fatal("retained universe metadata must not be cached with a fresh timestamp")
	}
	if adapter.standardMetaCache[metaKey].time.After(time.Now().Add(-szCacheTTL)) {
		t.Fatal("retained universe must not be relabeled as freshly verified")
	}
}

func TestRoundNotionalToCoinSizeRoundsDownToAllowedIncrement(t *testing.T) {
	got := roundNotionalToCoinSize(680, 112.98, 3)
	if got != 6.018 {
		t.Fatalf("expected rounded size 6.018, got %v", got)
	}
}

func TestRoundOrderNotionalToCoinSizePreservesMinimumOpenNotional(t *testing.T) {
	got := roundOrderNotionalToCoinSize(10, 67336, 5, true)
	if got != 0.00015 {
		t.Fatalf("expected rounded size 0.00015, got %v", got)
	}
}

func TestRoundOrderNotionalToCoinSizeKeepsReduceOnlyRoundedDown(t *testing.T) {
	got := roundOrderNotionalToCoinSize(10, 67336, 5, false)
	if got != 0.00014 {
		t.Fatalf("expected rounded size 0.00014, got %v", got)
	}
}

func TestEncodeBuilderPerpAssetID(t *testing.T) {
	got := encodeBuilderPerpAssetID(1, 0)
	if got != 110000 {
		t.Fatalf("expected asset id 110000, got %d", got)
	}
}

func TestExtractExchangeStatusError(t *testing.T) {
	tests := []struct {
		name     string
		response map[string]interface{}
		expected string
	}{
		{
			name:     "nil response",
			response: nil,
			expected: "",
		},
		{
			name:     "empty response",
			response: map[string]interface{}{},
			expected: "",
		},
		{
			name: "flat error shape",
			response: map[string]interface{}{
				"status":   "err",
				"response": "User or API Wallet does not exist",
			},
			expected: "User or API Wallet does not exist",
		},
		{
			name: "nested error in statuses",
			response: map[string]interface{}{
				"response": map[string]interface{}{
					"type": "order",
					"data": map[string]interface{}{
						"statuses": []interface{}{
							map[string]interface{}{"error": "insufficient margin"},
						},
					},
				},
			},
			expected: "insufficient margin",
		},
		{
			name: "direct data statuses error",
			response: map[string]interface{}{
				"data": map[string]interface{}{
					"statuses": []interface{}{
						map[string]interface{}{"error": "order too small"},
					},
				},
			},
			expected: "order too small",
		},
		{
			name: "no error in statuses",
			response: map[string]interface{}{
				"data": map[string]interface{}{
					"statuses": []interface{}{
						map[string]interface{}{"oid": 12345},
					},
				},
			},
			expected: "",
		},
		{
			name: "capitalized Error field",
			response: map[string]interface{}{
				"data": map[string]interface{}{
					"statuses": []interface{}{
						map[string]interface{}{"Error": "SOME ERROR"},
					},
				},
			},
			expected: "SOME ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractExchangeStatusError(tt.response)
			if got != tt.expected {
				t.Errorf("extractExchangeStatusError() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestExtractExchangeStatuses(t *testing.T) {
	tests := []struct {
		name     string
		response map[string]interface{}
		wantLen  int
		wantOk   bool
	}{
		{
			name:     "nil response",
			response: nil,
			wantLen:  0,
			wantOk:   false,
		},
		{
			name: "response wrapper path",
			response: map[string]interface{}{
				"response": map[string]interface{}{
					"data": map[string]interface{}{
						"statuses": []interface{}{
							map[string]interface{}{"oid": 1},
							map[string]interface{}{"oid": 2},
						},
					},
				},
			},
			wantLen: 2,
			wantOk:  true,
		},
		{
			name: "direct data path",
			response: map[string]interface{}{
				"data": map[string]interface{}{
					"statuses": []interface{}{
						map[string]interface{}{"oid": 1},
					},
				},
			},
			wantLen: 1,
			wantOk:  true,
		},
		{
			name: "missing statuses",
			response: map[string]interface{}{
				"data": map[string]interface{}{},
			},
			wantLen: 0,
			wantOk:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			statuses, ok := extractExchangeStatuses(tt.response)
			if ok != tt.wantOk {
				t.Errorf("extractExchangeStatuses() ok = %v, want %v", ok, tt.wantOk)
			}
			if len(statuses) != tt.wantLen {
				t.Errorf("extractExchangeStatuses() len = %d, want %d", len(statuses), tt.wantLen)
			}
		})
	}
}

func TestInfoLaneClassifiesMarketReadsAsEnrichment(t *testing.T) {
	for _, typ := range []string{"meta", "metaAndAssetCtxs", "allMids", "l2Book", "candleSnapshot", "activeAssetData"} {
		if got := infoLane(map[string]interface{}{"type": typ}); got != infogovernor.Enrichment {
			t.Fatalf("%s lane = %v, want Enrichment", typ, got)
		}
	}
	if got := infoLane(map[string]interface{}{"type": "clearinghouseState"}); got != infogovernor.AccountCore {
		t.Fatalf("clearinghouseState lane = %v, want AccountCore", got)
	}
}

func TestPlaceOrderPostOnlyTifAlo(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	var capturedTif string
	adapter.httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/exchange") {
			var payload struct {
				Action struct {
					Orders []struct {
						OrderType struct {
							Limit *struct {
								Tif string `json:"tif"`
							} `json:"limit"`
						} `json:"t"`
					} `json:"orders"`
				} `json:"action"`
			}
			body, _ := io.ReadAll(req.Body)
			_ = json.Unmarshal(body, &payload)
			if len(payload.Action.Orders) > 0 && payload.Action.Orders[0].OrderType.Limit != nil {
				capturedTif = payload.Action.Orders[0].OrderType.Limit.Tif
			}
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader(`{"status":"ok","response":{"type":"order","data":{"statuses":[{"resting":{"oid":1}}]}}}`)),
			}, nil
		}
		return nil, errors.New("unexpected request")
	})}

	now := time.Now()
	adapter.szCache["false:BTC"] = szDecimalEntry{value: 5, time: now}
	adapter.tickCache["false:BTC"] = tickSizeEntry{value: 1, time: now}
	adapter.assetIndexCache[mainnetAPIURL+"|BTC|"] = assetIndexEntry{value: 0, time: now}

	_, err := adapter.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: "1111111111111111111111111111111111111111111111111111111111111111",
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         100,
		LimitPx:    64000,
		PostOnly:   true,
		Mainnet:    true,
	})
	if err != nil {
		t.Fatalf("PlaceOrder post-only failed: %v", err)
	}
	if capturedTif != "Alo" {
		t.Fatalf("capturedTif = %q, want Alo", capturedTif)
	}
}

func TestClearParsedKeyCache(t *testing.T) {
	adapter := NewHyperliquidAdapter()
	pk := "1111111111111111111111111111111111111111111111111111111111111111"
	key1, err := adapter.getOrParseECDSAKey(pk)
	if err != nil || key1 == nil {
		t.Fatalf("getOrParseECDSAKey failed: %v", err)
	}
	if len(adapter.parsedKeyCache) != 1 {
		t.Fatalf("expected 1 cached key, got %d", len(adapter.parsedKeyCache))
	}
	adapter.ClearParsedKeyCache()
	if len(adapter.parsedKeyCache) != 0 {
		t.Fatalf("expected empty cache after clear, got %d", len(adapter.parsedKeyCache))
	}
}
