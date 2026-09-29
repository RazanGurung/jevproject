package services

import (
	"testing"
	"time"
)

func TestAccountRuntimeRemovesTerminalOrdersFromUserStream(t *testing.T) {
	runtime := NewAccountRuntime()
	account := "0xabc"

	runtime.UpdateOrdersFromSnapshot(account, []interface{}{
		map[string]interface{}{"oid": float64(101), "coin": "BTC", "limitPx": "50000"},
		map[string]interface{}{"oid": float64(202), "coin": "ETH", "limitPx": "3000"},
	}, true)

	snapshot := runtime.ApplyUserStreamMessage(account, []byte(`{
		"channel":"orderUpdates",
		"data":{"orderUpdates":[{"oid":101,"status":"filled"}]}
	}`))

	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected 1 order after terminal update, got %d", len(snapshot.Orders))
	}
	order := snapshot.Orders[0].(map[string]interface{})
	if order["coin"] != "ETH" {
		t.Fatalf("expected ETH order to remain, got %+v", order)
	}
	if snapshot.Revision < 2 {
		t.Fatalf("expected runtime revision to advance, got %d", snapshot.Revision)
	}
}

func TestAccountRuntimeIgnoresStaleReappearingRemovedOrders(t *testing.T) {
	runtime := NewAccountRuntime()
	account := "0xabc"

	runtime.UpdateOrdersFromSnapshot(account, []interface{}{
		map[string]interface{}{"oid": float64(303), "coin": "BTC", "limitPx": "51000"},
	}, true)
	runtime.MarkOrdersRemoved(account, []int64{303})

	snapshot := runtime.UpdateOrdersFromSnapshot(account, []interface{}{
		map[string]interface{}{"oid": float64(303), "coin": "BTC", "limitPx": "51000"},
	}, false)

	if len(snapshot.Orders) != 0 {
		t.Fatalf("expected removed order to stay filtered, got %+v", snapshot.Orders)
	}
	if snapshot.OrderFresh {
		t.Fatalf("expected stale snapshot to remain marked stale")
	}
}

func TestAccountRuntimeAcceptsWebData3Snapshots(t *testing.T) {
	runtime := NewAccountRuntime()
	account := "0xabc"

	snapshot := runtime.ApplyUserStreamMessage(account, []byte(`{
		"channel":"webData3",
		"data":{"orders":[{"oid":505,"coin":"SOL","limitPx":"150"}]}
	}`))

	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected 1 order from webData3 snapshot, got %d", len(snapshot.Orders))
	}
	order := snapshot.Orders[0].(map[string]interface{})
	if order["coin"] != "SOL" {
		t.Fatalf("expected SOL order to be tracked, got %+v", order)
	}
	if !snapshot.OrderFresh {
		t.Fatalf("expected webData3 snapshot to be marked fresh")
	}
}

func TestAccountRuntimeAllowsRemovedOrderAfterTombstoneExpiry(t *testing.T) {
	runtime := NewAccountRuntime()
	account := "0xabc"

	runtime.UpdateOrdersFromSnapshot(account, []interface{}{
		map[string]interface{}{"oid": float64(404), "coin": "BTC", "limitPx": "52000"},
	}, true)
	runtime.MarkOrdersRemoved(account, []int64{404})

	runtime.mu.Lock()
	state := runtime.accounts[normalizeRuntimeAccount(account)]
	state.removedOids[404] = time.Now().Add(-time.Second)
	runtime.mu.Unlock()

	snapshot := runtime.UpdateOrdersFromSnapshot(account, []interface{}{
		map[string]interface{}{"oid": float64(404), "coin": "BTC", "limitPx": "52000"},
	}, true)

	if len(snapshot.Orders) != 1 {
		t.Fatalf("expected order to be accepted after tombstone expiry, got %+v", snapshot.Orders)
	}
}
