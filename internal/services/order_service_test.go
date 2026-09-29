package services

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"hyperliquid-go/internal/accountcache"
	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/services/testutil"
)

// waitForTriggerOrders polls until at least `want` trigger orders have been
// captured (TP/SL protection is now attached asynchronously after an immediate
// fill) and returns a safe snapshot for assertions.
func waitForTriggerOrders(t *testing.T, mu *sync.Mutex, reqs *[]models.TriggerOrderRequest, want int) []models.TriggerOrderRequest {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(*reqs)
		if n >= want {
			snapshot := append([]models.TriggerOrderRequest(nil), (*reqs)...)
			mu.Unlock()
			return snapshot
		}
		mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("expected %d trigger orders, got %d within timeout", want, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPlaceOrderForwardsLimitBuyAndSellRequestsToExchange(t *testing.T) {
	mockExchange := testutil.NewMockExchange()
	captured := make([]models.OrderRequest, 0, 2)
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		captured = append(captured, req)
		return map[string]interface{}{"resting": map[string]interface{}{"oid": 1}}, nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		NewAccountRuntime(),
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         680,
		LimitPx:    50000.25,
	})
	if err != nil {
		t.Fatalf("buy PlaceOrder returned error: %v", err)
	}

	_, err = service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "BTC",
		IsBuy:      false,
		Sz:         680,
		LimitPx:    50000.25,
	})
	if err != nil {
		t.Fatalf("sell PlaceOrder returned error: %v", err)
	}

	if len(captured) != 2 {
		t.Fatalf("expected 2 forwarded orders, got %d", len(captured))
	}
	if !captured[0].IsBuy || captured[0].LimitPx != 50000.25 {
		t.Fatalf("expected first forwarded order to be buy @ 50000.25, got %+v", captured[0])
	}
	if captured[1].IsBuy || captured[1].LimitPx != 50000.25 {
		t.Fatalf("expected second forwarded order to be sell @ 50000.25, got %+v", captured[1])
	}
}

func TestPlaceOrderRegistersAcceptedOrderInAccountRuntime(t *testing.T) {
	mockExchange := testutil.NewMockExchange()
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(77)}}, nil
	}

	runtime := NewAccountRuntime()
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		runtime,
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         680,
		LimitPx:    50000.25,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	address, err := service.extractAddress(privateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}

	snapshot := runtime.GetSnapshot(address)
	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected 1 runtime order, got %d", len(snapshot.Orders))
	}
	order := snapshot.Orders[0].(map[string]interface{})
	if order["coin"] != "BTC" || order["oid"] != int64(77) {
		t.Fatalf("unexpected runtime order: %+v", order)
	}
}

func TestPlaceOrderUsesCachedTradingAccountForRuntimeOwnership(t *testing.T) {
	t.Chdir(t.TempDir())
	accountcache.Cache("0x1111111111111111111111111111111111111111")
	defer accountcache.Clear()

	mockExchange := testutil.NewMockExchange()
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(88)}}, nil
	}

	runtime := NewAccountRuntime()
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		runtime,
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "xyz:CL",
		IsBuy:      true,
		Sz:         10,
		LimitPx:    95.25,
		TpPct:      1,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	snapshot := runtime.GetSnapshot("0x1111111111111111111111111111111111111111")
	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected 1 runtime order for cached trading account, got %d", len(snapshot.Orders))
	}

	service.protectMu.Lock()
	defer service.protectMu.Unlock()
	protected := service.protectionByID["0x1111111111111111111111111111111111111111"]
	if len(protected) != 1 {
		t.Fatalf("expected protection to be registered for cached trading account, got %d entries", len(protected))
	}
}

func TestBuildScalePreviewGeneratesBackendOwnedLadder(t *testing.T) {
	service := NewOrderService(
		testutil.NewMockExchange(),
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		NewAccountRuntime(),
	)
	service.metadataCache.SetTickSize("BTC", 1)

	resp, err := service.BuildScalePreview(context.Background(), models.ScalePreviewRequest{
		Coin:      "BTC",
		IsBuy:     true,
		TotalUsd:  1000,
		NumOrders: 2,
		LowPx:     69000,
		HighPx:    71000,
		Mainnet:   true,
	})
	if err != nil {
		t.Fatalf("BuildScalePreview returned error: %v", err)
	}
	if len(resp.Orders) != 2 {
		t.Fatalf("expected 2 scale orders, got %d", len(resp.Orders))
	}
	if resp.Orders[0].LimitPx != 69000 || resp.Orders[1].LimitPx != 71000 {
		t.Fatalf("unexpected ladder prices: %+v", resp.Orders)
	}
	if resp.Orders[0].Sz != 500 || resp.Orders[1].Sz != 500 {
		t.Fatalf("unexpected ladder sizes: %+v", resp.Orders)
	}
}

