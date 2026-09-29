package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/keycache"
	"hyperliquid-go/internal/services/testutil"
)

func TestWriteFileAtomicReplacesContentAndLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pending_protection.json")
	if err := os.WriteFile(path, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []byte(`{"version":2}`), 0600); err != nil {
		t.Fatalf("writeFileAtomic: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"version":2}` {
		t.Fatalf("atomic file content=%q", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("atomic file mode=%#o want 0600", info.Mode().Perm())
	}
	leftovers, err := filepath.Glob(filepath.Join(dir, ".pending_protection.json.tmp-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("temporary files leaked: %v", leftovers)
	}
}

// containsProtectionErrorMatching mirrors containsProtectionError (see
// order_service_modify_test.go) but also asserts the error text contains a
// specific substring, so tests can tell distinct failure reasons apart
// (e.g. "no signing key" vs a generic exchange rejection).
func containsProtectionErrorMatching(raw []byte, substr string) bool {
	var payload map[string]interface{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	data, _ := payload["data"].(map[string]interface{})
	if data == nil {
		return false
	}
	protectionError, _ := data["protectionError"].(map[string]interface{})
	if protectionError == nil {
		return false
	}
	errText, _ := protectionError["error"].(string)
	return errText != "" && containsIgnoreCase(errText, substr)
}

func containsIgnoreCase(haystack, needle string) bool {
	h, n := []rune(haystack), []rune(needle)
	toLower := func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}
	for i, r := range h {
		h[i] = toLower(r)
	}
	for i, r := range n {
		n[i] = toLower(r)
	}
	hs, ns := string(h), string(n)
	for i := 0; i+len(ns) <= len(hs); i++ {
		if hs[i:i+len(ns)] == ns {
			return true
		}
	}
	return len(ns) == 0
}

// TestAttachProtectionPlacesSlEvenWhenTpFails guards against the guaranteed
// double-miss the old code had: attachProtectionForFill placed TP first and
// returned immediately on error, so SL was never even attempted whenever TP
// failed. Both legs must always be attempted independently.
func TestAttachProtectionPlacesSlEvenWhenTpFails(t *testing.T) {
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	var mu sync.Mutex
	var triggerReqs []models.TriggerOrderRequest
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{
			"filled": map[string]interface{}{"avgPx": "100", "oid": float64(501), "totalSz": "2"},
		}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		mu.Lock()
		triggerReqs = append(triggerReqs, req)
		mu.Unlock()
		if req.Tpsl == "tp" {
			return errors.New("simulated tp rejection")
		}
		return nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         200,
		LimitPx:    100,
		Mainnet:    true,
		TpPct:      4,
		SlPct:      2,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	reqs := waitForTriggerOrders(t, &mu, &triggerReqs, 2)
	if reqs[0].Tpsl != "tp" || reqs[1].Tpsl != "sl" {
		t.Fatalf("expected both TP and SL attempted despite TP failure, got %+v", reqs)
	}
	for _, req := range reqs {
		if req.SzCoin != 2 {
			t.Fatalf("protection must preserve exact filled coin size, got %+v", req)
		}
	}

	address, err := service.extractAddress(modifyTestPrivateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}
	key := normalizeRuntimeAccount(address)
	deadline := time.Now().Add(2 * time.Second)
	for {
		service.protectMu.Lock()
		entry, ok := service.protectionByID[key][501]
		service.protectMu.Unlock()
		if ok && len(entry.Attaches) == 1 && entry.Attaches[0].SL.Done && !entry.Attaches[0].TP.Done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected SL done and TP pending: ok=%v entry=%+v", ok, entry)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestAttachProtectionPlacesTpEvenWhenSlFails is the symmetric case.
func TestAttachProtectionPlacesTpEvenWhenSlFails(t *testing.T) {
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	var mu sync.Mutex
	var triggerReqs []models.TriggerOrderRequest
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{
			"filled": map[string]interface{}{"avgPx": "100", "oid": float64(502), "totalSz": "2"},
		}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		mu.Lock()
		triggerReqs = append(triggerReqs, req)
		mu.Unlock()
		if req.Tpsl == "sl" {
			return errors.New("simulated sl rejection")
		}
		return nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         200,
		LimitPx:    100,
		Mainnet:    true,
		TpPct:      4,
		SlPct:      2,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	reqs := waitForTriggerOrders(t, &mu, &triggerReqs, 2)
	if reqs[0].Tpsl != "tp" || reqs[1].Tpsl != "sl" {
		t.Fatalf("expected both TP and SL attempted despite SL failure, got %+v", reqs)
	}

	address, _ := service.extractAddress(modifyTestPrivateKey)
	key := normalizeRuntimeAccount(address)
	deadline := time.Now().Add(2 * time.Second)
	for {
		service.protectMu.Lock()
		entry, ok := service.protectionByID[key][502]
		service.protectMu.Unlock()
		if ok && len(entry.Attaches) == 1 && entry.Attaches[0].TP.Done && !entry.Attaches[0].SL.Done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected TP done and SL pending: ok=%v entry=%+v", ok, entry)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestProtectionRetrySweepCompletesMissingLegWithoutDoublingSuccessfulLeg
// covers both the retry-without-double-placement guarantee and the
// removal of a fully-attached, closed entry once the sweep finishes it.
func TestProtectionRetrySweepCompletesMissingLegWithoutDoublingSuccessfulLeg(t *testing.T) {
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	var mu sync.Mutex
	var triggerReqs []models.TriggerOrderRequest
	failTP := true
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{
			"filled": map[string]interface{}{"avgPx": "100", "oid": float64(601), "totalSz": "2"},
		}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		mu.Lock()
		defer mu.Unlock()
		triggerReqs = append(triggerReqs, req)
		if req.Tpsl == "tp" && failTP {
			return errors.New("simulated tp rejection")
		}
		return nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         200,
		LimitPx:    100,
		Mainnet:    true,
		TpPct:      4,
		SlPct:      2,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	waitForTriggerOrders(t, &mu, &triggerReqs, 2) // TP attempted (fails) + SL attempted (succeeds)

	mu.Lock()
	failTP = false
	mu.Unlock()

	service.retryIncompleteProtectionAttachesOnce(context.Background())

	mu.Lock()
	reqs := append([]models.TriggerOrderRequest(nil), triggerReqs...)
	mu.Unlock()

	tpCount, slCount := 0, 0
	var tpCloids []string
	for _, r := range reqs {
		switch r.Tpsl {
		case "tp":
			tpCount++
			tpCloids = append(tpCloids, r.Cloid)
		case "sl":
			slCount++
		}
	}
	if tpCount != 2 || slCount != 1 {
		t.Fatalf("expected 2 TP attempts (1 failed + 1 retried) and exactly 1 SL attempt (never doubled), got tp=%d sl=%d: %+v", tpCount, slCount, reqs)
	}
	if len(tpCloids) != 2 || tpCloids[0] == "" || tpCloids[0] != tpCloids[1] {
		t.Fatalf("protection retry must reuse one stable TP cloid, got %v", tpCloids)
	}
	if reqs[1].Tpsl == "sl" && reqs[1].Cloid == "" {
		t.Fatal("SL protection leg must carry a stable cloid")
	}

	address, _ := service.extractAddress(modifyTestPrivateKey)
	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	_, stillThere := service.protectionByID[key][601]
	service.protectMu.Unlock()
	if stillThere {
		t.Fatal("expected the entry to be removed once both legs are done and the entry is closed")
	}
}

// TestProcessUserFillsReplayRetriesOnlyMissingLeg covers the fix for the old
// SeenTids-before-attach bug: a fill whose attach partially failed must still
// be retryable by a later replay of the same fill, but only the missing leg
// should ever be re-placed.
func TestProcessUserFillsReplayRetriesOnlyMissingLeg(t *testing.T) {
	t.Chdir(t.TempDir())
	mockExchange := testutil.NewMockExchange()
	failSL := true
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{"resting": map[string]interface{}{"oid": float64(77)}}, nil
	}
	var triggerReqs []models.TriggerOrderRequest
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerReqs = append(triggerReqs, req)
		if req.Tpsl == "sl" && failSL {
			return errors.New("simulated sl rejection")
		}
		return nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: modifyTestPrivateKey,
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
	address, err := service.extractAddress(modifyTestPrivateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}

	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(4501, "2")})
	if len(triggerReqs) != 2 {
		t.Fatalf("expected TP+SL attempted on first fill, got %d: %+v", len(triggerReqs), triggerReqs)
	}

	// Replay the identical fill (same tid) while SL still fails: nothing new
	// should be attempted for TP (already Done), and SL should be retried
	// (still incomplete) — not skipped outright as the old SeenTids dedupe
	// would have done.
	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(4501, "2")})
	if len(triggerReqs) != 3 {
		t.Fatalf("expected exactly one retried SL attempt on replay, got %d: %+v", len(triggerReqs), triggerReqs)
	}
	if triggerReqs[2].Tpsl != "sl" {
		t.Fatalf("expected the retried leg to be SL, got %+v", triggerReqs[2])
	}

	// Now let SL succeed and replay again: it must complete, and a further
	// replay must not double-place it.
	failSL = false
	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(4501, "2")})
	if len(triggerReqs) != 4 {
		t.Fatalf("expected exactly one more SL attempt (now succeeding), got %d: %+v", len(triggerReqs), triggerReqs)
	}

	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(4501, "2")})
	if len(triggerReqs) != 4 {
		t.Fatalf("expected a fully-attached replay to be a pure no-op, got %d: %+v", len(triggerReqs), triggerReqs)
	}
}

