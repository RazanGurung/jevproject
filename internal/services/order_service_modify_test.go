package services

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/services/testutil"
)

const modifyTestPrivateKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func newModifyTestService(t *testing.T) (*OrderService, *AccountRuntime, *testutil.MockPublisher, string) {
	t.Helper()
	ensureProtectionTestDir(t)
	runtime := NewAccountRuntime()
	publisher := testutil.NewMockPublisher()
	service := NewOrderService(
		testutil.NewMockExchange(),
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		publisher,
		runtime,
	)
	address, err := service.extractAddress(modifyTestPrivateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}
	return service, runtime, publisher, address
}

func TestModifyOrderUpdatesRuntimeSnapshotAndPublishes(t *testing.T) {
	service, runtime, publisher, address := newModifyTestService(t)

	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(101), "coin": "BTC", "limitPx": "50000", "sz": "0.01", "side": "B"},
	}, true)
	before := runtime.GetSnapshot(address)

	_, err := service.ModifyOrder(context.Background(), models.ModifyOrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		Oid:        101,
		IsBuy:      true,
		Sz:         0.01,
		LimitPx:    51000,
		Mainnet:    true,
	})
	if err != nil {
		t.Fatalf("ModifyOrder returned error: %v", err)
	}

	snapshot := runtime.GetSnapshot(address)
	if snapshot.Revision <= before.Revision {
		t.Fatalf("expected revision bump after modify, got %d -> %d", before.Revision, snapshot.Revision)
	}
	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected 1 runtime order, got %d", len(snapshot.Orders))
	}
	order := snapshot.Orders[0].(map[string]interface{})
	if px := order["limitPx"]; px != 51000.0 {
		t.Fatalf("runtime kept stale price after modify: %v", px)
	}
	if len(publisher.Events) == 0 {
		t.Fatal("expected an order update to be published after modify")
	}
}

func TestModifyTriggerOrderRegistersTriggerFields(t *testing.T) {
	service, runtime, _, address := newModifyTestService(t)

	_, err := service.ModifyOrder(context.Background(), models.ModifyOrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		Oid:        321,
		IsBuy:      false,
		Sz:         0.01,
		TriggerPx:  99000,
		IsMarket:   true,
		Tpsl:       "sl",
		Mainnet:    true,
	})
	if err != nil {
		t.Fatalf("ModifyOrder returned error: %v", err)
	}

	snapshot := runtime.GetSnapshot(address)
	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected 1 runtime order, got %d", len(snapshot.Orders))
	}
	order := snapshot.Orders[0].(map[string]interface{})
	if order["tpsl"] != "sl" || order["triggerPx"] != 99000.0 {
		t.Fatalf("trigger fields not registered: %+v", order)
	}
	if order["reduceOnly"] != true {
		t.Fatalf("trigger modify must be reduce-only: %+v", order)
	}
	// limitPx falls back to triggerPx so the runtime order passes normalization.
	if order["limitPx"] != 99000.0 {
		t.Fatalf("expected limitPx fallback to triggerPx, got %v", order["limitPx"])
	}
}

func TestBulkModifyOrdersUpdatesRuntimeSnapshot(t *testing.T) {
	service, runtime, _, address := newModifyTestService(t)
	mockExchange := testutil.NewMockExchange()
	mockExchange.BulkModifyOrdersFunc = func([]models.ModifyOrderRequestItem) ([]int64, error) {
		return []int64{1, 2}, nil
	}
	service.exchange = mockExchange

	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(1), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(2), "coin": "ETH", "limitPx": "3000"},
	}, true)

	_, err := service.BulkModifyOrders(context.Background(), models.BulkModifyOrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Mainnet:    true,
		Modifies: []models.ModifyOrderRequestItem{
			{Oid: 1, Coin: "BTC", IsBuy: true, Sz: 0.01, LimitPx: 50500},
			{Oid: 2, Coin: "ETH", IsBuy: false, Sz: 0.2, LimitPx: 2950},
		},
	})
	if err != nil {
		t.Fatalf("BulkModifyOrders returned error: %v", err)
	}

	snapshot := runtime.GetSnapshot(address)
	prices := map[int64]float64{}
	for _, raw := range snapshot.Orders {
		order := raw.(map[string]interface{})
		prices[extractRuntimeOid(order)] = parseRuntimeFloat(order["limitPx"])
	}
	if prices[1] != 50500 || prices[2] != 2950 {
		t.Fatalf("runtime prices not updated by bulk modify: %+v", prices)
	}
}