func TestBulkCancelRemovesOrdersFromAccountRuntime(t *testing.T) {
	mockExchange := testutil.NewMockExchange()
	mockExchange.CancelOrderFunc = func(address, coin string, oid int64, testnet bool) error {
		return nil
	}

	runtime := NewAccountRuntime()
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		runtime,
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	address, err := service.extractAddress(privateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}
	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(101), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(202), "coin": "ETH", "limitPx": "3000"},
	}, true)

	cancelled, err := service.BulkCancel(context.Background(), models.BulkCancelRequest{
		PrivateKey: privateKey,
		Cancels: []map[string]interface{}{
			{"coin": "BTC", "oid": float64(101)},
		},
	})
	if err != nil {
		t.Fatalf("BulkCancel returned error: %v", err)
	}
	if len(cancelled) != 1 || cancelled[0] != 101 {
		t.Fatalf("expected cancelled oids [101], got %v", cancelled)
	}

	snapshot := runtime.GetSnapshot(address)
	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected 1 remaining runtime order, got %d", len(snapshot.Orders))
	}
	order := snapshot.Orders[0].(map[string]interface{})
	if order["coin"] != "ETH" {
		t.Fatalf("unexpected remaining runtime order: %+v", order)
	}
}

func TestEnsureOrderCloidGeneratesUniqueWireIds(t *testing.T) {
	var a, b models.OrderRequest
	if err := ensureOrderCloid(&a); err != nil {
		t.Fatalf("ensureOrderCloid a: %v", err)
	}
	if err := ensureOrderCloid(&b); err != nil {
		t.Fatalf("ensureOrderCloid b: %v", err)
	}
	if a.Cloid == "" || !strings.HasPrefix(a.Cloid, "0x") || len(a.Cloid) != 34 {
		t.Fatalf("unexpected cloid format %q", a.Cloid)
	}
	if a.Cloid == b.Cloid {
		t.Fatalf("expected unique cloids, both %q", a.Cloid)
	}
	// Caller-supplied ids are preserved.
	preset := models.OrderRequest{Cloid: "0x11111111111111111111111111111111"}
	if err := ensureOrderCloid(&preset); err != nil {
		t.Fatalf("ensureOrderCloid preset: %v", err)
	}
	if preset.Cloid != "0x11111111111111111111111111111111" {
		t.Fatalf("preset cloid rewritten to %q", preset.Cloid)
	}
}

func TestIsAmbiguousExchangeError(t *testing.T) {
	if !isAmbiguousExchangeError(fmt.Errorf("http 429")) {
		t.Fatal("http 429 must be ambiguous")
	}
	if !isAmbiguousExchangeError(fmt.Errorf("http 502")) {
		t.Fatal("http 502 must be ambiguous")
	}
	if !isAmbiguousExchangeError(fmt.Errorf("http 408")) {
		t.Fatal("http 408 must be ambiguous")
	}
	if isAmbiguousExchangeError(fmt.Errorf("Order must have minimum value of $10.")) {
		t.Fatal("explicit venue reject must not be ambiguous")
	}
}

func TestPlaceBulkOrdersMarksAmbiguousTransportFailure(t *testing.T) {
	mock := testutil.NewMockExchange()
	mock.PlaceBulkOrdersFunc = func(orders []models.OrderRequest) ([]interface{}, error) {
		return nil, fmt.Errorf("http 429")
	}
	service := NewOrderService(
		mock,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		NewAccountRuntime(),
	)
	pk := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	result, err := service.PlaceBulkOrders(context.Background(), models.BulkOrderRequest{
		PrivateKey: pk,
		Mainnet:    true,
		Orders:     []models.OrderRequest{{Coin: "BTC", IsBuy: true, Sz: 100, LimitPx: 50000}},
	})
	if err == nil {
		t.Fatal("expected transport error")
	}
	if result == nil || !result.Ambiguous {
		t.Fatalf("bulk transport 429 must set Ambiguous, got %+v", result)
	}
}