// TestCleanupExpiredProtectionKeepsPartiallyAttachedEntryForRetry guards
// against the old cleanupExpiredProtectionLocked bug, which treated any
// AttachedSzCoin > 0 as "fully protected" and silently evicted an entry that
// still had a missing leg.
func TestCleanupExpiredProtectionKeepsPartiallyAttachedEntryForRetry(t *testing.T) {
	t.Chdir(t.TempDir())
	publisher := testutil.NewMockPublisher()
	service := NewOrderService(
		testutil.NewMockExchange(),
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		publisher,
		NewAccountRuntime(),
	)

	address := "0xdef"
	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		777: {
			Coin:      "ETH",
			TpPct:     4,
			SlPct:     2,
			Mainnet:   true,
			CreatedAt: time.Now().Add(-protectionTTL - time.Minute),
			Attaches: []protectionAttachUnit{
				{
					Tid:    "9001",
					AvgPx:  100,
					SzCoin: 2,
					TP:     protectionLeg{Required: true, Done: true},
					SL:     protectionLeg{Required: true, Done: false, LastError: "boom"},
				},
			},
		},
	}
	service.protectMu.Unlock()

	// A fill for an unrelated oid triggers cleanup of the expired entry.
	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{"oid": float64(999), "coin": "SOL"},
	})

	found := false
	for _, event := range publisher.Events {
		raw, _ := json.Marshal(event.Payload)
		if containsProtectionErrorMatching(raw, "incomplete leg") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a distinct partial-expiry protectionError, got %+v", publisher.Events)
	}

	service.protectMu.Lock()
	entry, stillThere := service.protectionByID[key][777]
	service.protectMu.Unlock()
	if !stillThere {
		t.Fatal("partially attached entry must not be silently dropped")
	}
	if !entry.Closed {
		t.Fatal("expired partially-attached entry should be marked Closed")
	}
	if len(entry.Attaches) != 1 || !entry.Attaches[0].TP.Done || entry.Attaches[0].SL.Done {
		t.Fatalf("expected TP to remain Done and SL to remain pending, got %+v", entry.Attaches)
	}
}