func TestBulkModifyPartialConfirmationOnlyRekeysConfirmedOrders(t *testing.T) {
	service, runtime, _, address := newModifyTestService(t)
	mockExchange := testutil.NewMockExchange()
	mockExchange.BulkModifyOrdersFunc = func([]models.ModifyOrderRequestItem) ([]int64, error) {
		return []int64{9001, 0}, errors.New("1/2 modifications were not confirmed")
	}
	service.exchange = mockExchange
	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(1), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(2), "coin": "ETH", "limitPx": "3000"},
	}, true)

	oids, err := service.BulkModifyOrders(context.Background(), models.BulkModifyOrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Mainnet:    true,
		Modifies: []models.ModifyOrderRequestItem{
			{Oid: 1, Coin: "BTC", IsBuy: true, Sz: 0.01, LimitPx: 50500},
			{Oid: 2, Coin: "ETH", IsBuy: false, Sz: 0.2, LimitPx: 2950},
		},
	})
	if err == nil || len(oids) != 2 || oids[0] != 9001 || oids[1] != 0 {
		t.Fatalf("got oids=%v err=%v", oids, err)
	}

	snapshot := runtime.GetSnapshot(address)
	prices := map[int64]float64{}
	for _, raw := range snapshot.Orders {
		order := raw.(map[string]interface{})
		prices[extractRuntimeOid(order)] = parseRuntimeFloat(order["limitPx"])
	}
	if prices[9001] != 50500 || prices[2] != 3000 {
		t.Fatalf("partial modify corrupted runtime snapshot: %+v", prices)
	}
}

func TestModifyOrderReplacesOldOidWithExchangeAssignedOid(t *testing.T) {
	service, runtime, publisher, address := newModifyTestService(t)
	mockExchange := testutil.NewMockExchange()
	mockExchange.ModifyOrderFunc = func(req models.ModifyOrderRequest) (int64, error) {
		return 9001, nil // HL modify = cancel+replace: new oid comes back
	}
	service.exchange = mockExchange

	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(101), "coin": "xyz:CL", "limitPx": "87.5", "sz": "0.23", "side": "B"},
	}, true)

	// Pending TP/SL protection keyed by the old oid must follow the order.
	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		101: {PrivateKey: modifyTestPrivateKey, Coin: "xyz:CL", TpPct: 2, Mainnet: true, CreatedAt: time.Now()},
	}
	service.protectMu.Unlock()

	newOid, err := service.ModifyOrder(context.Background(), models.ModifyOrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "xyz:CL",
		Oid:        101,
		IsBuy:      true,
		Sz:         0.23,
		LimitPx:    88.1,
		Mainnet:    true,
	})
	if err != nil {
		t.Fatalf("ModifyOrder returned error: %v", err)
	}
	if newOid != 9001 {
		t.Fatalf("expected new oid 9001, got %d", newOid)
	}

	snapshot := runtime.GetSnapshot(address)
	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected exactly 1 runtime order (no old-oid ghost), got %d", len(snapshot.Orders))
	}
	order := snapshot.Orders[0].(map[string]interface{})
	if extractRuntimeOid(order) != 9001 || parseRuntimeFloat(order["limitPx"]) != 88.1 {
		t.Fatalf("runtime order not re-keyed to the replacement oid: %+v", order)
	}

	service.protectMu.Lock()
	_, oldThere := service.protectionByID[key][101]
	_, newThere := service.protectionByID[key][9001]
	service.protectMu.Unlock()
	if oldThere || !newThere {
		t.Fatalf("protection not re-keyed: old=%t new=%t", oldThere, newThere)
	}
	service.protectMu.Lock()
	alias, hasAlias := service.protectionAlias[key][101]
	service.protectMu.Unlock()
	if !hasAlias || alias != 9001 {
		t.Fatalf("expected old oid alias 101→9001, got has=%t alias=%d", hasAlias, alias)
	}

	if len(publisher.Events) == 0 {
		t.Fatal("expected order updates to be published after modify")
	}
}