func TestPlaceOrderReturnsAutoGeneratedCloid(t *testing.T) {
	mock := testutil.NewMockExchange()
	var seen string
	mock.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		seen = req.Cloid
		return map[string]interface{}{
			"resting": map[string]interface{}{"oid": float64(42)},
		}, nil
	}
	service := NewOrderService(
		mock,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		NewAccountRuntime(),
	)
	pk := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	result, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: pk,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         100,
		LimitPx:    50000,
		Mainnet:    true,
	})
	if err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	if result == nil || !result.Accepted || result.Oid != 42 {
		t.Fatalf("unexpected result %+v", result)
	}
	if result.Cloid == "" || !strings.HasPrefix(result.Cloid, "0x") || len(result.Cloid) != 34 {
		t.Fatalf("expected auto cloid on result, got %q", result.Cloid)
	}
	if seen != result.Cloid {
		t.Fatalf("wire cloid %q != response cloid %q", seen, result.Cloid)
	}
}

func TestNormalizeExchangeOrderResultXyzSingleOrder(t *testing.T) {
	// xyz/HIP-3 single order response: oid is nested at response.data.statuses[0].filled.oid
	hip3Response := map[string]interface{}{
		"status": "ok",
		"response": map[string]interface{}{
			"type": "order",
			"data": map[string]interface{}{
				"statuses": []interface{}{
					map[string]interface{}{
						"filled": map[string]interface{}{
							"avgPx":   "107.15",
							"oid":     float64(373597687089),
							"totalSz": "0.094",
						},
					},
				},
			},
		},
	}
	result := normalizeExchangeOrderResult(hip3Response, 50)
	if !result.Accepted {
		t.Fatalf("expected xyz single order to be accepted, got error: %s", result.Error)
	}
	if result.Oid != 373597687089 {
		t.Fatalf("expected oid=373597687089, got %d", result.Oid)
	}
	if result.Filled == nil {
		t.Fatal("expected filled to be populated")
	}

	// Standard resting order (regression check)
	restingResponse := map[string]interface{}{
		"resting": map[string]interface{}{"oid": float64(99)},
	}
	result2 := normalizeExchangeOrderResult(restingResponse, 10)
	if !result2.Accepted || result2.Oid != 99 {
		t.Fatalf("expected resting order accepted with oid=99, got %+v", result2)
	}
}

func TestPlaceOrderAttachesHip3ProtectionForImmediateFill(t *testing.T) {
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	var triggerMu sync.Mutex
	triggerReqs := make([]models.TriggerOrderRequest, 0, 2)
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{
			"status": "ok",
			"response": map[string]interface{}{
				"type": "order",
				"data": map[string]interface{}{
					"statuses": []interface{}{
						map[string]interface{}{
							"filled": map[string]interface{}{
								"avgPx":   "100",
								"oid":     float64(123),
								"totalSz": "2",
							},
						},
					},
				},
			},
		}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerMu.Lock()
		triggerReqs = append(triggerReqs, req)
		triggerMu.Unlock()
		return nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		NewAccountRuntime(),
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "xyz:CL",
		IsBuy:      true,
		Sz:         680,
		LimitPx:    100,
		Mainnet:    true,
		TpPct:      4,
		SlPct:      2,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	triggers := waitForTriggerOrders(t, &triggerMu, &triggerReqs, 2)
	if triggers[0].Tpsl != "tp" || triggers[0].TriggerPx != 104 || triggers[0].Sz != 208 {
		t.Fatalf("unexpected TP trigger: %+v", triggers[0])
	}
	if triggers[1].Tpsl != "sl" || triggers[1].TriggerPx != 98 || triggers[1].Sz != 196 {
		t.Fatalf("unexpected SL trigger: %+v", triggers[1])
	}
}