// TestCancelAfterPartialFillPreservesPendingRetry is the corollary fix: a
// resting order's cancel must not abandon an already-filled portion's
// still-incomplete leg.
func TestCancelAfterPartialFillPreservesPendingRetry(t *testing.T) {
	var triggerReqs []models.TriggerOrderRequest
	service, address, privateKey := newProtectionTestService(t, &triggerReqs)

	mockExchange := testutil.NewMockExchange()
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerReqs = append(triggerReqs, req)
		if req.Tpsl == "sl" {
			return errors.New("simulated sl rejection")
		}
		return nil
	}
	service.exchange = mockExchange

	service.ProcessUserFills(context.Background(), address, []interface{}{partialFill(4601, "2")})
	if len(triggerReqs) != 2 {
		t.Fatalf("expected TP+SL attempted, got %d", len(triggerReqs))
	}

	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	entry := service.protectionByID[key][77]
	service.protectMu.Unlock()
	if !entry.Attaches[0].TP.Done || entry.Attaches[0].SL.Done {
		t.Fatalf("expected TP done, SL pending before cancel: %+v", entry.Attaches[0])
	}

	if err := service.CancelOrder(context.Background(), privateKey, "xyz:CL", 77, false); err != nil {
		t.Fatalf("CancelOrder returned error: %v", err)
	}

	service.protectMu.Lock()
	entry, stillThere := service.protectionByID[key][77]
	service.protectMu.Unlock()
	if !stillThere {
		t.Fatal("cancel must not abandon a partially-attached fill's pending retry")
	}
	if !entry.Closed {
		t.Fatal("expected the entry to be marked Closed (no more fills expected) after cancel")
	}
	if !entry.Attaches[0].TP.Done || entry.Attaches[0].SL.Done {
		t.Fatalf("expected SL to remain pending after cancel: %+v", entry.Attaches[0])
	}
}