// TestModifyOrderRekeysProtectionBeforeRuntimeRegistration ensures a fill on
// the replacement oid that arrives after exchange success (the historical race
// window) still finds protection because re-key runs before runtime work.
func TestModifyOrderRekeysProtectionBeforeRuntimeRegistration(t *testing.T) {
	service, _, _, address := newModifyTestService(t)
	mockExchange := testutil.NewMockExchange()
	var triggerCalls atomic.Int32
	mockExchange.ModifyOrderFunc = func(req models.ModifyOrderRequest) (int64, error) {
		return 9001, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerCalls.Add(1)
		return nil
	}
	service.exchange = mockExchange

	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		101: {
			PrivateKey: modifyTestPrivateKey,
			Coin:       "BTC",
			IsEntryBuy: true,
			TpPct:      2,
			SlPct:      1,
			Mainnet:    true,
			CreatedAt:  time.Now(),
		},
	}
	service.protectMu.Unlock()

	var sawProtectionUnderNewOid atomic.Bool
	service.testAfterModifyExchange = func() {
		service.protectMu.Lock()
		_, ok := service.protectionByID[key][9001]
		service.protectMu.Unlock()
		if ok {
			sawProtectionUnderNewOid.Store(true)
		}
		// Concurrent fill on the replacement oid in the post-rekey window.
		service.ProcessUserFills(context.Background(), address, []interface{}{
			map[string]interface{}{
				"oid": float64(9001), "coin": "BTC", "px": "50000", "sz": "0.01",
				"tid": float64(4242), "side": "B",
			},
		})
	}

	if _, err := service.ModifyOrder(context.Background(), models.ModifyOrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		Oid:        101,
		IsBuy:      true,
		Sz:         0.01,
		LimitPx:    51000,
		Mainnet:    true,
	}); err != nil {
		t.Fatalf("ModifyOrder: %v", err)
	}

	if !sawProtectionUnderNewOid.Load() {
		t.Fatal("protection was not re-keyed before post-exchange hook (runtime registration window)")
	}
	// Wait briefly for attach goroutine/path (ProcessUserFills is synchronous for apply).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && triggerCalls.Load() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if triggerCalls.Load() == 0 {
		t.Fatal("expected TP/SL attach after fill on replacement oid; protection was orphaned")
	}

	service.protectMu.Lock()
	entry := service.protectionByID[key][9001]
	alias := service.protectionAlias[key][101]
	service.protectMu.Unlock()
	if alias != 9001 {
		t.Fatalf("alias 101→9001 missing, got %d", alias)
	}
	if len(entry.Attaches) == 0 {
		t.Fatal("expected attach unit under replacement oid after fill")
	}
}

func TestModifyOrderRekeysProtectionWithoutAccountRuntime(t *testing.T) {
	service, _, _, address := newModifyTestService(t)
	service.accountRuntime = nil
	mockExchange := testutil.NewMockExchange()
	mockExchange.ModifyOrderFunc = func(req models.ModifyOrderRequest) (int64, error) {
		return 9001, nil
	}
	service.exchange = mockExchange

	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		101: {PrivateKey: modifyTestPrivateKey, Coin: "BTC", TpPct: 2, Mainnet: true, CreatedAt: time.Now()},
	}
	service.protectMu.Unlock()

	if _, err := service.ModifyOrder(context.Background(), models.ModifyOrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		Oid:        101,
		IsBuy:      true,
		Sz:         0.01,
		LimitPx:    51000,
		Mainnet:    true,
	}); err != nil {
		t.Fatalf("ModifyOrder: %v", err)
	}

	service.protectMu.Lock()
	_, oldThere := service.protectionByID[key][101]
	_, newThere := service.protectionByID[key][9001]
	service.protectMu.Unlock()
	if oldThere || !newThere {
		t.Fatalf("rekey without runtime: old=%t new=%t", oldThere, newThere)
	}
}