func TestProcessUserFillsAttachesPendingHip3ProtectionFromBackendState(t *testing.T) {
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	triggerReqs := make([]models.TriggerOrderRequest, 0, 2)
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(77)}}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerReqs = append(triggerReqs, req)
		return nil
	}

	runtime := NewAccountRuntime()
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		runtime,
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "xyz:CL",
		IsBuy:      true,
		Sz:         680,
		LimitPx:    100,
		Mainnet:    true,
		TpPct:      4,
		SlPct:      2,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	address, err := service.extractAddress(privateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}

	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{
			"coin": "xyz:CL",
			"oid":  float64(77),
			"px":   "100",
			"sz":   "2",
			"side": "B",
		},
	})

	if len(triggerReqs) != 2 {
		t.Fatalf("expected 2 trigger requests, got %d", len(triggerReqs))
	}
	if math.Abs(triggerReqs[0].Sz-208) > 1e-9 || math.Abs(triggerReqs[1].Sz-196) > 1e-9 {
		t.Fatalf("unexpected trigger sizes: %+v", triggerReqs)
	}

	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{
			"coin": "xyz:CL",
			"oid":  float64(77),
			"px":   "100",
			"sz":   "2",
			"side": "B",
		},
	})
	if len(triggerReqs) != 2 {
		t.Fatalf("expected pending protection to be consumed once, got %d trigger requests", len(triggerReqs))
	}
}

func TestPlaceOrderAttachesStandardPerpProtectionForImmediateFill(t *testing.T) {
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	var triggerMu sync.Mutex
	triggerReqs := make([]models.TriggerOrderRequest, 0, 2)
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{
			"filled": map[string]interface{}{
				"avgPx":   "50000",
				"oid":     float64(321),
				"totalSz": "0.02",
			},
		}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerMu.Lock()
		triggerReqs = append(triggerReqs, req)
		triggerMu.Unlock()
		return nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		NewAccountRuntime(),
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "BTC",
		IsBuy:      false,
		Sz:         1000,
		LimitPx:    50000,
		Mainnet:    true,
		TpPct:      5,
		SlPct:      2,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	triggers := waitForTriggerOrders(t, &triggerMu, &triggerReqs, 2)
	if triggers[0].Tpsl != "tp" || triggers[0].IsBuy != true {
		t.Fatalf("unexpected TP trigger: %+v", triggers[0])
	}
	if triggers[1].Tpsl != "sl" || triggers[1].IsBuy != true {
		t.Fatalf("unexpected SL trigger: %+v", triggers[1])
	}
}

func newProtectionTestService(t *testing.T, triggerReqs *[]models.TriggerOrderRequest) (*OrderService, string, string) {
	t.Helper()
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(77)}}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		*triggerReqs = append(*triggerReqs, req)
		return nil
	}
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		nil,
		NewAccountRuntime(),
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "xyz:CL",
		IsBuy:      true,
		Sz:         680,
		LimitPx:    100,
		Mainnet:    true,
		TpPct:      4,
		SlPct:      2,
	}); err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}
	address, err := service.extractAddress(privateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}
	return service, address, privateKey
}

func partialFill(tid float64, sz string) map[string]interface{} {
	return map[string]interface{}{
		"coin": "xyz:CL",
		"oid":  float64(77),
		"px":   "100",
		"sz":   sz,
		"side": "B",
		"tid":  tid,
	}
}

// Each partial fill of a resting order must attach its own TP/SL legs; the
// protection entry previously died with the first fill, leaving every later
// partial unprotected.
func TestProcessUserFillsAttachesProtectionPerPartialFill(t *testing.T) {
	var triggerReqs []models.TriggerOrderRequest
	service, address, _ := newProtectionTestService(t, &triggerReqs)

	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(1001, "2")})
	if len(triggerReqs) != 2 {
		t.Fatalf("first partial fill: expected 2 trigger requests, got %d", len(triggerReqs))
	}

	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(1002, "3")})
	if len(triggerReqs) != 4 {
		t.Fatalf("second partial fill: expected 4 trigger requests, got %d", len(triggerReqs))
	}
	// Second fill's legs are sized to its own 3 coins (TP at 104: 312 USD).
	if math.Abs(triggerReqs[2].Sz-312) > 1e-9 {
		t.Fatalf("second TP sized to %v, want 312", triggerReqs[2].Sz)
	}

	// Snapshot replay of an already-protected fill must not double-attach.
	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(1001, "2")})
	if len(triggerReqs) != 4 {
		t.Fatalf("replayed fill: expected 4 trigger requests, got %d", len(triggerReqs))
	}
}