// TestImmediateFillProtectionPersistsBeforeAttachAndRecoversAfterRestart
// covers both the durability fix (persisted before the exchange call, not
// after) and crash recovery (a fresh OrderService in the same working
// directory restores the not-yet-attached unit).
func TestImmediateFillProtectionPersistsBeforeAttachAndRecoversAfterRestart(t *testing.T) {
	t.Chdir(t.TempDir())

	mockExchange := testutil.NewMockExchange()
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	var once sync.Once
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{
			"filled": map[string]interface{}{"avgPx": "100", "oid": float64(701), "totalSz": "2"},
		}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		once.Do(func() { started <- struct{}{} })
		<-release
		return nil
	}

	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         200,
		LimitPx:    100,
		Mainnet:    true,
		TpPct:      4,
		SlPct:      2,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the first attach attempt to start")
	}

	// The attach attempt is now blocked mid-flight, before any leg has
	// completed. Persistence must already be on disk at this point — proving
	// it happens before the exchange call, not after.
	data, readErr := os.ReadFile(pendingProtectionFile)
	if readErr != nil {
		t.Fatalf("expected %s to exist before the exchange call completes: %v", pendingProtectionFile, readErr)
	}
	if !containsIgnoreCase(string(data), "701") {
		t.Fatalf("expected persisted file to reference oid 701: %s", data)
	}

	address, err := service.extractAddress(modifyTestPrivateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}
	key := normalizeRuntimeAccount(address)

	// Simulate a crash before the goroutine finishes: construct a second
	// OrderService in the same working directory now, while the exchange
	// call is still blocked, and confirm it recovers the not-yet-attached
	// unit rather than losing it.
	restarted := NewOrderService(
		testutil.NewMockExchange(),
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)
	restarted.protectMu.Lock()
	entry, ok := restarted.protectionByID[key][701]
	restarted.protectMu.Unlock()
	if !ok || len(entry.Attaches) != 1 {
		t.Fatalf("expected the immediate-fill protection unit to be restored, got ok=%v entry=%+v", ok, entry)
	}
	if entry.Attaches[0].TP.Done || entry.Attaches[0].SL.Done {
		t.Fatalf("expected the restored unit to still be incomplete (crash happened mid-attach), got %+v", entry.Attaches[0])
	}

	close(release)
}