func TestProcessUserFillsFollowsProtectionRekeyAlias(t *testing.T) {
	service, _, _, address := newModifyTestService(t)
	mockExchange := testutil.NewMockExchange()
	var triggerCalls atomic.Int32
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerCalls.Add(1)
		return nil
	}
	service.exchange = mockExchange

	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		9001: {
			PrivateKey: modifyTestPrivateKey,
			Coin:       "BTC",
			IsEntryBuy: true,
			TpPct:      2,
			SlPct:      1,
			Mainnet:    true,
			CreatedAt:  time.Now(),
		},
	}
	service.protectionAlias[key] = map[int64]int64{101: 9001}
	service.protectMu.Unlock()

	// Fill still reports the pre-modify oid; alias must resolve to 9001.
	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{
			"oid": float64(101), "coin": "BTC", "px": "50000", "sz": "0.01",
			"tid": float64(99), "side": "B",
		},
	})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && triggerCalls.Load() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if triggerCalls.Load() == 0 {
		t.Fatal("expected attach via re-key alias from old oid fill")
	}
}

func TestBulkCancelPartialFailureOnlyRemovesConfirmedOids(t *testing.T) {
	service, runtime, _, address := newModifyTestService(t)
	mockExchange := testutil.NewMockExchange()
	mockExchange.BulkCancelOrdersFunc = func(addr string, cancels []models.CancelEntry, testnet bool) ([]int64, error) {
		// Simulate one venue batch succeeding and the other failing.
		return []int64{101}, errors.New("xyz batch failed")
	}
	service.exchange = mockExchange

	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(101), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(202), "coin": "xyz:SOL", "limitPx": "140"},
	}, true)

	cancelled, err := service.BulkCancel(context.Background(), models.BulkCancelRequest{
		PrivateKey: modifyTestPrivateKey,
		Cancels: []map[string]interface{}{
			{"coin": "BTC", "oid": float64(101)},
			{"coin": "xyz:SOL", "oid": float64(202)},
		},
	})
	if err == nil {
		t.Fatal("expected partial-failure error to propagate")
	}
	if len(cancelled) != 1 || cancelled[0] != 101 {
		t.Fatalf("expected confirmed oids [101], got %v", cancelled)
	}

	snapshot := runtime.GetSnapshot(address)
	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected only the confirmed cancel removed, got %d orders", len(snapshot.Orders))
	}
	remaining := snapshot.Orders[0].(map[string]interface{})
	if remaining["coin"] != "xyz:SOL" {
		t.Fatalf("wrong order removed: %+v", remaining)
	}
}

func TestExpiredProtectionPublishesErrorInsteadOfSilentLoss(t *testing.T) {
	service, _, publisher, address := newModifyTestService(t)

	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		555: {
			PrivateKey: modifyTestPrivateKey,
			Coin:       "BTC",
			TpPct:      2,
			SlPct:      1,
			Mainnet:    true,
			CreatedAt:  time.Now().Add(-protectionTTL - time.Minute),
		},
	}
	service.protectMu.Unlock()

	// A fill for an unrelated oid triggers cleanup of the expired entry.
	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{"oid": float64(999), "coin": "ETH"},
	})

	found := false
	for _, event := range publisher.Events {
		raw, _ := json.Marshal(event.Payload)
		if string(raw) != "" && containsProtectionError(raw) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected a protectionError event for the expired entry, got %+v", publisher.Events)
	}

	service.protectMu.Lock()
	_, stillThere := service.protectionByID[key][555]
	service.protectMu.Unlock()
	if stillThere {
		t.Fatal("expired protection entry should have been evicted")
	}
}

func containsProtectionError(raw []byte) bool {
	var payload map[string]interface{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	data, _ := payload["data"].(map[string]interface{})
	if data == nil {
		return false
	}
	_, ok := data["protectionError"]
	return ok
}

func TestUpstreamSnapshotPreservesMissingBuilderPerpOrders(t *testing.T) {
	runtime := NewAccountRuntime()
	address := "0xabc"

	// Authoritative REST seed: one standard and one xyz order.
	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(1), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(2), "coin": "xyz:CL", "limitPx": "87.5"},
	}, true)

	// Upstream webData3 snapshot that omits the xyz order (intermittent
	// builder-dex coverage): the xyz order must survive, the absent standard
	// order is genuinely gone.
	snapshot := runtime.UpdateOrdersFromUpstreamSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(1), "coin": "BTC", "limitPx": "50100"},
	}, true)

	coins := map[string]bool{}
	for _, raw := range snapshot.Orders {
		order := raw.(map[string]interface{})
		coins[order["coin"].(string)] = true
	}
	if !coins["BTC"] || !coins["xyz:CL"] {
		t.Fatalf("expected BTC and preserved xyz:CL orders, got %+v", coins)
	}

	// Explicitly removed xyz orders must NOT be resurrected by preservation.
	runtime.MarkOrdersRemoved(address, []int64{2})
	snapshot = runtime.UpdateOrdersFromUpstreamSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(1), "coin": "BTC", "limitPx": "50100"},
	}, true)
	for _, raw := range snapshot.Orders {
		order := raw.(map[string]interface{})
		if order["coin"] == "xyz:CL" {
			t.Fatalf("cancelled xyz order resurrected by upstream preservation: %+v", order)
		}
	}

	// A REST snapshot stays authoritative: xyz absence there means gone.
	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(1), "coin": "BTC", "limitPx": "50100"},
	}, true)
	final := runtime.GetSnapshot(address)
	if len(final.Orders) != 1 {
		t.Fatalf("REST snapshot should fully replace orders, got %d", len(final.Orders))
	}
}