func TestProcessOrderUpdatesRetiresProtection(t *testing.T) {
	var triggerReqs []models.TriggerOrderRequest
	service, address, _ := newProtectionTestService(t, &triggerReqs)

	// A "filled" terminal status keeps the entry alive through the grace
	// window so fills racing the status (or replayed after reconnect) attach.
	service.ProcessOrderUpdates(address, []interface{}{
		map[string]interface{}{"order": map[string]interface{}{"oid": float64(77)}, "status": "filled"},
	})
	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(2001, "2")})
	if len(triggerReqs) != 2 {
		t.Fatalf("fill within terminal grace: expected 2 trigger requests, got %d", len(triggerReqs))
	}

	// Past the grace window the entry is gone (quietly: it attached).
	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	entry := service.protectionByID[key][77]
	entry.TerminalAt = time.Now().Add(-protectionTerminalGrace - time.Minute)
	service.protectionByID[key][77] = entry
	service.protectMu.Unlock()
	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(2002, "2")})
	if len(triggerReqs) != 2 {
		t.Fatalf("fill after terminal grace: expected no new trigger requests, got %d", len(triggerReqs))
	}
}

func TestProcessOrderUpdatesCancelClearsProtection(t *testing.T) {
	var triggerReqs []models.TriggerOrderRequest
	service, address, _ := newProtectionTestService(t, &triggerReqs)

	service.ProcessOrderUpdates(address, []interface{}{
		map[string]interface{}{"order": map[string]interface{}{"oid": float64(77)}, "status": "canceled"},
	})
	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(3001, "2")})
	if len(triggerReqs) != 0 {
		t.Fatalf("fill after cancel: expected no trigger requests, got %d", len(triggerReqs))
	}
}

func TestOrderPlacementBudgetRefund(t *testing.T) {
	budget := NewOrderPlacementBudget(2, time.Minute)
	addr := "0x1111111111111111111111111111111111111111"

	if !budget.Allow(addr, 1) {
		t.Fatal("expected first Allow(1) to succeed")
	}
	if !budget.Allow(addr, 1) {
		t.Fatal("expected second Allow(1) to succeed")
	}
	if budget.Allow(addr, 1) {
		t.Fatal("expected third Allow(1) to be rejected (budget exhausted)")
	}

	// Refund 1 unit
	budget.Refund(addr, 1)
	if !budget.Allow(addr, 1) {
		t.Fatal("expected Allow(1) to succeed after refund")
	}
	if budget.Allow(addr, 1) {
		t.Fatal("expected Allow(1) to be rejected again after re-consuming")
	}
}

func TestPlaceOrderRefundsOnNonAmbiguousError(t *testing.T) {
	mockExchange := testutil.NewMockExchange()
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return nil, fmt.Errorf("Order must have minimum value of $10")
	}

	budget := NewRateLimiter(1, time.Minute)
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		budget,
		nil,
		NewAccountRuntime(),
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	addr, _ := service.resolveTradingAccount(privateKey)

	// First attempt fails with explicit exchange error
	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         5,
		LimitPx:    1,
	})
	if err == nil {
		t.Fatal("expected PlaceOrder to fail")
	}

	// Because weight was refunded on non-ambiguous error, second attempt should NOT be rate limited
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(88)}}, nil
	}

	_, err = service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: privateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         680,
		LimitPx:    50000.25,
	})
	if err != nil {
		t.Fatalf("expected second PlaceOrder to succeed due to refund, got: %v", err)
	}

	// Now budget should be exhausted
	if budget.Allow(addr, 1) {
		t.Fatal("expected budget to be exhausted after successful placement")
	}
}

func TestPlaceBulkOrdersRefundsOnNonAmbiguousError(t *testing.T) {
	mockExchange := testutil.NewMockExchange()
	mockExchange.PlaceBulkOrdersFunc = func(req []models.OrderRequest) ([]interface{}, error) {
		return nil, fmt.Errorf("margin insufficient")
	}

	budget := NewRateLimiter(1, time.Minute)
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		budget,
		nil,
		NewAccountRuntime(),
	)

	privateKey := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	addr, _ := service.resolveTradingAccount(privateKey)

	_, err := service.PlaceBulkOrders(context.Background(), models.BulkOrderRequest{
		PrivateKey: privateKey,
		Orders: []models.OrderRequest{{
			Coin:    "BTC",
			IsBuy:   true,
			Sz:      10,
			LimitPx: 50000,
		}},
	})
	if err == nil {
		t.Fatal("expected PlaceBulkOrders to fail")
	}

	// Weight was refunded; another attempt should be allowed by rate limiter
	if !budget.Allow(addr, 1) {
		t.Fatal("expected budget to have been refunded after non-ambiguous bulk failure")
	}
}