// TestProcessUserFillsFailsFastOnEmptySigningKey guards against the old bug
// where an empty signing key (a disk-restored entry with no keycache
// fallback available) was used to attempt a doomed signed call
// indistinguishable from a genuine exchange rejection.
func TestProcessUserFillsFailsFastOnEmptySigningKey(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("PEZ_PRIVATE_KEY", "")
	t.Setenv("PRIVATE_KEY", "")

	mockExchange := testutil.NewMockExchange()
	var triggerCalls int32
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		atomic.AddInt32(&triggerCalls, 1)
		return nil
	}
	publisher := testutil.NewMockPublisher()
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		publisher,
		NewAccountRuntime(),
	)

	address := "0xabc"
	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		// PrivateKey intentionally empty, as a disk-restored entry would be.
		901: {Coin: "BTC", TpPct: 4, SlPct: 2, Mainnet: true, CreatedAt: time.Now()},
	}
	service.protectMu.Unlock()

	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{"oid": float64(901), "coin": "BTC", "px": "100", "sz": "2", "tid": float64(1)},
	})

	if atomic.LoadInt32(&triggerCalls) != 0 {
		t.Fatalf("expected no exchange calls with no signing key available, got %d", triggerCalls)
	}

	found := false
	for _, event := range publisher.Events {
		raw, _ := json.Marshal(event.Payload)
		if containsProtectionErrorMatching(raw, "signing key") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a distinct 'signing key' protectionError, got %+v", publisher.Events)
	}

	service.protectMu.Lock()
	entry := service.protectionByID[key][901]
	service.protectMu.Unlock()
	if len(entry.Attaches) != 1 || entry.Attaches[0].TP.Done || entry.Attaches[0].SL.Done {
		t.Fatalf("expected the unit to remain pending for a later retry, got %+v", entry)
	}
}

func TestImmediateFillUserStreamReplayDoesNotDuplicateProtection(t *testing.T) {
	t.Chdir(t.TempDir())

	mockExchange := testutil.NewMockExchange()
	var mu sync.Mutex
	var triggerReqs []models.TriggerOrderRequest
	mockExchange.PlaceOrderFunc = func(req models.OrderRequest) (interface{}, error) {
		return map[string]interface{}{
			"filled": map[string]interface{}{
				"avgPx":   "100",
				"totalSz": "0.1",
				"oid":     float64(777),
			},
		}, nil
	}
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		mu.Lock()
		triggerReqs = append(triggerReqs, req)
		mu.Unlock()
		return nil
	}
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	_, err := service.PlaceOrder(context.Background(), models.OrderRequest{
		PrivateKey: modifyTestPrivateKey,
		Coin:       "BTC",
		IsBuy:      true,
		Sz:         10,
		Mainnet:    true,
		TpPct:      5,
		SlPct:      5,
	})
	if err != nil {
		t.Fatalf("PlaceOrder returned error: %v", err)
	}
	waitForTriggerOrders(t, &mu, &triggerReqs, 2)

	address, err := service.extractAddress(modifyTestPrivateKey)
	if err != nil {
		t.Fatalf("extractAddress returned error: %v", err)
	}
	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{
			"oid": float64(777), "coin": "BTC", "px": "100", "sz": "0.1", "tid": float64(1234),
		},
	})
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	got := len(triggerReqs)
	mu.Unlock()
	if got != 2 {
		t.Fatalf("immediate fill replay placed %d trigger legs, want exactly 2", got)
	}
}