func TestReconcileBuilderPerpOrdersReplacesOnlyXyzSlice(t *testing.T) {
	runtime := NewAccountRuntime()
	address := "0xabc"
	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(1), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(2), "coin": "xyz:CL", "limitPx": "87.5"},
	}, true)
	before := runtime.GetSnapshot(address)

	// Identical xyz state → no change, no revision bump.
	snapshot, changed := runtime.ReconcileBuilderPerpOrders(address, []interface{}{
		map[string]interface{}{"oid": float64(2), "coin": "xyz:CL", "limitPx": "87.5"},
	})
	if changed || snapshot.Revision != before.Revision {
		t.Fatalf("unchanged poll must not bump revision: changed=%t rev %d->%d", changed, before.Revision, snapshot.Revision)
	}

	// xyz order replaced on-exchange (e.g. TP fired, new SL resting): the xyz
	// slice swaps, the standard order is untouched.
	snapshot, changed = runtime.ReconcileBuilderPerpOrders(address, []interface{}{
		map[string]interface{}{"oid": float64(3), "coin": "xyz:CL", "limitPx": "82.0", "orderType": "Stop Market"},
	})
	if !changed {
		t.Fatal("expected change when the xyz order set differs")
	}
	coins := map[string]int64{}
	for _, raw := range snapshot.Orders {
		order := raw.(map[string]interface{})
		coins[order["coin"].(string)] = extractRuntimeOid(order)
	}
	if coins["BTC"] != 1 || coins["xyz:CL"] != 3 {
		t.Fatalf("unexpected reconciled orders: %+v", coins)
	}

	// Suppressed (just-cancelled) xyz oids must not be resurrected by a stale poll.
	runtime.MarkOrdersRemoved(address, []int64{3})
	snapshot, _ = runtime.ReconcileBuilderPerpOrders(address, []interface{}{
		map[string]interface{}{"oid": float64(3), "coin": "xyz:CL", "limitPx": "82.0"},
	})
	for _, raw := range snapshot.Orders {
		order := raw.(map[string]interface{})
		if extractRuntimeOid(order) == 3 {
			t.Fatalf("suppressed xyz order resurrected by poll: %+v", order)
		}
	}
}

// ensureProtectionTestDir isolates pending_protection.json writes per test
// so protection persistence cannot pollute the package directory or leak
// state between tests.
func ensureProtectionTestDir(t *testing.T) {
	t.Helper()
	t.Chdir(t.TempDir())
}

func TestPendingProtectionPersistsAcrossRestart(t *testing.T) {
	// All services in this test must share one working directory so they see
	// the same pending_protection.json (the helper chdirs per call).
	service, _, _, address := newModifyTestService(t)
	key := normalizeRuntimeAccount(address)

	newServiceSameDir := func() *OrderService {
		return NewOrderService(
			testutil.NewMockExchange(),
			testutil.NewMockPriceCache(),
			testutil.NewMockMetadataCache(),
			NewRateLimiter(100, time.Minute),
			testutil.NewMockPublisher(),
			NewAccountRuntime(),
		)
	}

	// Register a resting-order protection request via the public path.
	service.maybeRegisterProtection(context.Background(), address, models.OrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "xyz:CL",
		IsBuy:      true,
		TpPct:      2,
		SlPct:      1,
		Mainnet:    true,
	}, map[string]interface{}{"resting": map[string]interface{}{"oid": float64(777)}})

	// A fresh service (simulated restart) restores the entry from disk,
	// without the private key (re-resolved from keycache at attach time).
	restarted := newServiceSameDir()
	restarted.protectMu.Lock()
	entry, ok := restarted.protectionByID[key][777]
	restarted.protectMu.Unlock()
	if !ok {
		t.Fatal("pending protection not restored after restart")
	}
	if entry.PrivateKey != "" {
		t.Fatal("private key must never be persisted")
	}
	if entry.Coin != "xyz:CL" || entry.TpPct != 2 || entry.SlPct != 1 {
		t.Fatalf("restored entry mismatch: %+v", entry)
	}

	// Consuming the entry clears the file so it is not re-restored.
	restarted.clearProtectionByOid(address, 777)
	again := newServiceSameDir()
	again.protectMu.Lock()
	_, stillThere := again.protectionByID[key][777]
	again.protectMu.Unlock()
	if stillThere {
		t.Fatal("cleared protection entry must not be restored")
	}
}

func TestUserFillsDoNotRemoveRuntimeOrders(t *testing.T) {
	runtime := NewAccountRuntime()
	address := "0xabc"
	runtime.UpdateOrdersFromSnapshot(address, []interface{}{
		map[string]interface{}{"oid": float64(303), "coin": "BTC", "limitPx": "51000"},
	}, true)

	msg, _ := json.Marshal(map[string]interface{}{
		"channel": "userFills",
		"data": map[string]interface{}{
			"fills": []interface{}{
				map[string]interface{}{"oid": float64(303), "coin": "BTC", "sz": "0.005"},
			},
		},
	})
	snapshot := runtime.ApplyUserStreamMessage(address, msg)

	if len(snapshot.Orders) != 1 {
		t.Fatalf("partial fill must not evict the resting order, got %d orders", len(snapshot.Orders))
	}

	// Terminal orderUpdates still remove the order.
	terminal, _ := json.Marshal(map[string]interface{}{
		"channel": "orderUpdates",
		"data": []interface{}{
			map[string]interface{}{"order": map[string]interface{}{"oid": float64(303)}, "status": "filled"},
		},
	})
	snapshot = runtime.ApplyUserStreamMessage(address, terminal)
	if len(snapshot.Orders) != 0 {
		t.Fatalf("terminal status should remove the order, got %d orders", len(snapshot.Orders))
	}
}

// Residual: after cancel+replace modify, exchange cancels the old oid.
// ProcessOrderUpdates must not follow protectionAlias, or replacement protection dies.
func TestProcessOrderUpdatesCancelOnOldOidDoesNotClearRekeyedProtection(t *testing.T) {
	service, _, _, address := newModifyTestService(t)
	mockExchange := testutil.NewMockExchange()
	var triggerCalls atomic.Int32
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerCalls.Add(1)
		return nil
	}
	service.exchange = mockExchange

	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		9001: {
			PrivateKey: modifyTestPrivateKey,
			Coin:       "BTC",
			IsEntryBuy: true,
			TpPct:      2,
			SlPct:      1,
			Mainnet:    true,
			CreatedAt:  time.Now(),
		},
	}
	service.protectionAlias[key] = map[int64]int64{101: 9001}
	service.protectMu.Unlock()

	// Exchange cancel of the pre-modify oid (cancel+replace side effect).
	service.ProcessOrderUpdates(address, []interface{}{
		map[string]interface{}{"order": map[string]interface{}{"oid": float64(101)}, "status": "canceled"},
	})

	service.protectMu.Lock()
	_, stillThere := service.protectionByID[key][9001]
	alias := service.protectionAlias[key][101]
	service.protectMu.Unlock()
	if !stillThere {
		t.Fatal("cancel on old oid followed alias and cleared replacement protection")
	}
	if alias != 9001 {
		t.Fatalf("alias 101→9001 should remain for late fills, got %d", alias)
	}

	// Late fill on replacement oid must still attach.
	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{
			"oid": float64(9001), "coin": "BTC", "px": "50000", "sz": "0.01",
			"tid": float64(77), "side": "B",
		},
	})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && triggerCalls.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if triggerCalls.Load() == 0 {
		t.Fatal("expected TP/SL attach on replacement oid after old-oid cancel")
	}
}