// TestLoadPendingProtectionMigratesLegacyShape covers the on-disk migration
// shim: a pending_protection.json written by the pre-per-leg-tracking binary
// (seenTids/attachedSzCoin, no attaches) must still dedupe correctly after
// upgrading, so a fill replayed post-upgrade never double-places an
// already-live leg.
func TestLoadPendingProtectionMigratesLegacyShape(t *testing.T) {
	t.Chdir(t.TempDir())

	legacy := map[string]map[string]map[string]interface{}{
		"0xabc": {
			"55": {
				"coin":           "BTC",
				"isEntryBuy":     true,
				"tpPct":          4.0,
				"slPct":          2.0,
				"mainnet":        true,
				"createdAt":      time.Now().Format(time.RFC3339Nano),
				"attachedSzCoin": 2.0,
				"seenTids":       []string{"1001", "1002"},
			},
		},
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("marshal legacy fixture: %v", err)
	}
	if err := os.WriteFile(pendingProtectionFile, data, 0600); err != nil {
		t.Fatalf("write legacy fixture: %v", err)
	}

	mockExchange := testutil.NewMockExchange()
	var triggerCalls int32
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		atomic.AddInt32(&triggerCalls, 1)
		return nil
	}
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	service.protectMu.Lock()
	entry, ok := service.protectionByID["0xabc"][55]
	service.protectMu.Unlock()
	if !ok {
		t.Fatal("expected legacy entry to be restored")
	}
	if len(entry.Attaches) != 2 {
		t.Fatalf("expected 2 migrated attach units (one per legacy seenTid), got %d", len(entry.Attaches))
	}
	for _, u := range entry.Attaches {
		if !u.fullyAttached() {
			t.Fatalf("expected migrated legacy units to be marked fully attached (preserving dedupe), got %+v", u)
		}
	}

	// A fill replaying one of the legacy tids must not double-place a leg.
	service.ProcessUserFills(context.Background(), "0xabc", []interface{}{
		map[string]interface{}{"oid": float64(55), "coin": "BTC", "px": "100", "sz": "2", "tid": float64(1001)},
	})
	if atomic.LoadInt32(&triggerCalls) != 0 {
		t.Fatalf("expected replay of a migrated legacy tid to be a no-op, got %d exchange calls", triggerCalls)
	}
}

// Residual: disk-restored protection has empty PrivateKey. Fail-fast is covered;
// this pins recovery when the key is restored later (set-key / keycache).
func TestProtectionRetrySweepRecoversAfterSigningKeyRestored(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("PEZ_PRIVATE_KEY", "")
	t.Setenv("PRIVATE_KEY", "")
	keycache.Clear()
	t.Cleanup(keycache.Clear)

	mockExchange := testutil.NewMockExchange()
	var triggerCalls atomic.Int32
	mockExchange.PlaceTriggerOrderFunc = func(req models.TriggerOrderRequest) error {
		triggerCalls.Add(1)
		return nil
	}
	service := NewOrderService(
		mockExchange,
		testutil.NewMockPriceCache(),
		testutil.NewMockMetadataCache(),
		NewRateLimiter(100, time.Minute),
		testutil.NewMockPublisher(),
		NewAccountRuntime(),
	)

	address := "0xabc"
	key := normalizeRuntimeAccount(address)
	service.protectMu.Lock()
	service.protectionByID[key] = map[int64]protectionRequest{
		901: {Coin: "BTC", IsEntryBuy: true, TpPct: 4, SlPct: 2, Mainnet: true, CreatedAt: time.Now()},
	}
	service.protectMu.Unlock()

	// Fill while no key: unit stays pending, no exchange calls.
	service.ProcessUserFills(context.Background(), address, []interface{}{
		map[string]interface{}{"oid": float64(901), "coin": "BTC", "px": "100", "sz": "2", "tid": float64(9)},
	})
	if triggerCalls.Load() != 0 {
		t.Fatalf("expected 0 trigger calls without key, got %d", triggerCalls.Load())
	}

	// Operator restores key (browser set-key → keycache).
	keycache.Cache(modifyTestPrivateKey)
	service.retryIncompleteProtectionAttachesOnce(context.Background())

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && triggerCalls.Load() < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	if triggerCalls.Load() < 2 {
		t.Fatalf("expected TP+SL after key restore + sweep, got %d trigger calls", triggerCalls.Load())
	}

	service.protectMu.Lock()
	entry := service.protectionByID[key][901]
	service.protectMu.Unlock()
	if len(entry.Attaches) != 1 || !entry.Attaches[0].fullyAttached() {
		t.Fatalf("expected fully attached unit after key restore, got %+v", entry)
	}
}
